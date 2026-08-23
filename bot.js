const mineflayer = require('mineflayer')
const mcDataLoader = require('minecraft-data')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const toolPlugin = require('mineflayer-tool').plugin
const pvpPlugin = require('mineflayer-pvp').plugin
const autoEat = require('mineflayer-auto-eat').loader
const { Vec3 } = require('vec3')
const readline = require('readline')

// Optional: lets a .env file populate process.env in Codespaces/local dev.
// Safe no-op if the package isn't installed for some reason.
try { require('dotenv').config() } catch {}

const CFG = {
  host: process.env.MC_HOST || 'stridesmp.mcsh.io',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'FayaazMJacc',
  version: '1.21.11',
  auth: 'offline',

  // Set these targets in ModVC if you want a shorter test run.
  targetDiamonds: Number(process.env.TARGET_DIAMONDS || 192),
  targetGold: Number(process.env.TARGET_GOLD || 192),
  targetApples: Number(process.env.TARGET_APPLES || 32),

  // Safety/behavior limits.
  maxSearchDistance: 80,
  dangerousRadius: 10,
  taskTimeoutMs: 90000,

  // Combat behavior.
  engageRadius: 10,
  lowHealthThreshold: 8,

  // Death/item-recovery behavior.
  recoveryTimeoutMs: 5 * 60 * 1000, // vanilla dropped-item despawn time
  recoveryMaxDistance: 200,

  // Reconnect behavior (unexpected disconnects only - never after a kick,
  // and never more than maxReconnectAttempts in a row).
  autoReconnect: (process.env.AUTO_RECONNECT || 'true') === 'true',
  maxReconnectAttempts: 10,

  // Eating behavior (mineflayer-auto-eat).
  eatAt: Number(process.env.EAT_AT_HUNGER || 14)
}

let bot
let reconnectAttempts = 0
let reconnectTimer = null

function createBot() {
  bot = mineflayer.createBot(CFG)

  // --- Smooth head turning -----------------------------------------------
  // Pathfinder/pvp/collectblock all call bot.look() every tick with a fresh
  // target angle, which is what causes the visible instant "snap." Wrapping
  // the primitive here clamps how far the head can rotate per call; since
  // it's still invoked ~20x/sec by those plugins, the head eases toward the
  // target over a few ticks instead of teleporting to it. This is a purely
  // client-side smoothing change - it doesn't alter what the bot can do or
  // see, so it stays "legit."
  const _rawLook = bot.look.bind(bot)
  bot.look = function (yaw, pitch, force) {
    if (!bot.entity) return _rawLook(yaw, pitch, force)
    const curYaw = bot.entity.yaw
    const curPitch = bot.entity.pitch
    const dYaw = normalizeAngle(yaw - curYaw)
    const dPitch = pitch - curPitch
    const newYaw = curYaw + clamp(dYaw, -MAX_TURN_PER_CALL, MAX_TURN_PER_CALL)
    const newPitch = curPitch + clamp(dPitch, -MAX_TURN_PER_CALL, MAX_TURN_PER_CALL)
    return _rawLook(newYaw, newPitch, force)
  }

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)
  bot.loadPlugin(toolPlugin)
  bot.loadPlugin(pvpPlugin)
  bot.loadPlugin(autoEat)

  bindBotEvents()
}

