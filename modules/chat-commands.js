/**
 * Chat Commands System
 * ─────────────────────────────────────────────────────────────────────────
 * Handles all command registration and dispatch. The command prefix is fully
 * configurable via config.json -> theme.commands.prefix (default ".").
 * All built-in output is themed through core/theme.js.
 */

'use strict'

const theme = require('../core/theme')
const { sendSystemChat } = require('../core/chat')

const commands = {}
let _config = null
let _logger = null
let _cachedInjectEntries = null

const { createLogger } = require('../core/logger')
const defaultLogger = createLogger('Commands')

function resolveLogger (logger) {
  return logger && typeof logger.error === 'function' ? logger : defaultLogger
}

function formatCheatDescription (desc) {
  let d = String(desc || 'runs a proxy command').replace(/^§[0-9a-f]/gi, '').trim()
  d = d.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (/^a cheat that\b/i.test(d)) return d
  const rest = d.charAt(0).toLowerCase() + d.slice(1)
  const verbLead = /^(enables|allows|shows|displays|toggles|prevents|reduces|removes|alerts|finds|teleports|tp)\b/
  if (verbLead.test(rest)) return `A cheat that ${rest}`
  return `A cheat that enables ${rest}`
}

function invalidateCommandCache () {
  _cachedInjectEntries = null
}

function enumValue (params, value) {
  let i = params.enum_values.indexOf(value)
  if (i === -1) i = params.enum_values.push(value) - 1
  return i
}

function softEnum (params, nameEnum, values) {
  let i = params.dynamic_enums.findIndex(e => e.name === nameEnum)
  if (i === -1) {
    i = params.dynamic_enums.push({ name: nameEnum, values: [...values] }) - 1
    return i
  }
  for (const v of values) {
    if (!params.dynamic_enums[i].values.includes(v)) {
      params.dynamic_enums[i].values.push(v)
    }
  }
  return i
}

function hardEnum (params, nameEnum, values) {
  const indices = values.map(v => enumValue(params, v))
  let i = params.enums.findIndex(e => e.name === nameEnum && e.values.every((v, j) => v === indices[j]))
  if (i === -1) i = params.enums.push({ name: nameEnum, values: indices }) - 1
  return i
}

function buildCommandParameters (params, cmd, usage) {
  const parameters = []
  if (!usage || !params) return parameters
  for (const [paramName, configParam] of Object.entries(usage)) {
    let valueType = 56
    let enumType = 'valid'
    if (configParam.type === 'enum') {
      valueType = softEnum(params, configParam.enumName ?? `${cmd}_${paramName}`, configParam.values)
      enumType = 'soft_enum'
    } else if (configParam.type === 'boolean') {
      valueType = hardEnum(params, `${cmd}_${paramName}`, ['true', 'false'])
      enumType = 'enum'
    } else if (configParam.type === 'int') {
      valueType = 'int'
    } else if (configParam.type === 'float') {
      valueType = 'float'
    } else if (configParam.type === 'target') {
      valueType = 'target'
    }
    parameters.push({
      parameter_name: paramName,
      value_type: valueType,
      enum_type: enumType,
      optional: configParam.optional ?? false,
      options: {
        unused: 0,
        collapse_enum: 0,
        has_semantic_constraint: 0,
        as_chained_command: 0,
        unknown2: 0
      }
    })
  }
  return parameters
}

function buildInjectEntries (params = null) {
  if (!params && _cachedInjectEntries) return _cachedInjectEntries
  const accent = theme.primary || '§1'
  const p = theme.prefix
  const entries = []
  for (const [cmd, info] of Object.entries(commands)) {
    const bare = cmd.toLowerCase()
    const desc = formatCheatDescription(info.description)
    const parameters = buildCommandParameters(params, bare, info.usage)
    const entry = {
      name: p ? `${p}${bare}` : bare,
      description: `${accent}${desc}`,
      flags: 0,
      permission_level: 'any',
      alias: -1,
      chained_subcommand_offsets: [],
      overloads: [{ chaining: false, parameters }]
    }
    entries.push(entry)
  }
  if (!params) _cachedInjectEntries = entries
  return entries
}

