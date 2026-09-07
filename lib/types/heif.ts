import type { IImage, ISize } from './interface'
import { findBox, readBox, readUInt32BE, toUTF8String } from './utils'

// A full-box version/flags word, followed by two 32-bit values
const MIN_PROPERTY_PAYLOAD = 12

const brandMap = {
  avif: 'avif',
  mif1: 'heif',
  msf1: 'heif', // heif-sequence
  heic: 'heic',
  heix: 'heic',
  hevc: 'heic', // heic-sequence
  hevx: 'heic', // heic-sequence
}

export const HEIF: IImage = {
  validate(input) {
    const boxType = toUTF8String(input, 4, 8)
    if (boxType !== 'ftyp') return false

    const ftypBox = findBox(input, 'ftyp', 0)
    if (!ftypBox) return false

    const brandOffset = ftypBox.offset + ftypBox.headerSize
    const brand = toUTF8String(input, brandOffset, brandOffset + 4)
    return brand in brandMap
  },

  calculate(input) {
    // Based on https://nokiatech.github.io/heif/technical.html
    // `meta` is a full box, so its payload starts after a version/flags word
    const metaBox = findBox(input, 'meta', 0)
    const iprpBox =
      metaBox && findBox(input, 'iprp', metaBox.offset + metaBox.headerSize + 4)
    const ipcoBox =
      iprpBox && findBox(input, 'ipco', iprpBox.offset + iprpBox.headerSize)

    if (!ipcoBox) {
      throw new TypeError('Invalid HEIF, no ipco box found')
    }

    const type = toUTF8String(input, 8, 12)

    const images: ISize[] = []
    const ipcoEnd = ipcoBox.offset + ipcoBox.size
    let currentOffset = ipcoBox.offset + ipcoBox.headerSize

    // Walk the property container once. Searching the whole file for the next
    // `ispe` and `clap` on every turn costs quadratic time, which a file
    // packed with properties turns into a denial of service.
    while (currentOffset < ipcoEnd) {
      const property = readBox(input, currentOffset)
      if (!property) break
      currentOffset += property.size

      // Both properties read here are full boxes holding at least two values
      if (property.size < property.headerSize + MIN_PROPERTY_PAYLOAD) continue
      const payload = property.offset + property.headerSize

      if (property.name === 'ispe') {
        images.push({
          width: readUInt32BE(input, payload + 4),
          height: readUInt32BE(input, payload + 8),
        })
      } else if (property.name === 'clap' && images.length > 0) {
        // A clean aperture crops the image property it follows
        images[images.length - 1].width -= readUInt32BE(input, payload + 4)
      }
    }

    if (images.length === 0) {
      throw new TypeError('Invalid HEIF, no sizes found')
    }

    return {
      width: images[0].width,
      height: images[0].height,
      type,
      ...(images.length > 1 ? { images } : {}),
    }
  },
}
