'use strict'

function pauseCombat (player, ms = 1500) {
  player._combatPauseUntil = Date.now() + ms
}

function isCombatPaused (player) {
  return !!(player._combatPauseUntil && Date.now() < player._combatPauseUntil)
}

function isTpBusy (player) {
  if (isCombatPaused(player)) return true
  if (player._enemyTpPhase === 'flying') return true
  if (player._enemyTpBlockCorrectionUntil && Date.now() < player._enemyTpBlockCorrectionUntil) {
    return true
  }
  try {
    const tp = require('./tp')
    if (tp?.isSyncing?.(player) || tp?.isGuarding?.(player)) return true
  } catch (_) {}
  return false
}

function seedCombatPositions (player, pos) {
  if (!pos) return
  const p = { x: pos.x, y: pos.y, z: pos.z }
  player._kaPos = { ...p }
  player._killauraPos = { ...p }
  player._enemyTpPos = { ...p }
  player._lastRealPos = { ...p }
  if (player._kaLastAuth) {
    player._kaLastAuth = {
      ...player._kaLastAuth,
      position: { ...p }
    }
  }
}

module.exports = {
  pauseCombat,
  isCombatPaused,
  isTpBusy,
  seedCombatPositions
}