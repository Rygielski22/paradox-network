'use strict'

function isFlyModuleActive (player) {
  return !!(player._cflyFlying || player._flyFlying || player._noclipFlying || player._speedFlyFlying)
}

function isInstantTpFlying (player) {
  return !!(
    player._surfaceTpPhase === 'flying' ||
    player._smscanPhase === 'flying' ||
    player._chestTpPhase === 'flying' ||
    player._tpminePhase === 'flying' ||
    player._camtpPhase === 'flying' ||
    player._enemyTpPhase === 'flying' ||
    (player._amPhase && player._amPhase !== 'idle')
  )
}

function zeroEntityMotion (player) {
  const rid = player._runtimeId || player._smscanRid || player._surfaceTpRid ||
    player._chestTpRid || player._tpmineRid || player._kaRid
  if (rid == null) return
  const { queueClientMotion } = require('./protocol')
  queueClientMotion(player, {
    runtime_entity_id: rid,
    velocity: { x: 0, y: 0, z: 0 },
    tick: 0
  })
}

function ensureMeteorTpBound (player) {
  try {
    const tp = require('./tp')
    if (tp?.bind) tp.bind(player)
  } catch (_) {}
}

function cancelOtherTpFlights (player, keep) {
  if (keep !== 'surface' && player._surfaceTpPhase === 'flying') {
    player._surfaceTpPhase = 'idle'
    player._surfaceTpTarget = null
  }
  if (keep !== 'smscan' && (player._smscanPhase === 'flying' || player._smscanPhase === 'landed')) {
    player._smscanPhase = 'idle'
    player._smscanTarget = null
    player._smscanTimerState = {}
    player._smscanAnchor = null
    player._smscanLandedUntil = 0
  }
  if (keep !== 'chest' && player._chestTpPhase === 'flying') {
    player._chestTpPhase = 'idle'
    player._chestTpTarget = null
  }
  if (keep !== 'tpmine' && player._tpminePhase === 'flying') {
    player._tpminePhase = 'idle'
    player._tpmineTarget = null
  }
  if (keep !== 'camtp' && (player._camtpPhase === 'flying' || player._camtpPhase === 'freecam')) {
    player._camtpPhase = 'off'
  }
  if (keep !== 'enemytp' && (player._enemyTpPhase === 'flying' || player._enemyTpPhase === 'landed')) {
    player._enemyTpPhase = 'idle'
    player._enemyTpAnchor = null
    player._enemyTpLandedUntil = 0
    player._enemyTpLandGuardUntil = 0
    player._enemyTpBlockCorrectionUntil = 0
  }
  if (keep !== 'automine' && player._amPhase && player._amPhase !== 'idle') {
    player._amPhase = 'idle'
    player._amTarget = null
  }
  if (keep !== 'playercoords' && player._playerCoordsPhase && player._playerCoordsPhase !== 'idle') {
    player._playerCoordsPhase = 'idle'
    player._playerCoordsOrigin = null
    player._playerCoordsScanGen = (player._playerCoordsScanGen || 0) + 1
    player._moduleTpFlight = false
  }
}

function prepareInstantTp (player, keep) {
  ensureMeteorTpBound(player)
  cancelOtherTpFlights(player, keep)

  player._flyFlying = false
  player._cflyFlying = false
  player._noclipFlying = false
  player._speedFlyFlying = false
  player._flyLandGuardUntil = 0
  player._cflyLandGuardUntil = 0
  player._noclipLandGuardUntil = 0
  player._speedFlyLandGuardUntil = 0
  player._speedFlyVirtualTicks = null
  player._disablerWasFlying = false

  player._killauraGuardUntil = 0
  player._smscanActive = false
  player._scanning = false
  player._tpFlying = false
  player._reachActive = false

  try {
    const tp = require('./tp')
    if (tp?.cancel) tp.cancel(player, 'PREP')
  } catch (_) {}

  zeroEntityMotion(player)
  stripFlyForTp(player)
}

function stripFlyForTp (player) {
  const rid = player._runtimeId || player._smscanRid || player._surfaceTpRid ||
    player._chestTpRid || player._tpmineRid || player._disablerRid
  if (!rid) return
  try {
    player.queue('update_abilities', {
      entity_unique_id: BigInt(rid),
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [{
        type: 'base',
        allowed: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: false, may_fly: false,
          instant_build: false, lightning: false, fly_speed: false, walk_speed: true,
          muted: false, world_builder: false, no_clip: false, privileged_builder: false
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: false, may_fly: false,
          instant_build: false, lightning: false, fly_speed: false, walk_speed: true,
          muted: false, world_builder: false, no_clip: false, privileged_builder: false
        },
        fly_speed: 0.05000000074505806,
        vertical_fly_speed: 0.05000000074505806,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}

function scheduleReleaseInstantTp (player) {
  setImmediate(() => {
    try { releaseInstantTp(player) } catch (_) {}
  })
}

/** End sync/guard pinning immediately after instant module TPs land. */
function releaseInstantTp (player) {
  try {
    const { endSync, clearRelayAnchor } = require('./tp/sync')
    const { getState, clearTimers, finishSession } = require('./tp/state')
    endSync(player)
    clearRelayAnchor(player)
    const s = getState(player)
    if (!s.active) return
    s.guardUntil = 0
    s.syncUntil = 0
    s.relayUntil = 0
    clearTimers(player)
    finishSession(player, s.sessionId)
  } catch (_) {}
}

module.exports = {
  isFlyModuleActive,
  isInstantTpFlying,
  prepareInstantTp,
  releaseInstantTp,
  scheduleReleaseInstantTp,
  zeroEntityMotion,
  cancelOtherTpFlights,
  stripFlyForTp,
  ensureMeteorTpBound
}