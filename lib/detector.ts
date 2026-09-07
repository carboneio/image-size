import type { imageType } from './types/index'
import { typeHandlers, types } from './types/index'

// This map helps avoid validating for every single image type
const firstBytes = new Map<number, imageType>([
  [0x00, 'heif'],
  [0x38, 'psd'],
  [0x42, 'bmp'],
  [0x44, 'dds'],
  [0x47, 'gif'],
  [0x49, 'tiff'],
  [0x4d, 'tiff'],
  [0x52, 'webp'],
  [0x69, 'icns'],
  [0x89, 'png'],
  [0xff, 'jpg'],
])

// A validator only answers "is this input mine?". One that cannot read far
// enough to tell must not abort the sweep for the formats after it.
function validates(type: imageType, input: Uint8Array): boolean {
  try {
    return typeHandlers.get(type)!.validate(input)
  } catch {
    return false
  }
}

export function detector(input: Uint8Array): imageType | undefined {
  const byte = input[0]
  const type = firstBytes.get(byte)
  if (type && validates(type, input)) {
    return type
  }
  return types.find((candidate) => validates(candidate, input))
}