function cloneAvailPacket (params) {
  if (!params) return null
  try {
    return JSON.parse(JSON.stringify(params))
  } catch (_) {
    return null
  }
}

function normalizeAvailableCommands (params) {
  const p = cloneAvailPacket(params) || {}
  if (!Array.isArray(p.enum_values)) p.enum_values = []
  if (!Array.isArray(p.chained_subcommand_values)) p.chained_subcommand_values = []
  if (!Array.isArray(p.suffixes)) p.suffixes = []
  if (!Array.isArray(p.enums)) p.enums = []
  if (!Array.isArray(p.chained_subcommands)) p.chained_subcommands = []
  if (!Array.isArray(p.command_data)) p.command_data = []
  if (!Array.isArray(p.dynamic_enums)) p.dynamic_enums = []
  if (!Array.isArray(p.enum_constraints)) p.enum_constraints = []
  p.values_len = p.enum_values.length
  return p
}

function buildMeteorOnlyPacket () {
  return normalizeAvailableCommands({ command_data: [] })
}

function registerDeferredModuleCommands () {
}

function refreshPlayerCommands (player, logger) {
  if (!player || typeof player.queue !== 'function') return
  const log = resolveLogger(logger)
  const base = player._meteorAvailCmdPkt
    ? cloneAvailPacket(player._meteorAvailCmdPkt)
    : buildMeteorOnlyPacket()
  if (!base) return
  pushAvailableCommands(player, base, log)
}

function mergeMeteorCommands (params) {
  if (!params) return false
  if (!Array.isArray(params.command_data)) params.command_data = []
  const inject = buildInjectEntries(params)
  if (!inject.length) return false
  const seen = new Set(params.command_data.map((c) => (c.name || '').toLowerCase()))
  let added = 0
  for (const entry of inject) {
    const key = entry.name.toLowerCase()
    if (seen.has(key)) continue
    params.command_data.push(entry)
    seen.add(key)
    added++
  }
  return added > 0 || inject.length > 0
}

