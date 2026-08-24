const fs = require('fs')
const path = require('path')

const botFile = path.join(__dirname, 'bot.js')
let src = fs.readFileSync(botFile, 'utf8')
const original = src

// The old version wrapped Mineflayer's low-level bot.look() before
// pathfinder/collectblock started. That interferes with pathfinder's turning
// calculations and can leave the bot connected but apparently frozen.
const lookStart = src.indexOf('  // --- Smooth head turning')
const pluginStart = src.indexOf('  bot.loadPlugin(pathfinder)', lookStart)
if (lookStart !== -1 && pluginStart !== -1) {
  src = src.slice(0, lookStart) + src.slice(pluginStart)
}

// Remove the now-unused smoothing helpers.
src = src.replace(
  /\nconst MAX_TURN_PER_CALL = \(28 \* Math\.PI\) \/ 180[\s\S]*?\nfunction clamp\(v, lo, hi\) \{ return Math\.max\(lo, Math\.min\(hi, v\)\) \}\n/,
  '\n'
)

// Use conservative, reliable pathfinder movement. Sprinting remains enabled;
// parkour is disabled because it can cause path stalls on Paper servers.
src = src.replace(
  "    movements.allowParkour = true      // jump gaps/1-block steps instead of walking around - faster routes\n    movements.allow1by1towers = false\n    movements.canDig = true\n    movements.maxDropDown = 3\n    movements.allowSprinting = true    // speedrunner-style movement instead of walking\n",
  "    movements.allowParkour = false\n    movements.allow1by1towers = false\n    movements.canDig = true\n    movements.maxDropDown = 2\n    movements.allowSprinting = true\n"
)

// Do not silently ignore path failures. A failed collection should surface as
// an error so the run can recover instead of looking frozen.
src = src.replace('      ignoreNoPath: true', '      ignoreNoPath: false')

// Small movement recovery helper for genuine collision stalls. It does not
// add, remove, or rename any terminal commands.
const marker = "function stopBot(reason = 'manual') {"
if (!src.includes('async function recoverMovement()')) {
  const helper = `async function recoverMovement() {\n  if (!bot || !bot.entity || stopped) return false\n  try {\n    bot.pathfinder.setGoal(null)\n    for (const c of ['forward','back','left','right','jump','sprint']) {\n      try { bot.setControlState(c, false) } catch {}\n    }\n    bot.setControlState('jump', true)\n    bot.setControlState('forward', true)\n    await sleep(450)\n    bot.setControlState('jump', false)\n    bot.setControlState('forward', false)\n    await sleep(150)\n    return true\n  } catch (e) {\n    say(\`Movement recovery failed: \${e.message}\`)\n    return false\n  }\n}\n\n`
  src = src.replace(marker, helper + marker)
}

if (src !== original) {
  fs.writeFileSync(botFile, src)
  console.log('[PATCH] Applied movement reliability fixes to bot.js')
} else {
  console.log('[PATCH] bot.js already contains the movement fixes (or no matching old code was found).')
}

require('./bot.js')
