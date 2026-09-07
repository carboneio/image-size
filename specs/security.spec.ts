import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { imageSize } from '../lib'
import {
  ascii,
  box,
  buildFixture,
  concat,
  filler,
  u16le,
  u32be,
  u32le,
  u64be,
} from './fixtures'
import { cpuMillis, elapsed, imageSizeIsolated } from './helpers/isolate'

/**
 * Proofs that hostile inputs cannot hang, crash or leak through the public API.
 *
 * Every case here goes through `imageSize` only, never through an individual
 * parser, so that a passing test really means a caller of the library is safe.
 */

/**
 * Asserts out of process that a hostile payload is rejected.
 *
 * Both halves have to be checked from the same isolated run: asserting the
 * TypeError in-process would hang the runner for as long as the bug is there,
 * which is precisely what these payloads exploit.
 */
const expectIsolatedRejection = (payload: Uint8Array) => {
  const { killed, outcome } = imageSizeIsolated(payload)
  assert.equal(killed, false, 'imageSize never returned, the input hangs it')
  if (!outcome || !('threw' in outcome)) {
    assert.fail(`expected a rejection, got ${JSON.stringify(outcome)}`)
  }
  assert.equal(outcome.threw.name, 'TypeError')
}

/**
 * Big enough that the smaller of the two scans below still takes long enough
 * to measure, since `process.cpuUsage` can be tick-based. A quarter of it is
 * the 512KB that `imageSizeFromFile` hands to the parsers.
 */
const SCAN_BYTES = 2 * 1024 * 1024

/**
 * Asserts that a scan costs no more than a multiple of what a quarter of the
 * same input costs.
 *
 * These tests used to assert a wall-clock budget, which measures the machine
 * as much as the code: the 512KB that JPEG scans in 17ms here took 108ms on a
 * loaded CI runner. Comparing two sizes cancels the machine out.
 *
 * On a 4x input, linear work lands on 4, and stayed under 5.4 with twice as
 * many busy processes as cores, while the quadratic scans this guards against
 * measure 13.
 */
const expectLinearScan = (build: (bytes: number) => Uint8Array) => {
  // The best of a few runs, to compare work rather than scheduler luck
  const measure = (input: Uint8Array) =>
    Math.min(
      ...Array.from({ length: 3 }, () => cpuMillis(() => imageSize(input))),
    )

  const quarter = measure(build(SCAN_BYTES / 4))
  const whole = measure(build(SCAN_BYTES))
  const ratio = (whole + 0.001) / (quarter + 0.001)

  assert.ok(ratio < 8, `a 4x larger input cost ${ratio.toFixed(1)}x as much`)
}

describe('the isolated harness itself', () => {
  it('reports a well-formed image as terminating on its own', () => {
    const png = buildFixture('png', { width: 8, height: 8, payload: 0 })
    const result = imageSizeIsolated(png.data)
    assert.equal(result.killed, false)
    assert.deepEqual(result.outcome, {
      returned: { width: 8, height: 8, type: 'png' },
    })
  })
})

describe('reads stay inside the input view', () => {
  it('does not leak bytes of the surrounding ArrayBuffer', () => {
    // Node allocates small Buffers out of a shared 8KB pool, so the bytes
    // sitting next to a view routinely belong to somebody else's data.
    const pool = new Uint8Array(4096).fill(0x41)
    pool.set(ascii('8BPS'), 0)
    // The caller only hands over the 8 bytes of the signature
    const input = new Uint8Array(pool.buffer, 0, 8)

    assert.throws(() => imageSize(input), TypeError)
  })

  it('rejects a truncated input with a TypeError, not a RangeError', () => {
    for (const signature of [[0x00], [0x38], [0x42], [0x44, 0x44]]) {
      assert.throws(() => imageSize(Uint8Array.from(signature)), TypeError)
    }
  })
})

describe('CVE-2025-71330, ICNS entry of length zero', () => {
  // https://github.com/advisories/GHSA-w3rx-r6r6-pgpr
  const icns = concat(
    ascii('icns'),
    u32be(64),
    ascii('ICON'),
    u32be(0),
    new Uint8Array(48),
  )

  it('rejects an entry that never advances instead of spinning', () => {
    expectIsolatedRejection(icns)
  })

  it('skips icon types it does not know rather than sizing them undefined', () => {
    const entry = (type: string) => concat(ascii(type), u32be(16), filler(8))
    const input = concat(
      ascii('icns'),
      u32be(8 + 16 + 16),
      entry('zzzz'),
      entry('ic09'),
    )
    assert.deepEqual(imageSize(input), {
      width: 512,
      height: 512,
      type: 'icns',
    })
  })
})

