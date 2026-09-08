import type { IImage } from './interface'
import { findBox, readUInt32BE, toUTF8String } from './utils'

export const JP2: IImage = {
  validate(input) {
    const boxType = toUTF8String(input, 4, 8)
    if (boxType !== 'jP  ') return false

    const ftypBox = findBox(input, 'ftyp', 0)
    if (!ftypBox) return false

    const brandOffset = ftypBox.offset + ftypBox.headerSize
    const brand = toUTF8String(input, brandOffset, brandOffset + 4)
    return brand === 'jp2 '
  },

  calculate(input) {
    const jp2hBox = findBox(input, 'jp2h', 0)
    const ihdrBox =
      jp2hBox && findBox(input, 'ihdr', jp2hBox.offset + jp2hBox.headerSize)
    if (ihdrBox) {
      const sizeOffset = ihdrBox.offset + ihdrBox.headerSize
      return {
        height: readUInt32BE(input, sizeOffset),
        width: readUInt32BE(input, sizeOffset + 4),
      }
    }
    throw new TypeError('Unsupported JPEG 2000 format')
  },
}
