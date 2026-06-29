'use strict'

const InvUtil = require('../utils/invutil')
const { emptyItem, toAttackHeldItem, sanitizePacketParams } = require('./packet-compat')
const { isFlyModuleActive } = require('./tp-prep')
const { isTpBusy } = require('./combat-pause')
const { syncPlayerRids } = require('./player-rid')
const {
  buildPlayerAuthInput,
  buildMovePlayer,
  normalizeVarint64,
  nextTick,
  queueUpstreamAuth: protoQueueAuth,
  queueClientMovePlayer
} = require('./protocol')

const STILL_TICKS_MAX = 200

function kaKey (rid) {
  if (rid == null) return null
  return String(rid)
}

function kaEq (a, b) {
  return a != null && b != null && String(a) === String(b)
}

function isNpcMetadata (metadata) {
  if (!Array.isArray(metadata)) return false
  for (const m of metadata) {
    if (!m) continue
    if (m.key === 'flags' && m.value && m.value.no_ai === true) return true
    if (m.key === 'scale' && typeof m.value === 'number' && m.value !== 1) return true
  }
  return false
}

const MOB_TYPE_NAMES = new Set([
  'mob', 'entity', 'npc', 'player', 'armor_stand', 'item', 'xp_orb',
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'cow', 'pig', 'sheep',
  'chicken', 'horse', 'donkey', 'mule', 'villager', 'wandering_trader', 'enderman',
  'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'piglin', 'hoglin', 'wolf',
  'cat', 'ocelot', 'rabbit', 'squid', 'salmon', 'cod', 'tropical_fish',
  'pufferfish', 'dolphin', 'turtle', 'parrot', 'bee', 'fox', 'panda', 'polar_bear',
  'llama', 'trader_llama', 'iron_golem', 'snow_golem', 'bat', 'silverfish',
  'endermite', 'phantom', 'drowned', 'husk', 'stray', 'wither_skeleton',
  'piglin_brute', 'zombified_piglin', 'mooshroom', 'strider', 'goat', 'axolotl',
  'glow_squid', 'frog', 'tadpole', 'allay', 'camel', 'sniffer', 'armadillo',
  'bogged', 'breeze', 'warden', 'shulker', 'guardian', 'elder_guardian',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex'
])

function isMobTypeName (name) {
  if (!name) return false
  const n = String(name).replace(/§./g, '').trim().toLowerCase()
  if (!n) return false
  if (n.includes('minecraft:')) return true
  const base = n.split(':').pop()
  return MOB_TYPE_NAMES.has(base)
}

function hasDisplayName (ent) {
  if (!ent?.name) return false
  const n = ent.name
  if (n === 'player') return false
  if (n.includes('minecraft:') || (n.includes('_') && n.length > 20)) return false
  if (isMobTypeName(n)) return false
  return true
}

function stripMcText (s) {
  return String(s || '').replace(/§./g, '').trim()
}

/** HUD popup label — real gamertag only, never coords/rids/mob ids. */
function formatPopupTargetName (ent, fallback) {
  const raw = stripMcText(ent?.name || fallback)
  if (!raw) return 'enemy'
  const lower = raw.toLowerCase()
  if (lower === 'player' || lower.includes('coord') || isMobTypeName(raw)) return 'enemy'
  if (/^\d+$/.test(raw)) return 'enemy'
  if (/^-?\d+\s+-?\d+\s+-?\d+$/.test(raw)) return 'enemy'
  return raw
}

/** Real enemy player for ESP/tracers — not mobs, NPCs, or tab-list placeholders. */
function isEspPlayerTarget (ent, key) {
  if (!ent || ent.type !== 'player') return false
  if (key != null && String(key).startsWith('plist:')) return false
  if (ent.isNpc || ent.removed || ent.wasMob || ent.stale) return false
  return hasDisplayName(ent)
}

