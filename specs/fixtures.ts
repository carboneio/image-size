import type { imageType } from '../lib/types/index'

/**
 * Synthetic image builders.
 *
 * Every builder produces the smallest byte sequence that a real decoder would
 * still recognise, plus an arbitrary amount of trailing payload so that the
 * same fixture can be generated as a tiny file or as a multi-megabyte one.
 */

export interface FixtureOptions {
  width: number
  height: number
  /** Extra bytes appended as pixel/entropy data, to grow the file */
  payload: number
}

export interface Fixture {
  name: string
  /** Type reported by the detector */
  detected: imageType
  /** Value of the `type` field returned by `imageSize` */
  reported: string
  data: Uint8Array
  /** Dimensions actually encoded, after per-format clamping */
  width: number
  height: number
}

const encoder = new TextEncoder()

export const ascii = (text: string): Uint8Array => encoder.encode(text)

type Chunk = Uint8Array | number[]

export const concat = (...chunks: Chunk[]): Uint8Array => {
  const parts = chunks.map((chunk) =>
    chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk),
  )
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  )
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export const u16be = (value: number): Uint8Array =>
  Uint8Array.from([(value >>> 8) & 0xff, value & 0xff])

export const u16le = (value: number): Uint8Array =>
  Uint8Array.from([value & 0xff, (value >>> 8) & 0xff])

export const u24le = (value: number): Uint8Array =>
  Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff])

export const u32be = (value: number): Uint8Array =>
  Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])

export const u32le = (value: number): Uint8Array =>
  Uint8Array.from([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ])

const u64 = (value: number | bigint, littleEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), littleEndian)
  return bytes
}

export const u64be = (value: number | bigint): Uint8Array => u64(value, false)
export const u64le = (value: number | bigint): Uint8Array => u64(value, true)

/** Deterministic filler, so that every run produces byte-identical fixtures */
export const filler = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 31 + 7) & 0xff
  }
  return bytes
}

const asciiFiller = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    bytes[index] = index % 32 === 31 ? 0x0a : 0x30 + (index % 10)
  }
  return bytes
}

/** ISO base media file format box: size, four-character code, payload */
export const box = (name: string, ...content: Chunk[]): Uint8Array => {
  const body = concat(...content)
  return concat(u32be(body.length + 8), ascii(name), body)
}

/** Writes bits least-significant-bit first, mirroring `BitReader` */
export class BitWriter {
  private readonly bytes: number[] = []
  private bitOffset = 0

