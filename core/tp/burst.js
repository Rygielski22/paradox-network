'use strict'

const { BURST_STEP, BURST_MAX_STEPS, ARRIVE_EPS } = require('./config')
const { vec3, burstTick } = require('./utils')
const { buildAuthFromPlayer, queueUpstreamAuth } = require('./packets')
const { setPhase, PHASE } = require('./state')

/**
 * Server-side path: stepped PlayerAuthInput from origin → destination.
 * Reason: Bedrock server validates movement incrementally; one giant jump is rejected.
 */
function runBurst (player, origin, destination, authBase) {
  if (!player.upstream) return { ok: false, steps: 0 }

  const from = vec3(origin)
  const to = vec3(destination)
  const base = authBase || {}
  const baseTick = base.tick ?? 0
  let cur = { ...from }
  let steps = 0

  setPhase(player, PHASE.BURSTING)

  while (
    steps < BURST_MAX_STEPS &&
    (Math.abs(cur.x - to.x) > ARRIVE_EPS ||
     Math.abs(cur.y - to.y) > ARRIVE_EPS ||
     Math.abs(cur.z - to.z) > ARRIVE_EPS)
  ) {
    steps++
    const dx = to.x - cur.x
    const dy = to.y - cur.y
    const dz = to.z - cur.z
    const dist = Math.hypot(dx, dy, dz)
    const step = Math.min(BURST_STEP, dist)
    const r = step / dist
    cur = { x: cur.x + dx * r, y: cur.y + dy * r, z: cur.z + dz * r }

    const pkt = buildAuthFromPlayer(
      player,
      base,
      cur,
      burstTick(player, baseTick, steps),
      true
    )
    queueUpstreamAuth(player, pkt)
  }

  queueUpstreamAuth(player, buildAuthFromPlayer(
    player,
    base,
    to,
    burstTick(player, baseTick, steps + 1),
    true
  ))

  return { ok: true, steps: steps + 1 }
}

module.exports = { runBurst }