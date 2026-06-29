'use strict'

/**
 * Tracers — Lead/rope lines via fake foot-level entities.
 * 
 * For each enemy player, spawns a tiny invisible chicken at their feet,
 * leashes it to the local player. Chicken's leash anchor is at ground level
 * so the rope goes from their feet → your hand. Updates position each tick.
 *
 * ?tracers on / off / range <10-200>
 */

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { bindKaEntityTracking, kaEq, kaKey, isEspPlayerTarget, STILL_TICKS_MAX } = require('../core/ka-entities')
const { ESP_UPDATE_TICKS } = require('../core/perf')

const BASE_FAKE_RID = 1400000  // above playeresp (1300000)
const DEFAULT_RANGE = 80
const MAX_TARGETS   = 12
const UPDATE_TICKS  = ESP_UPDATE_TICKS

module.exports = {
  name: 'Tracers',
  description: 'Lead-rope tracers to enemy players (?tracers)',

  onPlayer (player, relay) {
    bindKaEntityTracking(player)
    if (player._tracersEnabled === undefined) player._tracersEnabled = false
    if (player._tracersRange   === undefined) player._tracersRange   = DEFAULT_RANGE
    player._tracersRid     = null
    player._tracersAnchors = new Map()  // targetRid (string) -> fakeChickenRid (BigInt)
    player._tracersNextRid = BASE_FAKE_RID
    player._tracersPos     = null
    player._tracersTick    = 0

    player.on('clientbound', (data) => {
      if (!data || !data.name) return

      if (data.name === 'start_game' && data.params) {
        player._tracersRid = data.params.runtime_entity_id
        clearAll(player)
        player._tracersNextRid = BASE_FAKE_RID
        return
      }

      if (data.name === 'respawn' || data.name === 'change_dimension' || data.name === 'transfer') {
        clearAll(player)
        player._tracersNextRid = BASE_FAKE_RID
        if (data.params?.runtime_entity_id) player._tracersRid = data.params.runtime_entity_id
        return
      }

      if (data.name === 'remove_entity' && data.params) {
        const rid = kaKey(data.params.entity_id_self ?? data.params.entity_id)
        if (rid && player._tracersAnchors.has(rid)) {
          despawnAnchor(player, player._tracersAnchors.get(rid))
          player._tracersAnchors.delete(rid)
        }
      }
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return
      player._tracersPos = data.params.position
      if (!player._tracersEnabled) return
      player._tracersTick++
      if (player._tracersTick % UPDATE_TICKS !== 0) return
      updateAnchors(player)
    })
  },

  onEnable () {
    registerCommand('tracers', 'Lead tracers (?tracers on/off/range)', (player, args) => {
      const a = (args[0] || '').toLowerCase()

      if (a === 'on') {
        player._tracersEnabled = true
        sendMessage(player, theme.toggle('Tracers', true, `— ${player._tracersRange}m`))

      } else if (a === 'off') {
        player._tracersEnabled = false
        clearAll(player)
        sendMessage(player, theme.toggle('Tracers', false))

      } else if (a === 'range') {
        const n = parseInt(args[1])
        if (n >= 10 && n <= 200) {
          player._tracersRange = n
          sendMessage(player, theme.line('Tracers', `§7range §f${n}m`))
        } else {
          sendMessage(player, theme.error('range 10-200'))
        }

      } else {
        sendMessage(player, theme.line('Tracers',
          `is ${theme.status(player._tracersEnabled)} §7· ${player._tracersRange}m · ${player._tracersAnchors.size} active`))
      }
    })
  }
}

// ─── Update loop ──────────────────────────────────────────────────────────

function updateAnchors (player) {
  const entities = player._kaEntities
  if (!entities || !player._tracersPos || !player._tracersRid) return

  const myRid = player._tracersRid
  const pos = player._tracersPos

  // Collect visible targets
  const targets = []
  for (const [rid, ent] of entities) {
    if (kaEq(rid, myRid)) continue
    if (!isEspPlayerTarget(ent, rid)) continue
    if (player._friends && player._friends.has(ent.name)) continue
    if (ent.removed || ent.stillTicks > STILL_TICKS_MAX) continue
    const dx = ent.x - pos.x
    const dy = ent.y - pos.y
    const dz = ent.z - pos.z
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
    if (dist > player._tracersRange || dist < 1) continue
    targets.push({ rid: String(rid), ent, dist })
  }

  targets.sort((a, b) => a.dist - b.dist)
  if (targets.length > MAX_TARGETS) targets.length = MAX_TARGETS

  const activeSet = new Set(targets.map(t => t.rid))

  // Remove anchors for players no longer in range
  for (const [targetRid, fakeRid] of player._tracersAnchors) {
    if (!activeSet.has(targetRid)) {
      despawnAnchor(player, fakeRid)
      player._tracersAnchors.delete(targetRid)
    }
  }

  // Spawn new / update existing anchors
  for (const t of targets) {
    const feetY = t.ent.y  // entity Y is already at feet in Bedrock

    if (!player._tracersAnchors.has(t.rid)) {
      // Spawn new anchor chicken at target feet
      const fakeRid = BigInt(player._tracersNextRid++)
      spawnAnchor(player, fakeRid, t.ent.x, feetY, t.ent.z)
      player._tracersAnchors.set(t.rid, fakeRid)
    } else {
      // Move existing anchor to updated position
      const fakeRid = player._tracersAnchors.get(t.rid)
      moveAnchor(player, fakeRid, t.ent.x, feetY, t.ent.z)
    }
  }
}

// ─── Fake anchor entity (tiny invisible chicken) ──────────────────────────

function spawnAnchor (player, fakeRid, x, y, z) {
  try {
    player.queue('add_entity', {
      unique_id:   -fakeRid,
      runtime_id:  fakeRid,
      entity_type: 'minecraft:chicken',
      position:    { x, y, z },
      velocity:    { x: 0, y: 0, z: 0 },
      pitch: 0, yaw: 0, head_yaw: 0, body_yaw: 0,
      attributes: [],
      metadata: [
        { key: 'flags', type: 'long', value: {
          no_ai: true,
          invisible: true,
          affected_by_gravity: false,
          has_collision: false,
          can_show_nametag: false,
          leashed: true
        }},
        { key: 'lead_holder_eid', type: 'long',  value: BigInt(player._tracersRid) },
        { key: 'scale',           type: 'float', value: 0.01 },
        { key: 'boundingbox_width',  type: 'float', value: 0.01 },
        { key: 'boundingbox_height', type: 'float', value: 0.01 }
      ],
      properties: { ints: [], floats: [] },
      links: []
    })
  } catch (e) {}
}

function moveAnchor (player, fakeRid, x, y, z) {
  try {
    player.queue('move_entity', {
      runtime_entity_id: fakeRid,
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0 },
      on_ground: true,
      teleport: true
    })
  } catch (e) {}
}

function despawnAnchor (player, fakeRid) {
  try { player.queue('remove_entity', { entity_id_self: -fakeRid }) } catch (e) {}
  try { player.queue('remove_entity', { entity_id_self: fakeRid }) } catch (e) {}
}

function clearAll (player) {
  for (const fakeRid of player._tracersAnchors.values()) {
    despawnAnchor(player, fakeRid)
  }
  player._tracersAnchors.clear()
}
