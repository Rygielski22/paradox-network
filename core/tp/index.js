'use strict'

/**
 * Meteor Proxy — unified teleport subsystem
 * ==========================================
 *
 * PACKET FLOW (why each step exists)
 * ----------------------------------
 * 1. Cancel prior session — consecutive TPs supersede; avoids mixed anchors.
 * 2. Upstream burst (PlayerAuthInput) — server validates incremental movement;
 *    one jump is rejected on Lifeboat-style AC.
 * 3. Final upstream auth at destination — server authoritative position catch-up.
 * 4. Client MovePlayer (mode=teleport, tick=0) — instant visual snap for client.
 * 5. Tracker update — all module caches read one canonical position.
 * 6. Sync phase (~2s) — pin stationary auth to dest + relay _meteorTp anchor so
 *    raw passthrough cannot leak old coords; ends on movement input.
 * 7. Guard phase (~12s) — block CorrectPlayerMovement / rubber-band MovePlayer
 *    toward origin only; player can move freely.
 *
 * INTERCEPTED
 * -----------
 * - clientbound: correct_player_movement, move_player (setbacks during guard)
 * - serverbound: player_auth_input (pin during sync if stationary)
 *
 * IGNORED
 * -------
 * - unrelated packets
 * - large server teleports (>200 blocks) — dimension/admin TP clears guard
 *
 * POSITION CACHE UPDATES
 * ----------------------
 * - tracker.updateAll on successful snap
 * - sync pin updates _lastRealPos / _kaPos while stationary
 * - modules should use tp.getPosition(), not private fields
 *
 * SYNC END
 * --------
 * - movement input during sync, or SYNC_MS elapsed
 *
 * PREDICTION
 * ----------
 * - client snap @ tick 0 resets client prediction baseline
 * - upstream burst aligns server simulation before live auth resumes
 */

const { getState, reset, isActive, isSyncing, isGuarding } = require('./state')
const { readPosition, updateAll, POSITION_ALIASES } = require('./tracker')
const { handleServerboundAuth } = require('./sync')
const { handleClientbound, isGuarding: guardActive } = require('./guard')
const { teleport, teleportNow, cancel, resolveSession, endSyncOnMovement } = require('./teleport')
const { TpError } = require('./utils')
const CONFIG = require('./config')

let boundPlayers = new WeakSet()

function bind (player) {
  if (boundPlayers.has(player)) return
  boundPlayers.add(player)
  getState(player)

  player.on('clientbound', (data, des) => {
    if (data.name === 'start_game' && data.params?.runtime_entity_id != null) {
      player._tpRid = data.params.runtime_entity_id
      player._runtimeId = data.params.runtime_entity_id
    }
    if (data.name === 'change_dimension' || data.name === 'transfer') {
      cancel(player, 'DIMENSION')
    }
    handleClientbound(player, data, des)
  })

  player.on('serverbound', (data, des) => {
    if (handleServerboundAuth(player, data, des)) return
    if (data.name === 'player_auth_input' && data.params && isSyncing(player)) {
      if (require('./utils').hasMovementInput(data.params)) {
        const s = getState(player)
        const sid = s.sessionId
        endSyncOnMovement(player)
        resolveSession(player, sid)
      }
    }
  })

  player.on('close', () => {
    try { cancel(player, 'DISCONNECT') } catch (_) {}
    reset(player)
  })
}

function isTeleporting (player) {
  return isActive(player)
}

function getPosition (player) {
  return readPosition(player)
}

module.exports = {
  CONFIG,
  TpError,
  bind,
  teleport,
  teleportNow,
  cancel,
  isTeleporting,
  getState,
  getPosition,
  reset,
  updateAll,
  POSITION_ALIASES,
  isSyncing,
  isGuarding: (p) => isGuarding(p) || guardActive(p),
  endSyncOnMovement
}