'use strict'

/**
 * SpeedFly — velocity fly at PlayerCoords scan speed (set_entity_motion + 3× ticks).
 *
 * ?speedfly on/off
 */

const { registerCommand, sendMessage, onDeath } = require('./chat-commands')
const theme = require('../core/theme')
const { stripFlyForTp, zeroEntityMotion } = require('../core/tp-prep')
const { sendClientMovePlayerSnap } = require('../core/tensura-tp')

const FLY_SPEED = 6
const TICK_MULT = 3

function setMotion (player, vel) {
  const rid = player._speedFlyRid || player._runtimeId
  if (rid == null) return
  try {
    player.queue('set_entity_motion', {
      runtime_entity_id: BigInt(rid),
      velocity: vel,
      tick: 0n
    })
  } catch (_) {}
}

/** Local WASD (x=strafe, z=forward) → world velocity using look yaw. */
function readWorldHorizVel (params) {
  const mv = params.raw_move_vector || params.move_vector || params.analogue_move_vector || {}
  const fwd = mv.z !== undefined ? Number(mv.z) : (Number(mv.y) || 0)
  const strafe = Number(mv.x) || 0
  if (Math.abs(fwd) < 0.05 && Math.abs(strafe) < 0.05) return { x: 0, z: 0 }

  const yawRad = -(params.yaw ?? params.head_yaw ?? 0) * Math.PI / 180
  return {
    x: (Math.sin(yawRad) * fwd + Math.cos(yawRad) * strafe) * FLY_SPEED,
    z: (Math.cos(yawRad) * fwd - Math.sin(yawRad) * strafe) * FLY_SPEED
  }
}

function readVertDir (params) {
  const flags = params.input_data || {}
  let y = 0
  if (flags.jumping || flags.want_up || flags.jump_current_raw || flags.ascend) y += 1
  if (flags.sneaking || flags.want_down || flags.descend) y -= 1
  return y
}

function bumpVirtualTicks (player, authParams) {
  if (player._speedFlyVirtualTicks == null) {
    player._speedFlyVirtualTicks = authParams.ticks_alive || 0
  }
  if (Math.abs(player._speedFlyVirtualTicks - (authParams.ticks_alive || 0)) > 5000 &&
      player._speedFlyVirtualTicks < (authParams.ticks_alive || 0)) {
    player._speedFlyVirtualTicks = authParams.ticks_alive || 0
  }
  player._speedFlyVirtualTicks += TICK_MULT
  authParams.ticks_alive = Math.floor(player._speedFlyVirtualTicks)
}

function clearCflyState (player) {
  player._cflyFlying = false
  player._cflyLandGuardUntil = 0
}

function snapGround (player) {
  const rid = player._speedFlyRid || player._runtimeId
  const pos = player._speedFlyPos || player._kaLastAuth?.position || player._kaPos
  if (rid == null || !pos) return
  const auth = player._kaLastAuth ? { ...player._kaLastAuth } : {}
  auth.position = { x: pos.x, y: pos.y, z: pos.z }
  auth.on_ground = true
  if (auth.delta) auth.delta = { x: 0, y: 0, z: 0 }
  try {
    sendClientMovePlayerSnap(player, rid, pos, auth, true)
  } catch (_) {}
  if (player._kaLastAuth) {
    player._kaLastAuth.on_ground = true
  }
}

function landSpeedFly (player) {
  player._speedFlyFlying = false
  player._speedFlyEnabled = false
  player._speedFlyLandGuardUntil = 0
  player._speedFlyVirtualTicks = null

  zeroEntityMotion(player)
  setMotion(player, { x: 0, y: 0, z: 0 })
  try { stripFlyForTp(player) } catch (_) {}
  snapGround(player)
  player._disablerWasFlying = false
}

function applyFlyMotion (player, params) {
  const h = readWorldHorizVel(params)
  const vy = readVertDir(params)
  const vertScale = 0.55

  if (!h.x && !h.z && !vy) {
    setMotion(player, { x: 0, y: 0, z: 0 })
    return
  }

  setMotion(player, {
    x: h.x,
    y: vy * FLY_SPEED * vertScale,
    z: h.z
  })
}

function startSpeedFly (player) {
  if (player._cflyFlying) clearCflyState(player)
  try { stripFlyForTp(player) } catch (_) {}

  player._speedFlyEnabled = true
  player._speedFlyFlying = true
  player._speedFlyLandGuardUntil = 0
  player._speedFlyVirtualTicks = null
  player._disablerAbilitiesTick = 0
  player._disablerWasFlying = true
}

module.exports = {
  name: 'SpeedFly',
  description: 'Fast velocity fly (?speedfly on/off)',
  landSpeedFly,

  onPlayer (player) {
    if (player._speedFlyEnabled === undefined) player._speedFlyEnabled = false
    player._speedFlyRid = null
    player._speedFlyFlying = false
    player._speedFlyPos = null
    player._speedFlyLandGuardUntil = 0
    player._speedFlyVirtualTicks = null

    onDeath(player, () => {
      if (player._speedFlyFlying) landSpeedFly(player)
    })

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._speedFlyRid = data.params.runtime_entity_id
        player._runtimeId = data.params.runtime_entity_id
      }

      if (!player._speedFlyFlying) return

      if (data.name === 'correct_player_movement') {
        des.canceled = true
        return
      }
      if (data.name === 'move_player' && data.params &&
          String(data.params.runtime_id) === String(player._speedFlyRid || player._runtimeId)) {
        des.canceled = true
      }

      if (data.name === 'entity_event' && data.params &&
          data.params.event_id === 'death_smoke_cloud' &&
          String(data.params.runtime_entity_id) === String(player._speedFlyRid)) {
        landSpeedFly(player)
      }
      if (data.name === 'set_health' && data.params?.health <= 0) landSpeedFly(player)
      if (data.name === 'respawn' || data.name === 'change_dimension') landSpeedFly(player)
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return

      player._speedFlyPos = data.params.position

      if (!player._speedFlyFlying) {
        player._speedFlyVirtualTicks = null
        return
      }

      data.params.on_ground = false
      bumpVirtualTicks(player, data.params)
      applyFlyMotion(player, data.params)
    })
  },

  onEnable () {
    registerCommand('speedfly', 'Velocity fly at scan speed (?speedfly on/off)', (player, args) => {
      const arg = (args[0] || '').toLowerCase()

      if (!player._disablerEnabled) {
        sendMessage(player, theme.error('enable §f?lifeboatmode on §7first'))
        return
      }

      if (arg === 'on') {
        startSpeedFly(player)
        sendMessage(player, theme.toggle('SpeedFly', true))
        return
      }

      if (arg === 'off') {
        landSpeedFly(player)
        sendMessage(player, theme.toggle('SpeedFly', false))
        return
      }

      if (player._speedFlyFlying) {
        landSpeedFly(player)
        sendMessage(player, theme.toggle('SpeedFly', false))
        return
      }

      startSpeedFly(player)
      sendMessage(player, theme.toggle('SpeedFly', true))
    })
  }
}