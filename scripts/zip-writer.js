/**
 * Minimal dependency-free ZIP writer (store method, no compression).
 * Produces a spec-compliant .zip with forward-slash entry paths, which is
 * exactly what Minecraft Bedrock resource packs require.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')

// CRC32 table
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF]
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/**
 * @param {string} outputPath  destination .zip file path
 * @param {Array<{name:string, data:Buffer}>} files  entries (name uses "/")
 */
function writeZip(outputPath, files) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const crc = crc32(raw)

    // Deflate the content (method 8). Falls back to store if it somehow grows.
    let method = 8
    let compressed = zlib.deflateRawSync(raw, { level: 9 })
    if (compressed.length >= raw.length) {
      method = 0
      compressed = raw
    }

    // ── Local file header ──
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)   // signature
    local.writeUInt16LE(20, 4)           // version needed
    local.writeUInt16LE(0, 6)            // flags
    local.writeUInt16LE(method, 8)       // compression method
    local.writeUInt16LE(0, 10)           // mod time
    local.writeUInt16LE(0, 12)           // mod date
    local.writeUInt32LE(crc, 14)         // crc32
    local.writeUInt32LE(compressed.length, 18) // compressed size
    local.writeUInt32LE(raw.length, 22)  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)           // extra len

    localParts.push(local, nameBuf, compressed)

    // ── Central directory header ──
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)         // version made by
    central.writeUInt16LE(20, 6)         // version needed
    central.writeUInt16LE(0, 8)          // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)         // extra len
    central.writeUInt16LE(0, 32)         // comment len
    central.writeUInt16LE(0, 34)         // disk number
    central.writeUInt16LE(0, 36)         // internal attrs
    central.writeUInt32LE(0, 38)         // external attrs
    central.writeUInt32LE(offset, 42)    // local header offset

    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + compressed.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const localBuf = Buffer.concat(localParts)

  // ── End of central directory ──
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20)

  fs.writeFileSync(outputPath, Buffer.concat([localBuf, centralBuf, eocd]))
  return localBuf.length + centralBuf.length + eocd.length
}

module.exports = { writeZip }
