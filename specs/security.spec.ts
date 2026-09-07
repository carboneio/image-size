import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { imageSize } from '../lib'
import { ascii, buildFixture } from './fixtures'
import { imageSizeIsolated } from './helpers/isolate'

/**
 * Proofs that hostile inputs cannot hang, crash or leak through the public API.
 *
 * Every case here goes through `imageSize` only, never through an individual
 * parser, so that a passing test really means a caller of the library is safe.
 */

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
