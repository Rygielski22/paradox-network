'use strict'

/**
 * Post-install patch for bedrock-protocol relay.js
 *
 * 1.26.30 container/crafting packets parse OK but re-encode wrong (ItemV4 /
 * ItemStackRequest schema). Mining still works because break_block uses the
 * simpler item_use transaction path.
 *
 * Fix: never re-encode container/inventory packets — forward original bytes.
 *
 * CRITICAL: all raw forwards MUST be deferred via setImmediate. Calling
 * sendBuffer(immediate=true) synchronously from raknet's read callback
 * re-enters raknet-native and corrupts the heap ("double free or corruption").
 */

const fs = require('fs')
const path = require('path')

const filePath = path.join(__dirname, '..', 'node_modules', 'bedrock-protocol', 'src', 'relay.js')

const JOIN_RAW_MS = 15000

const CB_RAW = [
  // Join / world bootstrap — re-encoding breaks 1.26.30 (new start_game fields, ItemV4…)
  'start_game',
  'play_status',
  'level_chunk',
  'item_registry',
  'creative_content',
  'biome_definition_list',
  'available_actor_identifiers',
  'available_entity_identifiers',
  'resource_packs_info',
  'resource_pack_data_info',
  'resource_pack_chunk_data',
  'resource_packs_ready_for_validation',
  // boost-aligned: never re-encode Lifeboat stack — inject via pack-injector queue/raw
  'resource_pack_stack',
  'player_list',
  'remove_volume_entity',
  'set_spawn_position',
  'chunk_radius_update',
  'game_rules_changed',
  'adventure_settings',
  'update_adventure_settings',
  'mob_equipment',
  'mob_armor_equipment',
  'set_health',
  'update_attributes',
  'tick_sync',
  'set_time',
  'sync_entity_property',
  'available_commands',
  'camera',
  'set_difficulty',
  'set_commands_enabled',
  'set_player_game_type',
  'change_dimension',
  // Inventory / containers
  'item_stack_response',
  'container_open',
  'container_close',
  'inventory_content',
  'inventory_slot',
  'crafting_data',
  'inventory_transaction',
  'container_set_data',
  'container_registry_cleanup',
  'set_player_inventory_options',
  'network_stack_latency',
  'network_chunk_publisher_update'
]

const SB_RAW = [
  'item_stack_request',
  'inventory_transaction',
  'network_stack_latency',
  'client_movement_prediction_sync',
  'player_location',
  'update_client_options',
  'set_local_player_as_initialized',
  'request_chunk_radius',
  'client_cache_status'
  // player_auth_input: only raw-forward item/inventory subtypes (see conditional below).
  // Unconditional raw breaks fly/speed/disabler/killaura serverbound hooks.
]

const CB_RAW_JS = JSON.stringify(CB_RAW)
const SB_RAW_JS = JSON.stringify(SB_RAW)

console.log('[Patch] Checking bedrock-protocol relay.js...')

if (!fs.existsSync(filePath)) {
  console.log('[Patch] bedrock-protocol not installed yet, skipping relay patch')
  process.exit(0)
}

let src = fs.readFileSync(filePath, 'utf8')
let changed = false

function relayLooksValid (text) {
  return text.length > 5000 &&
    text.includes('class Relay ') &&
    text.includes('module.exports = { Relay }')
}

if (!relayLooksValid(src)) {
  console.error('[Patch] relay.js missing or corrupt — reinstall bedrock-protocol (npm install) then restart.')
  process.exit(1)
}

