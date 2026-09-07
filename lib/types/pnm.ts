import type { IImage, ISize } from './interface'
import { toUTF8String } from './utils'

const PNMTypes = {
  P1: 'pbm/ascii',
  P2: 'pgm/ascii',
  P3: 'ppm/ascii',
  P4: 'pbm',
  P5: 'pgm',
  P6: 'ppm',
  P7: 'pam',
  PF: 'pfm',
} as const

type ValidSignature = keyof typeof PNMTypes
type Handler = (lines: Iterable<string>) => ISize

const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

const isLineBreak = (byte: number) =>
  byte === LINE_FEED || byte === CARRIAGE_RETURN

/**
 * Yields the lines of `input` from `start`, decoding them one at a time.
 *
 * Decoding the whole file up front and splitting it into an array made the
 * cost grow with the pixel data rather than with the header, and consuming
 * that array with `shift()` recopied it on every line.
 */
function* readLines(input: Uint8Array, start: number): Generator<string> {
  let lineStart = start
  while (lineStart < input.length) {
    let lineEnd = lineStart
    while (lineEnd < input.length && !isLineBreak(input[lineEnd])) {
      lineEnd += 1
    }

    yield toUTF8String(input, lineStart, lineEnd)

    // Skip the whole run of line breaks, so that an empty line is not
    // reported once per byte of separator
    lineStart = lineEnd + 1
    while (lineStart < input.length && isLineBreak(input[lineStart])) {
      lineStart += 1
    }
  }
}

const handlers: Record<string, Handler> = {
  default: (lines) => {
    for (const line of lines) {
      if (line[0] === '#') {
        continue
      }
      const dimensions = line.split(' ')
      if (dimensions.length === 2) {
        return {
          height: Number.parseInt(dimensions[1], 10),
          width: Number.parseInt(dimensions[0], 10),
        }
      }
      break
    }
    throw new TypeError('Invalid PNM')
  },
  pam: (lines) => {
    const size: Record<string, number> = {}
    for (const line of lines) {
      if (line.length > 16 || line.charCodeAt(0) > 128) {
        continue
      }
      const [key, value] = line.split(' ')
      if (key && value) {
        size[key.toLowerCase()] = Number.parseInt(value, 10)
      }
      if (size.height && size.width) {
        break
      }
    }

    if (size.height && size.width) {
      return {
        height: size.height,
        width: size.width,
      }
    }
    throw new TypeError('Invalid PAM')
  },
}

export const PNM: IImage = {
  validate: (input) => toUTF8String(input, 0, 2) in PNMTypes,

  calculate(input) {
    const signature = toUTF8String(input, 0, 2) as ValidSignature
    const type = PNMTypes[signature]
    const handler = handlers[type] || handlers.default
    // The signature is followed by a single separator byte
    return handler(readLines(input, 3))
  },
}
