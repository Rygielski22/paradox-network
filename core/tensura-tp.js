'use strict'

/**
 * TensuraQ-style module TP — upstream move_player bursts via sendAuraBurstPos,
 * auth pair on the final step, then client move_player snap.
 * Same engine as MeteorAura / tpaura / visit-frame.
 */

const {
  sendAuraBurstPos,
  planAuraBurstSteps,
  beginAuraBurstTicks,
  endAuraBurstTicks
} = require('./ka-entities')
const { sendLuminaClientSnap, snapAuthKeepTick } = require('./lumina-tp')

const STEP_DIST = 3.0
const MAX_STEPS = 12
const ARRIVE_DISTANCE = 1.5

function lerp3 (start, end, t) {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t
  }
}

function snapAuthToDest (authParams, dest, onGround, keepTick = true) {
  snapAuthKeepTick(authParams, dest, onGround)
  if (!keepTick) authParams.tick = 0
}

function sendClientMovePlayerSnap (player, rid, dest, authParams, onGround, fromPos) {
  sendLuminaClientSnap(player, rid, dest, authParams, onGround, fromPos)
}

function tensuraTp (player, from, dest, rid, options = {}) {
  if (!player?.upstream || !dest || rid == null) return false

  const start = from
    ? { x: from.x, y: from.y, z: from.z }
    : (player._kaPos || player._lastRealPos || player._surfaceTpPos)
  if (!start) return false

  dest = { x: dest.x, y: dest.y, z: dest.z }
  const onGround = options.onGround === true
  const authParams = options.authParams
  const arriveDist = options.arriveDistance ?? ARRIVE_DISTANCE

  const dist = Math.hypot(dest.x - start.x, dest.y - start.y, dest.z - start.z)
  const burstOpts = { rid, onGround }

  beginAuraBurstTicks(player)
  try {
    if (dist < arriveDist) {
      sendAuraBurstPos(player, dest, { ...burstOpts, auth: true })
    } else {
      const { steps } = planAuraBurstSteps(dist, options.stepDist || STEP_DIST, options.maxSteps || MAX_STEPS)
      for (let i = 0; i <= steps; i++) {
        const pos = lerp3(start, dest, steps === 0 ? 1 : i / steps)
        sendAuraBurstPos(player, pos, {
          ...burstOpts,
          auth: i === steps
        })
      }
    }
  } finally {
    endAuraBurstTicks(player)
  }

  sendClientMovePlayerSnap(player, rid, dest, authParams, onGround, start)
  if (authParams?.position) snapAuthToDest(authParams, dest, onGround, true)

  return true
}

module.exports = {
  STEP_DIST,
  MAX_STEPS,
  ARRIVE_DISTANCE,
  tensuraTp,
  sendClientMovePlayerSnap,
  snapAuthToDest
}