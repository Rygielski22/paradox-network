'use strict'

// Minecraft default font advance widths (px @ scale 1).
const WIDTH = {
  ' ': 4, '!': 2, '"': 5, '#': 6, '$': 6, '%': 6, '&': 6, "'": 3,
  '(': 5, ')': 5, '*': 5, '+': 6, ',': 2, '-': 6, '.': 2, '/': 6,
  '0': 6, '1': 6, '2': 6, '3': 6, '4': 6, '5': 6, '6': 6, '7': 6,
  '8': 6, '9': 6, ':': 2, ';': 2, '<': 5, '=': 6, '>': 5, '?': 6,
  '@': 7, 'A': 6, 'B': 6, 'C': 6, 'D': 6, 'E': 6, 'F': 6, 'G': 6,
  'H': 6, 'I': 4, 'J': 6, 'K': 6, 'L': 6, 'M': 6, 'N': 6, 'O': 6,
  'P': 6, 'Q': 6, 'R': 6, 'S': 6, 'T': 6, 'U': 6, 'V': 6, 'W': 6,
  'X': 6, 'Y': 6, 'Z': 6, '[': 4, '\\': 6, ']': 4, '^': 6, '_': 6,
  '`': 3, 'a': 6, 'b': 6, 'c': 6, 'd': 6, 'e': 6, 'f': 5, 'g': 6,
  'h': 6, 'i': 2, 'j': 6, 'k': 5, 'l': 3, 'm': 6, 'n': 6, 'o': 6,
  'p': 6, 'q': 6, 'r': 6, 's': 6, 't': 4, 'u': 6, 'v': 6, 'w': 6,
  'x': 6, 'y': 6, 'z': 6, '{': 5, '|': 2, '}': 5, '~': 7
}

function stripFormat (text) {
  return String(text).replace(/§[0-9a-fk-or]/gi, '')
}

function measureText (text) {
  let w = 0
  for (const ch of stripFormat(text)) w += WIDTH[ch] ?? 6
  return w
}

function padLineToWidth (line, targetWidth) {
  let w = measureText(line)
  if (w >= targetWidth) return line
  let prefix = ''
  while (w + 4 <= targetWidth) {
    prefix += ' '
    w += 4
  }
  return prefix + line
}

function alignLinesRight (lines) {
  if (!lines.length) return lines
  const maxW = Math.max(...lines.map(measureText))
  return lines.map((line) => padLineToWidth(line, maxW))
}

module.exports = {
  measureText,
  alignLinesRight
}