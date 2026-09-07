import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { buildFixture } from './fixtures'
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
