'use strict'

/**
 * Shared instant teleport for all TP modules (chesttp, cameratp, playertp,
 * automine...). This is Dani's exact stepFlight from his tpmine: burst the
 * whole path to the destination in ONE real tick via upstream.queue() step
 * sub-packets, then snap the outgoing auth_input to the final position and
 * send a move_player teleport so the client follows.
 *
 * Tuning: each step covers MAX_PACKET_STEP blocks and advances the tick
 * counter by TICKS_PER_STEP. The ratio is what AC validates against — at
 * 9 blocks / 3 ticks that's 3 blocks per server-tick (same proven safe
 * rate as the old 3 blocks / 1 tick form, but covers ground 3x faster
 * per packet). Pairs naturally with .timerbypass at 3x.
 *
 * Returns true once arrived (single call arrives immediately).
 */

const MAX_PACKET_STEP   = 1.0     // blocks per upstream sub-packet
const LONG_DIST_STEP    = 1.0     // bumps slightly for >1000-block jumps
const TICKS_PER_STEP    = 3      // server-tick increment per sub-packet
const ARRIVE_DISTANCE   = 1.5

function instantFlight (player, authParams, dest, rid, options = {}) {
  if (!dest) return true

  let currentX = authParams.position.x
  let currentY = authParams.position.y
  let currentZ = authParams.position.z
  let lastTickValue = typeof authParams.tick === 'bigint' ? Number(authParams.tick) : (Number(authParams.tick) || 0)
  let isFlying = true

  const arriveDist  = options.arriveDistance !== undefined ? options.arriveDistance : ARRIVE_DISTANCE
  const stepSize    = options.stepSize       !== undefined ? options.stepSize       : MAX_PACKET_STEP
  const ticksPerStep = options.ticksPerStep  !== undefined ? options.ticksPerStep   : TICKS_PER_STEP
  // keepTick: leave the FINAL outgoing auth_input tick alone (only sub-packets carry inflated tick).
  const keepTick    = options.keepTick === true
  // tickZero: every sub-packet AND the final packet get tick=0 — for use with disabler to bypass
  // server-side movement validation entirely (server thinks no time elapsed → all moves valid).
  const tickZero    = options.tickZero === true
  const onGround    = options.onGround === true

  while (isFlying) {
    const dx = dest.x - currentX
    const dy = dest.y - currentY
    const dz = dest.z - currentZ
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

    if (dist < arriveDist) {
      currentX = dest.x
      currentY = dest.y
      currentZ = dest.z
      isFlying = false
    } else {
      let stepLimit = stepSize
      if (dist > 1000.0) {
        stepLimit = LONG_DIST_STEP
      }
      const step = Math.min(stepLimit, dist)
      const ratio = step / dist
      currentX += dx * ratio
      currentY += dy * ratio
      currentZ += dz * ratio
    }

    lastTickValue += ticksPerStep

    if (isFlying) {
      const subPacket = {
        ...authParams,
        position: { x: currentX, y: currentY, z: currentZ },
        tick: tickZero ? 0n : BigInt(lastTickValue),
        delta: authParams.delta ? { x: 0, y: 0, z: 0 } : undefined
      }
      player.upstream.queue('player_auth_input', subPacket)
    }
  }

  authParams.position.x = currentX
  authParams.position.y = currentY
  authParams.position.z = currentZ
  if (tickZero) authParams.tick = 0n
  else if (!keepTick) authParams.tick = BigInt(lastTickValue)
  if (authParams.delta) {
    authParams.delta.x = 0
    authParams.delta.y = 0
    authParams.delta.z = 0
  }

  player.queue('move_player', {
    runtime_id: Number(rid),
    position: { x: currentX, y: currentY, z: currentZ },
    pitch: authParams.pitch || 0,
    yaw: authParams.yaw || 0,
    head_yaw: authParams.yaw || 0,
    mode: 'teleport',
    on_ground: onGround,
    ridden_runtime_id: 0,
    teleport: { cause: 'unknown', source_entity_type: 0 },
    tick: 0n
  })

  return true
}

module.exports = { instantFlight }

