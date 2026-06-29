'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { isFlyModuleActive, isInstantTpFlying } = require('../core/tp-prep')
const { isVisitGuard, isVisitEnabled, shouldBlockVisitCorrection } = require('../core/visit-frame')
const { syncPlayerRids } = require('../core/player-rid')
const { onPlayerDeath, handlePlayerRespawn, isPlayerDead } = require('../core/death-resync')
const {
  initDisabler2,
  handleLatencyClientbound,
  shouldCancelBurstVelocity,
  flushLatencyQueue
} = require('../core/disabler2')

// Brief raw-passthrough burst so chest open packets keep real ticks without
// exposing movement long enough for Lifeboat AC to kick.
const CONTAINER_BURST_MS = 350
const CONTAINER_BURST_EXTEND_MS = 200

const BREAK_ACTION_RE = /break|crack|predict|abort|continue/i

function airjumpBurstActive (player) {
  return !!(
    player._airjumpEnabled &&
    player._airjumpGuardUntil &&
    Date.now() < player._airjumpGuardUntil
  )
}

function killauraBurstActive (player) {
  if (!player._killauraEnabled) return false
  const phase = player._killauraPhase || 'idle'
  return phase === 'going' || phase === 'attacking' || phase === 'returning'
}

function auraBurstActive (player) {
  const now = Date.now()
  return !!(
    killauraBurstActive(player) ||
    player._tpauraBurst ||
    (player._visitOwnsGuard && player._visitGuardUntil && now < player._visitGuardUntil)
  )
}

function inTpCorrectionGuard (player) {
  try {
    const tp = require('../core/tp')
    if (tp?.isGuarding) return tp.isGuarding(player)
  } catch (_) {}
  return false
}

function inTpSyncActive (player) {
  try {
    const tp = require('../core/tp')
    if (tp?.isSyncing) return tp.isSyncing(player)
  } catch (_) {}
  return false
}

function shouldBlockAuraBurstCorrection (player, data) {
  if (!killauraBurstActive(player) || !data?.name) return false
  const { isCorrectionPacket } = require('../core/protocol')
  if (isCorrectionPacket(data.name)) return true
  if (data.name !== 'move_player' || !data.params) return false

  const rid = data.params.runtime_id
  const myRid = player._disablerRid || player._runtimeId
  if (rid == null || myRid == null || String(rid) !== String(myRid)) return false

  const live = player._killauraPos || player._kaPos
  const p = data.params.position
  if (!live || !p) return true

  const big = Math.abs(p.x - live.x) > 200 ||
              Math.abs(p.y - live.y) > 200 ||
              Math.abs(p.z - live.z) > 200
  return !big
}

// Modules that need auth_input tick=0 (AC bypass). Passive tweaks (haste/noslow/
// nofall/fullbright) are excluded — they don't need tick zero and must NOT
// trigger fly abilities.
function movementActive (player) {
  return !!(
    player._flyFlying || player._noclipFlying || player._cflyFlying || player._speedFlyFlying ||
    player._speedEnabled || player._phaseEnabled ||
    player._antihitEnabled ||
    airjumpBurstActive(player) ||
    player._camtpPhase === 'flying' || player._camtpPhase === 'freecam' ||
    player._playerTpPhase === 'flying' || player._playerTpPhase === 'scanning' ||
    player._tpminePhase === 'flying' ||
    player._chestTpPhase === 'flying' || player._chestTpPhase === 'landed' ||
    player._surfaceTpPhase === 'flying' ||
    player._smscanActive ||
    player._smscanPhase === 'scanning' ||
    player._smscanPhase === 'flying' || player._smscanPhase === 'landed' || player._smscanPhase === 'waiting' ||
    (player._automineEnabled && player._amTpBusy) ||
    (player._automineEnabled && player._amPhase === 'cluster') ||
    (player._automineEnabled && player._amPhase === 'pickup') ||
    player._tpFlying || player._scanning || player._infauraEnabled ||
    killauraBurstActive(player) ||
    (player._visitOwnsGuard && player._visitGuardUntil && Date.now() < player._visitGuardUntil) ||
    player._enemyTpPhase === 'flying' ||
    inEnemyTpBlockCorrection(player) ||
    player._playerCoordsPhase === 'scanning' ||
    player._playerCoordsPhase === 'returning' ||
    player._moduleTpFlight ||
    (player._visitEnabled && (player._visitAuto || isVisitGuard(player)))
  )
}

