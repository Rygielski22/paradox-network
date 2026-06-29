'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { enrichChunkParams } = require('../core/chunk-scan')
const { scanChunkForTiles } = require('../core/tile-scan')
const { meteorTp } = require('../core/meteor-tp')
const { sendClientMovePlayerSnap } = require('../core/tensura-tp')
const { triggerStatusPulse } = require('../core/mod-status')

const RECENT_VISIT_WINDOW_MS = 1500
const MIN_TP_DISTANCE = 1.5
const MAX_TP_RANGE = 256
const FLY_WATCHDOG_MS = 2500
const MAX_TRACKED_CHESTS = 1000
const TARGET_Y_OFFSET = 2
const ARRIVE_DISTANCE = 1.5
const LANDED_MS = 1200
const LAND_GUARD_MS = 1200
const GRACE_MS = 400
const BLOCK_CORRECTION_MS = 1800
const TP_COOLDOWN_MS = 650
const MIN_CHEST_Y = 70
const MAX_CHEST_Y = 85

module.exports = {
  name: 'TpChest',
  description: 'Sneak to TP to the next nearest chest',

  onPlayer (player, relay) {
    if (player._chestTpEnabled === undefined) player._chestTpEnabled = false
    player._chestTpRid = null
    player._chestTpPos = null
    player._chestTpChests = new Map()
    player._chestTpVisited = new Set()
    player._chestTpLastSneak = false
    player._chestTpLastVisited = null
    player._chestTpPhase = 'idle'
    player._chestTpTarget = null
    player._chestTpFlyStart = 0
    player._chestTpTimerState = {}
    player._chestTpLandGuardUntil = 0
    player._chestTpCooldownUntil = 0
    player._chestTpAnchor = null
    player._chestTpLandedUntil = 0
    player._chestTpBlockCorrectionUntil = 0

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._chestTpRid = data.params.runtime_entity_id
        player._chestTpChests.clear()
        player._chestTpVisited.clear()
        player._chestTpPhase = 'idle'
        player._chestTpTarget = null
        return
      }
      if (data.name === 'change_dimension' || data.name === 'transfer') {
        player._chestTpChests.clear()
        player._chestTpVisited.clear()
        player._chestTpPhase = 'idle'
        player._chestTpTarget = null
        return
      }
      if (data.name === 'container_open' && player._chestTpEnabled) {
        clearChestSettle(player)
      }
      if (!inChestTpCorrectionWindow(player)) {
        // fall through
      } else if (data.name === 'move_player' || data.name === 'correct_player_movement') {
        if (data.name === 'move_player' && data.params?.position && player._chestTpPos) {
          const p = data.params.position
          if (Math.abs(p.x - player._chestTpPos.x) > 200 ||
              Math.abs(p.y - player._chestTpPos.y) > 200 ||
              Math.abs(p.z - player._chestTpPos.z) > 200) {
            clearChestSettle(player)
            player._chestTpBlockCorrectionUntil = 0
            return
          }
        }
        des.canceled = true
        return
      }

      if (player._chestTpEnabled && data.name === 'level_chunk' && data.params) {
        try {
          const params = enrichChunkParams(data.params, des, 'level_chunk')
          for (const raw of scanChunkForTiles(params)) {
            const chest = normalizeChest(raw)
            if (!isValidChestCoord(chest)) continue
            const key = chestKey(chest)
            if (!player._chestTpChests.has(key)) {
              player._chestTpChests.set(key, chest)
            }
          }
          pruneChestMap(player)
        } catch (e) {}
      }
      if (data.name === 'set_health' && data.params?.health <= 0 && player._chestTpEnabled) {
        player._chestTpPhase = 'idle'
        player._chestTpTarget = null
        player._chestTpBlockCorrectionUntil = 0
      }
      if (data.name === 'respawn' && player._chestTpEnabled) {
        player._chestTpPhase = 'idle'
        player._chestTpTarget = null
        player._chestTpBlockCorrectionUntil = 0
      }
    })

    player.on('serverbound', (data, des) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return

      if (player._chestTpPhase === 'landed' &&
          player._chestTpLandedUntil &&
          Date.now() >= player._chestTpLandedUntil) {
        clearChestSettle(player)
      }

      if (player._chestTpPhase === 'landed') {
        holdChestAnchor(player, data.params)
        player._chestTpLastSneak = isSneaking(data.params.input_data)
        return
      }

      if (!player._chestTpEnabled || !player._chestTpRid) {
        player._chestTpPos = data.params.position
        player._chestTpLastSneak = isSneaking(data.params.input_data)
        return
      }

      if (player._chestTpPhase === 'flying') {
        player._chestTpLastSneak = isSneaking(data.params.input_data)
        return
      }

      player._chestTpPos = data.params.position
      player._chestTpTimerState = {}

      const sneakNow = isSneaking(data.params.input_data)
      if (sneakNow && !player._chestTpLastSneak && canStartChestTp(player)) {
        startTpToNearestChest(player, data.params)
      }
      player._chestTpLastSneak = sneakNow
    })
  },

  onEnable (relay) {
    registerCommand('tpchest', 'TP to chests (?tpchest on/off/clear/list/status)', (player, args) => {
      const cmd = (args[0] || '').toLowerCase()
      if (cmd === 'on') {
        player._chestTpEnabled = true
        sendMessage(player, theme.toggle('TpChest', true, '— sneak to TP (use ?lifeboatmode on)'))
      } else if (cmd === 'off') {
        cancelTpChest(player, theme.toggle('TpChest', false))
      } else if (cmd === 'clear') {
        player._chestTpVisited.clear()
        sendMessage(player, theme.line('TpChest', '§7visited list cleared'))
      } else if (cmd === 'list') {
        showNearest(player)
      } else if (cmd === 'status') {
        sendMessage(player, theme.line('TpChest',
          `§7tracked §f${player._chestTpChests.size}§7 · visited §f${player._chestTpVisited.size}`))
      } else {
        sendMessage(player, theme.line('TpChest', '?tpchest on/off/clear/list/status'))
      }
    })
  }
}

