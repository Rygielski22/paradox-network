'use strict'

const { BIG_TP_BLOCKS } = require('./config')
const { normalizeVarint64, nextTick } = require('../protocol')

function asNum (v) {
  if (v == null) return 0
  return typeof v === 'bigint' ? Number(v) : (Number(v) || 0)
}

function vec3 (v) {
  return { x: asNum(v?.x), y: asNum(v?.y), z: asNum(v?.z) }
}

function cloneVec (v) {
  return { x: v.x, y: v.y, z: v.z }
}

function dist3 (a, b) {
  if (!a || !b) return Infinity
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function isValidDest (dest) {
  if (!dest) return false
  const { x, y, z } = vec3(dest)
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
}

function zeroMotion (auth) {
  if (!auth) return
  if (auth.delta) {
    auth.delta.x = 0
    auth.delta.y = 0
    auth.delta.z = 0
  }
  auth.move_vector = { x: 0, z: 0 }
  auth.raw_move_vector = { x: 0, z: 0 }
  auth.analogue_move_vector = { x: 0, z: 0 }
}

function hasMovementInput (params) {
  if (!params) return false
  const f = params.input_data
  if (f && (
    f.up || f.down || f.left || f.right || f.ascend || f.descend ||
    f.sprint || f.jump || f.sneak || f.sneak_down || f.sneak_current_raw
  )) return true

  const moving = (v) => v && (
    Math.abs(v.x) > 0.02 || Math.abs(v.y) > 0.02 || Math.abs(v.z) > 0.02
  )
  return moving(params.move_vector) || moving(params.raw_move_vector) || moving(params.delta)
}

function resolveRuntimeId (player, override) {
  if (override != null) return override
  return player._runtimeId ||
    player._tpRid ||
    player._disablerRid ||
    player._kaRid ||
    player._smscanRid ||
    player._tpmineRid ||
    player._chestTpRid ||
    player._surfaceTpRid ||
    player._enemyTpRid ||
    player._amRid ||
    null
}

function isBigTeleport (anchor, pos) {
  if (!anchor || !pos) return false
  return Math.abs(pos.x - anchor.x) > BIG_TP_BLOCKS ||
    Math.abs(pos.y - anchor.y) > BIG_TP_BLOCKS ||
    Math.abs(pos.z - anchor.z) > BIG_TP_BLOCKS
}

function burstTick (player, baseTick, step) {
  if (player._disablerEnabled) return 0
  return nextTick(baseTick ?? 0, step)
}

class TpError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'TpError'
    this.code = code
  }
}

module.exports = {
  TpError,
  asNum,
  vec3,
  cloneVec,
  dist3,
  isValidDest,
  zeroMotion,
  hasMovementInput,
  resolveRuntimeId,
  isBigTeleport,
  burstTick
}