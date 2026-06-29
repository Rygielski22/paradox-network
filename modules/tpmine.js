'use strict'
// created by droopy
// rewritten by dani for instant tp, anti lava and anti bedrock.

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { instantFlight } = require('../core/instant-tp')
const { prepareInstantTp } = require('../core/tp-prep')
const { ensureTracker } = require('./ore-tracker')
const { getOreScanDiagnostics } = require('../core/chunk-scan')
const TARGET_Y_OFFSET = 1
const RECENT_VISIT_WINDOW_MS = 1500
const MIN_TP_DISTANCE = 1.5
const MAX_PACKET_STEP = 3.0
const ARRIVE_DISTANCE = 1.5

module.exports = {
  name: 'TpMine',
  description: 'Sneak to TP between filtered ores',

  onPlayer (player, relay) {
    if (player._tpmineEnabled === undefined) player._tpmineEnabled = false
    const tr = ensureTracker(player)
    player._tpmineOreMap = tr.map
    player._tpmineLavaMap = tr.lava
    player._tpmineFilter = null
    player._tpmineRid = null
    player._tpminePos = null
    player._tpmineLastSneak = false
    player._tpmineLastVisited = null
    player._tpminePhase = 'idle'
    player._tpmineTarget = null

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._tpmineRid = data.params.runtime_entity_id
        player._tpminePhase = 'idle'
        player._tpmineTarget = null
        return
      }
      if (data.name === 'change_dimension' || data.name === 'transfer') {
        player._tpminePhase = 'idle'
        player._tpmineTarget = null
        return
      }
      if (player._tpminePhase === 'flying') {
        if (data.name === 'move_player' || data.name === 'correct_player_movement') {
          if (data.name === 'move_player' && data.params?.position && player._tpminePos) {
            const p = data.params.position
            if (Math.abs(p.x - player._tpminePos.x) > 200 || Math.abs(p.y - player._tpminePos.y) > 200 || Math.abs(p.z - player._tpminePos.z) > 200) {
              player._tpminePhase = 'idle'; player._tpmineTarget = null; sendMessage(player, theme.toggle('TpMine', false) + ' (server teleport)'); return
            }
          }
          des.canceled = true
        }
      }

      if (data.name === 'entity_event' && data.params && player._tpmineRid && player._tpmineEnabled) {
        if (data.params.event_id === 'death_smoke_cloud' && String(data.params.runtime_entity_id) === String(player._tpmineRid)) {
          player._tpminePhase = 'idle'; player._tpmineTarget = null
        }
      }
      if (data.name === 'set_health' && data.params?.health <= 0 && player._tpmineEnabled) {
        player._tpminePhase = 'idle'; player._tpmineTarget = null
      }
      if (data.name === 'respawn' && player._tpmineEnabled) {
        player._tpminePhase = 'idle'; player._tpmineTarget = null
      }

    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return
      player._tpminePos = data.params.position
      if (!player._tpmineEnabled || !player._tpmineRid) { player._tpmineLastSneak = isSneaking(data.params.input_data); return }
      if (player._tpminePhase === 'flying' && player._tpmineTarget) { stepFlight(player, data.params); return }
      const sneakNow = isSneaking(data.params.input_data)
      if (sneakNow && !player._tpmineLastSneak) startTpToNearestOre(player, data.params)
      player._tpmineLastSneak = sneakNow
    })
  },

  onEnable (relay) {
    registerCommand('tpmine', 'Sneak TP to ores (?tpmine on/off/filter/list/status/clear)', (player, args) => {
      const cmd = (args[0] || '').toLowerCase()
      if (cmd === 'on') { player._tpmineEnabled = true; sendMessage(player, theme.toggle('TpMine', true, '— sneak to TP' + (player._tpmineFilter ? ` (filter: ${player._tpmineFilter})` : ''))) }
      else if (cmd === 'off') { player._tpmineEnabled = false; player._tpminePhase = 'idle'; player._tpmineTarget = null; sendMessage(player, theme.toggle('TpMine', false)) }
      else if (cmd === 'filter') {
        const f = (args[1] || '').toLowerCase()
        if (!f || f === 'clear' || f === 'none') { player._tpmineFilter = null; sendMessage(player, theme.line('TpMine', '§7filter cleared')) }
        else { player._tpmineFilter = f; sendMessage(player, theme.line('TpMine', `§7filter: §f${f}`)) }
      } else if (cmd === 'list') { showNearest(player, (args[1] || '').toLowerCase()) }
      else if (cmd === 'status') {
        const counts = {}
        for (const ore of player._tpmineOreMap.values()) counts[ore.name] = (counts[ore.name] || 0) + 1
        const d = getOreScanDiagnostics(player)
        const lines = [
          theme.line('TpMine', player._tpmineEnabled ? '§aON' : '§cOFF'),
          `§7Filter: §f${player._tpmineFilter || '(none)'}`,
          `§7Tracked Ores: §f${player._tpmineOreMap.size}`,
          `§7Tracked Lava: §f${player._tpmineLavaMap.size}`,
          `§7Scan: §f${d.levelChunks}§7 chunks §f${d.subchunkPackets}§7 sub §7registry §f${d.registryBlocks}§7 oreRids §f${d.oreRids}`
        ]
        if (d.blobMiss > 0) lines.push(`§7Blob miss: §f${d.blobMiss} §7cache: §f${d.blobCacheSize}`)
        for (const [n, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
          lines.push(`  §d${n.replace('minecraft:', '')}: §f${c}`)
        }
        sendMessage(player, lines.join('\n'))
      } else if (cmd === 'clear') { player._tpmineOreMap.clear(); player._tpmineLavaMap.clear(); sendMessage(player, theme.line('TpMine', '§7ore and lava maps cleared')) }
      else sendMessage(player, theme.line('TpMine', '?tpmine on/off/filter <type>/list [type]/status/clear'))
    })
  }
}

