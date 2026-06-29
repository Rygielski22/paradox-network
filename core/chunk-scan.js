'use strict'

const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const { isVanillaOreName } = require('./block-registry')
const tlog = require('./terminal-log')

const ORE_NAMES = new Set([
  'minecraft:coal_ore', 'minecraft:iron_ore', 'minecraft:gold_ore', 'minecraft:diamond_ore',
  'minecraft:emerald_ore', 'minecraft:lapis_ore', 'minecraft:redstone_ore', 'minecraft:lit_redstone_ore',
  'minecraft:copper_ore', 'minecraft:deepslate_coal_ore', 'minecraft:deepslate_iron_ore',
  'minecraft:deepslate_gold_ore', 'minecraft:deepslate_diamond_ore', 'minecraft:deepslate_emerald_ore',
  'minecraft:deepslate_lapis_ore', 'minecraft:deepslate_redstone_ore', 'minecraft:lit_deepslate_redstone_ore',
  'minecraft:deepslate_copper_ore', 'minecraft:nether_gold_ore', 'minecraft:quartz_ore', 'minecraft:ancient_debris'
])

// Only real lava fluids go in the hazard map — bedrock/gravel exist in every chunk
// and instantly blow past any cap if tracked globally.
const LAVA_FLUID_NAMES = new Set([
  'minecraft:lava', 'minecraft:flowing_lava'
])
const LAVA_NAMES = LAVA_FLUID_NAMES

const ORE_NAME_BUFFERS = [...ORE_NAMES].map(name => ({
  name,
  buf: Buffer.from(name, 'utf8'),
  short: Buffer.from(name.replace('minecraft:', ''), 'utf8')
}))

let FALLBACK_PALETTE = null
let FALLBACK_AIR_RID = 0
const ORE_RID_SET = new Set()
const RID_TO_ORE_NAME = new Map()
const LAVA_RID_SET = new Set()
const MAX_RECENT_CHUNK_SCANS = 160

function loadFallbackPalette () {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'block-palette.json'), 'utf8'))
    if (!Array.isArray(data)) return
    FALLBACK_PALETTE = data
    const air = data.indexOf('minecraft:air')
    if (air >= 0) FALLBACK_AIR_RID = air
  } catch (e) {
    tlog.error('palette-missing', `block-palette.json missing: ${e.message}`)
  }
}

function ensureOreScanStats (player) {
  if (!player) return null
  if (!player._oreScanStats) {
    player._oreScanStats = {
      levelChunks: 0,
      subchunkPackets: 0,
      subParsed: 0,
      blobMiss: 0,
      blobBatches: 0,
      itemRegistryPackets: 0,
      oresFound: 0,
      scanErrors: 0,
      lastScanError: null,
      emptyPayloadChunks: 0
    }
  }
  return player._oreScanStats
}

function bumpOreScanStat (player, key, n = 1) {
  const s = ensureOreScanStats(player)
  if (!s) return
  s[key] = (s[key] || 0) + n
}

function getOreScanDiagnostics (player) {
  const s = player?._oreScanStats || {}
  return {
    registryBlocks: player?._blockPaletteMap?.size || 0,
    oreRids: ORE_RID_SET.size,
    oreRidSample: [...RID_TO_ORE_NAME.entries()].slice(0, 4).map(([r, n]) => `${n.split(':')[1]}=${r}`).join(', '),
    levelChunks: s.levelChunks || 0,
    subchunkPackets: s.subchunkPackets || 0,
    subParsed: s.subParsed || 0,
    blobMiss: s.blobMiss || 0,
    blobBatches: s.blobBatches || 0,
    emptyPayloadChunks: s.emptyPayloadChunks || 0,
    blobCacheSize: player?._blobCache?.size || 0,
    pendingScans: player?._pendingOreScans?.length || 0,
    oresTracked: player?._oreTracker?.map?.size ?? 0,
    scanErrors: s.scanErrors || 0,
    lastScanError: s.lastScanError || null
  }
}

function loadOreRids () {
  // Legacy helper — Lifeboat ore RIDs come from item_registry (often negative).
  // ore-block-ids.json used block-palette indices and is wrong on Lifeboat.
}

/** Lifeboat runtime IDs change per session — item_registry is authoritative. */
function resetSessionOreRids () {
  ORE_RID_SET.clear()
  RID_TO_ORE_NAME.clear()
  LAVA_RID_SET.clear()
}

function registerLavaRid (rid, name) {
  if (typeof rid !== 'number' || !name) return
  const n = normalizeName(name)
  if (!n || !LAVA_FLUID_NAMES.has(n)) return
  LAVA_RID_SET.add(rid)
}

function syncFallbackAirRid () {
  if (!FALLBACK_PALETTE) return
  const air = FALLBACK_PALETTE.indexOf('minecraft:air')
  if (air >= 0) FALLBACK_AIR_RID = air
}

loadFallbackPalette()
syncFallbackAirRid()

function asBuffer (data) {
  if (!data) return null
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.from(data)
  if (typeof data === 'object' && typeof data.length === 'number' && typeof data.readUInt8 === 'function') {
    return Buffer.from(data)
  }
  return null
}

function normalizeName (name) {
  if (!name || typeof name !== 'string') return null
  if (name.startsWith('minecraft:')) return name
  if (name.includes(':')) return name
  return `minecraft:${name}`
}

