import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { imageSize } from '../lib/lookup'
import { HEIF } from '../lib/types/heif'
import { JP2 } from '../lib/types/jp2'
import { JXL } from '../lib/types/jxl'
import { findBox } from '../lib/types/utils'
import {
  ascii,
  box,
  concat,
  filler,
  jpegSegment,
  jxlCodestream,
  jxlContainerHeader,
  u16be,
  u16le,
  u32be,
  u32le,
  u64le,
} from './fixtures'

const expectTypeError = (input: Uint8Array, message: string) =>
  assert.throws(
    () => imageSize(input),
    (err: Error) => {
      assert.ok(err instanceof TypeError)
      assert.equal(err.message, message)
      return true
    },
  )

describe('HEIF', () => {
  const ftyp = box('ftyp', ascii('heic'), u32be(0))

  it('recognises a file cut short after its ftyp box, then gives up', () => {
    const truncated = concat(u32be(0xffff), ascii('ftyp'), ascii('heic'))
    assert.equal(HEIF.validate(truncated), true)
    expectTypeError(truncated, 'Invalid HEIF, no ipco box found')
  })

  it('throws when the property container is missing', () => {
    const input = concat(ftyp, box('meta', u32be(0), box('hdlr', filler(8))))
    expectTypeError(input, 'Invalid HEIF, no ipco box found')
  })

  it('throws when the property container holds no size', () => {
    const input = concat(ftyp, box('meta', u32be(0), box('iprp', box('ipco'))))
    expectTypeError(input, 'Invalid HEIF, no sizes found')
  })

  it('subtracts the clean aperture crop from the stored width', () => {
    const input = concat(
      ftyp,
      box(
        'meta',
        u32be(0),
        box(
          'iprp',
          box(
            'ipco',
            box('ispe', u32be(0), u32be(400), u32be(300)),
            box('clap', u32be(0), u32be(40), u32be(0), u32be(0)),
          ),
        ),
      ),
    )
    assert.deepEqual(imageSize(input), {
      width: 360,
      height: 300,
      type: 'heic',
    })
  })

  it('exposes every image and promotes the largest one', () => {
    const input = concat(
      ftyp,
      box(
        'meta',
        u32be(0),
        box(
          'iprp',
          box(
            'ipco',
            box('ispe', u32be(0), u32be(64), u32be(64)),
            box('ispe', u32be(0), u32be(512), u32be(512)),
          ),
        ),
      ),
    )
    const dimensions = imageSize(input)
    assert.equal(dimensions.width, 512)
    assert.equal(dimensions.height, 512)
    assert.deepEqual(dimensions.images, [
      { width: 64, height: 64 },
      { width: 512, height: 512 },
    ])
  })
})

describe('ICNS', () => {
  it('throws when the file holds no icon entry', () => {
    expectTypeError(
      concat(ascii('icns'), u32be(8)),
      'Invalid ICNS, no sizes found',
    )
  })
})

describe('JPEG 2000', () => {
  const signature = concat(u32be(12), ascii('jP  '), [0x0d, 0x0a, 0x87, 0x0a])
  const ftyp = box('ftyp', ascii('jp2 '), u32be(0), ascii('jp2 '))

  it('rejects a file whose ftyp box runs past the end of the input', () => {
    const truncated = concat(u32be(0xffff), ascii('jP  '), ascii('jp2 '))
    assert.equal(JP2.validate(truncated), false)
  })

  it('throws when the image header box is missing', () => {
    const input = concat(signature, ftyp, box('jp2c', filler(16)))
    expectTypeError(input, 'Unsupported JPEG 2000 format')
  })
})

