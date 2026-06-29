'use strict'

/**
 * Config — auto-saves all module settings on disconnect, auto-loads on join.
 * Stored per-gamertag in player-configs/<name>.json
 *
 * .config save   — manual save
 * .config load   — manual load
 * .config reset  — delete saved config
 * .config list   — show what's saved
 */

const fs   = require('fs')
const path = require('path')
const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

const CONFIG_DIR = path.join(__dirname, '..', 'player-configs')
try { fs.mkdirSync(CONFIG_DIR, { recursive: true }) } catch (_) {}

// Every player flag that gets saved/loaded
const KEYS = [
  // Fly
  '_flyEnabled', '_flySpeed',
  // Disabler
  '_disablerEnabled',
  // KillAura
  '_killauraEnabled', '_killauraRange', '_killauraCPS', '_killauraDelay',
  // TPAura2
  '_tpauraEnabled', '_tpauraRange', '_tpauraDelay', '_tpauraSteps', '_tpauraRadius', '_tpauraTpMode', '_tpauraYOffset',
  // MobAura / TriggerBot / EnemyTP
  '_mobauraEnabled', '_mobauraRange', '_mobauraDelay',
  '_triggerbotEnabled', '_triggerbotDelay', '_triggerbotRange', '_triggerbotFov',
  '_criticalsEnabled',
  '_enemyTpRange', '_enemyTpSpeed', '_enemyTpThreshold',
  // ModAlerts
  '_modAlertsEnabled', '_modAlertsAutohub',
  // AntiHit
  '_antihitEnabled', '_antihitRadius', '_antihitSpeed', '_antihitHeight',
  // Velocity (antikb)
  '_antikbEnabled', '_antikbPercent',
  // NoFall
  '_nofallEnabled',
  // AutoEat
  '_autoeatEnabled', '_aeThreshold', '_aeFoodSlot',
  // NoSlow
  '_noslowEnabled',
  // Phase
  '_phaseEnabled',
  // AirJump
  '_airjumpEnabled',
  // Speed
  '_speedEnabled', '_speedMultiplier',
  // Haste
  '_hasteEnabled', '_hasteLevel',
  // Fullbright
  '_fbEnabled',
  // Tracers
  '_tracersEnabled',
  // CreativeFly
  '_cflyEnabled', '_cflySpeed', '_cflyVerticalSpeed',
  // StashFinder
  '_stashEnabled',
  // TpChest
  '_chestTpEnabled',
  // TpMine
  '_tpmineEnabled', '_tpmineFilter',
  // AutoMine
  '_automineEnabled', '_amFilter',
  // Spammer
  '_spamEnabled',
  // DamageAlerts / DamageText
  '_daEnabled', '_dtEnabled',
  // PlayerESP / StorageESP
  '_pespEnabled', '_seEnabled',
  // Arraylist / HUD
  '_arraylistEnabled',
  // JoinAlerts
  '_joinAlertEnabled',

  // Friends (persist as array, convert from/to Set)
  '_friendsList',
]

function configPath(name) {
  return path.join(CONFIG_DIR, `${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.json`)
}

function namedSavePath(playerName, saveName) {
  const dir = path.join(CONFIG_DIR, playerName.toLowerCase().replace(/[^a-z0-9_-]/g, '_'), 'saves')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
  return path.join(dir, `${saveName.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.json`)
}

function listNamed(player) {
  const name = player.profile?.name
  if (!name) return []
  const dir = path.join(CONFIG_DIR, name.toLowerCase().replace(/[^a-z0-9_-]/g, '_'), 'saves')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
}

function saveNamed(player, saveName) {
  const data = {}
  for (const key of KEYS) {
    if (key === '_friendsList') {
      if (player._friends instanceof Set) data._friendsList = [...player._friends]
    } else {
      if (player[key] !== undefined) data[key] = player[key]
    }
  }
  try {
    fs.writeFileSync(namedSavePath(player.profile?.name || 'unknown', saveName), JSON.stringify(data, null, 2))
    return true
  } catch (e) { return false }
}

