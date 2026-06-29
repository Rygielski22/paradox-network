'use strict'

/**
 * PlayerCoords — serpentine fly scan at Y=100 (noclip) to stream every chunk,
 * sync back to origin, then leak all tracked player coords in chat.
 *
 * Driven on serverbound auth ticks (same engine as SMScan) — async TP loops freeze on Lifeboat.
 *
 * ?playercoords [scan|stop|margin <n>]
 */

const { registerCommand, sendMessage, onDeath } = require('./chat-commands')
const theme = require('../core/theme')
const { bindKaEntityTracking, hasDisplayName, resetKaEntityFreshness } = require('../core/ka-entities')
const { meteorTp } = require('../core/meteor-tp')
const { prepareInstantTp, releaseInstantTp, stripFlyForTp } = require('../core/tp-prep')
const { triggerStatusPulse, clearHudTip } = require('../core/mod-status')
const { SYNC_MS } = require('../core/tp/config')

// Lifeboat playable bounds (world border is outside these coords).
const MAP_MIN = 25
const MAP_MAX = 1175

const SCAN_Y = 100
const STRIP_GAP = 64
const FLY_SPEED = 6
const DEFAULT_BORDER_MARGIN = 48
const SEND_GAP_MS = 600
const BLOCK_CORRECTION_MS = 1200
const PULSE_EVERY_TICKS = 40

function authFromPlayer (player, pos) {
  const { buildPlayerAuthInput } = require('../core/protocol')
  const { authPacketFromPlayer } = require('../core/ka-entities')
  return buildPlayerAuthInput(player, {
    ...authPacketFromPlayer(player, pos, player._kaLastAuth?.tick ?? 0),
    position: { x: pos.x, y: pos.y, z: pos.z },
    delta: { x: 0, y: 0, z: 0 },
    move_vector: { x: 0, z: 0 },
    raw_move_vector: { x: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 }
  })
}

function livePos (player) {
  return player._playerCoordsPos || player._kaLastAuth?.position || player._kaPos
}

function scanBounds (player) {
  const margin = player._playerCoordsMargin ?? DEFAULT_BORDER_MARGIN
  const minX = MAP_MIN + margin
  const maxX = MAP_MAX - margin
  const minZ = MAP_MIN + margin
  const maxZ = MAP_MAX - margin
  const spanX = maxX - minX
  const spanZ = maxZ - minZ
  if (spanX <= 0 || spanZ <= 0) return null
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    spanX,
    spanZ,
    strips: Math.ceil(spanX / STRIP_GAP)
  }
}

function setMotion (player, vel) {
  const rid = player._playerCoordsRid
  if (rid == null) return
  try {
    player.queue('set_entity_motion', {
      runtime_entity_id: BigInt(rid),
      velocity: vel,
      tick: 0n
    })
  } catch (_) {}
}

function enableScanFlight (player) {
  player._moduleTpFlight = true
  player._disablerAbilitiesTick = 0
  player._disablerWasFlying = true
}

function disableScanFlight (player) {
  player._moduleTpFlight = false
  setMotion(player, { x: 0, y: 0, z: 0 })
  try { stripFlyForTp(player) } catch (_) {}
  player._disablerWasFlying = false
}

function inPlayerCoordsCorrection (player) {
  return !!(
    player._playerCoordsPhase === 'scanning' ||
    player._playerCoordsPhase === 'returning' ||
    (player._playerCoordsBlockCorrectionUntil && Date.now() < player._playerCoordsBlockCorrectionUntil)
  )
}

function stopScan (player, reason) {
  player._playerCoordsScanGen = (player._playerCoordsScanGen || 0) + 1
  player._playerCoordsPhase = 'idle'
  player._playerCoordsOrigin = null
  player._playerCoordsVirtualTicks = null
  player._playerCoordsBlockCorrectionUntil = 0
  setMotion(player, { x: 0, y: 0, z: 0 })
  disableScanFlight(player)
  releaseInstantTp(player)
  clearHudTip(player)
  if (reason) sendMessage(player, theme.line('PlayerCoords', reason))
}

