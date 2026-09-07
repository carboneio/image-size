# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-09-07

A security release. Three published denial-of-service advisories are closed,
along with five further problems found while auditing the parsers, and the
library no longer hands back dimensions that no image can have.

Every fix in this release was written test first: a case going through the
public `imageSize` was added and observed to fail before the parser was
touched. The proofs live in `specs/security.spec.ts`.

### Security

- **Out-of-bounds read (not previously reported).** `getView` built its
  `DataView` without a length, so it spanned the rest of the underlying
  `ArrayBuffer` instead of the `Uint8Array` it was handed. Any parser reading
  past the end of a short input returned adjacent memory. Because Node
  allocates small `Buffer`s out of a shared 8KB pool, those bytes routinely
  belonged to unrelated data. An eight byte view onto a 4096 byte buffer made
  `imageSize` report a size of `1094795585x1094795585` — the neighbouring bytes,
  read straight out of the caller's process. This is the only entry here that
  discloses information rather than denying service.

- **[CVE-2025-71330] ICNS infinite loop.**
  ([GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr))
  An ICNS entry declares its own length and the parser added that length to its
  cursor with no lower bound. An entry of length zero left the cursor in place
  and spun the event loop for ever. A 64 byte file was enough.

- **[CVE-2025-71329] HEIF and JXL infinite loops.**
  ([GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq))
  A box declaring a size of zero never moved the box cursor forward, in the
  HEIF property walk and in the JXL partial codestream walk alike. Box sizes are
  now read as the ISO base media file format defines them, where zero means the
  box runs to the end of the file, so the cursor always advances.

- **Quadratic JPEG scanning (not previously reported).** Realigning after a bad
  segment length copied the whole remaining buffer for every byte skipped.
  512KB of bytes that never spell a marker blocked the event loop for 10.8
  seconds. `imageSizeFromFile` hands the parsers exactly 512KB, so any file that
  size reached this path.

- **Quadratic HEIF property scanning (not previously reported).** The property
  walk searched the whole file for the next `ispe` and again for the next
  `clap` on every turn. 4000 properties, in 78KB, cost 4.1 seconds.

- **Quadratic TIFF tag scanning (not previously reported).** Every twelve byte
  tag entry resliced the rest of the buffer. 512KB of tags that never terminate
  cost 0.9 seconds.

- **Unbounded ICO entry count (not previously reported).** The number of icons
  came straight from the file header and was never checked against the buffer.
  A 22 byte header announcing 65535 icons produced 65535 entries whose width
  and height were `undefined`.

- **Implausible dimensions returned without complaint (not previously
  reported).** A PNM header whose dimensions are not numbers came back as
  `NaN x NaN`, one with negative numbers came back as `-5 x -5`, and a BMP or
  GIF declaring an empty surface came back as `0 x 0`. Code sizing a layout
  from those values got silent nonsense instead of an error.

### Performance

Same payloads, same machine, measured against the compiled `dist/` before and
after. Each is a single `imageSize` call on a hostile input.

| Payload                            |    Before |  After | Factor |
| ---------------------------------- | --------: | -----: | -----: |
| JPEG, 512KB of unmarked bytes      | 10 850 ms |  20 ms |   543x |
| HEIF, 4000 image properties (78KB) |  4 052 ms |   4 ms |  1013x |
| TIFF, 512KB of unterminated tags   |    890 ms |  11 ms |    81x |
| ICNS, HEIF, JXL with a size of 0   |     never |  23 ms |      — |

Valid images are unaffected: `npm run bench` shows no measurable change across
the thirty formats it covers, since none of them exercised the pathological
paths.

### Fixed

- A HEIF cropped inside a box that declares more bytes than survived is read
  again, instead of failing with `Invalid HEIF, no ipco box found`
  ([#452](https://codeberg.org/image-size/image-size/issues/452)). A box is now
  clamped to what the input holds rather than rejected outright.
- A baseline JPEG that opens straight on its frame header, `FF D8 FF C0`, is
  measured instead of reported as having no size
  ([#434](https://codeberg.org/image-size/image-size/issues/434)). The old code
  skipped four bytes past the signature, stepping over the marker.
- `Corrupt JPG, exceeded buffer limits` no longer fires on files that are
  merely large ([#96](https://codeberg.org/image-size/image-size/issues/96)),
  as a consequence of the index based scan.
- Boxes carrying their size as a 64-bit `largesize` are read correctly. HEIF,
  JP2 and JXL located their payloads by assuming an eight byte header.
- A clean aperture (`clap`) now crops the image property it follows. The old
  scan could apply the first `clap` of a file to every image before it.
- `tiff.ts` imported `node:fs` without using it, dragging a Node builtin into
  every browser bundle of the library.

### Changed

These are the observable differences for a caller. Valid images return exactly
what they returned before; everything below concerns malformed input.

- **Malformed input always raises `TypeError`.** Short buffers used to escape as
  `RangeError` from `DataView`, and a truncated JXL codestream as a bare
  `Error`. Integrations that filter on the error type should now expect
  `TypeError` throughout.
- **A size of zero, a negative size or `NaN` is now an error** rather than a
  returned value, with the message `Invalid <type>, implausible size <w>x<h>`.
  This is the change most likely to surface in an existing integration: code
  that silently accepted `0 x 0` will start seeing exceptions.
- **A box declaring a size of zero is the last box of the file**, as the format
  says. Anything laid out after it is no longer scanned.
- **ICNS entries with an unknown OSType are skipped** instead of contributing an
  entry sized `undefined` by `undefined`.
- **ICO reports only the entries the file carries**, and a header with no entry
  behind it raises `Invalid ICO, no entries found`.
- **A format validator that throws is treated as "not this format"** rather than
  aborting detection for every format behind it. A two byte JXL codestream used
  to be reported with the truncation complaint of an unrelated parser.
- `PNG.validate` no longer throws `Invalid PNG`; the same error now comes from
  `PNG.calculate`. Callers of `imageSize` see no difference. This only matters
  if you import `lib/types/png` directly.

### Known limitations

SVG detection only looks at the first 1000 bytes, so a valid SVG preceded by a
longer comment or doctype is reported as an unsupported file type
([#397](https://codeberg.org/image-size/image-size/issues/397),
[#410](https://codeberg.org/image-size/image-size/issues/410)). Widening that
window is deliberately left alone here: it is a detection question rather than
a safety one, and it belongs with the scanner rewrite proposed in
[#448](https://codeberg.org/image-size/image-size/pulls/448).

[2.1.0]: https://codeberg.org/image-size/image-size/compare/v2.0.2...v2.1.0
[CVE-2025-71330]: https://github.com/advisories/GHSA-w3rx-r6r6-pgpr
[CVE-2025-71329]: https://github.com/advisories/GHSA-5p2g-fcmc-qvqq
