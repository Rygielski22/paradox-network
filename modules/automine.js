'use strict'

/**
 * AutoMine — scans chunks for ores, flies to clusters, breaks them, repeats.
 *
 * Break sequence (confirmed from saber-packets.log capture):
 *   Breaks ride on the serverbound `player_auth_input` packet via its
 *   `block_action` array (gated by input_data.block_action = true):
 *     tick 0:       [start_break, crack_break]
 *     ticks 1..N-1: [crack_break]      one per tick while breaking
 *     final tick:   [predict_break]    tells server we expect it broken
 *   Server confirms with update_block(air) at the position.
 *
 * ?automine on/off/stop/filter <type>/list [type]/status/clear
 */

const path = require('path')
const fs = require('fs')
const nbt = require('prismarine-nbt')
const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { instantFlight } = require('../core/instant-tp')
const { normalizeItemNew } = require('../core/packet-compat')
const { prepareInstantTp } = require('../core/tp-prep')

// ─── Block palette ────────────────────────────────────────────────────────
let RUNTIME_ID_TO_NAME = null
let NAME_TO_RUNTIME_ID = null
try {
  RUNTIME_ID_TO_NAME = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'block-palette.json'), 'utf8'))
  if (!Array.isArray(RUNTIME_ID_TO_NAME)) RUNTIME_ID_TO_NAME = null
  if (RUNTIME_ID_TO_NAME) {
    NAME_TO_RUNTIME_ID = new Map()
    for (let i = 0; i < RUNTIME_ID_TO_NAME.length; i++) {
      const n = RUNTIME_ID_TO_NAME[i]
      if (n && !NAME_TO_RUNTIME_ID.has(n)) NAME_TO_RUNTIME_ID.set(n, i)
    }
  }
} catch (e) { console.error('[AutoMine] block-palette.json missing:', e.message) }

const ORE_NAMES = new Set([
  'minecraft:coal_ore', 'minecraft:iron_ore', 'minecraft:gold_ore', 'minecraft:diamond_ore',
  'minecraft:emerald_ore', 'minecraft:lapis_ore', 'minecraft:redstone_ore', 'minecraft:lit_redstone_ore',
  'minecraft:copper_ore', 'minecraft:deepslate_coal_ore', 'minecraft:deepslate_iron_ore',
  'minecraft:deepslate_gold_ore', 'minecraft:deepslate_diamond_ore', 'minecraft:deepslate_emerald_ore',
  'minecraft:deepslate_lapis_ore', 'minecraft:deepslate_redstone_ore', 'minecraft:lit_deepslate_redstone_ore',
  'minecraft:deepslate_copper_ore', 'minecraft:nether_gold_ore', 'minecraft:quartz_ore', 'minecraft:ancient_debris'
])

const AIR_RUNTIME_ID = 13094

// Blocks we refuse to fly through / land in.
const LAVA_NAMES = new Set([
  'minecraft:lava', 'minecraft:flowing_lava'
])

// ─── Constants ────────────────────────────────────────────────────────────
const FLY_SPEED      = 9      // blocks per tick (gradual flight, proven no-desync)
const ARRIVE_DIST    = 1.5
const CLUSTER_RADIUS = 8      // group ores within 8 blocks of seed (keep veins whole)
const TARGET_Y_OFF   = 0      // feet in the anchor ore (head/feet clear frees us)
const MINE_REACH     = 24     // max distance to attempt a break (covers full vein)
const MINE_TIMEOUT   = 20000  // ms to give up on a block if not confirmed (barehand ore is slow)
const MINE_GAP       = 30     // ms between blocks (haste makes break itself instant)
const TICK_MS        = 50     // 20 tps
const MINE_FALLBACK  = 1500   // fallback break duration if server doesn't send ticks
const MIN_ORE_Y      = 7      // ignore ores at Y 6 and below (lava/bedrock zone)

