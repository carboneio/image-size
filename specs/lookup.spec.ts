import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import defaultExport, { imageSize } from '../lib'
import { concat, filler, u16le, u32le } from './fixtures'

/** ICO file whose first entry is deliberately not the biggest one */
const multiSizeIcon = (sizes: number[]) => {
  const entries = sizes.map((size, index) =>
    concat(
      [size & 0xff, size & 0xff, 0, 0],
      u16le(1),
      u16le(32),
      u32le(0),
      u32le(6 + 16 * (index + 1)),
    ),
  )
  return concat(u16le(0), u16le(1), u16le(sizes.length), ...entries)
}

describe('imageSize', () => {
  it('is also available as the default export', () => {
    assert.equal(defaultExport, imageSize)
  })

  it('throws when the input matches no known format', () => {
    assert.throws(
      () => imageSize(filler(64)),
      (err: Error) => {
        assert.ok(err instanceof TypeError)
        assert.equal(err.message, 'unsupported file type: undefined')
        return true
      },
    )
  })

  it('reports the largest image of a multi-size file as the top-level size', () => {
    const dimensions = imageSize(multiSizeIcon([16, 64, 32]))
    assert.equal(dimensions.width, 64)
    assert.equal(dimensions.height, 64)
    assert.deepEqual(dimensions.images, [
      { width: 16, height: 16 },
      { width: 64, height: 64 },
      { width: 32, height: 32 },
    ])
  })
})