describe('CVE-2025-71329, HEIF property box of size zero', () => {
  // https://github.com/advisories/GHSA-5p2g-fcmc-qvqq
  const heifWith = (...properties: Uint8Array[]) =>
    concat(
      box('ftyp', ascii('heic'), u32be(0)),
      box('meta', u32be(0), box('iprp', box('ipco', ...properties))),
    )

  it('does not spin on an ispe box whose size field is zero', () => {
    const zeroSized = concat(
      u32be(0),
      ascii('ispe'),
      u32be(0),
      u32be(100),
      u32be(100),
    )
    const { killed, outcome } = imageSizeIsolated(heifWith(zeroSized))
    assert.equal(killed, false, 'imageSize never returned, the input hangs it')
    // A size of zero means "up to the end of the file", so the property is
    // still a well-formed one and describes a 100x100 image
    assert.deepEqual(outcome, {
      returned: { width: 100, height: 100, type: 'heic' },
    })
  })

  it('walks a long property list in linear time', () => {
    const ispe = box('ispe', u32be(0), u32be(64), u32be(64))
    const input = heifWith(...Array.from({ length: 4000 }, () => ispe))

    // Every property has to parse, or the walk would be timed doing nothing
    const { width, height } = imageSize(input)
    assert.deepEqual({ width, height }, { width: 64, height: 64 })

    // This walk costs under a millisecond, so unlike the byte scans below it
    // is too short to compare against a smaller one: the budget is what fits.
    // A quadratic walk of 4000 properties is nowhere near it.
    const ms = elapsed(() => imageSize(input))
    assert.ok(ms < 250, `parsing 4000 properties took ${ms.toFixed(0)}ms`)
  })

  it('ignores properties too short to hold the values they should', () => {
    const input = heifWith(
      box('pixi'),
      box('ispe', u32be(0), u32be(400), u32be(300)),
    )
    assert.deepEqual(imageSize(input), {
      width: 400,
      height: 300,
      type: 'heic',
    })
  })

  it('ignores a clean aperture that refines no image property', () => {
    const input = heifWith(
      box('clap', u32be(0), u32be(40), u32be(0), u32be(0)),
      box('ispe', u32be(0), u32be(400), u32be(300)),
    )
    assert.deepEqual(imageSize(input), {
      width: 400,
      height: 300,
      type: 'heic',
    })
  })

  it('keeps the properties that survived a crop', () => {
    // Every enclosing box is left open-ended, as a cropped file leaves them,
    // and the file stops on a fragment too short to be a property
    const openEnded = (name: string, ...content: Uint8Array[]) =>
      concat(u32be(0), ascii(name), ...content)
    const input = concat(
      box('ftyp', ascii('heic'), u32be(0)),
      openEnded(
        'meta',
        u32be(0),
        openEnded(
          'iprp',
          openEnded(
            'ipco',
            box('ispe', u32be(0), u32be(400), u32be(300)),
            ascii('isp'),
          ),
        ),
      ),
    )
    assert.deepEqual(imageSize(input), {
      width: 400,
      height: 300,
      type: 'heic',
    })
  })
})

describe('CVE-2025-71329, JXL container box of size zero', () => {
  // https://github.com/advisories/GHSA-5p2g-fcmc-qvqq
  const header = concat(
    u32be(12),
    ascii('JXL '),
    [0x0d, 0x0a, 0x87, 0x0a],
    box('ftyp', ascii('jxl '), u32be(0), ascii('jxl ')),
  )

  it('does not spin on a jxlp box whose size field is zero', () => {
    const zeroSized = concat(u32be(0), ascii('jxlp'), new Uint8Array(32))
    const { killed } = imageSizeIsolated(concat(header, zeroSized))
    assert.equal(killed, false, 'imageSize never returned, the input hangs it')
  })

  it('rejects an empty codestream with a TypeError', () => {
    assert.throws(() => imageSize(concat(header, box('jxlc'))), {
      name: 'TypeError',
      message: 'No codestream found in JXL container',
    })
  })

  it('rejects partial codestreams that carry no bytes', () => {
    const emptyPartial = concat(u32be(8), ascii('jxlp'))
    assert.throws(() => imageSize(concat(header, emptyPartial)), {
      name: 'TypeError',
      message: 'No codestream found in JXL container',
    })
  })

  it('finds the brand of a ftyp box with a 64-bit header', () => {
    // A codestream declaring a small 8x8 image, enough to read a size from
    const codestream = [0xff, 0x0a, 0x30, 0x54, 0x10, 0x08, 0x08, 0x00]
    const largeFtyp = concat(
      u32be(1),
      ascii('ftyp'),
      u64be(16 + 8),
      ascii('jxl '),
      u32be(0),
    )
    const input = concat(
      u32be(12),
      ascii('JXL '),
      [0x0d, 0x0a, 0x87, 0x0a],
      largeFtyp,
      box('jxlc', codestream),
    )
    assert.equal(imageSize(input).type, 'jxl')
  })

  it('rejects a codestream that ends mid-header with a TypeError', () => {
    const input = concat(header, box('jxlc', [0xff, 0x0a]))
    assert.throws(() => imageSize(input), {
      name: 'TypeError',
      message: 'Reached end of input',
    })
  })
})