const MAX_TURN_PER_CALL = (28 * Math.PI) / 180 // ~28 degrees per call
function normalizeAngle(a) {
  a = a % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  if (a < -Math.PI) a += Math.PI * 2
  return a
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

let mcData
let movements
let stopped = false
let busy = false
let phase = 'boot'
let lastAction = ''
let home = null
let lastKnownPos = null   // updated every tick, used to locate death position
let pendingRecovery = null // { deathPos, inLava, ts } set on death, consumed on next RUN
let hazardBusy = false

const hostile = new Set([
  'zombie','husk','drowned','skeleton','stray','creeper','spider',
  'cave_spider','witch','enderman','silverfish','blaze','magma_cube',
  'phantom','pillager','vindicator','evoker','vex','ravager',
  'warden','piglin_brute','zoglin'
])

// Mobs the bot will not melee even when healthy - explosion, fire, or
// raw damage output makes fighting them a bad trade for a resource bot.
const avoidMobs = new Set([
  'creeper','blaze','magma_cube','warden','ravager',
  'wither','ender_dragon','piglin_brute','zoglin'
])

const foodNames = [
  'cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton',
  'cooked_rabbit','bread','baked_potato','carrot','apple'
]

const logNames = [
  'oak_log','birch_log','spruce_log','jungle_log',
  'acacia_log','dark_oak_log','mangrove_log','cherry_log'
]

const stoneNames = ['stone','cobblestone','deepslate']
const coalNames = ['coal_ore','deepslate_coal_ore']
const ironNames = ['iron_ore','deepslate_iron_ore']
const diamondNames = ['diamond_ore','deepslate_diamond_ore']
const goldNames = ['gold_ore','deepslate_gold_ore','nether_gold_ore']
const flintNames = ['gravel']
const obsidianNames = ['obsidian']

function say(msg) {
  console.log(`[BOT] ${msg}`)
}
function chat(msg) {
  if (!bot.player) return
  bot.chat(msg)
}
function pos() {
  if (!bot.entity) return null
  const p = bot.entity.position
  return `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`
}
function invCount(names) {
  const set = new Set(names)
  return bot.inventory.items()
    .filter(i => set.has(i.name))
    .reduce((n, i) => n + i.count, 0)
}
function itemCount(name) {
  return invCount([name])
}
function printStatus() {
  say(`phase=${phase} pos=${pos() || 'unknown'} last=${lastAction}`)
  say(`wood=${invCount(logNames)} stone=${invCount(stoneNames)} coal=${invCount(coalNames)} iron=${invCount(ironNames)} diamonds=${itemCount('diamond')} gold=${invCount(['gold_ingot','raw_gold','gold_nugget'])} apples=${itemCount('apple')}`)
}
function setPhase(p) {
  phase = p
  say(`PHASE -> ${p}`)
  say(`CORDS -> ${pos() || 'unknown'}`)
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function nearestHostile() {
  if (!bot.entity) return null
  let best = null, bestD = Infinity
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.position || !e.name) continue
    if (!hostile.has(e.name)) continue
    const d = bot.entity.position.distanceTo(e.position)
    if (d < bestD) { best = e; bestD = d }
  }
  return best ? { entity: best, distance: bestD } : null
}

async function flee(entity) {
  say(`Avoiding dangerous mob ${entity.name}.`)
  bot.pvp.stop()
  bot.pathfinder.setGoal(null)
  // Note: vanilla doesn't allow sprinting while moving backward, so this
  // retreat is walking speed by design - sprinting away would require
  // turning around first, which is worse when something is already close.
  bot.setControlState('back', true)
  await sleep(700)
  bot.setControlState('back', false)
}

// Fight-or-flee decision: fightable mobs get engaged with pvp when the bot
// is healthy enough; dangerous mobs (creeper/blaze/etc.) or low bot health
// always trigger disengagement instead.
async function handleHostiles() {
  if (stopped || !bot.entity) return
  const h = nearestHostile()
  if (!h) return
  const { entity, distance } = h

  if (typeof bot.health === 'number' && bot.health <= CFG.lowHealthThreshold) {
    if (distance <= CFG.dangerousRadius) await flee(entity)
    return
  }
  if (avoidMobs.has(entity.name)) {
    if (distance <= CFG.dangerousRadius) await flee(entity)
    return
  }
  if (distance <= CFG.engageRadius) {
    if (bot.pvp.target !== entity) {
      await equipBest(['diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword'])
      lastAction = `fighting ${entity.name}`
      say(`Engaging ${entity.name} at ${distance.toFixed(1)} blocks.`)
      bot.pvp.attack(entity)
    }
  }
}

function isLavaNear(position, radius = 1) {
  if (!position) return false
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(position.offset(dx, dy, dz))
        if (b && b.name === 'lava') return true
      }
    }
  }
  return false
}

