import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { imageSize } from '../lib'
import {
  ascii,
  box,
  buildFixture,
  concat,
  filler,
  u32be,
  u64be,
} from './fixtures'
import { imageSizeIsolated } from './helpers/isolate'

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
