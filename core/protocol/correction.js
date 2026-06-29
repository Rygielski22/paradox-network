'use strict'

/** 1.26.30 wire name + sim/harness legacy alias */
const CORRECTION_NAMES = new Set([
  'correct_player_move_prediction',
  'correct_player_movement'
])

function isCorrectionPacket (name) {
  return CORRECTION_NAMES.has(name)
}

module.exports = { isCorrectionPacket, CORRECTION_NAMES }