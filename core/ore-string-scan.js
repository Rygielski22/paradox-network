'use strict'

/**
 * Stashfinder-style ore string scanner — scans raw chunk bytes for ore block
 * names and extracts coordinates from nearby NBT (world or chunk-local).
 */

const { ORE_NAMES } = require('./chunk-scan')

const ORE_NAME_BUFFERS = [...ORE_NAMES].map(name => ({
  name,
  buf: Buffer.from(name, 'utf8'),
  short: Buffer.from(name.replace('minecraft:', ''), 'utf8')
}))

function asBuffer (data) {
  if (!data) return null
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.from(data)
  return null
}

function normalizeName (name) {
  if (!name || typeof name !== 'string') return null
  if (name.startsWith('minecraft:')) return name
  return `minecraft:${name}`
}

/** Stashfinder coord extract — world xyz from NBT tag bytes near a string hit. */
function extractWorldXYZ (data) {
  let x = null; let y = null; let z = null
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] !== 0x03 || i + 2 >= data.length) continue
    const nameLen = data[i + 1]
    if (nameLen !== 1 || i + 3 > data.length) continue
    const nc = data[i + 2]
    const r = readZigzagVarint(data, i + 3)
    if (r.bytesRead <= 0) continue
    if (nc === 0x78 && x === null) x = r.value
    else if (nc === 0x79 && y === null) y = r.value
    else if (nc === 0x7a && z === null) z = r.value
  }
  if (x == null || y == null || z == null) return null
  if (Math.abs(x) > 30000000 || Math.abs(y) > 512 || Math.abs(z) > 30000000) return null
  return { x, y, z }
}

/** Chunk-local xyz (used when world coords are 0–15). */
function extractLocalXYZ (data) {
  let lx = null; let ly = null; let lz = null; let subY = null
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] !== 0x03 || i + 2 >= data.length) continue
    const nameLen = data[i + 1]
    if (nameLen !== 1 || i + 3 > data.length) continue
    const nc = data[i + 2]
    const r = readZigzagVarint(data, i + 3)
    if (r.bytesRead <= 0) continue
    if (nc === 0x78 && lx === null) lx = r.value
    else if (nc === 0x79 && ly === null) ly = r.value
    else if (nc === 0x7a && lz === null) lz = r.value
    else if (nc === 0x59 && subY === null) subY = r.value
  }
  if (lx == null || ly == null || lz == null) return null
  return { lx, ly, lz, subY: subY != null ? subY : Math.floor(ly / 16) }
}

function readZigzagVarint (buf, offset) {
  let val = 0; let shift = 0; let n = 0
  while (true) {
    if (offset + n >= buf.length) return { value: 0, bytesRead: 0 }
    const b = buf[offset + n]; n++
    val |= (b & 0x7F) << shift; shift += 7
    if ((b & 0x80) === 0) break
    if (n > 5) return { value: 0, bytesRead: 0 }
  }
  return { value: (val >>> 1) ^ -(val & 1), bytesRead: n }
}

function resolveCoords (region, chunkX, chunkZ) {
  const candidates = []
  const world = extractWorldXYZ(region)
  if (world) {
    if (Math.abs(world.x) > 15 || Math.abs(world.z) > 15) {
      candidates.push(world)
    } else if (chunkX != null && chunkZ != null) {
      candidates.push({
        x: chunkX * 16 + world.x,
        y: world.y,
        z: chunkZ * 16 + world.z
      })
      candidates.push(world)
    } else {
      candidates.push(world)
    }
  }
  const local = extractLocalXYZ(region)
  if (local && chunkX != null && chunkZ != null) {
    candidates.push({
      x: chunkX * 16 + local.lx,
      y: (local.subY != null ? local.subY * 16 : 0) + local.ly,
      z: chunkZ * 16 + local.lz
    })
  }
  return candidates
}

/**
 * Scan a raw chunk/subchunk payload for ore blocks (stashfinder method).
 * @returns {Array<{x,y,z,name,rid}>}
 */
function scanChunkPayloadForOres (payload, chunkX, chunkZ, options = {}) {
  const buf = asBuffer(payload)
  if (!buf || buf.length < 8) return []
  const minY = options.minOreY != null ? options.minOreY : -64
  const ores = []
  const seen = new Set()

  for (const { name, buf: needle, short } of ORE_NAME_BUFFERS) {
    for (const n of [needle, short]) {
      let idx = 0
      while (idx < buf.length) {
        const pos = buf.indexOf(n, idx)
        if (pos === -1) break
        const region = buf.slice(Math.max(0, pos - 120), Math.min(buf.length, pos + 320))
        const coordsList = resolveCoords(region, chunkX, chunkZ)
        for (const c of coordsList) {
          if (c.y < minY) continue
          const key = `${c.x},${c.y},${c.z}`
          if (seen.has(key)) continue
          seen.add(key)
          ores.push({
            x: Math.floor(c.x),
            y: Math.floor(c.y),
            z: Math.floor(c.z),
            name: normalizeName(name),
            rid: 0
          })
          break
        }
        idx = pos + n.length
      }
    }
  }
  return ores
}

module.exports = {
  ORE_NAME_BUFFERS,
  asBuffer,
  scanChunkPayloadForOres,
  extractWorldXYZ,
  extractLocalXYZ
}