// Only these should receive update_abilities with flying=true.
function shouldGrantFly (player) {
  if (isInstantTpFlying(player) && !player._moduleTpFlight) return false
  return !!(
    player._moduleTpFlight ||
    player._cflyFlying || player._flyFlying || player._noclipFlying || player._speedFlyFlying ||
    player._antihitEnabled ||
    player._camtpPhase === 'flying' || player._camtpPhase === 'freecam' ||
    player._playerTpPhase === 'flying' || player._playerTpPhase === 'scanning' ||
    player._tpminePhase === 'flying' ||
    player._surfaceTpPhase === 'flying' ||
    player._smscanActive ||
    player._smscanPhase === 'scanning' ||
    player._smscanPhase === 'flying' || player._smscanPhase === 'landed' || player._smscanPhase === 'waiting' ||
    player._playerCoordsPhase === 'scanning' ||
    player._playerCoordsPhase === 'returning'
  )
}

function isBreakBlockAction (data) {
  const ba = data.params?.block_action
  if (!Array.isArray(ba) || !ba.length) return false
  return ba.some(a => a.action && BREAK_ACTION_RE.test(String(a.action)))
}

function isOpenBlockAction (data) {
  const ba = data.params?.block_action
  if (!Array.isArray(ba) || !ba.length) return false
  return ba.some(a => a.action && !BREAK_ACTION_RE.test(String(a.action)))
}

function isInteractionAuthInput (data) {
  const flags = data.params?.input_data
  if (flags && (
    flags.item_interact || flags.item_stack_request || flags.start_using_item ||
    flags.using_item || flags.continue_using_item ||
    flags.released_using_item || flags.released_item_use ||
    flags.item_use
  )) return true
  if (data.params?.item_stack_request || data.params?.transaction) return true
  return isOpenBlockAction(data)
}

function isContainerInteraction (data) {
  if (!data || !data.params) return false
  if (data.name === 'item_stack_request') return true
  if (data.name === 'inventory_transaction') {
    const tx = data.params.transaction
    if (!tx) return false
    const type = String(tx.transaction_type || '')
    if (type === 'item_use' || type === 'item_release' || type === 'item_use_on_entity') return true
    const td = tx.transaction_data
    if (td && td.action_type && /use|click|open/i.test(String(td.action_type))) return true
  }
  if (data.name === 'player_auth_input') return isInteractionAuthInput(data)
  return false
}

function inContainerBurst (player) {
  return player._containerBurstUntil && Date.now() < player._containerBurstUntil
}

function inChestTpGrace (player) {
  return player._chestTpGraceUntil && Date.now() < player._chestTpGraceUntil
}

function inChestTpLandGuard (player) {
  return player._chestTpLandGuardUntil && Date.now() < player._chestTpLandGuardUntil
}



function inModuleTpHold (player) {
  return !!(player._moduleTpHoldUntil && Date.now() < player._moduleTpHoldUntil)
}

function inCflyLandGuard (player) {
  return player._cflyLandGuardUntil && Date.now() < player._cflyLandGuardUntil
}

function inFlyLandGuard (player) {
  return player._flyLandGuardUntil && Date.now() < player._flyLandGuardUntil
}

function inNoclipLandGuard (player) {
  return player._noclipLandGuardUntil && Date.now() < player._noclipLandGuardUntil
}

function inSmscanLandGuard (player) {
  return player._smscanLandGuardUntil && Date.now() < player._smscanLandGuardUntil
}

function inEnemyTpLandGuard (player) {
  return player._enemyTpLandGuardUntil && Date.now() < player._enemyTpLandGuardUntil
}

function inEnemyTpBlockCorrection (player) {
  return player._enemyTpBlockCorrectionUntil && Date.now() < player._enemyTpBlockCorrectionUntil
}

function inPlayerCoordsBlockCorrection (player) {
  return player._playerCoordsBlockCorrectionUntil && Date.now() < player._playerCoordsBlockCorrectionUntil
}

function inKillAuraGuard (player) {
  return player._killauraGuardUntil && Date.now() < player._killauraGuardUntil
}