function loadNamed(player, saveName) {
  const fp = namedSavePath(player.profile?.name || 'unknown', saveName)
  if (!fs.existsSync(fp)) return false
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    for (const key of KEYS) {
      if (!(key in data)) continue
      if (key === '_friendsList') {
        if (!player._friends) player._friends = new Set()
        for (const f of (data._friendsList || [])) player._friends.add(f)
      } else {
        player[key] = data[key]
      }
    }
    return true
  } catch (e) { return false }
}

function deleteNamed(player, saveName) {
  try { fs.unlinkSync(namedSavePath(player.profile?.name || 'unknown', saveName)); return true } catch (_) { return false }
}

function save(player) {
  const name = player.profile?.name
  if (!name) return false
  const data = {}
  for (const key of KEYS) {
    if (key === '_friendsList') {
      // Serialize friends Set as array
      if (player._friends instanceof Set) data._friendsList = [...player._friends]
    } else {
      if (player[key] !== undefined) data[key] = player[key]
    }
  }
  try {
    fs.writeFileSync(configPath(name), JSON.stringify(data, null, 2))
    return true
  } catch (e) {
    console.error('[Config] save failed:', e.message)
    return false
  }
}

function load(player) {
  const name = player.profile?.name
  if (!name) return false
  const fp = configPath(name)
  if (!fs.existsSync(fp)) return false
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    for (const key of KEYS) {
      if (!(key in data)) continue
      if (key === '_friendsList') {
        // Restore as Set — merge with session friends if any
        if (!player._friends) player._friends = new Set()
        for (const f of (data._friendsList || [])) player._friends.add(f)
      } else {
        player[key] = data[key]
      }
    }
    // Migration: retired keys → KillAura
    let migrated = false
    const deadKeys = [
      '_reachEnabled', '_reachValue', '_infauraEnabled', '_infreachEnabled',
      '_infreachReach', '_meteorauraMode', '_meteorauraEnabled', '_meteorauraReach',
      '_meteorauraCPS', '_meteorauraDelay'
    ]
    for (const dead of deadKeys) {
      if (!(dead in data)) continue
      if (dead === '_meteorauraEnabled' || dead === '_infauraEnabled' || dead === '_infreachEnabled') {
        if (data[dead] === true) player._killauraEnabled = true
      } else if (dead === '_meteorauraReach' || dead === '_infreachReach') {
        if (typeof data[dead] === 'number') player._killauraRange = data[dead]
      } else if (dead === '_meteorauraCPS') {
        if (typeof data[dead] === 'number') player._killauraCPS = data[dead]
      } else if (dead === '_meteorauraDelay') {
        const delay = data[dead]
        if (typeof delay === 'number' && delay > 0) {
          player._killauraDelay = delay
          if (player._killauraCPS == null) {
            player._killauraCPS = Math.max(1, Math.min(20, Math.round(1000 / delay)))
          }
        }
      }
      delete player[dead]
      migrated = true
    }
    if ('_disabler2Mode' in data) {
      delete player._disabler2Mode
      migrated = true
    }
    if (player._killauraRange == null) player._killauraRange = 100
    if (player._killauraCPS == null && player._killauraDelay == null) {
      player._killauraCPS = 20
    }
    if (migrated) save(player)
    if (player._killauraEnabled) player._killauraWantOn = true
    return true
  } catch (e) {
    console.error('[Config] load failed:', e.message)
    return false
  }
}

function reset(player) {
  const name = player.profile?.name
  if (!name) return false
  try { fs.unlinkSync(configPath(name)); return true } catch (_) { return false }
}

// ─── Named presets ─────────────────────────────────────────────────────
// Available to everyone via `.config load <preset_name>`. Each entry maps
// a preset name to a set of flag overrides applied to the player.
const PRESETS = {
  droopy: {
    label: 'Droopy preset',
    flags: {
      _fbEnabled:       true,    // Fullbright
      _cflyEnabled:     true,    // CreativeFly
      _cflySpeed:       6,
      _cflyVerticalSpeed: 6,
      _nofallEnabled:   true,
      _antikbEnabled:   true,    // Velocity
      _tracersEnabled:  true,
      _pespEnabled:     true,    // PlayerESP
      _seEnabled:       true     // StorageESP
    }
  }
}