const HELPERS = `  /* meteor-relay-helpers:start */
  _meteorDeferRawToClient (packet) {
    const self = this
    const buf = packet
    setImmediate(() => {
      try {
        if (typeof self.sendBuffer === 'function') self.sendBuffer(buf, true)
      } catch (e) {
        self._meteorLogEncodeFail('clientbound', 'raw-forward', e.message)
      }
    })
  }

  _meteorDeferRawToUpstream (packet) {
    const up = this.upstream
    const buf = packet
    setImmediate(() => {
      try {
        if (up && typeof up.sendBuffer === 'function') {
          up.sendBuffer(buf, true)
        } else if (global._meteorPacketDiag) {
          global._meteorPacketDiag.recordRelayDead(this, 'serverbound')
        }
      } catch (e) {
        if (global._meteorPacketDiag) global._meteorPacketDiag.recordRelayDead(this, 'serverbound')
        else console.warn('[meteor-relay] serverbound raw-forward failed:', e.message)
      }
    })
  }

  _meteorCleanParseMessage (raw) {
    let m = String(raw || 'parse error')
    if (/Read error for undefined\s*:\s*undefined/i.test(m)) {
      m = 'malformed packet (reader field error — protocol drift or variable-length payload)'
    } else if (/Unexpected buffer end while reading VarInt/i.test(m)) {
      m = 'truncated / short buffer while reading VarInt (partial packet or schema mismatch)'
    }
    return m
  }

  _meteorIsAuthInputPacket (packet) {
    if (!packet || packet.length < 2) return false
    // Quick check: VarInt 144 (0x90 0x01) for player_auth_input is very common
    const b0 = packet[0]
    if ((b0 & 0x7f) === 0x10 && (b0 & 0x80)) { // continuation + 16
      const b1 = packet[1]
      if ((b1 & 0x7f) === 1) return true
    }
    return false
  }

  _meteorForceTpPositionOnRaw (packet, player) {
    const anchor = player && player._meteorTp
    const mt = anchor && anchor.dest
    if (!mt || (anchor.until && Date.now() > anchor.until) || !this._meteorIsAuthInputPacket(packet)) return packet

    try {
      // Skip VarInt id
      let off = 0
      while (off < packet.length && (packet[off] & 0x80)) off++
      off++

      const candidates = [off + 8, off + 12, off + 16, off + 4, off + 20, off + 1, off + 24]
      for (const start of candidates) {
        if (start + 24 > packet.length) continue
        packet.writeDoubleLE(mt.x, start)
        packet.writeDoubleLE(mt.y, start + 8)
        packet.writeDoubleLE(mt.z, start + 16)
        break
      }
    } catch (e) {}
    return packet
  }

  _meteorLogParseFail (direction, message, packet, packetName) {
    const head = packet && packet.length ? packet.slice(0, 24).toString('hex') : ''
    const id = (packetName && String(packetName).startsWith('id:')) ? packetName
      : (packetName != null ? ('id:' + packetName) : ('id:' + (this._meteorPeekPacketId(packet) ?? '?')))
    const idNum = id.match(/id:(\d+)/) ? Number(id.match(/id:(\d+)/)[1]) : null

    // Known packet names for nicer logs (player_auth_input is by far the most common offender)
    const KNOWN = { 144: 'player_auth_input', 30: 'inventory_transaction', 21: 'item_stack_request' }
    const nice = (idNum != null && KNOWN[idNum]) ? (idNum + '(' + KNOWN[idNum] + ')') : id

    const cleanMsg = this._meteorCleanParseMessage(message)

    if (global._meteorPacketDiag) {
      global._meteorPacketDiag.recordParseFail(this, direction, message, head, id)  // diag will also sanitize
    }

    // Separate, slower throttling for the hot player_auth_input path
    const isAuth = idNum === 144
    const throttleMs = isAuth ? 15000 : 4000
    const key = isAuth ? '_meteorParseLogAt_auth' : '_meteorParseLogAt'
    const now = Date.now()
    if (!this[key] || now - this[key] > throttleMs) {
      this[key] = now
      const extra = isAuth ? ' (player_auth_input — raw forwarded, some modules may skip this tick)' : ''
      console.warn('[meteor-relay]', direction, 'parse failed — forwarding raw (deferred):', cleanMsg, 'pkt=' + nice, head ? 'buf=' + head : '', extra)
    }
  }

  _meteorLogEncodeFail (direction, packetName, message) {
    if (global._meteorPacketDiag) {
      global._meteorPacketDiag.recordEncodeFail(this, direction, packetName, message)
    }
    const now = Date.now()
    const key = direction + ':' + packetName
    if (!this._meteorEncodeLogAt) this._meteorEncodeLogAt = {}
    if (!this._meteorEncodeLogAt[key] || now - this._meteorEncodeLogAt[key] > 3000) {
      this._meteorEncodeLogAt[key] = now
      console.warn('[meteor-relay]', direction, 'encode failed for', packetName, '—', message)
    }
  }

  _meteorPeekPacketId (packet) {
    if (!packet || !packet.length) return null
    let num = 0
    let shift = 0
    let off = 0
    while (off < packet.length && shift < 35) {
      const b = packet[off++]
      num |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return num
      shift += 7
    }
    return null
  }

  _meteorEmitServerboundAsync (packet) {
    const self = this
    setImmediate(() => {
      try {
        const des = self.server.deserializer.parsePacketBuffer(packet)
        des._meteorRawPacket = packet
        self.emit('serverbound', des.data, des)
      } catch (e) {
        if (e && (e.partialReadError || e.name === 'PartialReadError')) return
        self._meteorLogParseFail('serverbound-async', e.message, packet, 'id:' + (self._meteorPeekPacketId(packet) ?? '?'))
      }
    })
  }

  _meteorEmitClientboundAsync (packet) {
    const self = this
    setImmediate(() => {
      try {
        const des = self.server.deserializer.parsePacketBuffer(packet)
        des._meteorRawPacket = packet
        self.emit('clientbound', des.data, des)
      } catch (e) {
        if (e && (e.partialReadError || e.name === 'PartialReadError')) return
        self._meteorLogParseFail('clientbound-async', e.message, packet, 'id:' + (self._meteorPeekPacketId(packet) ?? '?'))
      }
    })
  }

  _meteorFlushChunkCache () {
    if (!this.chunkSendCache.length || !this.sentStartGame) return
    const self = this
    const cache = this.chunkSendCache
    this.chunkSendCache = []
    for (const entry of cache) {
      this._meteorDeferRawToClient(entry)
      try {
        const cachedDes = this.server.deserializer.parsePacketBuffer(entry)
        cachedDes._meteorRawPacket = entry
        setImmediate(() => {
          try { self.emit('clientbound', cachedDes.data, cachedDes) } catch (_) {}
        })
      } catch (_) {}
    }
  }

  _meteorSanitizeParams (params) {
    if (!params || typeof params !== 'object') return params
    const seen = new Set()
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object' || seen.has(obj)) return
      if (Buffer.isBuffer(obj)) return
      seen.add(obj)
      if (obj.network_id !== undefined && obj.count !== undefined && obj.block_runtime_id !== undefined) {
        if (obj.extra_data === undefined || obj.extra_data === null) obj.extra_data = Buffer.alloc(0)
      }
      if (Array.isArray(obj)) { for (const v of obj) walk(v); return }
      for (const v of Object.values(obj)) walk(v)
    }
    walk(params)
    return params
  }

  _meteorHotbarSlotOf (hotbar, networkId) {
    if (!networkId || !Array.isArray(hotbar)) return -1
    for (let i = 0; i < 9 && i < hotbar.length; i++) {
      const it = hotbar[i]
      if (it && it.network_id === networkId) return i
    }
    return -1
  }

  // Strip item_use that references a hotbar slot other than the tracked selection.
  _meteorSanitizeServerbound (des) {
    const state = this._invUtilState
    if (!state || !des || !des.data || !des.data.params) return
    const n = des.data.name
    const p = des.data.params
    const sel = state.selectedSlot ?? 0
    const hotbar = state.hotbar || []
    const selected = hotbar[sel]

    if (n === 'inventory_transaction') {
      const tx = p.transaction
      if (!tx) return
      const type = String(tx.transaction_type || '')
      if (type !== 'item_use' && type !== 'item_release') return
      const td = tx.transaction_data
      if (!td) return
      const heldId = td.held_item && td.held_item.network_id
      const packetSlot = td.hotbar_slot
      const itemSlot = typeof packetSlot === 'number'
        ? packetSlot
        : (heldId ? this._meteorHotbarSlotOf(hotbar, heldId) : -1)
      if (itemSlot >= 0 && itemSlot !== sel) {
        td.hotbar_slot = sel
        td.held_item = selected || { network_id: 0 }
        des._meteorReserialize = true
      }
      return
    }

    if (n !== 'player_auth_input') return
    const flags = p.input_data
    if (!flags) return

    const tx = p.transaction || (p.item_use_transaction && p.item_use_transaction.transaction)
    const td = tx && (tx.data || tx.transaction_data)
    const d = tx && tx.data
    const heldId = td && td.held_item && td.held_item.network_id
    const packetSlot = td && td.hotbar_slot
    const itemSlot = typeof packetSlot === 'number'
      ? packetSlot
      : (heldId ? this._meteorHotbarSlotOf(hotbar, heldId) : -1)
    const wrongSlot = itemSlot >= 0 && itemSlot !== sel

    if (flags.item_interact || flags.block_action) {
      if (!tx || !d || !wrongSlot) return
      d.hotbar_slot = sel
      d.held_item = selected || { network_id: 0 }
      des._meteorReserialize = true
      return
    }

    if (flags.start_using_item || flags.item_use) {
      if (wrongSlot) {
        flags.start_using_item = false
        flags.item_use = false
        flags.using_item = false
        flags.continue_using_item = false
        if (p.item_use_transaction) p.item_use_transaction = null
        if (p.transaction) p.transaction = null
        des._meteorReserialize = true
      }
    }
  }
  /* meteor-relay-helpers:end */`