describe('JPEG', () => {
  const sof0 = (width: number, height: number) =>
    jpegSegment(
      0xc0,
      [8],
      u16be(height),
      u16be(width),
      [3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1],
    )

  const exifEntry = (tag: number, format: number, components: number) =>
    concat(u16le(tag), u16le(format), [components, 0, 0, 0], [8, 0, 0, 0])

  const withExif = (...entries: Uint8Array[]) =>
    concat(
      [0xff, 0xd8],
      jpegSegment(
        0xe1,
        ascii('Exif\0\0'),
        ascii('II'),
        u16le(42),
        [8, 0, 0, 0],
        u16le(entries.length),
        ...entries,
      ),
      sof0(123, 456),
    )

  /** A frame header of any kind: precision, height, width, one component */
  const frame = (marker: number, width: number, height: number) =>
    jpegSegment(marker, [8], u16be(height), u16be(width), [1, 1, 0x11, 0])

  it('reads a lossless frame header', () => {
    // 0xC3 opens a lossless frame. In the C0..CF range only C4 (Huffman
    // tables), C8 (reserved) and CC (arithmetic conditioning) are not frames.
    const input = concat(
      [0xff, 0xd8],
      jpegSegment(0xee, ascii('Adobe')),
      frame(0xc3, 227, 149),
    )
    assert.deepEqual(imageSize(input), { width: 227, height: 149, type: 'jpg' })
  })

  it('reads a file that opens straight on a lossless frame header', () => {
    const input = concat([0xff, 0xd8], frame(0xc3, 227, 149))
    assert.deepEqual(imageSize(input), { width: 227, height: 149, type: 'jpg' })
  })

  it('reads the orientation tag', () => {
    const input = withExif(exifEntry(274, 3, 1))
    assert.deepEqual(imageSize(input), {
      width: 123,
      height: 456,
      orientation: 8,
      type: 'jpg',
    })
  })

  it('ignores an orientation tag stored with the wrong data format', () => {
    const dimensions = imageSize(withExif(exifEntry(274, 4, 1)))
    assert.equal(dimensions.orientation, undefined)
    assert.equal(dimensions.width, 123)
  })

  it('ignores an orientation tag with more than one component', () => {
    const dimensions = imageSize(withExif(exifEntry(274, 3, 2)))
    assert.equal(dimensions.orientation, undefined)
    assert.equal(dimensions.width, 123)
  })

  it('stops reading an EXIF block that claims more entries than it holds', () => {
    // Announces four entries but only carries two, plus a two byte stub
    const input = concat(
      [0xff, 0xd8],
      jpegSegment(
        0xe1,
        ascii('Exif\0\0'),
        ascii('II'),
        u16le(42),
        [8, 0, 0, 0],
        u16le(4),
        exifEntry(256, 3, 1),
        exifEntry(257, 3, 1),
        u16le(0),
      ),
      sof0(123, 456),
    )
    const dimensions = imageSize(input)
    assert.equal(dimensions.orientation, undefined)
    assert.equal(dimensions.width, 123)
  })

  it('throws when a segment length points past the end of the file', () => {
    expectTypeError(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]),
      'Corrupt JPG, exceeded buffer limits',
    )
  })

  it('realigns on the next marker when a segment length is off', () => {
    const input = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0,
      // A segment length of zero, so the parser has to slide forward one byte
      0x00, 0x00,
      // From here on the stream is a well-formed SOF0 segment
      0x02, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xc8, 0x00, 0x7b, 0x00, 0x00,
    ])
    assert.deepEqual(imageSize(input), { width: 123, height: 456, type: 'jpg' })
  })

  it('throws when the stream ends without a frame header', () => {
    expectTypeError(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]),
      'Invalid JPG, no size found',
    )
  })
})