/** Strict whitelist — Dragonfly block_states ore entries only (no Lifeboat generators). */
function isOreBlockName (name) {
  const n = normalizeName(name)
  if (!n || !n.startsWith('minecraft:')) return false
  if (n.includes('generator')) return false
  if (isVanillaOreName(n)) return true
  return ORE_NAMES.has(n)
}

function registerOreRid (rid, name) {
  if (typeof rid !== 'number' || !name) return
  const n = normalizeName(name)
  if (!n || !isOreBlockName(n)) return
  ORE_RID_SET.add(rid)
  RID_TO_ORE_NAME.set(rid, n)
}

function ensurePaletteMap (player) {
  if (!player._blockPaletteMap) player._blockPaletteMap = new Map()
  return player._blockPaletteMap
}

function setPaletteEntry (player, rid, name) {
  if (!player || rid == null || typeof rid !== 'number' || !name) return
  const n = normalizeName(name)
  if (!n) return
  ensurePaletteMap(player).set(rid, n)
  const pal = ensureMutablePalette(player)
  if (rid >= 0 && rid < 65536) pal[rid] = n
  if (n === 'minecraft:air') player._airRuntimeId = rid
}

function blockRid (block) {
  if (!block) return null
  if (typeof block.rid === 'number') return block.rid
  if (block.name && block.name.startsWith('runtime:')) {
    const p = parseInt(block.name.slice(8), 10)
    if (!isNaN(p)) return p
  }
  return null
}

function coerceRid (rid) {
  if (typeof rid === 'number') return rid
  if (typeof rid === 'bigint') return Number(rid)
  if (typeof rid === 'string' && rid !== '') {
    const p = parseInt(rid, 10)
    if (!isNaN(p)) return p
  }
  return null
}

/** Learn ore block RIDs from creative_content (Lifeboat sends this on join). */
function ingestCreativeContent (player, params) {
  const items = params?.items
  if (!Array.isArray(items)) return 0
  let added = 0
  for (const entry of items) {
    const item = entry?.item || entry
    if (!item) continue
    const rid = coerceRid(item.block_runtime_id)
    if (rid == null || rid === 0) continue
    let name = null
    if (typeof item.name === 'string') name = item.name
    if (!name && FALLBACK_PALETTE && rid < FALLBACK_PALETTE.length) name = FALLBACK_PALETTE[rid]
    if (!name) name = RID_TO_ORE_NAME.get(rid)
    if (name && isOreBlockName(name)) {
      registerOreRid(rid, name)
      setPaletteEntry(player, rid, name)
      added++
    }
  }
  if (added > 0 && !player._oreScanLogged) {
    tlog.ore(`creative_content: +${added} ore RIDs (total ${ORE_RID_SET.size})`)
  }
  return added
}

/** Lifeboat runtime IDs come from start_game.block_properties, not block-palette.json. */
function paletteFromStartGame (params) {
  const props = params?.block_properties
  if (!Array.isArray(props) || props.length === 0) return null
  const pal = new Array(props.length)
  for (let i = 0; i < props.length; i++) {
    const n = normalizeName(props[i]?.name)
    if (n) pal[i] = n
  }
  return pal
}

function applyStartGamePalette (player, params) {
  const pal = paletteFromStartGame(params)
  if (!pal) return false
  player._blockPalette = pal
  player._hasStartGamePalette = true
  player._blockPaletteMap = new Map()
  const air = pal.indexOf('minecraft:air')
  player._airRuntimeId = air >= 0 ? air : FALLBACK_AIR_RID
  for (let i = 0; i < pal.length; i++) {
    if (!pal[i]) continue
    setPaletteEntry(player, i, pal[i])
    if (isOreBlockName(pal[i])) registerOreRid(i, pal[i])
  }
  if (!player._oreScanLogged) {
    player._oreScanLogged = true
    const oreHits = pal.filter(n => n && ORE_NAMES.has(n)).length
    tlog.ore(`${player.profile?.name || 'player'} start_game palette: ${pal.length} states, ${oreHits} ores`)
  }
  return true
}

/** Lifeboat 1.26.x subchunk blob cache — payloads arrive in client_cache_miss_response. */
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
  if (added > 0 && !player._blobCacheLogged) {
    player._blobCacheLogged = true
    tlog.ore(`${player.profile?.name || 'player'} blob cache: +${added} (total ${player._blobCache.size})`)
  }
  if (added > 0) {
    if (player._pendingOreScans?.length) flushPendingOreScans(player)
    rescanRecentChunks(player, { blobOnly: true })
  }
  return added
}

function flushPendingOreScans (player) {
  const pending = player._pendingOreScans
  if (!pending?.length) return
  player._pendingOreScans = []
  const scanOpts = buildScanOpts(player)
  for (const job of pending) {
    try {
      const found = job.kind === 'subchunk'
        ? scanSubchunkPacket(job.snap, { ...scanOpts, ...job.options })
        : scanLevelChunk(job.snap, { ...scanOpts, ...job.options })
      ingestScan(found, job.handlers, player)
    } catch (_) {}
  }
}

function buildScanOpts (player) {
  return {
    player,
    palette: getPalette(player),
    paletteMap: ensurePaletteMap(player),
    blobCache: player._blobCache
  }
}

