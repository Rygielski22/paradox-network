'use strict'

/**
 * Legacy facade — all modules should migrate to require('./tp').
 */
const tp = require('./tp')

function bindMeteorTp (player) {
  tp.bind(player)
}

function meteorTp (player, dest, fromPos = null, extra = {}) {
  return tp.teleportNow(player, dest, {
    from: fromPos,
    ...extra
  })
}

function getRid (player) {
  const { resolveRuntimeId } = require('./tp/utils')
  return resolveRuntimeId(player)
}

function updateAllPositions (player, dest) {
  tp.updateAll(player, dest)
}

function getBaseAuth (player, fromPos) {
  const { buildPlayerAuthInput } = require('./protocol')
  const pos = fromPos || tp.getPosition(player) || { x: 0, y: 64, z: 0 }
  return buildPlayerAuthInput(player, {
    position: { x: pos.x, y: pos.y, z: pos.z },
    tick: 0,
    pitch: 0,
    yaw: 0,
    head_yaw: 0,
    input_data: {}
  })
}

module.exports = {
  meteorTp,
  bindMeteorTp,
  updateAllPositions,
  getBaseAuth,
  getRid,
  isFlightActive: () => false,
  anyFlightActive: () => false,
  isCorrectionGuardActive: (p) => tp.isGuarding(p),
  isSyncActive: (p) => tp.isSyncing(p)
}