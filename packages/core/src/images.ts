/**
 * What a photo actually is, decided by reading it.
 *
 * A merchant uploading a product photo sends `Content-Type` along with it,
 * and that header is whatever their browser guessed from a filename. It is
 * not evidence. A file called `rice.jpg` that is actually an HTML document
 * would be stored, served back with the type its uploader claimed, and run
 * in somebody's browser on our origin; a file that is genuinely a JPEG stays
 * a JPEG whatever it is called.
 *
 * So the type comes from the first few bytes, which is the one part of an
 * image an uploader cannot lie about without ceasing to be one.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Three formats and no more.
 *
 * SVG is deliberately absent, and it is the important omission: it is a
 * document, not a raster, and it can carry script that runs when a browser
 * renders it. A product photo has no use for that, so allowing it would be
 * accepting a stored cross-site scripting vector in exchange for nothing.
 * GIF and AVIF are absent for a duller reason: nobody has asked.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  /* RIFF....WEBP: the four-byte length between them is the file's own, so
   * bytes 4 to 7 are skipped rather than matched. */
  if (
    starts(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

/**
 * The most a product photo may weigh.
 *
 * Two megabytes is generous for something rendered at a few hundred pixels
 * and small enough that a merchant on a Lagos mobile connection can send one
 * without watching a progress bar. It is also the ceiling that stops one
 * shop's uploads becoming everybody's storage bill.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** The extension to store it under, so the key says what it holds. */
export function extensionFor(type: ImageType): string {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  return 'webp';
}
