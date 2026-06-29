'use strict'

const {
  buildPlayerAuthInput,
  applyAuthPatch,
  buildMovePlayer,
  queueClientMovePlayer
} = require('../protocol')
const { vec3, zeroMotion } = require('./utils')

function buildAuthFromPlayer (player, base, position, tick, _onGround = true) {
  const pos = vec3(position)
  const patch = {
    position: pos,
    tick: player._disablerEnabled ? 0 : tick,
    pitch: base?.pitch ?? 0,
    yaw: base?.yaw ?? 0,
    head_yaw: base?.head_yaw ?? base?.yaw ?? 0,
    input_data: base?.input_data || {},
    delta: { x: 0, y: 0, z: 0 },
    move_vector: { x: 0, z: 0 },
    raw_move_vector: { x: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 }
  }
  return buildPlayerAuthInput(player, patch)
}

function queueUpstreamAuth (player, pktOrPatch) {
  if (!player?.upstream) return false
  const pkt = (pktOrPatch?.input_mode != null)
    ? pktOrPatch
    : buildPlayerAuthInput(player, pktOrPatch || {})
  try {
    player.upstream.queue('player_auth_input', pkt)
    return true
  } catch (e) {
    return false
  }
}

function sendClientMovePlayer (player, rid, dest, rotation, onGround = true) {
  return queueClientMovePlayer(player, {
    runtime_id: Number(rid),
    position: vec3(dest),
    pitch: rotation.pitch ?? 0,
    yaw: rotation.yaw ?? 0,
    head_yaw: rotation.head_yaw ?? rotation.yaw ?? 0,
    mode: 'teleport',
    on_ground: !!onGround,
    ridden_runtime_id: 0,
    teleport: { cause: 'unknown', source_entity_type: 0 },
    tick: 0
  })
}

function applyAuthPin (params, dest, player) {
  const d = vec3(dest)
  applyAuthPatch(params, {
    position: d,
    tick: player._disablerEnabled ? 0 : params.tick
  }, player)
  zeroMotion(params)
}

function markReserialize (des) {
  if (!des) return
  des._meteorReserialize = true
  des._meteorMeteorTpForce = true
  des._meteorForceTp = true
}

module.exports = {
  buildAuthFromPlayer,
  queueUpstreamAuth,
  sendClientMovePlayer,
  applyAuthPin,
  markReserialize
}