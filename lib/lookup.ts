import { detector } from './detector'
import type { imageType } from './types/index'
import { typeHandlers } from './types/index'
import type { ISizeCalculationResult } from './types/interface'

type Options = {
  disabledTypes: imageType[]
}

const globalOptions: Options = {
  disabledTypes: [],
}

/**
 * Last line of defence before the caller.
 *
 * No image has a fractional, negative or empty side, so anything else is a
 * parser that read past its data or misread a field. Catching it here keeps
 * NaN and undefined out of the returned object whatever the format does.
 */
function assertPlausible(size: ISizeCalculationResult): void {
  const { width, height, type } = size
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError(`Invalid ${type}, implausible size ${width}x${height}`)
  }
}

/**
 * Return size information based on an Uint8Array
 *
 * @param {Uint8Array} input
 * @returns {ISizeCalculationResult}
 */
export function imageSize(input: Uint8Array): ISizeCalculationResult {
  // detect the file type... don't rely on the extension
  const type = detector(input)

  if (typeof type !== 'undefined') {
    if (globalOptions.disabledTypes.indexOf(type) > -1) {
      throw new TypeError(`disabled file type: ${type}`)
    }

    // find an appropriate handler for this file type
    const size = typeHandlers.get(type)!.calculate(input)
    if (size !== undefined) {
      size.type = size.type ?? type

      // If multiple images, find the largest by area
      if (size.images && size.images.length > 1) {
        const largestImage = size.images.reduce((largest, current) => {
          return current.width * current.height > largest.width * largest.height
            ? current
            : largest
        }, size.images[0])

        // Ensure the main result is the largest image
        size.width = largestImage.width
        size.height = largestImage.height
      }

      assertPlausible(size)
      return size
    }
  }

  // throw up, if we don't understand the file
  throw new TypeError(`unsupported file type: ${type}`)
}

export const disableTypes = (types: imageType[]): void => {
  globalOptions.disabledTypes = types
}
