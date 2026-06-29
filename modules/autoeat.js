'use strict'

/**
 * AutoEat — switches to a food hotbar slot, eats, switches back.
 *
 * ?autoeat on / off / slot <0-8> / threshold <1-19> / status
 */

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const InvUtil = require('../utils/invutil')
const { toAttackHeldItem, sanitizePacketParams } = require('../core/packet-compat')

const EAT_DURATION_MS = 1700
const EAT_COOLDOWN_MS = 600
const DEFAULT_THRESHOLD = 17

const FOOD_NAMES = new Set([
  'minecraft:apple', 'minecraft:golden_apple', 'minecraft:enchanted_golden_apple',
  'minecraft:bread',
  'minecraft:beef', 'minecraft:cooked_beef',
  'minecraft:chicken', 'minecraft:cooked_chicken',
  'minecraft:porkchop', 'minecraft:cooked_porkchop',
  'minecraft:mutton', 'minecraft:cooked_mutton',
  'minecraft:rabbit', 'minecraft:cooked_rabbit',
  'minecraft:cod', 'minecraft:cooked_cod',
  'minecraft:salmon', 'minecraft:cooked_salmon',
  'minecraft:tropical_fish', 'minecraft:pufferfish',
  'minecraft:carrot', 'minecraft:golden_carrot',
  'minecraft:potato', 'minecraft:baked_potato',
  'minecraft:beetroot', 'minecraft:beetroot_soup',
  'minecraft:mushroom_stew', 'minecraft:rabbit_stew', 'minecraft:suspicious_stew',
  'minecraft:melon_slice', 'minecraft:cookie',
  'minecraft:pumpkin_pie',
  'minecraft:dried_kelp',
  'minecraft:glow_berries', 'minecraft:sweet_berries',
  'minecraft:chorus_fruit',
  'minecraft:honey_bottle',
  'minecraft:rotten_flesh', 'minecraft:spider_eye'
])

const FOOD_PATTERNS = [
  '_apple', 'bread', 'cooked_', 'beef', 'chicken', 'porkchop', 'mutton',
  'rabbit', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'carrot',
  'cookie', 'melon_slice', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup',
  'beetroot', 'baked_potato', 'potato', 'dried_kelp', 'glow_berries',
  'sweet_berries', 'chorus_fruit', '_pie', 'honey_bottle', 'suspicious_stew'
]

const FOOD_BLACKLIST = new Set([
  'minecraft:carrot_on_a_stick', 'minecraft:warped_fungus_on_a_stick',
  'minecraft:potato_seeds', 'minecraft:beetroot_seeds',
  'minecraft:poisonous_potato'
])

function isFoodName (name) {
  if (!name) return false
  const n = String(name).toLowerCase()
  if (!n.startsWith('minecraft:')) return isFoodName(`minecraft:${n}`)
  if (FOOD_BLACKLIST.has(n)) return false
  if (FOOD_NAMES.has(n)) return true
  for (const p of FOOD_PATTERNS) {
    if (n.includes(p)) return true
  }
  return false
}

function learnFoodIds (player, items) {
  if (!Array.isArray(items)) return
  if (!player._aeIdToName) player._aeIdToName = new Map()
  if (!player._aeFoodIds) player._aeFoodIds = new Set()
  for (const it of items) {
    const nm = (it && (it.name || it.name_string || '')) + ''
    const id = it?.runtime_id ?? it?.id ?? it?.network_id
    if (id == null || !nm) continue
    player._aeIdToName.set(id, nm)
    if (isFoodName(nm)) player._aeFoodIds.add(id)
  }
}

function isFoodItem (player, item) {
  if (!item?.network_id || !(item.count > 0)) return false
  if (player._aeFoodIds?.has(item.network_id)) return true
  const name = player._aeIdToName?.get(item.network_id)
  return isFoodName(name)
}

function findFoodSlot (player) {
  const pinned = player._aeFoodSlot
  if (pinned >= 0 && pinned < 9) {
    const it = InvUtil.getItem(player, pinned)
    if (isFoodItem(player, it)) return pinned
  }
  return InvUtil.findItemInHotbar(player, (it) => isFoodItem(player, it))
}