function findNearbyNamedPlayer (player, pos, maxDist = 1.5) {
  if (!pos || !player._kaEntities?.size) return null
  let best = null
  let bestD = maxDist
  for (const ent of player._kaEntities.values()) {
    if (ent.type !== 'player' || !hasDisplayName(ent) || ent.isNpc) continue
    const d = Math.hypot(ent.x - pos.x, ent.y - pos.y, ent.z - pos.z)
    if (d < bestD) {
      bestD = d
      best = ent
    }
  }
  return best
}

function pruneUnnamedNear (player, pos, keepKey, maxDist = 2) {
  if (!pos || !player._kaEntities?.size) return
  for (const [key, ent] of player._kaEntities) {
    if (key === keepKey || ent.type !== 'player' || hasDisplayName(ent)) continue
    const d = Math.hypot(ent.x - pos.x, ent.y - pos.y, ent.z - pos.z)
    if (d <= maxDist) player._kaEntities.delete(key)
  }
}

function promoteToPlayer (ent) {
  if (!ent || ent.type === 'player' || ent.type === 'mob' || ent.wasMob) return
  const name = (ent.name || '').toLowerCase()
  if (name.includes('armor_stand') || name.includes('item') || name.includes('xp_orb')) return
  if (isMobTypeName(name)) return
  ent.type = 'player'
}

function updateTrackedPlayer (ent, pos) {
  if (!ent || !pos) return
  ent.x = pos.x
  ent.y = pos.y
  ent.z = pos.z
  ent.stillTicks = 0
  ent.removed = false
  ent.stale = false
  promoteToPlayer(ent)
}

function resetKaEntityFreshness (player) {
  if (!player._kaEntities?.size) return
  for (const ent of player._kaEntities.values()) {
    if (ent.type !== 'player') continue
    ent.stillTicks = 0
    ent.removed = false
    ent.stale = false
  }
}

function markKaEntitiesStale (player) {
  if (!player._kaEntities?.size) return
  for (const ent of player._kaEntities.values()) {
    if (ent.type === 'player') ent.stale = true
  }
}

function seedKaPosFromPacket (player, pktOrPos) {
  const pos = pktOrPos?.position || pktOrPos
  if (!pos) return
  player._kaPos = { x: pos.x, y: pos.y, z: pos.z }
  player._killauraPos = { x: pos.x, y: pos.y, z: pos.z }
}

function removeTrackedEntity (player, rid) {
  const key = kaKey(rid)
  if (!key || !player._kaEntities) return false
  return player._kaEntities.delete(key)
}

function prunePlayersByName (player, name) {
  if (!name || !player._kaEntities?.size) return
  const tag = name.replace(/§./g, '').trim().toLowerCase()
  if (!tag) return
  for (const [key, ent] of player._kaEntities) {
    if (ent.type === 'player' && ent.name === tag) player._kaEntities.delete(key)
  }
}

function dropPlistPlaceholder (player, name) {
  if (!name || !player._kaEntities?.size) return
  const tag = name.toLowerCase()
  for (const [key, ent] of player._kaEntities) {
    if (key.startsWith('plist:') && ent.name === tag) player._kaEntities.delete(key)
  }
}

function trackPlayer (player, rid, pos, name, metadata, opts = {}) {
  const key = kaKey(rid)
  if (!key) return

  const rawName = (name || '').replace(/§./g, '').trim()
  const prev = player._kaEntities.get(key)
  const displayName = rawName
    ? rawName.toLowerCase()
    : (prev?.name || '')
  const confirmedPlayer = !!(
    prev?.confirmedPlayer ||
    rawName ||
    opts.confirmedPlayer
  )
  player._kaEntities.set(key, {
    x: pos?.x ?? prev?.x ?? 0,
    y: pos?.y ?? prev?.y ?? 0,
    z: pos?.z ?? prev?.z ?? 0,
    type: 'player',
    name: displayName,
    // NPC flags from metadata are applied in set_entity_data — avoid false positives on join.
    isNpc: prev?.isNpc || false,
    confirmedPlayer,
    wasMob: false,
    stillTicks: 0,
    removed: false,
    stale: !pos,
    runtimeId: rid
  })
  if (displayName) dropPlistPlaceholder(player, displayName)
  if (rawName && pos) pruneUnnamedNear(player, pos, key)
}