function queueRecentChunkScan (player, snap, kind, handlers, options) {
  if (!player._recentChunkScans) player._recentChunkScans = []
  player._recentChunkScans.push({ snap, kind, handlers, options })
  if (player._recentChunkScans.length > MAX_RECENT_CHUNK_SCANS) {
    player._recentChunkScans.shift()
  }
}

function levelChunkBlobMisses (params, blobCache) {
  if (!params?.cache_enabled || !params.blobs?.hashes?.length || !blobCache) return 0
  let miss = 0
  for (const h of params.blobs.hashes) {
    const payload = blobCache.get(String(h))
    if (!payload || payload.length === 0) miss++
  }
  return miss
}

function rescanRecentChunks (player, opts = {}) {
  const jobs = player._recentChunkScans
  if (!jobs?.length) return
  const mapSize = player._blockPaletteMap?.size || 0
  if (!opts.blobOnly && ORE_RID_SET.size === 0 && mapSize < 50) return
  const scanOpts = buildScanOpts(player)
  let hits = 0
  for (const job of jobs) {
    try {
      const found = job.kind === 'subchunk'
        ? scanSubchunkPacket(job.snap, { ...scanOpts, ...job.options })
        : scanLevelChunk(job.snap, { ...scanOpts, ...job.options })
      const before = hits
      if (found.ores?.length) hits += found.ores.length
      ingestScan(found, job.handlers, player)
      if (hits > before && !player._registryRescanLogged) {
        player._registryRescanLogged = true
        tlog.ore(`${player.profile?.name || 'player'} registry rescan found ores in cached chunks`)
      }
    } catch (_) {}
  }
}

function resolveEntryPayload (entry, blobCache) {
  const direct = asBuffer(entry?.payload || entry?.data)
  if (direct && direct.length > 0) return direct
  if (entry?.blob_id != null && blobCache) {
    return blobCache.get(String(entry.blob_id)) || null
  }
  return null
}

/** Lifeboat 1.26.x often sends empty block_properties — seed a mutable sparse palette. */
function initPlayerPalette (player, params) {
  player._oreScanLogged = false
  player._oreScanErrLogged = false
  player._blobCacheLogged = false
  player._oreScanStats = null
  player._registryIngested = false
  player._hasStartGamePalette = false
  player._pendingOreScans = []
  player._recentChunkScans = []
  player._blobCache = new Map()
  player._blockPaletteMap = new Map()
  player._firstOreLogged = false
  if (Array.isArray(params?.itemstates) && params.itemstates.length > 0) {
    ingestItemRegistry(player, params)
  }
  if (applyStartGamePalette(player, params)) return
  player._blockPalette = FALLBACK_PALETTE ? FALLBACK_PALETTE.slice() : []
  player._airRuntimeId = FALLBACK_AIR_RID
  if (!player._oreScanLogged) {
    player._oreScanLogged = true
    tlog.ore(`${player.profile?.name || 'player'} fallback palette (${player._blockPalette.length} states, air=${player._airRuntimeId})`)
  }
}

function ensureMutablePalette (player) {
  if (!player._blockPalette) {
    player._blockPalette = FALLBACK_PALETTE ? FALLBACK_PALETTE.slice() : []
    player._airRuntimeId = FALLBACK_AIR_RID
  }
  return player._blockPalette
}

/** Lifeboat 1.26 streams batched block deltas via update_sub_chunk_blocks. */
function handleUpdateSubChunkBlocks (player, params, handlers = {}) {
  const baseX = params?.x
  const baseY = params?.y
  const baseZ = params?.z
  if (baseX == null || baseY == null || baseZ == null) return
  const blocks = [...(params?.blocks || []), ...(params?.extra || [])]
  for (const b of blocks) {
    const pos = b?.position
    const rid = coerceRid(b?.runtime_id)
    if (!pos || rid == null) continue
    handleBlockUpdate(player, {
      position: {
        x: baseX + pos.x,
        y: baseY + pos.y,
        z: baseZ + pos.z
      },
      block_runtime_id: rid
    }, handlers)
  }
}

function handleBlockUpdate (player, params, handlers = {}) {
  const pos = params?.position
  const rid = coerceRid(params?.block_runtime_id)
  if (!pos || rid == null) return

  const pal = ensureMutablePalette(player)
  const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
  const airRid = getAirRuntimeId(player)

  if (rid === airRid) {
    if (handlers.oreMap) handlers.oreMap.delete(key)
    if (handlers.lavaMap) handlers.lavaMap.delete(key)
    return
  }

  const blockName = nameFromRid(rid, pal, ensurePaletteMap(player), player)
  if (!blockName && !isOreRid(rid) && !isLavaRid(rid)) return

  if ((blockName && LAVA_FLUID_NAMES.has(blockName)) || isLavaRid(rid)) {
    if (handlers.lavaMap) handlers.lavaMap.set(key, true)
    if (handlers.oreMap) handlers.oreMap.delete(key)
  } else if (handlers.lavaMap) {
    handlers.lavaMap.delete(key)
  }

  const oreName = blockName && isOreBlockName(blockName)
    ? blockName
    : (isOreRid(rid) ? (RID_TO_ORE_NAME.get(rid) || null) : null)
  if (oreName && handlers.oreMap) {
    handlers.oreMap.set(key, {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      name: oreName,
      rid
    })
  }
}

function getPalette (player) {
  return (player && player._blockPalette) || FALLBACK_PALETTE
}

function getAirRuntimeId (player) {
  if (player && player._airRuntimeId != null) return player._airRuntimeId
  return FALLBACK_AIR_RID
}

