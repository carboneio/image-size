# Changelog

All notable changes to this project are documented in this file.

## [3.0.0] - 2026-09-07

A security release. Two published denial-of-service advisories are closed,
between them covering three parsers, along with seven further problems found
while auditing the others, and the library no longer hands back dimensions
that no image can have. Two more wrong answers, in the TIFF and JPEG readers,
came out of checking every result against
[sharp](https://github.com/lovell/sharp) over the 501 images in its test
fixtures; the two libraries now agree on all 496 they can both read.

Removing those pathological scans made the library about three and a half
times faster on valid images. The **Performance** section has the
measurements.

It is a major version because the hardening is observable: inputs that used to
come back as `0 x 0`, `NaN x NaN` or a `RangeError` now raise a `TypeError`.
Valid images return exactly what they returned in 2.x, so an upgrade is only
breaking for code that was relying on the old answers to malformed files. The
**Changed** section below lists every difference.

Every fix in this release was written test first: a case going through the
public `imageSize` was added and observed to fail before the parser was
touched. The proofs live in `specs/security.spec.ts` and
`specs/malformed.spec.ts`.

### Security

- **Out-of-bounds read.** `getView` built its
  `DataView` without a length, so it spanned the rest of the underlying
  `ArrayBuffer` instead of the `Uint8Array` it was handed. Any parser reading
  past the end of a short input returned adjacent memory. Because Node
  allocates small `Buffer`s out of a shared 8KB pool, those bytes routinely
  belonged to unrelated data. An eight byte view onto a 4096 byte buffer made
  `imageSize` report a size of `1094795585x1094795585` — the neighbouring bytes,
  read straight out of the caller's process. This is the only entry here that
  discloses information rather than denying service.

- **ICNS infinite loop.**
  [CVE-2025-71330](https://nvd.nist.gov/vuln/detail/CVE-2025-71330),
  [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).
  An ICNS entry declares its own length and the parser added that length to its
  cursor with no lower bound. An entry of length zero left the cursor in place
  and spun the event loop for ever. A 64 byte file was enough.

- **HEIF and JXL infinite loops.**
  [CVE-2025-71329](https://nvd.nist.gov/vuln/detail/CVE-2025-71329),
  [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
  A box declaring a size of zero never moved the box cursor forward, in the
  HEIF property walk and in the JXL partial codestream walk alike. Box sizes are
  now read as the ISO base media file format defines them, where zero means the
  box runs to the end of the file, so the cursor always advances.

- **Quadratic JPEG scanning.** Realigning after a bad
  segment length copied the whole remaining buffer for every byte skipped.
  512KB of bytes that never spell a marker blocked the event loop for 10.8
  seconds. `imageSizeFromFile` hands the parsers exactly 512KB, so any file that
  size reached this path.

- **Quadratic HEIF property scanning.** The property
  walk searched the whole file for the next `ispe` and again for the next
  `clap` on every turn. 4000 properties, in 78KB, cost 4.1 seconds.

- **Quadratic TIFF tag scanning.** Every twelve byte
  tag entry resliced the rest of the buffer. 512KB of tags that never terminate
  cost 0.9 seconds.

- **Quadratic PNM header scanning.** The header was
  decoded from the whole file into one string, split into an array of lines,
  and that array then consumed with `shift()`, which recopies it on every call.
  512KB of comment lines blocked the event loop for 1.9 seconds. As with JPEG,
  512KB is exactly what `imageSizeFromFile` hands the parsers.

- **WebP streams sized without their signature.** The
  two guards each tested the *other* format's signature, in the negative. A
  lossy chunk missing its `9d 01 2a` start code was sized from whatever bytes
  followed, reporting `320x240` for arbitrary data, and a lossless chunk
  missing its `0x2f` signature reported `321x177` the same way. Both are
  positive integers, so the plausibility check below cannot catch them.

- **Unbounded ICO entry count.** The number of icons
  came straight from the file header and was never checked against the buffer.
  A 22 byte header announcing 65535 icons produced 65535 entries whose width
  and height were `undefined`.

- **Implausible dimensions returned without complaint (not previously
  reported).** A PNM header whose dimensions are not numbers came back as
  `NaN x NaN`, one with negative numbers came back as `-5 x -5`, and a BMP or
  GIF declaring an empty surface came back as `0 x 0`. Code sizing a layout
  from those values got silent nonsense instead of an error.

### Performance

Every number below compares this release against 2.0.2, the commit this work
started from, on the same machine and with the same payloads. Each row here is
a single `imageSize` call on a hostile input.

| Payload                            |    Before |   After |  Factor |
| ---------------------------------- | --------: | ------: | ------: |
| JPEG, 512KB of unmarked bytes      | 13 950 ms | 1.23 ms | 11 342x |
| HEIF, 4000 image properties (78KB) |  2 339 ms | 0.50 ms |  4 678x |
| TIFF, 512KB of unterminated tags   |  1 167 ms | 0.44 ms |  2 652x |
| PNM, 512KB of comment lines        |  1 914 ms | 13.6 ms |    141x |
| ICNS, HEIF, JXL with a size of 0   |     never | 0.03 ms |       — |

Valid images got faster too, which was not the point but is the larger effect.
Some of those scans were pathological on ordinary files and not only on
crafted ones, and two parsers were reading whole files to find a header that
sits in the first few bytes.

These come from `npm run bench`, which builds a valid 1920x1080 image in each
of the thirty supported formats, padded with pixel data to the size given. A
*decode* is one `imageSize` call on that image held in memory — nothing is
really decoded, only the header is read — and *per file* is one
`imageSizeFromFile`, I/O included. Operations per second, mean over the thirty
formats:

| Measure               |    Before |     After | Factor |
| --------------------- | --------: | --------: | -----: |
| decodes/s, 512 B file | 1 105 014 | 3 891 394 |   3.5x |
| decodes/s, 2 MB file  |   922 673 | 3 293 873 |   3.6x |
| files/s, 2 MB file    |     6 848 |     8 848 |   1.3x |

Decodes per second on a 2 MB payload, for the formats that moved most:

| Format     |    Before |     After |  Factor |
| ---------- | --------: | --------: | ------: |
| pnm        |       176 |   775 445 | 4 406x |
| pnm/pam    |       179 |   609 858 | 3 407x |
| pnm/ascii  |       515 |   783 961 | 1 522x |
| tiff       |     1 302 | 2 404 652 | 1 847x |
| bigtiff    |     1 277 | 1 422 460 | 1 114x |
| jpg        |     5 373 | 4 670 237 |   869x |
| svg        |     2 436 |   535 711 |   220x |
| avif       |   315 559 | 1 298 583 |   4.1x |
| png        | 1 280 919 | 4 041 767 |   3.2x |
| webp lossy |   749 164 | 1 686 248 |   2.3x |

Those factors dwarf the 3.6x mean, and the mean is the fairer summary. It
averages throughput across the thirty formats, so it is carried by the ones
that were already fast: DDS, PSD, GIF, BMP and ICNS alone held 65% of it. The
nine formats that gained three orders of magnitude sat below 10 000 decodes
per second before, 0.05% of the total between them, so multiplying them by a
thousand barely moves it. The median format gained 3.2x.

What the large factors say is not that the library is a thousand times faster,
but that PNM, SVG and TIFF used to be unusably slow and no longer are. PNM's
cost no longer depends on file size at all: 775 445 decodes per second on a
2 MB file against 807 683 on a 529 byte one.

Two changes lift every format at once, since every parser goes through them.
`toUTF8String` and `toHexString` copied the byte range before reading it, and
each format's `validate` calls one of the two. Integer reads allocated a
`DataView` apiece — one shared view is not an option, as it would reach past
the image into the rest of the `ArrayBuffer` — where reading the bytes by
index keeps the bounds check and allocates nothing. This second change is
worth 8.1x on its own for a tag-heavy TIFF, which is why TIFF and BigTIFF sit
in the table above next to parsers that had an algorithmic fault. The new
readers were checked against `DataView` over 2.2 million random reads at
random offsets.

Two more copies are gone that the benchmark's fixtures do not exercise, since
neither shape appears in them:

| Payload                          |  Before |   After | Factor |
| -------------------------------- | ------: | ------: | -----: |
| JXL container, 32 MB codestream  | 2.34 ms | 0.01 ms |   234x |
| JPEG APP1 EXIF, 5000 IFD entries | 1.04 ms | 0.11 ms |   9.5x |

The JXL container was copied whole so that nine bytes of header could be read
from its start. The EXIF walk copied the APP1 segment, up to 64 KB, and then
each twelve byte entry out of that copy.

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
  JP2 and JXL located their payloads by assuming an eight byte header. A JXL
  container whose `ftyp` box carries a `largesize` had its brand read from the
  middle of that size field, and so was reported as an unsupported file type.
- A lossless WebP whose packed dimension bits happen to spell the lossy start
  code, `9d 01 2a`, is measured instead of rejected.
- A multi-page TIFF reports its first page instead of its last. A directory
  says how many entries it holds and the reader ignored that count, walking on
  until a zero tag or the end of the file. A two page fax crossed 3569 entries
  where the directory declared 17, ran into the second directory, and let its
  dimensions overwrite the first one's. Any bytes that looked like a width tag
  could do the same.
- A lossless or arithmetic-coded JPEG is measured instead of rejected as
  corrupt. Only `FF C0`, `FF C1` and `FF C2` counted as frame headers, where
  the start-of-frame markers fill the `FF C0`..`FF CF` range apart from three
  that carry no frame (`FF C4`, `FF C8`, `FF CC`).
- `imageSizeFromFile` no longer parses bytes a short read never delivered. It
  ignored the `bytesRead` it was given, so a partial read on a network or FUSE
  filesystem left the rest of the buffer at zero and the parsers were handed
  bytes that were never in the file — a wrong answer where an error was due.
- `imageSizeFromFile` now honours its concurrency limit. Every call drained the
  queue itself and nothing counted the jobs already running, so each caller
  started its own batch and the cap of 100 never engaged. Sizing 500 files at
  once held 500 descriptors open; it now peaks at 100, in the same time. This
  is the `EMFILE` the queue exists to prevent.
- A clean aperture (`clap`) now crops the image property it follows. The old
  scan could apply the first `clap` of a file to every image before it.
- `tiff.ts` imported `node:fs` without using it, dragging a Node builtin into
  every browser bundle of the library.

### Changed (breaking)

These are the observable differences for a caller, and the reason this is a
major version. Valid images return exactly what they returned in 2.x;
everything below concerns malformed input.

- **Malformed input always raises `TypeError`.** Short buffers used to escape as
  `RangeError` from `DataView`, and a truncated JXL codestream as a bare
  `Error`. Integrations that filter on the error type should now expect
  `TypeError` throughout.
- **A JXL container with no codestream says so**, with
  `No codestream found in JXL container`. An empty `jxlc` box, or `jxlp` boxes
  carrying nothing but their headers, used to reach the bit reader and fail
  there with `Reached end of input`, which described the symptom rather than
  the problem.
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
- **A WebP stream must carry its own signature.** A `VP8 ` chunk now needs the
  `9d 01 2a` start code and a `VP8L` chunk the `0x2f` signature byte, where
  before each was checked against the other format's. Files that were being
  sized out of unvalidated bytes now raise `Invalid WebP`.
- **`Empty file` from `imageSizeFromFile` is a `TypeError`**, like every other
  rejection of bad input.
- **A format validator that throws is treated as "not this format"** rather than
  aborting detection for every format behind it. A two byte JXL codestream used
  to be reported with the truncation complaint of an unrelated parser.
- `PNG.validate` no longer throws `Invalid PNG`; the same error now comes from
  `PNG.calculate`. Callers of `imageSize` see no difference. This only matters
  if you import `lib/types/png` directly.

### Known limitations

Four things were looked at and left alone, none of them a crash or a leak.

SVG detection only looks at the first 1000 bytes, so a valid SVG preceded by a
longer comment or doctype is reported as an unsupported file type
([#397](https://codeberg.org/image-size/image-size/issues/397),
[#410](https://codeberg.org/image-size/image-size/issues/410)). Widening that
window is a detection question rather than a safety one, and it belongs with
the scanner rewrite proposed in
[#448](https://codeberg.org/image-size/image-size/pulls/448).

TGA validation accepts six near-empty bytes, so unrelated data can be detected
as a TGA and measured. The format has no magic number to check, and any
tightening would be a heuristic.

J2C reads its `SIZ` segment at a fixed offset after `SOC` rather than walking
the markers, so an unusual layout yields wrong dimensions. They stay bounded
and positive, so nothing downstream breaks.

A PNM header using CRLF line endings is rejected, because the parser assumes a
single byte separates the signature from the first line. This is unchanged
from 2.x.
