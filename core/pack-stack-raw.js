'use strict'

/**
 * Append Meteor pack entries to raw resource_pack packets without re-encoding
 * Lifeboat fields (re-encoding breaks joins / causes resourcepack disconnect).
 */

const UUID = require('uuid-1345')

function readVarInt (buf, off) {
  let num = 0
  let shift = 0
  let o = off
  while (o < buf.length) {
    const b = buf[o++]
    num |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: num, offset: o }
    shift += 7
    if (shift > 35) throw new Error('varint overflow')
  }
  throw new Error('varint eof')
}

function writeVarInt (n) {
  const out = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}

function readString (buf, off) {
  const len = readVarInt(buf, off)
  const start = len.offset
  const end = start + len.value
  if (end > buf.length) throw new Error('string eof')
  return { value: buf.toString('utf8', start, end), offset: end }
}

function writeString (s) {
  const body = Buffer.from(s, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

function readLi16 (buf, off) {
  if (off + 2 > buf.length) throw new Error('li16 eof')
  return { value: buf.readInt16LE(off), offset: off + 2 }
}

function writeLi16 (n) {
  const b = Buffer.alloc(2)
  b.writeInt16LE(n, 0)
  return b
}

function writeLu64 (n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n), 0)
  return b
}

function skipTexturePackEntry (buf, off) {
  off += 16
  let s = readString(buf, off); off = s.offset
  off += 8
  s = readString(buf, off); off = s.offset
  s = readString(buf, off); off = s.offset
  s = readString(buf, off); off = s.offset
  off += 3
  s = readString(buf, off); off = s.offset
  return off
}

function writeTexturePackEntry (uuid, version, size) {
  return Buffer.concat([
    UUID.parse(uuid),
    writeString(version),
    writeLu64(size),
    writeString(''),
    writeString(''),
    writeString(''),
    Buffer.from([0, 0, 0]),
    writeString('')
  ])
}

function appendTexturePackToInfoBuffer (packet, uuid, version, size) {
  if (!packet || packet.length < 8) return null

  let off = 0
  const id = readVarInt(packet, off)
  off = id.offset
  if (off + 4 > packet.length) return null
  off += 4

  off += 16
  const wtVer = readString(packet, off)
  off = wtVer.offset

  const countPos = off
  const count = readLi16(packet, off)
  off = count.offset

  for (let i = 0; i < count.value; i++) {
    const existing = UUID.stringify(packet.slice(off, off + 16))
    if (existing === uuid) return null
    off = skipTexturePackEntry(packet, off)
  }

  const afterPacks = off
  const newEntry = writeTexturePackEntry(uuid, version, size)

  return Buffer.concat([
    packet.slice(0, countPos),
    writeLi16(count.value + 1),
    packet.slice(count.offset, afterPacks),
    newEntry,
    packet.slice(afterPacks)
  ])
}

function appendPackToStackBuffer (packet, uuid, version, name) {
  if (!packet || packet.length < 4) return null

  let off = 0
  const id = readVarInt(packet, off)
  off = id.offset

  if (off >= packet.length) return null
  off += 1

  const countPos = off
  const count = readVarInt(packet, off)
  off = count.offset

  for (let i = 0; i < count.value; i++) {
    let s = readString(packet, off)
    if (s.value === uuid) return null
    off = s.offset
    s = readString(packet, off); off = s.offset
    s = readString(packet, off); off = s.offset
  }

  const afterPacks = off
  const newPack = Buffer.concat([writeString(uuid), writeString(version), writeString(name)])

  return Buffer.concat([
    packet.slice(0, countPos),
    writeVarInt(count.value + 1),
    packet.slice(count.offset, afterPacks),
    newPack,
    packet.slice(afterPacks)
  ])
}

function validatePackStackBuffer (packet) {
  if (!packet || packet.length < 4) return false
  try {
    let off = 0
    const id = readVarInt(packet, off)
    off = id.offset
    if (off >= packet.length) return false
    off += 1
    const count = readVarInt(packet, off)
    off = count.offset
    for (let i = 0; i < count.value; i++) {
      let s = readString(packet, off); off = s.offset
      s = readString(packet, off); off = s.offset
      s = readString(packet, off); off = s.offset
    }
    return off <= packet.length
  } catch (_) {
    return false
  }
}

function validatePacksInfoBuffer (packet) {
  if (!packet || packet.length < 8) return false
  try {
    let off = 0
    const id = readVarInt(packet, off)
    off = id.offset
    off += 4
    off += 16
    const wt = readString(packet, off); off = wt.offset
    const count = readLi16(packet, off); off = count.offset
    for (let i = 0; i < count.value; i++) {
      off = skipTexturePackEntry(packet, off)
    }
    return off <= packet.length
  } catch (_) {
    return false
  }
}

module.exports = {
  appendPackToStackBuffer,
  appendTexturePackToInfoBuffer,
  validatePackStackBuffer,
  validatePacksInfoBuffer
}