describe('JPEG segment scanning', () => {
  it('scans a hostile file in linear time', () => {
    // Bytes that never spell a marker force the parser to realign one byte at
    // a time
    const build = (bytes: number) => {
      const input = new Uint8Array(bytes)
      input.set([0xff, 0xd8], 0)
      return input
    }

    assert.throws(() => imageSize(build(SCAN_BYTES)), { name: 'TypeError' })
    expectLinearScan(build)
  })

  it('reads a file that opens straight on its frame header', () => {
    // FF D8 FF C0: a baseline frame with no segment in front of it
    const input = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xc8, 0x00, 0x7b, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
    ])
    assert.deepEqual(imageSize(input), {
      width: 123,
      height: 456,
      type: 'jpg',
    })
  })
})

describe('WebP stream signatures', () => {
  // The chunk payload starts at offset 20, which is what the parser reads
  const webp = (fourCC: string, ...payload: number[]) =>
    concat(
      ascii('RIFF'),
      u32le(0),
      ascii('WEBP'),
      ascii(fourCC),
      u32le(payload.length),
      payload,
      new Uint8Array(10),
    )

  it('does not size a lossy stream that carries no start code', () => {
    // A VP8 frame must be followed by the 9d 01 2a start code. Without it,
    // the bytes where the dimensions should be mean nothing, and reading them
    // anyway fabricated a 320x240 that no amount of output validation catches.
    const input = webp('VP8 ', 0, 0, 0, 0xaa, 0xbb, 0xcc, 0x40, 0x01, 0xf0, 0)
    assert.throws(() => imageSize(input), {
      name: 'TypeError',
      message: 'Invalid WebP',
    })
  })

  it('does not size a lossless stream that carries no signature byte', () => {
    // A VP8L stream opens with 0x2f. Without it, the packed dimension bits
    // are not dimension bits, and reading them fabricated a 321x177.
    const input = webp('VP8L', 0x99, 0x40, 0x01, 0x2c, 0x50, 0)
    assert.throws(() => imageSize(input), {
      name: 'TypeError',
      message: 'Invalid WebP',
    })
  })
})

describe('PNM header scanning', () => {
  it('scans a hostile header in linear time', () => {
    // A signature followed by nothing but comment lines. The dimension line
    // never comes, so every line of the file has to be looked at.
    const build = (bytes: number) => ascii(`P6\n${'#c\n'.repeat(bytes / 3)}`)

    assert.throws(() => imageSize(build(SCAN_BYTES)), { name: 'TypeError' })
    expectLinearScan(build)
  })

  it('reads the header without walking the pixels behind it', () => {
    // The dimensions sit in the first two lines; the megabytes of pixel data
    // after them must not be paid for.
    const header = ascii('P6\n800 600\n255\n')
    const small = concat(header, new Uint8Array(64 * 1024))
    const large = concat(header, new Uint8Array(4 * 1024 * 1024))
    const expected = { width: 800, height: 600, type: 'pnm' }

    assert.deepEqual(imageSize(small), expected)
    assert.deepEqual(imageSize(large), expected)

    // Warm both paths before timing, so this compares work and not JIT state
    const measure = (input: Uint8Array) =>
      Math.min(
        ...Array.from({ length: 5 }, () => elapsed(() => imageSize(input))),
      )
    const ratio = (measure(large) + 0.001) / (measure(small) + 0.001)
    assert.ok(ratio < 8, `a 64x larger file cost ${ratio.toFixed(1)}x as much`)
  })
})

