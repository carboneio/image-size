import type { IImage, ISize } from './interface'
import { readUInt, readUInt64, toHexString, toUTF8String } from './utils'

const CONSTANTS = {
  TAG: {
    WIDTH: 256,
    HEIGHT: 257,
    COMPRESSION: 259,
  },
  TYPE: {
    SHORT: 3,
    LONG: 4,
    LONG8: 16,
  },
  ENTRY_SIZE: {
    STANDARD: 12,
    BIG: 20,
  },
  COUNT_SIZE: {
    STANDARD: 2,
    BIG: 8,
  },
} as const

interface TIFFFormat {
  isBigEndian: boolean
  isBigTiff: boolean
}

interface TIFFInfo extends ISize {
  compression?: number
}

// Where the first image-file-directory begins
function findIFD(input: Uint8Array, { isBigEndian, isBigTiff }: TIFFFormat) {
  return isBigTiff
    ? Number(readUInt64(input, 8, isBigEndian))
    : readUInt(input, 32, 4, isBigEndian)
}

function readTagValue(
  input: Uint8Array,
  type: number,
  offset: number,
  isBigEndian: boolean,
): number {
  switch (type) {
    case CONSTANTS.TYPE.SHORT:
      return readUInt(input, 16, offset, isBigEndian)
    case CONSTANTS.TYPE.LONG:
      return readUInt(input, 32, offset, isBigEndian)
    case CONSTANTS.TYPE.LONG8: {
      const value = Number(readUInt64(input, offset, isBigEndian))
      if (value > Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Value too large')
      }
      return value
    }
    // Unreachable: `extractTags` filters out every other type before calling
    /* c8 ignore next 2 */
    default:
      return 0
  }
}

interface TIFFTags {
  [key: number]: number
}

function extractTags(
  input: Uint8Array,
  ifdOffset: number,
  { isBigEndian, isBigTiff }: TIFFFormat,
): TIFFTags {
  const tags: TIFFTags = {}
  const entrySize = isBigTiff
    ? CONSTANTS.ENTRY_SIZE.BIG
    : CONSTANTS.ENTRY_SIZE.STANDARD
  const valueOffset = isBigTiff ? 12 : 8

  // A directory says how many entries it holds. Reading on until a zero tag
  // or the end of the file instead ran into whatever came next, so the last
  // page of a multi-page file overwrote the dimensions of the first.
  const declared = isBigTiff
    ? Number(readUInt64(input, ifdOffset, isBigEndian))
    : readUInt(input, 16, ifdOffset, isBigEndian)

  const start =
    ifdOffset +
    (isBigTiff ? CONSTANTS.COUNT_SIZE.BIG : CONSTANTS.COUNT_SIZE.STANDARD)
  const carried = Math.floor((input.length - start) / entrySize)
  const count = Math.min(declared, Math.max(carried, 0))

  // Walking by index rather than reslicing the remainder on every entry: a
  // file whose tag list never terminates used to cost quadratic time
  for (let entry = 0; entry < count; entry++) {
    const offset = start + entry * entrySize
    const code = readUInt(input, 16, offset, isBigEndian)
    const type = readUInt(input, 16, offset + 2, isBigEndian)
    const length = isBigTiff
      ? Number(readUInt64(input, offset + 4, isBigEndian))
      : readUInt(input, 32, offset + 4, isBigEndian)

    if (
      length === 1 &&
      (type === CONSTANTS.TYPE.SHORT ||
        type === CONSTANTS.TYPE.LONG ||
        (isBigTiff && type === CONSTANTS.TYPE.LONG8))
    ) {
      tags[code] = readTagValue(input, type, offset + valueOffset, isBigEndian)
    }
  }

  return tags
}

function determineFormat(input: Uint8Array): TIFFFormat {
  const signature = toUTF8String(input, 0, 2)
  const version = readUInt(input, 16, 2, signature === 'MM')

  return {
    isBigEndian: signature === 'MM',
    isBigTiff: version === 43,
  }
}

function validateBigTIFFHeader(input: Uint8Array, isBigEndian: boolean): void {
  const byteSize = readUInt(input, 16, 4, isBigEndian)
  const reserved = readUInt(input, 16, 6, isBigEndian)

  if (byteSize !== 8 || reserved !== 0) {
    throw new TypeError('Invalid BigTIFF header')
  }
}

const signatures = new Set([
  '49492a00', // Little Endian
  '4d4d002a', // Big Endian
  '49492b00', // BigTIFF Little Endian
  '4d4d002b', // BigTIFF Big Endian
])

export const TIFF: IImage = {
  validate: (input) => {
    const signature = toHexString(input, 0, 4)
    return signatures.has(signature)
  },

  calculate(input) {
    const format = determineFormat(input)

    if (format.isBigTiff) {
      validateBigTIFFHeader(input, format.isBigEndian)
    }

    const tags = extractTags(input, findIFD(input, format), format)

    const info: TIFFInfo = {
      height: tags[CONSTANTS.TAG.HEIGHT],
      width: tags[CONSTANTS.TAG.WIDTH],
      type: format.isBigTiff ? 'bigtiff' : 'tiff',
    }

    if (tags[CONSTANTS.TAG.COMPRESSION]) {
      info.compression = tags[CONSTANTS.TAG.COMPRESSION]
    }

    if (!info.width || !info.height) {
      throw new TypeError('Invalid Tiff. Missing tags')
    }

    return info
  },
}
