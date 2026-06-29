'use strict'

/**
 * NoClip — cfly-style smooth fly with collision disabled.
 * Client handles movement; disabler re-sends abilities + tick=0 while flying.
 *
 * ?noclip on/off/speed <n>/verticalspeed <n>
 */

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

const DEFAULT_SPEED = 6
const DEFAULT_VERTICAL_SPEED = 6
const LAND_GUARD_MS = 600

module.exports = {
  name: 'NoClip',
  description: 'Smooth fly through blocks (cfly-style, no jump toggle)',

  onPlayer (player, relay) {
    if (player._noclipEnabled === undefined) player._noclipEnabled = false
    if (player._noclipSpeed === undefined) player._noclipSpeed = DEFAULT_SPEED
    if (player._noclipVerticalSpeed === undefined) player._noclipVerticalSpeed = DEFAULT_VERTICAL_SPEED
    player._noclipFlying = false
    player._noclipLastPos = null

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._runtimeId = data.params.runtime_entity_id
      }

      const inLandGuard = player._noclipLandGuardUntil && Date.now() < player._noclipLandGuardUntil
      if (player._noclipFlying || inLandGuard) {
        if (data.name === 'correct_player_movement') {
          des.canceled = true
          return
        }
        if (data.name === 'move_player' && data.params &&
            String(data.params.runtime_id) === String(player._runtimeId)) {
          des.canceled = true
          return
        }
      }

      if (data.name === 'entity_event' && data.params && player._noclipFlying) {
        if (data.params.event_id === 'death_smoke_cloud' &&
            String(data.params.runtime_entity_id) === String(player._runtimeId)) {
          landPlayer(player)
        }
      }
      if (data.name === 'set_health' && data.params?.health <= 0 && player._noclipFlying) {
        landPlayer(player)
      }
      if (data.name === 'respawn' && player._noclipFlying) landPlayer(player)
      if (data.name === 'change_dimension' && player._noclipFlying) landPlayer(player)
    })

    player.on('serverbound', (data) => {
      if (data.name === 'player_auth_input' && data.params?.position) {
        player._noclipLastPos = data.params.position
      }
    })
  },

  onEnable (relay) {
    const help = '?noclip on/off/speed/verticalspeed <1-10>'
    registerCommand('noclip', `Fly through blocks (${help})`, (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') {
        player._noclipEnabled = true
        player._noclipFlying = true
        player._noclipLandGuardUntil = 0
        player._disablerAbilitiesTick = 0
        sendAbilities(player, true)
        sendMessage(player, theme.toggle('NoClip', true, '§aFlying'))
      } else if (arg === 'off') {
        player._noclipEnabled = false
        player._noclipFlying = false
        landPlayer(player)
        sendMessage(player, theme.toggle('NoClip', false))
      } else if (arg === 'speed') {
        const val = parseFloat(args[1])
        if (isNaN(val) || val <= 0 || val > 10) {
          sendMessage(player, theme.error('?noclip speed <1-10>'))
          return
        }
        player._noclipSpeed = val
        if (player._noclipFlying) sendAbilities(player, true)
        sendMessage(player, theme.line('NoClip', `speed §f${val}§7 → fly_speed §f${(val * 0.05).toFixed(3)}`))
      } else if (arg === 'verticalspeed' || arg === 'vertical' || arg === 'vspeed' || arg === 'v') {
        const val = parseFloat(args[1])
        if (isNaN(val) || val <= 0 || val > 10) {
          sendMessage(player, theme.error('?noclip verticalspeed <1-10>'))
          return
        }
        player._noclipVerticalSpeed = val
        if (player._noclipFlying) sendAbilities(player, true)
        sendMessage(player, theme.line('NoClip', `verticalspeed §f${val}`))
      } else {
        sendMessage(player, theme.line('NoClip',
          `is ${theme.status(player._noclipFlying)}\n§7Speed: §f${player._noclipSpeed}`))
      }
    })
  }
}

function landPlayer (player) {
  player._noclipFlying = false
  player._noclipLandGuardUntil = Date.now() + LAND_GUARD_MS
  player._disablerWasFlying = false
  sendAbilities(player, false)
}

function resolveVerticalFlySpeed (player, flying) {
  if (!flying) return 0.05
  const n = player._noclipVerticalSpeed ?? DEFAULT_VERTICAL_SPEED
  return Math.max(0.05, Math.min(1.0, n * 0.17))
}

function sendAbilities (player, flying) {
  const rid = player._runtimeId
  if (!rid) return
  const flySpeed = flying ? (player._noclipSpeed * 0.05) : 0.05
  const verticalFlySpeed = resolveVerticalFlySpeed(player, flying)
  try {
    player.queue('update_abilities', {
      entity_unique_id: BigInt(rid),
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [{
        type: 'base',
        allowed: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: true,
          teleport: true, invulnerable: true, flying: true, may_fly: true,
          instant_build: true, lightning: true, fly_speed: true, walk_speed: true,
          muted: true, world_builder: true, no_clip: true, privileged_builder: true,
          vertical_fly_speed: true
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: flying, may_fly: true,
          instant_build: false, lightning: false, fly_speed: true, walk_speed: true,
          vertical_fly_speed: flying,
          muted: false, world_builder: false, no_clip: flying, privileged_builder: false
        },
        fly_speed: flySpeed,
        vertical_fly_speed: verticalFlySpeed,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}