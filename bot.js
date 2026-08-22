require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const pvp = require("mineflayer-pvp").plugin;
const minecraftData = require("minecraft-data");

const CFG = {
  host: process.env.MC_HOST || "stridesmp.mcsh.io",
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || "FayaazMJacc",
  version: process.env.MC_VERSION || undefined,

  hostileRange: 12,
  dangerRange: 4,
  lowHealth: 8,
  lowFood: 8,
  reconnectMs: 4000,
  loopMs: 350
};

let bot = null;
let data = null;
let moves = null;
let stopped = false;
let phase = "WOOD";
let recovering = false;
let currentTask = "Starting";
let deathPosition = null;
let deathTime = 0;

const HOSTILES = new Set([
  "zombie","skeleton","creeper","spider","cave_spider","drowned",
  "husk","stray","witch","pillager","vindicator","evoker",
  "ravager","phantom","silverfish","enderman","blaze","magma_cube","slime"
]);

const LOGS = [
  "oak_log","spruce_log","birch_log","jungle_log",
  "acacia_log","dark_oak_log","mangrove_log","cherry_log"
];

const PICKAXES = [
  "netherite_pickaxe","diamond_pickaxe","iron_pickaxe",
  "stone_pickaxe","wooden_pickaxe"
];

const WEAPONS = [
  "netherite_sword","diamond_sword","iron_sword","stone_sword",
  "wooden_sword","golden_sword",
  "netherite_axe","diamond_axe","iron_axe","stone_axe","wooden_axe"
];

const FOODS = [
  "cooked_beef","cooked_porkchop","cooked_mutton","cooked_chicken",
  "bread","baked_potato","cooked_rabbit","apple","carrot",
  "potato","sweet_berries"
];

function log(...x) {
  console.log("[BOT]", ...x);
}

function setTask(task) {
  currentTask = task;
  log("Task:", task);
}

function inventorySummary() {
  const items = bot.inventory.items();
  if (!items.length) return "empty";
  return items.map(i => `${i.name} x${i.count}`).join(", ");
}

function playerNameForChat(username) {
  return username || "Unknown";
}

function sendChat(message) {
  // Normal Mineflayer chat API: the server supplies the real sender name.
  bot.chat(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function distance(a, b) {
  return a.distanceTo(b);
}

function inventoryCount(names) {
  if (!Array.isArray(names)) names = [names];
  return bot.inventory.items()
    .filter(i => names.includes(i.name))
    .reduce((sum, i) => sum + i.count, 0);
}

function has(names) {
  return inventoryCount(names) > 0;
}

function bestItem(names) {
  return bot.inventory.items().find(i => names.includes(i.name));
}

function nearestEntity(filter) {
  return Object.values(bot.entities)
    .filter(e => e && e.position && filter(e))
    .sort((a, b) =>
      distance(bot.entity.position, a.position) -
      distance(bot.entity.position, b.position)
    )[0];
}

function isHostile(e) {
  return e.type === "mob" && HOSTILES.has((e.name || "").toLowerCase());
}

function dangerousBlock(block) {
  if (!block) return false;
  return ["lava","flowing_lava","fire","soul_fire"].includes(block.name);
}

function dangerAt(pos) {
  const center = pos.floored();
  for (let x = -CFG.dangerRange; x <= CFG.dangerRange; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -CFG.dangerRange; z <= CFG.dangerRange; z++) {
        if (dangerousBlock(bot.blockAt(center.offset(x,y,z)))) return true;
      }
    }
  }
  return false;
}

/*
 * No camera/head snapping:
 * There are intentionally no bot.look(), bot.lookAt(), forced yaw,
 * forced pitch, or instant rotation calls in this project.
 */
function enableFastMovement() {
  moves.canDig = true;
  moves.allowParkour = true;
  moves.allowSprinting = true;
  moves.allow1by1towers = false;
  moves.maxDropDown = 3;
  moves.infiniteLiquidDropdownDistance = false;
  bot.pathfinder.setMovements(moves);
  bot.setControlState("sprint", true);
}

async function safeGoto(goal, timeout = 10000) {
  if (dangerAt(bot.entity.position)) {
    await escapeDanger();
    if (dangerAt(bot.entity.position)) return false;
  }

  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      sleep(timeout).then(() => { throw new Error("path timeout"); })
    ]);
    return !dangerAt(bot.entity.position);
  } catch {
    bot.pathfinder.setGoal(null);
    return false;
  }
}

async function escapeDanger() {
  bot.pathfinder.setGoal(null);
  bot.pvp.stop();

  const p = bot.entity.position.floored();
  const options = [
    p.offset(6,0,0), p.offset(-6,0,0),
    p.offset(0,0,6), p.offset(0,0,-6),
    p.offset(5,2,5), p.offset(-5,2,-5)
  ];

  for (const t of options) {
    if (dangerousBlock(bot.blockAt(t)) ||
        dangerousBlock(bot.blockAt(t.offset(0,-1,0)))) continue;

    if (await safeGoto(new goals.GoalNear(t.x,t.y,t.z,2), 5000)) return true;
  }
  return false;
}

