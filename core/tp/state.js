'use strict'

const { TIMEOUT_MS } = require('./config')

const PHASE = {
  IDLE: 'idle',
  BURSTING: 'bursting',
  SNAPPING: 'snapping',
  SYNCING: 'syncing',
  GUARDING: 'guarding',
  DONE: 'done'
}

function createIdleState () {
  return {
    active: false,
    phase: PHASE.IDLE,
    sessionId: 0,
    module: null,
    destination: null,
    origin: null,
    runtimeId: null,
    rotation: { pitch: 0, yaw: 0, head_yaw: 0 },
    syncUntil: 0,
    guardUntil: 0,
    relayUntil: 0,
    startedAt: 0,
    lastAuth: null,
    refreshTimer: null,
    timeoutTimer: null,
    syncCompleteTimer: null,
    lastReinforce: 0,
    promise: null
  }
}

function getState (player) {
  if (!player.tpState) player.tpState = createIdleState()
  return player.tpState
}

function isActive (player) {
  const s = getState(player)
  return s.active && s.phase !== PHASE.IDLE && s.phase !== PHASE.DONE
}

function isSyncing (player) {
  const s = getState(player)
  return s.active && s.syncUntil > 0 && Date.now() < s.syncUntil
}

function isGuarding (player) {
  const s = getState(player)
  return s.active && s.guardUntil > 0 && Date.now() < s.guardUntil
}

function setPhase (player, phase) {
  getState(player).phase = phase
}

function beginSession (player, meta) {
  const s = getState(player)
  s.sessionId += 1
  const id = s.sessionId
  const now = Date.now()

  s.active = true
  s.phase = PHASE.BURSTING
  s.module = meta.module || null
  s.destination = meta.destination
  s.origin = meta.origin
  s.runtimeId = meta.runtimeId
  s.rotation = meta.rotation || s.rotation
  s.syncUntil = meta.syncUntil || 0
  s.guardUntil = meta.guardUntil || 0
  s.relayUntil = meta.syncUntil || 0
  s.startedAt = now
  s.lastAuth = meta.lastAuth || null
  s.lastReinforce = 0

  return id
}

function clearTimers (player) {
  const s = getState(player)
  if (s.refreshTimer) {
    clearInterval(s.refreshTimer)
    s.refreshTimer = null
  }
  if (s.timeoutTimer) {
    clearTimeout(s.timeoutTimer)
    s.timeoutTimer = null
  }
  if (s.syncCompleteTimer) {
    clearTimeout(s.syncCompleteTimer)
    s.syncCompleteTimer = null
  }
}

function armTimeout (player, onTimeout) {
  const s = getState(player)
  clearTimeout(s.timeoutTimer)
  s.timeoutTimer = setTimeout(() => {
    if (s.active) onTimeout(s.sessionId)
  }, TIMEOUT_MS)
}

function finishSession (player, sessionId) {
  const s = getState(player)
  if (sessionId != null && s.sessionId !== sessionId) return false
  clearTimers(player)
  s.active = false
  s.phase = PHASE.DONE
  s.promise = null
  return true
}

function reset (player) {
  const s = getState(player)
  const rej = s.promise?.reject
  clearTimers(player)
  Object.assign(s, createIdleState())
  if (rej) {
    try { rej(new Error('TP_RESET')) } catch (_) {}
  }
}

module.exports = {
  PHASE,
  getState,
  isActive,
  isSyncing,
  isGuarding,
  setPhase,
  beginSession,
  clearTimers,
  armTimeout,
  finishSession,
  reset,
  createIdleState
}