function trackOrMergePlayer (player, rid, pos) {
  const key = kaKey(rid)
  if (!key || !pos) return null
  let ent = player._kaEntities.get(key)
  if (ent) {
    updateTrackedPlayer(ent, pos)
    return ent
  }
  const near = findNearbyNamedPlayer(player, pos)
  if (near) {
    updateTrackedPlayer(near, pos)
    return near
  }
  trackPlayer(player, rid, pos, null, null)
  return player._kaEntities.get(key) || null
}

function trackMob (player, rid, pos, entityType) {
  const key = kaKey(rid)
  if (!key) return
  const t = String(entityType || 'mob')
  if (t.includes('armor_stand') || t.includes('item') || t.includes('xp_orb')) return
  const prev = player._kaEntities.get(key)
  player._kaEntities.set(key, {
    x: pos?.x ?? prev?.x ?? 0,
    y: pos?.y ?? prev?.y ?? 0,
    z: pos?.z ?? prev?.z ?? 0,
    type: 'mob',
    name: t.replace(/^minecraft:/, '').toLowerCase(),
    isNpc: false,
    confirmedPlayer: false,
    wasMob: true,
    stillTicks: 0,
    runtimeId: rid
  })
}

// bedrock-protocol decodes move_entity_delta x/y/z as absolute positions on Lifeboat.
function applyEntityDelta (ent, p) {
  if (!ent || !p) return
  if (p.x !== undefined) ent.x = p.x
  if (p.y !== undefined) ent.y = p.y
  if (p.z !== undefined) ent.z = p.z
  ent.stillTicks = 0
  ent.removed = false
  ent.stale = false
  promoteToPlayer(ent)
}

function deltaPosition (p) {
  if (!p) return null
  if (p.x === undefined && p.y === undefined && p.z === undefined) return null
  return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 }
}

function toEntityRid (rid) {
  if (rid == null) return null
  try {
    if (typeof rid === 'bigint') return rid
    return BigInt(String(rid).replace(/n$/i, ''))
  } catch (e) {
    return null
  }
}

