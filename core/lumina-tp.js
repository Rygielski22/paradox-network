'use strict'

/**
 * Lumina Client portable TP (QuickAttack / TPAura / InfiniteAura patterns).
 * - Client move_player uses current auth tick (not tick=0)
 * - set_entity_motion nudge before teleport snap
 * - Silent lagback: absorb large corrections into server-side anchor
 */

const {
  normalizeVarint64,
  buildMovePlayer,
  buildSetEntityMotion,
  queueClientMovePlayer,
  queueClientMotion
} = require('./protocol')

const SILENT_LAGBACK_DIST = 50
const SILENT_LAGBACK_COOLDOWN_MS = 100

function asNum (v) {
  if (v == null) return 0
  return typeof v === 'bigint' ? Number(v) : (Number(v) || 0)
}

function currentAuthTick (player, authParams) {
  const tick = authParams?.tick ?? player._kaLastAuth?.tick
  return normalizeVarint64(tick)
}

function sendEntityMotionNudge (player, rid, from, to, scale = 0.5) {
  if (rid == null || !from || !to) return
  queueClientMotion(player, {
    runtime_entity_id: rid,
    velocity: {
      x: (to.x - from.x) * scale,
      y: (to.y - from.y) * scale,
      z: (to.z - from.z) * scale
    },
    tick: 0
  })
}

function sendLuminaClientSnap (player, rid, dest, authParams, onGround, fromPos) {
  if (!dest || rid == null) return

  const rot = authParams || player._kaLastAuth || player._kaRot || { pitch: 0, yaw: 0 }
  const tick = currentAuthTick(player, authParams)
  const ground = onGround !== false

  if (fromPos) {
    sendEntityMotionNudge(player, rid, fromPos, dest)
  }

  const movePkt = buildMovePlayer({
    runtime_id: Number(rid),
    position: { x: dest.x, y: dest.y, z: dest.z },
    pitch: rot.pitch || 0,
    yaw: rot.yaw || 0,
    head_yaw: rot.head_yaw ?? rot.yaw ?? 0,
    mode: 'teleport',
    on_ground: ground,
    tick
  })

  try {
    if (typeof player.write === 'function') player.write('move_player', movePkt)
    else queueClientMovePlayer(player, movePkt)
  } catch (e) {
    try { queueClientMovePlayer(player, movePkt) } catch (_) {}
  }
}

function sendLuminaNormalSnap (player, rid, dest, authParams, onGround) {
  if (!dest || rid == null) return

  const rot = authParams || player._kaLastAuth || { pitch: 0, yaw: 0 }
  const tick = currentAuthTick(player, authParams)

  queueClientMovePlayer(player, {
    runtime_id: Number(rid),
    position: { x: dest.x, y: dest.y, z: dest.z },
    pitch: rot.pitch || 0,
    yaw: rot.yaw || 0,
    head_yaw: rot.head_yaw ?? rot.yaw ?? 0,
    mode: 'normal',
    on_ground: onGround !== false,
    tick
  })
}

/** Rotation-only client snap — normal mode + auth tick (no teleport lock). */
function sendLuminaLookSnap (player, rid, pos, rot, authParams, onGround = true) {
  if (!pos || rid == null || !rot) return
  queueClientMovePlayer(player, {
    runtime_id: Number(rid),
    position: { x: pos.x, y: pos.y, z: pos.z },
    pitch: rot.pitch || 0,
    yaw: rot.yaw || 0,
    head_yaw: rot.head_yaw ?? rot.yaw ?? 0,
    mode: 'normal',
    on_ground: onGround !== false,
    tick: currentAuthTick(player, authParams)
  })
}

function snapAuthKeepTick (authParams, dest, onGround) {
  if (!authParams?.position || !dest) return
  authParams.position.x = dest.x
  authParams.position.y = dest.y
  authParams.position.z = dest.z
  if (authParams.delta) {
    authParams.delta.x = 0
    authParams.delta.y = 0
    authParams.delta.z = 0
  }
  authParams.move_vector = { x: 0, z: 0 }
  authParams.raw_move_vector = { x: 0, z: 0 }
  authParams.analogue_move_vector = { x: 0, z: 0 }
}

function trySilentLagbackAbsorb (player, correctionPos) {
  if (!correctionPos || !player._luminaAnchor) return false
  const anchor = player._luminaAnchor
  const now = Date.now()
  if (now < anchor.cooldownUntil) return true

  const dist = Math.hypot(
    correctionPos.x - anchor.x,
    correctionPos.y - anchor.y,
    correctionPos.z - anchor.z
  )
  if (dist < SILENT_LAGBACK_DIST) return false

  player._luminaAnchor = {
    x: correctionPos.x,
    y: correctionPos.y,
    z: correctionPos.z,
    cooldownUntil: now + SILENT_LAGBACK_COOLDOWN_MS
  }
  if (player._kaLastAuth?.position) {
    player._kaLastAuth.position.x = correctionPos.x
    player._kaLastAuth.position.y = correctionPos.y
    player._kaLastAuth.position.z = correctionPos.z
  }
  return true
}

module.exports = {
  sendLuminaClientSnap,
  sendLuminaNormalSnap,
  sendLuminaLookSnap,
  sendEntityMotionNudge,
  snapAuthKeepTick,
  trySilentLagbackAbsorb,
  currentAuthTick
}