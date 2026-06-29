'use strict'

const { SYNC_MS } = require('./config')
const { TpError, isValidDest, resolveRuntimeId, vec3 } = require('./utils')
const { runBurst } = require('./burst')
const { sendClientMovePlayer } = require('./packets')
const { updateAll, readPosition } = require('./tracker')
const { startSync, endSync, clearRelayAnchor } = require('./sync')
const { armGuard } = require('./guard')
const {
  getState,
  beginSession,
  armTimeout,
  clearTimers,
  finishSession,
  reset,
  setPhase,
  PHASE
} = require('./state')

function validateRequest (player, dest, options) {
  if (!player) throw new TpError('NO_PLAYER', 'Player is required')
  if (!isValidDest(dest)) throw new TpError('INVALID_DEST', 'Invalid destination')
  const rid = resolveRuntimeId(player, options.rid)
  if (rid == null) throw new TpError('NO_RID', 'Missing runtime entity id')
  if (options.requireUpstream !== false && !player.upstream) {
    throw new TpError('NO_UPSTREAM', 'Upstream connection not ready')
  }
  return rid
}

function cancel (player, reason = 'CANCELLED') {
  const s = getState(player)
  if (!s.active) return false
  const rej = s.promise?.reject
  const sessionId = s.sessionId
  clearTimers(player)
  clearRelayAnchor(player)
  reset(player)
  if (rej) {
    try { rej(new TpError('CANCELLED', reason)) } catch (_) {}
  }
  return sessionId
}

function resolveSession (player, sessionId) {
  const s = getState(player)
  if (s.sessionId !== sessionId) return
  const resolve = s.promise?.resolve
  finishSession(player, sessionId)
  if (resolve) {
    try { resolve({ destination: s.destination, sessionId }) } catch (_) {}
  }
}

function scheduleSyncComplete (player, sessionId) {
  const s = getState(player)
  if (s.syncCompleteTimer) clearTimeout(s.syncCompleteTimer)
  s.syncCompleteTimer = setTimeout(() => {
    if (s.sessionId !== sessionId) return
    endSync(player)
    resolveSession(player, sessionId)
  }, SYNC_MS)
}

function runTeleport (player, dest, options = {}) {
  const destination = vec3(dest)
  const rid = validateRequest(player, dest, options)

  if (options.cancelPrevious !== false) {
    cancel(player, 'SUPERSEDED')
  }

  const origin = vec3(
    options.from ||
    options.fromPos ||
    options.authParams?.position ||
    readPosition(player) ||
    destination
  )

  const rotation = {
    pitch: options.pitch ?? options.authParams?.pitch ?? player._kaLastAuth?.pitch ?? 0,
    yaw: options.yaw ?? options.authParams?.yaw ?? player._kaLastAuth?.yaw ?? 0,
    head_yaw: options.head_yaw ?? options.authParams?.head_yaw ?? player._kaLastAuth?.head_yaw ?? 0
  }

  const { buildPlayerAuthInput } = require('../protocol')
  const authBase = options.authParams || player._kaLastAuth ||
    buildPlayerAuthInput(player, {
      position: origin,
      tick: 0,
      pitch: rotation.pitch,
      yaw: rotation.yaw,
      head_yaw: rotation.head_yaw,
      input_data: {}
    })

  const sessionId = beginSession(player, {
    module: options.module || options.moduleKey || null,
    destination,
    origin,
    runtimeId: rid,
    rotation,
    lastAuth: authBase
  })

  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  getState(player).promise = { resolve, reject, promise }

  armTimeout(player, (id) => {
    if (id !== sessionId) return
    cancel(player, 'TIMEOUT')
    try { reject(new TpError('TIMEOUT', 'Teleport timed out')) } catch (_) {}
  })

  try {
    if (options.burst !== false) {
      runBurst(player, origin, destination, authBase)
    }

    setPhase(player, PHASE.SNAPPING)
    sendClientMovePlayer(
      player,
      rid,
      destination,
      rotation,
      options.onGround !== undefined ? !!options.onGround : true
    )

    updateAll(player, destination, {
      authParams: options.authParams,
      onGround: options.onGround
    })

    startSync(player)
    armGuard(player)
    scheduleSyncComplete(player, sessionId)

    if (typeof options.onArrive === 'function') {
      try { options.onArrive(destination) } catch (_) {}
    }

    return { promise, sessionId }
  } catch (e) {
    cancel(player, 'FAILED')
    throw e
  }
}

async function teleport (player, dest, options = {}) {
  const { promise } = runTeleport(player, dest, options)
  return promise
}

function teleportNow (player, dest, options = {}) {
  try {
    runTeleport(player, dest, options)
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  teleport,
  teleportNow,
  cancel,
  runTeleport,
  resolveSession,
  endSyncOnMovement: endSync
}