function sendUseStart (player, item, slot, authParams) {
  if (!player.upstream || !item) return
  const pos = authParams?.position || { x: 0, y: 0, z: 0 }
  const pkt = sanitizePacketParams({
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: {
        action_type: 'click_air',
        trigger_type: 'unknown',
        block_position: { x: 0, y: 0, z: 0 },
        face: 255,
        hotbar_slot: slot,
        held_item: toAttackHeldItem(item),
        player_pos: { x: pos.x, y: pos.y, z: pos.z },
        click_pos: { x: 0, y: 0, z: 0 },
        block_runtime_id: 0
      }
    }
  })
  try {
    player.upstream.queue('inventory_transaction', pkt)
  } catch (_) {}
}

function sendRelease (player, item, slot, authParams) {
  if (!player.upstream || !item) return
  const pos = authParams?.position || { x: 0, y: 0, z: 0 }
  const pkt = sanitizePacketParams({
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: {
        action_type: 'release',
        block_position: { x: 0, y: 0, z: 0 },
        face: 255,
        hotbar_slot: slot,
        held_item: toAttackHeldItem(item),
        player_pos: { x: pos.x, y: pos.y, z: pos.z },
        click_pos: { x: 0, y: 0, z: 0 },
        block_runtime_id: 0
      }
    }
  })
  try {
    player.upstream.queue('inventory_transaction', pkt)
  } catch (_) {}
}

function finishEating (player, authParams) {
  const slot = player._aeFoodSlotUsed
  const item = InvUtil.getItem(player, slot)
  if (item?.network_id) sendRelease(player, item, slot, authParams)

  player._aePhase = 'idle'
  player._aeNextAt = Date.now() + EAT_COOLDOWN_MS

  if (player._aePrevSlot !== player._aeFoodSlotUsed) {
    InvUtil.switchTo(player, player._aePrevSlot)
  }
}

function runAutoEat (player, authParams) {
  const now = Date.now()

  if (player._aePhase === 'idle') {
    if (player._aeHunger > player._aeThreshold) return
    if (now < player._aeNextAt) return

    const slot = findFoodSlot(player)
    if (slot < 0) return

    player._aePrevSlot = InvUtil.getSelectedSlot(player)
    player._aeFoodSlotUsed = slot
    player._aePhase = 'eating'
    player._aeEatStart = now
    player._aeAte = false
    player._aeFirstTick = true

    InvUtil.switchTo(player, slot)
    return
  }

  if (player._aePhase !== 'eating') return

  const slot = player._aeFoodSlotUsed
  const item = InvUtil.getItem(player, slot)
  if (!item?.network_id) {
    player._aePhase = 'idle'
    if (player._aePrevSlot !== slot) InvUtil.switchTo(player, player._aePrevSlot)
    return
  }

  if (!authParams.input_data || typeof authParams.input_data !== 'object') {
    authParams.input_data = {}
  }

  authParams.selected_item_slot = slot

  if (player._aeFirstTick) {
    authParams.input_data.start_using_item = true
    sendUseStart(player, item, slot, authParams)
    player._aeFirstTick = false
  }

  authParams.input_data.using_item = true
  authParams.input_data.continue_using_item = true
  authParams.input_data.item_interact = true

  const elapsed = now - player._aeEatStart
  if (player._aeAte || elapsed >= EAT_DURATION_MS) {
    delete authParams.input_data.start_using_item
    delete authParams.input_data.using_item
    delete authParams.input_data.continue_using_item
    delete authParams.input_data.item_interact
    authParams.input_data.released_item_use = true
    authParams.input_data.released_using_item = true
    finishEating(player, authParams)
  }
}

