'use strict'

/**
 * Unified ore scan — palette parse (Lifeboat runtime RIDs) + string scan fallback.
 * Stashfinder-style string scan alone does NOT work for ores (no tile entities).
 */

const { asBuffer, scanChunkPayloadForOres } = require('./ore-string-scan')
const {
  enrichChunkParams,
  scanLevelChunk,
  scanSubchunkPacket,
  ensureMutablePalette,
  ensurePaletteMap,
  getPalette,
  ensureOreScanStats,
  ingestItemRegistry,
  ingestBlobCache,
  ingestCreativeContent
} = require('./chunk-scan')

function registryReady (player) {
  const mapSize = player._blockPaletteMap?.size || 0
  return mapSize >= 100 || player._registryIngested === true
}

function buildScanOpts (player, extra = {}) {
  ensureMutablePalette(player)
  return {
    player,
    palette: getPalette(player),
    paletteMap: ensurePaletteMap(player),
    blobCache: player._blobCache,
    minOreY: extra.minOreY != null ? extra.minOreY : -64,
    trackLava: extra.trackLava === true,
    stats: ensureOreScanStats(player)
  }
}

function mergeOres (lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    if (!list) continue
    for (const ore of list) {
      const key = `${ore.x},${ore.y},${ore.z}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ore)
    }
  }
  return out
}

function stringScanLevel (params, opts) {
  const payload = asBuffer(params?.payload)
  if (!payload || payload.length < 8) return []
  return scanChunkPayloadForOres(payload, params.x, params.z, opts)
}

function stringScanSubchunk (params, opts) {
  const origin = params?.origin || { x: 0, y: 0, z: 0 }
  const entries = params?.entries
  if (!Array.isArray(entries)) return []
  const blobCache = opts.player?._blobCache
  const all = []
  for (const e of entries) {
    let payload = asBuffer(e?.payload || e?.data)
    if ((!payload || payload.length === 0) && e?.blob_id != null && blobCache) {
      payload = blobCache.get(String(e.blob_id)) || null
    }
    if (!payload || payload.length < 8) continue
    const chunkX = (origin.x || 0) + (e.dx || 0)
    const chunkZ = (origin.z || 0) + (e.dz || 0)
    all.push(...scanChunkPayloadForOres(payload, chunkX, chunkZ, opts))
  }
  return all
}

/**
 * Synchronous full scan for one level_chunk or subchunk packet.
 */
function scanChunkPacketFull (player, params, kind, des, extra = {}) {
  if (!params || !player) return { ores: [], lava: [], meta: { kind, empty: true } }

  const enriched = enrichChunkParams(params, des)
  const opts = buildScanOpts(player, extra)
  const payload = asBuffer(enriched?.payload)
  const hasPayload = payload && payload.length >= 8

  let paletteOres = []
  let lava = []
  let blobMiss = 0

  if (kind === 'level_chunk') {
    const found = scanLevelChunk(enriched, opts)
    paletteOres = found.ores || []
    lava = found.lava || []
    blobMiss = found.blobMiss || 0
  } else if (kind === 'subchunk') {
    const found = scanSubchunkPacket(enriched, opts)
    paletteOres = found.ores || []
    lava = found.lava || []
    blobMiss = found.blobMiss || 0
  }

  let stringOres = []
  if (!extra.paletteOnly) {
    stringOres = kind === 'level_chunk'
      ? stringScanLevel(enriched, opts)
      : stringScanSubchunk(enriched, opts)
  }

  const ores = mergeOres([paletteOres, stringOres])

  return {
    ores,
    lava,
    meta: {
      kind,
      hasPayload,
      registryReady: registryReady(player),
      paletteHits: paletteOres.length,
      stringHits: stringOres.length,
      blobMiss,
      mapSize: player._blockPaletteMap?.size || 0
    }
  }
}

function ensureRegistryFromPacket (player, data) {
  const n = data?.name
  const p = data?.params
  if (!p) return 0
  if (n === 'item_registry') return ingestItemRegistry(player, p)
  if (n === 'creative_content') return ingestCreativeContent(player, p)
  if (n === 'start_game' && Array.isArray(p.itemstates) && p.itemstates.length > 0) {
    return ingestItemRegistry(player, p)
  }
  return 0
}

function ingestBlobPacket (player, params) {
  return ingestBlobCache(player, params)
}

module.exports = {
  registryReady,
  buildScanOpts,
  scanChunkPacketFull,
  ensureRegistryFromPacket,
  ingestBlobPacket,
  mergeOres
}