// Per-player auto-preset map. Add a name → preset entry here to make a
// specific preset apply automatically on every join for that account.
const AUTO_PRESETS = {
  'm3teorproxy':   'droopy',
  'andysalt0122':  'droopy'
}

function applyPreset(player, presetName) {
  const preset = PRESETS[presetName.toLowerCase()]
  if (!preset) return null
  const applied = []
  for (const [flag, value] of Object.entries(preset.flags)) {
    player[flag] = value
    applied.push(flag.replace(/^_/, '').replace(/Enabled$/, ''))
  }
  return { label: preset.label, applied }
}

function list(player) {
  const name = player.profile?.name
  if (!name) return null
  const fp = configPath(name)
  if (!fs.existsSync(fp)) return null
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    return Object.entries(data)
      .filter(([k, v]) => v !== false && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `  ${theme.secondary}${k.replace('_', '')} ${theme.accent}= ${theme.highlight}${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
      .join('\n')
  } catch (_) { return null }
}

module.exports = {
  name: 'Config',
  description: 'Auto-save/load all module settings per player',

  onPlayer(player, relay) {
    // Auto-load 1.5s after joining (let other modules init first)
    player.on('clientbound', (data) => {
      if (data.name === 'start_game') {
        setTimeout(() => {
          if (load(player)) {
            sendMessage(player, theme.line('Config', '§7settings loaded'))
          }
          // Per-player auto-preset (applied AFTER saved config so it always
          // wins). Keyed by lower-cased gamertag.
          const name = (player.profile?.name || '').toLowerCase()
          const presetName = AUTO_PRESETS[name]
          if (presetName) {
            const result = applyPreset(player, presetName)
            if (result) {
              sendMessage(player, theme.toggle('Config', true, `§7auto-preset §f${result.label}`))
              console.log(`[Config] auto-applied "${presetName}" preset for ${player.profile?.name}`)
            }
          }
        }, 1500)
      }
    })

    // Auto-save on disconnect
    player.on('close', () => {
      save(player)
      console.log(`[Config] saved for ${player.profile?.name || '?'}`)
    })
  },

  onEnable(relay) {
    registerCommand('config', 'Named configs (.config save/load/delete/list [name])', (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      const name = (args[1] || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')

      if (arg === 'save') {
        if (name) {
          if (saveNamed(player, name)) sendMessage(player, theme.line('Config', `§7saved as §f${name}`))
          else sendMessage(player, theme.error('Failed to save'))
        } else {
          save(player)
          sendMessage(player, theme.line('Config', '§7auto-config saved'))
        }
      } else if (arg === 'load') {
        if (name) {
          // Try named save first, then built-in preset
          if (loadNamed(player, name)) {
            sendMessage(player, theme.line('Config', `§fLoaded §a${name}`))
          } else {
            const result = applyPreset(player, name)
            if (result) sendMessage(player, theme.line('Config', `§fLoaded preset §a${result.label}`))
            else sendMessage(player, theme.error(`No config or preset named "${name}"`))
          }
        } else {
          if (load(player)) sendMessage(player, theme.line('Config', '§7auto-config loaded'))
          else sendMessage(player, theme.error('No auto-config saved'))
        }
      } else if (arg === 'delete' || arg === 'del') {
        if (!name) { sendMessage(player, theme.error('.config delete <name>')); return }
        if (deleteNamed(player, name)) sendMessage(player, theme.line('Config', `§7deleted §f${name}`))
        else sendMessage(player, theme.error(`No config named "${name}"`))
      } else if (arg === 'list') {
        const saves = listNamed(player)
        const presets = Object.keys(PRESETS)
        const lines = [`§5§lYour saves: §f${saves.length ? saves.join('§7, §f') : '§8none'}`]
        if (presets.length) lines.push(`§5§lBuilt-in presets: §f${presets.join('§7, §f')}`)
        sendMessage(player, lines.join('\n'))
      } else if (arg === 'reset') {
        reset(player)
        sendMessage(player, theme.line('Config', '§7auto-config deleted'))
      } else {
        sendMessage(player, theme.line('Config', '.config save/load/delete/list [name]'))
      }
    })
  }
}


