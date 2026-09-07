import * as fs from 'node:fs'
import * as path from 'node:path'

import { imageSize } from './lookup'
import type { ISizeCalculationResult } from './types/interface'

// Maximum input size, with a default of 512 kilobytes.
// TO-DO: make this adaptive based on the initial signature of the image
const MaxInputSize = 512 * 1024

type Job = {
  filePath: string
  resolve: (value: ISizeCalculationResult) => void
  reject: (error: Error) => void
}

// This queue is for async `fs` operations, to avoid reaching file-descriptor limits
const queue: Job[] = []
let inFlight = 0

let concurrency = 100
export const setConcurrency = (c: number): void => {
  concurrency = c
  pump()
}

const runJob = async ({ filePath, resolve, reject }: Job) => {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(path.resolve(filePath), 'r')
  } catch (err) {
    return reject(err as Error)
  }
  try {
    const { size } = await handle.stat()
    if (size <= 0) {
      throw new TypeError('Empty file')
    }
    const inputSize = Math.min(size, MaxInputSize)
    const input = new Uint8Array(inputSize)
    // A read is allowed to come back short. Parsing the whole buffer would
    // feed the parsers zeros that were never in the file.
    const { bytesRead } = await handle.read(input, 0, inputSize, 0)
    resolve(imageSize(input.subarray(0, bytesRead)))
  } catch (err) {
    reject(err as Error)
  } finally {
    await handle.close()
  }
}

/**
 * Starts as many queued jobs as the budget allows, and one more each time a
 * job finishes. Counting what is in flight is what makes the budget real: a
 * queue that is drained by whoever fills it only ever limits a single caller.
 */
function pump(): void {
  while (inFlight < concurrency && queue.length > 0) {
    const job = queue.shift() as Job
    inFlight += 1

    // Free the slot whether the job succeeded or not, as `allSettled` did
    const release = () => {
      inFlight -= 1
      pump()
    }
    runJob(job).then(release, release)
  }
}

/**
 * @param {string} filePath - relative/absolute path of the image file
 */
export const imageSizeFromFile = async (filePath: string) =>
  new Promise<ISizeCalculationResult>((resolve, reject) => {
    queue.push({ filePath, resolve, reject })
    pump()
  })