module.exports = {
  name: 'AutoMine',
  description: 'TP to ore clusters and auto-break them',

  onPlayer (player, relay) {
    if (player._automineEnabled === undefined) player._automineEnabled = false

    player._oreMap     = new Map()
    player._amLavaMap  = new Map()
    player._amRid      = null
    player._amPos      = null
    player._amPhase    = 'idle'   // idle | flying | mining
    player._amTarget   = null
    player._amPath     = null
    player._amVerifyAt = 0
    player._amVerifyTries = 0
    player._amRepositioning = false
    player._amCluster  = []
    player._amFilter   = null
    player._amNextAt   = 0
    player._amTpDelay = 500
    player._autoLogEnabled = false
    player._amActiveDrops = new Map()
    player._autoLogThreshold = 5 // Default: Disconnect at 5 health or less

    // Mining state
    player._amQueue       = []
    player._amCurrent     = null
    player._amBrokenSpots = []     // ore positions we confirmed broken this cluster
    player._amPickupQueue = []     // remaining waypoints for the pickup pass
    player._amPickupTarget = null
    player._amSentAt      = 0
    player._amBreakMs     = MINE_FALLBACK  // set from server block_start_break
    player._amConfirmed   = false
    player._amPredicted   = false
    player._amServerAck   = false
    player._amStopped     = false
    player._amStartedAt   = 0
    player._amHeldItem    = { network_id: 0 }
    player._amHotbarSlot  = 0
    player._amHotbarItems = []
    player._amPickaxeIds  = new Set()

    // ── clientbound ────────────────────────────────────────────────────────
    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._amRid = data.params.runtime_entity_id
        player._oreMap.clear()
        player._amLavaMap.clear()
        player._amPhase = 'idle'; player._amTarget = null; player._amCluster = []
        // Build pickaxe item-id set from this session's item palette so we can
        // auto-switch to a pickaxe before mining (server destroy-rate needs a tool).
        try {
          const states = data.params.itemstates || []
          player._amPickaxeIds = new Set()
          for (const it of states) {
            const nm = (it && (it.name || it.name_string || '')) + ''
            if (nm.includes('_pickaxe')) {
              const id = (it.runtime_id !== undefined) ? it.runtime_id : it.id
              if (typeof id === 'number') player._amPickaxeIds.add(id)
            }
          }
          console.log('[AutoMine] pickaxe ids tracked: ' + player._amPickaxeIds.size)
        } catch (e) { player._amPickaxeIds = new Set() }
        return
      }
      if (data.name === 'change_dimension' || data.name === 'transfer') {
        player._oreMap.clear(); player._amLavaMap.clear(); cancelMine(player); return
      }

      if (data.name === 'set_health' && data.params && player._autoLogEnabled) {
        const health = data.params.health
        if (health <= player._autoLogThreshold) {
          console.log(`[AutoLog] Health ${health} <= threshold ${player._autoLogThreshold}. Disconnecting...`)
          // Force disconnect: This sends a disconnect packet to the client
          // and terminates the connection to the server.
          try { player.end('AutoLog: Low health triggered.') } catch (e) {}
        }
      }

      if (data.name === 'add_item_entity' && data.params) {
        const p = data.params.position
        const entityId = data.params.runtime_entity_id
        const itemStack = data.params.item
        // Filter for specific items using known network IDs.
        // 335: Diamond, 15: Iron, 446: Lapis, 405: Redstone, 333: Coal, 14: Gold
        const targetIds = new Set([335, 15, 446, 405, 333, 14])
        if (itemStack && targetIds.has(itemStack.network_id)) {
          if (p) {
            player._amActiveDrops.set(String(entityId), { x: p.x, y: p.y, z: p.z })
            console.log(`[AutoMine] Drop detected: Network ID ${itemStack.network_id} at ${p.x}, ${p.y}, ${p.z}`)
          }
        }
      }
      if (data.name === 'take_item_entity' && data.params) {
        const entityId = data.params.runtime_entity_id
        // Remove it from tracking once picked up (either by us or someone else)
        player._amActiveDrops.delete(String(entityId))
      }

      // Block corrections during flight + verify (verify was leaking
      // server move_player updates which caused the visible ore-to-ore TP
      // jitter while the player was settling).
      if (player._amPhase === 'flying' || player._amPhase === 'verify') {
        if (data.name === 'move_player' || data.name === 'correct_player_movement') {
          if (data.name === 'move_player' && data.params?.position && player._amPos) {
            const p = data.params.position
            if (Math.abs(p.x - player._amPos.x) > 200 || Math.abs(p.y - player._amPos.y) > 200 || Math.abs(p.z - player._amPos.z) > 200) {
              cancelMine(player); sendMessage(player, theme.toggle('AutoMine', false) + ' (server teleport)'); return
            }
          }
          des.canceled = true
        }
      }

      // Server tells us how long a break will take. It re-sends block_start_break
      // every tick with a fluctuating speed value; only trust the FIRST one per
      // block, otherwise a later tiny value resets our timer and predict never fires.
      if (data.name === 'level_event' && data.params) {
        const ev = data.params.event
        const pos = data.params.position
        const cur = player._amCurrent
        if (pos && cur && cur.x === Math.floor(pos.x) && cur.y === Math.floor(pos.y) && cur.z === Math.floor(pos.z)) {
          if (ev === 'block_start_break' && !player._amServerAck) {
            player._amServerAck = true
            const speed = Number(data.params.data) || 0
            if (speed > 0) {
              const ticks = 65535 / speed
              player._amBreakMs = Math.max(50, Math.min(ticks * TICK_MS, 30000))
              console.log(`[AutoMine] server speed=${speed} → ${ticks.toFixed(1)} ticks = ${Math.round(player._amBreakMs)}ms for ${cur.name}`)
            }
          }
          // particle_destroy at our target = block actually broke. Only accept
          // it once we've sent stop_break (otherwise early particles during
          // cracking would falsely confirm).
          if (ev === 'particle_destroy' && player._amStopped) {
            player._amConfirmed = true
            player._oreMap.delete(`${cur.x},${cur.y},${cur.z}`)
            console.log(`[AutoMine] ✓ confirmed via particle_destroy @ ${cur.x},${cur.y},${cur.z}`)
          }
        }
      }

      // Block confirmed broken. The server fires update_block at our target
      // MANY times during a break (neighbor updates, re-asserting the ore rid),
      // so we must NOT confirm on early updates. Only confirm AFTER we've sent
      // stop_break (break duration elapsed) — then the next block change at the
      // target is the real break. This avoids the false-confirm-at-100ms bug.
      //
      // SECONDARY USE: when ANY tracked ore turns into a non-ore block (other
      // player mined it, lava flowed, etc.) prune it from the map so we don't
      // keep targeting stone where a diamond used to be.
      if (data.name === 'update_block' && data.params) {
        const pos = data.params.position
        const cur = player._amCurrent
        const rid = data.params.block_runtime_id
        if (pos) {
          const k = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
          // Active mining confirm.
          if (cur && player._amStopped &&
              cur.x === Math.floor(pos.x) && cur.y === Math.floor(pos.y) && cur.z === Math.floor(pos.z) &&
              rid !== cur.rid) {
            player._amConfirmed = true
            player._oreMap.delete(k)
            console.log(`[AutoMine] ✓ confirmed (rid=${rid}) @ ${pos.x},${pos.y},${pos.z}`)
          }
          // Passive prune — any tracked ore whose rid changed is no longer that ore.
          const tracked = player._oreMap.get(k)
          if (tracked && rid != null && rid !== tracked.rid) {
            player._oreMap.delete(k)
          }
        }
      }

      // Death / respawn
      if (data.name === 'entity_event' && data.params && player._amRid) {
        if (data.params.event_id === 'death_smoke_cloud' && String(data.params.runtime_entity_id) === String(player._amRid)) {
          player._automineEnabled = false; cancelMine(player); sendMessage(player, theme.toggle('AutoMine', false) + ' (death)')
        }
      }
      if (data.name === 'set_health' && data.params?.health <= 0 && player._automineEnabled) {
        player._automineEnabled = false; cancelMine(player); sendMessage(player, theme.toggle('AutoMine', false) + ' (death)')
      }
      if (data.name === 'respawn' && player._automineEnabled) {
        player._automineEnabled = false; cancelMine(player); sendMessage(player, theme.toggle('AutoMine', false) + ' (respawn)')
      }

      // Track held item
      if (data.name === 'mob_equipment' && data.params && player._amRid && String(data.params.runtime_entity_id) === String(player._amRid)) {
        if (data.params.item) player._amHeldItem = data.params.item
        if (typeof data.params.hotbar_slot === 'number') player._amHotbarSlot = data.params.hotbar_slot
      }
      if (data.name === 'player_hotbar' && typeof data.params?.selected_hotbar_slot === 'number') {
        player._amHotbarSlot = data.params.selected_hotbar_slot
      }

      // Track hotbar contents so we can find a pickaxe slot to switch to.
      // inventory_content for the player inventory window holds all 36 slots
      // (0-8 are the hotbar). We only need the hotbar slots.
      if (data.name === 'inventory_content' && data.params && Array.isArray(data.params.input)) {
        const wid = data.params.window_id
        if (wid === 0 || wid === 'inventory') {
          player._amHotbarItems = data.params.input.slice(0, 9)
        }
      }
      if (data.name === 'inventory_slot' && data.params && (data.params.window_id === 0 || data.params.window_id === 'inventory')) {
        const slot = data.params.slot
        if (typeof slot === 'number' && slot < 9) {
          if (!player._amHotbarItems) player._amHotbarItems = []
          player._amHotbarItems[slot] = data.params.item
        }
      }

      // Scan chunks
      if (player._automineEnabled && data.name === 'level_chunk' && data.params) {
        try {
          if (data.params.payload && data.params.sub_chunk_count > 0) {
            const found = scanChunkForOres(data.params)
            for (const ore of found.ores) {
              const key = `${ore.x},${ore.y},${ore.z}`
              if (!player._oreMap.has(key)) {
                player._oreMap.set(key, ore)
                if (player._oreMap.size > 5000) player._oreMap.delete(player._oreMap.keys().next().value)
              }
            }
            for (const lk of found.lava) {
              player._amLavaMap.set(lk, true)
              if (player._amLavaMap.size > 20000) player._amLavaMap.delete(player._amLavaMap.keys().next().value)
            }
          }
        } catch (e) {}
      }
    })


    // ── serverbound ────────────────────────────────────────────────────────
    player.on('serverbound', (data) => {
      // Track held item from outbound too
      if (data.name === 'mob_equipment' && data.params) {
        if (data.params.item) player._amHeldItem = data.params.item
        if (typeof data.params.hotbar_slot === 'number') player._amHotbarSlot = data.params.hotbar_slot
      }

      if (data.name !== 'player_auth_input' || !data.params?.position) return
      player._amPos = data.params.position

      // Internal timerbypass — when automine is on, ALWAYS run server clock
      // at 3x. Faster TPs (pairs with the 9-block-step instant-tp), faster
      // block-break server timers, faster everything. Self-contained so it
      // works even without the standalone .timerbypass module enabled.
      if (player._automineEnabled) {
        if (player._amVirtualTicks == null) player._amVirtualTicks = data.params.ticks_alive || 0
        if (Math.abs(player._amVirtualTicks - (data.params.ticks_alive || 0)) > 5000 &&
            player._amVirtualTicks < (data.params.ticks_alive || 0)) {
          player._amVirtualTicks = data.params.ticks_alive || 0
        }
        player._amVirtualTicks += 3
        data.params.ticks_alive = Math.floor(player._amVirtualTicks)
      }

      // Auto-pick next cluster when idle
      if (player._automineEnabled && player._amPhase === 'idle' && Date.now() >= player._amNextAt) {
        if (player._oreMap.size > 0) startNextCluster(player)
      }

      // Flight phase — Dani's stepFlight: burst the WHOLE path to the target in
      // a single tick via upstream.write() 3-block hops (no per-tick cap).
      if (player._amPhase === 'flying' && player._amTarget && player._amRid) {
        const arrived = instantFlight(player, data.params, player._amTarget, player._amRid, { arriveDistance: 1.5, tickZero: true })
        if (!arrived) return
        // No settle delay — break the block we landed on instantly. The
        // anchor sanity check in verify phase still runs, and instant-tp
        // already requested the chunk for our destination, so by the time
        // we hit verify next tick the area is loaded. If it isn't, the
        // anchor check bails to a fresh cluster instead of mining stone.
        player._amPhase = 'verify'
        player._amVerifyAt = Date.now() + (player._amTpDelay || 0)
        return
      }

      // Verify phase — short settle window then anchor sanity check. If the
      // anchor ore got pruned (chunk update overwrote it, someone else mined
      // it, lava flowed in, whatever), bail and pick a fresh cluster instead
      // of mining stone where the diamond used to be.
      if (player._amPhase === 'verify' && player._amTarget && player._amRid) {
        if (Date.now() < player._amVerifyAt) return
        const dest = player._amTarget
        const anc = player._amAnchor
        if (anc && !player._oreMap.has(`${anc.x},${anc.y},${anc.z}`)) {
          console.log(`[AutoMine] anchor gone @ ${anc.x},${anc.y},${anc.z} — picking new cluster`)
          player._amPhase = 'idle'
          player._amTarget = null
          player._amCluster = []
          player._amAnchor = null
          player._amRepositioning = false
          player._amNextAt = Date.now() + 200
          return
        }
        player._amVerifyTries = 0
        {
          // If we flew here mid-vein just to get in reach, don't rebuild the
          // queue — re-anchor and resume mining the remaining ores.
          if (player._amRepositioning) {
            player._amRepositioning = false
            player._amMineAnchor = { x: dest.x, y: dest.y, z: dest.z }
            player._amCurrent = null
            player._amConfirmed = false
            player._amPhase = 'mining'
            player._amNextAt = Date.now()
            console.log(`[AutoMine] repositioned, resuming queue=${player._amQueue.length}`)
            return
          }
          // Order ore queue by distance to the player's landing spot (nearest
          // first) so we always mine the closest reachable ore next.
          const cluster = player._amCluster
          const here = data.params.position || dest
          player._amQueue = [...cluster].sort((a, b) => sqDist(a, here) - sqDist(b, here))
          player._amCurrent = null; player._amBreakMs = MINE_FALLBACK; player._amConfirmed = false
          player._amPhase = 'mining'
          player._amMineAnchor = { x: dest.x, y: dest.y, z: dest.z }
          player._amBlocksMined = 0
          player._amBrokenSpots = []

          // Priority order in front of the ore queue:
          //   1. HEAD block (eye level) — clears suffocation FIRST so we
          //      stop taking damage while the rest mines
          //   2. FEET block — frees the floor we landed on
          // then the nearest-first ore queue follows.
          const hx = Math.floor(dest.x), hz = Math.floor(dest.z)
          const hy = Math.floor(dest.y)
          const clearBlocks = [
            { x: hx, y: hy + 1, z: hz, name: 'clear:head', face: 1 },
            { x: hx, y: hy,     z: hz, name: 'clear:feet', face: 1 }
          ]
          player._amQueue = [...clearBlocks, ...player._amQueue]

          console.log(`[AutoMine] entered mining, queue=${player._amQueue.length}, pos=${Math.floor(dest.x)},${Math.floor(dest.y)},${Math.floor(dest.z)}`)
          sendMessage(player, theme.line('AutoMine', `§7mining §f${cluster.length}§7 ore${cluster.length === 1 ? '' : 's'}`))
        }
        return
      }

      // Pickup phase — fly through each broken-ore spot (gradual flight, same
      // proven no-desync method) so dropped items get collected, THEN go idle
      // and pick the next cluster.
      if (player._amPhase === 'pickup' && player._amRid) {
        if (!player._amPickupTarget) {
          if (player._amPickupQueue.length === 0) {
            player._amPhase = 'idle'
            player._amTarget = null
            player._amCluster = []
            player._amNextAt = Date.now() + 800
            console.log('[AutoMine] pickup done, looking for next...')
            return
          }
          player._amPickupTarget = player._amPickupQueue.shift()
        }
        const t = player._amPickupTarget
        // tickZero: every sub-packet has tick=0 → server sees zero elapsed
        // per hop → no movement-cheat kicks during rapid pickup hops.
        const reached = instantFlight(player, data.params, t, player._amRid, { arriveDistance: 1.5, tickZero: true })
        if (reached) player._amPickupTarget = null  // advance to next spot
        return
      }

      // Mining phase — inject block_action array into the live player_auth_input.
      // Confirmed from saber capture: breaks ride on player_auth_input via the
      // `block_action` field (plain array), gated by input_data.block_action=true.
      // IMPORTANT: merge with any actions the real client already put there
      // (so the player's own manual mining isn't clobbered → no desync).
      if (player._amPhase === 'mining' && player._amRid) {
        const actions = runMiningTick(player, data.params)
        if (actions && actions.length) {
          const cur = player._amCurrent
          // Aim the player at the block being broken. Server raycasts from the
          // crosshair to validate the break, so pitch/yaw MUST point at it.
          if (cur && data.params.position) {
            const look = lookAt(data.params.position, { x: cur.x, y: cur.y, z: cur.z })
            // 1. Force the server to see you looking at the block.
            data.params.pitch = look.pitch
            data.params.yaw = look.yaw
            data.params.head_yaw = look.yaw
            // 2. Force the local client to rotate the camera by snapping
            // move_player downstream. Once per new target only — we key on
            // the block coords so we don't spam every tick.
            const camKey = `${cur.x},${cur.y},${cur.z}`
            if (player._amCamKey !== camKey) {
              player._amCamKey = camKey
              try {
                player.queue('move_player', {
                  runtime_id: Number(player._amRid),
                  position: { x: data.params.position.x, y: data.params.position.y, z: data.params.position.z },
                  pitch: look.pitch,
                  yaw: look.yaw,
                  head_yaw: look.yaw,
                  mode: 'teleport',
                  on_ground: true,
                  ridden_runtime_id: 0,
                  teleport: { cause: 'unknown', source_entity_type: 0 },
                  tick: 0n
                })
              } catch (e) {}
            }
          }
          const existing = (data.params.input_data && data.params.input_data.block_action && Array.isArray(data.params.block_action))
            ? data.params.block_action
            : []
          if (data.params.input_data && typeof data.params.input_data === 'object') {
            data.params.input_data.block_action = true
            data.params.input_data.block_breaking_delay_enabled = true
          }
          data.params.block_action = [...existing, ...actions]

          // ALSO fire the standalone player_action packet in parallel. Some
          // servers only honor block breaks through this packet, not the
          // auth_input block_action array. Map our action names to the
          // PlayerActionType enum (start_break / abort_break / crack_break /
          // predict_break all exist there too).
          for (const act of actions) {
            sendPlayerAction(player, act.action, act.position, act.face)
          }

          const a = actions[actions.length - 1]
          console.log(`[AutoMine] block_action x${actions.length}: ${a.action} @ ${a.position?.x},${a.position?.y},${a.position?.z}`)
        }
      }
    })
  },

  onEnable (relay) {
    registerCommand('automine', 'Auto-mine ore clusters (?automine on/off/stop/filter/pickup/list/status/clear)', (player, args) => {
      const cmd = (args[0] || '').toLowerCase()
      if (cmd === 'on') {
        player._automineEnabled = true
        sendMessage(player, theme.toggle('AutoMine', true, '— scanning chunks, will fly to ores'))
        startNextCluster(player)
      } else if (cmd === 'off') {
        player._automineEnabled = false
        cancelMine(player)
        sendMessage(player, theme.toggle('AutoMine', false))
      } else if (cmd === 'stop') {
        cancelMine(player)
        sendMessage(player, theme.line('AutoMine', '§7stopped'))
      } else if (cmd === 'log') {
        const sub = (args[1] || '').toLowerCase()
        if (sub === 'on') {
          player._autoLogEnabled = true
          sendMessage(player, theme.line('AutoMine', '§7AutoLog: §aENABLED'))
        } else if (sub === 'off') {
          player._autoLogEnabled = false
          sendMessage(player, theme.line('AutoMine', '§7AutoLog: §cDISABLED'))
        } else if (!isNaN(parseInt(sub))) {
          player._autoLogThreshold = parseInt(sub)
          sendMessage(player, theme.line('AutoMine', `§7AutoLog threshold set to §f${player._autoLogThreshold}`))
        } else {
          sendMessage(player, theme.line('AutoMine', `§7AutoLog: ${player._autoLogEnabled ? '§aON' : '§cOFF'} (Threshold: ${player._autoLogThreshold})`))
        }
      } else if (cmd === 'filter') {
        const f = (args[1] || '').toLowerCase()
        if (!f || f === 'clear' || f === 'none') { player._amFilter = null; sendMessage(player, theme.line('AutoMine', '§7filter cleared')) }
        else { player._amFilter = f; sendMessage(player, theme.line('AutoMine', `§7filter: §f${f}`)) }
      } else if (cmd === 'pickup') {
        const sub = (args[1] || '').toLowerCase()
        player._amPickupEnabled = sub === 'on' ? true : sub === 'off' ? false : !player._amPickupEnabled
        sendMessage(player, theme.line('AutoMine', `§7pickup pass ${player._amPickupEnabled ? '§aON' : '§cOFF'}`))
      } else if (cmd === 'delay') {
        const d = parseInt(args[1])
        if (!isNaN(d)) {
          player._amTpDelay = d
          sendMessage(player, theme.line('AutoMine', `§7teleport delay set to §f${d}ms`))
        } else {
          sendMessage(player, theme.line('AutoMine', `§7current delay: §f${player._amTpDelay}ms`))
        }
      } else if (cmd === 'list') {
        showNearest(player, (args[1] || '').toLowerCase())
      } else if (cmd === 'status') {
        const counts = {}
        for (const ore of player._oreMap.values()) counts[ore.name] = (counts[ore.name] || 0) + 1
        const lines = [theme.line('AutoMine', player._automineEnabled ? '§aON' : '§cOFF'), `§7Phase: §f${player._amPhase}`, `§7Filter: §f${player._amFilter || '(none)'}`, `§7Ores tracked: §f${player._oreMap.size}`]
        for (const [n, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`  §d${n.replace('minecraft:', '')}: §f${c}`)
        sendMessage(player, lines.join('\n'))
      } else if (cmd === 'clear') {
        player._oreMap.clear(); sendMessage(player, theme.line('AutoMine', '§7ore map cleared'))
      } else {
        sendMessage(player, theme.line('AutoMine', '?automine on/off/stop/filter <type>/list/status/clear'))
      }
    })
  }
}