function pushAvailableCommands (player, params, logger) {
  if (!player || typeof player.queue !== 'function') return false
  const pkt = normalizeAvailableCommands(params)
  if (!mergeMeteorCommands(pkt)) return false
  try {
    player.queue('available_commands', pkt)
    return true
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[Commands] available_commands encode failed: ${msg}`)
    } else {
      console.warn(`[Commands] available_commands encode failed: ${msg}`)
    }
    return false
  }
}

function registerCommand (name, description, handler, usage = null) {
  commands[name.toLowerCase()] = {
    description: formatCheatDescription(description),
    handler,
    usage
  }
  invalidateCommandCache()
}

function sendMessage (player, text) {
  sendSystemChat(player, text)
}

function onDeath (player, fn) {
  if (!player._meteorDeathCallbacks) player._meteorDeathCallbacks = []
  player._meteorDeathCallbacks.push(fn)
}

/** @deprecated Modules stay enabled — use core/death-resync pause instead. */
function deathDisable (player, _flag, _name) {
  onDeath(player, () => {})
}

function stopActiveMovementOnDeath (player) {
  const { onPlayerDeath } = require('../core/death-resync')
  onPlayerDeath(player)
}

function parseMeteorCommand (raw) {
  const text = (raw || '').trim()
  if (!text.startsWith('/')) return null
  let body = text.slice(1)
  const p = theme.prefix
  if (p && body.startsWith(p)) body = body.slice(p.length)
  const parts = body.split(' ').filter(Boolean)
  if (!parts[0]) return null
  return { cmd: parts[0].toLowerCase(), args: parts.slice(1) }
}

registerCommand('help', 'A cheat that shows all available commands', (player, args) => {
  const p = theme.prefix
  const sorted = Object.entries(commands).sort((a, b) => a[0].localeCompare(b[0]))
  const pad = Math.max(...sorted.map(([c]) => c.length))
  const lines = [
    theme.heading(`Commands (${sorted.length})`),
    ''
  ]
  for (const [cmd, info] of sorted) {
    const spaces = ' '.repeat(pad - cmd.length + 2)
    const display = p ? `${p}${cmd}` : cmd
    lines.push(`  ${theme.primary}/${display}${spaces}§7${info.description}`)
  }
  lines.push('')
  lines.push(`§7Use ${theme.primary}/${p ? p : ''}<cmd> §7to run a command`)
  sendMessage(player, lines.join('\n'))
})

module.exports = {
  name: 'ChatCommands',
  description: 'Configurable command system (?help)',

  registerCommand,
  sendMessage,
  sendMsg: sendMessage,
  onDeath,
  deathDisable,
  stopActiveMovementOnDeath,
  mergeMeteorCommands,
  buildInjectEntries,

  onEnable (relay, config, logger) {
    _config = config
    _logger = resolveLogger(logger)
    registerDeferredModuleCommands()
  },

  onPlayer (player, relay, config, logger) {
    _config = config
    const log = resolveLogger(logger || _logger)
    let ready = false

    player.on('clientbound', (data, des) => {
      const { name, params } = data
      if (!ready && name === 'play_status') {
        ready = true
      }

      if (name === 'start_game' && params) {
        player._runtimeId = params.runtime_entity_id
        player._meteorServerCommands = null
        player._meteorAvailCmdPkt = null
        registerDeferredModuleCommands()
        for (const delay of [400, 1200, 2500]) {
          setTimeout(() => refreshPlayerCommands(player, log), delay)
        }
      }

      if (name === 'entity_event' && params &&
          params.event_id === 'death_smoke_cloud' &&
          String(params.runtime_entity_id) === String(player._runtimeId)) {
        stopActiveMovementOnDeath(player)
        if (player._meteorDeathCallbacks) {
          for (const cb of player._meteorDeathCallbacks) {
            try { cb() } catch (e) {}
          }
        }
      }

      if (ready && (name === 'move_player' || name === 'correct_player_movement')) {
        player._lastPos = params.position || params
      }

      // Merge Meteor commands into every available_commands refresh.
      // available_commands is raw-forwarded when not canceled — skipping a refresh
      // wipes tab-complete, so we must always cancel + re-queue our merged list.
      if (name === 'available_commands' && params) {
        player._meteorAvailCmdPkt = cloneAvailPacket(params)
        player._meteorServerCommands = player._meteorAvailCmdPkt
          ? player._meteorAvailCmdPkt.command_data.map((c) => ({ ...c }))
          : []
        if (pushAvailableCommands(player, player._meteorAvailCmdPkt, log)) {
          des.canceled = true
        }
        return
      }

      if (name === 'play_status' && params?.status === 'player_spawn') {
        registerDeferredModuleCommands()
        for (const delay of [400, 1200, 2500]) {
          setTimeout(() => refreshPlayerCommands(player, log), delay)
        }
      }
    })

    player.on('serverbound', ({ name, params }, des) => {
      if (name !== 'command_request') return

      const raw = params.command || ''
      const parsed = parseMeteorCommand(raw)
      if (!parsed) return

      const { cmd: cmdName, args } = parsed
      if (!commands[cmdName]) return

      des.canceled = true

      if (config?.get?.('logging.logCommands')) {
        log.command(player.profile?.name || 'Unknown', raw)
      }

      try {
        commands[cmdName].handler(player, args)
      } catch (err) {
        log.error(`Command error (${cmdName}): ${err.message}`)
        sendMessage(player, theme.error(`Error executing command: ${err.message}`))
      }
    })
  }
}