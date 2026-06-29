/**
 * Resource Pack Injection System
 * ─────────────────────────────────────────────────────────────────────────
 * Serves the Paradox HUD pack (watermark + arraylist UI) to clients for Lifeboat.
 *
 * Key behavior:
 *   • Pack UUID/version are read DYNAMICALLY from resource_pack/manifest.json,
 *     so rebuilding the pack (which regenerates UUIDs) automatically changes
 *     what we advertise — forcing the client to re-download.
 *   • The "already has pack" cache is keyed by the pack hash. When the pack
 *     content changes, the cache is invalidated for everyone so every player
 *     re-downloads the new HUD.
 *   • Phase 1: first time players get pack served + disconnect to install.
 *   • Phase 2: returning players get pack injected into Lifeboat's resource_pack_stack.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { appendPackToStackBuffer, validatePackStackBuffer } = require('./pack-stack-raw')

const ROOT = path.join(__dirname, '..')
const PACK_PATH = path.join(ROOT, 'paradox_pack.zip')
const MANIFEST_PATH = path.join(ROOT, 'resource_pack', 'manifest.json')
const CHUNK_SIZE = 1024 * 128

let PACK_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
let PACK_VERSION = '1.0.0'
let PACK_NAME = 'Paradox Network HUD'

let packBuffer = null
let packHash = null
let packSize = 0

const PACK_CACHE_PATH = path.join(ROOT, 'pack-players.json')
let playersWithPack = new Set()
let cachedPackSignature = null

function loadManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    if (m.header) {
      PACK_UUID = m.header.uuid || PACK_UUID
      PACK_VERSION = Array.isArray(m.header.version) ? m.header.version.join('.') : PACK_VERSION
      PACK_NAME = m.header.name || PACK_NAME
    }
    console.log(`[Pack] Manifest: ${PACK_NAME} v${PACK_VERSION} (${PACK_UUID})`)
  } catch (e) {
    console.warn('[Pack] Could not read manifest.json, using defaults:', e.message)
  }
}

// Extract and parse manifest.json from INSIDE a pack zip buffer. We advertise
// whatever UUID/version the served bytes actually contain, so the value we
// announce can never drift from what the client downloads (the drift was the
// cause of the "pack failed to load" loop). Returns the manifest or null.
function readManifestFromZip(buf) {
  try {
    // Walk local file headers looking for the "manifest.json" entry.
    let off = 0
    while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
      const method = buf.readUInt16LE(off + 8)
      const compSize = buf.readUInt32LE(off + 18)
      const nameLen = buf.readUInt16LE(off + 26)
      const extraLen = buf.readUInt16LE(off + 28)
      const name = buf.toString('utf8', off + 30, off + 30 + nameLen)
      const dataStart = off + 30 + nameLen + extraLen
      const dataEnd = dataStart + compSize
      const raw = buf.slice(dataStart, dataEnd)
      if (name === 'manifest.json') {
        const json = (method === 8) ? zlib.inflateRawSync(raw).toString('utf8') : raw.toString('utf8')
        return JSON.parse(json)
      }
      off = dataEnd
    }
  } catch (e) {
    console.warn('[Pack] Could not read manifest from zip:', e.message)
  }
  return null
}

function loadPackCache() {
  try {
    if (fs.existsSync(PACK_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(PACK_CACHE_PATH, 'utf8'))
      // New format: { signature, players: [] }. Old format: [] (player list).
      if (Array.isArray(data)) {
        playersWithPack = new Set(data)
        cachedPackSignature = null
      } else {
        cachedPackSignature = data.signature || null
        playersWithPack = new Set(data.players || [])
      }
      console.log(`[Pack] Loaded ${playersWithPack.size} cached player(s)`)
    }
  } catch (e) {
    console.error('[Pack] Failed to load pack cache:', e.message)
  }
}

function savePackCache() {
  try {
    fs.writeFileSync(PACK_CACHE_PATH, JSON.stringify({
      signature: cachedPackSignature,
      players: [...playersWithPack]
    }, null, 2))
  } catch (e) {
    console.error('[Pack] Failed to save pack cache:', e.message)
  }
}

function loadPack() {
  if (!fs.existsSync(PACK_PATH)) {
    console.error('[Pack] paradox_pack.zip not found! Run: node scripts/build-pack.js')
    return false
  }

  // Re-read the manifest too — its UUID/version change every build, and the
  // client will reject a download whose advertised UUID/version, hash and
  // bytes don't all line up. Re-loading both together prevents that drift.
  loadManifest()

  packBuffer = fs.readFileSync(PACK_PATH)
  packSize = packBuffer.length
  packHash = crypto.createHash('sha256').update(packBuffer).digest()

  // Advertise the UUID/version that are ACTUALLY inside the zip we serve, so
  // there's no drift between what we announce and what the client downloads.
  // Fall back to the disk manifest only if the zip can't be parsed.
  const zipManifest = readManifestFromZip(packBuffer)
  if (zipManifest && zipManifest.header) {
    PACK_UUID = zipManifest.header.uuid || PACK_UUID
    PACK_VERSION = Array.isArray(zipManifest.header.version) ? zipManifest.header.version.join('.') : PACK_VERSION
    PACK_NAME = zipManifest.header.name || PACK_NAME
    console.log(`[Pack] Using zip manifest: ${PACK_NAME} v${PACK_VERSION} (${PACK_UUID})`)
  } else {
    console.warn('[Pack] Falling back to disk manifest.json (zip manifest unreadable)')
  }

  // Signature ties the cache to this exact pack (hash + uuid + version).
  const signature = crypto.createHash('sha256')
    .update(packHash).update(PACK_UUID).update(PACK_VERSION)
    .digest('hex')

  if (cachedPackSignature !== signature) {
    if (cachedPackSignature !== null) {
      console.log('[Pack] Pack changed — invalidating cache so all players re-download.')
    }
    playersWithPack.clear()
    cachedPackSignature = signature
    savePackCache()
  }

  console.log(`[Pack] Loaded paradox_pack.zip (${packSize} bytes, sha256 ${packHash.slice(0, 4).toString('hex')}…)`)
  return true
}

// Force-reload the pack from disk (used by .reload command + on stale-mtime
// detection in playerNeedsPack). Returns true if the bytes changed.
function reloadPack() {
  const before = packHash ? packHash.toString('hex') : null
  loadPack()
  return before !== (packHash ? packHash.toString('hex') : null)
}

function clearPackPlayerCache () {
  playersWithPack.clear()
  cachedPackSignature = null
  savePackCache()
  console.log('[Pack] Cleared player cache — all players will be prompted to download.')
}

function getPlayerPackKey (player) {
  if (!player) return ''
  const xuid = String(player.profile?.xuid || player.profile?.XUID || '').trim()
  if (xuid && xuid !== '0') return xuid
  const name = String(player.profile?.name || '').trim()
  if (name) return `name:${name}`
  const addr = player.connection?.address || ''
  if (addr) return `addr:${addr}`
  return ''
}

let lastPackMtime = 0

function playerNeedsPack (packKey) {
  // Auto-reload if the pack on disk changed since we last read it.
  try {
    const stat = fs.statSync(PACK_PATH)
    const mtime = stat.mtimeMs
    if (mtime !== lastPackMtime) {
      lastPackMtime = mtime
      loadPack()
    }
  } catch (e) { /* fall through */ }

  if (!packKey) return false

  if (!packBuffer) {
    if (!loadPack()) {
      console.error('[Pack] paradox_pack.zip missing — cannot serve pack download')
      return true
    }
  }
  return !playersWithPack.has(packKey)
}

