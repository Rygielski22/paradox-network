'use strict'

const { syncPlayerRids, restoreCombatAfterRespawn } = require('./player-rid')

/**
 * Death/respawn — pause in-flight movement/TP/combat, keep module enabled flags.
 * Prevents desync from stale pre-death coords without toggling modules off.
 */

function cancelTpSession (player) {
  try {
    const tp = require('./tp')
    tp.cancel(player, 'DEATH')
    tp.reset(player)
  } catch (_) {}
}

function pauseScanFlight (player) {
  if (!player._smscanActive && !(player._smscanPhase && player._smscanPhase !== 'idle')) return
  player._smscanActive = false
  player._smscanPhase = 'idle'
  player._smscanTarget = null
  player._smscanTimerState = {}
  player._smscanLandGuardUntil = 0
  player._smscanAnchor = null
  player._smscanLandedUntil = 0
  try {
    const { zeroEntityMotion, stripFlyForTp } = require('./tp-prep')
    zeroEntityMotion(player)
    stripFlyForTp(player)
  } catch (_) {}
}

function pauseMovementPhases (player) {
  player._flyFlying = false
  player._flyLandGuardUntil = 0
  player._noclipFlying = false
  player._noclipLandGuardUntil = 0
  try {
    const { landSpeedFly } = require('../modules/speedfly')
    if (player._speedFlyFlying && landSpeedFly) landSpeedFly(player)
  } catch (_) {
    player._speedFlyFlying = false
    player._speedFlyLandGuardUntil = 0
    player._speedFlyVirtualTicks = null
  }
  player._cflyFlying = false
  player._cflyLandGuardUntil = 0
  player._scanning = false
  player._tpFlying = false
  player._reachActive = false
  player._killauraGuardUntil = 0
  player._killauraPhase = 'idle'
  player._killauraBusy = false
  player._killauraPauseUntil = 0
  player._enemyTpPhase = 'idle'
  player._enemyTpGoal = null
  player._enemyTpAnchor = null
  player._enemyTpLandedUntil = 0
  player._enemyTpLandGuardUntil = 0
  player._enemyTpBlockCorrectionUntil = 0
  player._csStealing = false
  player._disablerWasFlying = false
  player._containerBurstUntil = 0
  player._chestTpGraceUntil = 0
  player._chestTpLandGuardUntil = 0
  player._tpmineBlockCorrectionUntil = 0
  player._tpauraBurst = null

  if (player._playerTpPhase && player._playerTpPhase !== 'idle') {
    player._playerTpPhase = 'idle'
    player._playerTpTarget = null
  }
  if (player._playerCoordsPhase && player._playerCoordsPhase !== 'idle') {
    player._playerCoordsPhase = 'idle'
    player._playerCoordsOrigin = null
    player._playerCoordsScanGen = (player._playerCoordsScanGen || 0) + 1
    player._moduleTpFlight = false
  }
  if (player._chestTpPhase && player._chestTpPhase !== 'idle') {
    player._chestTpPhase = 'idle'
    player._chestTpTarget = null
    player._chestTpBlockCorrectionUntil = 0
  }
  if (player._camtpPhase && player._camtpPhase !== 'off') {
    player._camtpPhase = 'off'
    player._camtpPos = null
    player._camtpHome = null
  }
  if (player._surfaceTpPhase && player._surfaceTpPhase !== 'idle') {
    player._surfaceTpPhase = 'idle'
    player._surfaceTpTarget = null
    player._surfaceTpBlockCorrectionUntil = 0
  }
  if (player._tpminePhase && player._tpminePhase !== 'idle') {
    player._tpminePhase = 'idle'
    player._tpmineTarget = null
    player._tpmineBlockCorrectionUntil = 0
  }

  pauseScanFlight(player)

  if (player._amPhase && player._amPhase !== 'idle') {
    try {
      const { pauseAutomine } = require('../modules/automine')
      pauseAutomine(player)
    } catch (_) {
      try {
        const { pauseAutomine } = require('./automine/orchestrator')
        pauseAutomine(player)
      } catch (__) {
        player._amPhase = 'idle'
        player._amTpBusy = false
      }
    }
  }

  try {
    const { finishVisitOff } = require('./visit-frame')
    finishVisitOff(player)
  } catch (_) {}
}

