'use strict'

const CHEST_TILES = ['Chest']

const TILE_BUFFERS = CHEST_TILES.map(name => ({
  name,
  buf: Buffer.from(name, 'utf8')
}))

function readZigzagVarint (buf, offset) {
  let val = 0
  let shift = 0
  let n = 0
  while (true) {
    if (offset + n >= buf.length) return { value: 0, bytesRead: 0 }
    const b = buf[offset + n]
    n++
    val |= (b & 0x7F) << shift
    shift += 7
    if ((b & 0x80) === 0) break
    if (n > 5) return { value: 0, bytesRead: 0 }
  }
  return { value: (val >>> 1) ^ -(val & 1), bytesRead: n }
}

function extractXYZ (data, anchor = 0) {
  const tags = []
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0x03 && i + 2 < data.length && data[i + 1] === 1 && i + 3 <= data.length) {
      const nc = data[i + 2]
      const r = readZigzagVarint(data, i + 3)
      if (r.bytesRead > 0 && (nc === 0x78 || nc === 0x79 || nc === 0x7a)) {
        tags.push({ i, axis: nc, value: r.value })
      }
    }
  }
  let best = null
  let bestDist = Infinity
  for (const xt of tags) {
    if (xt.axis !== 0x78) continue
    const yc = tags.find(t => t.axis === 0x79 && t.i >= xt.i && t.i - xt.i < 48)
    const zc = tags.find(t => t.axis === 0x7a && t.i >= xt.i && t.i - xt.i < 48)
    if (!yc || !zc) continue
    const mid = (xt.i + zc.i) / 2
    const dist = Math.abs(mid - anchor)
    if (dist < bestDist) {
      bestDist = dist
      best = { x: xt.value, y: yc.value, z: zc.value }
    }
  }
  if (best &&
      Math.abs(best.x) < 30000000 &&
      Math.abs(best.y) < 512 &&
      Math.abs(best.z) < 30000000) {
    return best
  }
  return null
}

function scanPayloadForChests (payload) {
  if (!payload || payload.length < 16) return []
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const results = []
  const seen = new Set()
  for (const t of TILE_BUFFERS) {
    let idx = 0
    while (idx < buf.length) {
      const pos = buf.indexOf(t.buf, idx)
      if (pos === -1) break
      const regionStart = Math.max(0, pos - 80)
      const region = buf.slice(regionStart, Math.min(buf.length, pos + 200))
      const coords = extractXYZ(region, pos - regionStart)
      if (coords) {
        const key = `${coords.x},${coords.y},${coords.z}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push({ x: coords.x, y: coords.y, z: coords.z, name: t.name })
        }
      }
      idx = pos + t.buf.length
    }
  }
  return results
}

function scanChunkForTiles (params) {
  if (!params) return []
  const out = []
  const seen = new Set()
  const add = (list) => {
    for (const t of list) {
      const key = `${t.x},${t.y},${t.z}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push(t)
      }
    }
  }
  const payload = params.payload
  if (payload) add(scanPayloadForChests(payload))
  if (Array.isArray(params.entries)) {
    for (const e of params.entries) {
      const p = e?.payload || e?.data
      if (p) add(scanPayloadForChests(p))
    }
  }
  return out
}

module.exports = {
  scanPayloadForChests,
  scanChunkForTiles,
  extractXYZ
}