'use strict'

/**
 * Disabler2 — Lifeboat bypass extensions (TensuraQ-style).
 * Latency echo, burst move pacing, optional velocity cancel.
 */

const MODES = {
  safe: {
    latency: true,
    velocityCancel: false,
    moveDelayMs: 16,
    queueLatency: false
  },
  aggressive: {
    latency: true,
    velocityCancel: true,
    moveDelayMs: 0,
    queueLatency: false
  },
  silent: {
    latency: true,
    velocityCancel: false,
    moveDelayMs: 16,
    queueLatency: true
  },
  ultimate: {
    latency: true,
    velocityCancel: true,
    moveDelayMs: 0,
    queueLatency: true
  }
}

const LATENCY_QUEUE_MAX = 150

function initDisabler2 (player) {
  player._disabler2Mode = 'aggressive'
  if (!player._disabler2LatencyQueue) player._disabler2LatencyQueue = []
}

function disabler2Cfg () {
  return MODES.aggressive
}

function killauraSpoofActive (player) {
  if (!player._killauraEnabled) return false
  const phase = player._killauraPhase || 'idle'
  return phase === 'going' || phase === 'attacking' || phase === 'returning'
}

function auraCombatBurstActive (player) {
  return !!(
    killauraSpoofActive(player) ||
    player._tpauraBurst
  )
}

function burstMoveDelayMs (player) {
  if (!player._disablerEnabled) return 16
  return disabler2Cfg().moveDelayMs
}

function shouldCancelBurstVelocity (player) {
  if (!player._disablerEnabled) return false
  if (!disabler2Cfg().velocityCancel) return false
  return auraCombatBurstActive(player)
}

function latencyTimestamp (params) {
  const ts = params?.timestamp
  if (Array.isArray(ts) && ts.length >= 2) return [ts[0], ts[1]]
  if (ts != null) return [0, Number(ts)]
  return null
}

function echoLatencyUpstream (player, timestamp) {
  if (!player.upstream || !timestamp) return
  try {
    player.upstream.queue('network_stack_latency', {
      timestamp,
      needs_response: false
    })
  } catch (e) {}
}

function flushLatencyQueue (player) {
  const q = player._disabler2LatencyQueue
  if (!q?.length || !player.upstream) return
  for (const ts of q) echoLatencyUpstream(player, ts)
  q.length = 0
}

function handleLatencyClientbound (player, data, des) {
  if (!player._disablerEnabled) return false
  const cfg = disabler2Cfg()
  if (!cfg.latency) return false
  if (data?.name !== 'network_stack_latency' || !data.params) return false

  const needs = data.params.needs_response
  if (needs !== true && needs !== 1) return false

  const ts = latencyTimestamp(data.params)
  if (!ts) return false

  if (cfg.queueLatency) {
    const q = player._disabler2LatencyQueue || (player._disabler2LatencyQueue = [])
    q.push(ts)
    if (q.length >= LATENCY_QUEUE_MAX) flushLatencyQueue(player)
  } else {
    echoLatencyUpstream(player, ts)
  }

  if (des) des.canceled = true
  return true
}

function setDisabler2Mode (player, mode) {
  const m = String(mode || '').toLowerCase()
  if (!MODES[m]) return false
  player._disabler2Mode = m
  if (player._disabler2LatencyQueue) player._disabler2LatencyQueue.length = 0
  return true
}

module.exports = {
  MODES,
  initDisabler2,
  disabler2Cfg,
  burstMoveDelayMs,
  shouldCancelBurstVelocity,
  auraCombatBurstActive,
  handleLatencyClientbound,
  flushLatencyQueue,
  setDisabler2Mode
}