module.exports = {
  name: 'AutoEat',
  description: 'Auto-eat food when hunger is low',

  onPlayer (player) {
    InvUtil.setup(player)

    if (player._autoeatEnabled === undefined) player._autoeatEnabled = false
    player._aeRid = null
    player._aeHunger = 20
    player._aeThreshold = DEFAULT_THRESHOLD
    player._aeFoodSlot = -1
    player._aeFoodIds = new Set()
    player._aeIdToName = new Map()
    player._aePhase = 'idle'
    player._aeEatStart = 0
    player._aeNextAt = 0
    player._aePrevSlot = 0
    player._aeFoodSlotUsed = -1
    player._aeAte = false
    player._aeFirstTick = false

    player.on('clientbound', (data) => {
      if (data.name === 'start_game' && data.params) {
        player._aeRid = data.params.runtime_entity_id
        learnFoodIds(player, data.params.itemstates)
        return
      }

      if (data.name === 'item_registry' && data.params) {
        learnFoodIds(player, data.params.itemstates)
        return
      }

      if (data.name === 'update_attributes' && data.params &&
          String(data.params.runtime_entity_id) === String(player._aeRid)) {
        for (const a of (data.params.attributes || [])) {
          const hungerName = a.name === 'minecraft:player.hunger' || a.name === 'minecraft:hunger'
          if (!hungerName) continue
          const v = a.current ?? a.current_value ?? a.value
          if (typeof v !== 'number') break
          if (player._aePhase === 'eating' && v > player._aeHunger) player._aeAte = true
          player._aeHunger = v
          break
        }
        return
      }

      if ((data.name === 'entity_event' || data.name === 'actor_event') && data.params &&
          String(data.params.runtime_entity_id) === String(player._aeRid)) {
        const ev = data.params.event || data.params.event_id
        if (ev === 'use_item' && player._aePhase === 'eating') player._aeAte = true
      }
    })

    player.on('serverbound', (data) => {
      if (!player._autoeatEnabled || !player._aeRid) return
      if (data.name !== 'player_auth_input' || !data.params) return
      runAutoEat(player, data.params)
    })
  },

  onEnable () {
    const handler = (player, args) => {
      const cmd = (args[0] || '').toLowerCase()

      if (cmd === 'on') {
        player._autoeatEnabled = true
        sendMessage(player, theme.toggle('AutoEat', true, `— eats at hunger ≤ ${player._aeThreshold}`))
        return
      }
      if (cmd === 'off') {
        player._autoeatEnabled = false
        if (player._aePhase === 'eating' && player._aePrevSlot !== player._aeFoodSlotUsed) {
          InvUtil.switchTo(player, player._aePrevSlot)
        }
        player._aePhase = 'idle'
        sendMessage(player, theme.toggle('AutoEat', false))
        return
      }
      if (cmd === 'slot' || cmd === 'food') {
        const n = parseInt(args[1], 10)
        if (n >= 0 && n <= 8) {
          player._aeFoodSlot = n
          sendMessage(player, theme.line('AutoEat', `§7food slot pinned to §f${n}`))
        } else {
          player._aeFoodSlot = -1
          sendMessage(player, theme.line('AutoEat', '§7food slot: §fauto-detect'))
        }
        return
      }
      if (cmd === 'threshold') {
        const n = parseInt(args[1], 10)
        if (n >= 1 && n <= 19) {
          player._aeThreshold = n
          sendMessage(player, theme.line('AutoEat', `§7threshold §f${n}/20`))
        } else {
          sendMessage(player, theme.error('threshold must be 1-19'))
        }
        return
      }
      if (cmd === 'status') {
        const hb = InvUtil.getHotbar(player)
        const lines = [
          theme.line('AutoEat', `${player._autoeatEnabled ? '§aON' : '§cOFF'} §7· hunger §f${player._aeHunger}§7/20`),
          `§7Threshold: §f≤${player._aeThreshold} §7· Slot: §f${player._aeFoodSlot < 0 ? 'auto' : player._aeFoodSlot} §7· Food IDs: §f${player._aeFoodIds.size}`
        ]
        for (let i = 0; i < 9; i++) {
          const it = hb[i]
          if (!it?.network_id) {
            lines.push(`  §7${i}: §8empty`)
            continue
          }
          const name = (player._aeIdToName.get(it.network_id) || `id${it.network_id}`).replace('minecraft:', '')
          const tag = i === player._aeFoodSlot ? ' §a[pinned]' : (isFoodItem(player, it) ? ' §e[food]' : '')
          lines.push(`  §7${i}: §f${name}${tag}`)
        }
        sendMessage(player, lines.join('\n'))
        return
      }

      sendMessage(player, theme.line('AutoEat', '?autoeat on / off / slot <0-8> / threshold <1-19> / status'))
    }

    registerCommand('autoeat', 'Auto-eat when hunger drops (?autoeat on/off/slot/threshold/status)', handler)
    registerCommand('eat', 'Auto-eat when hunger drops (?eat on/off/slot/threshold/status)', handler)
  }
}