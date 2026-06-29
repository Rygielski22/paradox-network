'use strict'

// StashFinder — Lifeboat tile-entity string scan (chunk payload).

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

const STORAGE_NAMES = ['Hopper', 'Bookshelf', 'Barrel', 'BrewingStand', 'NetherWart']
const STORAGE_BUFFERS = STORAGE_NAMES.map(name => ({ name, buf: Buffer.from(name, 'utf8') }))

function scanChunkForStorage (payload) {
  const results = []
  for (const { name, buf } of STORAGE_BUFFERS) {
    let idx = 0
    while (idx < payload.length) {
      const pos = payload.indexOf(buf, idx)
      if (pos === -1) break
      const region = payload.slice(Math.max(0, pos - 100), Math.min(payload.length, pos + 300))
      const coords = extractXYZ(region)
      if (coords) results.push({ x: coords.x, y: coords.y, z: coords.z, name })
      idx = pos + buf.length
    }
  }
  return results
}

function extractXYZ (data) {
  let x = null, y = null, z = null
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0x03 && i + 2 < data.length && data[i + 1] === 1 && i + 3 <= data.length) {
      const nc = data[i + 2], r = readZigzagVarint(data, i + 3)
      if (r.bytesRead > 0) {
        if (nc === 0x78 && x === null) x = r.value
        else if (nc === 0x79 && y === null) y = r.value
        else if (nc === 0x7A && z === null) z = r.value
      }
    }
  }
  if (x !== null && y !== null && z !== null && Math.abs(x) < 30000000 && Math.abs(y) < 512 && Math.abs(z) < 30000000) return { x, y, z }
  return null
}

function readZigzagVarint (buf, offset) {
  let val = 0, shift = 0, n = 0
  while (true) {
    if (offset + n >= buf.length) return { value: 0, bytesRead: 0 }
    const b = buf[offset + n]; n++; val |= (b & 0x7F) << shift; shift += 7
    if ((b & 0x80) === 0) break
    if (n > 5) return { value: 0, bytesRead: 0 }
  }
  return { value: (val >>> 1) ^ -(val & 1), bytesRead: n }
}

module.exports = {
  name: 'StashFinder',
  description: 'Find hoppers, bookshelves, barrels, brewing stands, nether wart',

  onPlayer (player, relay) {
    player._stashEnabled = false; player._stashMap = new Map(); player._stashNotified = 0; player._stashChunks = 0

    player.on('serverbound', (data) => {
      if (data.name === 'player_auth_input' && data.params?.position) player._playerPos = data.params.position
    })

    player.on('clientbound', (data) => {
      if (data.name === 'start_game') { player._stashMap.clear(); player._stashNotified = 0; player._stashChunks = 0 }
      if (data.name === 'change_dimension' || data.name === 'transfer') { player._stashMap.clear(); player._stashNotified = 0; player._stashChunks = 0 }
      if (data.name === 'level_chunk' && data.params && player._stashEnabled) {
        const p = data.params
        if (p.payload && p.payload.length > 10) {
          player._stashChunks++
          const found = scanChunkForStorage(p.payload)
          if (found.length > 0) {
            let newCount = 0
            for (const f of found) {
              const key = `${f.x},${f.y},${f.z}`
              if (!player._stashMap.has(key)) {
                player._stashMap.set(key, f); newCount++
                if (player._stashMap.size > 2000) player._stashMap.delete(player._stashMap.keys().next().value)
              }
            }
            if (newCount > 0) {
              player._stashNotified++
              if (player._stashNotified <= 30 || player._stashNotified % 5 === 0) {
                const last = found[found.length - 1]
                sendMessage(player, `§d+${newCount} ${last.name} §7@ §f${last.x}, ${last.y}, ${last.z} §8(${player._stashMap.size} total)`)
              }
            }
          }
        }
      }
    })
  },

  onEnable (relay) {
    registerCommand('stashfinder', 'Find storage blocks (?stashfinder on/off/nearest/list/clear)', (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') { player._stashEnabled = true; player._stashMap.clear(); player._stashNotified = 0; player._stashChunks = 0; sendMessage(player, theme.toggle('StashFinder', true)) }
      else if (arg === 'off') { player._stashEnabled = false; sendMessage(player, theme.toggle('StashFinder', false)) }
      else if (arg === 'nearest') { showNearest(player) }
      else if (arg === 'list') { showList(player) }
      else if (arg === 'clear') { player._stashMap.clear(); player._stashNotified = 0; sendMessage(player, theme.line('StashFinder', '§7cleared')) }
      else if (arg === 'status') { sendMessage(player, theme.line('StashFinder', `§7chunks §f${player._stashChunks}§7 · storage §f${player._stashMap.size}`)) }
      else sendMessage(player, theme.line('StashFinder', '?stashfinder on/off/nearest/list/clear/status'))
    })
  }
}

function showNearest (player) {
  if (player._stashMap.size === 0) { sendMessage(player, theme.error('No storage found yet. Walk around with stashfinder on.')); return }
  const pos = player._playerPos || { x: 0, y: 0, z: 0 }
  const sorted = [...player._stashMap.values()].map(s => ({ ...s, dist: Math.sqrt((s.x-pos.x)**2 + (s.y-pos.y)**2 + (s.z-pos.z)**2) })).sort((a, b) => a.dist - b.dist).slice(0, 10)
  sendMessage(player, '§5§lNearest Storage:\n' + sorted.map(s => `§d${s.name} §7@ §f${s.x}, ${s.y}, ${s.z} §8(${Math.floor(s.dist)}m)`).join('\n'))
}

function showList (player) {
  if (player._stashMap.size === 0) { sendMessage(player, theme.error('No storage found yet.')); return }
  const counts = {}
  for (const [, s] of player._stashMap) counts[s.name] = (counts[s.name] || 0) + 1
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  sendMessage(player, '§5§lStashFinder:\n' + entries.map(([n, c]) => `  §d${n} §7× §f${c}`).join('\n'))
}