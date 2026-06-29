'use strict'

/**
 * packet_mob_effect — protocol.json lines 9471–9511
 * runtime_entity_id(varint64), event_id, effect_id, amplifier, particles, duration, tick(varint64)
 */

const { normalizeVarint64 } = require('./varint64')

function buildMobEffect (patch = {}) {
  return {
    runtime_entity_id: normalizeVarint64(
      patch.runtime_entity_id ?? patch.runtimeEntityId ?? patch.runtime_id ?? 0
    ),
    event_id: patch.event_id || 'add',
    effect_id: Number(patch.effect_id) || 0,
    amplifier: Number(patch.amplifier) || 0,
    particles: patch.particles !== false,
    duration: Number(patch.duration) || 0,
    tick: normalizeVarint64(patch.tick ?? 0)
  }
}

module.exports = { buildMobEffect }