// Proactive hazard check, run on an interval regardless of current phase.
// Best-effort only: a block broken open mid-dig can expose lava faster
// than this loop can react, so this reduces risk, it does not eliminate it.
async function hazardCheckLoop() {
  if (stopped || hazardBusy || !bot.entity) return
  const p = bot.entity.position
  if (isLavaNear(p.floored(), 0) || isLavaNear(p.floored().offset(0, -1, 0), 0)) {
    hazardBusy = true
    say('Lava detected underfoot/adjacent - evading.')
    bot.pathfinder.setGoal(null)
    bot.setControlState('jump', true)
    bot.setControlState('back', true)
    await sleep(500)
    bot.setControlState('jump', false)
    bot.setControlState('back', false)
    hazardBusy = false
  }
}

// Tries to recover dropped items near a death location, bounded by both a
// time budget (matches vanilla's 5-minute item despawn) and a distance cap.
// Whatever ends up in the inventory afterward is what runOnePhase() resumes
// from - if recovery fails entirely, that's an empty/near-empty inventory,
// which is functionally "start from 0" since every acquire* function checks
// current counts first.
async function attemptRecovery(deathPos, timeBudgetMs) {
  const start = Date.now()
  say(`Attempting item recovery near ${deathPos.x.toFixed(1)} ${deathPos.y.toFixed(1)} ${deathPos.z.toFixed(1)} (up to ${Math.round(timeBudgetMs / 1000)}s left).`)

  if (!bot.entity || bot.entity.position.distanceTo(deathPos) > CFG.recoveryMaxDistance) {
    say(`Death location is more than ${CFG.recoveryMaxDistance} blocks away. Abandoning recovery.`)
    return false
  }

  try {
    await bot.pathfinder.goto(new goals.GoalNear(deathPos.x, deathPos.y, deathPos.z, 3))
  } catch (e) {
    say(`Could not path back to death location: ${e.message}`)
    return false
  }

  let recoveredAny = false
  while (Date.now() - start < timeBudgetMs && !stopped) {
    const drops = Object.values(bot.entities).filter(e =>
      e && e.position && e.name === 'item' && e.position.distanceTo(deathPos) < 16
    )
    if (!drops.length) {
      await sleep(2000)
      continue
    }
    for (const drop of drops) {
      if (Date.now() - start >= timeBudgetMs || stopped) break
      try {
        await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1))
        recoveredAny = true
      } catch {}
    }
    if (recoveredAny) break
    await sleep(1500)
  }

  if (!recoveredAny) say('No dropped items recovered within the time/distance window.')
  return recoveredAny
}

function hasItem(name) { return bot.inventory.items().some(i => i.name === name) }

async function equipBest(types) {
  for (const type of types) {
    const item = bot.inventory.items().find(i => i.name === type)
    if (item) {
      try {
        await bot.equip(item, 'hand')
        return true
      } catch {}
    }
  }
  return false
}

async function collectNearest(names, count, maxDistance = CFG.maxSearchDistance) {
  if (stopped) return false
  const targets = new Set(names)
  const blocks = bot.findBlocks({
    matching: b => b && targets.has(b.name),
    maxDistance,
    count: count * 3 // over-fetch, then pick the truly nearest ones ourselves
  })
  if (!blocks.length) return false

  // Route optimization: sort candidates by actual distance so the bot visits
  // the closest cluster first instead of whatever order findBlocks returned.
  const origin = bot.entity.position
  blocks.sort((a, b) => origin.distanceTo(a) - origin.distanceTo(b))
  const ordered = blocks.slice(0, count)

  lastAction = `collect ${names.join(',')}`
  say(`Collecting ${ordered.length} target block(s), nearest-first.`)
  try {
    await bot.collectBlock.collect(ordered, {
      ignoreNoPath: true
    })
    return true
  } catch (e) {
    say(`Collection stopped: ${e.message}`)
    bot.pathfinder.setGoal(null)
    return false
  }
}

async function craftByName(name, count = 1) {
  const item = mcData.itemsByName[name]
  if (!item) return false
  const recipes = bot.recipesFor(item.id, null, count, null)
  if (!recipes.length) return false
  try {
    await bot.craft(recipes[0], count, null)
    say(`Crafted ${count} x ${name}`)
    return true
  } catch (e) {
    say(`Craft ${name} failed: ${e.message}`)
    return false
  }
}

