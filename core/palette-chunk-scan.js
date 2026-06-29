'use strict'

/**
 * Lifeboat chunk ore scanner (ported from meteor-proxy.zip 1.26.21 automine).
 *
 * - Runtime palettes: zigzag varint → block-palette.json OR live start_game palette
 * - NBT palettes: block name in compound is authoritative
 * - 1.26.31+: ingest start_game.block_properties + update_block_properties
 */

const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const { enrichChunkParams } = require('./chunk-scan')

const ORE_NAMES = new Set([
  'minecraft:coal_ore', 'minecraft:iron_ore', 'minecraft:gold_ore', 'minecraft:diamond_ore',
  'minecraft:emerald_ore', 'minecraft:lapis_ore', 'minecraft:redstone_ore', 'minecraft:lit_redstone_ore',
  'minecraft:copper_ore', 'minecraft:deepslate_coal_ore', 'minecraft:deepslate_iron_ore',
  'minecraft:deepslate_gold_ore', 'minecraft:deepslate_diamond_ore', 'minecraft:deepslate_emerald_ore',
  'minecraft:deepslate_lapis_ore', 'minecraft:deepslate_redstone_ore', 'minecraft:lit_deepslate_redstone_ore',
  'minecraft:deepslate_copper_ore', 'minecraft:nether_gold_ore', 'minecraft:quartz_ore', 'minecraft:ancient_debris'
])

const LAVA_NAMES = new Set(['minecraft:lava', 'minecraft:flowing_lava'])

let RUNTIME_ID_TO_NAME = null
let PALETTE_SOURCE = 'block-palette.json'

function reloadBlockPalette () {
  try {
    RUNTIME_ID_TO_NAME = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'block-palette.json'), 'utf8'))
    if (!Array.isArray(RUNTIME_ID_TO_NAME)) RUNTIME_ID_TO_NAME = null
    else PALETTE_SOURCE = 'block-palette.json'
  } catch (_) {
    RUNTIME_ID_TO_NAME = null
  }
  return RUNTIME_ID_TO_NAME
}

reloadBlockPalette()

function getActivePalette (player, options = {}) {
  if (options.palette) return options.palette
  if (player?._livePalette) return player._livePalette
  return RUNTIME_ID_TO_NAME
}

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
  if (name.includes(':')) return name
  return `minecraft:${name}`
}

function paletteFromBlockProperties (props) {
  if (!Array.isArray(props) || props.length === 0) return null
  const pal = new Array(props.length)
  for (let i = 0; i < props.length; i++) {
    pal[i] = normalizeName(props[i]?.name) || null
  }
  return pal
}

function walkNbtForPalette (node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i]
      if (typeof item === 'string') {
        out[i] = normalizeName(item)
        continue
      }
      if (item && typeof item === 'object') {
        const name = normalizeName(item.name || item.Name || item.block_name || item.id)
        if (name) out[i] = name
      }
    }
    if (out.some(Boolean)) return
    for (const item of node) walkNbtForPalette(item, out)
    return
  }
  for (const [key, val] of Object.entries(node)) {
    if (Array.isArray(val) && val.length > 0) {
      const nested = []
      walkNbtForPalette(val, nested)
      if (nested.some(Boolean) && nested.length >= out.length) {
        for (let i = 0; i < nested.length; i++) {
          if (nested[i]) out[i] = nested[i]
        }
      }
    }
    if (key === 'name' && typeof val === 'string' && out.length === 0) {
      out.push(normalizeName(val))
    }
  }
}

function paletteFromUpdateBlockProperties (params) {
  const raw = params?.nbt
  if (!raw) return null
  try {
    const simplified = nbt.simplify(raw)
    const out = []
    walkNbtForPalette(simplified, out)
    if (out.some(Boolean)) return out
    if (Array.isArray(simplified)) return paletteFromBlockProperties(simplified)
    if (Array.isArray(simplified?.blocks)) return paletteFromBlockProperties(simplified.blocks)
    if (Array.isArray(simplified?.block_properties)) {
      return paletteFromBlockProperties(simplified.block_properties)
    }
  } catch (_) {}
  return null
}