// ─── Mining tick — returns an array of block_action objects to inject, or null ──
// Lifecycle per block (confirmed from saber packet capture):
//   tick 0:        [start_break, crack_break]
//   ticks 1..N-1:  [crack_break]            (one per tick while breaking)
//   final tick:    [predict_break]          (tells server we expect it broken)
// Server then sends update_block(air) to confirm.
function runMiningTick (player, authParams) {
  const now = Date.now()
  const cur = player._amCurrent

  if (cur) {
    const pos = { x: Math.floor(cur.x), y: Math.floor(cur.y), z: Math.floor(cur.z) }

    if (player._amConfirmed) {
      console.log('[AutoMine] ✓ confirmed, moving to next')
      if (cur && !(cur.name && cur.name.startsWith('clear:'))) {
        player._amBrokenSpots.push({ x: cur.x + 0.5, y: cur.y + 0.5, z: cur.z + 0.5 })
      }
      player._amCurrent = null
      player._amBreakMs = MINE_FALLBACK
      player._amConfirmed = false
      player._amStarted = false
      player._amNextAt = now + MINE_GAP
      player._amBlocksMined = (player._amBlocksMined || 0) + 1
      if (player._amBlocksMined === 1 && player._amMineAnchor && player._amRid) {
        player._amMineAnchor.y += 1
        teleportClient(player, player._amMineAnchor.x, player._amMineAnchor.y, player._amMineAnchor.z,
          authParams.pitch || 0, authParams.yaw || 0)
      }
      return null
    }

    const elapsed = now - player._amSentAt
    const isClearBlock = cur.name && cur.name.startsWith('clear:')
    // Clears get a longer give-up than before (was 500) — with timerbypass
    // /3 a stone clear is ~500ms breakWait, so we need at least 1500ms to
    // tolerate server processing. If clear bails too early the player
    // suffocates while the queue moves on to ores.
    const giveUp = isClearBlock ? 2000 : Math.max(MINE_TIMEOUT, player._amBreakMs + 6000)
    if (elapsed > giveUp) {
      const wasMining = player._amStarted
      const isClear = cur.name && cur.name.startsWith('clear:')
      cur._retries = (cur._retries || 0) + 1
      if (!isClear && cur._retries <= 2) {
        console.log(`[AutoMine] timeout @ ${pos.x},${pos.y},${pos.z} — requeue (retry ${cur._retries})`)
        player._amQueue.push({ x: cur.x, y: cur.y, z: cur.z, name: cur.name, rid: cur.rid, _retries: cur._retries })
      } else {
        console.log(`[AutoMine] timeout @ ${pos.x},${pos.y},${pos.z} — giving up${isClear ? ' (clear)' : ''}`)
      }
      player._amCurrent = null
      player._amBreakMs = MINE_FALLBACK
      player._amConfirmed = false
      player._amStarted = false
      player._amStopped = false
      player._amServerAck = false
      player._amNextAt = now + MINE_GAP
      return wasMining ? [{ action: 'abort_break', position: pos, face: cur.face || 1 }] : null
    }

    if (!player._amStarted) {
      player._amStarted = true
      player._amStopped = false
      console.log(`[AutoMine] start_break @ ${pos.x},${pos.y},${pos.z} (${cur.name}) face=${cur.face}`)

      // One swing_arm per real ore (skip the clear:feet/head no-ops). Both
      // upstream so other players see us swinging AND downstream so our own
      // viewmodel arm swings.
      if (!(cur.name && cur.name.startsWith('clear:')) && player._amRid) {
        const animPkt = {
          action_id: 'swing_arm',
          runtime_entity_id: BigInt(player._amRid),
          data: 0,
          has_swing_source: true,
          swing_source: 'attack'
        }
        try { if (player.upstream) player.upstream.queue('animate', animPkt) } catch (e) {}
        try { player.queue('animate', animPkt) } catch (e) {}
      }

      return [
        { action: 'start_break', position: pos, face: cur.face || 1 },
        { action: 'crack_break', position: pos, face: cur.face || 1 }
      ]
    }

    const isClear = cur.name && cur.name.startsWith('clear:')
    // Built-in ×3 timerbypass means server clock runs 3x — divide the
    // server-told break time by 3 so we send stop_break at the right
    // server-time moment, not 3x too late. Floor 250ms so we don't beat
    // server packet processing on fast clears.
    const breakWait = Math.max(player._amBreakMs / 3, 250)
    if (!player._amStopped && elapsed >= breakWait) {
      player._amStopped = true
      console.log(`[AutoMine] stop_break @ ${pos.x},${pos.y},${pos.z} after ${elapsed}ms${isClear ? ' CLEAR' : ''}`)
      return [
        { action: 'stop_break', position: pos, face: cur.face || 1 },
        { action: 'crack_break', position: pos, face: cur.face || 1 }
      ]
    }

    return [{ action: 'crack_break', position: pos, face: cur.face || 1 }]
  }

  if (now < player._amNextAt) return null

  if (player._amQueue.length > 0) {
    // Reach is measured from where we LANDED (anchor), not the live position
    // which drifts after the instant TP and falsely fails the range check —
    // that drift was causing the spam-tp-between-ores bug.
    const refPos = player._amMineAnchor || authParams.position
    const headY = Math.floor(refPos.y + 1.62)
    let targetIdx = -1

    // 1. Look for a head-level block that is within reach of the anchor
    for (let i = 0; i < player._amQueue.length; i++) {
      if (Math.floor(player._amQueue[i].y) === headY) {
        const testDist = Math.sqrt(sqDist(player._amQueue[i], refPos))
        if (testDist <= MINE_REACH) {
          targetIdx = i
          break
        }
      }
    }
    if (targetIdx === -1) {
      targetIdx = 0
    }

    const next = player._amQueue.splice(targetIdx, 1)[0]
    const dist = Math.sqrt(sqDist(next, refPos))

    // 2. Validate final range against the anchor position so it doesn't trigger
    //    a flight route desync from drifting livePos.
    if (dist > MINE_REACH) {
      console.log(`[AutoMine] ${next.x},${next.y},${next.z} dist=${dist.toFixed(1)} > ${MINE_REACH} — repositioning`)
      player._amQueue.unshift(next)
      player._amTarget = { x: next.x + 0.5, y: next.y + TARGET_Y_OFF, z: next.z + 0.5 }
      player._amPath = buildSafePath(player._amLavaMap, refPos, player._amTarget) || [player._amTarget]
      player._amRepositioning = true
      prepareInstantTp(player, 'automine')
      player._amPhase = 'flying'
      return null
    }

    const face = pickFace(next, refPos)
    player._amCurrent = { ...next, face }
    player._amBreakMs = MINE_FALLBACK
    player._amConfirmed = false
    player._amStarted = false
    player._amStopped = false
    player._amServerAck = false
    player._amEquipDiag = false
    player._amCamKey = null
    player._amSentAt = now
    return null
  }

  const spots = player._amBrokenSpots || []
  if (spots.length > 0 && player._amPickupEnabled !== false) {
    const start = authParams.position
    player._amPickupQueue = orderRoute(spots, start)
    player._amPickupTarget = null
    player._amBrokenSpots = []
    player._amPhase = 'pickup'
    console.log(`[AutoMine] pickup pass: ${player._amPickupQueue.length} spots`)
    return null
  }

  player._amBrokenSpots = []
  player._amPhase = 'idle'
  player._amTarget = null
  player._amCluster = []
  player._amNextAt = now + 2000
  console.log('[AutoMine] cluster done, looking for next...')
  return null
}

