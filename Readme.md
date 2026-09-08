# @carboneio/image-size

## Forked by [Carbone](https://carbone.io)

[![Build and test](https://github.com/carboneio/image-size/actions/workflows/build-test.yml/badge.svg?branch=main)](https://github.com/carboneio/image-size/actions/workflows/build-test.yml)
[![NPM Version](https://img.shields.io/npm/v/@carboneio/image-size.svg?style=flat-square)](https://www.npmjs.com/package/@carboneio/image-size)
[![Downloads](https://img.shields.io/npm/dm/@carboneio/image-size.svg?style=flat-square)](https://www.npmjs.com/package/@carboneio/image-size)
[![Code style: Biome](https://img.shields.io/badge/code_style-biome-60a5fa.svg?style=flat-square)](https://biomejs.dev/)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg?style=flat-square)](https://github.com/carboneio/image-size)

After a thorough security audit (pentest) of our dependencies, we decided to fork this project to fix several vulnerabilities and, in the process, optimize the library. For a detailed list of changes, please see the [full changelog](CHANGELOG.md).

We started by ensuring the test suite had 100% code coverage before making any changes. We also compared our results and performance with the tests from [sharp](https://github.com/lovell/sharp), a widely used, more general-purpose library.

This package is a fork of [image-size on GitHub](https://github.com/image-size/image-size) and [image-size on Codeberg](https://codeberg.org/image-size/image-size), optimized and maintained by [Carbone](https://carbone.io) to provide the fastest image-size library for Node.js.

We would like to warmly thank the original developer of this library for their excellent work. We are maintaining this fork only because we needed to apply some urgent fixes and improvements; as soon as the original project incorporates these corrections, we will be very happy to remove this fork and return to the main repository.

Please note that we will maintain this project as long as it remains relevant to our needs, but cannot guarantee support for issues outside our own roadmap.

Fast, lightweight NodeJS package to get dimensions of any image file or buffer.

## Key Features
- Zero dependencies
- Supports all major image formats
- Works with both files and buffers
- Minimal memory footprint - reads only image headers
- ESM and CommonJS support
- TypeScript types included

## Supported formats

- BMP
- CUR
- DDS
- GIF
- HEIC (HEIF, AVCI, AVIF)
- ICNS
- ICO
- J2C
- JPEG-2000 (JP2)
- JPEG
- JPEG-XL
- KTX (1 and 2)
- PNG
- PNM (PAM, PBM, PFM, PGM, PPM)
- PSD
- SVG
- TGA
- TIFF
- WebP

## Installation

```shell
npm install @carboneio/image-size
# or
yarn add @carboneio/image-size
# or
pnpm add @carboneio/image-size
```

## Usage

### Passing in a Buffer/Uint8Array
Best for streams, network requests, or when you already have the image data in memory.

```javascript
import { imageSize } from '@carboneio/image-size'
// or
const { imageSize } = require('@carboneio/image-size')

const dimensions = imageSize(buffer)
console.log(dimensions.width, dimensions.height)
```

### Reading from a file
Best for local files. Returns a promise.

```javascript
import { imageSizeFromFile } from '@carboneio/image-size/fromFile'
// or
const { imageSizeFromFile } = require('@carboneio/image-size/fromFile')

const dimensions = await imageSizeFromFile('photos/image.jpg')
console.log(dimensions.width, dimensions.height)
```

Note: Reading from files has a default concurrency limit of **100**
To change this limit, you can call the `setConcurrency` function like this:

```javascript
import { setConcurrency } from '@carboneio/image-size/fromFile'
// or
const { setConcurrency } = require('@carboneio/image-size/fromFile')
setConcurrency(123456)
```

### Reading from a file Syncronously (not recommended) ⚠️
v1.x of this library had a sync API, that internally used sync file reads.  

This isn't recommended because this blocks the node.js main thread, which reduces the performance, and prevents this library from being used concurrently.  

However if you still need to use this package syncronously, you can read the file syncronously into a buffer, and then pass the buffer to this library.  

```javascript
import { readFileSync } from 'node:fs'
import { imageSize } from '@carboneio/image-size'

const buffer = readFileSync('photos/image.jpg')
const dimensions = imageSize(buffer)
console.log(dimensions.width, dimensions.height)
```

### 3. Command Line
Useful for quick checks.

```shell
npx @carboneio/image-size image1.jpg image2.png
```

### Multi-size

If the target file/buffer is an HEIF, an ICO, or a CUR file, the `width` and `height` will be the ones of the largest image in the set.

An additional `images` array is available and returns the dimensions of all the available images

```javascript
import { imageSizeFromFile } from '@carboneio/image-size/fromFile'
// or
const { imageSizeFromFile } = require('@carboneio/image-size/fromFile')

const { images } = await imageSizeFromFile('images/multi-size.ico')
for (const dimensions of images) {
  console.log(dimensions.width, dimensions.height)
}
```

### Using a URL

```javascript
import url from 'node:url'
import http from 'node:http'
import { imageSize } from '@carboneio/image-size'

const imgUrl = 'http://my-amazing-website.com/image.jpeg'
const options = url.parse(imgUrl)

http.get(options, function (response) {
  const chunks = []
  response
    .on('data', function (chunk) {
      chunks.push(chunk)
    })
    .on('end', function () {
      const buffer = Buffer.concat(chunks)
      console.log(imageSize(buffer))
    })
})
```

### Disabling certain image types

```javascript
import { disableTypes } from '@carboneio/image-size'
// or
const { disableTypes } = require('@carboneio/image-size')

disableTypes(['tiff', 'ico'])
```

### JPEG image orientation

If the orientation is present in the JPEG EXIF metadata, it will be returned by the function. The orientation value is a [number between 1 and 8](https://exiftool.org/TagNames/EXIF.html#:~:text=0x0112,8%20=%20Rotate%20270%20CW) representing a type of orientation.

```javascript
import { imageSizeFromFile } from '@carboneio/image-size/fromFile'
// or
const { imageSizeFromFile } = require('@carboneio/image-size/fromFile')

const { width, height, orientation } = await imageSizeFromFile('images/photo.jpeg')
console.log(width, height, orientation)
```

# Performance

`image-size` reads a header; [sharp](https://github.com/lovell/sharp) decodes
an image. That makes them hard to compare on anything but this one question:
*how long does it take to learn an image's dimensions?* They give the same
answer: across sharp's own 501 test fixtures, the two libraries agree on all
496 that both can read.

Measured against sharp 0.35.4 / libvips 8.18.6 on Node 24, macOS arm64.

**From a buffer already in memory**,  parsing cost on its own:

| Format | Fixture              |   sharp | image-size | Factor |
| ------ | -------------------- | ------: | ---------: | -----: |
| JPEG   | 810 kB, 2725x2225    |  101 µs |    0.48 µs |   209x |
| PNG    | 6.8 MB, 2725x2225    |   76 µs |    0.34 µs |   226x |
| WebP   | 173 kB, 1024x772     |  206 µs |    0.52 µs |   400x |
| GIF    | 279 kB, 800x533      |   85 µs |    0.20 µs |   429x |
| TIFF   | 249 kB, 246x345      |  122 µs |    0.63 µs |   195x |
| AVIF   | 279 kB, 2048x858     |  102 µs |    1.39 µs |    74x |
| SVG    | 32 kB, 480x360       |  263 µs |    2.10 µs |   125x |

**From a file path**, what an application actually pays, I/O included:

| Format | Size    |   sharp | image-size | Factor |
| ------ | ------- | ------: | ---------: | -----: |
| JPEG   | 810 kB  |  230 µs |     102 µs |   2.3x |
| PNG    | 6.8 MB  |  124 µs |      99 µs |   1.3x |
| WebP   | 173 kB  |  294 µs |      64 µs |   4.6x |
| GIF    | 279 kB  |  191 µs |      73 µs |   2.6x |
| TIFF   | 249 kB  |  285 µs |      69 µs |   4.1x |
| AVIF   | 279 kB  |  342 µs |      75 µs |   4.6x |
| SVG    | 32 kB   |  444 µs |      48 µs |   9.2x |

The second table is the one to plan with. Reading the file dominates the cost,
so the two orders of magnitude on a buffer shrink to between 1.3x and 9.2x
once I/O is counted. `image-size` also has no native binary to install and no
start-up cost, where sharp pays about 50 ms on its first call.

libvips' cache is disabled for these numbers, since the benchmark re-reads the
same fixture in a loop and would otherwise measure memoisation rather than
work. Files are warm in the OS page cache on both sides. Run `npm run bench`
for throughput across all thirty formats.

# Limitations

1. **Partial File Reading**
   - Only reads image headers, not full files
   - Some corrupted images might still report dimensions

2. **SVG Limitations**
   - Only supports pixel dimensions and viewBox
   - Percentage values not supported

3. **File Access**
   - Reading from files has a default concurrency limit of 100
   - Can be adjusted using `setConcurrency()`

4. **Buffer Requirements**
   - Some formats (like TIFF) require the full header in buffer
   - Streaming partial buffers may not work for all formats

## Development

```bash
npm ci          # install dependencies from package-lock.json
npm test        # unit tests, with a 100% coverage threshold
npm run bench   # detection throughput, per format, on small and large files
```

`npm run bench` accepts `--filter=<substring>` to benchmark a single format,
e.g. `npm run bench -- --filter=webp`.

## License

MIT

## Credits

not a direct port, but an attempt to have something like
[dabble's imagesize](https://github.com/dabble/imagesize/blob/master/lib/image_size.rb) as a node module.

## [Contributors](Contributors.md)