function nameFromRid (rid, palette, paletteMap, player) {
  if (rid == null || typeof rid !== 'number') return null
  if (RID_TO_ORE_NAME.has(rid)) return RID_TO_ORE_NAME.get(rid)
  if (paletteMap && paletteMap.has(rid)) return paletteMap.get(rid)
  // Lifeboat runtime IDs are session-specific — never map through block-palette.json.
  if (player?._hasStartGamePalette && palette && rid >= 0 && rid < palette.length && palette[rid]) {
    return palette[rid]
  }
  return null
}

function isOreRid (rid) {
  return typeof rid === 'number' && ORE_RID_SET.has(rid)
}

function isLavaRid (rid) {
  return typeof rid === 'number' && LAVA_RID_SET.has(rid)
}

function resolveBlock (block, palette) {
  if (!block) return null
  let rid = typeof block.rid === 'number' ? block.rid : null
  let name = block.name ? normalizeName(block.name) : null

  if (name && name.startsWith('runtime:')) {
    const parsed = parseInt(name.slice(8), 10)
    if (!isNaN(parsed)) rid = parsed
    name = null
  }

  if (rid != null && isOreRid(rid)) {
    return { name: nameFromRid(rid, palette) || RID_TO_ORE_NAME.get(rid) || `minecraft:ore`, rid }
  }

  if (rid != null && !name) name = nameFromRid(rid, palette)
  if (name && ORE_NAMES.has(name) && rid == null && palette) {
    const idx = palette.indexOf(name)
    if (idx >= 0) rid = idx
  }

  if (!name || !name.startsWith('minecraft:')) return null
  return { name, rid: rid != null ? rid : 0 }
}

function extendPalette (palette, rid, name, paletteMap) {
  const n = normalizeName(name)
  if (!n || typeof rid !== 'number') return
  if (paletteMap) {
    const existing = paletteMap.get(rid)
    if (existing && (isOreRid(rid) || isOreBlockName(existing)) && !isOreBlockName(n)) return
    if (existing && LAVA_FLUID_NAMES.has(existing) && !LAVA_FLUID_NAMES.has(n)) return
    paletteMap.set(rid, n)
  }
  if (palette && rid >= 0 && rid < 65536 && !palette[rid]) palette[rid] = n
}

function normalizeBlockName (block, palette, paletteMap, player) {
  if (!block || !block.name) return null
  const direct = normalizeName(block.name)
  if (direct && direct.startsWith('minecraft:')) return direct
  if (block.name.startsWith('runtime:')) {
    const rid = parseInt(block.name.slice(8), 10)
    if (!isNaN(rid)) return nameFromRid(rid, palette, paletteMap, player) || block.name
  }
  return direct
}

function scanLevelChunk (params, options = {}) {
  const ores = []
  const lava = []
  const palette = options.palette
  const payload = asBuffer(params?.payload)
  const hasBlobHashes = params.cache_enabled && params.blobs?.hashes?.length > 0 && options.blobCache

  const blobMiss = hasBlobHashes ? levelChunkBlobMisses(params, options.blobCache) : 0

  if ((!payload || payload.length === 0) && !hasBlobHashes) {
    if (options.stats) options.stats.emptyPayloadChunks++
    return { ores, lava, blobMiss: 0 }
  }

  const chunkX = params.x
  const chunkZ = params.z
  const scc = params.sub_chunk_count
  let off = 0
  let parsedAny = false

  const pal = palette
  const paletteMap = options.paletteMap

  const player = options.player
  const trySub = (sub, subY) => {
    if (!sub) return
    parsedAny = true
    extractFromSub(sub, chunkX, chunkZ, subY, ores, lava, options)
  }

  if (payload && payload.length > 0 && scc !== -1) {
    if (scc === -2) {
      while (off < payload.length) {
        const sub = parseSubChunk(payload, off, pal, paletteMap, player)
        if (!sub) break
        off = sub.end
        trySub(sub, sub.subY)
      }
    } else if (scc > 0) {
      for (let sci = 0; sci < scc && off < payload.length; sci++) {
        const sub = parseSubChunk(payload, off, pal, paletteMap, player)
        if (!sub) break
        off = sub.end
        trySub(sub, sub.subY !== undefined ? sub.subY : (sci - 4))
      }
    } else {
      while (off < payload.length) {
        const sub = parseSubChunk(payload, off, pal, paletteMap, player)
        if (!sub) break
        off = sub.end
        trySub(sub, sub.subY)
      }
    }
  }

  // String scan finds false positives on Lifeboat — palette-only mode skips this.
  if (!options.paletteOnly && payload && payload.length > 0) {
    scanPayloadForOres(payload, chunkX, chunkZ, ores, options)
  }

  if (hasBlobHashes) {
    scanLevelChunkBlobs(params, options, ores, lava, (sub, subY) => {
      parsedAny = true
      extractFromSub(sub, chunkX, chunkZ, subY, ores, lava, options)
    })
  }

  return { ores, lava, blobMiss }
}