function inChestTpCorrectionWindow (player) {
  return !!(
    player._chestTpPhase === 'flying' ||
    player._chestTpPhase === 'landed' ||
    (player._chestTpBlockCorrectionUntil && Date.now() < player._chestTpBlockCorrectionUntil)
  )
}

function canStartChestTp (player) {
  if (player._chestTpPhase !== 'idle') return false
  if (Date.now() < (player._chestTpCooldownUntil || 0)) return false
  try {
    const tp = require('../core/tp')
    if (tp?.isSyncing?.(player) || tp?.isGuarding?.(player)) return false
  } catch (_) {}
  return true
}

function clearChestSettle (player) {
  player._chestTpPhase = 'idle'
  player._chestTpTarget = null
  player._chestTpGraceUntil = 0
  player._chestTpLandGuardUntil = 0
  player._chestTpLandedUntil = 0
  player._chestTpAnchor = null
  player._chestTpBlockCorrectionUntil = 0
}

function zeroAuthMotion (params) {
  if (params.delta) {
    params.delta.x = 0
    params.delta.y = 0
    params.delta.z = 0
  }
  params.move_vector = { x: 0, z: 0 }
  params.raw_move_vector = { x: 0, z: 0 }
  params.analogue_move_vector = { x: 0, z: 0 }
}

function holdChestAnchor (player, authParams) {
  const anchor = player._chestTpAnchor
  const rid = player._chestTpRid
  if (!anchor || rid == null) return
  authParams.position.x = anchor.x
  authParams.position.y = anchor.y
  authParams.position.z = anchor.z
  authParams.on_ground = true
  zeroAuthMotion(authParams)
  player._chestTpPos = { x: anchor.x, y: anchor.y, z: anchor.z }
  sendClientMovePlayerSnap(player, rid, anchor, authParams, true)
}

function normalizeChest (c) {
  return {
    x: Math.floor(c.x),
    y: Math.floor(c.y),
    z: Math.floor(c.z),
    name: c.name || 'Chest'
  }
}

function chestKey (c) {
  const n = typeof c.x === 'number' && c.x === Math.floor(c.x) ? c : normalizeChest(c)
  return `${n.x},${n.y},${n.z}`
}

function isValidChestCoord (c) {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) return false
  if (c.y < -64 || c.y > 320) return false
  if (Math.abs(c.x) > 30_000_000 || Math.abs(c.z) > 30_000_000) return false
  return true
}

