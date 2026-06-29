'use strict'

/**
 * InvUtil — shared inventory + hotbar utilities, ported from Dani/EUTOPIA's
 * InvUtil.cpp. Any module can:
 *   • InvUtil.setup(player)           — wire up clientbound tracking once
 *   • InvUtil.switchTo(player, slot)  — equip a hotbar slot (server + client)
 *   • InvUtil.getHotbar(player)       — returns slots 0..8 array (item or null)
 *   • InvUtil.findItemInHotbar(player, predicate)
 *   • InvUtil.getSelectedSlot(player) — last known held slot (0..8)
 *
 * Tracks inventory_content / inventory_slot / mob_equipment / player_hotbar
 * server→client AND client→server so getHotbar() is always fresh.
 */

const STATE_KEY = '_invUtilState'

function setup (player) {
  if (player[STATE_KEY]) return player[STATE_KEY]
  const state = {
    rid: null,
    hotbar: [],          // slots 0..8 of the player inventory
    selectedSlot: 0,
    setup: true
  }
  player[STATE_KEY] = state

  player.on('clientbound', (data) => {
    if (!data || !data.params) return
    if (data.name === 'start_game') {
      state.rid = data.params.runtime_entity_id
      return
    }
    if (data.name === 'inventory_content' &&
        (data.params.window_id === 0 || data.params.window_id === 'inventory')) {
      const contents = data.params.input || data.params.items || data.params.contents
      if (Array.isArray(contents)) {
        state.hotbar = contents.slice(0, 9)
      }
      return
    }
    if (data.name === 'inventory_slot' &&
        (data.params.window_id === 0 || data.params.window_id === 'inventory')) {
      const s = data.params.slot
      if (typeof s === 'number' && s < 9) state.hotbar[s] = data.params.item
      return
    }
    if (data.name === 'mob_equipment' && state.rid != null &&
        String(data.params.runtime_entity_id) === String(state.rid)) {
      if (typeof data.params.selected_slot === 'number') state.selectedSlot = data.params.selected_slot
      else if (typeof data.params.hotbar_slot === 'number') state.selectedSlot = data.params.hotbar_slot
      return
    }
    if (data.name === 'player_hotbar' && typeof data.params.selected_hotbar_slot === 'number') {
      state.selectedSlot = data.params.selected_hotbar_slot
    }
  })

  player.on('serverbound', (data) => {
    if (!data || !data.params) return
    // Mirror client-side hotbar select so we know what slot the player has
    // even before the server echoes back.
    if (data.name === 'mob_equipment') {
      if (typeof data.params.selected_slot === 'number') state.selectedSlot = data.params.selected_slot
      else if (typeof data.params.slot === 'number') state.selectedSlot = data.params.slot
    }
    if (data.name === 'player_hotbar' && typeof data.params.selected_hotbar_slot === 'number') {
      state.selectedSlot = data.params.selected_hotbar_slot
    }
  })

  return state
}

function getState (player) {
  return player[STATE_KEY] || setup(player)
}

function getHotbar (player) {
  return getState(player).hotbar || []
}

function getSelectedSlot (player) {
  return getState(player).selectedSlot || 0
}

function getItem (player, slot) {
  const hb = getHotbar(player)
  return (slot >= 0 && slot < 9) ? (hb[slot] || null) : null
}

// Walk the hotbar and return the first slot whose item passes the predicate,
// or -1 if none match. predicate(item, slot) → boolean.
function findItemInHotbar (player, predicate) {
  const hb = getHotbar(player)
  for (let i = 0; i < 9 && i < hb.length; i++) {
    const it = hb[i]
    if (it && it.network_id && it.count > 0 && predicate(it, i)) return i
  }
  return -1
}

const { normalizeItemNew } = require('../core/packet-compat')

// Build ItemNew for mob_equipment (1.26.30). Preserve server item shape when possible.
function buildEquipItem (item) {
  if (!item || !item.network_id) return null
  return normalizeItemNew(item)
}

/**
 * switchTo — equivalent of InvUtil::switchTo from Dani's EUTOPIA.
 *   1. Set local selectedSlot state.
 *   2. Send mob_equipment + player_hotbar UPSTREAM so the server thinks we
 *      switched (mob_equipment carries the full item, player_hotbar covers
 *      protocol versions that gate on the slot-select packet).
 *   3. Send mob_equipment + player_hotbar DOWNSTREAM so the local client
 *      visually shows the held-item swap (otherwise the viewmodel keeps
 *      rendering whatever was held before).
 *
 * Returns the slot if it switched, or -1 if no rid / invalid slot.
 */
function switchTo (player, slot) {
  if (slot < 0 || slot > 8) return -1
  const state = getState(player)
  if (state.rid == null) return -1

  const item = getItem(player, slot)
  const equipItem = buildEquipItem(item)
  state.selectedSlot = slot

  // Upstream: server equipped to this slot
  try {
    player.upstream.queue('player_hotbar', {
      selected_hotbar_slot: slot,
      window_id: 'inventory',
      select_hotbar_slot: true
    })
  } catch (e) {}
  if (equipItem) {
    try {
      player.upstream.queue('mob_equipment', {
        runtime_entity_id: BigInt(state.rid),
        item: equipItem,
        slot,
        selected_slot: slot,
        window_id: 'inventory'
      })
    } catch (e) {}
  }

  // Downstream: client visually updates the held slot + viewmodel
  try {
    player.queue('player_hotbar', {
      selected_hotbar_slot: slot,
      window_id: 'inventory',
      select_hotbar_slot: true
    })
  } catch (e) {}
  if (equipItem) {
    try {
      player.queue('mob_equipment', {
        runtime_entity_id: BigInt(state.rid),
        item: equipItem,
        slot,
        selected_slot: slot,
        window_id: 'inventory'
      })
    } catch (e) {}
  }

  return slot
}

module.exports = {
  setup,
  switchTo,
  getHotbar,
  getSelectedSlot,
  getItem,
  findItemInHotbar,
  buildEquipItem
}
