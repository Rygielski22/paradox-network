'use strict'

const { isValidTarget, kaKey, kaEq, targetBodyDistance } = require('./ka-entities')

function livePos (player) {
  return player._kaLastAuth?.position || player._kaPos || player._killauraPos
}

function normalizeAngle (deg) {
  let a = deg
  while (a > 180) a -= 360
  while (a < -180) a += 360
  return a
}

function lerpAngle (from, to, t) {
  const delta = normalizeAngle(to - from)
  return normalizeAngle(from + delta * t)
}

// Lifeboat auth position + tracked player Y are eye height (not feet).
const AIM_TORSO_DROP = 0.2

function aimWorldPoint (ent) {
  return {
    x: ent.x,
    y: ent.y - AIM_TORSO_DROP,
    z: ent.z
  }
}

function computeAimClick (ent, playerPos) {
  const aim = aimWorldPoint(ent)
  return {
    x: aim.x - playerPos.x,
    y: aim.y - playerPos.y,
    z: aim.z - playerPos.z
  }
}

function computeAimRotation (ent, fromPos) {
  const dx = ent.x - fromPos.x
  const dy = (ent.y - AIM_TORSO_DROP) - fromPos.y
  const dz = ent.z - fromPos.z
  const horiz = Math.hypot(dx, dz)
  return {
    pitch: Math.atan2(-dy, horiz) * (180 / Math.PI),
    yaw: Math.atan2(-dx, dz) * (180 / Math.PI)
  }
}

function aimDelta (rot, desired) {
  const pitch = Math.abs(normalizeAngle(desired.pitch - rot.pitch))
  const yaw = Math.abs(normalizeAngle(desired.yaw - rot.yaw))
  return Math.hypot(pitch, yaw)
}

function syncRotState (player, rot) {
  player._kaRot = { pitch: rot.pitch, yaw: rot.yaw }
  player._killauraRot = { pitch: rot.pitch, yaw: rot.yaw }
}

function isAimbotTarget (player, rid, ent, myRid, maxRange) {
  if (kaEq(rid, myRid)) return false
  const key = kaKey(rid)
  if (key && key.startsWith('plist:')) return false
  if (!ent || ent.removed || ent.isNpc) return false
  if (ent.type && ent.type !== 'player' && !ent.confirmedPlayer) return false
  if (player._friends && ent.name && player._friends.has(ent.name)) return false
  const pos = livePos(player)
  if (!pos) return false
  if (!Number.isFinite(ent.x) || !Number.isFinite(ent.y) || !Number.isFinite(ent.z)) return false
  const dist = Math.hypot(ent.x - pos.x, ent.y - pos.y, ent.z - pos.z)
  if (dist < 0.15 || dist > maxRange) return false
  return { dist, rid: key }
}

function findNearestTarget (player, range, options = {}) {
  const myRid = player._killauraRid || player._kaRid || player._kaRuntimeId
  const pos = livePos(player)
  if (!pos || !player._kaEntities?.size) return null

  const max = range || 100
  let best = null
  let bestDist = max

  for (const [rid, ent] of player._kaEntities) {
    const hit = options.aimbot
      ? isAimbotTarget(player, rid, ent, myRid, max)
      : isValidTarget(player, rid, ent, myRid, max, {
        bodyDist: true,
        requireName: true,
        skipStale: options.skipStale
      })
    if (!hit || hit.dist >= bestDist) continue
    bestDist = hit.dist
    best = { rid: hit.rid, ent, dist: hit.dist, name: ent.name || '' }
  }
  return best
}

function findCrosshairTarget (player, range, maxAngle = 18) {
  const myRid = player._killauraRid || player._kaRid || player._kaRuntimeId
  const pos = livePos(player)
  if (!pos || !player._kaEntities?.size) return null

  const rot = player._kaRot || player._killauraRot ||
    { pitch: player._kaLastAuth?.pitch || 0, yaw: player._kaLastAuth?.yaw || 0 }

  const max = range || 100
  let best = null
  let bestAngle = maxAngle

  for (const [rid, ent] of player._kaEntities) {
    const hit = isValidTarget(player, rid, ent, myRid, max, {
      bodyDist: true,
      requireName: true
    })
    if (!hit) continue
    const desired = computeAimRotation(ent, pos)
    const angle = aimDelta(rot, desired)
    if (angle >= bestAngle) continue
    bestAngle = angle
    best = { rid: hit.rid, ent, dist: hit.dist, name: ent.name || '', angle }
  }
  return best
}

function rotToCameraOrientation (pitch, yaw) {
  const pitchRad = pitch * Math.PI / 180
  const yawRad = yaw * Math.PI / 180
  const cosPitch = Math.cos(pitchRad)
  return {
    x: -Math.sin(yawRad) * cosPitch,
    y: -Math.sin(pitchRad),
    z: Math.cos(yawRad) * cosPitch
  }
}

module.exports = {
  livePos,
  normalizeAngle,
  lerpAngle,
  computeAimRotation,
  computeAimClick,
  aimWorldPoint,
  aimDelta,
  syncRotState,
  rotToCameraOrientation,
  isAimbotTarget,
  findNearestTarget,
  findCrosshairTarget
}