'use strict'

const { toEntityRid } = require('./ka-entities')
const { aimWorldPoint } = require('./combat-target')

const BURST_COUNT = 8
const SPREAD = 0.28

function critBodyPos (ent, clickPos, playerPos) {
  if (ent && typeof ent.x === 'number') {
    const aim = aimWorldPoint(ent)
    return {
      x: aim.x + (Math.random() - 0.5) * 0.1,
      y: aim.y + (Math.random() - 0.5) * 0.08,
      z: aim.z + (Math.random() - 0.5) * 0.1
    }
  }
  if (clickPos && playerPos &&
      typeof clickPos.x === 'number' && typeof playerPos.x === 'number') {
    return {
      x: playerPos.x + clickPos.x,
      y: playerPos.y + clickPos.y,
      z: playerPos.z + clickPos.z
    }
  }
  return null
}

function queueCritParticle (player, pos) {
  if (!player || !pos) return
  try {
    player.queue('level_event', {
      event: 'add_particle_critical',
      position: { x: pos.x, y: pos.y, z: pos.z },
      data: 0
    })
  } catch (_) {}
}

function queueCritAnimate (player, ent, targetRid) {
  if (!player) return
  const rid = toEntityRid(ent?.runtimeId ?? targetRid)
  if (rid == null) return
  try {
    player.queue('animate', {
      action_id: 'critical_hit',
      runtime_entity_id: rid,
      data: 0,
      has_swing_source: false
    })
  } catch (_) {}
}

function spawnCritParticles (player, ent, targetRid, clickPos, playerPos) {
  const base = critBodyPos(ent, clickPos, playerPos)
  if (!base) return

  queueCritAnimate(player, ent, targetRid)

  for (let i = 0; i < BURST_COUNT; i++) {
    queueCritParticle(player, {
      x: base.x + (Math.random() - 0.5) * SPREAD,
      y: base.y + (Math.random() - 0.5) * SPREAD * 0.45,
      z: base.z + (Math.random() - 0.5) * SPREAD
    })
  }
}

module.exports = {
  spawnCritParticles
}