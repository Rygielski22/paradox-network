'use strict'

/**
 * Triggerbot — auto-attack when crosshair is on an enemy (FOV check).
 *
 * ?triggerbot on / off / range <3-100> / delay <ms> / fov <5-45>
 */

const { registerCommand, sendMessage, onDeath } = require('./chat-commands')
const theme = require('../core/theme')
const { saveCombatWantFlags } = require('../core/player-rid')
const { isPlayerDead } = require('../core/death-resync')
const { triggerModuleTpPulse } = require('../core/mod-status')
const {
  bindKaEntityTracking,
  kaKey,
  isHurtEvent,
  formatPopupTargetName,
  queueMeleeAttack,
  queueSilentReachAttack
} = require('../core/ka-entities')
const { isTpBusy } = require('../core/combat-pause')
const {
  livePos,
  computeAimRotation,
  syncRotState,
  findCrosshairTarget
} = require('../core/combat-target')

const MELEE_RANGE = 3.5
const DEFAULT_RANGE = 6
const DEFAULT_DELAY = 120
const DEFAULT_FOV = 18

function attackDelayMs (player) {
  const d = player._triggerbotDelay
  return typeof d === 'number' && d > 0 ? d : DEFAULT_DELAY
}

function resetTriggerbot (player) {
  player._triggerbotBusy = false
}

function pulseHit (player, target) {
  const name = formatPopupTargetName(target.ent, target.name)
  triggerModuleTpPulse(player, 'killaura', `${name} @ ${target.dist.toFixed(1)}m`)
}

function tryTriggerAttack (player) {
  if (!player._triggerbotEnabled) return
  if (player._triggerbotBusy) return
  if (isTpBusy(player)) return
  if (isPlayerDead(player)) return

  const now = Date.now()
  if (now - (player._tbLastAttack || 0) < attackDelayMs(player)) return

  const range = player._triggerbotRange || DEFAULT_RANGE
  const fov = player._triggerbotFov || DEFAULT_FOV
  const target = findCrosshairTarget(player, range, fov)
  if (!target) return

  const realPos = livePos(player)
  if (!realPos) return

  player._triggerbotBusy = true
  player._triggerbotLastTarget = target.rid

  try {
    const aim = computeAimRotation(target.ent, realPos)
    syncRotState(player, aim)
    if (target.dist <= MELEE_RANGE) {
      queueMeleeAttack(player, target.rid, target.ent, realPos)
    } else {
      queueSilentReachAttack(player, target.rid, target.ent, realPos, target.dist, MELEE_RANGE)
    }
    pulseHit(player, target)
  } catch (_) {}

  player._triggerbotBusy = false
  player._tbLastAttack = now
}

module.exports = {
  name: 'TriggerBot',
  description: 'Attack when crosshair is on enemy (?triggerbot on/off/range/delay/fov)',

  onEnable () {
    registerCommand('triggerbot', 'Attack when looking at an enemy', (player, args) => {
      const a = (args[0] || '').toLowerCase()

      if (a === 'on') {
        player._triggerbotEnabled = true
        player._triggerbotWantOn = true
        resetTriggerbot(player)
        sendMessage(player, theme.toggle('TriggerBot', true,
          `— ${player._triggerbotRange || DEFAULT_RANGE}m · ${attackDelayMs(player)}ms`))
      } else if (a === 'off') {
        player._triggerbotEnabled = false
        player._triggerbotWantOn = false
        resetTriggerbot(player)
        sendMessage(player, theme.toggle('TriggerBot', false))
      } else if (a === 'range') {
        const n = parseInt(args[1], 10)
        if (n >= 3 && n <= 100) {
          player._triggerbotRange = n
          sendMessage(player, theme.line('TriggerBot', `§7range §f${n}m`))
        } else {
          sendMessage(player, theme.error('range 3-100'))
        }
      } else if (a === 'delay') {
        const n = parseInt(args[1], 10)
        if (n >= 0 && n <= 1000) {
          player._triggerbotDelay = n
          sendMessage(player, theme.line('TriggerBot', `§7delay §f${n}ms`))
        } else {
          sendMessage(player, theme.error('delay 0-1000'))
        }
      } else if (a === 'fov') {
        const n = parseInt(args[1], 10)
        if (n >= 5 && n <= 45) {
          player._triggerbotFov = n
          sendMessage(player, theme.line('TriggerBot', `§7fov §f${n}°`))
        } else {
          sendMessage(player, theme.error('fov 5-45'))
        }
      } else {
        sendMessage(player, theme.line('TriggerBot',
          `is ${theme.status(player._triggerbotEnabled)} §7· ${player._triggerbotRange || DEFAULT_RANGE}m · ${attackDelayMs(player)}ms · fov ${player._triggerbotFov || DEFAULT_FOV}°`))
      }
    })
  },

  onPlayer (player) {
    bindKaEntityTracking(player)
    if (player._triggerbotRange == null) player._triggerbotRange = DEFAULT_RANGE
    if (player._triggerbotDelay == null) player._triggerbotDelay = DEFAULT_DELAY
    if (player._triggerbotFov == null) player._triggerbotFov = DEFAULT_FOV
    if (player._triggerbotEnabled === undefined) player._triggerbotEnabled = false
    resetTriggerbot(player)
    player._tbLastAttack = 0

    player.on('clientbound', (data) => {
      if (!data?.name || !data.params) return
      if (data.name === 'entity_event' && isHurtEvent(data.params)) {
        const rid = kaKey(data.params.runtime_entity_id)
        if (!rid || rid !== player._triggerbotLastTarget) return
        const ent = player._kaEntities?.get(rid)
        const name = formatPopupTargetName(ent, ent?.name)
        const pos = livePos(player)
        const dist = pos && ent
          ? Math.hypot(ent.x - pos.x, ent.y - pos.y, ent.z - pos.z)
          : 0
        triggerModuleTpPulse(player, 'killaura', `${name} @ ${dist.toFixed(1)}m`)
      }
    })

    onDeath(player, () => {
      saveCombatWantFlags(player)
      resetTriggerbot(player)
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input') return
      if (!player._triggerbotEnabled) return
      tryTriggerAttack(player)
    })
  }
}