function isSneaking (f) { if (!f || typeof f !== 'object') return false; return !!(f.sneaking || f.sneak_down || f.sneak_current_raw || f.start_sneaking) }

// now tps to nearest vein
function startTpToNearestOre (player, authParams) {
  if (player._tpmineOreMap.size === 0) { sendMessage(player, theme.error('No ores tracked yet — walk around to load chunks')); return }
  const pos = authParams.position, filter = player._tpmineFilter, recent = player._tpmineLastVisited, now = Date.now()
  const visitedBlocks = new Set()
  const veins = []
  for (const ore of player._tpmineOreMap.values()) {
    if (filter && !ore.name.includes(filter)) continue
    const blockKey = `${ore.x},${ore.y},${ore.z}`
    if (visitedBlocks.has(blockKey)) continue
    const currentVein = []
    const queue = [ore]
    visitedBlocks.add(blockKey)
    while (queue.length > 0) {
      const current = queue.shift()
      currentVein.push(current)
      for (const neighbor of player._tpmineOreMap.values()) {
        if (filter && !neighbor.name.includes(filter)) continue
        const nKey = `${neighbor.x},${neighbor.y},${neighbor.z}`
        if (visitedBlocks.has(nKey)) continue
        if (Math.abs(current.x - neighbor.x) <= 1 &&
            Math.abs(current.y - neighbor.y) <= 1 &&
            Math.abs(current.z - neighbor.z) <= 1) {
          visitedBlocks.add(nKey)
          queue.push(neighbor)
        }
      }
    }
    veins.push(currentVein)
  }
  let bestVein = null
  let bestOreInVein = null
  let bestVeinSize = -1
  let bestDist = Infinity
  for (const vein of veins) {
    let closestSafeOreInVein = null
    let closestVeinDist = Infinity
    for (const ore of vein) {
      const key = `${ore.x},${ore.y},${ore.z}`
      if (recent && recent.key === key && now - recent.t < RECENT_VISIT_WINDOW_MS) continue
      const targetX = ore.x + 0.5
      const targetY = ore.y + TARGET_Y_OFFSET
      const targetZ = ore.z + 0.5
      const txFloor = Math.floor(targetX)
      const tyFloor = Math.floor(targetY)
      const tzFloor = Math.floor(targetZ)
      if (player._tpmineLavaMap.has(`${txFloor},${tyFloor},${tzFloor}`) || player._tpmineLavaMap.has(`${txFloor},${tyFloor + 1},${tzFloor}`) ||
          player._tpmineLavaMap.has(`${txFloor},${tyFloor - 1},${tzFloor}`)) {
        continue
      }
      if (isLavaInPath(pos, { x: targetX, y: targetY, z: targetZ }, player._tpmineLavaMap)) {
        continue
      }
      const dx = ore.x - pos.x, dy = ore.y - pos.y, dz = ore.z - pos.z
      const d = dx*dx + dy*dy + dz*dz
      if (d < MIN_TP_DISTANCE * MIN_TP_DISTANCE) continue
      if (d < closestVeinDist) {
        closestVeinDist = d
        closestSafeOreInVein = ore
      }
    }
    if (!closestSafeOreInVein) continue
    if (vein.length > bestVeinSize) {
      bestVeinSize = vein.length
      bestDist = closestVeinDist
      bestOreInVein = closestSafeOreInVein
      bestVein = vein
    } else if (vein.length === bestVeinSize && closestVeinDist < bestDist) {
      bestDist = closestVeinDist
      bestOreInVein = closestSafeOreInVein
      bestVein = vein
    }
  }
  if (!bestOreInVein) { sendMessage(player, theme.error('No safe ores found (all paths or targets blocked by lava)')); return }
  prepareInstantTp(player, 'tpmine')
  player._tpmineTarget = { x: bestOreInVein.x + 0.5, y: bestOreInVein.y + TARGET_Y_OFFSET, z: bestOreInVein.z + 0.5 }
  player._tpminePhase = 'flying'
  player._tpmineLastVisited = { key: `${bestOreInVein.x},${bestOreInVein.y},${bestOreInVein.z}`, t: now }
  sendMessage(player, theme.line('TpMine', `flying to §d${bestOreInVein.name.replace('minecraft:', '')} §7(vein ${bestVeinSize}) @ §f${bestOreInVein.x}, ${bestOreInVein.y}, ${bestOreInVein.z}`))
}