function clearStalePositions (player) {
  player._kaPos = null
  player._killauraPos = null
  player._lastRealPos = null
  player._amPos = null
  player._amMineAnchor = null
  player._lastPosition = null
  if (player._kaLastAuth) {
    player._kaLastAuth = { ...player._kaLastAuth, position: undefined }
  }
}

function onPlayerDeath (player) {
  player._meteorDead = true
  player._meteorDeadAt = Date.now()
  cancelTpSession(player)
  pauseMovementPhases(player)
  clearStalePositions(player)
  try {
    const { saveCombatWantFlags } = require('./player-rid')
    saveCombatWantFlags(player)
  } catch (_) {}
}

function seedPositionsFromRespawn (player, params) {
  if (!params?.position) return
  const pos = {
    x: params.position.x,
    y: params.position.y,
    z: params.position.z
  }
  player._kaPos = { ...pos }
  player._killauraPos = { ...pos }
  player._lastRealPos = { ...pos }
  player._amPos = { ...pos }
  player._lastPosition = { ...pos }
  player._lastPos = { ...pos }
  if (player._kaLastAuth) {
    player._kaLastAuth = { ...player._kaLastAuth, position: { ...pos } }
  }
}

function resumeKillauraAfterRespawn (player) {
  player._killauraBusy = false
  player._killauraPhase = 'idle'
  player._killauraGuardUntil = 0
  player._killauraPauseUntil = 0
  player._kaAttackTick = 0
  player._kaLastAttack = 0
  player._combatPauseUntil = 0
  try {
    const { resetKaEntityFreshness } = require('./ka-entities')
    resetKaEntityFreshness(player)
  } catch (_) {}
}

const RESPAWN_DEDUP_MS = 800

function onPlayerRespawn (player, params) {
  player._meteorDead = false
  player._meteorDeadAt = 0

  if (params?.runtime_entity_id != null) {
    syncPlayerRids(player, params.runtime_entity_id)
  }
  seedPositionsFromRespawn(player, params)

  pauseMovementPhases(player)
  resumeKillauraAfterRespawn(player)
  restoreCombatAfterRespawn(player)

  if (player._automineEnabled) {
    try {
      const { resumeAutomineAfterRespawn } = require('../modules/automine')
      resumeAutomineAfterRespawn(player)
    } catch (_) {
      try {
        const { resumeAutomineAfterRespawn } = require('./automine/orchestrator')
        resumeAutomineAfterRespawn(player)
      } catch (__) {}
    }
  }
}

/** Respawn + player_spawn — deduped so KillAura/combat resume once per death. */
function handlePlayerRespawn (player, params = {}) {
  const now = Date.now()
  const duplicate = player._respawnHandledAt && now - player._respawnHandledAt < RESPAWN_DEDUP_MS

  if (!duplicate) {
    player._respawnHandledAt = now
    onPlayerRespawn(player, params)
    return
  }

  player._meteorDead = false
  player._meteorDeadAt = 0
  if (params?.runtime_entity_id != null) {
    syncPlayerRids(player, params.runtime_entity_id)
  }
  if (params?.position) {
    seedPositionsFromRespawn(player, params)
  }
  resumeKillauraAfterRespawn(player)
  restoreCombatAfterRespawn(player)
}

function isPlayerDead (player) {
  return !!player._meteorDead
}

module.exports = {
  onPlayerDeath,
  onPlayerRespawn,
  handlePlayerRespawn,
  isPlayerDead,
  resumeKillauraAfterRespawn,
  pauseMovementPhases,
  pauseScanFlight,
  clearStalePositions,
  cancelTpSession
}