function inLandGuard (player) {
  return inCflyLandGuard(player) || inFlyLandGuard(player) || inNoclipLandGuard(player) ||
    inSmscanLandGuard(player) || inChestTpLandGuard(player) ||
    inEnemyTpLandGuard(player) || inEnemyTpBlockCorrection(player) ||
    inPlayerCoordsBlockCorrection(player)
}

function shouldBlockCorrections (player) {
  return movementActive(player) || inLandGuard(player) || inKillAuraGuard(player) ||
    inChestTpGrace(player) ||
    inModuleTpHold(player) || inTpCorrectionGuard(player)
}

function shouldZeroTicks (player) {
  return movementActive(player) || inChestTpGrace(player) ||
    inModuleTpHold(player) || inChestTpLandGuard(player) ||
    inCflyLandGuard(player) || inFlyLandGuard(player) || inNoclipLandGuard(player) ||
    inEnemyTpLandGuard(player) || inEnemyTpBlockCorrection(player) ||
    inPlayerCoordsBlockCorrection(player) ||
    inTpSyncActive(player) ||
    (player._disablerEnabled && player._cflyEnabled) ||
    (player._disablerEnabled && player._noclipEnabled)
}

function armContainerBurst (player, des, extraMs = 0) {
  const until = Date.now() + CONTAINER_BURST_MS + extraMs
  if (!player._containerBurstUntil || until > player._containerBurstUntil) {
    player._containerBurstUntil = until
  }
  if (des) des._meteorRawPassthrough = true
}

