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
import { elapsed, imageSizeIsolated } from './helpers/isolate'

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
    // a time. 512KB is exactly what imageSizeFromFile hands to the parsers.
    const input = new Uint8Array(512 * 1024)
    input.set([0xff, 0xd8], 0)

    let thrown: unknown
    const ms = elapsed(() => {
      try {
        imageSize(input)
      } catch (err) {
        thrown = err
      }
    })

    assert.ok(ms < 100, `scanning 512KB took ${ms.toFixed(0)}ms`)
    assert.ok(thrown instanceof TypeError, `threw ${thrown}`)
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

describe('TIFF tag scanning', () => {
  it('scans a hostile file in linear time', () => {
    // A valid header followed by bytes that never terminate the tag list
    const input = new Uint8Array(512 * 1024).fill(0xab)
    input.set(concat(ascii('II'), u16le(42), u32le(8)), 0)

    let thrown: unknown
    const ms = elapsed(() => {
      try {
        imageSize(input)
      } catch (err) {
        thrown = err
      }
    })

    assert.ok(ms < 100, `scanning 512KB took ${ms.toFixed(0)}ms`)
    assert.ok(thrown instanceof TypeError, `threw ${thrown}`)
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
