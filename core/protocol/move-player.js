'use strict'

/**
 * packet_move_player — protocol.json lines 8928–9013
 * runtime_id(varint), position, pitch, yaw, head_yaw, mode, on_ground,
 * ridden_runtime_id, teleport?(mode=teleport), tick(varint64)
 */

const { normalizeVarint64 } = require('./varint64')

function buildMovePlayer (patch = {}) {
  const mode = patch.mode || 'teleport'
  const pkt = {
    runtime_id: Number(patch.runtime_id ?? patch.runtimeId ?? 0),
    position: {
      x: Number(patch.position?.x) || 0,
      y: Number(patch.position?.y) || 0,
      z: Number(patch.position?.z) || 0
    },
    pitch: Number(patch.pitch) || 0,
    yaw: Number(patch.yaw) || 0,
    head_yaw: Number(patch.head_yaw ?? patch.yaw) || 0,
    mode,
    on_ground: patch.on_ground !== false,
    ridden_runtime_id: Number(patch.ridden_runtime_id ?? 0),
    tick: normalizeVarint64(patch.tick ?? 0)
  }

  if (mode === 'teleport') {
    pkt.teleport = patch.teleport || {
      cause: 'unknown',
      source_entity_type: 0
    }
  }

  return pkt
}

module.exports = { buildMovePlayer }