function applyLivePalette (player, pal, source) {
  if (!Array.isArray(pal) || !pal.some(Boolean)) return false
  player._livePalette = pal
  player._paletteSource = source
  player._paletteIron = pal.indexOf('minecraft:iron_ore')
  player._paletteDiamond = pal.indexOf('minecraft:diamond_ore')
  RUNTIME_ID_TO_NAME = pal
  PALETTE_SOURCE = source
  return true
}

function ingestStartGamePalette (player, params) {
  const pal = paletteFromBlockProperties(params?.block_properties)
  if (!pal) return false
  return applyLivePalette(player, pal, 'start_game.block_properties')
}

function ingestUpdateBlockProperties (player, params) {
  const pal = paletteFromUpdateBlockProperties(params)
  if (!pal) return false
  return applyLivePalette(player, pal, 'update_block_properties')
}

function nameFromRuntimeId (rid, palette) {
  if (typeof rid !== 'number') return null
  const pal = palette || RUNTIME_ID_TO_NAME
  if (pal && rid >= 0 && rid < pal.length) {
    return normalizeName(pal[rid])
  }
  return null
}

function ingestBlobCache (player, params) {
  const blobs = params?.blobs
  if (!Array.isArray(blobs)) return 0
  if (!player._blobCache) player._blobCache = new Map()
  let added = 0
  for (const b of blobs) {
    const hash = b?.hash
    const payload = asBuffer(b?.payload)
    if (hash == null || !payload || payload.length === 0) continue
    player._blobCache.set(String(hash), payload)
    added++
  }
  return added
}

function resolveEntryPayload (entry, blobCache) {
  const direct = asBuffer(entry?.payload || entry?.data)
  if (direct && direct.length > 0) return direct
  if (entry?.blob_id != null && blobCache) {
    return blobCache.get(String(entry.blob_id)) || null
  }
  return null
}

function scanLevelChunkPalette (params, options = {}) {
  const palette = getActivePalette(options.player, options)
  const payload = asBuffer(params?.payload)
  const scc = params?.sub_chunk_count
  const blobCache = options.blobCache
  const hasBlobHashes = params?.cache_enabled && params?.blobs?.hashes?.length > 0 && blobCache

  if ((!payload || payload.length === 0) && !hasBlobHashes) {
    return { ores: [], lava: [], subs: 0, blobMiss: 0, payloadBytes: 0 }
  }

  const chunkX = params.x
  const chunkZ = params.z
  const minY = options.minOreY != null ? options.minOreY : -64
  const trackLava = options.trackLava === true
  const ores = []
  const lava = []
  let off = 0
  let subs = 0

  const walkSub = (sub, subY) => {
    if (!sub) return
    subs++
    extractOresFromSub(sub, chunkX, chunkZ, subY, ores, lava, minY, trackLava, palette)
  }

  if (scc === -2) {
    while (off < payload.length) {
      const sub = parseSubChunk(payload, off, palette)
      if (!sub) break
      off = sub.end
      walkSub(sub, sub.subY)
    }
  } else if (scc > 0) {
    for (let sci = 0; sci < scc && off < payload.length; sci++) {
      const sub = parseSubChunk(payload, off, palette)
      if (!sub) break
      off = sub.end
      walkSub(sub, sub.subY !== undefined ? sub.subY : (sci - 4))
    }
  } else if (scc === 0 || scc == null) {
    while (off < payload.length) {
      const sub = parseSubChunk(payload, off, palette)
      if (!sub) break
      off = sub.end
      walkSub(sub, sub.subY)
    }
  }

  let blobMiss = 0
  if (hasBlobHashes) {
    for (const h of params.blobs.hashes) {
      const blobPayload = blobCache.get(String(h))
      if (!blobPayload || blobPayload.length === 0) {
        blobMiss++
        continue
      }
      const sub = parseSubChunk(blobPayload, 0, palette)
      if (sub) walkSub(sub, sub.subY)
    }
  }

  return { ores, lava, subs, blobMiss, payloadBytes: payload?.length || 0 }
}

