const decoder = new TextDecoder()
export const toUTF8String = (
  input: Uint8Array,
  start = 0,
  end = input.length,
  // A view is enough to read from, where slice would copy the range first
) => decoder.decode(input.subarray(start, end))

export const toHexString = (input: Uint8Array, start = 0, end = input.length) =>
  input
    .subarray(start, end)
    .reduce((memo, i) => memo + `0${i.toString(16)}`.slice(-2), '')

/**
 * Every read below composes its value from indexed bytes rather than through a
 * `DataView`. A view has to be built per read, since one spanning the whole
 * input would reach into the rest of the underlying ArrayBuffer, which for a
 * pooled Node Buffer is somebody else's data. That allocation dominated the
 * tag-heavy formats: TIFF spent most of its time on it.
 */
const checkBounds = (input: Uint8Array, offset: number, size: number) => {
  if (offset < 0 || offset + size > input.byteLength) {
    throw new TypeError('Truncated input, cannot read past the end of the data')
  }
}

export const readInt16LE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 2)
  // Shifting a 16-bit value up to the sign bit and back down sign-extends it
  return (((input[offset + 1] << 8) | input[offset]) << 16) >> 16
}

export const readUInt16BE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 2)
  return (input[offset] << 8) | input[offset + 1]
}

export const readUInt16LE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 2)
  return (input[offset + 1] << 8) | input[offset]
}

export const readUInt24LE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 3)
  return (input[offset + 2] << 16) | (input[offset + 1] << 8) | input[offset]
}

export const readInt32LE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 4)
  return (
    (input[offset + 3] << 24) |
    (input[offset + 2] << 16) |
    (input[offset + 1] << 8) |
    input[offset]
  )
}

// The top byte is added rather than shifted in: `<< 24` would make the result
// signed, and these four bytes are an unsigned quantity
export const readUInt32BE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 4)
  return (
    input[offset] * 0x1000000 +
    ((input[offset + 1] << 16) | (input[offset + 2] << 8) | input[offset + 3])
  )
}

export const readUInt32LE = (input: Uint8Array, offset = 0) => {
  checkBounds(input, offset, 4)
  return (
    input[offset + 3] * 0x1000000 +
    ((input[offset + 2] << 16) | (input[offset + 1] << 8) | input[offset])
  )
}

export const readUInt64 = (
  input: Uint8Array,
  offset: number,
  isBigEndian: boolean,
): bigint => {
  checkBounds(input, offset, 8)
  const high = isBigEndian
    ? readUInt32BE(input, offset)
    : readUInt32LE(input, offset + 4)
  const low = isBigEndian
    ? readUInt32BE(input, offset + 4)
    : readUInt32LE(input, offset)
  return (BigInt(high) << 32n) | BigInt(low)
}

// Abstract reading multi-byte unsigned integers
export function readUInt(
  input: Uint8Array,
  bits: 16 | 32,
  offset = 0,
  isBigEndian = false,
): number {
  if (bits === 16) {
    return isBigEndian
      ? readUInt16BE(input, offset)
      : readUInt16LE(input, offset)
  }
  return isBigEndian ? readUInt32BE(input, offset) : readUInt32LE(input, offset)
}

// A box header is a 32-bit size followed by a four-character code. Two sizes
// are special: zero means the box runs to the end of the file, and one means
// the real size is the 64-bit value stored right after the header.
const BOX_HEADER_SIZE = 8
const LARGE_BOX_HEADER_SIZE = 16
const SIZE_EXTENDS_TO_EOF = 0
const SIZE_IS_64_BIT = 1

export interface Box {
  name: string
  offset: number
  /** Bytes between the start of the box and its payload */
  headerSize: number
  /** Bytes of the box that are actually present in the input */
  size: number
}

export function readBox(input: Uint8Array, offset: number): Box | undefined {
  const available = input.length - offset
  if (available < BOX_HEADER_SIZE) return

  const name = toUTF8String(input, offset + 4, offset + 8)
  const declaredSize = readUInt32BE(input, offset)

  let headerSize = BOX_HEADER_SIZE
  let size = declaredSize
  if (declaredSize === SIZE_EXTENDS_TO_EOF) {
    size = available
  } else if (declaredSize === SIZE_IS_64_BIT) {
    if (available < LARGE_BOX_HEADER_SIZE) return
    headerSize = LARGE_BOX_HEADER_SIZE
    size = Number(readUInt64(input, offset + BOX_HEADER_SIZE, true))
  }

  // A box cannot be smaller than the header that describes it
  if (size < headerSize) return

  // Clamping instead of rejecting keeps a cropped file readable, as long as
  // the boxes we need survived the cut
  return { name, offset, headerSize, size: Math.min(size, available) }
}

export function findBox(
  input: Uint8Array,
  boxName: string,
  startOffset: number,
): Box | undefined {
  let offset = startOffset
  while (offset < input.length) {
    const box = readBox(input, offset)
    if (!box) return
    if (box.name === boxName) return box
    // readBox never returns a box shorter than its header, so this advances
    offset += box.size
  }
}