function stepFlight (player, authParams) {
  const dest = player._tpmineTarget
  if (!dest) return
  const reached = instantFlight(player, authParams, dest, player._tpmineRid, {
    arriveDistance: ARRIVE_DISTANCE,
    tickZero: true
  })
  if (reached) {
    player._tpminePhase = 'idle'
    player._tpmineTarget = null
  }
}

function isLavaInPath (start, end, lavaMap) {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))) * 2
  for (let i = 0; i <= steps; i++) {
    const r = steps === 0 ? 0 : i / steps
    const px = Math.floor(start.x + dx * r)
    const py = Math.floor(start.y + dy * r)
    const pz = Math.floor(start.z + dz * r)
    for (let xOff = -1; xOff <= 1; xOff++) {
      for (let yOff = -1; yOff <= 1; yOff++) {
        for (let zOff = -1; zOff <= 1; zOff++) {
          if (lavaMap.has(`${px + xOff},${py + yOff},${pz + zOff}`)) {
            return true
          }
        }
      }
    }
  }
  return false
}

function showNearest (player, filter) {
  if (player._tpmineOreMap.size === 0) { sendMessage(player, theme.error('No ores tracked yet.')); return }
  const pos = player._tpminePos || { x: 0, y: 0, z: 0 }
  let entries = [...player._tpmineOreMap.values()]
  if (filter) entries = entries.filter(o => o.name.includes(filter))
  if (entries.length === 0) { sendMessage(player, theme.error(`No ores matching "${filter}".`)); return }
  entries = entries.map(o => ({ ...o, dist: Math.hypot(o.x - pos.x, o.y - pos.y, o.z - pos.z) })).sort((a, b) => a.dist - b.dist).slice(0, 15)
  const lines = [theme.heading(`TpMine Nearest${filter ? ` (${filter})` : ''}`)]
  for (const o of entries) lines.push(`  §f${o.name.replace('minecraft:', '')} §7@ §f${o.x}, ${o.y}, ${o.z} §7(${Math.floor(o.dist)}m)`)
  sendMessage(player, lines.join('\n'))
}