async function craftToolSet(material) {
  await craftByName(`${material}_pickaxe`, 1)
  await craftByName(`${material}_axe`, 1)
  await craftByName(`${material}_sword`, 1)
  await craftByName(`${material}_shovel`, 1)
}

const fuelNames = [
  'coal','charcoal','oak_log','birch_log','spruce_log','jungle_log',
  'acacia_log','dark_oak_log','mangrove_log','cherry_log',
  'oak_planks','birch_planks','spruce_planks','jungle_planks',
  'acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks'
]

// Places a furnace near the bot if one is carried but none is nearby yet.
async function ensureFurnaceNearby(maxDistance = 32) {
  let furnaceBlock = bot.findBlock({ matching: b => b && b.name === 'furnace', maxDistance })
  if (furnaceBlock) return furnaceBlock
  if (!hasItem('furnace')) return null

  try {
    const refBlock = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    if (!refBlock) return null
    await bot.equip(bot.inventory.items().find(i => i.name === 'furnace'), 'hand')
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
    return bot.findBlock({ matching: b => b && b.name === 'furnace', maxDistance: 8 })
  } catch (e) {
    say(`Could not place furnace: ${e.message}`)
    return null
  }
}

// Real smelting: opens a furnace, loads ore + fuel, waits for output, and
// collects it. Bounded by a time budget so a fuel shortage doesn't hang the
// whole run - it just stops that phase and reports why.
async function smeltOre(oreNames, outputName, wantedOutputCount, timeBudgetMs = 3 * 60 * 1000) {
  if (itemCount(outputName) >= wantedOutputCount) return true

  const oreItem = bot.inventory.items().find(i => oreNames.includes(i.name))
  if (!oreItem) return false

  const furnaceBlock = await ensureFurnaceNearby()
  if (!furnaceBlock) {
    say('No furnace available to smelt (none nearby and none carried).')
    return false
  }

  try {
    await bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2))
  } catch (e) {
    say(`Could not reach furnace: ${e.message}`)
    return false
  }

  let furnace
  try {
    furnace = await bot.openFurnace(furnaceBlock)
  } catch (e) {
    say(`Could not open furnace: ${e.message}`)
    return false
  }

  const fuelItem = bot.inventory.items().find(i => fuelNames.includes(i.name))
  if (!fuelItem) {
    say('No fuel available for smelting.')
    furnace.close()
    return false
  }

  try {
    await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, 32))
    await furnace.putInput(oreItem.type, null, oreItem.count)
  } catch (e) {
    say(`Furnace load failed: ${e.message}`)
    furnace.close()
    return false
  }

  say(`Smelting ${oreItem.count} x ${oreItem.name} into ${outputName}...`)
  const start = Date.now()
  while (Date.now() - start < timeBudgetMs && !stopped) {
    await sleep(3000)
    if (itemCount(outputName) >= wantedOutputCount) break
    const out = furnace.outputItem()
    if (out && out.count > 0) {
      try { await furnace.takeOutput() } catch {}
    }
    if (!furnace.fuel && !bot.inventory.items().some(i => fuelNames.includes(i.name))) {
      say('Furnace ran out of fuel and none left to add.')
      break
    }
  }
  try {
    const out = furnace.outputItem()
    if (out && out.count > 0) await furnace.takeOutput()
  } catch {}
  furnace.close()

  const ok = itemCount(outputName) >= wantedOutputCount
  say(ok ? `Smelting complete: ${itemCount(outputName)} x ${outputName}.` : `Smelting stopped early: ${itemCount(outputName)} x ${outputName} so far.`)
  return ok
}

async function acquireWood() {
  setPhase('wood')
  if (invCount(logNames) >= 16) return true
  return await collectNearest(logNames, 16)
}

async function acquireStone() {
  setPhase('stone')
  if (invCount(stoneNames) >= 32) return true
  return await collectNearest(stoneNames, 32)
}

async function acquireCoal() {
  setPhase('coal')
  if (invCount(coalNames) >= 8) return true
  return await collectNearest(coalNames, 8)
}