function nearestBlock(names, maxDistance = 48) {
  const set = new Set(Array.isArray(names) ? names : [names]);
  return bot.findBlock({
    maxDistance,
    matching: b => b && set.has(b.name)
  });
}

async function mineBlock(block) {
  if (!block || !block.position) return false;
  if (dangerAt(block.position)) return false;

  try {
    await safeGoto(
      new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
      7000
    );
    if (dangerAt(block.position)) return false;
    if (!bot.canDigBlock(block)) return false;
    await bot.dig(block, true);
    return true;
  } catch {
    return false;
  }
}

async function collectBlocks(names, amount) {
  let attempts = 0;
  while (inventoryCount(names) < amount && attempts++ < 12) {
    const block = nearestBlock(names);
    if (!block) return false;
    if (!(await mineBlock(block))) return false;
    await sleep(80);
  }
  return inventoryCount(names) >= amount;
}

async function craft(name, count = 1) {
  if (!data.itemsByName[name]) return false;

  try {
    const recipes = bot.recipesFor(data.itemsByName[name].id, null, 1, null);
    if (!recipes.length) return false;
    await bot.craft(recipes[0], count, null);
    return true;
  } catch {
    return false;
  }
}

async function equipBest(names) {
  const item = bestItem(names);
  if (!item) return false;
  try {
    await bot.equip(item, "hand");
    return true;
  } catch {
    return false;
  }
}

async function eat() {
  if (bot.food >= CFG.lowFood) return true;

  const food = bot.inventory.items()
    .filter(i => FOODS.includes(i.name))
    .sort((a,b) => b.count - a.count)[0];

  if (!food) return false;

  try {
    await bot.equip(food, "hand");
    await bot.consume();
    return true;
  } catch {
    return false;
  }
}

async function getWoodAndStarterTools() {
  if (!has(PICKAXES)) {
    if (!has(LOGS)) {
      const logBlock = nearestBlock(LOGS, 48);
      if (!logBlock || !(await mineBlock(logBlock))) return false;
    }

    await craft("oak_planks", 4);
    await craft("stick", 4);
    await craft("crafting_table", 1);
    await craft("wooden_pickaxe", 1);
  }

  return has(PICKAXES);
}

async function getStoneTools() {
  if (has(["stone_pickaxe","iron_pickaxe","diamond_pickaxe","netherite_pickaxe"])) {
    if (has(["stone_sword","iron_sword","diamond_sword","netherite_sword"])) return true;
  }

  const stone = nearestBlock(["stone","cobblestone"], 48);
  if (stone && !(await mineBlock(stone))) return false;

  await collectBlocks(["stone","cobblestone"], 11);
  await craft("stone_pickaxe", 1);
  await craft("stone_sword", 1);
  await craft("stone_axe", 1);

  return has(["stone_pickaxe","iron_pickaxe","diamond_pickaxe","netherite_pickaxe"]);
}

async function getFoodFast() {
  if (bot.food >= CFG.lowFood) return true;

  const animal = nearestEntity(e =>
    ["cow","pig","sheep","chicken"].includes(e.name) &&
    distance(bot.entity.position, e.position) <= 18
  );

  if (animal) {
    await fight(animal);
    await sleep(150);
  }

  return eat();
}

async function fight(target) {
  if (!target || !target.isValid) return;
  if (distance(bot.entity.position, target.position) > CFG.hostileRange) return;

  if (bot.health <= CFG.lowHealth) {
    await escapeDanger();
    await eat();
    return;
  }

  if (dangerAt(target.position)) return;

  await equipBest(WEAPONS);

  try {
    bot.pvp.attack(target);

    const deadline = Date.now() + 4500;

    while (target.isValid && Date.now() < deadline) {
      if (bot.health <= CFG.lowHealth || dangerAt(bot.entity.position)) {
        bot.pvp.stop();
        await escapeDanger();
        await eat();
        break;
      }

      await sleep(120);
    }

    bot.pvp.stop();
  } catch {
    bot.pvp.stop();
  }
}

async function handleCombat() {
  const target = nearestEntity(e =>
    isHostile(e) &&
    distance(bot.entity.position, e.position) <= CFG.hostileRange
  );

  if (target) {
    log("Fighting", target.name);
    await fight(target);
  }
}

async function getCoalAndSurface() {
  const coal = nearestBlock(["coal_ore","deepslate_coal_ore"], 48);

  if (coal) {
    await mineBlock(coal);
    await collectBlocks(["coal_ore","deepslate_coal_ore"], 4);
  }

  // Prefer returning upward rather than continuing deep underground.
  const startY = bot.entity.position.y;
  if (startY < 70) {
    for (let i = 0; i < 10 && bot.entity.position.y < 70; i++) {
      const p = bot.entity.position;
      const goal = new goals.GoalNear(p.x, Math.min(100, p.y + 8), p.z, 2);
      if (!(await safeGoto(goal, 5000))) break;
    }
  }
}

async function safeExplore() {
  const p = bot.entity.position.floored();

  // Short, efficient routes. No random spinning or head snapping.
  const choices = [
    p.offset(20,0,0),
    p.offset(-20,0,0),
    p.offset(0,0,20),
    p.offset(0,0,-20)
  ];

  for (const t of choices) {
    if (await safeGoto(new goals.GoalNear(t.x,t.y,t.z,3), 7000)) return;
  }
}

