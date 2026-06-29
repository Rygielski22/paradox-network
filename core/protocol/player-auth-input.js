'use strict'

/**
 * packet_player_auth_input — bedrock/1.26.30/protocol.json lines 13031–13390
 *
 * Fields: pitch, yaw, position, move_vector, head_yaw, input_data, input_mode,
 * play_mode, interaction_model, interact_rotation, tick, delta, transaction?,
 * item_stack_request?, vehicle?, block_action?, analogue_move_vector,
 * camera_orientation, raw_move_vector
 *
 * NOT in schema: ticks_alive, on_ground (legacy — strip before encode)
 */

const { normalizeVarint64 } = require('./varint64')

const AUTH_DEFAULTS = {
  pitch: 0,
  yaw: 0,
  head_yaw: 0,
  position: { x: 0, y: 64, z: 0 },
  move_vector: { x: 0, z: 0 },
  raw_move_vector: { x: 0, z: 0 },
  analogue_move_vector: { x: 0, z: 0 },
  delta: { x: 0, y: 0, z: 0 },
  input_data: {},
  input_mode: 'mouse',
  play_mode: 'normal',
  interaction_model: 'touch',
  interact_rotation: { x: 0, z: 0 },
  camera_orientation: { x: 0, y: 0, z: 1 },
  tick: 0
}

const STRIP_KEYS = [
  'ticks_alive', 'on_ground', 'gaze_direction', 'item_use_transaction',
  'transaction', 'item_stack_request', 'block_action'
]

function clone (v) {
  if (v == null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(clone)
  const o = {}
  for (const k of Object.keys(v)) o[k] = clone(v[k])
  return o
}

function stripVolatileFromLast (last) {
  if (!last) return null
  const c = clone(last)
  for (const k of STRIP_KEYS) delete c[k]
  return c
}

function sanitizeConditionals (pkt) {
  const flags = pkt.input_data || {}
  if (!flags.item_interact) delete pkt.transaction
  if (!flags.item_stack_request) delete pkt.item_stack_request
  if (!flags.block_action) delete pkt.block_action
  if (!flags.client_predicted_vehicle) {
    delete pkt.vehicle_rotation
    delete pkt.predicted_vehicle
  }
}

function vec3 (p) {
  return { x: Number(p?.x) || 0, y: Number(p?.y) || 0, z: Number(p?.z) || 0 }
}

function vec2 (p) {
  return { x: Number(p?.x) || 0, z: Number(p?.z) || 0 }
}

/**
 * Build a schema-complete player_auth_input packet.
 */
function buildPlayerAuthInput (player, patch = {}) {
  const last = stripVolatileFromLast(player?._kaLastAuth)
  const base = last ? { ...AUTH_DEFAULTS, ...last } : { ...AUTH_DEFAULTS }
  const pkt = { ...base, ...patch }

  pkt.position = vec3(pkt.position)
  pkt.move_vector = vec2(pkt.move_vector)
  pkt.raw_move_vector = vec2(pkt.raw_move_vector)
  pkt.analogue_move_vector = vec2(pkt.analogue_move_vector)
  pkt.interact_rotation = vec2(pkt.interact_rotation)
  pkt.camera_orientation = vec3(pkt.camera_orientation)
  pkt.delta = vec3(pkt.delta)
  pkt.input_data = pkt.input_data || {}

  pkt.input_mode = pkt.input_mode ?? 'mouse'
  pkt.play_mode = pkt.play_mode ?? 'normal'
  pkt.interaction_model = pkt.interaction_model ?? 'touch'

  pkt.tick = normalizeVarint64(pkt.tick)

  for (const k of STRIP_KEYS) delete pkt[k]

  sanitizeConditionals(pkt)
  return pkt
}

function ensureAuthEncodeShape (params) {
  if (!params) return params
  const flags = params.input_data || {}
  if (!flags.block_action) delete params.block_action
  else if (!Array.isArray(params.block_action)) params.block_action = []
  if (!flags.item_stack_request) delete params.item_stack_request
  if (!flags.item_interact) delete params.transaction
  if (!flags.client_predicted_vehicle) {
    delete params.vehicle_rotation
    delete params.predicted_vehicle
  }
  for (const k of ['ticks_alive', 'on_ground', 'gaze_direction', 'item_use_transaction']) {
    delete params[k]
  }
  return params
}

function applyAuthPatch (params, patch, player) {
  if (!params) return buildPlayerAuthInput(player, patch)

  if (player) player._kaLastAuth = { ...params, ...patch }

  if (patch.tick !== undefined) {
    params.tick = normalizeVarint64(patch.tick)
  }
  if (patch.position) params.position = vec3(patch.position)
  if (patch.delta) params.delta = vec3(patch.delta)
  if (patch.move_vector) params.move_vector = vec2(patch.move_vector)
  if (patch.raw_move_vector) params.raw_move_vector = vec2(patch.raw_move_vector)
  if (patch.analogue_move_vector) params.analogue_move_vector = vec2(patch.analogue_move_vector)
  if (patch.input_data) params.input_data = { ...params.input_data, ...patch.input_data }

  return ensureAuthEncodeShape(params)
}

module.exports = {
  AUTH_DEFAULTS,
  buildPlayerAuthInput,
  applyAuthPatch,
  ensureAuthEncodeShape,
  sanitizeConditionals,
  stripVolatileFromLast
}