// Pick the block face pointing roughly toward the player so the server accepts
// line-of-sight. Faces: 0=down 1=up 2=north 3=south 4=west 5=east.
function pickFace (block, playerPos) {
  if (!playerPos) return 1
  const dx = playerPos.x - (block.x + 0.5)
  const dy = playerPos.y - (block.y + 0.5)
  const dz = playerPos.z - (block.z + 0.5)
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
  if (ay >= ax && ay >= az) return dy >= 0 ? 1 : 0
  if (ax >= az) return dx >= 0 ? 5 : 4
  return dz >= 0 ? 3 : 2
}

// Compute the pitch/yaw that aims from the player's eyes at a block's center.
// Bedrock yaw: 0=+Z(south), 90=-X(west), -90=+X(east); pitch: +down, -up.
function lookAt (playerPos, block) {
  const eyeY = playerPos.y + 1.62
  const dx = (block.x + 0.5) - playerPos.x
  const dy = (block.y + 0.5) - eyeY
  const dz = (block.z + 0.5) - playerPos.z
  const horiz = Math.sqrt(dx * dx + dz * dz)
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI
  const pitch = (Math.atan2(-dy, horiz) * 180) / Math.PI
  return { yaw, pitch }
}

// Switch the held item to a hotbar slot that contains a pickaxe (if any), so the
// server's destroy-rate is high enough to complete the break. Sends mob_equipment
// to the server. No-op if already holding a pickaxe or none is found.
function equipPickaxe (player) {
  const ids = player._amPickaxeIds
  const hotbar = player._amHotbarItems

  // Loud diagnostics once per mining session so we can see why it's not switching.
  if (!player._amEquipDiag) {
    player._amEquipDiag = true
    const idsSize = ids ? ids.size : 0
    const hbLen = Array.isArray(hotbar) ? hotbar.length : -1
    const hbIds = Array.isArray(hotbar) ? hotbar.map(it => it && it.network_id).join(',') : 'none'
    console.log(`[AutoMine] equip diag: pickaxeIds=${idsSize} hotbarLen=${hbLen} hotbarIds=[${hbIds}] heldId=${player._amHeldItem && player._amHeldItem.network_id}`)
  }

  if (!ids || ids.size === 0 || !Array.isArray(hotbar)) return
  const heldId = player._amHeldItem && player._amHeldItem.network_id
  if (heldId && ids.has(heldId)) return

  let pickSlot = -1
  for (let i = 0; i < 9 && i < hotbar.length; i++) {
    const it = hotbar[i]
    if (it && ids.has(it.network_id)) { pickSlot = i; break }
  }
  if (pickSlot < 0) { if (!player._amNoPickWarned) { player._amNoPickWarned = true; console.log('[AutoMine] no pickaxe found in hotbar — mining will be slow') } return }
  if (pickSlot === player._amHotbarSlot) return

  const item = hotbar[pickSlot]
  const equipItem = normalizeItemNew(item)
  try {
    player.upstream.queue('mob_equipment', {
      runtime_entity_id: BigInt(player._amRid),
      item: equipItem,
      slot: pickSlot,
      selected_slot: pickSlot,
      window_id: 'inventory'
    })
    player._amHotbarSlot = pickSlot
    player._amHeldItem = item
    console.log('[AutoMine] switched to pickaxe slot ' + pickSlot)
  } catch (e) { console.log('[AutoMine] pickaxe switch failed: ' + e.message) }
}