function scanActive (player) {
  return player._playerCoordsPhase === 'scanning' || player._playerCoordsPhase === 'returning'
}

function recordScanPlayer (player, params, opts = {}) {
  if (!scanActive(player)) return
  const rid = params.runtime_id ?? params.runtime_entity_id
  const pos = params.position
  const rawName = (params.username || params.name || opts.name || '').replace(/§./g, '').trim()
  if (rid == null || !pos) return

  const myRid = String(player._kaRid || player._playerCoordsRid || '')
  if (myRid && String(rid) === myRid) return

  let key = rawName ? rawName.toLowerCase() : null
  if (!key) {
    const byRid = player._playerCoordsByRid?.get(String(rid))
    key = byRid || `rid:${rid}`
  }

  const prev = player._playerCoordsFound.get(key)
  const displayName = rawName || prev?.displayName || null
  const entry = {
    displayName: displayName || prev?.displayName || null,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    rid,
    lastSeen: Date.now()
  }
  player._playerCoordsFound.set(key, entry)
  if (!player._playerCoordsByRid) player._playerCoordsByRid = new Map()
  player._playerCoordsByRid.set(String(rid), key)

  if (displayName && key.startsWith('rid:')) {
    const namedKey = displayName.toLowerCase()
    player._playerCoordsFound.delete(key)
    player._playerCoordsFound.set(namedKey, { ...entry, displayName })
    player._playerCoordsByRid.set(String(rid), namedKey)
  }
}

function updateScanPlayerByRid (player, rid, pos) {
  if (!scanActive(player) || rid == null || !pos) return
  const mapKey = player._playerCoordsByRid?.get(String(rid))
  if (!mapKey) return
  const ent = player._playerCoordsFound.get(mapKey)
  if (!ent) return
  ent.x = pos.x
  ent.y = pos.y
  ent.z = pos.z
  ent.lastSeen = Date.now()
}

function applyScanNametag (player, rid, tag) {
  if (!scanActive(player) || rid == null || !tag) return
  const name = tag.replace(/§./g, '').trim()
  if (!name || name.toLowerCase() === 'player') return
  if (!hasDisplayName({ name })) return

  const ridKey = `rid:${rid}`
  const prev = player._playerCoordsFound.get(ridKey) || player._playerCoordsFound.get(name.toLowerCase())
  const entry = {
    displayName: name,
    x: prev?.x ?? 0,
    y: prev?.y ?? 0,
    z: prev?.z ?? 0,
    rid,
    lastSeen: Date.now()
  }
  const namedKey = name.toLowerCase()
  player._playerCoordsFound.set(namedKey, entry)
  if (!player._playerCoordsByRid) player._playerCoordsByRid = new Map()
  player._playerCoordsByRid.set(String(rid), namedKey)
  if (ridKey !== namedKey) player._playerCoordsFound.delete(ridKey)
}

function collectTrackedPlayers (player) {
  const myRid = String(player._kaRid || player._playerCoordsRid || '')
  const seen = new Map()

  for (const [key, ent] of player._playerCoordsFound || []) {
    if (key.startsWith('rid:') || !ent?.displayName) continue
    if (ent.x == null || ent.y == null || ent.z == null) continue
    seen.set(key, {
      name: ent.displayName,
      x: ent.x,
      y: ent.y,
      z: ent.z
    })
  }

  for (const [key, ent] of player._kaEntities || []) {
    if (ent.type !== 'player' || !hasDisplayName(ent) || ent.isNpc || ent.removed) continue
    if (myRid && String(key) === myRid) continue
    if (String(key).startsWith('plist:')) continue
    const tag = ent.name.toLowerCase()
    if (seen.has(tag)) continue
    seen.set(tag, { name: ent.name, x: ent.x, y: ent.y, z: ent.z })
  }

  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function leakCoordsInChat (player, list) {
  if (!player.upstream || !list.length) return
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    const idx = i
    setTimeout(() => {
      if (!player.upstream) return
      try {
        const line = `${e.name} @ ${Math.floor(e.x)}, ${Math.floor(e.y)}, ${Math.floor(e.z)}`
        player.upstream.queue('text', {
          type: 'chat',
          needs_translation: false,
          source_name: line,
          message: `${e.name} coords`,
          xuid: player.profile?.xuid || '',
          platform_chat_id: '',
          filtered_message: ''
        })
      } catch (_) {}
    }, idx * SEND_GAP_MS)
  }
}