function distSq (a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function pruneChestMap (player) {
  if (player._chestTpChests.size <= MAX_TRACKED_CHESTS) return
  const anchor = player._chestTpPos || { x: 0, y: 64, z: 0 }
  const ranked = [...player._chestTpChests.entries()]
    .map(([key, chest]) => ({ key, chest, d: distSq(anchor, chest) }))
    .sort((a, b) => b.d - a.d)
  while (player._chestTpChests.size > MAX_TRACKED_CHESTS && ranked.length) {
    const far = ranked.shift()
    if (far) player._chestTpChests.delete(far.key)
  }
}

function chestDest (chest) {
  return {
    x: chest.x + 0.5,
    y: chest.y + TARGET_Y_OFFSET,
    z: chest.z + 0.5
  }
}

function isSneaking (f) {
  if (!f || typeof f !== 'object') return false
  return !!(f.sneaking || f.sneak_down || f.sneak_current_raw || f.start_sneaking)
}

function startTpToNearestChest (player, authParams) {
  if (!canStartChestTp(player)) return
  if (player._chestTpChests.size === 0) {
    sendMessage(player, theme.error('No chests tracked yet — walk around to load chunks'))
    return
  }
  if (!player._disablerEnabled) {
    sendMessage(player, theme.error('enable ?lifeboatmode on before using ?tpchest'))
    return
  }

  const pos = authParams.position
  const now = Date.now()
  const recent = player._chestTpLastVisited
  const maxRangeSq = MAX_TP_RANGE * MAX_TP_RANGE
  let best = null
  let bestDist = Infinity

  for (const chest of player._chestTpChests.values()) {
    const key = chestKey(chest)
    if (player._chestTpVisited.has(key)) continue
    if (recent && recent.key === key && now - recent.t < RECENT_VISIT_WINDOW_MS) continue
    if (isDoubleChest(player._chestTpChests, chest)) continue

    const d = distSq(pos, chest)
    if (d < MIN_TP_DISTANCE * MIN_TP_DISTANCE) continue
    if (d > maxRangeSq) continue
    if (chest.y < MIN_CHEST_Y) continue
    if (chest.y > MAX_CHEST_Y) continue
    if (d < bestDist) {
      bestDist = d
      best = chest
    }
  }

  if (!best) {
    sendMessage(player, theme.error('No nearby unvisited chests. ?tpchest clear to reset.'))
    return
  }

  const key = chestKey(best)
  const dest = chestDest(best)
  player._chestTpTimerState = {}
  player._chestTpVisited.add(key)
  player._chestTpLastVisited = { key, t: now }

  player._chestTpPhase = 'flying'
  player._chestTpTarget = dest

  const ok = meteorTp(player, dest, authParams.position, {
    moduleKey: 'chest',
    rid: player._chestTpRid,
    authParams,
    phaseProp: '_chestTpPhase',
    targetProp: '_chestTpTarget',
    posProp: '_chestTpPos',
    onArrive: () => {
      triggerStatusPulse(player, `TpChest -> ${Math.floor(Math.sqrt(bestDist))}m`)
      finishChestTpArrival(player, dest)
      sendMessage(player, theme.line('TpChest',
        `§a→ §f${best.name} §7@ §f${best.x}, ${best.y}, ${best.z} §8(${Math.floor(Math.sqrt(bestDist))}m)`))
    }
  })

  if (!ok) {
    player._chestTpPhase = 'idle'
    player._chestTpTarget = null
    sendMessage(player, theme.error('TpChest failed — enable ?lifeboatmode on'))
  } else {
    sendMessage(player, theme.line('TpChest',
      `§7→ §f${best.name} §7@ §f${best.x}, ${best.y}, ${best.z}`))
  }
}

function isDoubleChest (chests, c) {
  const bx = c.x
  const by = c.y
  const bz = c.z
  return chests.has(`${bx + 1},${by},${bz}`) ||
    chests.has(`${bx - 1},${by},${bz}`) ||
    chests.has(`${bx},${by},${bz + 1}`) ||
    chests.has(`${bx},${by},${bz - 1}`)
}

function finishChestTpArrival (player, dest) {
  const anchor = dest || player._chestTpTarget || player._chestTpAnchor
  if (anchor) {
    player._chestTpAnchor = { x: anchor.x, y: anchor.y, z: anchor.z }
    player._chestTpPos = { ...player._chestTpAnchor }
    player._kaPos = { ...player._chestTpAnchor }
  }
  player._chestTpPhase = 'landed'
  player._chestTpTarget = null
  player._chestTpTimerState = {}
  const until = Date.now() + LANDED_MS
  player._chestTpLandedUntil = until
  player._chestTpLandGuardUntil = until + LAND_GUARD_MS
  player._chestTpGraceUntil = Date.now() + GRACE_MS
  player._chestTpBlockCorrectionUntil = Date.now() + BLOCK_CORRECTION_MS
  player._chestTpCooldownUntil = Date.now() + TP_COOLDOWN_MS
}

function cancelTpChest (player, msg) {
  player._chestTpEnabled = false
  player._chestTpPhase = 'idle'
  player._chestTpTarget = null
  player._chestTpTimerState = {}
  clearChestSettle(player)
  player._chestTpCooldownUntil = 0
  if (msg) sendMessage(player, msg)
}

function showNearest (player) {
  if (player._chestTpChests.size === 0) {
    sendMessage(player, theme.error('No chests tracked yet.'))
    return
  }
  const pos = player._chestTpPos || { x: 0, y: 0, z: 0 }
  const maxRangeSq = MAX_TP_RANGE * MAX_TP_RANGE
  const sorted = [...player._chestTpChests.values()]
    .map(c => ({ ...c, dist: Math.sqrt(distSq(pos, c)) }))
    .filter(c => c.dist <= MAX_TP_RANGE)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 15)
  const lines = ['§5§lTpChest Nearest:']
  for (const c of sorted) {
    const visited = player._chestTpVisited.has(chestKey(c)) ? ' §8(visited)' : ''
    lines.push(`  §d${c.name} §7@ §f${c.x}, ${c.y}, ${c.z} §8(${Math.floor(c.dist)}m)${visited}`)
  }
  if (!sorted.length) lines.push('  §8(none within range — load more chunks)')
  sendMessage(player, lines.join('\n'))
}