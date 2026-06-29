'use strict'

function syncPlayerRids (player, rid) {
  if (rid == null) return
  player._runtimeId = rid
  player._kaRid = rid
  player._kaRuntimeId = rid
  player._killauraRid = rid
  player._disablerRid = rid
  const st = player._invUtilState
  if (st) st.rid = rid
}

function isSelfRid (player, rid) {
  const my = player._runtimeId ?? player._kaRid ?? player._killauraRid
  if (my == null || rid == null) return false
  return String(my) === String(rid)
}

function saveCombatWantFlags (player) {
  // Death often fires twice (smoke + set_health). Never clear want flags on the
  // second pass when modules are already disabled — that stranded KillAura off.
  if (player._killauraEnabled || player._killauraWantOn) player._killauraWantOn = true
  if (player._tpauraEnabled) player._tpauraWantOn = true
  if (player._mobauraEnabled) player._mobauraWantOn = true
  if (player._triggerbotEnabled) player._triggerbotWantOn = true
  if (player._criticalsEnabled) player._criticalsWantOn = true
}

function restoreCombatAfterRespawn (player) {
  player._kaLastAttack = 0

  if (player._killauraWantOn) {
    player._killauraEnabled = true
  }
  if (player._tpauraWantOn) {
    player._tpauraEnabled = true
    if (typeof player._tpauraStartLoop === 'function') player._tpauraStartLoop()
  }
  if (player._mobauraWantOn) player._mobauraEnabled = true
  if (player._triggerbotWantOn) player._triggerbotEnabled = true
  if (player._criticalsWantOn) player._criticalsEnabled = true
}

module.exports = {
  syncPlayerRids,
  isSelfRid,
  saveCombatWantFlags,
  restoreCombatAfterRespawn
}