const SB_START = '/* meteor-relay-parse-guard:start */'
const SB_END = '/* meteor-relay-parse-guard:end */'
const SB_PASSTHROUGH = '/* meteor-relay-passthrough-sb */'
const CB_PASSTHROUGH = '/* meteor-relay-passthrough-cb */'
const REGISTRY_FAST_START = '/* meteor-relay-registry-fastpath:start */'
const REGISTRY_FAST_END = '/* meteor-relay-registry-fastpath:end */'
const CHUNK_FAST_START = '/* meteor-relay-chunk-fastpath:start */'
const CHUNK_FAST_END = '/* meteor-relay-chunk-fastpath:end */'
const HELPERS_START = '/* meteor-relay-helpers:start */'
const HELPERS_END = '/* meteor-relay-helpers:end */'

const REGISTRY_FAST_BLOCK = `    ${REGISTRY_FAST_START}
    if (name === 'item_registry' || name === 'creative_content') {
      try { this.emit('clientbound', des.data, des) } catch (_) {}
      this._meteorDeferRawToClient(packet)
      return
    }
    ${REGISTRY_FAST_END}`

const CHUNK_FAST_BLOCK = `    ${CHUNK_FAST_START}
    if (name === 'level_chunk' || name === 'subchunk') {
      if (name === 'level_chunk' && !this.sentStartGame) {
        this.chunkSendCache.push(packet)
        return
      }
      this._meteorDeferRawToClient(packet)
      const chunkDes = des
      const self = this
      setImmediate(() => {
        try { self.emit('clientbound', chunkDes.data, chunkDes) } catch (_) {}
      })
      if (this.chunkSendCache.length > 0 && this.sentStartGame) {
        for (const entry of this.chunkSendCache) {
          this._meteorDeferRawToClient(entry)
        }
        this.chunkSendCache = []
      }
      return
    }
    ${CHUNK_FAST_END}`

