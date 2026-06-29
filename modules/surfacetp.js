'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { meteorTp } = require('../core/meteor-tp')
const { prepareInstantTp, scheduleReleaseInstantTp } = require('../core/tp-prep')
const { triggerStatusPulse } = require('../core/mod-status')
const { authPacketFromPlayer } = require('../core/ka-entities')
const { hasMovementInput } = require('../core/tp/utils')

const DEFAULT_Y = 90

function authFromPlayer (player, pos) {
  const { buildPlayerAuthInput } = require('../core/protocol')
  return buildPlayerAuthInput(player, {
    ...authPacketFromPlayer(player, pos, player._kaLastAuth?.tick ?? 0),
    position: { x: pos.x, y: pos.y, z: pos.z },
    delta: { x: 0, y: 0, z: 0 },
    move_vector: { x: 0, z: 0 },
    raw_move_vector: { x: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 }
  })
}

function clearSurfaceTpSettle (player) {
  player._surfaceTpPhase = 'idle'
  player._surfaceTpTarget = null
  player._surfaceTpBlockCorrectionUntil = 0
}

function finishSurfaceTpArrival (player, dest) {
  player._surfaceTpPos = { x: dest.x, y: dest.y, z: dest.z }
  player._kaPos = { x: dest.x, y: dest.y, z: dest.z }
  player._surfaceTpPhase = 'idle'
  player._surfaceTpTarget = null
  player._surfaceTpBlockCorrectionUntil = 0
  scheduleReleaseInstantTp(player)
}

function canSurfaceTp (player) {
  if (player._surfaceTpPhase === 'flying') return false
  try {
    const tp = require('../core/tp')
    if (tp?.isSyncing?.(player) || tp?.isGuarding?.(player)) return false
  } catch (_) {}
  return true
}

module.exports = {
  name: 'SurfaceTP',
  description: 'Instant TP to surface Y level',

  onPlayer (player, relay) {
    if (player._surfaceTpY === undefined) player._surfaceTpY = DEFAULT_Y
    player._surfaceTpRid = null
    player._surfaceTpPos = null
    player._surfaceTpPhase = 'idle'
    player._surfaceTpTarget = null
    player._surfaceTpBlockCorrectionUntil = 0

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._surfaceTpRid = data.params.runtime_entity_id
      }
      if (data.name === 'change_dimension' || data.name === 'transfer') {
        clearSurfaceTpSettle(player)
        return
      }

      if (player._surfaceTpPhase !== 'flying') return
      if (data.name !== 'move_player' && data.name !== 'correct_player_movement') return

      if (data.name === 'move_player' && data.params?.position && player._surfaceTpPos) {
        const p = data.params.position
        if (Math.abs(p.x - player._surfaceTpPos.x) > 200 ||
            Math.abs(p.y - player._surfaceTpPos.y) > 200 ||
            Math.abs(p.z - player._surfaceTpPos.z) > 200) {
          clearSurfaceTpSettle(player)
          return
        }
      }

      try {
        const { shouldBlockClientbound } = require('../core/tp/guard')
        if (shouldBlockClientbound(player, data)) {
          des.canceled = true
        }
      } catch (_) {}
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return

      if (player._surfaceTpPhase === 'flying') return

      player._surfaceTpPos = data.params.position

      if (hasMovementInput(data.params)) {
        player._surfaceTpBlockCorrectionUntil = 0
        try {
          const { endSyncOnMovement } = require('../core/tp')
          endSyncOnMovement(player)
        } catch (_) {}
      }
    })
  },

  onEnable (relay) {
    registerCommand('surfacetp', 'TP straight up to surface Y (?surfacetp [y]/set <y>)', (player, args) => {
      const cmd = (args[0] || '').toLowerCase()
      if (cmd === 'set') {
        const n = parseFloat(args[1])
        if (isNaN(n) || n < -64 || n > 320) {
          sendMessage(player, theme.error('?surfacetp set <y>  (y must be -64..320)'))
          return
        }
        player._surfaceTpY = n
        sendMessage(player, theme.line('SurfaceTP', `default Y set to §f${n}`))
        return
      }

      let targetY = player._surfaceTpY
      if (cmd) {
        const n = parseFloat(cmd)
        if (!isNaN(n)) {
          if (n < -64 || n > 320) {
            sendMessage(player, theme.error('y must be -64..320'))
            return
          }
          targetY = n
        }
      }

      const pos = player._surfaceTpPos
      if (!pos || !player._surfaceTpRid) {
        sendMessage(player, theme.error('SurfaceTP: not ready (no position yet)'))
        return
      }

      if (!player._disablerEnabled) {
        sendMessage(player, theme.error('enable ?lifeboatmode on before using ?surfacetp'))
        return
      }

      if (!canSurfaceTp(player)) {
        sendMessage(player, theme.error('SurfaceTP: wait for current TP to finish'))
        return
      }

      const dest = { x: pos.x, y: targetY, z: pos.z }
      const rid = player._surfaceTpRid || player._runtimeId

      prepareInstantTp(player, 'surface')
      clearSurfaceTpSettle(player)
      player._surfaceTpPhase = 'flying'
      player._surfaceTpTarget = dest

      const ok = meteorTp(player, dest, pos, {
        moduleKey: 'surface',
        rid,
        authParams: authFromPlayer(player, pos),
        posProp: '_surfaceTpPos',
        onArrive: () => {
          finishSurfaceTpArrival(player, dest)
          triggerStatusPulse(player, `SurfaceTP -> y${targetY}`)
          sendMessage(player, theme.line('SurfaceTP',
            `→ §f${Math.round(pos.x)}, ${targetY}, ${Math.round(pos.z)} §aArrived`))
        }
      })

      if (!ok) {
        clearSurfaceTpSettle(player)
        sendMessage(player, theme.error('SurfaceTP failed — enable ?lifeboatmode on'))
      } else {
        sendMessage(player, theme.line('SurfaceTP', `§7→ y§f${targetY}`))
      }
    })
  }
}