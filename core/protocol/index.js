'use strict'

const { normalizeVarint64, nextTick } = require('./varint64')
const {
  buildPlayerAuthInput,
  applyAuthPatch,
  ensureAuthEncodeShape,
  sanitizeConditionals,
  AUTH_DEFAULTS
} = require('./player-auth-input')
const { buildMovePlayer } = require('./move-player')
const { buildSetEntityMotion } = require('./set-entity-motion')
const { buildMobEffect } = require('./mob-effect')
const { isCorrectionPacket, CORRECTION_NAMES } = require('./correction')

function queueUpstreamAuth (player, patch) {
  if (!player?.upstream) return false
  const pkt = buildPlayerAuthInput(player, patch)
  try {
    player.upstream.queue('player_auth_input', pkt)
    return true
  } catch (e) {
    return false
  }
}

function queueClientMovePlayer (player, patch) {
  if (!player) return false
  const pkt = buildMovePlayer(patch)
  try {
    player.queue('move_player', pkt)
    return true
  } catch (e) {
    return false
  }
}

function queueClientMotion (player, patch) {
  if (!player) return false
  const pkt = buildSetEntityMotion(patch)
  try {
    player.queue('set_entity_motion', pkt)
    return true
  } catch (e) {
    return false
  }
}

function queueClientMobEffect (player, patch) {
  if (!player) return false
  const pkt = buildMobEffect(patch)
  try {
    player.queue('mob_effect', pkt)
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  normalizeVarint64,
  nextTick,
  AUTH_DEFAULTS,
  buildPlayerAuthInput,
  applyAuthPatch,
  ensureAuthEncodeShape,
  sanitizeConditionals,
  buildMovePlayer,
  buildSetEntityMotion,
  buildMobEffect,
  isCorrectionPacket,
  CORRECTION_NAMES,
  queueUpstreamAuth,
  queueClientMovePlayer,
  queueClientMotion,
  queueClientMobEffect
}