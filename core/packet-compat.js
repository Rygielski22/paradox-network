'use strict'

/**
 * Bedrock 1.26.30 packet helpers — ItemNew / ItemV4 shapes and encode sanitizers.
 */

function isItemV4 (o) {
  return o && typeof o === 'object' &&
    'network_id' in o && 'count' in o && 'block_runtime_id' in o &&
    ('extra_data' in o || !('extra' in o))
}

function isItemNew (o) {
  return o && typeof o === 'object' &&
    'network_id' in o && 'count' in o && 'block_runtime_id' in o &&
    ('extra' in o || !('extra_data' in o))
}

/** Legacy Item type (inventory_transaction held_item) — air is just network_id 0. */
function emptyItem () {
  return { network_id: 0 }
}

/**
 * TransactionUseItem.held_item on 1.26.30 is ItemInstanceLegacy (zigzag network_id),
 * not ItemV4 — wrong shape causes silent encode failure or Lifeboat kicks.
 */
function toAttackHeldItem (item) {
  if (!item || !item.network_id) return emptyItem()
  const out = {
    network_id: item.network_id,
    count: item.count || 1,
    metadata: item.metadata || 0,
    has_stack_id: !!item.has_stack_id,
    block_runtime_id: item.block_runtime_id || 0,
    extra_data: Buffer.isBuffer(item.extra_data) ? item.extra_data : Buffer.alloc(0)
  }
  if (out.has_stack_id && item.stack_id !== undefined) out.stack_id = item.stack_id
  return out
}

/** ItemNew for mob_equipment / hotbar (1.26.30). */
function emptyItemNew () {
  return {
    network_id: 0,
    count: 0,
    metadata: 0,
    has_stack_id: false,
    block_runtime_id: 0
  }
}

function normalizeItemNew (item) {
  if (!item || !item.network_id) return emptyItemNew()
  const out = {
    network_id: item.network_id,
    count: item.count || 1,
    metadata: item.metadata || 0,
    has_stack_id: !!item.has_stack_id,
    block_runtime_id: item.block_runtime_id || 0
  }
  if (out.has_stack_id && item.stack_id !== undefined) out.stack_id = item.stack_id
  if (item.extra !== undefined) out.extra = item.extra
  return out
}

/** Ensure ItemV4.extra_data is a Buffer before re-encode (relay patch also does this). */
function sanitizePacketParams (params) {
  if (!params || typeof params !== 'object') return params
  walk(params, new Set())
  return params
}

function walk (obj, seen) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return
  if (Buffer.isBuffer(obj) || ArrayBuffer.isView(obj)) return
  seen.add(obj)

  if (isItemV4(obj) && (obj.extra_data === undefined || obj.extra_data === null)) {
    obj.extra_data = Buffer.alloc(0)
  }

  if (Array.isArray(obj)) {
    for (const v of obj) walk(v, seen)
    return
  }
  for (const v of Object.values(obj)) walk(v, seen)
}

module.exports = {
  isItemV4,
  isItemNew,
  emptyItem,
  emptyItemNew,
  toAttackHeldItem,
  normalizeItemNew,
  sanitizePacketParams
}