function scanLevelChunkBlobs (params, options, oresOut, lavaOut, trySub) {
  const hashes = params.blobs?.hashes
  const blobCache = options.blobCache
  if (!Array.isArray(hashes) || !blobCache) return
  const chunkX = params.x
  const chunkZ = params.z
  const pal = options.palette
  const paletteMap = options.paletteMap
  const player = options.player
  for (let i = 0; i < hashes.length; i++) {
    const blobPayload = blobCache.get(String(hashes[i]))
    if (!blobPayload || blobPayload.length === 0) continue
    if (!options.paletteOnly) scanPayloadForOres(blobPayload, chunkX, chunkZ, oresOut, options)
    const sub = parseSubChunk(blobPayload, 0, pal, paletteMap, player)
    if (sub) trySub(sub, sub.subY !== undefined ? sub.subY : (i - 4))
  }
}

function scanSubchunkPacket (params, options = {}) {
  const ores = []
  const lava = []
  const origin = params?.origin || { x: 0, y: 0, z: 0 }
  const entries = params?.entries
  const blobCache = options.blobCache
  const stats = options.stats
  if (!Array.isArray(entries)) return { ores, lava, parsed: 0, entries: 0, blobMiss: 0 }

  let parsed = 0
  let blobMiss = 0

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

    if (!options.paletteOnly) {
      scanPayloadForOres(entryPayload, chunkX, chunkZ, ores, options)
    }
    const sub = parseSubChunk(entryPayload, 0, options.palette, options.paletteMap, options.player)
    if (!sub) continue
    parsed++
    const yIndex = sub.subY !== undefined ? sub.subY : subY
    extractFromSub(sub, chunkX, chunkZ, yIndex, ores, lava, options)
  }

  if (stats) {
    stats.subchunks += 1
    stats.subEntries += entries.length
    stats.subParsed += parsed
    stats.blobMiss += blobMiss
  }
  return { ores, lava, parsed, entries: entries.length, blobMiss }
}

/** Saber/stashfinder method — delegates to improved dual coord resolver. */
function scanPayloadForOres (payload, chunkX, chunkZ, oresOut, options) {
  const { scanChunkPayloadForOres } = require('./ore-string-scan')
  const hits = scanChunkPayloadForOres(payload, chunkX, chunkZ, options)
  for (const h of hits) oresOut.push(h)
}

function extractCoordsNearName (data) {
  let lx = null; let ly = null; let lz = null; let subY = null
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0x03 && i + 2 < data.length) {
      const nameLen = data[i + 1]
      if (nameLen === 1 && i + 3 <= data.length) {
        const nc = data[i + 2]
        const r = readZigzagVarintBytes(data, i + 3)
        if (r.bytesRead > 0) {
          if (nc === 0x78 && lx === null) lx = r.value
          else if (nc === 0x79 && ly === null) ly = r.value
          else if (nc === 0x7A && lz === null) lz = r.value
          else if (nc === 0x59 && subY === null) subY = r.value
        }
      }
    }
  }
  if (lx != null && ly != null && lz != null) {
    return { lx, ly, lz, subY: subY != null ? subY : Math.floor(ly / 16) }
  }
  return null
}

function readZigzagVarintBytes (buf, offset) {
  let val = 0; let shift = 0; let n = 0
  while (true) {
    if (offset + n >= buf.length || n > 5) return { value: 0, bytesRead: 0 }
    const b = buf.readUInt8(offset + n); n++
    val |= (b & 0x7F) << shift; shift += 7
    if ((b & 0x80) === 0) break
  }
  return { value: (val >>> 1) ^ -(val & 1), bytesRead: n }
}

function oreNameFromBlock (block, palette, paletteMap, player, options = {}) {
  if (!block) return null
  let rid = blockRid(block)
  let name = block.name || null

  // NBT chunk palettes carry the real block name — never reject these.
  if (name && !name.startsWith('runtime:')) {
    const direct = normalizeName(name)
    if (direct && isOreBlockName(direct)) return direct
  }

  if (name && name.startsWith('runtime:')) {
    const parsed = parseInt(name.slice(8), 10)
    if (!isNaN(parsed)) rid = parsed
    name = null
  }

  if (rid == null || !isOreRid(rid)) {
    if (options.strictOreRids) return null
    if (!name && rid != null) name = nameFromRid(rid, palette, paletteMap, player)
    if (name) name = normalizeName(name)
    if (name && isOreBlockName(name)) return name
    return null
  }

  return RID_TO_ORE_NAME.get(rid) || nameFromRid(rid, palette, paletteMap, player) || null
}

function extractFromSub (sub, chunkX, chunkZ, subY, oresOut, lavaOut, options) {
  if (subY == null || subY < -4) return
  const palette = options.palette
  const paletteMap = options.paletteMap
  const baseY = subY * 16
  const minY = options.minOreY != null ? options.minOreY : -64
  const trackLava = options.trackLava === true
  const layer = sub.layers && sub.layers[0]
  if (!layer || layer.indices.length !== 4096 || layer.palette.length === 0) return

  for (let i = 0; i < 4096; i++) {
    const block = layer.palette[layer.indices[i]]
    if (!block) continue

    const rid = blockRid(block)
    if (rid != null && block.name && block.name.startsWith('minecraft:') && palette) {
      extendPalette(palette, rid, block.name, paletteMap)
    }

    const lx = (i >> 8) & 0xF
    const lz = (i >> 4) & 0xF
    const ly = i & 0xF
    const wx = chunkX * 16 + lx
    const wy = baseY + ly
    const wz = chunkZ * 16 + lz

    const oreName = oreNameFromBlock(block, palette, paletteMap, options.player, options)
    if (oreName) {
      if (wy >= minY) {
        oresOut.push({ x: wx, y: wy, z: wz, name: oreName, rid: rid != null ? rid : 0 })
      }
      continue
    }

    const name = normalizeBlockName(block, palette, paletteMap, options.player)
    if (trackLava && lavaOut && ((name && LAVA_FLUID_NAMES.has(name)) || (rid != null && isLavaRid(rid)))) {
      lavaOut.push(`${wx},${wy},${wz}`)
    }
  }
}