function collectPackKeys (player) {
  const keys = new Set()
  if (!player) return keys
  const xuid = String(player.profile?.xuid || player.profile?.XUID || '').trim()
  const name = String(player.profile?.name || '').trim()
  const addr = String(player.connection?.address || '').trim()
  if (xuid && xuid !== '0') keys.add(xuid)
  if (name) keys.add(`name:${name}`)
  if (addr) keys.add(`addr:${addr}`)
  return keys
}

function markPlayerHasPack (packKey) {
  if (!packKey) return
  playersWithPack.add(packKey)
  savePackCache()
}

/** Mark every stable id for this player so reconnect always hits the cache. */
function markPlayerHasPackForPlayer (player) {
  const keys = collectPackKeys(player)
  if (!keys.size) return
  for (const k of keys) playersWithPack.add(k)
  if (player) player._paradoxPackSig = cachedPackSignature
  savePackCache()
  console.log(`[Pack] Cached pack for: ${[...keys].join(', ')} (sig ${String(cachedPackSignature || '').slice(0, 8)})`)
}

function playerNeedsPackForPlayer (player) {
  // Per-player pack version — re-download when proxy pack changes.
  if (player?._paradoxPackSig && player._paradoxPackSig !== cachedPackSignature) return true
  const keys = collectPackKeys(player)
  if (!keys.size) return true
  for (const k of keys) {
    if (!playersWithPack.has(k)) return true
  }
  return false
}

function playerHasPack (packKey) {
  return !!(packKey && playersWithPack.has(packKey))
}

function getPackId () {
  return `${PACK_UUID}_${PACK_VERSION}`
}

function stackHasParadox (packs) {
  const id = String(PACK_UUID)
  return packs.some((p) => p && String(p.uuid) === id)
}

function isParadoxPackId (id) {
  if (!id) return false
  const s = String(id)
  return s === getPackId() || s.startsWith(PACK_UUID)
}