async function recoverAfterDeath() {
  if (!recovering) return;
  recovering = false;

  await sleep(1800);

  // Never attempt recovery if the death location is obviously dangerous.
  if (!deathPosition || dangerAt(deathPosition)) {
    setTask("Restarting progression after unsafe death");
    log("Death area unsafe; restarting progression.");
    phase = "WOOD";
    return;
  }

  // Only walk a short distance toward the death location.
  const d = distance(bot.entity.position, deathPosition);

  if (d > 24) {
    log("Death drops too far away; restarting progression.");
    phase = "WOOD";
    return;
  }

  log("Attempting safe death-drop recovery.");

  const ok = await safeGoto(
    new goals.GoalNear(
      deathPosition.x,
      deathPosition.y,
      deathPosition.z,
      2
    ),
    9000
  );

  if (!ok || dangerAt(bot.entity.position)) {
    log("Recovery unsafe; restarting from zero.");
    phase = "WOOD";
    return;
  }

  await sleep(1200);
  await equipBest(PICKAXES);
  phase = has(PICKAXES) ? "FOOD" : "WOOD";
}

async function progressionStep() {
  if (phase === "WOOD") {
    setTask("Getting wood and starter tools");
    log("Wood + starter tools");
    await getWoodAndStarterTools();
    phase = "STONE";
    return;
  }

  if (phase === "STONE") {
    setTask("Getting stone tools");
    log("Stone tools");
    await getStoneTools();
    phase = "FOOD";
    return;
  }

  if (phase === "FOOD") {
    setTask("Getting food");
    log("Food");
    await getFoodFast();
    phase = "COAL";
    return;
  }

  if (phase === "COAL") {
    setTask("Getting coal and resurfacing");
    log("Coal + resurface");
    await getCoalAndSurface();
    phase = "SURVIVE";
    return;
  }

  if (phase === "SURVIVE") {
    setTask("Surviving and exploring safely");
    await equipBest(PICKAXES);
    await eat();
    await safeExplore();
  }
}

function createBot() {
  bot = mineflayer.createBot({
    host: CFG.host,
    port: CFG.port,
    username: CFG.username,
    version: CFG.version
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);

  bot.once("spawn", async () => {
    data = minecraftData(bot.version);
    moves = new Movements(bot, data);
    enableFastMovement();

    phase = "WOOD";
    setTask("Starting survival progression");
    log(`Connected to ${CFG.host}:${CFG.port} as ${CFG.username}`);
    log("Fast movement enabled; no head/camera snapping.");
  });

  bot.on("death", () => {
    deathPosition = bot.entity.position.clone();
    deathTime = Date.now();
    recovering = true;
    phase = "RECOVER";
    bot.pvp.stop();
    setTask("Recovering after death");
    log("Died. Checking for safe recovery after respawn.");
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;

    // The incoming Mineflayer chat event gives the actual Minecraft username.
    // We only use that value for display; we do not spoof or rewrite senders.
    const sender = playerNameForChat(username);
    log(`<${sender}> ${message}`);

    if (message === "!task") {
      sendChat(`Task: ${currentTask} | Phase: ${phase}`);
      return;
    }

    if (message === "!inv") {
      sendChat(`Inventory: ${inventorySummary()}`);
      return;
    }

    if (message === "!status") {
      sendChat(
        `Status: task=${currentTask} | phase=${phase} | hp=${Math.round(bot.health)} | food=${Math.round(bot.food)}`
      );
      return;
    }

    if (message === "!stop") {
      stopped = true;
      setTask("Stopped by command");
      bot.pathfinder.setGoal(null);
      bot.pvp.stop();
      bot.clearControlStates();
      sendChat("Stopped.");
      return;
    }

    if (message === "!resume") {
      stopped = false;
      enableFastMovement();
      setTask("Resuming survival tasks");
      sendChat("Resuming.");
    }
  });

  bot.on("health", () => {
    if (bot.health <= CFG.lowHealth) {
      bot.pvp.stop();
      bot.setControlState("sprint", true);
    }
  });

  bot.on("kicked", reason => log("Kicked:", reason));
  bot.on("error", err => log("Network/error:", err.message));
  bot.on("end", () => {
    log(`Disconnected; reconnecting in ${CFG.reconnectMs}ms`);
    setTimeout(createBot, CFG.reconnectMs);
  });

  runLoop();
}

async function runLoop() {
  while (bot) {
    await sleep(CFG.loopMs);

    if (!bot.entity || !data || stopped) continue;

    if (recovering) {
      await recoverAfterDeath();
      continue;
    }

    // Highest-priority safety checks.
    if (dangerAt(bot.entity.position)) {
      await escapeDanger();
      continue;
    }

    if (bot.food < CFG.lowFood) await eat();

    await handleCombat();

    if (bot.health <= CFG.lowHealth) {
      await escapeDanger();
      await eat();
      continue;
    }

    await progressionStep();
  }
}

createBot();