async function acquireIron() {
  setPhase('iron')
  if (itemCount('iron_ingot') >= 24) return true
  // Raw ore is collected first, then actually smelted into ingots.
  if (invCount(ironNames) + invCount(['raw_iron']) < 24) {
    const got = await collectNearest(ironNames, 16)
    if (!got && invCount(ironNames) + invCount(['raw_iron']) === 0) return false
  }
  if (!hasItem('furnace') && !bot.findBlock({ matching: b => b && b.name === 'furnace', maxDistance: 32 })) {
    await craftByName('furnace', 1)
  }
  const ok = await smeltOre(['iron_ore','deepslate_iron_ore','raw_iron'], 'iron_ingot', 24)
  say(ok ? 'Iron ingots ready.' : `Iron smelting incomplete: ${itemCount('iron_ingot')} ingot(s) so far.`)
  return ok
}

async function surfaceAndBed() {
  setPhase('surface/bed')
  // If underground, head upward only a bounded amount. If pathfinder fails,
  // stop rather than repeatedly digging.
  if (bot.entity.position.y < 55) {
    const p = bot.entity.position
    try {
      await bot.pathfinder.goto(new goals.GoalY(55))
    } catch {
      say('Could not safely return to the surface.')
      return false
    }
  }
  if (!hasItem('white_wool') && !hasItem('bed')) {
    await collectNearest(['white_wool','black_wool','gray_wool','light_gray_wool',
      'brown_wool','red_wool','orange_wool','yellow_wool','lime_wool',
      'green_wool','cyan_wool','light_blue_wool','blue_wool','purple_wool',
      'magenta_wool','pink_wool'], 3, 48)
  }
  if (!hasItem('bed')) await craftByName('white_bed', 1)
  return hasItem('white_bed') || hasItem('bed')
}

async function diamondRun() {
  setPhase('diamonds')
  const have = itemCount('diamond')
  if (have >= CFG.targetDiamonds) return true

  // Use exposed nearby diamond ore first.
  if (await collectNearest(diamondNames, 8, 96)) return true

  // Conservative branch-mining fallback. This intentionally stops at a
  // bounded number of tunnels rather than running indefinitely.
  say('No exposed diamonds nearby; starting a bounded search.')
  const p = bot.entity.position.floored()
  const y = Math.min(16, Math.max(-50, p.y))
  try {
    await bot.pathfinder.goto(new goals.GoalY(y))
  } catch {}
  for (let i = 0; i < 4 && !stopped; i++) {
    const dir = i % 2 === 0 ? 1 : -1
    const dirKey = dir > 0 ? 'forward' : 'back'
    // Vanilla only allows sprinting while moving forward; sprint on the
    // backward leg is a no-op, so only set it going out, not coming back.
    if (dir > 0) bot.setControlState('sprint', true)
    bot.setControlState(dirKey, true)

    const segmentStart = Date.now()
    const segmentMs = 24 * 250 // same total travel budget per tunnel leg as before
    while (Date.now() - segmentStart < segmentMs && !stopped) {
      await handleHostiles()
      if (await collectNearest(diamondNames, 4, 8)) {
        // collectNearest hands control to pathfinder to reach/mine the
        // block; resume the tunnel heading afterward instead of stopping.
        bot.setControlState(dirKey, true)
        if (dir > 0) bot.setControlState('sprint', true)
      }
      if (itemCount('diamond') >= CFG.targetDiamonds) {
        bot.setControlState(dirKey, false)
        bot.setControlState('sprint', false)
        return true
      }
      await sleep(300)
    }
    bot.setControlState(dirKey, false)
    bot.setControlState('sprint', false)
  }
  return itemCount('diamond') >= CFG.targetDiamonds
}

async function goldRun() {
  setPhase('gold')
  if (invCount(['gold_ingot','raw_gold']) >= CFG.targetGold) return true
  const gotOre = await collectNearest(goldNames, 12, 96)
  if (!gotOre && invCount(['gold_ore','deepslate_gold_ore','nether_gold_ore','raw_gold']) === 0) {
    say('No nearby gold. Stopping this bounded gold search until instructed again.')
    return false
  }
  const ok = await smeltOre(['gold_ore','deepslate_gold_ore','nether_gold_ore','raw_gold'], 'gold_ingot', CFG.targetGold)
  return ok
}

