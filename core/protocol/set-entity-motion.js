'use strict'

/**
 * packet_set_entity_motion — protocol.json lines 9743–9757
 * runtime_entity_id(varint64), velocity(vec3f), tick(varint64)
 */

const { normalizeVarint64 } = require('./varint64')

function buildSetEntityMotion (patch = {}) {
  const rid = patch.runtime_entity_id ?? patch.runtimeEntityId ?? patch.runtime_id
  return {
    runtime_entity_id: normalizeVarint64(rid ?? 0),
    velocity: {
      x: Number(patch.velocity?.x) || 0,
      y: Number(patch.velocity?.y) || 0,
      z: Number(patch.velocity?.z) || 0
    },
    tick: normalizeVarint64(patch.tick ?? 0)
  }
}

module.exports = { buildSetEntityMotion }