  writeBits(value: number, length: number): this {
    let written = 0
    while (written < length) {
      if (this.bitOffset === 0) this.bytes.push(0)
      const index = this.bytes.length - 1
      const bitsToWrite = Math.min(length - written, 8 - this.bitOffset)
      const mask = (1 << bitsToWrite) - 1
      this.bytes[index] |= ((value >>> written) & mask) << this.bitOffset
      written += bitsToWrite
      this.bitOffset = (this.bitOffset + bitsToWrite) % 8
    }
    return this
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

type Geometry = Pick<Fixture, 'data' | 'width' | 'height'>
type Builder = (options: FixtureOptions) => Geometry

// --- ICO / CUR -------------------------------------------------------------

/** ICO and CUR store dimensions in a single byte, where 0 means 256 */
const iconFile =
  (kind: 1 | 2): Builder =>
  ({ width: requestedWidth, height: requestedHeight, payload }) => {
    const clamp = (value: number) => Math.min(256, Math.max(1, value))
    const width = clamp(requestedWidth)
    const height = clamp(requestedHeight)
    const pixels = filler(payload)
    const data = concat(
      u16le(0),
      u16le(kind),
      u16le(1),
      [width & 0xff, height & 0xff, 0, 0],
      u16le(1),
      u16le(32),
      u32le(pixels.length),
      u32le(22),
      pixels,
    )
    return { data, width, height }
  }

// --- HEIF ------------------------------------------------------------------

const heifFile =
  (brand: string): Builder =>
  ({ width, height, payload }) => {
    const ispe = box('ispe', u32be(0), u32be(width), u32be(height))
    const data = concat(
      box('ftyp', ascii(brand), u32be(0)),
      box('meta', u32be(0), box('iprp', box('ipco', ispe))),
      box('mdat', filler(payload)),
    )
    return { data, width, height }
  }

// --- ICNS ------------------------------------------------------------------

const ICNS_ICON_TYPES: Record<number, string> = {
  16: 'is32',
  32: 'il32',
  48: 'ih32',
  64: 'icp6',
  128: 'it32',
  256: 'ic08',
  512: 'ic09',
  1024: 'ic10',
}

const icnsFile: Builder = ({ width, height, payload }) => {
  const target = Math.max(width, height)
  const size = Object.keys(ICNS_ICON_TYPES)
    .map(Number)
    .reduce((best, candidate) =>
      Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
    )
  const entry = concat(
    ascii(ICNS_ICON_TYPES[size]),
    u32be(8 + payload),
    filler(payload),
  )
  const data = concat(ascii('icns'), u32be(8 + entry.length), entry)
  return { data, width: size, height: size }
}

// --- JPEG ------------------------------------------------------------------

export const jpegSegment = (
  marker: number,
  ...content: Chunk[]
): Uint8Array => {
  const body = concat(...content)
  return concat([0xff, marker], u16be(body.length + 2), body)
}

// --- JPEG XL ---------------------------------------------------------------

const JXL_DIMENSION_BITS = [9, 13, 18, 30]

const writeJxlDimension = (writer: BitWriter, value: number): void => {
  const stored = value - 1
  const sizeClass = JXL_DIMENSION_BITS.findIndex((bits) => stored < 2 ** bits)
  writer.writeBits(sizeClass, 2)
  writer.writeBits(stored, JXL_DIMENSION_BITS[sizeClass])
}

/** Codestream header: `ff0a`, then the bit-packed image dimensions */
export const jxlCodestream = (width: number, height: number): Uint8Array => {
  const writer = new BitWriter()
  const isSmallSquare =
    width === height && width <= 256 && width > 0 && width % 8 === 0
  if (isSmallSquare) {
    writer.writeBits(1, 1)
    writer.writeBits(height / 8 - 1, 5)
    writer.writeBits(0, 3)
    writer.writeBits(width / 8 - 1, 5)
  } else {
    writer.writeBits(0, 1)
    writeJxlDimension(writer, height)
    writer.writeBits(0, 3)
    writeJxlDimension(writer, width)
  }
  return concat([0xff, 0x0a], writer.toUint8Array())
}

/** Signature box + ftyp box shared by every JPEG XL container */
export const jxlContainerHeader = (): Uint8Array =>
  concat(
    u32be(12),
    ascii('JXL '),
    [0x0d, 0x0a, 0x87, 0x0a],
    box('ftyp', ascii('jxl '), u32be(0), ascii('jxl ')),
  )

// --- KTX -------------------------------------------------------------------

const ktxIdentifier = (version: '11' | '20'): Uint8Array =>
  concat([0xab], ascii(`KTX ${version}`), [0xbb, 0x0d, 0x0a, 0x1a, 0x0a])

const ktx1File: Builder = ({ width, height, payload }) => {
  const data = concat(
    ktxIdentifier('11'),
    u32le(0x04030201),
    u32le(0x1401),
    u32le(1),
    u32le(0x1908),
    u32le(0x8058),
    u32le(0x1908),
    u32le(width),
    u32le(height),
    u32le(0),
    u32le(0),
    u32le(1),
    u32le(1),
    u32le(0),
    filler(payload),
  )
  return { data, width, height }
}

const ktx2File: Builder = ({ width, height, payload }) => {
  const data = concat(
    ktxIdentifier('20'),
    u32le(37),
    u32le(1),
    u32le(width),
    u32le(height),
    u32le(0),
    u32le(0),
    u32le(1),
    filler(payload),
  )
  return { data, width, height }
}

// --- PNG -------------------------------------------------------------------

const pngChunk = (name: string, ...content: Chunk[]): Uint8Array =>
  concat(u32be(concat(...content).length), ascii(name), ...content, u32be(0))

// --- PNM -------------------------------------------------------------------

const pnmFile =
  (signature: string, binary: boolean): Builder =>
  ({ width, height, payload }) => {
    const header = ascii(`${signature}\n${width} ${height}\n255\n`)
    const body = binary ? filler(payload) : asciiFiller(payload)
    return { data: concat(header, body), width, height }
  }

const pamFile: Builder = ({ width, height, payload }) => {
  const header = ascii(
    [
      'P7',
      '# CREATED BY THE image-size BENCHMARK FIXTURE GENERATOR',
      `WIDTH ${width}`,
      `HEIGHT ${height}`,
      'DEPTH 3',
      'MAXVAL 255',
      'TUPLTYPE RGB',
      'ENDHDR',
      '',
    ].join('\n'),
  )
  return { data: concat(header, filler(payload)), width, height }
}

// --- TIFF ------------------------------------------------------------------

const tiffFile =
  (isBigEndian: boolean, isBigTiff: boolean): Builder =>
  ({ width, height, payload }) => {
    const short = isBigEndian ? u16be : u16le
    const long = isBigEndian ? u32be : u32le
    const long8 = isBigEndian ? u64be : u64le

    // BigTIFF stores the value inline as 8 bytes, so tags use the LONG8 type
    const tag = (code: number, value: number) =>
      isBigTiff
        ? concat(short(code), short(16), long8(1), long8(value))
        : concat(short(code), short(4), long(1), long(value))

    const entries = concat(tag(256, width), tag(257, height), tag(259, 1))
    const header = isBigTiff
      ? concat(
          ascii(isBigEndian ? 'MM' : 'II'),
          short(43),
          short(8),
          short(0),
          long8(16),
        )
      : concat(ascii(isBigEndian ? 'MM' : 'II'), short(42), long(8))
    const entryCount = isBigTiff ? long8(3) : short(3)
    // Enough zeroes for the parser to read a full "tag 0" terminator
    const terminator = new Uint8Array(isBigTiff ? 20 : 16)

    const data = concat(
      header,
      entryCount,
      entries,
      terminator,
      filler(payload),
    )
    return { data, width, height }
  }

// --- WebP ------------------------------------------------------------------

const riff = (fourCC: string, ...content: Chunk[]): Uint8Array => {
  const chunk = concat(...content)
  const body = concat(ascii('WEBP'), ascii(fourCC), u32le(chunk.length), chunk)
  return concat(ascii('RIFF'), u32le(body.length), body)
}

const webpLossy: Builder = ({ width, height, payload }) => {
  const data = riff(
    'VP8 ',
    [0x30, 0x00, 0x00],
    [0x9d, 0x01, 0x2a],
    u16le(width),
    u16le(height),
    filler(payload),
  )
  return { data, width, height }
}

const webpLossless: Builder = ({ width, height, payload }) => {
  const storedWidth = width - 1
  const storedHeight = height - 1
  const data = riff(
    'VP8L',
    [
      0x2f,
      storedWidth & 0xff,
      ((storedWidth >>> 8) & 0x3f) | ((storedHeight & 0x03) << 6),
      (storedHeight >>> 2) & 0xff,
      (storedHeight >>> 10) & 0x0f,
      // Keeps the bytes at offset 3..6 from ever spelling the lossy start code
      0x00,
    ],
    filler(payload),
  )
  return { data, width, height }
}

const webpExtended: Builder = ({ width, height, payload }) => {
  const data = riff(
    'VP8X',
    [0x10, 0x00, 0x00, 0x00],
    u24le(width - 1),
    u24le(height - 1),
    filler(payload),
  )
  return { data, width, height }
}

// --- Registry --------------------------------------------------------------

interface FixtureSpec {
  detected: imageType
  reported?: string
  extension: string
  build: Builder
}

export const fixtureSpecs = {
  bmp: {
    detected: 'bmp',
    extension: 'bmp',
    build: ({ width, height, payload }) => ({
      data: concat(
        ascii('BM'),
        u32le(54 + payload),
        u32le(0),
        u32le(54),
        u32le(40),
        u32le(width),
        u32le(height),
        u16le(1),
        u16le(24),
        u32le(0),
        u32le(payload),
        u32le(2835),
        u32le(2835),
        u32le(0),
        u32le(0),
        filler(payload),
      ),
      width,
      height,
    }),
  },
  cur: { detected: 'cur', extension: 'cur', build: iconFile(2) },
  dds: {
    detected: 'dds',
    extension: 'dds',
    build: ({ width, height, payload }) => {
      const header = new Uint8Array(128)
      header.set(ascii('DDS '), 0)
      header.set(u32le(124), 4)
      header.set(u32le(0x000a1007), 8)
      header.set(u32le(height), 12)
      header.set(u32le(width), 16)
      header.set(u32le(width * 4), 20)
      header.set(u32le(1), 28)
      return { data: concat(header, filler(payload)), width, height }
    },
  },
  gif: {
    detected: 'gif',
    extension: 'gif',
    build: ({ width, height, payload }) => ({
      data: concat(
        ascii('GIF89a'),
        u16le(width),
        u16le(height),
        [0xf7, 0x00, 0x00],
        filler(payload),
      ),
      width,
      height,
    }),
  },
  avif: {
    detected: 'heif',
    reported: 'avif',
    extension: 'avif',
    build: heifFile('avif'),
  },
  heic: {
    detected: 'heif',
    reported: 'heic',
    extension: 'heic',
    build: heifFile('heic'),
  },
  heif: {
    detected: 'heif',
    reported: 'mif1',
    extension: 'heif',
    build: heifFile('mif1'),
  },
  icns: { detected: 'icns', extension: 'icns', build: icnsFile },
  ico: { detected: 'ico', extension: 'ico', build: iconFile(1) },
  j2c: {
    detected: 'j2c',
    extension: 'j2c',
    build: ({ width, height, payload }) => ({
      data: concat(
        [0xff, 0x4f, 0xff, 0x51],
        u16be(47),
        u16be(0),
        u32be(width),
        u32be(height),
        u32be(0),
        u32be(0),
        u32be(width),
        u32be(height),
        u32be(0),
        u32be(0),
        u16be(1),
        [7, 1, 1],
        filler(payload),
      ),
      width,
      height,
    }),
  },
  jp2: {
    detected: 'jp2',
    extension: 'jp2',
    build: ({ width, height, payload }) => ({
      data: concat(
        u32be(12),
        ascii('jP  '),
        [0x0d, 0x0a, 0x87, 0x0a],
        box('ftyp', ascii('jp2 '), u32be(0), ascii('jp2 ')),
        box(
          'jp2h',
          box('ihdr', u32be(height), u32be(width), u16be(3), [7, 7, 0, 0]),
        ),
        box('jp2c', filler(payload)),
      ),
      width,
      height,
    }),
  },
  jpg: {
    detected: 'jpg',
    extension: 'jpg',
    build: ({ width, height, payload }) => ({
      data: concat(
        [0xff, 0xd8],
        jpegSegment(
          0xe0,
          ascii('JFIF\0'),
          [1, 1, 0],
          u16be(1),
          u16be(1),
          [0, 0],
        ),
        jpegSegment(
          0xc0,
          [8],
          u16be(height),
          u16be(width),
          [3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1],
        ),
        jpegSegment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
        filler(payload),
        [0xff, 0xd9],
      ),
      width,
      height,
    }),
  },
  jxl: {
    detected: 'jxl',
    extension: 'jxl',
    build: ({ width, height, payload }) => ({
      data: concat(
        jxlContainerHeader(),
        box('jxlc', jxlCodestream(width, height)),
        box('mdat', filler(payload)),
      ),
      width,
      height,
    }),
  },
  'jxl-stream': {
    detected: 'jxl-stream',
    extension: 'jxl',
    build: ({ width, height, payload }) => ({
      data: concat(jxlCodestream(width, height), filler(payload)),
      width,
      height,
    }),
  },
  ktx: { detected: 'ktx', extension: 'ktx', build: ktx1File },
  ktx2: {
    detected: 'ktx',
    reported: 'ktx2',
    extension: 'ktx2',
    build: ktx2File,
  },
  png: {
    detected: 'png',
    extension: 'png',
    build: ({ width, height, payload }) => ({
      data: concat(
        [0x89],
        ascii('PNG\r\n\x1a\n'),
        pngChunk('IHDR', u32be(width), u32be(height), [8, 6, 0, 0, 0]),
        pngChunk('IDAT', filler(payload)),
        pngChunk('IEND'),
      ),
      width,
      height,
    }),
  },
  pnm: {
    detected: 'pnm',
    extension: 'ppm',
    build: pnmFile('P6', true),
  },
  'pnm-ascii': {
    detected: 'pnm',
    extension: 'ppm',
    build: pnmFile('P3', false),
  },
  'pnm-pam': { detected: 'pnm', extension: 'pam', build: pamFile },
  psd: {
    detected: 'psd',
    extension: 'psd',
    build: ({ width, height, payload }) => ({
      data: concat(
        ascii('8BPS'),
        u16be(1),
        new Uint8Array(6),
        u16be(3),
        u32be(height),
        u32be(width),
        u16be(8),
        u16be(3),
        u32be(0),
        u32be(0),
        u32be(0),
        filler(payload),
      ),
      width,
      height,
    }),
  },
  svg: {
    detected: 'svg',
    extension: 'svg',
    build: ({ width, height, payload }) => ({
      data: ascii(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><!--${'.'.repeat(payload)}--></svg>`,
      ),
      width,
      height,
    }),
  },
  tga: {
    detected: 'tga',
    extension: 'tga',
    build: ({ width, height, payload }) => ({
      data: concat(
        [0, 0, 2, 0, 0, 0, 0, 0],
        u16le(0),
        u16le(0),
        u16le(width),
        u16le(height),
        [32, 8],
        filler(payload),
      ),
      width,
      height,
    }),
  },
  tiff: {
    detected: 'tiff',
    extension: 'tiff',
    build: tiffFile(false, false),
  },
  'tiff-big-endian': {
    detected: 'tiff',
    extension: 'tiff',
    build: tiffFile(true, false),
  },
  bigtiff: {
    detected: 'tiff',
    reported: 'bigtiff',
    extension: 'tif',
    build: tiffFile(false, true),
  },
  'bigtiff-big-endian': {
    detected: 'tiff',
    reported: 'bigtiff',
    extension: 'tif',
    build: tiffFile(true, true),
  },
  'webp-lossy': { detected: 'webp', extension: 'webp', build: webpLossy },
  'webp-lossless': { detected: 'webp', extension: 'webp', build: webpLossless },
  'webp-extended': { detected: 'webp', extension: 'webp', build: webpExtended },
} satisfies Record<string, FixtureSpec>

export type FixtureName = keyof typeof fixtureSpecs

export const fixtureNames = Object.keys(fixtureSpecs) as FixtureName[]

export const buildFixture = (
  name: FixtureName,
  options: FixtureOptions,
): Fixture => {
  const spec: FixtureSpec = fixtureSpecs[name]
  const { data, width, height } = spec.build(options)
  return {
    name,
    detected: spec.detected,
    reported: spec.reported ?? spec.detected,
    data,
    width,
    height,
  }
}

export const fixtureExtension = (name: FixtureName): string =>
  fixtureSpecs[name].extension