function scanLevelChunkPacket (params, des, options = {}) {
  const enriched = enrichChunkParams(params, des, 'level_chunk')
  return scanLevelChunkPalette(enriched, options)
}

function scanSubchunkPacket (params, des, options = {}) {
  const enriched = enrichChunkParams(params, des, 'subchunk')
  const palette = getActivePalette(options.player, options)
  const ores = []
  const lava = []
  const origin = enriched?.origin || { x: 0, y: 0, z: 0 }
  const entries = enriched?.entries
  const blobCache = options.blobCache
  if (!Array.isArray(entries)) return { ores, lava, subs: 0, blobMiss: 0, entries: 0 }

  let subs = 0
  let blobMiss = 0
  const minY = options.minOreY != null ? options.minOreY : -64
  const trackLava = options.trackLava === true

  for (const e of entries) {
    if (e.result && e.result !== 'success' && e.result !== 'success_all_air') continue
    if (e.result === 'success_all_air') continue

    const entryPayload = resolveEntryPayload(e, blobCache)
    if (!entryPayload || entryPayload.length === 0) {
      if (e.blob_id != null) blobMiss++
      continue
    }

    const chunkX = (origin.x || 0) + (e.dx || 0)
    const chunkZ = (origin.z || 0) + (e.dz || 0)
    const subY = (origin.y || 0) + (e.dy || 0)

    const sub = parseSubChunk(entryPayload, 0, palette)
    if (!sub) continue
    subs++
    const yIndex = sub.subY !== undefined ? sub.subY : subY
    extractOresFromSub(sub, chunkX, chunkZ, yIndex, ores, lava, minY, trackLava, palette)
  }

  return { ores, lava, subs, blobMiss, entries: entries.length }
}

function extractOresFromSub (sub, chunkX, chunkZ, subY, out, lavaOut, minY, trackLava, palette) {
  if (subY == null || subY < -4) return
  const baseY = subY * 16
  const layer = sub.layers && sub.layers[0]
  if (!layer || layer.indices.length !== 4096 || layer.palette.length === 0) return

  for (let i = 0; i < 4096; i++) {
    const block = layer.palette[layer.indices[i]]
    const name = blockName(block, palette)
    if (!name) continue

    const lx = (i >> 8) & 0xF
    const lz = (i >> 4) & 0xF
    const ly = i & 0xF
    const wx = chunkX * 16 + lx
    const wy = baseY + ly
    const wz = chunkZ * 16 + lz

    if (ORE_NAMES.has(name)) {
      if (wy >= minY) {
        out.push({ x: wx, y: wy, z: wz, name, rid: block?.rid ?? 0 })
      }
    } else if (trackLava && lavaOut && LAVA_NAMES.has(name)) {
      lavaOut.push(`${wx},${wy},${wz}`)
    }
  }
}

function blockName (block, palette) {
  if (!block) return null
  let name = normalizeName(block.name)
  if (name && !name.startsWith('runtime:')) return name
  if (typeof block.rid === 'number') return nameFromRuntimeId(block.rid, palette)
  if (name && name.startsWith('runtime:')) {
    const rid = parseInt(name.slice(8), 10)
    if (!isNaN(rid)) return nameFromRuntimeId(rid, palette)
  }
  return null
}

function parseSubChunk (buf, off, palette) {
  if (off >= buf.length) return null
  const version = buf.readUInt8(off++)
  let layerCount
  let subY
  if (version === 1) layerCount = 1
  else if (version === 8) {
    if (off >= buf.length) return null
    layerCount = buf.readUInt8(off++)
  } else if (version >= 9) {
    if (off + 1 >= buf.length) return null
    layerCount = buf.readUInt8(off++)
    subY = buf.readInt8(off++)
  } else return null

  const layers = []
  for (let i = 0; i < layerCount; i++) {
    const layer = parseStorageLayer(buf, off, palette)
    if (!layer) return null
    off = layer.end
    layers.push(layer)
  }
  return { version, subY, layers, end: off }
}

