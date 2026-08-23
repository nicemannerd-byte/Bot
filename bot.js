require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const pvp = require("mineflayer-pvp").plugin;
const minecraftData = require("minecraft-data");
const readline = require("readline");

const CFG = {
  host: process.env.MC_HOST || "stridesmp.mcsh.io",
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || "FayaazMJacc",
  version: process.env.MC_VERSION || "1.21.11",
  lowHealth: 8,
  lowFood: 10,
  hostileRange: 10,
  reconnectMs: 4000,
  tickMs: 150,
  targetSearch: 64,
  miningY: -54,
  mineBatch: 8,
  postMissionDisconnectMs: 3000
};

let bot = null;
let mcData = null;
let moves = null;
let stopped = false;
let missionDone = false;
let phase = "WOOD";
let currentTask = "Connecting";
let targetDescription = "none";
let activeGoal = null;
let lastDeath = null;
let loopRunning = false;

const LOGS = [
  "oak_log","spruce_log","birch_log","jungle_log",
  "acacia_log","dark_oak_log","mangrove_log","cherry_log"
];
const PLANKS = LOGS.map(x => x.replace("_log", "_planks"));
const STONE = ["stone","cobblestone"];
const COAL_ORES = ["coal_ore","deepslate_coal_ore"];
const IRON_ORES = ["iron_ore","deepslate_iron_ore"];
const GOLD_ORES = ["gold_ore","deepslate_gold_ore"];
const DIAMOND_ORES = ["diamond_ore","deepslate_diamond_ore"];
const COPPER_ORES = ["copper_ore","deepslate_copper_ore"];
const HOSTILES = new Set([
  "zombie","skeleton","creeper","spider","cave_spider","drowned",
  "husk","stray","witch","pillager","vindicator","evoker","ravager",
  "silverfish","blaze","magma_cube","slime","phantom","piglin_brute"
]);
const PASSIVE_FOOD = ["cow","pig","sheep","chicken","rabbit"];
const FOODS = [
  "cooked_beef","cooked_porkchop","cooked_mutton","cooked_chicken",
  "cooked_rabbit","bread","baked_potato","apple","carrot","potato","sweet_berries"
];
const PICKAXES = ["netherite_pickaxe","diamond_pickaxe","iron_pickaxe","stone_pickaxe","golden_pickaxe","wooden_pickaxe"];
const WEAPONS = ["netherite_sword","diamond_sword","iron_sword","stone_sword","golden_sword","wooden_sword","netherite_axe","diamond_axe","iron_axe","stone_axe","wooden_axe"];
const ARMOR = [
  "netherite_helmet","diamond_helmet","iron_helmet","golden_helmet","chainmail_helmet","leather_helmet",
  "netherite_chestplate","diamond_chestplate","iron_chestplate","golden_chestplate","chainmail_chestplate","leather_chestplate",
  "netherite_leggings","diamond_leggings","iron_leggings","golden_leggings","chainmail_leggings","leather_leggings",
  "netherite_boots","diamond_boots","iron_boots","golden_boots","chainmail_boots","leather_boots"
];