function completeReturn (player, gen) {
  if (player._playerCoordsScanGen !== gen) return

  player._playerCoordsPhase = 'idle'
  player._playerCoordsOrigin = null
  player._playerCoordsVirtualTicks = null
  player._playerCoordsBlockCorrectionUntil = Date.now() + BLOCK_CORRECTION_MS

  releaseInstantTp(player)
  disableScanFlight(player)
  clearHudTip(player)

  const players = collectTrackedPlayers(player)
  leakCoordsInChat(player, players)

  const eta = players.length ? Math.ceil((players.length * SEND_GAP_MS) / 1000) : 0
  if (players.length) {
    sendMessage(player, theme.line('PlayerCoords',
      `§7found §f${players.length}§7 — leaking coords §8(~${eta}s)`))
  } else {
    sendMessage(player, theme.line('PlayerCoords', '§7scan complete — no players found'))
  }
}

function beginReturnHome (player) {
  const origin = player._playerCoordsOrigin
  const from = livePos(player)
  if (!origin || !from) {
    stopScan(player, '§7lost position')
    return
  }

  const gen = player._playerCoordsScanGen
  player._playerCoordsPhase = 'returning'
  setMotion(player, { x: 0, y: 0, z: 0 })
  triggerStatusPulse(player, 'Syncing position...')

  prepareInstantTp(player, 'playercoords')
  meteorTp(player, origin, from, {
    moduleKey: 'playercoords',
    rid: player._playerCoordsRid,
    authParams: authFromPlayer(player, from),
    onArrive: () => {
      player._playerCoordsPos = { x: origin.x, y: origin.y, z: origin.z }
    }
  })

  setTimeout(() => completeReturn(player, gen), SYNC_MS + 200)
}

function finishScan (player) {
  if (player._playerCoordsPhase !== 'scanning') return
  sendMessage(player, theme.line('PlayerCoords',
    `§7sweep done — §f${collectTrackedPlayers(player).length}§7 tracked, syncing home`))
  beginReturnHome(player)
}

function runScanTick (player, pos) {
  const bounds = scanBounds(player)
  if (!bounds) {
    stopScan(player, '§7bounds lost')
    return
  }

  const { minX, maxX, minZ, maxZ, spanX } = bounds
  const turnPad = Math.min(40, STRIP_GAP * 0.5)

  if (pos.y < SCAN_Y - 5) {
    setMotion(player, { x: 0, y: FLY_SPEED * 0.6, z: 0 })
    return
  }

  if (!player._playerCoordsAtCorner) {
    const ddx = minX - pos.x
    const ddz = minZ - pos.z
    const d = Math.hypot(ddx, ddz)
    if (d < 24) {
      player._playerCoordsAtCorner = true
    } else {
      const scale = FLY_SPEED / d
      setMotion(player, { x: ddx * scale, y: 0, z: ddz * scale })
      return
    }
  }

  const targetX = Math.min(maxX, minX + (player._playerCoordsStrip * STRIP_GAP))
  const dx2 = targetX - pos.x

  if ((player._playerCoordsDir === 1 && pos.z >= maxZ - turnPad) ||
      (player._playerCoordsDir === -1 && pos.z <= minZ + turnPad)) {
    player._playerCoordsDir *= -1
    player._playerCoordsStrip++
    if (player._playerCoordsStrip * STRIP_GAP > spanX) {
      finishScan(player)
      return
    }
  }

  let vx = 0
  let vz = FLY_SPEED * player._playerCoordsDir
  if (Math.abs(dx2) > 8) vx = Math.max(-FLY_SPEED, Math.min(FLY_SPEED, dx2 * 0.12))

  let vy = 0
  if (pos.y < SCAN_Y - 2) vy = 0.4
  else if (pos.y > SCAN_Y + 2) vy = -0.4

  setMotion(player, { x: vx, y: vy, z: vz })

  player._playerCoordsPulseTicks = (player._playerCoordsPulseTicks || 0) + 1
  if (player._playerCoordsPulseTicks % PULSE_EVERY_TICKS === 0) {
    triggerStatusPulse(player, 'Finding Players...')
  }
}