function parseSubChunkHeader (buf, off, version) {
  let layerCount
  let subY
  if (version === 1) {
    layerCount = 1
  } else if (version === 8) {
    if (off >= buf.length) return null
    layerCount = buf.readUInt8(off++)
  } else if (version >= 9) {
    if (off + 1 >= buf.length) return null
    layerCount = buf.readUInt8(off++)
    subY = buf.readInt8(off++)
  } else {
    return null
  }
  return { layerCount, subY, off }
}

function parseSubChunk (buf, off, palette, paletteMap, player) {
  if (off >= buf.length) return null
  const version = buf.readUInt8(off++)
  const header = parseSubChunkHeader(buf, off, version)
  if (!header) return null
  off = header.off
  let { layerCount, subY } = header

  const layers = []
  for (let i = 0; i < layerCount; i++) {
    const layer = parseStorageLayer(buf, off, palette, paletteMap, player)
    if (!layer) return null
    off = layer.end
    layers.push(layer)
  }
  return { version, subY, layers, end: off }
}

function parseStorageLayer (buf, off, palette, paletteMap, player) {
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

  const pal = []
  for (let i = 0; i < palSize; i++) {
    if (isRuntime) {
      const v = readZigzagVarint(buf, off)
      if (!v) return null
      const name = nameFromRid(v.value, palette, paletteMap, player)
      if (name) extendPalette(palette, v.value, name, paletteMap)
      pal.push({ name: name || (`runtime:${v.value}`), rid: v.value })
      off = v.end
    } else {
      const entry = readNbtCompound(buf, off)
      if (!entry) return null
      // Per-chunk NBT palette — block name from NBT is authoritative (Dragonfly disk encoding).
      pal.push(entry.block)
      off = entry.end
    }
  }
  return { bpb, isRuntime, indices, palette: pal, end: off }
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
    return { block: { name: normalizeName(blockName) || blockName, states: blockStates }, end: off + consumed }
  } catch (_) {
    return null
  }
}

function snapshotLevelChunk (params) {
  const payload = asBuffer(params?.payload)
  const hashes = params?.blobs?.hashes
  return {
    x: params.x,
    z: params.z,
    sub_chunk_count: params.sub_chunk_count,
    cache_enabled: !!params?.cache_enabled,
    blobs: Array.isArray(hashes) ? { hashes: hashes.map((h) => (typeof h === 'bigint' ? h.toString() : h)) } : null,
    payload: payload && payload.length ? Buffer.from(payload) : null
  }
}

function snapshotSubchunk (params) {
  const entries = Array.isArray(params?.entries) ? params.entries.map((e) => {
    const payload = asBuffer(e?.payload || e?.data)
    return {
      dx: e.dx,
      dy: e.dy,
      dz: e.dz,
      result: e.result,
      blob_id: e.blob_id,
      payload: payload && payload.length ? Buffer.from(payload) : null
    }
  }) : []
  const origin = params?.origin || { x: 0, y: 0, z: 0 }
  return {
    cache_enabled: !!params?.cache_enabled,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    entries
  }
}

function ingestScan (found, handlers, player) {
  if (!found) return
  if (found.ores?.length && handlers.onOres) {
    handlers.onOres(found.ores)
    if (player && !player._firstOreLogged) {
      player._firstOreLogged = true
      const o = found.ores[0]
      tlog.ore(`${player.profile?.name || 'player'} first ore: ${o.name.replace('minecraft:', '')} @ ${o.x},${o.y},${o.z} rid=${o.rid}`)
      bumpOreScanStat(player, 'oresFound', found.ores.length)
    }
  }
  if (found.lava?.length && handlers.onLava) handlers.onLava(found.lava)
}

function enrichChunkParams (params, des, packetName) {
  if (!params) return params
  let payload = asBuffer(params.payload)
  const entries = params.entries
  const hasEntryPayload = Array.isArray(entries) && entries.some(e => {
    const p = asBuffer(e?.payload || e?.data)
    return p && p.length > 0
  })
  if ((payload && payload.length > 0) || hasEntryPayload) return params
  const raw = des?._meteorRawPacket
  if (!raw) return params
  try {
    require('./ensure-patches')
    const { getProxyVersion } = require('./proxy-version')
    const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
    const version = getProxyVersion()
    const parsed = createDeserializer(version).parsePacketBuffer(raw)
    const p2 = parsed?.data?.params
    if (!p2) return params
    payload = asBuffer(p2.payload)
    if (payload && payload.length > 0) {
      return { ...params, ...p2, payload }
    }
    if (Array.isArray(p2.entries) && p2.entries.some(e => asBuffer(e?.payload || e?.data)?.length > 0)) {
      return { ...params, ...p2 }
    }
    if (p2.blobs && !params.blobs) {
      return { ...params, ...p2 }
    }
  } catch (_) {}
  return params
}

