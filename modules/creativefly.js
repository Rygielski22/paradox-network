'use strict'

/**
 * CreativeFly — saber-style smooth fly via update_abilities.
 * Client handles movement; disabler re-sends abilities + tick=0 while flying.
 *
 * .creativefly on/off/speed <n>/verticalspeed <n>
 */

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

const CMD = 'creativefly'
const DEFAULT_SPEED = 6
const DEFAULT_VERTICAL_SPEED = 6
const DOUBLE_TAP_MS = 300
const LAND_GUARD_MS = 1200

module.exports = {
  name: 'CreativeFly',
  description: 'Smooth fast fly — double-tap jump to toggle',

  onPlayer (player, relay) {
    if (player._cflyEnabled === undefined) player._cflyEnabled = false
    if (player._cflySpeed === undefined) player._cflySpeed = DEFAULT_SPEED
    if (player._cflyVerticalSpeed === undefined) player._cflyVerticalSpeed = DEFAULT_VERTICAL_SPEED
    player._cflyFlying = false
    player._cflyLastJump = 0
    player._cflyWasJumping = false
    player._cflyLastPos = null

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._runtimeId = data.params.runtime_entity_id
      }

      const inLandGuard = player._cflyLandGuardUntil && Date.now() < player._cflyLandGuardUntil
      if (player._cflyFlying || inLandGuard) {
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

      if (data.name === 'entity_event' && data.params && player._cflyFlying) {
        if (data.params.event_id === 'death_smoke_cloud' &&
            String(data.params.runtime_entity_id) === String(player._runtimeId)) {
          landPlayer(player)
        }
      }
      if (data.name === 'set_health' && data.params?.health <= 0 && player._cflyFlying) {
        landPlayer(player)
      }
      if (data.name === 'respawn' && player._cflyEnabled) {
        // Keep enabled — just stop the fly phase so they can re-trigger
        landPlayer(player)
      }
      if (data.name === 'change_dimension' && player._cflyFlying) landPlayer(player)
    })

    player.on('serverbound', (data) => {
      if (data.name === 'player_auth_input' && data.params?.position) {
        player._cflyLastPos = data.params.position
      }
      if (data.name === 'player_auth_input' && data.params && player._cflyFlying) {
        data.params.on_ground = false
      }
      if (!player._cflyEnabled) return
      if (data.name !== 'player_auth_input' || !data.params || !player._runtimeId) return
      const flags = data.params.input_data
      if (!flags || typeof flags !== 'object') return

      const jumping = flags.jumping || flags.want_up || flags.jump_current_raw
      if (jumping && !player._cflyWasJumping) {
        const now = Date.now()
        if (now - player._cflyLastJump < DOUBLE_TAP_MS) {
          if (player._cflyFlying) {
            landPlayer(player)
            sendMessage(player, theme.toggle('CreativeFly', false, '§cLanded'))
          } else {
            if (!player._disablerEnabled) {
              sendMessage(player, theme.error('enable ?lifeboatmode on before flying'))
              player._cflyLastJump = 0
              player._cflyWasJumping = jumping
              return
            }
            clearSpeedFly(player)
            player._cflyFlying = true
            player._cflyLandGuardUntil = 0
            player._disablerAbilitiesTick = 0
            sendAbilities(player, true)
            sendMessage(player, theme.toggle('CreativeFly', true, '§aFlying'))
          }
          player._cflyLastJump = 0
        } else {
          player._cflyLastJump = Date.now()
        }
      }
      player._cflyWasJumping = jumping
    })
  },

  onEnable (relay) {
    const help = `?${CMD} on/off/speed/verticalspeed <1-10>`
    const handler = (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') {
        if (!player._disablerEnabled) {
          sendMessage(player, theme.error('enable ?lifeboatmode on before ?creativefly on'))
          return
        }
        clearSpeedFly(player)
        player._cflyEnabled = true
        player._cflyFlying = true
        player._cflyLandGuardUntil = 0
        player._disablerAbilitiesTick = 0
        sendAbilities(player, true)
        sendMessage(player, theme.toggle('CreativeFly', true, '§aFlying'))
      } else if (arg === 'off') {
        player._cflyEnabled = false
        landPlayer(player)
        sendMessage(player, theme.toggle('CreativeFly', false))
      } else if (arg === 'speed') {
        const val = parseFloat(args[1])
        if (isNaN(val) || val <= 0 || val > 10) {
          sendMessage(player, theme.error(`?${CMD} speed <1-10>`))
          return
        }
        player._cflySpeed = val
        if (player._cflyFlying) sendAbilities(player, true)
        sendMessage(player, theme.line('CreativeFly', `speed §f${val}§7 → fly_speed §f${(val * 0.05).toFixed(3)}`))
      } else if (arg === 'verticalspeed' || arg === 'vertical' || arg === 'vspeed' || arg === 'v') {
        const val = parseFloat(args[1])
        if (isNaN(val) || val <= 0 || val > 10) {
          sendMessage(player, theme.error(`?${CMD} verticalspeed <1-10>`))
          return
        }
        player._cflyVerticalSpeed = val
        if (player._cflyFlying) sendAbilities(player, true)
        sendMessage(player, theme.line('CreativeFly', `verticalspeed §f${val}`))
      } else {
        sendMessage(player, theme.line('CreativeFly', help))
      }
    }
    registerCommand(CMD, `Smooth fast fly (${help})`, handler)
    registerCommand('cfly', `Smooth fast fly (${help})`, handler)
  }
}

function clearSpeedFly (player) {
  try {
    const { landSpeedFly } = require('./speedfly')
    if (player._speedFlyFlying && landSpeedFly) landSpeedFly(player)
  } catch (_) {
    player._speedFlyFlying = false
    player._speedFlyEnabled = false
    player._speedFlyLandGuardUntil = 0
    player._speedFlyVirtualTicks = null
  }
}

function landPlayer (player) {
  player._cflyFlying = false
  player._cflyLandGuardUntil = Date.now() + LAND_GUARD_MS
  player._speedFlyFlying = false
  player._speedFlyEnabled = false
  player._speedFlyLandGuardUntil = 0
  player._speedFlyVirtualTicks = null
  player._disablerWasFlying = false
  sendAbilities(player, false)
}

function resolveVerticalFlySpeed (player, flying) {
  if (!flying) return 0.05
  const n = player._cflyVerticalSpeed ?? DEFAULT_VERTICAL_SPEED
  return Math.max(0.05, Math.min(1.0, n * 0.17))
}

function sendAbilities (player, flying) {
  const rid = player._runtimeId
  if (!rid) return
  const flySpeed = flying ? (player._cflySpeed * 0.05) : 0.05
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
          muted: true, world_builder: true, no_clip: false, privileged_builder: true,
          vertical_fly_speed: true
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: flying, may_fly: true,
          instant_build: false, lightning: false, fly_speed: true, walk_speed: true,
          vertical_fly_speed: flying,
          muted: false, world_builder: false, no_clip: false, privileged_builder: false
        },
        fly_speed: flySpeed,
        vertical_fly_speed: verticalFlySpeed,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}