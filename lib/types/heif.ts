import type { IImage, ISize } from './interface'
import { findBox, readUInt32BE, toUTF8String } from './utils'

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
    let currentOffset = ipcoBox.offset + ipcoBox.headerSize

    // Find all ispe and clap boxes
    while (currentOffset < ipcoBox.offset + ipcoBox.size) {
      const ispeBox = findBox(input, 'ispe', currentOffset)
      if (!ispeBox) break

      // `ispe` is a full box: version/flags, then the stored dimensions
      const sizeOffset = ispeBox.offset + ispeBox.headerSize + 4
      const rawWidth = readUInt32BE(input, sizeOffset)
      const rawHeight = readUInt32BE(input, sizeOffset + 4)

      // Look for a clap box after the ispe box
      const clapBox = findBox(input, 'clap', currentOffset)
      let width = rawWidth
      const height = rawHeight
      if (clapBox && clapBox.offset < ipcoBox.offset + ipcoBox.size) {
        const cropRight = readUInt32BE(
          input,
          clapBox.offset + clapBox.headerSize + 4,
        )
        width = rawWidth - cropRight
      }

      images.push({ height, width })

      currentOffset = ispeBox.offset + ispeBox.size
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
