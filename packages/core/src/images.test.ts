import { describe, expect, it } from 'vitest';
import { extensionFor, MAX_IMAGE_BYTES, sniffImageType } from './images.js';

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const webp = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('sniffImageType', () => {
  it('reads the three formats it accepts', () => {
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  /**
   * The whole reason this function exists rather than trusting a header. A
   * document served back under the type its uploader claimed would run in
   * somebody's browser on our own origin.
   */
  it('refuses an HTML document however it was announced', () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    expect(sniffImageType(html)).toBeNull();
  });

  it('refuses SVG, which is a document that can carry script', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffImageType(svg)).toBeNull();
  });

  it('refuses a RIFF container that is not WEBP', () => {
    const wav = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it('refuses a file too short to identify rather than guessing', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  /* A real JPEG that happens to be named .png is still a JPEG, and storing
   * it under the truth is what keeps the served type honest. */
  it('does not care what anybody called the file', () => {
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
  });
});

describe('extensionFor', () => {
  it('gives each type the extension a key should carry', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/webp')).toBe('webp');
  });
});

describe('MAX_IMAGE_BYTES', () => {
  it('is two megabytes', () => {
    expect(MAX_IMAGE_BYTES).toBe(2_097_152);
  });
});