describe('TIFF tag scanning', () => {
  it('scans a hostile file in linear time', () => {
    // A valid header followed by bytes that never terminate the tag list
    const build = (bytes: number) => {
      const input = new Uint8Array(bytes).fill(0xab)
      input.set(concat(ascii('II'), u16le(42), u32le(8)), 0)
      return input
    }

    assert.throws(() => imageSize(build(SCAN_BYTES)), { name: 'TypeError' })
    expectLinearScan(build)
  })
})

describe('dimensions handed back to the caller', () => {
  const cases: [string, Uint8Array][] = [
    ['a PNM header whose dimensions are not numbers', ascii('P1\nabc def\n')],
    ['a PNM header with negative dimensions', ascii('P1\n-5 -5\n')],
    [
      'a BMP declaring no surface at all',
      concat(ascii('BM'), new Uint8Array(52)),
    ],
    [
      'a GIF declaring no surface at all',
      concat(ascii('GIF89a'), new Uint8Array(7)),
    ],
  ]

  for (const [description, input] of cases) {
    it(`rejects ${description}`, () => {
      assert.throws(() => imageSize(input), TypeError)
    })
  }
})

describe('format detection', () => {
  it('does not let one parser abort the sweep for the others', () => {
    // Two bytes: the JXL codestream signature and nothing else. Detection
    // walks every format, and the ones that cannot read that far must simply
    // answer no, rather than reporting their own truncation as the verdict.
    assert.throws(() => imageSize(Uint8Array.from([0xff, 0x0a])), {
      name: 'TypeError',
      message: 'Reached end of input',
    })
  })
})

describe('ICO entry count', () => {
  const entry = (width: number, height: number) =>
    concat([width, height, 0, 0], u16le(1), u16le(32), u32le(0), u32le(22))

  it('does not invent the entries a file only claims to hold', () => {
    // Announces 65535 icons, carries two
    const input = concat(
      u16le(0),
      u16le(1),
      u16le(65535),
      entry(16, 16),
      entry(32, 32),
    )
    assert.deepEqual(imageSize(input).images, [
      { width: 16, height: 16 },
      { width: 32, height: 32 },
    ])
  })

  it('rejects a header with no entry behind it', () => {
    assert.throws(() => imageSize(concat(u16le(0), u16le(1), u16le(3))), {
      name: 'TypeError',
      message: 'Invalid ICO, no entries found',
    })
  })
})

describe('ISO base media box geometry', () => {
  const ftyp = box('ftyp', ascii('heic'), u32be(0))
  // The `meta` payload: a full-box version/flags word, then the property tree
  const metaBody = concat(
    u32be(0),
    box('iprp', box('ipco', box('ispe', u32be(0), u32be(400), u32be(300)))),
  )
  const heic = { width: 400, height: 300, type: 'heic' }

  it('reads a file cropped inside a box that declares more than it holds', () => {
    // A HEIF cropped after its property tree: `meta` still announces the bytes
    // that were cut away. The boxes that did survive have to remain readable.
    const meta = concat(
      u32be(metaBody.length + 8 + 1000),
      ascii('meta'),
      metaBody,
    )
    assert.deepEqual(imageSize(concat(ftyp, meta)), heic)
  })

  it('reads a box that carries its size as a 64-bit largesize', () => {
    const meta = concat(
      u32be(1),
      ascii('meta'),
      u64be(metaBody.length + 16),
      metaBody,
    )
    assert.deepEqual(imageSize(concat(ftyp, meta)), heic)
  })

  it('reads a last box whose size of zero means "up to the end of file"', () => {
    const meta = concat(u32be(0), ascii('meta'), metaBody)
    assert.deepEqual(imageSize(concat(ftyp, meta)), heic)
  })

  it('rejects a box smaller than its own header', () => {
    const runt = concat(u32be(4), ascii('meta'), metaBody)
    assert.throws(() => imageSize(concat(ftyp, runt)), TypeError)

    // The same rule applies to the very first box, which then fails detection
    const runtFtyp = concat(u32be(4), ascii('ftyp'), ascii('heic'))
    assert.throws(() => imageSize(runtFtyp), {
      message: 'unsupported file type: undefined',
    })
  })

  it('rejects a largesize box whose 64-bit size is missing', () => {
    const truncated = concat(u32be(1), ascii('meta'), u32be(0))
    assert.throws(() => imageSize(concat(ftyp, truncated)), TypeError)
  })

  it('rejects a trailing fragment too short to hold a box header', () => {
    assert.throws(() => imageSize(concat(ftyp, u32be(0x6d657461))), TypeError)
  })
})
