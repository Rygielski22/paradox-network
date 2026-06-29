'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { alignLinesRight } = require('../core/mc-font-width')

const MODULE_FLAGS = [
  ['_killauraEnabled',  'KillAura'],
  ['_triggerbotEnabled','TriggerBot'],
  ['_criticalsEnabled',  'Criticals'],
  ['_cflyFlying',       'CreativeFly'],
  ['_nofallEnabled',    'NoFall'],
  ['_autoeatEnabled',   'AutoEat'],
  ['_antikbEnabled',    'Velocity'],
  ['_surfaceTpPhase',   'SurfaceTp'],
  ['_noclipFlying',     'NoClip'],
  ['_speedFlyFlying',   'SpeedFly'],
  ['_stashEnabled',     'StashFinder'],
  ['_enemyTpPhase',     'EnemyTp'],
  ['_fbEnabled',        'FullBright'],
  ['_modAlertsEnabled', 'ModAlerts'],
  ['_tracersEnabled',   'Tracers'],
  ['_chestTpEnabled',   'TpChest'],
  ['_tpmineEnabled',    'TpMine'],
  ['_automineEnabled',  'AutoMine'],
  ['_joinAlertEnabled', 'JoinAlerts'],
  ['_playerCoordsPhase', 'PlayerCoords']
]

const MODULE_COLOR = '§8'

function sendActionBar (player, text) {
  if (!player || typeof player.queue !== 'function') return false
  try {
    player.queue('set_title', {
      type: 'action_bar_message',
      text,
      fade_in_time: 0,
      stay_time: 2147483647,
      fade_out_time: 0,
      xuid: '',
      platform_online_id: '',
      filtered_message: ''
    })
    return true
  } catch (_) {
    return false
  }
}

function configInterval (config) {
  const n = config?.get?.('theme.arraylist.updateInterval')
  return Math.max(8, typeof n === 'number' ? n : 12)
}

function buildHUD (player) {
  const active = []

  if (player._disablerEnabled !== false) {
    active.push('LifeboatMode')
  }

  for (const [flag, label] of MODULE_FLAGS) {
    const val = player[flag]
    if (val === true ||
        (flag === '_surfaceTpPhase' && val === 'flying') ||
        (flag === '_enemyTpPhase' && (val === 'flying' || val === 'landed')) ||
        (flag === '_playerCoordsPhase' && (val === 'scanning' || val === 'returning'))) {
      active.push(label)
    }
  }

  if (active.length === 0) return ''
  active.sort((a, b) => b.length - a.length)
  const lines = alignLinesRight(active.map((n) => MODULE_COLOR + n))
  return lines.join('\n')
}

function refreshArraylist (player, force = false) {
  if (player._arraylistEnabled === false) return

  const text = buildHUD(player)
  const payload = text || ' '

  if (!text) {
    if (!force && !player._alHadText) return
    if (sendActionBar(player, ' ')) {
      player._alHadText = false
      player._alLastText = ''
    }
    return
  }

  if (!force && payload === player._alLastText) return
  if (!sendActionBar(player, payload)) return

  player._alLastText = payload
  player._alHadText = true
}

function scheduleSpawnRefresh (player) {
  player._alLastText = ''
  for (const delay of [300, 900, 2000, 4000]) {
    setTimeout(() => refreshArraylist(player, true), delay)
  }
}

module.exports = {
  name: 'Arraylist',
  description: 'On-screen list of active modules',

  onEnable (relay) {
    registerCommand('arraylist', 'A cheat that toggles the HUD arraylist', (player, args) => {
      const a = (args[0] || '').toLowerCase()
      if (a === 'off') {
        player._arraylistEnabled = false
        player._alLastText = ''
        player._alHadText = false
        sendActionBar(player, ' ')
        sendMessage(player, theme.toggle('Arraylist', false))
      } else if (a === 'on') {
        player._arraylistEnabled = true
        player._alLastText = ''
        refreshArraylist(player, true)
        sendMessage(player, theme.toggle('Arraylist', true))
      } else {
        const state = player._arraylistEnabled !== false ? 'ON' : 'OFF'
        sendMessage(player, theme.line('Arraylist', `is ${state}`))
      }
    })
  },

  onPlayer (player, relay, config) {
    if (player._arraylistEnabled === undefined) {
      player._arraylistEnabled = config?.get?.('theme.arraylist.enabled') !== false
    }
    player._alLastText = ''
    player._alHadText = false
    player._alTick = 0

    player.on('clientbound', (data) => {
      if (data.name === 'play_status' && data.params?.status === 'player_spawn') {
        scheduleSpawnRefresh(player)
      }
      if (data.name === 'start_game') {
        setTimeout(() => refreshArraylist(player, true), 1600)
      }
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input') return
      if (player._arraylistEnabled === false) return

      const interval = configInterval(config)
      player._alTick++
      if (player._alTick % interval !== 0) return
      refreshArraylist(player, player._alTick % (interval * 4) === 0)
    })

    const heartbeat = setInterval(() => {
      if (player._arraylistEnabled === false) return
      refreshArraylist(player, true)
    }, 1500)

    scheduleSpawnRefresh(player)
    player.once('close', () => clearInterval(heartbeat))
  }
}