function bindKaEntityTracking (player) {
  if (player._kaTrackBound) return
  player._kaTrackBound = true
  if (!player._kaEntities) player._kaEntities = new Map()

  player.on('serverbound', (data) => {
    if (data.name === 'mob_equipment' && data.params) {
      player._kaHeldItem = data.params.item
      return
    }
    if (data.name !== 'player_auth_input' || !data.params) return
    player._kaLastAuth = { ...data.params }
    if (data.params.position) {
      player._kaPos = data.params.position
      player._killauraPos = data.params.position
      player._kaRot = { pitch: data.params.pitch || 0, yaw: data.params.yaw || 0 }
      player._killauraRot = { pitch: data.params.pitch || 0, yaw: data.params.yaw || 0 }
    }
    tickKaStill(player)
  })

  player.on('clientbound', (data) => {
    if (!data?.name || !data.params) return
    const p = data.params

    if (data.name === 'start_game') {
      player._kaEntities.clear()
      syncPlayerRids(player, p.runtime_entity_id)
      return
    }

    if (data.name === 'respawn') {
      // Keep tracked players — Lifeboat does not re-send add_player on respawn.
      syncPlayerRids(player, p.runtime_entity_id)
      seedKaPosFromPacket(player, p.position)
      resetKaEntityFreshness(player)
      return
    }

    if (data.name === 'change_dimension' || data.name === 'transfer') {
      if (p.runtime_entity_id != null) syncPlayerRids(player, p.runtime_entity_id)
      seedKaPosFromPacket(player, p.position)
      // SM transfer / dimension hop — old coords are wrong until fresh move packets arrive.
      markKaEntitiesStale(player)
      return
    }

    if (data.name === 'add_player') {
      trackPlayer(player, p.runtime_id, p.position, p.username || p.name, p.metadata)
    }

    if (data.name === 'add_entity') {
      const et = p.entity_type || p.identifier || p.type || ''
      if (et === 'minecraft:player' || et === 'player') {
        trackPlayer(player, p.runtime_id, p.position, null, p.metadata, { confirmedPlayer: true })
      } else if (et) {
        trackMob(player, p.runtime_id, p.position, et)
      } else if (p.runtime_id != null) {
        trackMob(player, p.runtime_id, p.position, 'mob')
      }
    }

    if (data.name === 'mob_equipment') {
      const rid = p.runtime_entity_id
      const myRid = player._kaRid || player._kaRuntimeId
      if (myRid != null && kaEq(rid, myRid)) {
        player._kaHeldItem = p.item
      }
    }

    if (data.name === 'set_entity_data') {
      const ent = player._kaEntities.get(kaKey(p.runtime_entity_id))
      if (ent && ent.type === 'player' && p.metadata) {
        if (isNpcMetadata(p.metadata)) ent.isNpc = true
        for (const m of p.metadata) {
          if (m && m.key === 'scale' && typeof m.value === 'number' && m.value !== 1) {
            ent.isNpc = true
          }
          if (m && m.key === 'nametag' && typeof m.value === 'string' && m.value) {
            const tag = m.value.replace(/§./g, '').trim().toLowerCase()
            if (tag && !isMobTypeName(tag)) {
              ent.name = tag
              if (!ent.wasMob) ent.confirmedPlayer = true
            }
          }
        }
      }
    }

    if (data.name === 'move_player' && p.position) {
      const rid = p.runtime_id
      const myRid = player._kaRid || player._kaRuntimeId
      if (rid != null && !kaEq(rid, myRid)) trackOrMergePlayer(player, rid, p.position)
    }

    if (data.name === 'move_entity') {
      const rid = p.runtime_entity_id
      const myRid = player._kaRid || player._kaRuntimeId
      if (rid != null && !kaEq(rid, myRid) && p.position) {
        trackOrMergePlayer(player, rid, p.position)
      }
    }

    if (data.name === 'move_entity_delta') {
      const rid = p.runtime_entity_id
      const myRid = player._kaRid || player._kaRuntimeId
      if (rid != null && !kaEq(rid, myRid)) {
        const pos = deltaPosition(p)
        let ent = trackOrMergePlayer(player, rid, pos)
        if (!ent) ent = player._kaEntities.get(kaKey(rid))
        if (ent) applyEntityDelta(ent, p)
      }
    }

    if (data.name === 'player_list') {
      const type = p.type ?? p.records?.type
      const records = p.records?.records || p.records || []
      if (type === 'add' || type === 0) {
        for (const record of records) {
          if (!record?.username) continue
          const name = record.username.replace(/§./g, '').trim().toLowerCase()
          if (!name) continue
          let has = false
          for (const ent of player._kaEntities.values()) {
            if (ent.type === 'player' && ent.name === name) { has = true; break }
          }
          if (!has) {
            trackPlayer(player, `plist:${name}`, null, name, null)
          }
        }
      } else if (type === 'remove' || type === 1) {
        for (const record of records) {
          if (!record) continue
          prunePlayersByName(player, record.username || '')
        }
      }
    }

    if (data.name === 'remove_entity') {
      removeTrackedEntity(player, p.entity_id_self ?? p.entity_id)
    }
  })
}

function tickKaStill (player) {
  if (!player._kaEntities) return
  const now = Date.now()
  if (player._kaStillLast && now - player._kaStillLast < 100) return
  player._kaStillLast = now
  for (const ent of player._kaEntities.values()) {
    if (ent.type === 'player') ent.stillTicks++
  }
}