describe('JPEG XL', () => {
  it('rejects a container whose ftyp box runs past the end of the input', () => {
    const truncated = concat(u32be(0xffff), ascii('JXL '), ascii('jxl '))
    assert.equal(JXL.validate(truncated), false)
  })

  it('reassembles a codestream split across jxlp boxes', () => {
    const codestream = jxlCodestream(3000, 2000)
    const input = concat(
      jxlContainerHeader(),
      box('jxlp', u32be(0), codestream.slice(0, 3)),
      box('jxlp', u32be(1), codestream.slice(3)),
      box('mdat', filler(32)),
    )
    assert.deepEqual(imageSize(input), {
      width: 3000,
      height: 2000,
      type: 'jxl',
    })
  })

  it('throws when the container holds no codestream', () => {
    const input = concat(jxlContainerHeader(), box('mdat', filler(32)))
    assert.throws(() => imageSize(input), {
      message: 'No codestream found in JXL container',
    })
  })

  it('decodes the compact encoding used by small square images', () => {
    const input = concat(jxlCodestream(64, 64), filler(16))
    assert.deepEqual(imageSize(input), {
      width: 64,
      height: 64,
      type: 'jxl-stream',
    })
  })
})

describe('PNM', () => {
  it('throws when no dimension line follows the signature', () => {
    expectTypeError(ascii('P1\n# a comment and nothing else\n'), 'Invalid PNM')
  })

  it('gives up on the first line that is not a pair of dimensions', () => {
    // Rather than keep reading, which on a large file would mean walking all
    // of the pixel data in search of a header that is not there
    expectTypeError(ascii('P6\nnotadimension\n255\n'), 'Invalid PNM')
  })

  it('throws when a PAM header declares neither width nor height', () => {
    expectTypeError(ascii('P7\nDEPTH 3\nENDHDR\n'), 'Invalid PAM')
  })

  it('reads a PAM header across a blank line', () => {
    const input = ascii('P7\nWIDTH 100\n\nHEIGHT 50\nENDHDR\n')
    assert.deepEqual(imageSize(input), {
      width: 100,
      height: 50,
      type: 'pnm',
    })
  })
})

describe('SVG', () => {
  const svg = (attributes: string) => ascii(`<svg ${attributes}></svg>`)

  it('converts absolute units to pixels', () => {
    assert.deepEqual(imageSize(svg('width="2in" height="1in"')), {
      width: 192,
      height: 96,
      type: 'svg',
    })
  })

  it('falls back to the viewBox when the dimensions are not lengths', () => {
    const input = svg('width="auto" height="auto" viewBox="0 0 100 50"')
    assert.deepEqual(imageSize(input), { width: 100, height: 50, type: 'svg' })
  })

  it('derives the missing dimension from the viewBox ratio', () => {
    assert.deepEqual(imageSize(svg('width="200" viewBox="0 0 100 50"')), {
      width: 200,
      height: 100,
      type: 'svg',
    })
    assert.deepEqual(imageSize(svg('height="200" viewBox="0 0 100 50"')), {
      width: 400,
      height: 200,
      type: 'svg',
    })
  })

  it('throws when neither dimensions nor viewBox are usable', () => {
    expectTypeError(svg('width="100%" height="100%"'), 'Invalid SVG')
  })
})