// ─── Cluster selection ────────────────────────────────────────────────────
function startNextCluster (player) {
  if (!player._amRid || !player._amPos) return false
  if (player._amPhase !== 'idle') return false
  if (player._oreMap.size === 0) return false

  const pos = player._amPos
  const filter = player._amFilter
  let candidates = [...player._oreMap.values()]
  if (filter) candidates = candidates.filter(o => o.name.includes(filter))
  if (candidates.length === 0) return false

  const lavaMap = player._amLavaMap
  const oreMap = player._oreMap

  // Build EVERY same-id cluster up front. Each cluster only contains ores
  // matching the seed's name (so diamond+redstone touching = two clusters).
  // Filter argument when set widens the match (`diamond` matches both
  // diamond_ore and deepslate_diamond_ore so a vein spanning both still
  // groups as one cluster).
  const visited = new Set()
  const clusters = []
  for (const seed of candidates) {
    const seedKey = `${seed.x},${seed.y},${seed.z}`
    if (visited.has(seedKey)) continue
    const matchKey = filter || seed.name   // exact-name flood unless filter widens it
    const cluster = floodVein(oreMap, seed, matchKey)
    for (const o of cluster) visited.add(`${o.x},${o.y},${o.z}`)
    if (cluster.length > 0) clusters.push(cluster)
  }

  // Priority: BIGGEST cluster first (most ores per TP). Tiebreak by closeness.
  clusters.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length
    const ca = clusterCentroid(a), cb = clusterCentroid(b)
    return sqDist(pos, ca) - sqDist(pos, cb)
  })

  // Try clusters in order; reject any whose landing spot is lava-near or
  // has no safe path to it.
  let chosen = null
  for (const cluster of clusters) {
    // Anchor is the TOP-Y ore. Land INSIDE that ore (dest.y = anchor.y) and
    // mine the head + feet clears immediately so the player is freed in one
    // tick.
    let anchor = cluster[0]
    for (const o of cluster) if (o.y > anchor.y) anchor = o
    const dest = { x: anchor.x + 0.5, y: anchor.y, z: anchor.z + 0.5 }
    if (lavaNear(lavaMap, dest)) continue
    // Column scan — check 6 blocks ABOVE and 6 blocks BELOW the ore for
    // lava in the (x,z) and 1-block-buffer columns. Catches lava lakes
    // hidden under ores and lava ceilings above them.
    if (lavaInColumn(lavaMap, dest.x, dest.z, anchor.y - 6, anchor.y + 6)) continue
    const path = buildSafePath(lavaMap, pos, dest)
    if (!path) continue
    const c = clusterCentroid(cluster)
    chosen = { cluster, dest, anchor, cx: c.x, cy: c.y, cz: c.z, path }
    break
  }
  if (!chosen) {
    // Everything reachable is lava-blocked right now.
    player._amNextAt = Date.now() + 3000
    return false
  }

  const { cluster, dest, anchor, cx, cy, cz, path } = chosen
  player._amTarget = dest
  player._amPath = path
  player._amCluster = cluster
  // Remember the anchor block so verify can confirm it's still an ore before
  // we commit to mining. If a chunk update pruned it (someone else mined it,
  // lava flowed, etc.) we'll bail out of mining rather than break stone.
  player._amAnchor = { x: anchor.x, y: anchor.y, z: anchor.z, name: anchor.name, rid: anchor.rid }
  prepareInstantTp(player, 'automine')
  player._amPhase = 'flying'

  const filterTxt = filter ? ` §8(${filter})` : ''
  sendMessage(player, theme.line('AutoMine', `§7→ §f${cluster.length}§7 ore${cluster.length === 1 ? '' : 's'} @ ${Math.floor(cx)}, ${Math.floor(cy)}, ${Math.floor(cz)}${filterTxt}`))
  return true
}

