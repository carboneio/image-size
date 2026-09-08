import * as assert from 'node:assert'
import * as fs from 'node:fs'
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
      name: 'TypeError',
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

    // No job can start until the budget is raised again, so this one has to
    // be picked up by the call that raises it
    setConcurrency(0)
    const pending = imageSizeFromFile(path)
    setConcurrency(DEFAULT_CONCURRENCY)

    const dimensions = await pending
    assert.equal(dimensions.width, width)
    assert.equal(dimensions.height, height)
  })

  it('never holds more files open at once than the budget allows', async () => {
    const paths = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const { data } = buildFixture('png', {
          width: 8 + index,
          height: 8,
          payload: 64,
        })
        const path = join(directory, `in-flight-${index}.png`)
        await writeFile(path, data)
        return path
      }),
    )

    // Count the handles that are open at the same moment, by watching the
    // window between an open and its matching close
    const open = fs.promises.open
    let inFlight = 0
    let peak = 0
    fs.promises.open = (async (...args: Parameters<typeof open>) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      const handle = await open(...args)
      const close = handle.close.bind(handle)
      handle.close = () => {
        inFlight -= 1
        return close()
      }
      return handle
    }) as typeof open

    setConcurrency(3)
    try {
      await Promise.all(paths.map((path) => imageSizeFromFile(path)))
    } finally {
      fs.promises.open = open
      setConcurrency(DEFAULT_CONCURRENCY)
    }

    assert.ok(peak <= 3, `held ${peak} files open at once, with a budget of 3`)
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