async function obsidianAndFlint() {
  setPhase('obsidian/flint')
  if (invCount(obsidianNames) < 10) {
    await collectNearest(obsidianNames, 10, 64)
  }
  if (itemCount('flint') < 1) {
    await collectNearest(flintNames, 8, 64)
  }
  if (hasItem('iron_ingot') && itemCount('flint') > 0) {
    await craftByName('flint_and_steel', 1)
  }
  return true
}

async function appleRun() {
  setPhase('apples')
  if (itemCount('apple') >= CFG.targetApples) return true
  await collectNearest(['oak_leaves','dark_oak_leaves'], 64, 64)
  return itemCount('apple') >= CFG.targetApples
}

async function runOnePhase() {
  if (stopped || busy) return
  busy = true
  try {
    // Finite state machine: each phase is attempted once per command/run.
    await acquireWood()
    await acquireStone()
    await craftToolSet('stone')
    await acquireCoal()
    await surfaceAndBed()
    await acquireIron()
    await craftToolSet('iron')
    await diamondRun()
    await obsidianAndFlint()
    await goldRun()
    await appleRun()
    setPhase('complete')
    say('Progression run finished or reached a bounded stopping point.')
    say('Waiting for further instructions. No automatic loop.')
  } catch (e) {
    say(`RUN STOPPED: ${e.stack || e.message}`)
  } finally {
    busy = false
  }
}

function stopBot(reason = 'manual') {
  stopped = true
  bot.pvp.stop()
  bot.pathfinder.setGoal(null)
  for (const c of ['forward','back','left','right','jump','sprint','sneak','attack']) {
    try { bot.setControlState(c, false) } catch {}
  }
  say(`STOPPED (${reason}) at ${pos() || 'unknown'}`)
}

function bindBotEvents() {
  bot.once('spawn', () => {
    mcData = mcDataLoader(bot.version)
    movements = new Movements(bot)
    movements.allowParkour = true      // jump gaps/1-block steps instead of walking around - faster routes
    movements.allow1by1towers = false
    movements.canDig = true
    movements.maxDropDown = 3
    movements.allowSprinting = true    // speedrunner-style movement instead of walking
    bot.pathfinder.setMovements(movements)

    // Configure auto-eat once the plugin is fully attached. Wrapped
    // defensively since the option shape has changed across major versions.
    try {
      if (bot.autoEat && bot.autoEat.options) {
        bot.autoEat.options = { priority: 'foodPoints', startAt: CFG.eatAt, bannedFood: [] }
      }
    } catch {}

    home = bot.entity.position.clone()
    lastKnownPos = bot.entity.position.clone()
    reconnectAttempts = 0
    say(`Connected as ${CFG.username} to ${CFG.host}:${CFG.port}`)
    say(`CORDS -> ${pos()}`)
    say('Type RUN, STOP, PAUSE, STATUS, CORDS, TASK, INV, or CHAT <message> in the ModVC terminal.')
    say('Minecraft chat is mirrored below.')

    bot.on('physicsTick', () => {
      if (bot.entity) lastKnownPos = bot.entity.position.clone()
    })
    setInterval(() => { handleHostiles().catch(() => {}) }, 1200)
    setInterval(() => { hazardCheckLoop().catch(() => {}) }, 400)
  })

  // The 'message' event fires for chat AND system/game_info text. Player
  // chat is already logged cleanly (with username) by the 'chat' event
  // below, so skip it here to avoid a second, unattributed copy.
  bot.on('message', (jsonMsg, position) => {
    if (position === 'chat') return
    console.log(`[MC] ${jsonMsg.toString()}`)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    console.log(`[CHAT] <${username}> ${message}`)
  })

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return
    console.log(`[WHISPER] <${username}> ${message}`)
  })

  bot.on('entityHurt', async entity => {
    if (entity === bot.entity) await handleHostiles()
  })

  bot.on('death', () => {
    const deathPos = lastKnownPos || (bot.entity && bot.entity.position) || null
    const inLava = deathPos ? isLavaNear(deathPos.floored(), 1) : false

    if (deathPos && !inLava) {
      pendingRecovery = { deathPos, inLava: false, ts: Date.now() }
      say(`BOT DIED at ${deathPos.x.toFixed(1)} ${deathPos.y.toFixed(1)} ${deathPos.z.toFixed(1)}. Items may be recoverable - will attempt recovery on next RUN (5 min / ${CFG.recoveryMaxDistance} block window).`)
    } else if (deathPos && inLava) {
      say(`BOT DIED in lava at ${deathPos.x.toFixed(1)} ${deathPos.y.toFixed(1)} ${deathPos.z.toFixed(1)}. Items presumed lost - next RUN starts fresh.`)
    } else {
      say('BOT DIED (position unknown). Next RUN starts fresh.')
    }

    stopBot('death')
    // Send the respawn packet so the bot regains control; it still waits
    // for an explicit RUN before doing anything (no autonomous respawn loop).
    try { bot.respawn() } catch {}
  })

  bot.on('kicked', reason => say(`KICKED: ${JSON.stringify(reason)}`))
  bot.on('error', err => say(`ERROR: ${err.message}`))

  bot.on('end', () => {
    say('Disconnected.')
    if (!CFG.autoReconnect) return
    if (reconnectAttempts >= CFG.maxReconnectAttempts) {
      say(`Reached ${CFG.maxReconnectAttempts} reconnect attempts. Giving up - restart the process to try again.`)
      return
    }
    reconnectAttempts++
    // Exponential backoff, capped at 60s, so a server restart or brief
    // outage doesn't turn into a tight reconnect loop.
    const delayMs = Math.min(60000, 2000 * 2 ** (reconnectAttempts - 1))
    say(`Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts}/${CFG.maxReconnectAttempts})...`)
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      stopped = false
      createBot()
    }, delayMs)
  })
}

