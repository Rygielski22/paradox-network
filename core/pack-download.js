'use strict'

/**
 * Phase 1 pack download — console-safe (Xbox/PS/Switch).
 * Kicks on have_all_packs, completed, or chunk-fallback if client goes silent.
 */

function createHandlePackDownload ({ packInjector, markPlayerHasPackForPlayer, config, logger, theme }) {
  return function handlePackDownload (player) {
    const playerName = () => player.profile?.name || 'Unknown'
    const gameVersion = config.get('proxy.version', '1.26.30')
    let installKickScheduled = false
    let chunkFallbackTimer = null

    function kickMessage () {
      return (
        `${theme.enabledColor}${theme.bold}Pack Installed!\n\n` +
        `${theme.accent}${theme.brand} HUD has been downloaded.\n` +
        `${theme.accent}Please ${theme.secondary}reconnect ${theme.accent}to start playing.`
      )
    }

    function forceDisconnect () {
      try {
        if (player.status === 0) return
        player.disconnect(kickMessage())
      } catch (e) {
        logger.warn(`[Pack] disconnect failed for ${playerName()}: ${e.message}`)
        try { player.close('pack-install') } catch (_) {}
      }
    }

    function scheduleInstallKick (reason) {
      if (installKickScheduled) return
      installKickScheduled = true
      if (chunkFallbackTimer) {
        clearTimeout(chunkFallbackTimer)
        chunkFallbackTimer = null
      }
      markPlayerHasPackForPlayer(player)
      logger.success(`[Pack] ${playerName()} installed (${reason}) — reconnect to play`)
      setTimeout(forceDisconnect, 800)
    }

    function scheduleChunkFallback () {
      if (installKickScheduled || chunkFallbackTimer) return
      chunkFallbackTimer = setTimeout(() => {
        chunkFallbackTimer = null
        if (!installKickScheduled) {
          logger.info(`[Pack] ${playerName()} chunk fallback kick (no client completion status)`)
          scheduleInstallKick('chunk-fallback')
        }
      }, 4000)
    }

    function handlePackResponse (status) {
      logger.info(`[Pack] ${playerName()} → ${status}`)

      if (status === 'refused') {
        player.disconnect('§cPack required.\n§7Enable resource packs in settings and reconnect.')
        return true
      }

      if (status === 'send_packs') {
        const chunkCount = Math.ceil(packInjector.packSize / packInjector.CHUNK_SIZE)
        logger.info(`[Pack] ${playerName()} sending ${chunkCount} chunk(s) (${packInjector.packSize} bytes)`)
        player.queue('resource_pack_data_info', {
          pack_id: packInjector.PACK_ID,
          max_chunk_size: packInjector.CHUNK_SIZE,
          chunk_count: chunkCount,
          size: BigInt(packInjector.packSize),
          hash: packInjector.packHash,
          is_premium: false,
          pack_type: 'resources'
        })
        return true
      }

      if (status === 'have_all_packs') {
        player.queue('resource_pack_stack', {
          must_accept: true,
          resource_packs: [{
            uuid: packInjector.PACK_UUID,
            version: packInjector.PACK_VERSION,
            name: packInjector.PACK_NAME || ''
          }],
          game_version: gameVersion,
          experiments: [],
          experiments_previously_used: false,
          has_editor_packs: false
        })
        scheduleInstallKick('have_all_packs')
        return true
      }

      if (status === 'completed') {
        scheduleInstallKick('completed')
        return true
      }

      return false
    }

    function handlePackPacket (name, params) {
      if (name === 'resource_pack_client_response') {
        return handlePackResponse(params.response_status)
      }

      if (name === 'resource_pack_chunk_request') {
        const chunkIndex = Number(params.chunk_index)
        const offset = chunkIndex * packInjector.CHUNK_SIZE
        const chunk = packInjector.packBuffer.slice(offset, offset + packInjector.CHUNK_SIZE)

        player.queue('resource_pack_chunk_data', {
          pack_id: packInjector.PACK_ID,
          chunk_index: params.chunk_index,
          progress: BigInt(offset),
          payload: chunk
        })

        const totalChunks = Math.ceil(packInjector.packSize / packInjector.CHUNK_SIZE)
        if (chunkIndex >= totalChunks - 1) {
          scheduleChunkFallback()
        }
        return true
      }

      return false
    }

    if (!packInjector.packBuffer || packInjector.packSize === 0) {
      logger.error('Pack buffer is null — cannot serve pack')
      player.disconnect('§cResource pack unavailable.\n§7Please contact server admin.')
      return
    }

    player._packPhase1 = true
    const originalReadPacket = player.readPacket.bind(player)

    player.readPacket = function (packet) {
      let des
      try {
        des = player.server.deserializer.parsePacketBuffer(packet)
      } catch (e) {
        const head = packet && packet.length ? packet.slice(0, 8).toString('hex') : ''
        logger.warn(`[Pack] ${playerName()} parse fail — forwarding (${e.message})${head ? ' buf=' + head : ''}`)
        originalReadPacket(packet)
        return
      }

      if (handlePackPacket(des.data.name, des.data.params)) return
      originalReadPacket(packet)
    }

    // Backup path — relay emits serverbound on some clients after startRelaying.
    player.on('serverbound', (data, des) => {
      if (!player._packPhase1) return
      if (!data?.name) return
      if (handlePackPacket(data.name, data.params) && des) {
        des.canceled = true
      }
    })

    const sendPackInfo = () => {
      logger.info(`[Pack] Handshake ready for ${playerName()} — advertising ${packInjector.PACK_UUID}`)
      player.queue('resource_packs_info', {
        must_accept: true,
        has_addons: false,
        has_scripts: false,
        disable_vibrant_visuals: false,
        world_template: {
          uuid: '00000000-0000-0000-0000-000000000000',
          version: ''
        },
        texture_packs: [{
          uuid: packInjector.PACK_UUID,
          version: packInjector.PACK_VERSION,
          size: BigInt(packInjector.packSize),
          content_key: '',
          sub_pack_name: '',
          content_identity: packInjector.packHash ? packInjector.packHash.toString('hex') : '',
          has_scripts: false,
          addon_pack: false,
          rtx_enabled: false,
          cdn_url: ''
        }]
      })
    }

    if (player.status >= 3) {
      sendPackInfo()
    } else {
      player.once('join', sendPackInfo)
    }
  }
}

module.exports = { createHandlePackDownload }