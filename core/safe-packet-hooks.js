'use strict'

/**
 * Wrap clientbound/serverbound listeners so one module throw cannot
 * tear down the relay connection mid-session.
 */
function installSafePacketHooks (player, logger) {
  if (!player || player._meteorSafeHooks) return
  player._meteorSafeHooks = true

  const wrap = (event, fn) => {
    if (typeof fn !== 'function') return fn
    return (...args) => {
      try {
        return fn(...args)
      } catch (err) {
        const pkt = args[0]?.name || '?'
        const msg = `[SafeHook] ${event} ${pkt}: ${err.message}`
        if (global._meteorPacketDiag) {
          global._meteorPacketDiag.recordModuleError(player, event, pkt, err.message)
        }
        if (logger?.error) logger.error(msg)
        else console.error(msg)
        if (logger?.debug && err.stack) logger.debug(err.stack)
      }
    }
  }

  const origOn = player.on.bind(player)
  const origOnce = player.once.bind(player)
  const origOff = (player.off || player.removeListener).bind(player)

  player.on = function (event, fn) {
    if (event === 'clientbound' || event === 'serverbound') return origOn(event, wrap(event, fn))
    return origOn(event, fn)
  }
  player.once = function (event, fn) {
    if (event === 'clientbound' || event === 'serverbound') return origOnce(event, wrap(event, fn))
    return origOnce(event, fn)
  }
  player.off = function (event, fn) {
    return origOff(event, fn)
  }
}

module.exports = { installSafePacketHooks }