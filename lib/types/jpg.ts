// NOTE: we only support baseline and progressive JPGs here
// due to the structure of the loader class, we only get a buffer
// with a maximum size of 4096 bytes. so if the SOF marker is outside
// if this range we can't detect the file size correctly.

import type { IImage, ISize } from './interface'
import { readUInt, readUInt16BE, toHexString } from './utils'

const EXIF_MARKER = '45786966'
const APP1_DATA_SIZE_BYTES = 2
const EXIF_HEADER_BYTES = 6
const TIFF_BYTE_ALIGN_BYTES = 2
const BIG_ENDIAN_BYTE_ALIGN = '4d4d'
const LITTLE_ENDIAN_BYTE_ALIGN = '4949'

// Each entry is exactly 12 bytes
const IDF_ENTRY_BYTES = 12
const NUM_DIRECTORY_ENTRIES_BYTES = 2

// 0xFFC0 is baseline standard (SOF), 0xFFC1 baseline optimized (SOF),
// 0xFFC2 progressive (SOF2)
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2])

function isEXIF(input: Uint8Array, segment: number): boolean {
  return toHexString(input, segment + 2, segment + 6) === EXIF_MARKER
}

function extractSize(input: Uint8Array, index: number): ISize {
  return {
    height: readUInt16BE(input, index),
    width: readUInt16BE(input, index + 2),
  }
}

function extractOrientation(exifBlock: Uint8Array, isBigEndian: boolean) {
  // TODO: assert that this contains 0x002A
  // let STATIC_MOTOROLA_TIFF_HEADER_BYTES = 2
  // let TIFF_IMAGE_FILE_DIRECTORY_BYTES = 4

  // TODO: derive from TIFF_IMAGE_FILE_DIRECTORY_BYTES
  const idfOffset = 8

  // IDF osset works from right after the header bytes
  // (so the offset includes the tiff byte align)
  const offset = EXIF_HEADER_BYTES + idfOffset

  const idfDirectoryEntries = readUInt(exifBlock, 16, offset, isBigEndian)

  for (
    let directoryEntryNumber = 0;
    directoryEntryNumber < idfDirectoryEntries;
    directoryEntryNumber++
  ) {
    const start =
      offset +
      NUM_DIRECTORY_ENTRIES_BYTES +
      directoryEntryNumber * IDF_ENTRY_BYTES
    const end = start + IDF_ENTRY_BYTES

    // Skip on corrupt EXIF blocks
    if (start > exifBlock.length) {
      return
    }

    const block = exifBlock.slice(start, end)
    const tagNumber = readUInt(block, 16, 0, isBigEndian)

    // 0x0112 (decimal: 274) is the `orientation` tag ID
    if (tagNumber === 274) {
      const dataFormat = readUInt(block, 16, 2, isBigEndian)
      if (dataFormat !== 3) {
        return
      }

      // unsinged int has 2 bytes per component
      // if there would more than 4 bytes in total it's a pointer
      const numberOfComponents = readUInt(block, 32, 4, isBigEndian)
      if (numberOfComponents !== 1) {
        return
      }

      return readUInt(block, 16, 8, isBigEndian)
    }
  }
}

function validateExifBlock(
  input: Uint8Array,
  segment: number,
  segmentLength: number,
) {
  // Skip APP1 Data Size
  const exifBlock = input.slice(
    segment + APP1_DATA_SIZE_BYTES,
    segment + segmentLength,
  )

  // Consider byte alignment
  const byteAlign = toHexString(
    exifBlock,
    EXIF_HEADER_BYTES,
    EXIF_HEADER_BYTES + TIFF_BYTE_ALIGN_BYTES,
  )

  // Ignore Empty EXIF. Validate byte alignment
  const isBigEndian = byteAlign === BIG_ENDIAN_BYTE_ALIGN
  const isLittleEndian = byteAlign === LITTLE_ENDIAN_BYTE_ALIGN

  if (isBigEndian || isLittleEndian) {
    return extractOrientation(exifBlock, isBigEndian)
  }
}

export const JPG: IImage = {
  validate: (input) => toHexString(input, 0, 2) === 'ffd8',

  calculate(input) {
    // A baseline JPEG may open straight on its frame header, with no segment
    // in front of it: signature, marker, length, precision, then the size
    if (SOF_MARKERS.has(input[3])) return extractSize(input, 7)

    let orientation: number | undefined
    // Index of the two byte length field of the segment being examined. The
    // whole scan works on indices: slicing the remainder on every step made
    // the cost quadratic, and a 512KB file blocked the event loop for 15s.
    let segment = 4

    while (segment + APP1_DATA_SIZE_BYTES <= input.length) {
      const segmentLength = readUInt16BE(input, segment)
      // Where the marker of the following segment should be
      const nextMarker = segment + segmentLength

      if (nextMarker > input.length) {
        throw new TypeError('Corrupt JPG, exceeded buffer limits')
      }

      // Every JPEG block must begin with a 0xFF
      if (input[nextMarker] !== 0xff) {
        segment += 1
        continue
      }

      if (isEXIF(input, segment)) {
        orientation = validateExifBlock(input, segment, segmentLength)
      }

      if (SOF_MARKERS.has(input[nextMarker + 1])) {
        const size = extractSize(input, nextMarker + 5)

        // TODO: is orientation=0 a valid answer here?
        if (!orientation) {
          return size
        }

        return {
          height: size.height,
          orientation,
          width: size.width,
        }
      }

      // move to the next block
      segment = nextMarker + 2
    }

    throw new TypeError('Invalid JPG, no size found')
  },
}
