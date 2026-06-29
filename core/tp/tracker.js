'use strict'

const { vec3, cloneVec } = require('./utils')

/**
 * Canonical position aliases — one updater for the whole proxy.
 * Legacy module fields map here so old code keeps working during migration.
 */
const POSITION_ALIASES = {
  core: ['_lastRealPos', '_kaPos', '_lastPosition'],
  scan: ['_smscanPos', '_playerCoordsPos'],
  mine: ['_tpminePos'],
  chest: ['_chestTpPos'],
  surface: ['_surfaceTpPos'],
  enemy: ['_enemyTpPos'],
  cam: ['_camtpPos'],
  automine: ['_amPos'],
  aura: ['_killauraPos', '_killauraPos']
}

function allKeys () {
  const keys = new Set()
  for (const group of Object.values(POSITION_ALIASES)) {
    for (const k of group) keys.add(k)
  }
  return [...keys]
}

function readPosition (player) {
  const p = player._lastRealPos || player._kaPos || player.tpState?.destination
  return p ? vec3(p) : null
}

function writeKey (player, key, pos) {
  const always = POSITION_ALIASES.core.includes(key)
  if (!always && player[key] === undefined) return
  player[key] = cloneVec(pos)
}

/**
 * Update every cached position the proxy knows about.
 * Modules should call this (via tp.teleport) instead of touching fields directly.
 */
function updateAll (player, dest, options = {}) {
  const pos = vec3(dest)

  for (const key of allKeys()) {
    writeKey(player, key, pos)
  }

  if (options.authParams?.position) {
    options.authParams.position.x = pos.x
    options.authParams.position.y = pos.y
    options.authParams.position.z = pos.z
    if (options.onGround !== undefined) {
      options.authParams.on_ground = !!options.onGround
    }
  }

  if (player.tpState) {
    player.tpState.lastKnownPos = cloneVec(pos)
  }

  return pos
}

module.exports = {
  POSITION_ALIASES,
  readPosition,
  updateAll
}