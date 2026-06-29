'use strict'

/**
 * Bedrock varint64 on the wire — protodef coerces via BigInt(value).
 * We keep ticks/entity ids as JS Number when safe (NOT bigint literals).
 */

function normalizeVarint64 (value) {
  if (value == null) return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0
    return value
  }
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : Number(value & 0x1fffffffffffffn)
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function nextTick (base, step = 1) {
  return normalizeVarint64(normalizeVarint64(base) + step)
}

module.exports = { normalizeVarint64, nextTick }