'use strict'

/**
 * Central ore/chunk scanner — one hook per player so TpMine/AutoMine/OreESP
 * don't miss packets. Clean [Ore] terminal logging.
 */

const tlog = require('../core/terminal-log')
const {
  scanChunkPacketFull,
  ensureRegistryFromPacket,
  ingestBlobPacket
} = require('../core/ore-scan-pipeline')
const {
  scheduleOreScan,
  initPlayerPalette,
  ingestCreativeContent,
  ingestItemRegistry,
  ingestBlobCache,
  handleBlockUpdate,
  handleUpdateSubChunkBlocks,
  getOreScanDiagnostics,
  bumpOreScanStat
} = require('../core/chunk-scan')

function playerName (player) {
  return player?.profile?.name || 'player'
}

function ensureTracker (player) {
  if (!player._oreTracker) {
    player._oreTracker = {
      map: new Map(),
      lava: new Map(),
      consumers: []
    }
  }
  return player._oreTracker
}

function trackLavaFor (player) {
  return !!(player._tpmineEnabled || player._automineEnabled)
}

function scanOptsFor (player) {
  const registryReady = player._registryIngested && (player._blockPaletteMap?.size || 0) >= 50
  return {
    minOreY: -64,
    trackLava: trackLavaFor(player),
    paletteOnly: true,
    strictOreRids: registryReady
  }
}

function makeHandlers (player) {
  const tr = ensureTracker(player)
  const trackLava = trackLavaFor(player)
  return {
    onOres: (ores) => {
      for (const ore of ores) {
        const key = `${ore.x},${ore.y},${ore.z}`
        if (!tr.map.has(key)) {
          tr.map.set(key, ore)
          if (tr.map.size > 5000) tr.map.delete(tr.map.keys().next().value)
        }
      }
      for (const fn of tr.consumers) {
        try { fn.onOres?.(ores) } catch (_) {}
      }
    },
    onLava: (lavaKeys) => {
      if (!trackLava) return
      for (const lk of lavaKeys) {
        tr.lava.set(lk, true)
        if (tr.lava.size > 1500) tr.lava.delete(tr.lava.keys().next().value)
      }
      for (const fn of tr.consumers) {
        try { fn.onLava?.(lavaKeys) } catch (_) {}
      }
    }
  }
}

function registerOreConsumer (player, consumer) {
  const tr = ensureTracker(player)
  if (!tr.consumers.includes(consumer)) tr.consumers.push(consumer)
}

/** Sync palette + string scan before async scheduleOreScan. */
function fastChunkScan (player, params, kind, des) {
  const result = scanChunkPacketFull(player, params, kind, des, scanOptsFor(player))
  if (result.ores?.length) makeHandlers(player).onOres(result.ores)
  if (result.lava?.length) makeHandlers(player).onLava(result.lava)
}

function wireChunkPackets (player) {
  player.on('clientbound', (data, des) => {
    const n = data.name
    const p = data.params
    if (!p) return

    if (n === 'start_game') {
      initPlayerPalette(player, p)
      ensureTracker(player).map.clear()
      ensureTracker(player).lava.clear()
      tlog.ore(`${playerName(player)} join — palette init`)
      return
    }
    if (n === 'creative_content') {
      ingestCreativeContent(player, p)
      return
    }
    if (n === 'item_registry' || n === 'creative_content') {
      if (n === 'item_registry') {
        const nStates = Array.isArray(p.itemstates) ? p.itemstates.length : 0
        bumpOreScanStat(player, 'itemRegistryPackets', 1)
        if (nStates === 0) {
          tlog.warn(`registry-empty-${playerName(player)}`, `${playerName(player)} item_registry has 0 itemstates`)
        }
      }
      ensureRegistryFromPacket(player, data)
      return
    }
    if (n === 'client_cache_miss_response') {
      const added = ingestBlobPacket(player, p)
      if (added > 0) bumpOreScanStat(player, 'blobBatches', 1)
      return
    }
    if (n === 'change_dimension' || n === 'transfer') {
      ensureTracker(player).map.clear()
      ensureTracker(player).lava.clear()
      return
    }
    if (n === 'update_block') {
      handleBlockUpdate(player, p, {
        oreMap: ensureTracker(player).map,
        lavaMap: trackLavaFor(player) ? ensureTracker(player).lava : null
      })
      return
    }
    if (n === 'update_sub_chunk_blocks') {
      handleUpdateSubChunkBlocks(player, p, {
        oreMap: ensureTracker(player).map,
        lavaMap: trackLavaFor(player) ? ensureTracker(player).lava : null
      })
      return
    }
    if (n === 'level_chunk') {
      bumpOreScanStat(player, 'levelChunks', 1)
      fastChunkScan(player, p, 'level_chunk', des)
      scheduleOreScan(player, p, 'level_chunk', makeHandlers(player), scanOptsFor(player), des)
      return
    }
    if (n === 'subchunk') {
      bumpOreScanStat(player, 'subchunkPackets', 1)
      fastChunkScan(player, p, 'subchunk', des)
      scheduleOreScan(player, p, 'subchunk', makeHandlers(player), scanOptsFor(player), des)
    }
  })
}

module.exports = {
  name: 'OreTracker',
  description: 'Central chunk ore scanner',

  onPlayer (player) {
    wireChunkPackets(player)
    if (!player._oreSummaryTimer) {
      player._oreSummaryTimer = setInterval(() => {
        const d = getOreScanDiagnostics(player)
        if (!d) return
        if (d.levelChunks === 0 && d.subchunkPackets === 0) return
        if (d.oresTracked > 0 && player._oreSummaryLogged) return
        if (d.oresTracked > 0) {
          player._oreSummaryLogged = true
          tlog.ore(`${playerName(player)} tracking ${d.oresTracked} ores (registry=${d.registryBlocks} oreRids=${d.oreRids})`)
          return
        }
        if (d.levelChunks + d.subchunkPackets >= 8 && !player._oreZeroWarned) {
          player._oreZeroWarned = true
          tlog.warn(`zero-ores-${playerName(player)}`,
            `${playerName(player)} 0 ores after ${d.levelChunks} chunks / ${d.subchunkPackets} subchunks — ` +
            `registry=${d.registryBlocks} emptyPayload=${d.emptyPayloadChunks || 0} blobCache=${d.blobCacheSize} blobMiss=${d.blobMiss}`)
        }
      }, 12000)
    }
  },



  registerOreConsumer,
  ensureTracker,
  getTrackedOres (player) {
    return ensureTracker(player).map
  },
  getTrackedLava (player) {
    return ensureTracker(player).lava
  }
}