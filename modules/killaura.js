'use strict'

/**
 * KillAura — auto-attack nearest enemy.
 *
 * ?killaura on / off / range <3-100> / cps <1-20>
 */

const { registerCommand, sendMessage, onDeath } = require('./chat-commands')
const theme = require('../core/theme')
const { saveCombatWantFlags, restoreCombatAfterRespawn, syncPlayerRids } = require('../core/player-rid')
const { resumeKillauraAfterRespawn } = require('../core/death-resync')
const { triggerModuleTpPulse, clearHudTip } = require('../core/mod-status')
const {
  bindKaEntityTracking,
  kaKey,
  kaEq,
  isHurtEvent,
  formatPopupTargetName,
  queueMeleeAttack,
  queueSilentReachAttack
} = require('../core/ka-entities')
const { isTpBusy, seedCombatPositions } = require('../core/combat-pause')
const { livePos, findNearestTarget } = require('../core/combat-target')

const MELEE_RANGE = 3.5
const DEFAULT_RANGE = 100
const DEFAULT_CPS = 20
const ATTACK_TICK_INTERVAL = 3
const REACH_GUARD_MS = 450
const DEATH_PAUSE_MS = 1200

function attackIntervalMs (player) {
  const delay = player._killauraDelay
  if (typeof delay === 'number' && delay > 0) return delay
  const cps = Math.max(1, Math.min(20, player._killauraCPS || DEFAULT_CPS))
  return Math.round(1000 / cps)
}

function myRid (player) {
  return player._killauraRid || player._kaRid || player._kaRuntimeId || player._runtimeId
}

function resetKillaura (player) {
  player._killauraPhase = 'idle'
  player._killauraBusy = false
  player._reachActive = false
  player._killauraGuardUntil = 0
  player._killauraTarget = null
  player._kaAttackTick = 0
}

function resumeKillAura (player) {
  if (!player._killauraWantOn && !player._killauraEnabled) return
  player._killauraWantOn = true
  player._killauraEnabled = true
  player._killauraPauseUntil = 0
  player._meteorDead = false
  player._meteorDeadAt = 0
}

function onKillauraDeath (player) {
  saveCombatWantFlags(player)
  player._killauraPauseUntil = Date.now() + DEATH_PAUSE_MS
  resetKillaura(player)
}

function onKillauraRespawn (player, params = {}) {
  player._meteorDead = false
  player._meteorDeadAt = 0
  player._killauraPauseUntil = 0

  if (params.runtime_entity_id != null) {
    syncPlayerRids(player, params.runtime_entity_id)
    player._killauraRid = params.runtime_entity_id
  }
  if (params.position) {
    seedCombatPositions(player, params.position)
  }

  resumeKillauraAfterRespawn(player)
  restoreCombatAfterRespawn(player)
  resumeKillAura(player)
  resetKillaura(player)
}

function isKillauraPaused (player) {
  return !!(player._killauraPauseUntil && Date.now() < player._killauraPauseUntil)
}

function canAttackNow (player) {
  if (!player._killauraEnabled) return false
  if (player._killauraBusy) return false
  if (isTpBusy(player)) return false
  if (isKillauraPaused(player)) return false
  if (!livePos(player)) return false
  const now = Date.now()
  return now - (player._kaLastAttack || 0) >= attackIntervalMs(player)
}

function pulseHit (player, target) {
  const name = formatPopupTargetName(target.ent, target.name)
  triggerModuleTpPulse(player, 'killaura', `${name} @ ${target.dist.toFixed(1)}m`)
}

function runAttack (player, target, realPos) {
  if (target.dist > MELEE_RANGE) {
    player._killauraGuardUntil = Date.now() + REACH_GUARD_MS
    queueSilentReachAttack(player, target.rid, target.ent, realPos, target.dist, MELEE_RANGE)
  } else {
    queueMeleeAttack(player, target.rid, target.ent, realPos)
  }
  player._killauraBusy = false
  player._kaLastAttack = Date.now()
  pulseHit(player, target)
}

function tryAttack (player) {
  if (!canAttackNow(player)) return

  const target = findNearestTarget(player, player._killauraRange || DEFAULT_RANGE)
  if (!target) return

  const realPos = livePos(player)
  if (!realPos) return

  player._killauraBusy = true
  player._killauraTarget = target.rid
  player._killauraLastTarget = target.rid

  try {
    runAttack(player, target, realPos)
  } catch (_) {
    player._killauraBusy = false
    player._kaLastAttack = Date.now()
  }
}

