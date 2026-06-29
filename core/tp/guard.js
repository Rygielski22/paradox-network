'use strict'

const { SETBACK_EPS, REINFORCE_COOLDOWN_MS, GUARD_MS } = require('./config')
const { dist3, isBigTeleport } = require('./utils')
const { sendClientMovePlayer } = require('./packets')
const { isCorrectionPacket } = require('../protocol')
const { getState, isGuarding, isSyncing, reset, PHASE, setPhase } = require('./state')

function isSetback (state, pos) {
  if (!state?.destination || !pos) return true
  if (!state.origin) return true
  const toDest = dist3(pos, state.destination)
  const toFrom = dist3(pos, state.origin)
  return toFrom + SETBACK_EPS < toDest
}

function shouldBlockClientbound (player, data) {
  const s = getState(player)
  if (!isGuarding(player)) return false

  const name = data?.name
  if (name !== 'move_player' && !isCorrectionPacket(name)) return false

  const pos = data.params?.position
  if (pos && isBigTeleport(s.destination, pos)) {
    reset(player)
    return false
  }

  if (isCorrectionPacket(name)) {
    return isSetback(s, pos)
  }

  if (name === 'move_player' && data.params) {
    const rid = data.params.runtime_id
    const myRid = s.runtimeId ?? player._disablerRid ?? player._runtimeId
    if (rid == null || myRid == null || String(rid) !== String(myRid)) return false
    return isSetback(s, pos)
  }

  return false
}

function reinforceSnap (player) {
  const s = getState(player)
  if (!s.destination || s.runtimeId == null) return
  const now = Date.now()
  if (s.lastReinforce && now - s.lastReinforce < REINFORCE_COOLDOWN_MS) return
  s.lastReinforce = now
  sendClientMovePlayer(player, s.runtimeId, s.destination, s.rotation, true)
}

function handleClientbound (player, data, des) {
  if (!shouldBlockClientbound(player, data)) return false
  des.canceled = true
  reinforceSnap(player)
  return true
}

function armGuard (player) {
  const s = getState(player)
  s.guardUntil = Date.now() + GUARD_MS
  setPhase(player, PHASE.GUARDING)
}

function onGuardTick (player) {
  const s = getState(player)
  if (!s.active) return
  if (Date.now() >= s.guardUntil && !isSyncing(player)) {
    setPhase(player, PHASE.DONE)
    s.active = false
  }
}

module.exports = {
  armGuard,
  shouldBlockClientbound,
  handleClientbound,
  isSetback,
  isGuarding,
  onGuardTick
}