function cancelMine (player) {
  player._amPhase = 'idle'
  player._amTarget = null
  player._amPath = null
  player._amCluster = []
  player._amAnchor = null
  player._amQueue = []
  player._amCurrent = null
  player._amConfirmed = false
  player._amPickupQueue = []
  player._amPickupTarget = null
  player._amBrokenSpots = []
  player._amRepositioning = false
  player._amVirtualTicks = null   // reset internal timerbypass counter
  player._amCamKey = null
  if (player._amPos && player._amRid) {
    teleportClient(player, player._amPos.x, player._amPos.y, player._amPos.z, 0, 0)
  }
}

// ─── Ore display ──────────────────────────────────────────────────────────
function showNearest (player, filter) {
  if (player._oreMap.size === 0) { sendMessage(player, theme.error('No ores tracked yet. Walk around with ?automine on.')); return }
  const pos = player._amPos || { x: 0, y: 0, z: 0 }
  let entries = [...player._oreMap.values()]
  if (filter) entries = entries.filter(o => o.name.includes(filter))
  entries = entries.map(o => ({ ...o, dist: Math.hypot(o.x - pos.x, o.y - pos.y, o.z - pos.z) })).sort((a, b) => a.dist - b.dist).slice(0, 15)
  const lines = [theme.heading(`Ores${filter ? ` (${filter})` : ''}`)]
  for (const o of entries) lines.push(`  §d${o.name.replace('minecraft:', '')} §7@ §f${o.x}, ${o.y}, ${o.z} §8(${Math.floor(o.dist)}m)`)
  sendMessage(player, lines.join('\n'))
}