function deferSendBuffer (player, buf) {
  setImmediate(() => {
    try {
      if (typeof player.sendBuffer === 'function') player.sendBuffer(buf, true)
      else if (typeof player._paradoxDeferRawToClient === 'function') player._paradoxDeferRawToClient(buf)
    } catch (e) {
      console.warn('[Pack] sendBuffer failed:', e.message)
    }
  })
}

function getRawPacket (des) {
  return (des && Buffer.isBuffer(des._paradoxRawPacket) && des._paradoxRawPacket) ||
    (des && Buffer.isBuffer(des.fullBuffer) && des.fullBuffer) ||
    (des && Buffer.isBuffer(des.buffer) && des.buffer) ||
    null
}

function sendPackDataInfo (player) {
  const chunkCount = Math.ceil(packSize / CHUNK_SIZE)
  player.queue('resource_pack_data_info', {
    pack_id: getPackId(),
    max_chunk_size: CHUNK_SIZE,
    chunk_count: chunkCount,
    size: BigInt(packSize),
    hash: packHash,
    is_premium: false,
    pack_type: 'resources'
  })
}

function sendPackChunk (player, chunkIndex) {
  const offset = Number(chunkIndex) * CHUNK_SIZE
  player.queue('resource_pack_chunk_data', {
    pack_id: getPackId(),
    chunk_index: chunkIndex,
    progress: BigInt(offset),
    payload: packBuffer.slice(offset, offset + CHUNK_SIZE)
  })
}

/**
 * Phase 2: inject into Lifeboat stack without re-encoding their packet (boost pattern).
 * Also serve our pack bytes when Lifeboat join re-requests them via send_packs.
 */
function injectParadoxIntoStack (params) {
  if (!params || !Array.isArray(params.resource_packs)) return null
  const id = String(PACK_UUID)
  const packs = params.resource_packs.filter((p) => p && String(p.uuid) !== id)
  packs.push({
    uuid: PACK_UUID,
    version: PACK_VERSION,
    name: PACK_NAME || ''
  })
  params.resource_packs = packs
  return packs
}

function attachPackStack (player) {
  player.on('clientbound', (data, des) => {
    if (playerNeedsPackForPlayer(player)) return
    if (data.name !== 'resource_pack_stack') return

    const packs = injectParadoxIntoStack(data.params)
    if (!packs) return

    des.canceled = true
    try {
      player.queue('resource_pack_stack', data.params)
      player._paradoxPackStackInjected = true
      console.log(`[Pack] Injected ${PACK_NAME} into stack for ${player.profile?.name || 'player'} (${packs.length} packs, v${PACK_VERSION})`)
      return
    } catch (e) {
      console.warn('[Pack] stack queue failed, trying raw append:', e.message)
    }

    const raw = getRawPacket(des)
    if (!raw) return
    try {
      const patched = appendPackToStackBuffer(raw, PACK_UUID, PACK_VERSION, PACK_NAME || '')
      if (!patched || !validatePackStackBuffer(patched)) return
      player._paradoxPackStackInjected = true
      deferSendBuffer(player, patched)
      console.log(`[Pack] Injected ${PACK_NAME} into stack (raw) for ${player.profile?.name || 'player'}`)
    } catch (err) {
      console.warn('[Pack] resource_pack_stack raw append failed:', err.message)
    }
  })

  player.on('serverbound', (data, des) => {
    if (playerNeedsPackForPlayer(player)) return

    if (data.name === 'resource_pack_client_response') {
      const status = data.params.response_status
      const ids = data.params.resourcepackids || []
      const ours = ids.filter(isParadoxPackId)
      const theirs = ids.filter(id => !isParadoxPackId(id))

      if (status === 'send_packs' && ours.length) {
        sendPackDataInfo(player)
        console.log(`[Pack] Serving ${PACK_NAME} during Lifeboat join for ${player.profile?.name || 'player'}`)
        if (!theirs.length) {
          des.canceled = true
          return
        }
        data.params.resourcepackids = theirs
      }
      return
    }

    if (data.name === 'resource_pack_chunk_request' && isParadoxPackId(data.params.pack_id)) {
      des.canceled = true
      sendPackChunk(player, data.params.chunk_index)
    }
  })
}

loadManifest()
loadPackCache()
loadPack()

module.exports = {
  playerNeedsPack,
  playerNeedsPackForPlayer,
  playerHasPack,
  markPlayerHasPack,
  markPlayerHasPackForPlayer,
  getPlayerPackKey,
  attachPackStack,
  reloadPack,
  clearPackPlayerCache,
  get PACK_UUID() { return PACK_UUID },
  get PACK_VERSION() { return PACK_VERSION },
  get PACK_NAME() { return PACK_NAME },
  get PACK_ID() { return getPackId() },
  CHUNK_SIZE,
  get packBuffer() { return packBuffer },
  get packSize() { return packSize },
  get packHash() { return packHash }
}