module.exports = {
  name: 'LifeboatMode',
  description: 'Lifeboat AC bypass (tick zero exploit)',

  onPlayer (player, relay) {
    if (player._disablerEnabled === undefined) player._disablerEnabled = true
    player._disablerRid = null
    initDisabler2(player)

    player.on('clientbound', (data, des) => {
      const n = data?.name
      if (!n) return

      if (n === 'network_stack_latency') {
        handleLatencyClientbound(player, data, des)
        return
      }

      if (shouldCancelBurstVelocity(player) &&
          n === 'set_entity_motion' && data.params) {
        const rid = data.params.runtime_entity_id
        const myRid = player._disablerRid || player._runtimeId
        if (rid != null && myRid != null && String(rid) === String(myRid)) {
          des.canceled = true
          return
        }
      }

      if (n !== 'start_game' && n !== 'entity_event' && n !== 'set_health' && n !== 'respawn' &&
          n !== 'play_status' &&
          n !== 'container_open' && n !== 'inventory_content' && n !== 'item_stack_response' &&
          n !== 'correct_player_movement' && n !== 'move_player') {
        return
      }
      if (data.name === 'start_game' && data.params) {
        player._disablerRid = data.params.runtime_entity_id
      }
      if (data.name === 'entity_event' && data.params) {
        if (data.params.event_id === 'death_smoke_cloud' && String(data.params.runtime_entity_id) === String(player._disablerRid)) {
          pauseMovementOnDeath(player)
        }
      }
      if (data.name === 'set_health' && data.params && data.params.health <= 0) {
        pauseMovementOnDeath(player)
      }
      if (data.name === 'respawn') {
        handlePlayerRespawn(player, data.params)
        stripFlyAbilities(player)
      }

      if (data.name === 'play_status' && data.params?.status === 'player_spawn' && isPlayerDead(player)) {
        handlePlayerRespawn(player, {
          runtime_entity_id: player._runtimeId || player._disablerRid,
          position: player._lastPos || player._kaPos || player._killauraPos
        })
        stripFlyAbilities(player)
      }

      if (data.name === 'container_open' || data.name === 'inventory_content' || data.name === 'item_stack_response') {
        armContainerBurst(player, null, CONTAINER_BURST_EXTEND_MS)
      }

      if (!player._disablerEnabled) return

      if (shouldBlockAuraBurstCorrection(player, data)) {
        des.canceled = true
        return
      }

      if ((isVisitEnabled(player) || isVisitGuard(player)) && shouldBlockVisitCorrection(player, data)) {
        des.canceled = true
        return
      }

      // Aura burst uses live-relative filtering above — skip blanket move_player cancel.
      if (data.name === 'move_player' && auraBurstActive(player)) {
        return
      }

      if (!shouldBlockCorrections(player)) return
      if (data.name === 'correct_player_movement') {
        des.canceled = true
        return
      }
      if (data.name === 'move_player' && data.params) {
        const rid = data.params.runtime_id
        if (rid != null && player._disablerRid != null && String(rid) === String(player._disablerRid)) {
          try {
            const { isAllowedPositionSync } = require('../core/automine/client-snap')
            if (isAllowedPositionSync(player, data.params.position)) return
          } catch (e) {}
          des.canceled = true
        }
      }
    })

    player.on('serverbound', (data, des) => {
      if (!player._disablerEnabled) return

      if (isContainerInteraction(data)) {
        armContainerBurst(player, des)
        if (data.name !== 'player_auth_input') {
          if (des) des._meteorRawPassthrough = true
          return
        }
        if (!shouldZeroTicks(player)) return
      }

      if (data.name !== 'player_auth_input') return

      if (isInteractionAuthInput(data)) {
        armContainerBurst(player, des)
        if (!shouldZeroTicks(player)) return
      }

      // Interactions/chests need real ticks when idle — never while fly/cfly is active.
      // Mining block_action still uses tick=0 below.
      const useRealTicks = (inContainerBurst(player) || isInteractionAuthInput(data)) &&
        !isBreakBlockAction(data) &&
        !isFlyModuleActive(player) &&
        !player._cflyEnabled && !inCflyLandGuard(player) &&
        !player._noclipEnabled && !inNoclipLandGuard(player) &&
        player._chestTpPhase !== 'flying' && player._chestTpPhase !== 'landed' &&
        player._tpminePhase !== 'flying' &&
        !inChestTpGrace(player) && !inChestTpLandGuard(player)

      if (useRealTicks) {
        if (des) des._meteorRawPassthrough = true
        return
      }

      if (!shouldZeroTicks(player)) {
        if (player._disablerWasFlying) {
          player._disablerWasFlying = false
          stripFlyAbilities(player)
        }
        return
      }

      const { applyAuthPatch, ensureAuthEncodeShape } = require('../core/protocol')
      applyAuthPatch(data.params, { tick: 0 }, player)
      ensureAuthEncodeShape(data.params)

      if (player._cflyFlying) {
        player._disablerWasFlying = true
        if (!player._disablerAbilitiesTick) player._disablerAbilitiesTick = 0
        player._disablerAbilitiesTick++
        if (player._disablerAbilitiesTick % 2 === 0) sendKeepCfly(player)
        return
      }

      if (player._noclipFlying) {
        player._disablerWasFlying = true
        sendKeepNoclip(player)
        return
      }

      if (player._flyFlying) {
        player._disablerWasFlying = true
        if (!player._disablerAbilitiesTick) player._disablerAbilitiesTick = 0
        player._disablerAbilitiesTick++
        if (player._disablerAbilitiesTick % 2 === 0) sendKeepFly(player)
        return
      }

      if (!shouldGrantFly(player)) {
        if (player._disablerWasFlying) {
          player._disablerWasFlying = false
          stripFlyAbilities(player)
        }
        return
      }

      player._disablerWasFlying = true
      if (!player._disablerAbilitiesTick) player._disablerAbilitiesTick = 0
      player._disablerAbilitiesTick++
      if (player._disablerAbilitiesTick % 2 === 0) {
        sendGrantFly(player)
      }
    })
  },

  onEnable (relay) {
    const handler = (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') {
        player._disablerEnabled = true
        initDisabler2(player)
        sendMessage(player, theme.toggle('LifeboatMode', true, '— Lifeboat AC bypass active'))
      } else if (arg === 'off') {
        player._disablerEnabled = false
        player._disablerWasFlying = false
        flushLatencyQueue(player)
        stripFlyAbilities(player)
        sendMessage(player, theme.toggle('LifeboatMode', false))
      } else {
        sendMessage(player, theme.line('LifeboatMode', `is ${theme.status(player._disablerEnabled)}`))
      }
    }
    registerCommand('lifeboatmode', 'A cheat that enables Lifeboat anti-cheat bypass', handler)
  }
}

function pauseMovementOnDeath (player) {
  const now = Date.now()
  if (player._deathPauseAt && now - player._deathPauseAt < 400) return
  player._deathPauseAt = now
  onPlayerDeath(player)
  stripFlyAbilities(player)
}