// ─── Chunk parsing (shared with tpmine) ───────────────────────────────────
function scanChunkForOres (params) {
  const chunkX = params.x, chunkZ = params.z, subChunkCount = params.sub_chunk_count, payload = params.payload
  if (!payload || subChunkCount <= 0) return { ores: [], lava: [] }
  const ores = [], lava = []; let off = 0
  for (let sci = 0; sci < subChunkCount; sci++) {
    if (off >= payload.length) break
    const sub = parseSubChunk(payload, off)
    if (!sub) break
    off = sub.end
    extractOresFromSub(sub, chunkX, chunkZ, sub.subY !== undefined ? sub.subY : (sci - 4), ores, lava)
  }
  return { ores, lava }
}

function extractOresFromSub (sub, chunkX, chunkZ, subY, out, lavaOut) {
  const baseY = subY * 16, layer = sub.layers[0]
  if (!layer || layer.indices.length !== 4096 || layer.palette.length === 0) return
  for (let i = 0; i < 4096; i++) {
    const block = layer.palette[layer.indices[i]]
    if (!block || !block.name) continue
    const lx = (i >> 8) & 0xF, lz = (i >> 4) & 0xF, ly = i & 0xF
    const wx = chunkX * 16 + lx, wy = baseY + ly, wz = chunkZ * 16 + lz
    if (ORE_NAMES.has(block.name)) {
      if (wy < MIN_ORE_Y) continue
      out.push({ x: wx, y: wy, z: wz, name: block.name, rid: block.rid || 0 })
    } else if (lavaOut && LAVA_NAMES.has(block.name)) {
      lavaOut.push(`${wx},${wy},${wz}`)
    }
  }
}

function parseSubChunk (buf, off) {
  if (off >= buf.length) return null
  const version = buf.readUInt8(off++); let layerCount, subY
  if (version === 1) layerCount = 1
  else if (version === 8) { if (off >= buf.length) return null; layerCount = buf.readUInt8(off++) }
  else if (version === 9) { if (off + 1 >= buf.length) return null; layerCount = buf.readUInt8(off++); subY = buf.readInt8(off++) }
  else return null
  const layers = []
  for (let i = 0; i < layerCount; i++) { const l = parseStorageLayer(buf, off); if (!l) return null; off = l.end; layers.push(l) }
  return { version, subY, layers, end: off }
}

function parseStorageLayer (buf, off) {
  if (off >= buf.length) return null
  const flags = buf.readUInt8(off++), bpb = flags >> 1, isRuntime = (flags & 1) === 1
  let indices
  if (bpb === 0) { indices = new Array(4096).fill(0) }
  else {
    const blocksPerWord = Math.floor(32 / bpb), wordCount = Math.ceil(4096 / blocksPerWord)
    if (off + wordCount * 4 > buf.length) return null
    indices = new Array(4096); const mask = (1 << bpb) - 1; let bi = 0
    for (let w = 0; w < wordCount; w++) { const word = buf.readUInt32LE(off); off += 4; for (let b = 0; b < blocksPerWord && bi < 4096; b++) indices[bi++] = (word >> (bpb * b)) & mask }
  }
  let palSize
  if (isRuntime) { const v = readVarInt(buf, off); if (!v) return null; palSize = v.value; off = v.end }
  else { if (off + 4 > buf.length) return null; palSize = buf.readInt32LE(off); off += 4 }
  if (palSize < 0 || palSize > 4096) return null
  const palette = []
  for (let i = 0; i < palSize; i++) {
    if (isRuntime) {
      const v = readZigzagVarint(buf, off); if (!v) return null
      const name = (RUNTIME_ID_TO_NAME && v.value >= 0 && v.value < RUNTIME_ID_TO_NAME.length) ? RUNTIME_ID_TO_NAME[v.value] : null
      palette.push({ name: name || ('runtime:' + v.value), rid: v.value }); off = v.end
    } else {
      const entry = readNbtCompound(buf, off); if (!entry) return null; palette.push(entry.block); off = entry.end
    }
  }
  return { bpb, isRuntime, indices, palette, end: off }
}

function readVarInt (buf, off) { let value = 0, shift = 0, n = 0; while (true) { if (off + n >= buf.length || n > 5) return null; const byte = buf.readUInt8(off + n); n++; value |= (byte & 0x7F) << shift; shift += 7; if ((byte & 0x80) === 0) break }; return { value, end: off + n } }
function readZigzagVarint (buf, off) { const v = readVarInt(buf, off); if (!v) return null; return { value: (v.value >>> 1) ^ -(v.value & 1), end: v.end } }