function scheduleOreScan (player, params, kind, handlers, options = {}, des = null) {
  if (!params || !player) return
  params = enrichChunkParams(params, des)
  ensureMutablePalette(player)
  ensureOreScanStats(player)
  const snap = kind === 'subchunk' ? snapshotSubchunk(params) : snapshotLevelChunk(params)
  queueRecentChunkScan(player, snap, kind, handlers, options)
  setImmediate(() => {
    try {
      const stats = ensureOreScanStats(player)
      const scanOpts = { ...options, ...buildScanOpts(player), stats }
      const found = kind === 'subchunk'
        ? scanSubchunkPacket(snap, scanOpts)
        : scanLevelChunk(snap, scanOpts)
      ingestScan(found, handlers, player)
      if (kind === 'subchunk') {
        if (found.parsed) bumpOreScanStat(player, 'subParsed', found.parsed)
      }
      if (found.blobMiss) bumpOreScanStat(player, 'blobMiss', found.blobMiss)
      if (found.ores?.length) bumpOreScanStat(player, 'oresFound', found.ores.length)
      if (found.blobMiss > 0) {
        if (!player._pendingOreScans) player._pendingOreScans = []
        player._pendingOreScans.push({ snap, kind, handlers, options })
        if (player._pendingOreScans.length > 80) player._pendingOreScans.shift()
      }
    } catch (e) {
      bumpOreScanStat(player, 'scanErrors', 1)
      if (player._oreScanStats) player._oreScanStats.lastScanError = e.message
      tlog.error(`scan-${kind}`, `${player.profile?.name || 'player'} ${kind} scan error: ${e.message}`)
    }
  })
}

/** Register ore block names from item_registry itemstates (Lifeboat 1.26). */
function ingestItemRegistry (player, params) {
  const states = params?.itemstates
  if (!Array.isArray(states)) return 0
  if (!player._registryIngested) {
    player._registryIngested = true
    resetSessionOreRids()
  }
  let added = 0
  for (const it of states) {
    const name = normalizeName(it?.name || it?.name_string)
    const rid = coerceRid(it?.runtime_id ?? it?.id)
    if (!name || rid == null) continue
    setPaletteEntry(player, rid, name)
    if (isOreBlockName(name)) {
      registerOreRid(rid, name)
      added++
    }
    if (LAVA_FLUID_NAMES.has(name)) {
      registerLavaRid(rid, name)
    }
  }
  const totalMapped = ensurePaletteMap(player).size
  if (added > 0 || totalMapped > 0) {
    const sample = [...RID_TO_ORE_NAME.entries()].slice(0, 4).map(([r, n]) => `${n.split(':')[1]}=${r}`).join(', ')
    tlog.ore(`${player.profile?.name || 'player'} item_registry: ${totalMapped} blocks, ${added} ore RIDs (${sample})`)
    if (added > 0 || totalMapped >= 50) {
      rescanRecentChunks(player)
      flushPendingOreScans(player)
    }
  }
  return added
}

function resolveRidName (player, rid, palette, paletteMap) {
  if (rid == null) return null
  if (RID_TO_ORE_NAME.has(rid)) return RID_TO_ORE_NAME.get(rid)
  const fromMap = paletteMap?.get(rid)
  if (fromMap) return fromMap
  return nameFromRid(rid, palette, paletteMap, player)
}

function recordRidHit (store, rid, name, source, extra = {}) {
  if (rid == null || typeof rid !== 'number') return
  const key = String(rid)
  let rec = store.get(key)
  if (!rec) {
    rec = {
      rid,
      name: name || null,
      sources: new Set(),
      paletteHits: 0,
      blockHits: 0,
      updateHits: 0,
      chunkSamples: [],
      updateSamples: []
    }
    store.set(key, rec)
  }
  if (name && !rec.name) rec.name = name
  rec.sources.add(source)
  if (source === 'level_chunk_palette') rec.paletteHits++
  if (source === 'level_chunk_block') rec.blockHits++
  if (source === 'update_block') {
    rec.updateHits++
    if (extra.pos && rec.updateSamples.length < 8) {
      const s = `${extra.pos.x},${extra.pos.y},${extra.pos.z}`
      if (!rec.updateSamples.includes(s)) rec.updateSamples.push(s)
    }
  }
  if (extra.chunk && rec.chunkSamples.length < 6) {
    const s = `${extra.chunk.x},${extra.chunk.z}`
    if (!rec.chunkSamples.includes(s)) rec.chunkSamples.push(s)
  }
}

function collectSubPaletteRids (sub, store, player, palette, paletteMap, chunk, source) {
  if (!sub?.layers) return
  for (const layer of sub.layers) {
    for (const block of layer.palette || []) {
      const rid = blockRid(block)
      const name = resolveRidName(player, rid, palette, paletteMap) ||
        (block.name && !String(block.name).startsWith('runtime:') ? normalizeName(block.name) : null)
      recordRidHit(store, rid, name, source, { chunk })
    }
    if (!layer.indices?.length || !layer.palette?.length) continue
    const counts = new Map()
    for (const idx of layer.indices) {
      counts.set(idx, (counts.get(idx) || 0) + 1)
    }
    for (const [idx, count] of counts) {
      const block = layer.palette[idx]
      if (!block) continue
      const rid = blockRid(block)
      const name = resolveRidName(player, rid, palette, paletteMap)
      const key = String(rid)
      const rec = store.get(key)
      if (rec) rec.blockHits += count
      else recordRidHit(store, rid, name, 'level_chunk_block', { chunk })
    }
  }
}