function isHurtEvent (params) {
  const e = params?.event_id
  return e === 'hurt_animation' || e === 2 || e === '2'
}

function targetBodyDistance (playerPos, ent) {
  if (!playerPos || !ent) return Infinity
  const dx = ent.x - playerPos.x
  const dy = (ent.y + 0.9) - (playerPos.y - 0.62)
  const dz = ent.z - playerPos.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function isValidTarget (player, rid, ent, myRid, maxRange, options = {}) {
  if (kaEq(rid, myRid)) return false
  const key = kaKey(rid)
  if (key && key.startsWith('plist:')) return false
  if (!ent || ent.type !== 'player') return false
  if (ent.wasMob && !ent.confirmedPlayer && !hasDisplayName(ent)) return false
  if (ent.removed) return false
  if (!options.skipStale && ent.stale) return false
  if (ent.isNpc) return false
  if (options.requireName && !hasDisplayName(ent)) return false
  if (player._friends && ent.name && player._friends.has(ent.name)) return false
  const pos = player._kaPos || player._killauraPos
  if (!pos) return false
  const dist = options.bodyDist
    ? targetBodyDistance(pos, ent)
    : Math.hypot(ent.x - pos.x, ent.y - pos.y, ent.z - pos.z)
  if (dist >= maxRange) return false
  return { dist, rid: kaKey(rid) }
}

function cloneAuthValue (v) {
  if (v == null || typeof v !== 'object') return v
  if (typeof v === 'bigint') return v
  if (Buffer.isBuffer(v)) return v
  if (Array.isArray(v)) return v.map(cloneAuthValue)
  const out = {}
  for (const k of Object.keys(v)) out[k] = cloneAuthValue(v[k])
  return out
}

function authPacketFromPlayer (player, pos, tick) {
  const rot = player._kaRot || player._killauraRot || { pitch: 0, yaw: 0 }
  const patch = {
    pitch: rot.pitch,
    yaw: rot.yaw,
    head_yaw: rot.yaw,
    position: { x: pos.x, y: pos.y, z: pos.z },
    move_vector: { x: 0, z: 0 },
    raw_move_vector: { x: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 },
    delta: { x: 0, y: 0, z: 0 }
  }
  if (tick != null) patch.tick = normalizeVarint64(tick)
  return buildPlayerAuthInput(player, patch)
}

/** Orion/Lifeboat burst auth — shallow clone of last client auth, tick=0 at spoofed pos. */
function buildBurstAuth (player, pos) {
  const rot = player._kaRot || player._killauraRot || { pitch: 0, yaw: 0 }
  const last = player._kaLastAuth
  if (last) {
    const {
      transaction, item_stack_request, item_use_transaction, block_action,
      ...safe
    } = last
    return {
      ...safe,
      pitch: rot.pitch,
      yaw: rot.yaw,
      head_yaw: rot.yaw,
      position: { x: pos.x, y: pos.y, z: pos.z },
      move_vector: { x: 0, z: 0 },
      raw_move_vector: { x: 0, z: 0 },
      analogue_move_vector: { x: 0, z: 0 },
      tick: 0n,
      delta: { x: 0, y: 0, z: 0 }
    }
  }
  return authPacketFromPlayer(player, pos, 0)
}

/** Orion/Silver burst auth — schema-safe via buildPlayerAuthInput (tick=0). */
function buildSilverBurstAuth (player, pos) {
  const rot = player._kaRot || player._killauraRot || { pitch: 0, yaw: 0 }
  return buildPlayerAuthInput(player, {
    pitch: rot.pitch,
    yaw: rot.yaw,
    head_yaw: rot.yaw,
    position: { x: pos.x, y: pos.y, z: pos.z },
    move_vector: { x: 0, z: 0 },
    raw_move_vector: { x: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 },
    delta: { x: 0, y: 0, z: 0 },
    tick: 0
  })
}

function beginAuraBurstTicks (player) {
  const last = player._kaLastAuth?.tick
  player._kaBurstNextTick = normalizeVarint64(last)
}

function allocBurstTick (player) {
  if (player._kaBurstNextTick == null) beginAuraBurstTicks(player)
  player._kaBurstNextTick = nextTick(player._kaBurstNextTick, 1)
  return player._kaBurstNextTick
}

function endAuraBurstTicks (player) {
  player._kaBurstNextTick = null
}

function silverBurstAuth (rot, pos) {
  return buildPlayerAuthInput(null, {
    pitch: rot.pitch,
    yaw: rot.yaw,
    head_yaw: rot.yaw,
    position: { x: pos.x, y: pos.y, z: pos.z },
    tick: 0
  })
}

function auraBurstRid (player) {
  return player._killauraRid || player._kaRid || player._kaRuntimeId
}

function burstAuthPacket (player, pos, options = {}) {
  const patch = { position: pos }
  if (options.crit) {
    patch.input_data = {
      start_falling: true,
      sprinting: true,
      sprint_down: false
    }
    patch.delta = { x: 0, y: -0.0784, z: 0 }
  }
  return buildPlayerAuthInput(player, patch)
}

function queueBurstAuthPair (player, pos, options = {}) {
  protoQueueAuth(player, burstAuthPacket(player, pos, options))
  player._disabler2AuthToggle = !player._disabler2AuthToggle
  const yAlt = player._disabler2AuthToggle ? 0.03 : 0
  protoQueueAuth(player, buildPlayerAuthInput(player, {
    position: { x: pos.x, y: pos.y + yAlt, z: pos.z },
    ...(options.crit ? {
      input_data: { start_falling: true, sprinting: true, sprint_down: false },
      delta: { x: 0, y: -0.0784, z: 0 }
    } : {})
  }))
}

/** Single upstream crit auth — no move_player, no auth pair (avoids movement lock). */
function queueCritAuthBurst (player, pos) {
  if (!player?.upstream || !pos) return false
  const rot = player._kaRot || player._killauraRot || {
    pitch: player._kaLastAuth?.pitch || 0,
    yaw: player._kaLastAuth?.yaw || 0
  }
  try {
    protoQueueAuth(player, buildPlayerAuthInput(player, {
      position: { x: pos.x, y: pos.y, z: pos.z },
      pitch: rot.pitch,
      yaw: rot.yaw,
      head_yaw: rot.yaw,
      input_data: { start_falling: true, sprinting: true, sprint_down: false },
      delta: { x: 0, y: -0.0784, z: 0 },
      move_vector: { x: 0, z: 0 },
      raw_move_vector: { x: 0, z: 0 },
      analogue_move_vector: { x: 0, z: 0 },
      tick: 0
    }))
    return true
  } catch (e) {
    return false
  }
}

/** Upstream-only snap — move_player + auth pair. Client auth is never modified. */
function sendAuraBurstPos (player, pos, options = {}) {
  const myRid = options.rid != null ? options.rid : auraBurstRid(player)
  if (!player.upstream || myRid == null || !pos) return false

  const rot = player._kaRot || player._killauraRot || { pitch: 0, yaw: 0 }
  const flying = isFlyModuleActive(player)
  const onGround = options.onGround !== undefined
    ? options.onGround
    : (options.crit ? false : !flying)
  const yLift = { x: pos.x, y: pos.y + 0.1, z: pos.z }

  try {
    player.upstream.queue('move_player', buildMovePlayer({
      runtime_id: Number(myRid),
      position: yLift,
      pitch: rot.pitch,
      yaw: rot.yaw,
      head_yaw: rot.yaw,
      mode: 'teleport',
      on_ground: onGround,
      tick: 0
    }))
  } catch (e) {}

  if (options.orion) {
    const authBase = buildBurstAuth(player, pos)
    const authLift = { ...authBase, position: yLift }
    try { player.upstream.queue('player_auth_input', authBase) } catch (e) {}
    try { player.upstream.queue('player_auth_input', authLift) } catch (e) {}
  } else if (options.silver) {
    const authBase = buildSilverBurstAuth(player, pos)
    const authLift = buildSilverBurstAuth(player, yLift)
    try { player.upstream.queue('player_auth_input', authBase) } catch (e) {}
    try { player.upstream.queue('player_auth_input', authLift) } catch (e) {}
  } else if (options.auth || options.dualAuth) {
    queueBurstAuthPair(player, pos, options)
  }
  return true
}

/** Cap burst steps so long-range hits don't flood auth/move packets (Lifeboat kicks). */
function planAuraBurstSteps (dist, stepDist = 3, maxSteps = 8) {
  const raw = Math.max(1, Math.floor(dist / stepDist))
  if (raw <= maxSteps) return { steps: raw, stepDist }
  return { steps: maxSteps, stepDist: Math.max(stepDist, dist / maxSteps) }
}

function snapAuraLive (player, rid, live, start) {
  if (!live || rid == null) return
  if (start &&
      live.x === start.x && live.y === start.y && live.z === start.z) {
    return
  }
  sendAuraBurstPos(player, live)
  const rot = player._killauraRot || player._kaRot || { pitch: 0, yaw: 0 }
  const onGround = !isFlyModuleActive(player)
  queueClientMovePlayer(player, {
    runtime_id: Number(rid),
    position: { x: live.x, y: live.y, z: live.z },
    pitch: rot.pitch,
    yaw: rot.yaw,
    head_yaw: rot.yaw,
    mode: 'teleport',
    on_ground: onGround,
    tick: 0
  })
}

function notifyAuraAttack (player, targetRid, playerPos, clickPos) {
  const key = kaKey(targetRid)
  if (!key) return
  const ent = player._kaEntities ? player._kaEntities.get(key) : null
  try {
    player.emit('aura_attack', { targetRid: key, ent, playerPos, clickPos })
  } catch (e) {}
}

function hotbarSlotOfItem (player, item) {
  if (!item?.network_id) return -1
  const hotbar = InvUtil.getHotbar(player)
  const id = item.network_id
  for (let i = 0; i < 9 && i < hotbar.length; i++) {
    const it = hotbar[i]
    if (it && it.network_id === id) return i
  }
  return -1
}

function syncHeldSlot (player, slot, item) {
  if (slot < 0 || slot > 8) return
  if (InvUtil.getSelectedSlot(player) !== slot) {
    InvUtil.switchTo(player, slot)
  }
  if (item?.network_id) player._kaHeldItem = item
}

function resolveAttackItem (player) {
  try {
    InvUtil.setup(player)
    const selected = InvUtil.getSelectedSlot(player)
    const equipped = player._kaHeldItem

    if (equipped?.network_id) {
      const slot = hotbarSlotOfItem(player, equipped)
      const useSlot = slot >= 0 ? slot : selected
      syncHeldSlot(player, useSlot, equipped)
      return { slot: useSlot, held: toAttackHeldItem(equipped) }
    }

    const selectedItem = InvUtil.getItem(player, selected)
    if (selectedItem?.network_id) {
      syncHeldSlot(player, selected, selectedItem)
      return { slot: selected, held: toAttackHeldItem(selectedItem) }
    }

    const fallback = InvUtil.findItemInHotbar(player, (it) => it && it.network_id > 0)
    if (fallback >= 0) {
      const item = InvUtil.getItem(player, fallback)
      syncHeldSlot(player, fallback, item)
      return { slot: fallback, held: toAttackHeldItem(item) }
    }

    return { slot: selected, held: emptyItem() }
  } catch (e) {
    return { slot: 0, held: emptyItem() }
  }
}

function queueEntityAttack (player, targetRid, playerPos, clickPos, options = {}) {
  if (!player.upstream || targetRid == null) return false
  const entRid = toEntityRid(targetRid)
  if (entRid == null) return false
  const pos = playerPos || player._kaPos || player._killauraPos || { x: 0, y: 0, z: 0 }
  const click = clickPos ?? { x: 0, y: 0, z: 0 }
  const useHeld = options.useHeld !== false
  const resolved = useHeld ? resolveAttackItem(player) : { slot: 0, held: emptyItem() }
  const slot = resolved.slot
  const held = resolved.held
  const pkt = sanitizePacketParams({
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: entRid,
        action_type: 'attack',
        hotbar_slot: slot,
        held_item: held,
        player_pos: { x: pos.x, y: pos.y, z: pos.z },
        click_pos: { x: click.x, y: click.y, z: click.z }
      }
    }
  })
  try {
    player.upstream.queue('inventory_transaction', pkt)
    queueSwingAnimation(player)
    notifyAuraAttack(player, targetRid, pos, click)
    return true
  } catch (e) {
    return false
  }
}