describe('TIFF', () => {
  const bigTiffHeader = (byteSize: number) =>
    concat(ascii('II'), u16le(43), u16le(byteSize), u16le(0), u64le(16))

  /** A little-endian LONG tag holding its value inline */
  const tag = (code: number, value: number) =>
    concat(u16le(code), u16le(4), u32le(1), u32le(value))

  /** count, entries, then the offset of the directory that follows */
  const directory = (entries: Uint8Array[], next: number) =>
    concat(u16le(entries.length), ...entries, u32le(next))

  const ENTRY = 12
  const NEXT_POINTER = 4
  const ENTRY_COUNT = 2

  /**
   * Reading past a directory resumes in twelve byte steps from the end of its
   * entries, swallowing the four byte pointer to the next directory on the
   * way. Both fixtures below pad what follows onto that step: landing on it is
   * what turns the overrun into a wrong answer rather than harmless noise.
   */
  const padding = (consumed: number) => new Uint8Array(ENTRY - consumed)

  const tiffHeader = concat(ascii('II'), u16le(42), u32le(8))

  it('reads the first page of a multi-page file', () => {
    const pages = (width: number, height: number, next: number) =>
      directory([tag(256, width), tag(257, height), tag(259, 1)], next)

    const second = tiffHeader.length + pages(0, 0, 0).length
    const input = concat(
      tiffHeader,
      pages(2464, 3248, second + padding(NEXT_POINTER + ENTRY_COUNT).length),
      padding(NEXT_POINTER + ENTRY_COUNT),
      pages(1232, 1624, 0),
    )

    assert.deepEqual(imageSize(input), {
      width: 2464,
      height: 3248,
      type: 'tiff',
      compression: 1,
    })
  })

  it('stops at the end of the directory instead of reading on', () => {
    // Entries that would describe a much larger image, sitting past the point
    // where the entry count says the directory has ended
    const input = concat(
      tiffHeader,
      directory([tag(256, 400), tag(257, 300)], 0xffff),
      padding(NEXT_POINTER),
      tag(256, 9999),
      tag(257, 9999),
      new Uint8Array(ENTRY),
    )

    assert.deepEqual(imageSize(input), {
      width: 400,
      height: 300,
      type: 'tiff',
    })
  })

  it('throws when the BigTIFF header is malformed', () => {
    const input = concat(bigTiffHeader(4), u64le(0), new Uint8Array(32))
    expectTypeError(input, 'Invalid BigTIFF header')
  })

  it('throws when a BigTIFF tag holds an unrepresentable value', () => {
    const input = concat(
      bigTiffHeader(8),
      u64le(1),
      u16le(256),
      u16le(16),
      u64le(1),
      u64le(0xffffffffffffffffn),
      new Uint8Array(20),
    )
    expectTypeError(input, 'Value too large')
  })
})

describe('WebP', () => {
  const riff = (fourCC: string, ...content: Uint8Array[]) => {
    const chunk = concat(...content)
    const body = concat(
      ascii('WEBP'),
      ascii(fourCC),
      u32be(chunk.length),
      chunk,
    )
    return concat(ascii('RIFF'), u32be(body.length), body)
  }

  it('throws when the extended header has reserved bits set', () => {
    const input = riff('VP8X', Uint8Array.from([0xc0, 0, 0, 0]), filler(6))
    expectTypeError(input, 'Invalid WebP')
  })

  it('throws on an unknown VP8 chunk', () => {
    expectTypeError(riff('VP8?', filler(10)), 'Invalid WebP')
  })

  it('throws when a lossy chunk is missing its start code', () => {
    const input = riff('VP8 ', Uint8Array.from([0x2f]), filler(9))
    expectTypeError(input, 'Invalid WebP')
  })

  it('throws when a lossless chunk is missing its signature byte', () => {
    const input = riff('VP8L', Uint8Array.from([0x00]), filler(9))
    expectTypeError(input, 'Invalid WebP')
  })

  it('reads a lossless chunk whose dimensions spell the lossy start code', () => {
    // 9d 01 2a is only meaningful right after a VP8 frame tag. Here those
    // bytes are packed dimension bits, and a signed VP8L stream is valid.
    const input = riff(
      'VP8L',
      Uint8Array.from([0x2f, 0x00, 0x00, 0x9d, 0x01, 0x2a]),
      filler(4),
    )
    assert.deepEqual(imageSize(input), {
      width: 1,
      height: 1653,
      type: 'webp',
    })
  })
})

describe('findBox', () => {
  it('treats a box sized zero as the last box of the file', () => {
    // ISO base media format: a size of zero means the box runs to the end of
    // the file, so nothing that follows it is a sibling to be scanned
    const input = concat(u32be(0), ascii('zero'), box('test', filler(4)))
    assert.equal(findBox(input, 'test', 0), undefined)
    assert.deepEqual(findBox(input, 'zero', 0), {
      name: 'zero',
      offset: 0,
      headerSize: 8,
      size: input.length,
    })
  })
})