function bumpVirtualTicks (player, authParams) {
  if (player._playerCoordsVirtualTicks == null) {
    player._playerCoordsVirtualTicks = authParams.ticks_alive || 0
  }
  if (Math.abs(player._playerCoordsVirtualTicks - (authParams.ticks_alive || 0)) > 5000 &&
      player._playerCoordsVirtualTicks < (authParams.ticks_alive || 0)) {
    player._playerCoordsVirtualTicks = authParams.ticks_alive || 0
  }
  player._playerCoordsVirtualTicks += 3
  authParams.ticks_alive = Math.floor(player._playerCoordsVirtualTicks)
}

function startScan (player) {
  if (!player._disablerEnabled) {
    sendMessage(player, theme.error('enable §f?lifeboatmode on §7first'))
    return
  }
  if (!player._playerCoordsRid) {
    sendMessage(player, theme.error('not ready — reconnect'))
    return
  }
  if (player._playerCoordsPhase === 'scanning' || player._playerCoordsPhase === 'returning') {
    stopScan(player, theme.toggle('PlayerCoords', false))
    return
  }
  try {
    const tp = require('../core/tp')
    if (tp?.isSyncing?.(player) || tp?.isGuarding?.(player)) {
      sendMessage(player, theme.error('wait for current TP to finish'))
      return
    }
  } catch (_) {}

  const pos = livePos(player)
  if (!pos) {
    sendMessage(player, theme.error('move once before scanning'))
    return
  }

  player._playerCoordsScanGen = (player._playerCoordsScanGen || 0) + 1
  player._playerCoordsOrigin = { x: pos.x, y: pos.y, z: pos.z }
  player._playerCoordsMargin = player._playerCoordsMargin ?? DEFAULT_BORDER_MARGIN
  player._playerCoordsFound = new Map()
  player._playerCoordsByRid = new Map()
  resetKaEntityFreshness(player)
  player._playerCoordsPhase = 'scanning'
  player._playerCoordsStrip = 0
  player._playerCoordsDir = 1
  player._playerCoordsAtCorner = false
  player._playerCoordsPulseTicks = 0
  player._playerCoordsVirtualTicks = null

  enableScanFlight(player)
  triggerStatusPulse(player, 'Finding Players...')

  const bounds = scanBounds(player)
  const margin = player._playerCoordsMargin ?? DEFAULT_BORDER_MARGIN
  sendMessage(player, theme.toggle('PlayerCoords', true,
    `§7§f${MAP_MIN}–${MAP_MAX}§7 inset §f${margin}§7 @ Y§f${SCAN_Y}§7 · §f${bounds?.strips ?? '?'}§7 strips`))
}