function queueSwingAnimation (player) {
  if (!player) return
  const rid = toEntityRid(
    player._killauraRid || player._kaRid || player._kaRuntimeId || player._runtimeId
  )
  if (rid == null) return
  const pkt = {
    action_id: 'swing_arm',
    runtime_entity_id: rid,
    data: 0,
    has_swing_source: false
  }
  try { player.queue('animate', pkt) } catch (e) {}
  try { if (player.upstream) player.upstream.queue('animate', pkt) } catch (e) {}
}

function queueMeleeAttack (player, targetRid, targetEnt, playerPos) {
  const pos = playerPos || player._kaPos || player._killauraPos
  if (!pos) return false
  const rid = targetEnt?.runtimeId ?? targetRid
  const click = targetEnt
    ? {
        x: targetEnt.x - pos.x,
        y: (targetEnt.y + 0.9) - pos.y,
        z: targetEnt.z - pos.z
      }
    : { x: 0, y: 0, z: 0 }
  return queueEntityAttack(player, rid, pos, click, { useHeld: true })
}

/** Melee uses real pos; beyond ~3.5m spoof player_pos at target (no TP) — Lifeboat reach AC. */
function queueSilentReachAttack (player, targetRid, targetEnt, realPos, dist, meleeRange = 3.5) {
  if (!targetEnt || dist == null || dist <= meleeRange) {
    return queueMeleeAttack(player, targetRid, targetEnt, realPos)
  }
  const rid = targetEnt.runtimeId ?? targetRid
  const atkPos = { x: targetEnt.x, y: targetEnt.y, z: targetEnt.z }
  const click = { x: targetEnt.x, y: targetEnt.y + 0.9, z: targetEnt.z }
  return queueEntityAttack(player, rid, atkPos, click, { useHeld: true })
}

module.exports = {
  STILL_TICKS_MAX,
  kaKey,
  kaEq,
  toEntityRid,
  hasDisplayName,
  formatPopupTargetName,
  isEspPlayerTarget,
  isMobTypeName,
  removeTrackedEntity,
  prunePlayersByName,
  resetKaEntityFreshness,
  markKaEntitiesStale,
  seedKaPosFromPacket,
  trackMob,
  applyEntityDelta,
  bindKaEntityTracking,
  tickKaStill,
  isHurtEvent,
  targetBodyDistance,
  isValidTarget,
  authPacketFromPlayer,
  buildBurstAuth,
  buildSilverBurstAuth,
  beginAuraBurstTicks,
  allocBurstTick,
  endAuraBurstTicks,
  sendAuraBurstPos,
  planAuraBurstSteps,
  snapAuraLive,
  queueEntityAttack,
  queueMeleeAttack,
  queueSilentReachAttack,
  queueSwingAnimation,
  queueCritAuthBurst,
  notifyAuraAttack
}