function parseStorageLayer (buf, off, palette) {
  if (off >= buf.length) return null
  const flags = buf.readUInt8(off++)
  const bpb = flags >> 1
  const isRuntime = (flags & 1) === 1
  let indices

  if (bpb === 0) {
    indices = new Array(4096).fill(0)
  } else {
    const blocksPerWord = Math.floor(32 / bpb)
    const wordCount = Math.ceil(4096 / blocksPerWord)
    if (off + wordCount * 4 > buf.length) return null
    indices = new Array(4096)
    const mask = (1 << bpb) - 1
    let bi = 0
    for (let w = 0; w < wordCount; w++) {
      const word = buf.readUInt32LE(off)
      off += 4
      for (let b = 0; b < blocksPerWord && bi < 4096; b++) {
        indices[bi++] = (word >> (bpb * b)) & mask
      }
    }
  }

  let palSize
  if (isRuntime) {
    const v = readVarInt(buf, off)
    if (!v) return null
    palSize = v.value
    off = v.end
  } else {
    if (off + 4 > buf.length) return null
    palSize = buf.readInt32LE(off)
    off += 4
  }
  if (palSize < 0 || palSize > 4096) return null

  const layerPalette = []
  for (let i = 0; i < palSize; i++) {
    if (isRuntime) {
      const v = readZigzagVarint(buf, off)
      if (!v) return null
      const name = nameFromRuntimeId(v.value, palette)
      layerPalette.push({ name: name || `runtime:${v.value}`, rid: v.value })
      off = v.end
    } else {
      const entry = readNbtCompound(buf, off)
      if (!entry) return null
      layerPalette.push(entry.block)
      off = entry.end
    }
  }
  return { bpb, isRuntime, indices, palette: layerPalette, end: off }
}

function readVarInt (buf, off) {
  let value = 0
  let shift = 0
  let n = 0
  while (true) {
    if (off + n >= buf.length || n > 5) return null
    const byte = buf.readUInt8(off + n)
    n++
    value |= (byte & 0x7F) << shift
    shift += 7
    if ((byte & 0x80) === 0) break
  }
  return { value, end: off + n }
}

function readZigzagVarint (buf, off) {
  const v = readVarInt(buf, off)
  if (!v) return null
  return { value: (v.value >>> 1) ^ -(v.value & 1), end: v.end }
}

function readNbtCompound (buf, off) {
  try {
    const proto = nbt.protos && nbt.protos.little
    if (!proto) return null
    const slice = buf.slice(off)
    const result = proto.parsePacketBuffer('nbt', slice)
    const consumed = result?.metadata?.size
    if (!consumed || consumed > slice.length) return null
    let blockName = 'unknown'
    let blockStates = {}
    try {
      const s = nbt.simplify(result.data)
      if (s && typeof s.name === 'string') blockName = s.name
      if (s?.states) blockStates = s.states
    } catch (_) {
      const r = result.data?.value
      if (r?.name && typeof r.name.value === 'string') blockName = r.name.value
    }
    return {
      block: { name: normalizeName(blockName) || blockName, states: blockStates },
      end: off + consumed
    }
  } catch (_) {
    return null
  }
}

function getPaletteMeta (player) {
  const pal = getActivePalette(player)
  return {
    source: player?._paletteSource || PALETTE_SOURCE,
    states: pal?.length || 0,
    iron: pal?.indexOf('minecraft:iron_ore') ?? -1,
    diamond: pal?.indexOf('minecraft:diamond_ore') ?? -1
  }
}

module.exports = {
  ORE_NAMES,
  LAVA_NAMES,
  RUNTIME_ID_TO_NAME,
  PALETTE_SOURCE,
  reloadBlockPalette,
  getActivePalette,
  getPaletteMeta,
  ingestStartGamePalette,
  ingestUpdateBlockProperties,
  applyLivePalette,
  ingestBlobCache,
  scanLevelChunkPalette,
  scanLevelChunkPacket,
  scanSubchunkPacket,
  nameFromRuntimeId,
  parseSubChunk
}