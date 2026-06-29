'use strict'

const { registerCommand, sendMessage, onDeath } = require('./chat-commands')
const theme = require('../core/theme')
const { bindKaEntityTracking, isValidTarget, authPacketFromPlayer } = require('../core/ka-entities')
const { meteorTp } = require('../core/meteor-tp')
const { prepareInstantTp, releaseInstantTp } = require('../core/tp-prep')
const { pauseCombat, seedCombatPositions } = require('../core/combat-pause')

const EYE_HEIGHT = 1.62
const BLOCK_CORRECTION_MS = 1200

function authFromPlayer (player, pos) {
  const { buildPlayerAuthInput } = require('../core/protocol')
  return buildPlayerAuthInput(player, {
    ...authPacketFromPlayer(player, pos, player._kaLastAuth?.tick ?? 0),
    position: { x: pos.x, y: pos.y, z: pos.z },
    delta: { x: 0, y: 0, z: 0 },
    move_vector: { x: 0, z: 0 },
    raw_move_vector: { x: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 }
  })
}

function livePos (player) {
  return player._kaLastAuth?.position || player._enemyTpPos || player._kaPos
}

function findNearestEnemy (player, range, excludeRid) {
  const myRid = player._kaRid || player._kaRuntimeId
  const map = player._kaEntities
  if (!map?.size) return null
  let best = null
  let min = range
  for (const [rid, ent] of map) {
    const hit = isValidTarget(player, rid, ent, myRid, range, {
      bodyDist: true,
      requireName: true,
      skipStale: false
    })
    if (!hit || hit.dist >= min) continue
    if (excludeRid && hit.rid === excludeRid) continue
    min = hit.dist
    best = {
      rid: hit.rid,
      x: ent.x,
      y: ent.y,
      z: ent.z,
      dist: hit.dist,
      name: ent.name || ''
    }
  }
  return best
}

function clearEnemyTpState (player) {
  player._enemyTpPhase = 'idle'
  player._enemyTpTarget = null
  player._enemyTpAnchor = null
  player._enemyTpLandedUntil = 0
  player._enemyTpLandGuardUntil = 0
  player._enemyTpBlockCorrectionUntil = 0
  releaseInstantTp(player)
}

function inEnemyTpCorrectionWindow (player) {
  return !!(
    player._enemyTpPhase === 'flying' ||
    (player._enemyTpBlockCorrectionUntil && Date.now() < player._enemyTpBlockCorrectionUntil)
  )
}

function finishEnemyTpArrival (player, dest, target) {
  seedCombatPositions(player, dest)
  player._enemyTpPhase = 'idle'
  player._enemyTpTarget = null
  player._enemyTpAnchor = null
  player._enemyTpLandedUntil = 0
  player._enemyTpLandGuardUntil = 0
  player._enemyTpBlockCorrectionUntil = Date.now() + BLOCK_CORRECTION_MS
  player._killauraBusy = false
  if (target?.rid) player._enemyTpLastRid = target.rid
  pauseCombat(player, BLOCK_CORRECTION_MS + 400)
  releaseInstantTp(player)
}

function canEnemyTp (player) {
  if (player._enemyTpPhase === 'flying') return false
  try {
    const tp = require('../core/tp')
    if (tp?.isSyncing?.(player) || tp?.isGuarding?.(player)) return false
  } catch (_) {}
  return true
}

module.exports = {
  name: 'EnemyTP',
  description: 'Instant TP to the nearest enemy player',

  onPlayer (player) {
    player._enemyTpRange = player._enemyTpRange ?? 120
    player._enemyTpRid = null
    player._enemyTpPos = null
    player._enemyTpPhase = 'idle'
    player._enemyTpTarget = null
    player._enemyTpAnchor = null
    player._enemyTpLastRid = null
    player._enemyTpLandedUntil = 0
    player._enemyTpLandGuardUntil = 0
    player._enemyTpBlockCorrectionUntil = 0
    bindKaEntityTracking(player)

    onDeath(player, () => clearEnemyTpState(player))

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) {
        player._enemyTpRid = data.params.runtime_entity_id
        clearEnemyTpState(player)
        return
      }

      if (data.name === 'change_dimension' || data.name === 'transfer') {
        clearEnemyTpState(player)
        return
      }

      if (!inEnemyTpCorrectionWindow(player)) return
      if (data.name !== 'move_player' && data.name !== 'correct_player_movement') return

      if (data.name === 'move_player' && data.params?.position && player._enemyTpPos) {
        const p = data.params.position
        if (Math.abs(p.x - player._enemyTpPos.x) > 200 ||
            Math.abs(p.y - player._enemyTpPos.y) > 200 ||
            Math.abs(p.z - player._enemyTpPos.z) > 200) {
          clearEnemyTpState(player)
          return
        }
      }
      if (des) des.canceled = true
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input' || !data.params?.position) return
      player._enemyTpPos = data.params.position

      if (player._enemyTpBlockCorrectionUntil &&
          Date.now() >= player._enemyTpBlockCorrectionUntil) {
        player._enemyTpBlockCorrectionUntil = 0
      }
    })
  },

  onEnable () {
    registerCommand('enemytp', 'Instant TP to nearest enemy (?enemytp [range])', (player, args) => {
      if (!player._disablerEnabled) {
        sendMessage(player, theme.error('enable §f?lifeboatmode on §7first'))
        return
      }

      if (!canEnemyTp(player)) {
        sendMessage(player, theme.error('EnemyTP: wait for current TP to finish'))
        return
      }

      const range = parseFloat(args[0]) || player._enemyTpRange
      player._enemyTpRange = Math.min(500, Math.max(3, range))

      let target = findNearestEnemy(player, player._enemyTpRange, player._enemyTpLastRid)
      if (!target) {
        target = findNearestEnemy(player, player._enemyTpRange)
      }
      if (!target) {
        sendMessage(player, theme.error('no enemy in range'))
        return
      }

      const pos = livePos(player)
      if (!pos) {
        sendMessage(player, theme.error('no position yet — move once'))
        return
      }

      const dest = { x: target.x, y: target.y + EYE_HEIGHT, z: target.z }
      const rid = player._enemyTpRid || player._kaRid || player._kaRuntimeId

      clearEnemyTpState(player)
      pauseCombat(player, BLOCK_CORRECTION_MS + 800)
      player._killauraBusy = false
      prepareInstantTp(player, 'enemytp')
      player._enemyTpPhase = 'flying'
      player._enemyTpTarget = dest

      const ok = meteorTp(player, dest, pos, {
        moduleKey: 'enemytp',
        rid,
        authParams: authFromPlayer(player, pos),
        posProp: '_enemyTpPos',
        onArrive: () => {
          finishEnemyTpArrival(player, dest, target)
          sendMessage(player, theme.line('EnemyTP', `§7→ §f${target.name || target.rid}`))
        }
      })

      if (!ok) {
        clearEnemyTpState(player)
        sendMessage(player, theme.error('EnemyTP failed — enable ?lifeboatmode on'))
      }
    })
  }
}