import * as assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { detector } from '../lib/detector'
import { imageSizeFromFile } from '../lib/fromFile'
import { imageSize } from '../lib/lookup'
import { buildFixture, fixtureExtension, fixtureNames } from './fixtures'

// The synthetic fixtures are the backbone of both the edge-case specs and the
// benchmark, so every one of them is round-tripped through the public API.
describe('Synthetic fixtures', () => {
  let directory: string

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'image-size-fixtures-'))
  })

  after(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  for (const name of fixtureNames) {
    describe(name, () => {
      for (const payload of [0, 4096]) {
        it(`is detected and measured with a ${payload} byte payload`, async () => {
          const fixture = buildFixture(name, {
            width: 123,
            height: 456,
            payload,
          })

          assert.equal(detector(fixture.data), fixture.detected)

          const dimensions = imageSize(fixture.data)
          assert.equal(dimensions.width, fixture.width)
          assert.equal(dimensions.height, fixture.height)
          assert.equal(dimensions.type, fixture.reported)

          const path = join(
            directory,
            `${name}-${payload}.${fixtureExtension(name)}`,
          )
          await writeFile(path, fixture.data)
          const fromDisk = await imageSizeFromFile(path)
          assert.deepEqual(fromDisk, dimensions)
        })
      }
    })
  }
})
