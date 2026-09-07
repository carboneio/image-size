import * as assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { imageSizeFromFile, setConcurrency } from '../lib/fromFile'
import { buildFixture } from './fixtures'

const DEFAULT_CONCURRENCY = 100

describe('imageSizeFromFile', () => {
  let directory: string

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'image-size-from-file-'))
  })

  after(async () => {
    setConcurrency(DEFAULT_CONCURRENCY)
    await rm(directory, { recursive: true, force: true })
  })

  it('rejects an empty file', async () => {
    const path = join(directory, 'empty.png')
    await writeFile(path, '')
    await assert.rejects(() => imageSizeFromFile(path), {
      message: 'Empty file',
    })
  })

  it('drains jobs queued while the concurrency budget is exhausted', async () => {
    const { data, width, height } = buildFixture('png', {
      width: 320,
      height: 240,
      payload: 128,
    })
    const path = join(directory, 'queued.png')
    await writeFile(path, data)

    // No job can start until the budget is raised again, which forces the
    // queue to be picked up by the retry timer rather than by the caller.
    setConcurrency(0)
    const pending = imageSizeFromFile(path)
    setConcurrency(DEFAULT_CONCURRENCY)

    const dimensions = await pending
    assert.equal(dimensions.width, width)
    assert.equal(dimensions.height, height)
  })

  it('resolves every file when more are requested than the budget allows', async () => {
    const paths = await Promise.all(
      [16, 32, 48, 64, 80].map(async (size) => {
        const { data } = buildFixture('png', {
          width: size,
          height: size,
          payload: 64,
        })
        const path = join(directory, `batch-${size}.png`)
        await writeFile(path, data)
        return { path, size }
      }),
    )

    setConcurrency(2)
    const results = await Promise.all(
      paths.map(({ path }) => imageSizeFromFile(path)),
    )
    setConcurrency(DEFAULT_CONCURRENCY)

    assert.deepEqual(
      results.map((result) => result.width),
      paths.map(({ size }) => size),
    )
  })
})