createBot()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', async line => {
  const input = line.trim()
  const upper = input.toUpperCase()

  if (upper === 'RUN') {
    if (stopped) {
      stopped = false
      say('Resuming only because you explicitly requested RUN.')
    }
    if (pendingRecovery) {
      const rec = pendingRecovery
      pendingRecovery = null
      if (rec.inLava) {
        say('Last death was in lava; items presumed lost. Starting fresh.')
      } else if (Date.now() - rec.ts > CFG.recoveryTimeoutMs) {
        say('More than 5 minutes have passed since death; dropped items have likely despawned. Starting fresh.')
      } else {
        const remaining = CFG.recoveryTimeoutMs - (Date.now() - rec.ts)
        const recovered = await attemptRecovery(rec.deathPos, remaining)
        say(recovered
          ? 'Recovered items from the death location - continuing from current inventory.'
          : 'Recovery unsuccessful - continuing from current inventory (effectively starting fresh).')
      }
    }
    runOnePhase()
    return
  }
  if (upper === 'STOP') {
    stopBot('terminal command')
    return
  }
  if (upper === 'STATUS') {
    printStatus()
    return
  }
  if (upper === 'CORDS' || upper === 'COORDS') {
    say(`CORDS -> ${pos() || 'unknown'}`)
    return
  }
  if (upper === 'CHAT') {
    say('Usage: CHAT your message')
    return
  }
  if (upper.startsWith('CHAT ')) {
    const msg = input.slice(5).trim()
    if (msg) bot.chat(msg)
    return
  }
  if (upper === 'PAUSE') {
    bot.pathfinder.setGoal(null)
    bot.pvp.stop()
    say(`Paused at ${pos() || 'unknown'}.`)
    return
  }
  if (upper === 'TASK') {
    say(`CURRENT TASK -> phase=${phase} action=${lastAction || 'idle'} pos=${pos() || 'unknown'}`)
    return
  }
  if (upper === 'INV') {
    const items = bot.inventory.items()
    if (!items.length) {
      say('Inventory is empty.')
      return
    }
    const grouped = {}
    for (const it of items) grouped[it.name] = (grouped[it.name] || 0) + it.count
    say('Inventory:')
    for (const [name, count] of Object.entries(grouped)) say(`  ${name} x${count}`)
    return
  }
  if (upper === 'HELP') {
    say('RUN | STOP | PAUSE | STATUS | CORDS | TASK | INV | CHAT <message>')
    return
  }
  if (input) say('Unknown command. Type HELP.')
})
