import type { IImage } from './interface'
import { readUInt32BE, toUTF8String } from './utils'

const pngSignature = 'PNG\r\n\x1a\n'
const pngImageHeaderChunkName = 'IHDR'

// Used to detect "fried" png's: https://web.archive.org/web/20190414220044/http://www.jongware.com/pngdefry.html
const pngFriedChunkName = 'CgBI'

export const PNG: IImage = {
  // The signature answers "is this a PNG?". Whether the file is a sound one
  // is for calculate to report, so that detection cannot be derailed by it.
  validate: (input) => pngSignature === toUTF8String(input, 1, 8),

  calculate(input) {
    const isFried = toUTF8String(input, 12, 16) === pngFriedChunkName
    const headerChunk = isFried ? 28 : 12

    if (
      toUTF8String(input, headerChunk, headerChunk + 4) !==
      pngImageHeaderChunkName
    ) {
      throw new TypeError('Invalid PNG')
    }

    const dimensions = headerChunk + 4
    return {
      height: readUInt32BE(input, dimensions + 4),
      width: readUInt32BE(input, dimensions),
    }
  },
}
