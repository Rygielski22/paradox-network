'use strict'

const fs = require('fs')
const path = require('path')

const filePath = path.join(__dirname, '..', 'node_modules', 'bedrock-protocol', 'src', 'handshake', 'keyExchange.js')

console.log('[Patch] Checking bedrock-protocol keyExchange.js...')

if (!fs.existsSync(filePath)) {
  console.error('[Patch] ✗ keyExchange.js not found:', filePath)
  process.exit(1)
}

let src = fs.readFileSync(filePath, 'utf8')

const START = '/* meteor-null-key-guard:start */'
const END = '/* meteor-null-key-guard:end */'

if (src.includes(START) && src.includes(END)) {
  const re = new RegExp(escapeRe(START) + '[\\s\\S]*?' + escapeRe(END) + '\\n?', 'g')
  src = src.replace(re, '')
  console.log('[Patch] Removed previous delimited guard (will reinstall latest).')
}

if (src.includes('/* meteor-null-key-guard */')) {
  const oldRe = /\/\* meteor-null-key-guard \*\/[\s\S]*?\n    \}\n/
  src = src.replace(oldRe, '')
  console.log('[Patch] Removed legacy guard (will reinstall latest).')
}

const sigRe = /function\s+startClientboundEncryption\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\{/
const m = src.match(sigRe)
if (!m) {
  console.error('[Patch] ✗ Could not find startClientboundEncryption signature. Skipping (no crash).')
  process.exit(0)
}
const arg = m[1]

const guard =
  m[0] + '\n' +
  '    ' + START + '\n' +
  '    try {\n' +
  '      var __pk = (' + arg + ' && typeof ' + arg + ' === \'object\' && ' + arg + '.key !== undefined) ? ' + arg + '.key : ' + arg + '\n' +
  '      if (typeof __pk !== \'string\' || __pk.length === 0) {\n' +
  '        console.warn(\'[encrypt] NULL client public key — closing this connection (guard active, proxy stays up)\')\n' +
  '        var __c = client\n' +
  '        // Close the half-open connection so it does NOT linger in raknet\'s\n' +
  '        // connection table (a lingering ghost blocks the same client from\n' +
  '        // reconnecting until a full restart). Deferred via setImmediate so we\n' +
  '        // never re-enter raknet-native from inside its own read callback\n' +
  '        // (synchronous re-entry corrupts its heap → double free).\n' +
  '        setImmediate(function () {\n' +
  '          try { if (__c && typeof __c.close === \'function\') __c.close(\'kick\') } catch (e) {}\n' +
  '        })\n' +
  '        return\n' +
  '      }\n' +
  '    } catch (e) {\n' +
  '      var __c2 = client\n' +
  '      setImmediate(function () { try { if (__c2 && typeof __c2.close === \'function\') __c2.close(\'kick\') } catch (_) {} })\n' +
  '      return\n' +
  '    }\n' +
  '    ' + END

src = src.replace(sigRe, guard)
fs.writeFileSync(filePath, src)
console.log('[Patch] ✓ Installed keyExchange null-key guard (arg="' + arg + '"). One bad login can no longer crash the proxy.')

function escapeRe (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