function readNbtCompound (buf, off) {
  try {
    const proto = nbt.protos && nbt.protos.little; if (!proto) return null
    const slice = buf.slice(off), result = proto.parsePacketBuffer('nbt', slice)
    const consumed = result?.metadata?.size; if (!consumed || consumed > slice.length) return null
    let blockName = 'unknown', blockStates = {}
    try { const s = nbt.simplify(result.data); if (s && typeof s.name === 'string') blockName = s.name; if (s?.states) blockStates = s.states } catch (_) { const r = result.data?.value; if (r?.name && typeof r.name.value === 'string') blockName = r.name.value }
    return { block: { name: blockName, states: blockStates }, end: off + consumed }
  } catch (_) { return null }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function sqDist (a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx*dx + dy*dy + dz*dz }

function clusterCentroid (cluster) {
  let cx = 0, cy = 0, cz = 0
  for (const o of cluster) { cx += o.x; cy += o.y; cz += o.z }
  return { x: cx / cluster.length, y: cy / cluster.length, z: cz / cluster.length }
}

// Flood-fill a vein from a seed ore: pull in EVERY ore (any type) that is
// touching (within the 26 surrounding cells) an ore already in the cluster.
// When `filter` is set, only ores whose name matches the filter substring are
// pulled in — this is what `?automine filter <type>` uses to mine ONLY that
// type even if other ore kinds are touching.
function floodVein (oreMap, seed, filter) {
  const cluster = []
  const seen = new Set()
  const stack = [seed]
  seen.add(`${seed.x},${seed.y},${seed.z}`)
  while (stack.length) {
    const cur = stack.pop()
    cluster.push(cur)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          const nk = `${cur.x + dx},${cur.y + dy},${cur.z + dz}`
          if (seen.has(nk)) continue
          const n = oreMap.get(nk)
          if (!n) continue
          if (filter && !n.name.includes(filter)) continue
          seen.add(nk); stack.push(n)
        }
  }
  return cluster
}

// Order a set of points into a short nearest-neighbour walk starting from `from`.
function orderRoute (points, from) {
  const remaining = points.slice()
  const route = []
  let cur = from
  while (remaining.length > 0) {
    let bi = 0, bd = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = sqDist(remaining[i], cur)
      if (d < bd) { bd = d; bi = i }
    }
    cur = remaining.splice(bi, 1)[0]
    route.push(cur)
  }
  return route
}

// Lava avoidance. _amLavaMap is a Map keyed by "x,y,z" of known lava blocks.
// True if there's lava in the 5×5×5 box centred on a point (so we don't land
// in or right next to lava).
function lavaNear (lavaMap, p) {
  if (!lavaMap || lavaMap.size === 0) return false
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  // 5×5×5 cube — 2-block buffer keeps us out of flow distance.
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (let dz = -2; dz <= 2; dz++)
        if (lavaMap.has(`${bx + dx},${by + dy},${bz + dz}`)) return true
  return false
}

// Vertical column lava scan with 1-block horizontal buffer. Used before
// committing to TP onto an ore — if there's lava in the same X,Z column
// (or its neighbours) anywhere from yLo..yHi, the cluster is rejected.
function lavaInColumn (lavaMap, x, z, yLo, yHi) {
  if (!lavaMap || lavaMap.size === 0) return false
  const bx = Math.floor(x), bz = Math.floor(z)
  const lo = Math.floor(Math.min(yLo, yHi))
  const hi = Math.ceil(Math.max(yLo, yHi))
  for (let y = lo; y <= hi; y++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (lavaMap.has(`${bx + dx},${y},${bz + dz}`)) return true
      }
    }
  }
  return false
}

// True if the straight-line flight path from start→end passes through (or
// within 1 block of) any known lava. Steps along the path one block at a time.
function lavaInPath (lavaMap, start, end) {
  if (!lavaMap || lavaMap.size === 0) return false
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
  if (dist < 0.001) return false
  // Sample at half-block resolution so a 1-wide lava stream between two whole
  // steps can't be skipped over.
  const steps = Math.ceil(dist * 2)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const px = start.x + dx * t, py = start.y + dy * t, pz = start.z + dz * t
    if (lavaNear(lavaMap, { x: px, y: py, z: pz })) return true
  }
  return false
}

// Highest known lava Y anywhere in the horizontal corridor between start→end
// (within 2 blocks of the line), or null if no lava in the corridor.
function highestLavaInCorridor (lavaMap, start, end) {
  if (!lavaMap || lavaMap.size === 0) return null
  let maxY = null
  for (const key of lavaMap.keys()) {
    const parts = key.split(',')
    const lx = +parts[0], ly = +parts[1], lz = +parts[2]
    // distance from point to the start→end segment in the XZ plane
    const ax = end.x - start.x, az = end.z - start.z
    const segLen2 = ax * ax + az * az
    let t = segLen2 > 0 ? ((lx - start.x) * ax + (lz - start.z) * az) / segLen2 : 0
    t = Math.max(0, Math.min(1, t))
    const px = start.x + ax * t, pz = start.z + az * t
    const dxz = Math.hypot(lx - px, lz - pz)
    if (dxz <= 2.5) { if (maxY === null || ly > maxY) maxY = ly }
  }
  return maxY
}

// Build a lava-safe flight path of waypoints from start→dest.
//   - straight line clear  → [dest]
//   - lava in the way      → climb to (lavaTop + clearance) over the start,
//                            cruise at that height over the dest, then drop in.
// Returns null only if even the over-the-top route would pass through lava
// (e.g. lava stacked all the way up — extremely rare).
function buildSafePath (lavaMap, start, dest) {
  if (!lavaInPath(lavaMap, start, dest)) return [{ x: dest.x, y: dest.y, z: dest.z }]
  const lavaTop = highestLavaInCorridor(lavaMap, start, dest)
  if (lavaTop === null) return [{ x: dest.x, y: dest.y, z: dest.z }]
  const cruiseY = lavaTop + 4  // fly 4 blocks above the highest lava surface
  const up    = { x: start.x, y: cruiseY, z: start.z }
  const over  = { x: dest.x,  y: cruiseY, z: dest.z }
  const down  = { x: dest.x,  y: dest.y,  z: dest.z }
  // Verify each leg of the over-the-top route is lava-free.
  if (lavaInPath(lavaMap, start, up) ||
      lavaInPath(lavaMap, up, over) ||
      lavaInPath(lavaMap, over, down)) return null
  return [up, over, down]
}

function spoofPos (params, x, y, z) {
  params.position.x = x; params.position.y = y; params.position.z = z
  if (params.delta) { params.delta.x = 0; params.delta.y = 0; params.delta.z = 0 }
}

function teleportClient (player, x, y, z, pitch, yaw) {
  player.queue('move_player', { runtime_id: Number(player._amRid), position: { x, y, z }, pitch: pitch || 0, yaw: yaw || 0, head_yaw: yaw || 0, mode: 'teleport', on_ground: false, ridden_runtime_id: 0, teleport: { cause: 'unknown', source_entity_type: 0 }, tick: 0n })
}

// Send the standalone player_action packet (parallel break path). Some servers
// only honor breaks via this packet, not the auth_input block_action array.
function sendPlayerAction (player, action, pos, face) {
  if (!player.upstream || !player._amRid || !pos) return
  try {
    player.upstream.queue('player_action', {
      runtime_entity_id: BigInt(player._amRid),
      action,
      position: { x: pos.x, y: pos.y, z: pos.z },
      result_position: { x: pos.x, y: pos.y, z: pos.z },
      face: typeof face === 'number' ? face : 1
    })
  } catch (e) {}
}