function log(...args) { console.log("[BOT]", ...args); }
function setTask(task, target = "none") { currentTask = task; targetDescription = target; log(`Task: ${task}${target !== "none" ? ` | Target: ${target}` : ""}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pos() { return bot.entity.position; }
function dist(a,b) { return a.distanceTo(b); }
function invCount(names) {
  const list = Array.isArray(names) ? names : [names];
  return bot.inventory.items().filter(i => list.includes(i.name)).reduce((n,i) => n + i.count, 0);
}
function has(names) { return invCount(names) > 0; }
function item(names) {
  const list = Array.isArray(names) ? names : [names];
  return bot.inventory.items().find(i => list.includes(i.name));
}
function inventorySummary() {
  const items = bot.inventory.items();
  return items.length ? items.map(i => `${i.name} x${i.count}`).join(", ") : "empty";
}
function sayTerminal(label, msg) { console.log(`[${label}] ${msg}`); }
function dangerousBlock(block) { return !!block && ["lava","flowing_lava","fire","soul_fire"].includes(block.name); }
function dangerAt(p) {
  const c = p.floored();
  for (let dx=-2;dx<=2;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-2;dz<=2;dz++) {
    if (dangerousBlock(bot.blockAt(c.offset(dx,dy,dz)))) return true;
  }
  return false;
}
function isHostile(e) { return e && e.type === "mob" && HOSTILES.has((e.name || "").toLowerCase()); }
function nearestEntity(filter, max=CFG.hostileRange) {
  let best = null, bd = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.position || !filter(e)) continue;
    const d = dist(pos(), e.position);
    if (d <= max && d < bd) { best=e; bd=d; }
  }
  return best;
}
function nearestBlock(names, max=CFG.targetSearch) {
  const set = new Set(Array.isArray(names) ? names : [names]);
  const blocks = bot.findBlocks({ maxDistance:max, count:32, matching:b => b && set.has(b.name) });
  blocks.sort((a,b) => dist(pos(),a) - dist(pos(),b));
  return blocks.find(p => !dangerAt(p)) || null;
}
function nearestBlockName(names, max=CFG.targetSearch) {
  const b = nearestBlock(names,max); return b ? `${b.x},${b.y},${b.z} (${bot.blockAt(b)?.name || "block"})` : "not found nearby";
}
function enableMovement() {
  moves.canDig = true;
  moves.allowSprinting = true;
  moves.allowParkour = true;
  moves.allow1by1towers = false;
  moves.maxDropDown = 2;
  moves.infiniteLiquidDropdownDistance = false;
  moves.canOpenDoors = true;
  bot.pathfinder.setMovements(moves);
  bot.setControlState("sprint", true);
}
function stopMovement() {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.pvp.stop();
  activeGoal = null;
}

async function gotoPoint(x,y,z,r=2,timeout=12000) {
  if (stopped || missionDone) return false;
  if (dangerAt(pos())) return await escapeDanger();
  activeGoal = `(${Math.floor(x)},${Math.floor(y)},${Math.floor(z)})`;
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(x,y,z,r)),
      sleep(timeout).then(()=>{ throw new Error("path timeout"); })
    ]);
    activeGoal = null;
    return !dangerAt(pos());
  } catch (e) {
    bot.pathfinder.setGoal(null);
    activeGoal = null;
    return false;
  }
}
async function gotoBlock(p,r=2,timeout=10000) { return gotoPoint(p.x,p.y,p.z,r,timeout); }

async function escapeDanger() {
  stopMovement();
  const p = pos().floored();
  const candidates = [
    p.offset(5,0,0),p.offset(-5,0,0),p.offset(0,0,5),p.offset(0,0,-5),
    p.offset(4,2,0),p.offset(-4,2,0),p.offset(0,2,4),p.offset(0,2,-4)
  ];
  for (const t of candidates) {
    const b=bot.blockAt(t), below=bot.blockAt(t.offset(0,-1,0));
    if (dangerousBlock(b)||dangerousBlock(below)) continue;
    if (await gotoPoint(t.x,t.y,t.z,2,4000)) return true;
  }
  return false;
}

async function equip(names, destination="hand") {
  const it=item(names); if (!it) return false;
  try { await bot.equip(it,destination); return true; } catch { return false; }
}
async function craft(name,count=1) {
  const def=mcData.itemsByName[name]; if (!def) return false;
  try {
    const recipes=bot.recipesFor(def.id,null,1,null);
    if (!recipes.length) return false;
    await bot.craft(recipes[0],count,null); return true;
  } catch { return false; }
}
async function placeCraftingTable() {
  if (!has("crafting_table")) return false;
  if (bot.findBlock({maxDistance:4,matching:b=>b.name==="crafting_table"})) return true;
  const table=item("crafting_table");
  const below=bot.blockAt(pos().offset(0,-1,0));
  if (!below || below.boundingBox !== "block") return false;
  try { await equip(table,"hand"); await bot.placeBlock(below,{x:0,y:1,z:0}); return true; } catch { return false; }
}
async function craftAtTable(name,count=1) {
  if (!await placeCraftingTable()) return false;
  return craft(name,count);
}

async function eatIfNeeded(force=false) {
  if (!force && bot.food >= CFG.lowFood) return true;
  const f=bot.inventory.items().filter(i=>FOODS.includes(i.name)).sort((a,b)=>b.count-a.count)[0];
  if (!f) return false;
  try { await bot.equip(f,"hand"); await bot.consume(); return true; } catch { return false; }
}

async function fight(target) {
  if (!target || !target.isValid) return false;
  if (bot.health <= CFG.lowHealth) { await escapeDanger(); await eatIfNeeded(true); return false; }
  await equip(WEAPONS);
  try {
    bot.pvp.attack(target);
    const end=Date.now()+5000;
    while (target.isValid && Date.now()<end) {
      if (bot.health<=CFG.lowHealth || dangerAt(pos())) { bot.pvp.stop(); await escapeDanger(); await eatIfNeeded(true); return false; }
      await sleep(80);
    }
    bot.pvp.stop(); return !target.isValid;
  } catch { bot.pvp.stop(); return false; }
}
async function combatCheck() {
  const e=nearestEntity(isHostile,CFG.hostileRange);
  if (e) { setTask(`Fighting ${e.name}`, `${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`); await fight(e); return true; }
  return false;
}

async function mineBlockAt(p) {
  const b=bot.blockAt(p);
  if (!b || b.name==="air" || dangerAt(p)) return false;
  try {
    await gotoPoint(p.x,p.y,p.z,2,8000);
    const groundDeadline=Date.now()+900;
    while (!bot.entity.onGround && Date.now()<groundDeadline) await sleep(40);
    if (!bot.entity.onGround || !bot.canDigBlock(b)) return false;
    await equip(PICKAXES);
    await bot.dig(b,true);
    return true;
  } catch { return false; }
}
async function mineNearest(names) {
  const p=nearestBlock(names,CFG.targetSearch); if (!p) return false;
  setTask("Mining nearest target", nearestBlockName(names));
  return mineBlockAt(p);
}
async function collect(names,count,limit=100) {
  let attempts=0;
  while (invCount(names)<count && attempts++<limit && !stopped && !missionDone) {
    if (await combatCheck()) continue;
    await eatIfNeeded();
    const p=nearestBlock(names,CFG.targetSearch);
    if (!p) return false;
    if (!await mineBlockAt(p)) return false;
  }
  return invCount(names)>=count;
}

async function gatherNearestWood() {
  if (invCount(LOGS)>=4) return true;
  const p=nearestBlock(LOGS,64);
  if (!p) { setTask("Waiting for a nearby wood target", "any log within 64 blocks"); return false; }
  setTask("Getting nearest wood", `${p.x},${p.y},${p.z} (${bot.blockAt(p).name})`);
  return collect(LOGS,4,16);
}
async function starter() {
  if (!has(PICKAXES)) {
    const log=bot.inventory.items().find(i=>LOGS.includes(i.name));
    if (!log) return false;
    const plank=log.name.replace("_log","_planks");
    await craft(plank,Math.min(8,log.count));
    await craft("stick",4);
    await craft("crafting_table",1);
    await craftAtTable("wooden_pickaxe",1);
    await craftAtTable("wooden_axe",1);
    await craftAtTable("wooden_sword",1);
  }
  return has(PICKAXES);
}
async function getStone() {
  if (has(["stone_pickaxe","iron_pickaxe","diamond_pickaxe","netherite_pickaxe"])) return true;
  const p=nearestBlock(STONE,32); if (!p) return false;
  setTask("Getting stone for tools",`${p.x},${p.y},${p.z}`);
  if (!await collect(STONE,11,20)) return false;
  await craftAtTable("stone_pickaxe",1);
  await craftAtTable("stone_axe",1);
  await craftAtTable("stone_sword",1);
  return has("stone_pickaxe");
}
async function getFoodAndBed() {
  if (bot.food<CFG.lowFood) {
    const animal=nearestEntity(e=>e.type==="mob"&&PASSIVE_FOOD.includes((e.name||"").toLowerCase()),32);
    if (animal) { setTask(`Getting food from ${animal.name}`); await fight(animal); }
  }
  await eatIfNeeded(true);
  // Bed: kill nearby sheep only if wool is missing; use any color wool.
  if (!has(["white_wool","black_wool","gray_wool","light_gray_wool","brown_wool","red_wool","orange_wool","yellow_wool","lime_wool","green_wool","cyan_wool","light_blue_wool","blue_wool","purple_wool","magenta_wool","pink_wool"])) {
    const sheep=nearestEntity(e=>e.name==="sheep",48);
    if (sheep) { setTask("Getting wool for a bed"); await fight(sheep); }
  }
  const wool=bot.inventory.items().find(i=>i.name.endsWith("_wool"));
  if (wool && !has("bed")) {
    const plank=bot.inventory.items().find(i=>PLANKS.includes(i.name));
    if (!plank) return false;
    await craftAtTable("bed",1);
  }
  return bot.food>0 && has("bed");
}
async function getCoal() {
  if (invCount("coal")>=16) return true;
  return collect(COAL_ORES,4,60) || invCount("coal")>=16;
}
async function smeltIron() {
  if (invCount("iron_ingot")>=24) return true;
  if (invCount("raw_iron")<24) await collect(IRON_ORES,24,120);
  if (invCount("raw_iron")<24) return false;
  // Find/place a furnace and smelt using available fuel.
  if (!has("furnace")) await craftAtTable("furnace",1);
  const furnace=bot.findBlock({maxDistance:4,matching:b=>b.name==="furnace"||b.name==="blast_furnace"});
  if (!furnace) {
    const below=bot.blockAt(pos().offset(0,-1,0));
    if (below) { try { await equip("furnace"); await bot.placeBlock(below,{x:0,y:1,z:0}); } catch {} }
  }
  const f=bot.findBlock({maxDistance:5,matching:b=>b.name==="furnace"||b.name==="blast_furnace"});
  if (!f) return false;
  try {
    const furnaceMachine=bot.openFurnace(f);
    const fuel=bot.inventory.items().find(i=>["coal","charcoal","oak_planks","spruce_planks","birch_planks","jungle_planks","acacia_planks","dark_oak_planks","mangrove_planks","cherry_planks"].includes(i.name));
    if (!fuel) { furnaceMachine.close(); return false; }
    await furnaceMachine.putFuel(fuel.type,null,Math.min(fuel.count,32));
    const raw=bot.inventory.items().find(i=>i.name==="raw_iron");
    await furnaceMachine.putInput(raw.type,null,Math.min(raw.count,24));
    while (invCount("iron_ingot")<24) { await sleep(500); if (!furnaceMachine.inputItem()) break; }
    furnaceMachine.close();
    return invCount("iron_ingot")>=24;
  } catch { return invCount("iron_ingot")>=24; }
}
async function makeIronKit() {
  await smeltIron();
  await craftAtTable("iron_pickaxe",1);
  await craftAtTable("iron_sword",1);
  await craftAtTable("iron_axe",1);
  for (const n of ["iron_helmet","iron_chestplate","iron_leggings","iron_boots"]) await craftAtTable(n,1);
  return has("iron_pickaxe");
}
async function descendToMiningLevel() {
  const y=pos().y;
  if (y<=CFG.miningY+4) return true;
  // Directed staircase: only move downward, never random exploration.
  setTask("Descending to diamond mining level", `Y≈${CFG.miningY}`);
  for (let i=0;i<80 && pos().y>CFG.miningY+4;i++) {
    const p=pos().floored();
    const below=bot.blockAt(p.offset(0,-1,0));
    if (!below || below.name==="air") { await sleep(50); continue; }
    if (dangerousBlock(below) || dangerousBlock(bot.blockAt(p.offset(0,-2,0)))) { await escapeDanger(); continue; }
    if (!await mineBlockAt(below.position)) return false;
    await sleep(40);
  }
  return pos().y<=CFG.miningY+4;
}
async function mineTargetResource(oreNames, itemName, targetCount, label) {
  if (invCount(itemName)>=targetCount) return true;
  await descendToMiningLevel();
  let misses=0;
  while (invCount(itemName)<targetCount && !stopped && !missionDone) {
    if (await combatCheck()) continue;
    await eatIfNeeded();
    const p=nearestBlock(oreNames,CFG.targetSearch);
    if (p) {
      setTask(`Mining ${label}`, `${p.x},${p.y},${p.z}`);
      if (await mineBlockAt(p)) { misses=0; continue; }
      misses++;
    } else {
      misses++;
      // Strict no-roam rule: only extend the current straight tunnel when needed.
      const here=pos().floored();
      const forward=here.offset(2,0,0);
      setTask(`Directed ${label} tunnel`, `X≈${forward.x}, Y≈${here.y}, Z≈${here.z}`);
      const block=bot.blockAt(forward);
      if (block && block.name!=="air" && !dangerousBlock(block)) await mineBlockAt(forward);
      else await sleep(100);
    }
    if (misses>240) return false;
  }
  return invCount(itemName)>=targetCount;
}
async function makeDiamondSets() {
  // 5 armor sets + full tools per set; the 3-stack diamond target is checked first.
  const pieces=["diamond_helmet","diamond_chestplate","diamond_leggings","diamond_boots"];
  const tools=["diamond_pickaxe","diamond_sword","diamond_axe","diamond_shovel","diamond_hoe"];
  for (let set=0;set<5;set++) {
    for (const n of pieces) await craftAtTable(n,1);
    for (const n of tools) await craftAtTable(n,1);
  }
}
async function mineGold() { return mineTargetResource(GOLD_ORES,"raw_gold",192,"gold"); }
async function mineDiamonds() { return mineTargetResource(DIAMOND_ORES,"diamond",192,"diamonds"); }
async function getObsidianAndFlint() {
  if (invCount("obsidian")<10) {
    const p=nearestBlock(["obsidian"],32);
    if (!p) {
      setTask("Waiting for a nearby obsidian target", "obsidian within 32 blocks");
      return false;
    }
    await equip(["diamond_pickaxe","netherite_pickaxe"]);
    if (!await collect(["obsidian"],10,80)) return false;
  }
  if (!has("flint_and_steel")) {
    if (invCount("flint")<1) {
      const gravel=nearestBlock(["gravel"],48);
      if (gravel) await mineBlockAt(gravel);
    }
    await craftAtTable("flint_and_steel",1);
  }
  return invCount("obsidian")>=10 && has("flint_and_steel");
}
async function buildPortal() {
  const p=pos().floored();
  const frame=[
    [0,0,0],[0,1,0],[0,2,0],[0,3,0],[1,0,0],[2,0,0],[2,1,0],[2,2,0],[2,3,0],[1,3,0]
  ];
  // Use the current safe location and a simple vertical frame. No wandering.
  for (const [dx,dy,dz] of frame) {
    const b=bot.blockAt(p.offset(dx,dy,dz));
    if (!b || b.name!=="air") continue;
    const below=bot.blockAt(p.offset(dx,dy-1,dz));
    if (!below) return false;
    try { await equip("obsidian"); await bot.placeBlock(below,{x:dx===0?0:0,y:1,z:0}); } catch { return false; }
  }
  const fire=bot.inventory.items().find(i=>i.name==="flint_and_steel");
  if (!fire) return false;
  await equip(fire,"hand");
  const inside=bot.blockAt(p.offset(1,1,0));
  if (inside) { try { await bot.activateBlock(inside); } catch {} }
  return true;
}

async function missionStep() {
  if (phase==="WOOD") {
    setTask("Getting the nearest wood", "any supported log within 64 blocks");
    if (await gatherNearestWood() && await starter()) phase="STONE";
    return;
  }
  if (phase==="STONE") {
    setTask("Getting stone tools");
    if (await getStone()) phase="FOOD";
    return;
  }
  if (phase==="FOOD") {
    setTask("Getting food and a bed");
    if (await getFoodAndBed()) phase="COAL";
    return;
  }
  if (phase==="COAL") {
    setTask("Getting coal");
    if (await getCoal()) phase="IRON";
    return;
  }
  if (phase==="IRON") {
    setTask("Mining and smelting iron");
    if (await makeIronKit()) phase="DIAMONDS";
    return;
  }
  if (phase==="DIAMONDS") {
    setTask("Mining 3 stacks of diamonds", "192 diamonds");
    if (await mineDiamonds()) phase="GOLD";
    return;
  }
  if (phase==="GOLD") {
    setTask("Mining 3 stacks of gold", "192 raw gold");
    if (await mineGold()) phase="DIAMOND_KITS";
    return;
  }
  if (phase==="DIAMOND_KITS") {
    setTask("Crafting 5 diamond armor + tool sets", "5 complete sets");
    await makeDiamondSets();
    phase="PORTAL";
    return;
  }
  if (phase==="PORTAL") {
    setTask("Getting obsidian and flint & steel");
    if (await getObsidianAndFlint()) phase="BUILD_PORTAL";
    return;
  }
  if (phase==="BUILD_PORTAL") {
    setTask("Building the Nether portal", "current safe position");
    if (await buildPortal()) phase="DONE";
    return;
  }
  if (phase==="DONE") {
    setTask("Mission complete - leaving", "disconnect");
    missionDone=true;
    stopMovement();
    await sleep(CFG.postMissionDisconnectMs);
    bot.quit("Mission complete");
  }
}

function terminalCommands() {
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  rl.on("line", async raw => {
    const cmd=raw.trim().toLowerCase();
    if (!cmd) return;
    if (cmd==="task") return sayTerminal("TASK",`${currentTask} | Phase=${phase} | Target=${targetDescription}`);
    if (cmd==="coords"||cmd==="cords") {
      if (!bot?.entity) return sayTerminal("COORDS","not spawned");
      const p=pos(); return sayTerminal("COORDS",`X=${Math.floor(p.x)} Y=${Math.floor(p.y)} Z=${Math.floor(p.z)}`);
    }
    if (cmd==="inv"||cmd==="inventory") return sayTerminal("INVENTORY",inventorySummary());
    if (cmd==="status") {
      if (!bot?.entity) return sayTerminal("STATUS","not spawned");
      const p=pos(); return sayTerminal("STATUS",`phase=${phase} task=${currentTask} target=${targetDescription} hp=${Math.round(bot.health)} food=${Math.round(bot.food)} X=${Math.floor(p.x)} Y=${Math.floor(p.y)} Z=${Math.floor(p.z)}`);
    }
    if (cmd==="stop") { stopped=true; stopMovement(); setTask("Stopped by terminal command"); return sayTerminal("COMMAND","stopped"); }
    if (cmd==="resume") { stopped=false; enableMovement(); setTask("Resuming mission"); return sayTerminal("COMMAND","resumed"); }
    if (cmd==="help") return sayTerminal("COMMANDS","task | coords | inv | status | stop | resume | help");
    sayTerminal("COMMAND",`unknown: ${raw.trim()}`);
  });
}

function createBot() {
  bot=mineflayer.createBot({host:CFG.host,port:CFG.port,username:CFG.username,version:CFG.version});
  bot.loadPlugin(pathfinder); bot.loadPlugin(pvp);
  bot.once("spawn",async()=>{
    mcData=minecraftData(bot.version);
    moves=new Movements(bot,mcData);
    enableMovement();
    phase="WOOD";
    setTask("Starting mission - get nearest wood");
    log(`Connected to ${CFG.host}:${CFG.port} as ${CFG.username} | MC ${bot.version}`);
    log("No random roaming. Movement is only to an explicit resource/mission target.");
  });
  bot.on("chat",(username,message)=>{ if(username!==bot.username) log(`<${username}> ${message}`); });
  bot.on("death",()=>{ lastDeath=pos().clone(); stopped=false; phase="WOOD"; setTask("Restarting mission after death"); stopMovement(); });
  bot.on("health",()=>{ if(bot.health<=CFG.lowHealth){ bot.pvp.stop(); bot.setControlState("sprint",true); } });
  bot.on("kicked",reason=>log("Kicked:",typeof reason==="string"?reason:JSON.stringify(reason)));
  bot.on("error",err=>log("Error:",err.message));
  bot.on("end",()=>{ if(!missionDone){ log(`Disconnected; reconnecting in ${CFG.reconnectMs}ms`); setTimeout(createBot,CFG.reconnectMs); } });
  if(!loopRunning){ loopRunning=true; runLoop(); }
}

async function runLoop(){
  while(true){
    await sleep(CFG.tickMs);
    if(!bot?.entity||!mcData||stopped||missionDone) continue;
    if(dangerAt(pos())){ setTask("Escaping danger"); await escapeDanger(); continue; }
    if(bot.food<CFG.lowFood) await eatIfNeeded();
    if(await combatCheck()) continue;
    if(bot.health<=CFG.lowHealth){ await escapeDanger(); await eatIfNeeded(true); continue; }
    await missionStep();
  }
}

terminalCommands();
createBot();