/** Walk level_chunk/subchunk payload and collect runtime IDs + resolved names. */
function inspectLevelChunk (params, options = {}) {
  const store = new Map()
  const palette = options.palette
  const paletteMap = options.paletteMap
  const player = options.player
  const payload = asBuffer(params?.payload)
  const chunk = { x: params.x, z: params.z }
  const hasBlobHashes = params.cache_enabled && params.blobs?.hashes?.length > 0 && options.blobCache
  let subCount = 0

  const walkPayload = (buf, chunkCoords) => {
    if (!buf || buf.length === 0) return
    let off = 0
    const scc = params.sub_chunk_count
    const trySub = (sub) => {
      if (!sub) return
      subCount++
      collectSubPaletteRids(sub, store, player, palette, paletteMap, chunkCoords || chunk, 'level_chunk_palette')
    }
    if (scc === -2) {
      while (off < buf.length) {
        const sub = parseSubChunk(buf, off, palette, paletteMap, player)
        if (!sub) break
        off = sub.end
        trySub(sub)
      }
    } else if (scc > 0) {
      for (let sci = 0; sci < scc && off < buf.length; sci++) {
        const sub = parseSubChunk(buf, off, palette, paletteMap, player)
        if (!sub) break
        off = sub.end
        trySub(sub)
      }
    } else {
      while (off < buf.length) {
        const sub = parseSubChunk(buf, off, palette, paletteMap, player)
        if (!sub) break
        off = sub.end
        trySub(sub)
      }
    }
  }

  if (payload && payload.length > 0) walkPayload(payload, chunk)

  if (hasBlobHashes) {
    for (const h of params.blobs.hashes) {
      const blobPayload = options.blobCache.get(String(h))
      if (!blobPayload?.length) continue
      const sub = parseSubChunk(blobPayload, 0, palette, paletteMap, player)
      if (sub) {
        subCount++
        collectSubPaletteRids(sub, store, player, palette, paletteMap, chunk, 'level_chunk_palette')
      }
    }
  }

  return {
    chunk,
    subCount,
    payloadBytes: payload?.length || 0,
    blobMode: !!hasBlobHashes,
    rids: [...store.values()].map(r => ({
      rid: r.rid,
      name: r.name,
      sources: [...r.sources],
      paletteHits: r.paletteHits,
      blockHits: r.blockHits,
      updateHits: r.updateHits,
      chunkSamples: r.chunkSamples,
      updateSamples: r.updateSamples,
      isOre: isOreRid(r.rid) || (r.name && isOreBlockName(r.name))
    }))
  }
}

function inspectSubchunkPacket (params, options = {}) {
  const store = new Map()
  const origin = params?.origin || { x: 0, y: 0, z: 0 }
  const entries = params?.entries
  if (!Array.isArray(entries)) return { rids: [], entries: 0 }
  const palette = options.palette
  const paletteMap = options.paletteMap
  const player = options.player
  const blobCache = options.blobCache

  for (const e of entries) {
    let payload = asBuffer(e?.payload || e?.data)
    if ((!payload || payload.length === 0) && e?.blob_id != null && blobCache) {
      payload = blobCache.get(String(e.blob_id)) || null
    }
    if (!payload || payload.length === 0) continue
    const chunk = { x: (origin.x || 0) + (e.dx || 0), z: (origin.z || 0) + (e.dz || 0) }
    const sub = parseSubChunk(payload, 0, palette, paletteMap, player)
    if (sub) collectSubPaletteRids(sub, store, player, palette, paletteMap, chunk, 'level_chunk_palette')
  }

  return {
    origin,
    entries: entries.length,
    rids: [...store.values()].map(r => ({
      rid: r.rid,
      name: r.name,
      sources: [...r.sources],
      paletteHits: r.paletteHits,
      blockHits: r.blockHits,
      isOre: isOreRid(r.rid) || (r.name && isOreBlockName(r.name))
    }))
  }
}

function inspectUpdateBlock (player, params) {
  const rid = coerceRid(params?.block_runtime_id)
  const pos = params?.position
  const palette = getPalette(player)
  const paletteMap = ensurePaletteMap(player)
  const name = resolveRidName(player, rid, palette, paletteMap)
  return {
    rid,
    name,
    pos: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
    isOre: isOreRid(rid) || (name && isOreBlockName(name))
  }
}

module.exports = {
  ORE_NAMES,
  LAVA_NAMES,
  LAVA_FLUID_NAMES,
  ORE_RID_SET,
  LAVA_RID_SET,
  loadFallbackPalette,
  loadOreRids,
  applyStartGamePalette,
  initPlayerPalette,
  ingestCreativeContent,
  ingestItemRegistry,
  ingestBlobCache,
  ensureMutablePalette,
  handleBlockUpdate,
  handleUpdateSubChunkBlocks,
  getPalette,
  nameFromRid,
  isOreRid,
  isLavaRid,
  getAirRuntimeId,
  scanLevelChunk,
  scanSubchunkPacket,
  enrichChunkParams,
  scheduleOreScan,
  bumpOreScanStat,
  getOreScanDiagnostics,
  ensureOreScanStats,
  ensurePaletteMap,
  inspectLevelChunk,
  inspectSubchunkPacket,
  inspectUpdateBlock,
  resolveRidName
}