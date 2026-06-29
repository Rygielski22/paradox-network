'use strict'

/**
 * Paradox Network — Beautiful Terminal Banner
 * Dark blue + white. Clean. Modern. Premium.
 */

const C = {
  p: '\x1b[34m',
  b: '\x1b[34m',
  w: '\x1b[97m',
  d: '\x1b[90m',
  r: '\x1b[0m'
}

const W = 66

function strip(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

function line(inner) {
  const v = strip(inner)
  return `${C.p}│${C.r} ${inner}${' '.repeat(Math.max(0, W - v.length))} ${C.p}│${C.r}`
}

function printParadoxBanner(opts = {}) {
  const {
    version = '1.0.0',
    protocol = '1.26.30',
    host = '0.0.0.0',
    port = 19132,
    target = '127.0.0.1:19132',
    prefix = '?',
    maxPlayers = 100
  } = opts

  const boxTop = `${C.d}╭${'─'.repeat(W + 2)}╮${C.r}`
  const boxBot = `${C.d}╰${'─'.repeat(W + 2)}╯${C.r}`

  const banner = [
    '',
    boxTop,
    line(''),
    line(`${C.b}   PARADOX${C.r}  ${C.p}NETWORK${C.r}`),
    line(''),
    line(`${C.d}──────────────────────────────────────────────────${C.r}`),
    line(''),
    line(`${C.d}Protocol${C.r}   ${C.w}${protocol}${C.r}`),
    line(`${C.d}Listen${C.r}     ${C.w}${host}:${port}${C.r}`),
    line(`${C.d}Target${C.r}     ${C.w}${target}${C.r}`),
    line(`${C.d}Slots${C.r}      ${C.w}${maxPlayers}${C.r}`),
    line(`${C.d}Command${C.r}    ${C.b}/${prefix}help${C.r}`),
    line(''),
    line(`${C.d}──────────────────────────────────────────────────${C.r}`),
    line(''),
    line(`${C.p}Ready to dominate.${C.r}`),
    boxBot,
    ''
  ]

  banner.forEach(l => console.log(l))

  console.log(`${C.p}▶ ${C.w}Paradox Network${C.r} ${C.d}— ${C.b}/${prefix}help${C.r}`)
  console.log(`${C.d}${'─'.repeat(W + 4)}${C.r}\n`)
}

module.exports = { printParadoxBanner }