module.exports = {
  name: 'KillAura',
  description: 'Auto-attack nearest enemy (?killaura on/off/range/cps)',

  onEnable () {
    registerCommand('killaura', 'Auto-attack nearest enemy player', (player, args) => {
      const a = (args[0] || '').toLowerCase()

      if (a === 'on') {
        player._killauraEnabled = true
        player._killauraWantOn = true
        player._killauraPauseUntil = 0
        resetKillaura(player)
        sendMessage(player, theme.toggle('KillAura', true,
          `— ${player._killauraRange || DEFAULT_RANGE}m · ${player._killauraCPS || DEFAULT_CPS} cps`))
      } else if (a === 'off') {
        player._killauraEnabled = false
        player._killauraWantOn = false
        player._killauraPauseUntil = 0
        resetKillaura(player)
        clearHudTip(player)
        sendMessage(player, theme.toggle('KillAura', false))
      } else if (a === 'range') {
        const n = parseInt(args[1], 10)
        if (n >= 3 && n <= 100) {
          player._killauraRange = n
          sendMessage(player, theme.line('KillAura', `range ${n}m`))
        } else {
          sendMessage(player, theme.error('range 3-100'))
        }
      } else if (a === 'cps') {
        const n = parseInt(args[1], 10)
        if (n >= 1 && n <= 20) {
          player._killauraCPS = n
          player._killauraDelay = null
          sendMessage(player, theme.line('KillAura', `cps ${n}`))
        } else {
          sendMessage(player, theme.error('cps 1-20'))
        }
      } else {
        const cps = player._killauraCPS || DEFAULT_CPS
        const range = player._killauraRange || DEFAULT_RANGE
        sendMessage(player, theme.line('KillAura',
          `is ${theme.status(player._killauraEnabled)} · ${range}m · ${cps} cps`))
      }
    })
  },

  onPlayer (player) {
    bindKaEntityTracking(player)

    if (player._killauraRange == null) player._killauraRange = DEFAULT_RANGE
    if (player._killauraCPS == null) player._killauraCPS = DEFAULT_CPS
    if (player._killauraEnabled === undefined) player._killauraEnabled = false
    if (player._killauraWantOn === undefined) player._killauraWantOn = false
    player._killauraPauseUntil = player._killauraPauseUntil || 0

    resetKillaura(player)
    player._kaLastAttack = 0

    player.on('clientbound', (data) => {
      if (!data?.name || !data.params) return
      const p = data.params
      const rid = myRid(player)

      if (data.name === 'start_game' && p.runtime_entity_id != null) {
        player._killauraRid = p.runtime_entity_id
        resetKillaura(player)
        return
      }

      if (data.name === 'set_health' && typeof p.health === 'number' && p.health > 0) {
        if (player._killauraPauseUntil || player._meteorDead) {
          onKillauraRespawn(player, {
            runtime_entity_id: rid,
            position: player._lastPos || player._kaPos || player._killauraPos
          })
        }
        return
      }

      if (data.name === 'respawn') {
        onKillauraRespawn(player, p)
        return
      }

      if (data.name === 'play_status' && p.status === 'player_spawn') {
        if (player._killauraWantOn || player._killauraEnabled || player._killauraPauseUntil) {
          onKillauraRespawn(player, {
            runtime_entity_id: rid,
            position: player._lastPos || player._kaPos || player._killauraPos
          })
        }
        return
      }

      if (data.name === 'entity_event' && rid != null) {
        if (kaEq(p.runtime_entity_id, rid)) {
          if (p.event_id === 'death_smoke_cloud' || p.event_id === 'death_animation') {
            onKillauraDeath(player)
          } else if (p.event_id === 'respawn') {
            onKillauraRespawn(player, {
              runtime_entity_id: rid,
              position: player._lastPos || player._kaPos || player._killauraPos
            })
          }
        }
        return
      }

      if (data.name === 'move_player' && p.position && kaEq(p.runtime_id, rid)) {
        if (player._killauraPauseUntil || player._meteorDead) {
          seedCombatPositions(player, p.position)
          if (player._killauraWantOn || player._killauraEnabled) {
            onKillauraRespawn(player, { runtime_entity_id: rid, position: p.position })
          }
        }
        return
      }

      if (data.name === 'change_dimension' || data.name === 'transfer') {
        resetKillaura(player)
        player._killauraPauseUntil = 0
        if (p.runtime_entity_id != null) {
          player._killauraRid = p.runtime_entity_id
        }
        if (p.position) seedCombatPositions(player, p.position)
        resumeKillAura(player)
      }
    })

    onDeath(player, () => {
      onKillauraDeath(player)
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input') return

      if (player._killauraWantOn && !player._killauraEnabled) {
        resumeKillAura(player)
      }

      if (!player._killauraEnabled) return

      if (player._killauraPauseUntil && Date.now() >= player._killauraPauseUntil) {
        player._killauraPauseUntil = 0
      }

      if (isKillauraPaused(player)) return

      player._kaAttackTick = (player._kaAttackTick || 0) + 1
      if (player._kaAttackTick % ATTACK_TICK_INTERVAL !== 0) return
      tryAttack(player)
    })
  }
}