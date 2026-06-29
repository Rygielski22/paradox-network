'use strict'

const { SYNC_MS, SYNC_REFRESH_MS, RELAY_ANCHOR_KEY } = require('./config')
const { hasMovementInput } = require('./utils')
const { buildAuthFromPlayer, queueUpstreamAuth, applyAuthPin, markReserialize } = require('./packets')
const { getState, setPhase, clearTimers, isSyncing, PHASE } = require('./state')
const { updateAll } = require('./tracker')

function setRelayAnchor (player, dest, until) {
  if (!dest || !until || Date.now() >= until) {
    player[RELAY_ANCHOR_KEY] = null
    return
  }
  player[RELAY_ANCHOR_KEY] = {
    dest: { x: dest.x, y: dest.y, z: dest.z },
    until
  }
}

function clearRelayAnchor (player) {
  player[RELAY_ANCHOR_KEY] = null
}

function pushAnchor (player) {
  const s = getState(player)
  if (!s.destination || !isSyncing(player)) return
  const auth = s.lastAuth || {}
  queueUpstreamAuth(player, buildAuthFromPlayer(player, auth, s.destination, auth.tick ?? 0, true))
  setRelayAnchor(player, s.destination, s.relayUntil)
}

function endSync (player) {
  const s = getState(player)
  s.syncUntil = 0
  s.relayUntil = 0
  clearRelayAnchor(player)
  if (s.refreshTimer) {
    clearInterval(s.refreshTimer)
    s.refreshTimer = null
  }
  if (Date.now() < s.guardUntil) {
    setPhase(player, PHASE.GUARDING)
  }
}

function startSync (player) {
  const s = getState(player)
  const now = Date.now()
  s.syncUntil = now + SYNC_MS
  s.relayUntil = s.syncUntil
  setPhase(player, PHASE.SYNCING)
  setRelayAnchor(player, s.destination, s.relayUntil)

  pushAnchor(player)

  if (s.refreshTimer) clearInterval(s.refreshTimer)
  s.refreshTimer = setInterval(() => {
    if (!isSyncing(player)) {
      endSync(player)
      return
    }
    pushAnchor(player)
  }, SYNC_REFRESH_MS)
}

/**
 * During sync: pin stationary auth to destination so relay raw passthrough
 * cannot leak the pre-TP position to the server.
 */
function handleServerboundAuth (player, data, des) {
  const s = getState(player)
  if (!isSyncing(player) || data.name !== 'player_auth_input' || !data.params?.position) {
    return false
  }

  if (hasMovementInput(data.params)) {
    endSync(player)
    return false
  }

  applyAuthPin(data.params, s.destination, player)
  updateAll(player, s.destination)
  setRelayAnchor(player, s.destination, s.relayUntil)
  markReserialize(des)
  return true
}

module.exports = {
  startSync,
  endSync,
  pushAnchor,
  handleServerboundAuth,
  setRelayAnchor,
  clearRelayAnchor,
  isSyncing
}