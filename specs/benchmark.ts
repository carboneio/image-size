import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import { imageSizeFromFile, setConcurrency } from '../lib/fromFile'
import { imageSize } from '../lib/lookup'
import {
  type FixtureName,
  buildFixture,
  fixtureExtension,
  fixtureNames,
} from './fixtures'

/**
 * Detection throughput benchmark.
 *
 * Every supported format is generated twice, as a small file and as a large
 * one, then measured three ways:
 *
 *   decode/s      `imageSize` over an in-memory buffer
 *   file/s        `imageSizeFromFile`, one file at a time
 *   file/s x64    `imageSizeFromFile`, 64 files in flight
 *
 * `imageSizeFromFile` never reads more than 512 kB, so the large-file numbers
 * measure the cost of opening and reading a header out of a big file rather
 * than the cost of walking the whole payload.
 */

const WARMUP_MS = 150
const MEASURE_MS = 400
const BATCH = 32
const PARALLELISM = 64

const SMALL_PAYLOAD = 512
const LARGE_PAYLOAD = 2 * 1024 * 1024

const now = () => process.hrtime.bigint()
const elapsedSeconds = (start: bigint) => Number(now() - start) / 1e9

const throughput = (run: () => void): number => {
  const warmupDeadline = now() + BigInt(WARMUP_MS) * 1_000_000n
  while (now() < warmupDeadline) run()

  const start = now()
  const deadline = start + BigInt(MEASURE_MS) * 1_000_000n
  let operations = 0
  while (now() < deadline) {
    for (let index = 0; index < BATCH; index++) run()
    operations += BATCH
  }
  return operations / elapsedSeconds(start)
}

const asyncThroughput = async (
  run: () => Promise<unknown>,
  inFlight: number,
): Promise<number> => {
  const batch = () => Promise.all(Array.from({ length: inFlight }, run))

  const warmupDeadline = now() + BigInt(WARMUP_MS) * 1_000_000n
  while (now() < warmupDeadline) await batch()

  const start = now()
  const deadline = start + BigInt(MEASURE_MS) * 1_000_000n
  let operations = 0
  while (now() < deadline) {
    await batch()
    operations += inFlight
  }
  return operations / elapsedSeconds(start)
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Row {
  format: string
  bytes: number
  decode: number
  sequential: number
  parallel: number
}

const printTable = (rows: Row[]): void => {
  const headers = [
    'format',
    'size',
    'decode/s',
    'file/s',
    `file/s x${PARALLELISM}`,
  ]
  const body = rows.map((row) => [
    row.format,
    formatBytes(row.bytes),
    integer.format(row.decode),
    integer.format(row.sequential),
    integer.format(row.parallel),
  ])

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...body.map((cells) => cells[column].length)),
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join('  ')

  console.log(`  ${line(headers)}`)
  console.log(`  ${'-'.repeat(widths.reduce((a, b) => a + b + 2, -2))}`)
  for (const cells of body) console.log(`  ${line(cells)}`)
}

const measureFormat = async (
  name: FixtureName,
  payload: number,
  directory: string,
): Promise<Row> => {
  const fixture = buildFixture(name, { width: 1920, height: 1080, payload })

  // A silently broken fixture would report absurd throughput, so verify first
  const dimensions = imageSize(fixture.data)
  if (
    dimensions.width !== fixture.width ||
    dimensions.height !== fixture.height
  ) {
    throw new Error(
      `${name}: expected ${fixture.width}x${fixture.height}, got ${dimensions.width}x${dimensions.height}`,
    )
  }

  const path = join(directory, `${name}.${fixtureExtension(name)}`)
  await writeFile(path, fixture.data)

  const row: Row = {
    format: name,
    bytes: fixture.data.length,
    decode: throughput(() => {
      imageSize(fixture.data)
    }),
    sequential: await asyncThroughput(() => imageSizeFromFile(path), 1),
    parallel: await asyncThroughput(() => imageSizeFromFile(path), PARALLELISM),
  }

  await rm(path, { force: true })
  return row
}

const main = async () => {
  const filter = process.argv
    .find((argument) => argument.startsWith('--filter='))
    ?.slice('--filter='.length)
  const names = filter
    ? fixtureNames.filter((name) => name.includes(filter))
    : fixtureNames

  if (names.length === 0) {
    console.error(`No format matches --filter=${filter}`)
    process.exitCode = 1
    return
  }

  setConcurrency(PARALLELISM)

  console.log('image-size detection throughput')
  console.log(
    `${process.version} - ${platform()} ${arch()} - ${cpus()[0]?.model ?? 'unknown cpu'}`,
  )

  const directory = await mkdtemp(join(tmpdir(), 'image-size-bench-'))
  try {
    for (const [label, payload] of [
      ['small files', SMALL_PAYLOAD],
      ['large files', LARGE_PAYLOAD],
    ] as const) {
      const rows: Row[] = []
      for (const name of names) {
        rows.push(await measureFormat(name, payload, directory))
      }

      const mean = (pick: (row: Row) => number) =>
        rows.reduce((total, row) => total + pick(row), 0) / rows.length

      console.log(`\n${label} - ${formatBytes(payload)} payload\n`)
      printTable(rows)
      console.log(
        `\n  mean: ${integer.format(mean((row) => row.decode))} decode/s, ` +
          `${integer.format(mean((row) => row.sequential))} file/s, ` +
          `${integer.format(mean((row) => row.parallel))} file/s x${PARALLELISM}`,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
