'use strict'

/**
 * Paradox Network Module Loader (Meteor-style)
 * LifeboatMode hooks serverbound last so tick-zero sees flags set by fly/cfly/etc.
 */

const fs = require('fs')
const path = require('path')

const MODULES_DIR = __dirname
const { createLogger } = require('../core/logger')
const loaded = []
const logger = createLogger('Paradox')

const DISABLED = new Set([
  'loader.js'
])

let bootstrapped = false

function loadModuleFile (file, relay, config, log) {
  const full = path.join(MODULES_DIR, file)
  try {
    delete require.cache[require.resolve(full)]
    const mod = require(full)
    if (!mod.name) return false

    loaded.push(mod)
    if (typeof mod.onEnable === 'function') {
      mod.onEnable(relay, config, log)
    }
    console.log(`${'\x1b[34m'}[Modules]${'\x1b[0m'} Loaded ${mod.name}`)
    return true
  } catch (err) {
    console.error(`[Modules] Failed to load ${file}:`, err.message)
    return false
  }
}

function loadModules (relay, config, log = logger) {
  if (bootstrapped) return

  const files = fs.readdirSync(MODULES_DIR).filter(f =>
    f.endsWith('.js') && !DISABLED.has(f)
  )

  // chat-commands.js must load first — re-requiring it later wipes the command
  // registry and drops commands registered by modules sorted before it (autoeat, arraylist).
  const CHAT_COMMANDS = 'chat-commands.js'
  if (files.includes(CHAT_COMMANDS)) {
    loadModuleFile(CHAT_COMMANDS, relay, config, log)
  }

  for (const file of files) {
    if (file === CHAT_COMMANDS) continue
    loadModuleFile(file, relay, config, log)
  }

  bootstrapped = true

  console.log(`${'\x1b[90m'}${loaded.length} modules ready${'\x1b[0m'}\n`)
}

function runOnPlayer (player, relay, config, log = logger) {
  try {
    const { installSafePacketHooks } = require('../core/safe-packet-hooks')
    installSafePacketHooks(player, log)
  } catch (_) {}

  try {
    const { bindVisitCapture } = require('../core/visit-frame')
    bindVisitCapture(player)
  } catch (_) {}

  const modules = [...loaded]
  const disIdx = modules.findIndex(m => m.name === 'LifeboatMode')
  const lifeboat = disIdx >= 0 ? modules[disIdx] : null
  const beforeLifeboat = disIdx >= 0
    ? [...modules.slice(0, disIdx), ...modules.slice(disIdx + 1)]
    : modules

  for (const mod of beforeLifeboat) {
    if (typeof mod.onPlayer === 'function') {
      try {
        mod.onPlayer(player, relay, config, log)
      } catch (e) {
        log.error(`${mod.name}.onPlayer: ${e.message}`)
      }
    }
  }

  if (lifeboat?.onPlayer) {
    try {
      lifeboat.onPlayer(player, relay, config, log)
    } catch (e) {
      log.error(`${lifeboat.name}.onPlayer: ${e.message}`)
    }
  }

  try {
    const tp = require('../core/tp')
    tp.bind(player)
  } catch (_) {}
}

function getLoadedModules () {
  return loaded
}

module.exports = { loadModules, runOnPlayer, getLoadedModules }