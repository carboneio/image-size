import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Helpers for proving denial-of-service bugs from the public API.
 *
 * An infinite loop inside `imageSize` cannot be caught by the `timeout` option
 * of `node:test`: the loop is synchronous, so the event loop never gets a
 * chance to fire the timer and the whole suite freezes. The proof therefore has
 * to run in a child process that can be killed from the outside.
 */

const libEntry = resolve(__dirname, '../../lib')
const tsConfig = resolve(__dirname, '../../tsconfig.test.json')

export type IsolatedOutcome =
  | { returned: { width: number; height: number; type?: string } }
  | { threw: { name: string; message: string } }

export interface IsolatedResult {
  /** `true` when the child had to be killed, i.e. `imageSize` never returned */
  killed: boolean
  /** What `imageSize` did, when the child terminated on its own */
  outcome?: IsolatedOutcome
}

/**
 * Runs `imageSize(payload)` in a child process that is killed after `timeout`.
 *
 * Costs roughly 600ms of `ts-node` startup, so it is reserved for the payloads
 * that would otherwise hang the test runner.
 */
export function imageSizeIsolated(
  payload: Uint8Array,
  timeout = 2000,
): IsolatedResult {
  const source = `
    const { imageSize } = require(${JSON.stringify(libEntry)})
    const payload = Uint8Array.from(${JSON.stringify(Array.from(payload))})
    let outcome
    try {
      outcome = { returned: imageSize(payload) }
    } catch (err) {
      outcome = { threw: { name: err.constructor.name, message: err.message } }
    }
    process.stdout.write(JSON.stringify(outcome))
  `

  const child = spawnSync(
    process.execPath,
    ['--require', 'ts-node/register', '-e', source],
    {
      timeout,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: tsConfig },
    },
  )

  if (child.signal === 'SIGKILL') return { killed: true }

  if (child.status !== 0) {
    throw new Error(`Isolated run failed unexpectedly: ${child.stderr}`)
  }

  return { killed: false, outcome: JSON.parse(child.stdout) as IsolatedOutcome }
}

/** Milliseconds spent in `run`, which is expected to throw or return */
export function elapsed(run: () => unknown): number {
  const start = process.hrtime.bigint()
  try {
    run()
  } catch {
    // A malformed input is expected to be rejected; only the delay matters here
  }
  return Number(process.hrtime.bigint() - start) / 1e6
}