module.exports = {
  name: 'PlayerCoords',
  description: 'Grid-scan map for player coords (?playercoords)',

  onPlayer (player) {
    player._playerCoordsRid = null
    player._playerCoordsPos = null
    player._playerCoordsPhase = 'idle'
    player._playerCoordsOrigin = null
    player._playerCoordsMargin = DEFAULT_BORDER_MARGIN
    player._playerCoordsScanGen = 0
    player._playerCoordsBlockCorrectionUntil = 0
    player._playerCoordsStrip = 0
    player._playerCoordsDir = 1
    player._playerCoordsAtCorner = false
    player._playerCoordsFound = new Map()
    player._playerCoordsByRid = new Map()
    bindKaEntityTracking(player)

    onDeath(player, () => stopScan(player))

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._playerCoordsRid = data.params.runtime_entity_id
        player._playerCoordsFound = new Map()
        player._playerCoordsByRid = new Map()
        stopScan(player)
        return
      }

      if (data.name === 'change_dimension' || data.name === 'transfer') {
        stopScan(player)
        return
      }

      if (data.name === 'entity_event' && data.params &&
          data.params.event_id === 'death_smoke_cloud' &&
          String(data.params.runtime_entity_id) === String(player._playerCoordsRid)) {
        stopScan(player, '§7(death)')
        return
      }

      if (scanActive(player)) {
        const p = data.params
        if (data.name === 'add_player' && p) {
          recordScanPlayer(player, p)
        } else if (data.name === 'add_entity' && p) {
          const et = p.entity_type || p.identifier || p.type || ''
          if (et === 'minecraft:player' || et === 'player') {
            recordScanPlayer(player, p, { confirmedPlayer: true })
          }
        } else if (data.name === 'move_entity' && p?.position) {
          updateScanPlayerByRid(player, p.runtime_entity_id, p.position)
        } else if (data.name === 'move_entity_delta' && p) {
          if (p.x !== undefined || p.y !== undefined || p.z !== undefined) {
            updateScanPlayerByRid(player, p.runtime_entity_id, {
              x: p.x ?? 0,
              y: p.y ?? 0,
              z: p.z ?? 0
            })
          }
        } else if (data.name === 'set_entity_data' && p?.metadata) {
          for (const m of p.metadata) {
            if (m?.key === 'nametag' && typeof m.value === 'string' && m.value) {
              applyScanNametag(player, p.runtime_entity_id, m.value)
            }
          }
        }
      }

      if (!inPlayerCoordsCorrection(player)) return
      if (data.name !== 'move_player' && data.name !== 'correct_player_movement') return

      if (data.name === 'move_player' && data.params?.position && player._playerCoordsPos) {
        const p = data.params.position
        if (Math.abs(p.x - player._playerCoordsPos.x) > 200 ||
            Math.abs(p.y - player._playerCoordsPos.y) > 200 ||
            Math.abs(p.z - player._playerCoordsPos.z) > 200) {
          stopScan(player, '§7(server teleport)')
          return
        }
      }
      if (des) des.canceled = true
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return

      player._playerCoordsPos = data.params.position

      if (player._playerCoordsPhase === 'scanning') {
        bumpVirtualTicks(player, data.params)
        runScanTick(player, data.params.position)
        return
      }

      if (player._playerCoordsPhase === 'idle') {
        player._playerCoordsVirtualTicks = null
      }

      if (player._playerCoordsBlockCorrectionUntil &&
          Date.now() >= player._playerCoordsBlockCorrectionUntil) {
        player._playerCoordsBlockCorrectionUntil = 0
      }
    })
  },

  onEnable () {
    registerCommand('playercoords', 'Scan map for player coords (?playercoords [scan|stop|margin])', (player, args) => {
      const arg = (args[0] || '').toLowerCase()

      if (arg === 'stop' || arg === 'off') {
        stopScan(player, theme.toggle('PlayerCoords', false))
        return
      }

      if (arg === 'margin' || arg === 'inset' || arg === 'r') {
        const n = parseInt(args[1], 10)
        if (isNaN(n) || n < 16 || n > 200) {
          sendMessage(player, theme.error('?playercoords margin <16-200>'))
          return
        }
        player._playerCoordsMargin = n
        sendMessage(player, theme.line('PlayerCoords',
          `§7border inset §f${n}§7 → scan §f${MAP_MIN + n}–${MAP_MAX - n}`))
        return
      }

      if (!arg || arg === 'scan' || arg === 'on') {
        startScan(player)
        return
      }

      if (player._playerCoordsPhase !== 'idle') {
        sendMessage(player, theme.line('PlayerCoords',
          `§7${player._playerCoordsPhase}… §8(?playercoords stop)`))
        return
      }

      const list = collectTrackedPlayers(player)
      if (!list.length) {
        sendMessage(player, theme.line('PlayerCoords', '§7no players tracked — run §f?playercoords'))
        return
      }
      const lines = [theme.heading(`Players (${list.length})`)]
      for (const e of list.slice(0, 25)) {
        lines.push(`  §f${e.name} §7@ ${Math.floor(e.x)}, ${Math.floor(e.y)}, ${Math.floor(e.z)}`)
      }
      if (list.length > 25) lines.push(`  §8…and ${list.length - 25} more`)
      sendMessage(player, lines.join('\n'))
    })
  }
}