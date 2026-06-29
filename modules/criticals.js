'use strict'

/**
 * Criticals — force critical hits on every attack + client crit particles.
 * Sends upstream crit auth (start_falling + delta) before each hit.
 *
 * ?criticals on / off
 */

const { registerCommand, sendMessage, onDeath } = require('./chat-commands')
const theme = require('../core/theme')
const { saveCombatWantFlags } = require('../core/player-rid')
const { queueCritAuthBurst, kaKey } = require('../core/ka-entities')
const { isTpBusy } = require('../core/combat-pause')
const { spawnCritParticles } = require('../core/crit-fx')

function attackPosFromTransaction (player, tx) {
  const pp = tx?.transaction_data?.player_pos
  if (pp && typeof pp.x === 'number') return { x: pp.x, y: pp.y, z: pp.z }
  const live = player._kaPos || player._killauraPos || player._lastRealPos
  if (live) return { x: live.x, y: live.y, z: live.z }
  const auth = player._kaLastAuth?.position
  if (auth) return { x: auth.x, y: auth.y, z: auth.z }
  return null
}

function clickPosFromTransaction (tx) {
  const cp = tx?.transaction_data?.click_pos
  if (!cp || typeof cp.x !== 'number') return null
  return { x: cp.x, y: cp.y, z: cp.z }
}

function targetEntFromTransaction (player, tx) {
  const rid = tx?.transaction_data?.entity_runtime_id
  const key = kaKey(rid)
  if (!key || !player._kaEntities) return null
  return player._kaEntities.get(key) || null
}

function isClientAttackTransaction (data) {
  if (data?.name !== 'inventory_transaction') return false
  const tx = data.params?.transaction
  if (!tx || tx.transaction_type !== 'item_use_on_entity') return false
  return String(tx.transaction_data?.action_type || '').toLowerCase() === 'attack'
}

function playCritFx (player, ent, targetRid, clickPos, playerPos) {
  if (!player._criticalsEnabled) return
  spawnCritParticles(player, ent, targetRid, clickPos, playerPos)
}

module.exports = {
  name: 'Criticals',
  description: 'Critical hit on every attack (?criticals on/off)',

  onEnable () {
    registerCommand('criticals', 'Force critical hits on every attack', (player, args) => {
      const a = (args[0] || '').toLowerCase()

      if (a === 'on') {
        player._criticalsEnabled = true
        player._criticalsWantOn = true
        sendMessage(player, theme.toggle('Criticals', true))
      } else if (a === 'off') {
        player._criticalsEnabled = false
        player._criticalsWantOn = false
        sendMessage(player, theme.toggle('Criticals', false))
      } else {
        sendMessage(player, theme.line('Criticals', `is ${theme.status(player._criticalsEnabled)}`))
      }
    })
  },

  onPlayer (player) {
    if (player._criticalsEnabled === undefined) player._criticalsEnabled = false

    onDeath(player, () => {
      saveCombatWantFlags(player)
    })

    player.on('aura_attack', (evt) => {
      if (!player._criticalsEnabled || isTpBusy(player)) return
      playCritFx(player, evt?.ent, evt?.targetRid, evt?.clickPos, evt?.playerPos)
    })

    player.on('serverbound', (data) => {
      if (!player._criticalsEnabled) return
      if (isTpBusy(player)) return
      if (!isClientAttackTransaction(data)) return

      const tx = data.params?.transaction
      const pos = attackPosFromTransaction(player, tx)
      if (!pos) return

      queueCritAuthBurst(player, pos)

      const ent = targetEntFromTransaction(player, tx)
      const click = clickPosFromTransaction(tx)
      const rid = tx?.transaction_data?.entity_runtime_id
      playCritFx(player, ent, rid, click, pos)
    })
  }
}