// Collapse duplicate registry/chunk fastpaths from repeated patch runs
const fastpathMegaRe = /\/\* meteor-relay-registry-fastpath:start \*\/[\s\S]*?\/\* meteor-relay-chunk-fastpath:end \*\//
const registryCount = (src.match(/\/\* meteor-relay-registry-fastpath:start \*\//g) || []).length
if (registryCount > 1) {
  const next = src.replace(fastpathMegaRe, '/* meteor-relay-fastpath-dedupe */')
  if (next !== src) {
    src = next
    changed = true
    console.log('[Patch] ✓ Removed duplicate registry/chunk fastpath blocks.')
  }
}
if (src.includes('/* meteor-relay-fastpath-dedupe */')) {
  src = src.replace('/* meteor-relay-fastpath-dedupe */', REGISTRY_FAST_BLOCK.trim())
  changed = true
  console.log('[Patch] ✓ Installed registry fastpath (boost-aligned, no chunk fastpath).')
}

const serverboundBlock = `${SB_START}
      let des
      try {
        des = this.server.deserializer.parsePacketBuffer(packet)
        des._meteorRawPacket = packet
      } catch (e) {
        const pid = this._meteorPeekPacketId(packet)
        this._meteorLogParseFail('serverbound', e.message, packet, pid != null ? 'id:' + pid : null)
        // METEOR-TP: always patch position into raw auth buffer if a TP is active.
        // This is the #1 thing that prevents "sets me back" and void issues.
        let toSend = packet
        if (this._meteorTp && this._meteorIsAuthInputPacket(packet)) {
          toSend = this._meteorForceTpPositionOnRaw(packet, this)
        }
        this._meteorDeferRawToUpstream(toSend)
        return
      }

      if (debugging) {
        try {
          this.server.deserializer.verify(des, this.server.serializer)
        } catch (ve) {
          const pid = this._meteorPeekPacketId(packet)
          this._meteorLogParseFail('serverbound-verify', ve.message, packet, pid != null ? 'id:' + pid : null)
          this._meteorDeferRawToUpstream(packet)
          return
        }
      }

      try {
        this.emit('serverbound', des.data, des)
      } catch (me) {
        const pid = this._meteorPeekPacketId(packet) || (des && des.data && des.data.name)
        this._meteorLogParseFail('serverbound-modules', me.message, packet, pid != null ? (typeof pid === 'number' ? 'id:' + pid : pid) : null)
      }
      this._meteorSanitizeServerbound(des)
      if (des.canceled) return

      ${SB_PASSTHROUGH}
      {
        const __n = des.data.name
        const __p = des.data.params
        let __raw = !!des._meteorRawPassthrough
        if (des._meteorReserialize || des._meteorMeteorTpForce || this._meteorTp) {
          __raw = false
        }
        if (!__raw && ${SB_RAW_JS}.includes(__n)) {
          __raw = true
        } else if (!__raw && __n === 'player_auth_input') {
          const __f = __p && __p.input_data
          if ((__f && (__f.item_stack_request || __f.item_interact || __f.start_using_item || __f.item_use)) ||
              __p.item_stack_request || __p.transaction) {
            if (! (des._meteorReserialize || des._meteorMeteorTpForce || this._meteorTp) ) {
              __raw = true
            }
          }
        }
        if (__raw) {
          this._meteorDeferRawToUpstream(packet)
          return
        }
      }

      switch (des.data.name) {
        case 'client_cache_status':
          try {
            this.upstream.queue('client_cache_status', { enabled: this.enableChunkCaching })
          } catch (e) {
            this._meteorLogEncodeFail('serverbound', 'client_cache_status', e.message)
            this._meteorDeferRawToUpstream(packet)
          }
          break
        case 'set_local_player_as_initialized':
          this.status = 3
        // falls through
        default:
          this.downInLog('Relaying', des.data)
          try {
            this._meteorSanitizeParams(des.data.params)
            this.upstream.queue(des.data.name, des.data.params)
          } catch (e) {
            this._meteorLogEncodeFail('serverbound', des.data.name, e.message)
            this._meteorDeferRawToUpstream(packet)
          }
      }
      ${SB_END}`

// ── Helper methods on RelayPlayer ─────────────────────────────────────────────
if (src.includes(HELPERS_START) && src.includes(HELPERS_END)) {
  const re = /\/\* meteor-relay-helpers:start \*\/[\s\S]*?\/\* meteor-relay-helpers:end \*\//
  if (re.test(src)) {
    src = src.replace(re, HELPERS.trim())
    changed = true
    console.log('[Patch] ✓ Updated deferred raw-forward helpers.')
  }
} else if (!src.includes('_meteorDeferRawToClient')) {
  const anchor = '    this.respawnPacket = []\n  }'
  if (src.includes(anchor)) {
    src = src.replace(anchor, '    this.respawnPacket = []\n  }\n\n' + HELPERS)
    changed = true
    console.log('[Patch] ✓ Installed deferred raw-forward helpers.')
  }
}

// ── Serverbound guard ─────────────────────────────────────────────────────────
if (src.includes(SB_START) && src.includes(SB_END)) {
  const re = /\/\* meteor-relay-parse-guard:start \*\/[\s\S]*?\/\* meteor-relay-parse-guard:end \*\//
  if (re.test(src)) {
    src = src.replace(re, serverboundBlock)
    changed = true
    console.log('[Patch] ✓ Updated serverbound guard + deferred passthrough.')
  }
} else {
  const oldBlock = `      // TODO: If we fail to parse a packet, proxy it raw and log an error
      const des = this.server.deserializer.parsePacketBuffer(packet)

      if (debugging) { // some packet encode/decode testing stuff
        this.server.deserializer.verify(des, this.server.serializer)
      }

      this.emit('serverbound', des.data, des)
      if (des.canceled) return

      switch (des.data.name) {
        case 'client_cache_status':
          // Force the chunk cache off.
          this.upstream.queue('client_cache_status', { enabled: this.enableChunkCaching })
          break
        case 'set_local_player_as_initialized':
          this.status = 3
        // falls through
        default:
          // Emit the packet as-is back to the upstream server
          this.downInLog('Relaying', des.data)
          this.upstream.queue(des.data.name, des.data.params)
      }`

  if (src.includes(oldBlock)) {
    src = src.replace(oldBlock, serverboundBlock)
    changed = true
    console.log('[Patch] ✓ Installed serverbound guard + deferred passthrough.')
  }
}

// ── Clientbound parse-fail guard ──────────────────────────────────────────────
const clientboundCatch = `    } catch (e) {
      this._meteorLogParseFail('clientbound', e.message, packet)
      this._meteorDeferRawToClient(packet)
      return
    }`

if (src.includes('[meteor-relay] clientbound parse failed — forwarding raw:')) {
  const oldCatch = /    \} catch \(e\) \{\n      console\.warn\('\[meteor-relay\] clientbound parse failed[\s\S]*?return\n    \}/
  if (oldCatch.test(src)) {
    src = src.replace(oldCatch, clientboundCatch)
    changed = true
    console.log('[Patch] ✓ Updated clientbound parse-fail guard (deferred).')
  }
} else if (!src.includes("_meteorLogParseFail('clientbound'")) {
  const oldCatch = `    } catch (e) {
      this.server.deserializer.dumpFailedBuffer(packet, this.connection.address)
      console.error(this.connection.address, e)

      if (!this.options.omitParseErrors) {
        this.disconnect('Server packet parse error')
      }

      return
    }`
  if (src.includes(oldCatch)) {
    src = src.replace(oldCatch, clientboundCatch)
    changed = true
    console.log('[Patch] ✓ Installed clientbound parse-fail guard (deferred).')
  }
}

const cbPassthroughBlock = `      /* meteor-relay-join-raw */
      if (this._meteorJoinRawUntil && Date.now() < this._meteorJoinRawUntil) {
        this._meteorDeferRawToClient(packet)
        return
      }

      ${CB_PASSTHROUGH}
      if (${CB_RAW_JS}.includes(name)) {
        this._meteorDeferRawToClient(packet)
        return
      }`

const clientboundQueue = `${cbPassthroughBlock}

      /* meteor-relay-clientbound-guard */
      try {
        this.queue(name, params)
      } catch (e) {
        this._meteorLogEncodeFail('clientbound', name, e.message)
        this._meteorDeferRawToClient(packet)
      }`

if (src.includes(CB_PASSTHROUGH)) {
  const cbRe = /\/\* meteor-relay-join-raw \*\/[\s\S]*?\/\* meteor-relay-passthrough-cb \*\/[\s\S]*?return\n      \}/
  const cbReLegacy = /\/\* meteor-relay-passthrough-cb \*\/[\s\S]*?return\n      \}/
  if (cbRe.test(src)) {
    src = src.replace(cbRe, cbPassthroughBlock)
    changed = true
    console.log('[Patch] ✓ Updated clientbound join-raw window + passthrough.')
  } else if (cbReLegacy.test(src)) {
    src = src.replace(cbReLegacy, cbPassthroughBlock)
    changed = true
    console.log('[Patch] ✓ Updated clientbound container passthrough (deferred).')
  }
} else if (src.includes('this.queue(name, params)') && !src.includes(CB_PASSTHROUGH)) {
  if (src.includes('      this.queue(name, params)\n    }')) {
    src = src.replace('      this.queue(name, params)\n    }', clientboundQueue + '\n    }')
    changed = true
    console.log('[Patch] ✓ Installed clientbound container passthrough (deferred).')
  }
}

// ── level_chunk cache: store raw bytes, never re-encode on replay ─────────────
const CHUNK_CACHE_OLD = `      if (name === 'start_game') {
        setTimeout(() => {
          this.sentStartGame = true
        }, 500)
      } else if (name === 'level_chunk' && !this.sentStartGame) {
        this.chunkSendCache.push(params)
        return
      }`
const CHUNK_CACHE_NEW = `      if (name === 'start_game') {
        this.sentStartGame = true
        this._meteorJoinRawUntil = Date.now() + ${JOIN_RAW_MS}
      } else if (name === 'level_chunk' && !this.sentStartGame) {
        this.chunkSendCache.push(packet)
        return
      }`
if (src.includes(CHUNK_CACHE_OLD)) {
  src = src.replace(CHUNK_CACHE_OLD, CHUNK_CACHE_NEW)
  changed = true
  console.log('[Patch] ✓ level_chunk cache stores raw buffers (no re-encode replay).')
} else if (src.includes('this.chunkSendCache.push(params)')) {
  src = src.replace('this.chunkSendCache.push(params)', 'this.chunkSendCache.push(packet)')
  changed = true
  console.log('[Patch] ✓ level_chunk cache push switched to raw packet.')
}

// readUpstream start_game must arm join-raw (flushDownQueue alone is not enough)
const startGameArmRe = /if \(name === 'start_game'\) \{\n(\s+)this\.sentStartGame = true\n(\s+)\} else if \(name === 'level_chunk'/
if (startGameArmRe.test(src) && !src.match(/if \(name === 'start_game'\)[\s\S]{0,200}_meteorJoinRawUntil/)) {
  src = src.replace(
    startGameArmRe,
    `if (name === 'start_game') {\n$1this.sentStartGame = true\n$1this._meteorJoinRawUntil = Date.now() + ${JOIN_RAW_MS}\n$2} else if (name === 'level_chunk'`
  )
  changed = true
  console.log('[Patch] ✓ start_game arms 15s join raw-forward window (readUpstream).')
}

const CHUNK_REPLAY_OLD = `    if (this.chunkSendCache.length > 0 && this.sentStartGame) {
      for (const entry of this.chunkSendCache) {
        this.queue('level_chunk', entry)
      }
      this.chunkSendCache = []
    }`
const CHUNK_REPLAY_NEW = `    if (this.chunkSendCache.length > 0 && this.sentStartGame) {
      for (const entry of this.chunkSendCache) {
        this._meteorDeferRawToClient(entry)
      }
      this.chunkSendCache = []
    }`
if (src.includes(CHUNK_REPLAY_OLD)) {
  src = src.replace(CHUNK_REPLAY_OLD, CHUNK_REPLAY_NEW)
  changed = true
  console.log('[Patch] ✓ Cached level_chunk replay forwards raw (fixes join crash).')
} else if (src.includes("this.queue('level_chunk', entry)")) {
  src = src.replace("this.queue('level_chunk', entry)", 'this._meteorDeferRawToClient(entry)')
  changed = true
  console.log('[Patch] ✓ Cached level_chunk replay uses raw forward.')
}

// ── flushDownQueue ────────────────────────────────────────────────────────────
const newFlushDown = `  flushDownQueue () {
    this.downOutLog('Flushing downstream queue')
    const rawNames = ${CB_RAW_JS}
    for (const packet of this.downQ) {
      try {
        const des = this.server.deserializer.parsePacketBuffer(packet)
        des._meteorRawPacket = packet
        if (des.data.name === 'start_game') {
          this.sentStartGame = true
          this._meteorJoinRawUntil = Date.now() + ${JOIN_RAW_MS}
        }
        this.emit('clientbound', des.data, des)
        if (des.canceled) continue
        if (this._meteorJoinRawUntil && Date.now() < this._meteorJoinRawUntil) {
          this._meteorDeferRawToClient(packet)
        } else if (rawNames.includes(des.data.name)) {
          this._meteorDeferRawToClient(packet)
        } else {
          this._meteorSanitizeParams(des.data.params)
          this.write(des.data.name, des.data.params)
        }
      } catch (err) {
        this._meteorLogParseFail('flushDownQueue', err.message, packet)
        this._meteorDeferRawToClient(packet)
      }
    }
    this.downQ = []
  }`

{
  const flushBlock = src.match(/flushDownQueue \(\) \{[\s\S]*?this\.downQ = \[\]\n  \}/)
  const flushNeedsBoostAlign = flushBlock && flushBlock[0].includes("des.data.name !== 'resource_pack_stack'")
  if (flushNeedsBoostAlign) {
    src = src.replace(flushBlock[0], newFlushDown.trim())
    changed = true
    console.log('[Patch] ✓ Upgraded flushDownQueue (boost-aligned — no stack re-encode).')
  }
}

// ── flushUpQueue ──────────────────────────────────────────────────────────────
if (!src.includes("this._meteorLogParseFail('flushUpQueue'")) {
  const oldFlush = `  flushUpQueue () {
    this.upOutLog('Flushing upstream queue')
    for (const e of this.upQ) { // Send the queue
      const des = this.server.deserializer.parsePacketBuffer(e)
      if (des.data.name === 'client_cache_status') {
        // Currently not working, force off the chunk cache
      } else {
        this.upstream.write(des.data.name, des.data.params)
      }
    }
    this.upQ = []
  }`

  const newFlush = `  flushUpQueue () {
    this.upOutLog('Flushing upstream queue')
    for (const e of this.upQ) { // Send the queue
      try {
        const des = this.server.deserializer.parsePacketBuffer(e)
        if (des.data.name === 'client_cache_status') {
          // Currently not working, force off the chunk cache
        } else {
          this.upstream.write(des.data.name, des.data.params)
        }
      } catch (err) {
        this._meteorLogParseFail('flushUpQueue', err.message, e)
        this._meteorDeferRawToUpstream(e)
      }
    }
    this.upQ = []
  }`

  if (src.includes(oldFlush)) {
    src = src.replace(oldFlush, newFlush)
    changed = true
    console.log('[Patch] ✓ Upgraded flushUpQueue (deferred).')
  } else {
    const partialFlush = /flushUpQueue \(\) \{[\s\S]*?this\.upQ = \[\]\n  \}/
    if (partialFlush.test(src) && !src.includes('_meteorDeferRawToUpstream(e)')) {
      src = src.replace(partialFlush, newFlush.trim())
      changed = true
      console.log('[Patch] ✓ Replaced flushUpQueue (deferred).')
    }
  }
}

// ── Fix leftover sync sendBuffer in clientbound encode catch ─────────────────
const syncCbCatch = `      } catch (e) {
        console.warn('[meteor-relay] clientbound encode failed for', name, '— forwarding raw:', e.message)
        if (typeof this.sendBuffer === 'function') {
          this.sendBuffer(packet, true)
        }
      }`
const deferCbCatch = `      } catch (e) {
        console.warn('[meteor-relay] clientbound encode failed for', name, '— forwarding raw:', e.message)
        this._meteorDeferRawToClient(packet)
      }`
if (src.includes(syncCbCatch)) {
  src = src.replace(syncCbCatch, deferCbCatch)
  changed = true
  console.log('[Patch] ✓ Fixed sync clientbound encode catch (now deferred).')
}

// ── Upstream-not-ready: never parse (parse failures crash the queue path) ───
const syncUpQueueParse = `      if (!this.upstream) {
        const des = this.server.deserializer.parsePacketBuffer(packet)
        this.downInLog('Got downstream connected packet but upstream is not connected yet, added to q', des)
        this.upQ.push(packet) // Put into a queue
        return
      }`
const safeUpQueueParse = `      if (!this.upstream) {
        this.downInLog('Got downstream packet while upstream connecting — queued raw')
        this.upQ.push(packet)
        return
      }`
if (src.includes(syncUpQueueParse)) {
  src = src.replace(syncUpQueueParse, safeUpQueueParse)
  changed = true
  console.log('[Patch] ✓ Upstream queue no longer parses before upstream ready.')
}

// ── Legacy sync raw-forward cleanup (old partial patches / relaypassthrough) ─
const legacySync = [
  [/this\.upstream\.sendBuffer\(packet\)/g, 'this._meteorDeferRawToUpstream(packet)'],
  [/this\.upstream\.sendBuffer\(e\)/g, 'this._meteorDeferRawToUpstream(e)'],
  [/parse failed — forwarding raw:/g, 'parse failed — forwarding raw (deferred):']
]
for (const [re, rep] of legacySync) {
  const next = src.replace(re, rep)
  if (next !== src) { src = next; changed = true }
}
if (changed) console.log('[Patch] ✓ Cleaned legacy sync raw-forward paths.')

// ── Sanitize ItemV4 before re-encode in flush queues ────────────────────────
const flushUpWrite = `          this.upstream.write(des.data.name, des.data.params)`
const flushUpSafe = `          this._meteorSanitizeParams(des.data.params)
          this.upstream.write(des.data.name, des.data.params)`
if (src.includes(flushUpWrite) && !src.includes('_meteorSanitizeParams(des.data.params)')) {
  src = src.replace(flushUpWrite, flushUpSafe)
  changed = true
  console.log('[Patch] ✓ flushUpQueue sanitizes ItemV4 before write.')
}

const flushDownWrite = `          this.write(des.data.name, des.data.params)`
const flushDownSafe = `          this._meteorSanitizeParams(des.data.params)
          this.write(des.data.name, des.data.params)`
if (src.includes(flushDownWrite) && src.includes('flushDownQueue')) {
  const block = src.match(/flushDownQueue \(\) \{[\s\S]*?this\.downQ = \[\]\n  \}/)
  if (block && block[0].includes(flushDownWrite) && !block[0].includes('_meteorSanitizeParams')) {
    src = src.replace(flushDownWrite, flushDownSafe)
    changed = true
    console.log('[Patch] ✓ flushDownQueue sanitizes ItemV4 before write.')
  }
}

// ── Remove chunk fastpath (boost-proxy relays level_chunk/subchunk normally) ─
const chunkFastRe = /\/\* meteor-relay-chunk-fastpath:start \*\/[\s\S]*?\/\* meteor-relay-chunk-fastpath:end \*\//
if (chunkFastRe.test(src)) {
  src = src.replace(chunkFastRe, '')
  changed = true
  console.log('[Patch] ✓ Removed chunk fastpath (boost-aligned).')
}

// ── Keep original packet bytes on des for pack stack injection fallback ─────
if (!src.includes('des._meteorRawPacket = packet')) {
  const attach = `des = this.server.deserializer.parsePacketBuffer(packet)
      des._meteorRawPacket = packet`
  if (src.includes('des = this.server.deserializer.parsePacketBuffer(packet)')) {
    src = src.replace(
      'des = this.server.deserializer.parsePacketBuffer(packet)',
      attach
    )
    changed = true
    console.log('[Patch] ✓ clientbound des._meteorRawPacket attach (pack injector).')
  }
}

// Restore boost-style upstream chunk cache handshake if a prior patch forced false.
if (src.includes("client.write('client_cache_status', { enabled: false })")) {
  src = src.replace(
    "client.write('client_cache_status', { enabled: false })",
    "client.write('client_cache_status', { enabled: this.enableChunkCaching })"
  )
  changed = true
  console.log('[Patch] ✓ upstream join uses enableChunkCaching (boost-aligned).')
}

// Remove inventory_transaction parse-skip (boost parses all clientbound packets).
const cbPeekRe = /    const __cbPeek = this\._meteorPeekPacketId\(packet\)\n    if \(__cbPeek !== null && \[30\]\.includes\(__cbPeek\)\) \{\n      this\._meteorDeferRawToClient\(packet\)\n      this\._meteorEmitClientboundAsync\(packet\)\n      return\n    \}\n\n/
if (cbPeekRe.test(src)) {
  src = src.replace(cbPeekRe, '')
  changed = true
  console.log('[Patch] ✓ Removed clientbound parse-skip (boost-aligned).')
}

// ── readUpstream: wrap debugging verify in try/catch ────────────────────────
const UP_VERIFY_OLD = `    if (debugging) { // some packet encode/decode testing stuff
      this.server.deserializer.verify(des, this.server.serializer)
    }`
const UP_VERIFY_NEW = `    if (debugging) {
      try {
        this.server.deserializer.verify(des, this.server.serializer)
      } catch (ve) {
        this._meteorLogParseFail('clientbound-verify', ve.message, packet)
      }
    }`
if (src.includes(UP_VERIFY_OLD)) {
  src = src.replace(UP_VERIFY_OLD, UP_VERIFY_NEW)
  changed = true
  console.log('[Patch] ✓ readUpstream verify wrapped in try/catch.')
}

// ── Upstream lifecycle: log drops before client disconnect ───────────────────
const UP_ERR_OLD = `    client.on('error', (err) => {
      ds.disconnect('Server error: ' + err.message)
      debug(clientAddr, 'was disconnected because of error', err)
      this.upstreams.delete(clientAddr.hash)
    })`
const UP_ERR_NEW = `    client.on('error', (err) => {
      if (global._meteorPacketDiag) {
        global._meteorPacketDiag.recordUpstreamDrop(ds, err.message || String(err), 'ERROR')
      }
      ds.disconnect('Server error: ' + err.message)
      debug(clientAddr, 'was disconnected because of error', err)
      this.upstreams.delete(clientAddr.hash)
    })`
if (src.includes(UP_ERR_OLD) && !src.includes('recordUpstreamDrop(ds')) {
  src = src.replace(UP_ERR_OLD, UP_ERR_NEW)
  changed = true
  console.log('[Patch] ✓ upstream error handler logs to packet diagnostics.')
}

const UP_CLOSE_OLD = `    client.on('close', (reason) => {
      ds.disconnect('Backend server closed connection')
      this.upstreams.delete(clientAddr.hash)
    })`
const UP_CLOSE_NEW = `    client.on('close', (reason) => {
      if (global._meteorPacketDiag) {
        global._meteorPacketDiag.recordUpstreamDrop(ds, reason ? String(reason) : 'closed', 'CLOSE')
      }
      ds.disconnect('Backend server closed connection')
      this.upstreams.delete(clientAddr.hash)
    })`
if (src.includes(UP_CLOSE_OLD) && !src.includes("recordUpstreamDrop(ds, reason")) {
  src = src.replace(UP_CLOSE_OLD, UP_CLOSE_NEW)
  changed = true
  console.log('[Patch] ✓ upstream close handler logs to packet diagnostics.')
}

if (changed) {
  if (!relayLooksValid(src)) {
    console.error('[Patch] relay.js patch would corrupt file — aborting write.')
    process.exit(1)
  }
  fs.writeFileSync(filePath, src)
  console.log('[Patch] ✓ relay.js updated.')
} else {
  console.log('[Patch] ✓ relay.js already fully patched.')
}