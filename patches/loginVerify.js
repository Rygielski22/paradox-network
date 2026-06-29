const JWT = require('jsonwebtoken')
const constants = require('./constants')
const debug = require('debug')('minecraft-protocol')
const crypto = require('crypto')

module.exports = (client, server, options) => {

  const getDER = b64 => {
    if (!b64) throw new Error('Missing key data')
    return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
  }

  function decodeJWTPayload (token) {
    const parts = token.split('.')
    if (parts.length < 2) throw new Error('Invalid JWT format')
    const payload = Buffer.from(parts[1], 'base64').toString('utf-8')
    return JSON.parse(payload)
  }

  function decodeJWTHeader (token) {
    const parts = token.split('.')
    if (parts.length < 2) throw new Error('Invalid JWT format')
    const header = Buffer.from(parts[0], 'base64').toString('utf-8')
    return JSON.parse(header)
  }

  function parseTokenData (token) {
    function normalizeToken (token) {
      return token.replace(/^MCToken\s+/i, '')
    }

    const normalized = normalizeToken(token)

    if (options.offline) {
      const payload = decodeJWTPayload(normalized)
      const header = decodeJWTHeader(normalized)
      const key = payload.cpk || payload.clientPublicKey || payload.identityPublicKey || header.x5u
      return {
        key,
        data: {
          extraData: {
            XUID: payload.xid || payload.XUID || payload.xuid || '0',
            displayName: payload.xname || payload.displayName || 'Player',
            identity: payload.identity,
            PlayFabID: payload.pfbid || payload.playFabId || payload.PlayFabID,
            PlayFabTitleID: payload.pfbtid || payload.playFabTitleId || payload.PlayFabTitleID
          }
        }
      }
    }

    const x5u = getX5U(normalized)
    const decoded = JWT.verify(normalized, getDER(x5u), { algorithms: ['ES384', 'RS256'] })
    if (!decoded || typeof decoded !== 'object') throw new Error('Invalid login token')

    const payload = decoded || {}
    const key = payload.cpk || payload.clientPublicKey || x5u
    return {
      key,
      data: {
        extraData: {
          XUID: payload.xid || payload.XUID || payload.xuid || '0',
          displayName: payload.xname || payload.displayName || 'Player',
          identity: payload.identity,
          PlayFabID: payload.pfbid || payload.playFabId || payload.PlayFabID,
          PlayFabTitleID: payload.pfbtid || payload.playFabTitleId || payload.PlayFabTitleID
        }
      }
    }
  }

  function verifyAuth (chain, token) {

    if (options.offline) {

      if (!chain || chain.length === 0 || chain.every(entry => !entry)) {
        if (token) return parseTokenData(token)

        return { key: null, data: { extraData: { displayName: 'Player', identity: '00000000-0000-0000-0000-000000000000', XUID: '0' } } }
      }

      let data = {}
      let finalKey = null
      for (const tok of chain) {
        try {
          const payload = decodeJWTPayload(tok)
          const header = decodeJWTHeader(tok)

          finalKey = payload.identityPublicKey || payload.cpk || payload.clientPublicKey || header.x5u || finalKey
          data = { ...data, ...payload }
        } catch (e) {
          debug('Failed to decode chain token in offline mode', e.message)
        }
      }

      if (!finalKey && token) {
        try { finalKey = parseTokenData(token).key || finalKey } catch (e) {}
      }
      if (!finalKey) {
        console.warn('[loginVerify] NULL key after chain scan. chain tokens=' + chain.length +
          ' — dumping field names to locate the key:')
        for (let i = 0; i < chain.length; i++) {
          try {
            const p = decodeJWTPayload(chain[i]); const h = decodeJWTHeader(chain[i])
            console.warn(`  chain[${i}] payloadKeys=[${Object.keys(p).join(',')}] headerKeys=[${Object.keys(h).join(',')}]`)
          } catch (e) {}
        }
      }
      return { key: finalKey, data }
    }

    if ((!chain || chain.length === 0 || chain.every(entry => !entry)) && token) {
      throw new Error('Missing certificate chain for authenticated login')
    }

    let data = {}
    let didVerify = false
    let pubKey = getDER(getX5U(chain[0]))
    let finalKey = null

    for (const token of chain) {
      const decoded = JWT.verify(token, pubKey, { algorithms: ['ES384'] })
      const x5u = getX5U(token)
      if (x5u === constants.PUBLIC_KEY && !data.extraData?.XUID) {
        didVerify = true
        debug('Verified client with mojang key', x5u)
      }
      pubKey = decoded.identityPublicKey ? getDER(decoded.identityPublicKey) : x5u
      finalKey = decoded.identityPublicKey || finalKey
      data = { ...data, ...decoded }
    }

    if (!didVerify) {
      client.disconnect('disconnectionScreen.notAuthenticated')
    }

    return { key: finalKey, data }
  }

  function verifySkin (publicKey, token) {

    if (options.offline) {
      return decodeJWTPayload(token)
    }
    const pubKey = getDER(publicKey)
    const decoded = JWT.verify(token, pubKey, { algorithms: ['ES384'] })
    return decoded
  }

  client.decodeLoginJWT = (authTokens, skinTokens, authToken = '') => {
    const { key, data } = verifyAuth(authTokens, authToken)
    let finalKey = key

    if (!finalKey && skinTokens) {
      try {
        const h = decodeJWTHeader(skinTokens)
        if (h && h.x5u) { finalKey = h.x5u; console.warn('[loginVerify] recovered client key from skin token x5u') }
      } catch (e) {}
    }
    if (!finalKey) console.warn('[loginVerify] STILL no client key — this login will be rejected by the guard')
    const skinData = verifySkin(finalKey, skinTokens)
    return { key: finalKey, userData: data, skinData }
  }

  client.encodeLoginJWT = (localChain, mojangChain) => {
    const chains = []
    chains.push(localChain)
    for (const chain of mojangChain) {
      chains.push(chain)
    }
    return chains
  }
}

function getX5U (token) {
  const [header] = token.split('.')
  const hdec = Buffer.from(header, 'base64').toString('utf-8')
  const hjson = JSON.parse(hdec)
  return hjson.x5u
}