function sendKeepFly (player) {
  const rid = player._runtimeId || player._disablerRid
  if (!rid) return
  const speed = player._flySpeed || 6
  const flySpeed = speed * 0.05
  const verticalFlySpeed = Math.min(1.0, speed * 0.17)
  try {
    player.queue('update_abilities', {
      entity_unique_id: BigInt(rid),
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [{
        type: 'base',
        allowed: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: true,
          teleport: true, invulnerable: true, flying: true, may_fly: true,
          instant_build: true, lightning: true, fly_speed: true, walk_speed: true,
          muted: true, world_builder: true, no_clip: false, privileged_builder: true
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: true, may_fly: true,
          instant_build: false, lightning: false, fly_speed: true, walk_speed: true,
          muted: false, world_builder: false, no_clip: false, privileged_builder: false
        },
        fly_speed: flySpeed,
        vertical_fly_speed: verticalFlySpeed,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}

function sendKeepNoclip (player) {
  const rid = player._runtimeId || player._disablerRid
  if (!rid) return
  const speed = player._noclipSpeed || 6
  const flySpeed = speed * 0.05
  const verticalN = player._noclipVerticalSpeed ?? 6
  const verticalFlySpeed = Math.max(0.05, Math.min(1.0, verticalN * 0.17))
  try {
    player.queue('update_abilities', {
      entity_unique_id: BigInt(rid),
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [{
        type: 'base',
        allowed: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: true,
          teleport: true, invulnerable: true, flying: true, may_fly: true,
          instant_build: true, lightning: true, fly_speed: true, walk_speed: true,
          muted: true, world_builder: true, no_clip: true, privileged_builder: true,
          vertical_fly_speed: true
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: true, may_fly: true,
          instant_build: false, lightning: false, fly_speed: true, walk_speed: true,
          vertical_fly_speed: true,
          muted: false, world_builder: false, no_clip: true, privileged_builder: false
        },
        fly_speed: flySpeed,
        vertical_fly_speed: verticalFlySpeed,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}

function sendKeepCfly (player) {
  const rid = player._runtimeId || player._disablerRid
  if (!rid) return
  const speed = player._cflySpeed || 6
  const flySpeed = speed * 0.05
  const verticalN = player._cflyVerticalSpeed ?? 6
  const verticalFlySpeed = Math.max(0.05, Math.min(1.0, verticalN * 0.17))
  try {
    player.queue('update_abilities', {
      entity_unique_id: BigInt(rid),
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [{
        type: 'base',
        allowed: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: true,
          teleport: true, invulnerable: true, flying: true, may_fly: true,
          instant_build: true, lightning: true, fly_speed: true, walk_speed: true,
          muted: true, world_builder: true, no_clip: false, privileged_builder: true,
          vertical_fly_speed: true
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: true, may_fly: true,
          instant_build: false, lightning: false, fly_speed: true, walk_speed: true,
          vertical_fly_speed: true,
          muted: false, world_builder: false, no_clip: false, privileged_builder: false
        },
        fly_speed: flySpeed,
        vertical_fly_speed: verticalFlySpeed,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}

function sendGrantFly (player) {
  const rid = player._runtimeId || player._disablerRid
  if (!rid) return
  const noClip = !!(
    player._antihitEnabled ||
    player._playerCoordsPhase === 'scanning' ||
    player._speedFlyFlying
  )
  try {
    player.queue('update_abilities', {
      entity_unique_id: BigInt(rid),
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [{
        type: 'base',
        allowed: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: true,
          teleport: true, invulnerable: true, flying: true, may_fly: true,
          instant_build: true, lightning: true, fly_speed: true, walk_speed: true,
          muted: true, world_builder: true, no_clip: true, privileged_builder: true
        },
        enabled: {
          build: true, mine: true, doors_and_switches: true, open_containers: true,
          attack_players: true, attack_mobs: true, operator_commands: false,
          teleport: false, invulnerable: false, flying: true, may_fly: true,
          instant_build: false, lightning: false, fly_speed: true, walk_speed: true,
          muted: false, world_builder: false, no_clip: noClip, privileged_builder: false
        },
        fly_speed: 0.05000000074505806,
        vertical_fly_speed: 0.05000000074505806,
        walk_speed: 0.10000000149011612
      }]
    })
  } catch (e) {}
}

function stripFlyAbilities (player) {
  const rid = player._runtimeId || player._disablerRid
  if (!rid) return
  try { player.queue('set_player_game_type', { gamemode: 'survival' }) } catch (e) {}
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