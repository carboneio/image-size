const decoder = new TextDecoder()
export const toUTF8String = (
  input: Uint8Array,
  start = 0,
  end = input.length,
) => decoder.decode(input.slice(start, end))

export const toHexString = (input: Uint8Array, start = 0, end = input.length) =>
  input
    .slice(start, end)
    .reduce((memo, i) => memo + `0${i.toString(16)}`.slice(-2), '')

// A DataView built without an explicit length spans the rest of the underlying
// ArrayBuffer, which for a pooled Node Buffer is somebody else's data. Passing
// the length keeps every read inside the slice the caller actually handed over.
const getView = (input: Uint8Array, offset: number, size: number) => {
  if (offset < 0 || offset + size > input.byteLength) {
    throw new TypeError('Truncated input, cannot read past the end of the data')
  }
  return new DataView(input.buffer, input.byteOffset + offset, size)
}

export const readInt16LE = (input: Uint8Array, offset = 0) =>
  getView(input, offset, 2).getInt16(0, true)

export const readUInt16BE = (input: Uint8Array, offset = 0) =>
  getView(input, offset, 2).getUint16(0, false)

export const readUInt16LE = (input: Uint8Array, offset = 0) =>
  getView(input, offset, 2).getUint16(0, true)

// DataView doesn't have 24-bit methods
export const readUInt24LE = (input: Uint8Array, offset = 0) => {
  const view = getView(input, offset, 3)
  return view.getUint16(0, true) + (view.getUint8(2) << 16)
}

export const readInt32LE = (input: Uint8Array, offset = 0) =>
  getView(input, offset, 4).getInt32(0, true)

export const readUInt32BE = (input: Uint8Array, offset = 0) =>
  getView(input, offset, 4).getUint32(0, false)

export const readUInt32LE = (input: Uint8Array, offset = 0) =>
  getView(input, offset, 4).getUint32(0, true)

export const readUInt64 = (
  input: Uint8Array,
  offset: number,
  isBigEndian: boolean,
): bigint => getView(input, offset, 8).getBigUint64(0, !isBigEndian)

// Abstract reading multi-byte unsigned integers
const methods = {
  readUInt16BE,
  readUInt16LE,
  readUInt32BE,
  readUInt32LE,
} as const

type MethodName = keyof typeof methods
export function readUInt(
  input: Uint8Array,
  bits: 16 | 32,
  offset = 0,
  isBigEndian = false,
): number {
  const endian = isBigEndian ? 'BE' : 'LE'
  const methodName = `readUInt${bits}${endian}` as MethodName
  return methods[methodName](input, offset)
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
