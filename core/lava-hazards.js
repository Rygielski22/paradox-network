'use strict'

/** Blocks between player/ore and lava — fire damage reaches ~2 blocks on Lifeboat. */
const LAVA_CLEARANCE = 2

function lavaBox (lavaMap, x, y, z, radius = LAVA_CLEARANCE) {
  if (!lavaMap?.size) return false
  const bx = Math.floor(x)
  const by = Math.floor(y)
  const bz = Math.floor(z)
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (lavaMap.has(`${bx + dx},${by + dy},${bz + dz}`)) return true
      }
    }
  }
  return false
}

function lavaInPath (lavaMap, start, end, clearance = LAVA_CLEARANCE) {
  if (!lavaMap?.size || !start || !end) return false
  const dx = end.x - start.x
  const dy = end.y - start.y
  const dz = end.z - start.z
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))) * 3)
  for (let i = 0; i <= steps; i++) {
    const r = i / steps
    const px = start.x + dx * r
    const py = start.y + dy * r
    const pz = start.z + dz * r
    if (lavaBox(lavaMap, px, py, pz, clearance)) return true
  }
  return false
}

function tpmineLandingSafe (lavaMap, dest) {
  if (!dest) return false
  if (!lavaMap?.size) return true
  const tx = Math.floor(dest.x)
  const ty = Math.floor(dest.y)
  const tz = Math.floor(dest.z)
  if (lavaBox(lavaMap, tx, ty, tz, 0)) return false
  if (lavaBox(lavaMap, tx, ty + 1, tz, 0)) return false
  if (lavaBox(lavaMap, tx, ty - 1, tz, 0)) return false
  return true
}

function isOreTpSafe (lavaMap, start, dest) {
  if (!dest) return false
  if (!tpmineLandingSafe(lavaMap, dest)) return false
  if (start && lavaInPath(lavaMap, start, dest)) return false
  return true
}

module.exports = {
  LAVA_CLEARANCE,
  lavaBox,
  lavaInPath,
  tpmineLandingSafe,
  isOreTpSafe
}