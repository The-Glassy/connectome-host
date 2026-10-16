/**
 * Images an operator attaches to a WebUI message, checked before they reach
 * the store.
 *
 * A stored image the model API refuses is not a one-off failure: it rides in
 * every later request on the branch, so each inference fails until someone
 * rolls the message back. So the host checks what the API checks — format by
 * the bytes, size, and pixel dimensions — and refuses the message with a
 * reason instead of storing it. The SPA fits images to the same limits before
 * sending; this is the check for every other client.
 */

import type { ContentBlock } from '@animalabs/agent-framework';
import { USER_IMAGE_LIMITS, type UserMessageImage } from './protocol.js';

export type UserImageCheck =
  | { ok: true; blocks: ContentBlock[] }
  | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Turn composer images into image content blocks, or say why not. Each
 * block's media type is the one its bytes show; a declared type that
 * disagrees (a JPEG saved as .png) is corrected rather than refused.
 */
export function userImageBlocks(images: ReadonlyArray<UserMessageImage>): UserImageCheck {
  const L = USER_IMAGE_LIMITS;
  if (images.length > L.maxCount) {
    return { ok: false, error: `${images.length} images attached; a message takes at most ${L.maxCount}` };
  }
  let total = 0;
  const blocks: ContentBlock[] = [];
  for (const [i, img] of images.entries()) {
    const which = images.length === 1 ? 'the image' : `image ${i + 1}`;
    const data = img.data;
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
      return { ok: false, error: `${which} is not valid base64` };
    }
    if (data.length > L.maxBase64Chars) {
      return { ok: false, error: `${which} is ${mb(data.length)} as base64, over the ${mb(L.maxBase64Chars)} limit` };
    }
    total += data.length;
    if (total > L.maxTotalBase64Chars) {
      return { ok: false, error: `the images come to more than ${mb(L.maxTotalBase64Chars)} as base64, the most one message carries` };
    }
    const bytes = Buffer.from(data, 'base64');
    const mediaType = sniffImageType(bytes);
    if (!mediaType) {
      return { ok: false, error: `${which} is not a PNG, JPEG, GIF or WebP image` };
    }
    const size = imageSize(bytes, mediaType);
    if (!size) {
      return { ok: false, error: `${which} looks like ${mediaType} but its dimensions can't be read` };
    }
    if (size.width > L.maxSidePx || size.height > L.maxSidePx) {
      return { ok: false, error: `${which} is ${size.width}×${size.height}; the model API takes at most ${L.maxSidePx} px on a side` };
    }
    blocks.push({ type: 'image', source: { type: 'base64', data, mediaType } });
  }
  return { ok: true, blocks };
}

function mb(chars: number): string {
  return `${(chars / 1_000_000).toFixed(1)} MB`;
}

/** The image format the leading bytes show, among those the model APIs take. */
export function sniffImageType(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

/** Pixel dimensions from the image header; null when the header is cut short
 *  or isn't the layout its format promises. */
export function imageSize(b: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const be16 = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const le16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  const le24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  const be32 = (o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  switch (mediaType) {
    case 'image/png':
      // 8-byte signature, then the IHDR chunk: length, 'IHDR', width, height.
      if (b.length < 24 || tag(12) !== 'IHDR') return null;
      return { width: be32(16), height: be32(20) };
    case 'image/gif':
      if (b.length < 10) return null;
      return { width: le16(6), height: le16(8) };
    case 'image/webp': {
      if (b.length < 30) return null;
      const chunk = tag(12);
      if (chunk === 'VP8 ') {
        // Lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit sizes.
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        // Lossless: signature 0x2f, then width-1 and height-1 as 14 bits each.
        if (b[20] !== 0x2f) return null;
        const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        // Extended: canvas width-1 and height-1 as 24 bits each.
        return { width: le24(24) + 1, height: le24(27) + 1 };
      }
      return null;
    }
    case 'image/jpeg': {
      // Walk the marker segments to the first start-of-frame.
      let o = 2;
      while (o + 4 <= b.length) {
        if (b[o] !== 0xff) return null;
        const marker = b[o + 1]!;
        if (marker === 0xff) { o++; continue; } // fill byte
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; } // no length
        if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan before any frame
        const len = be16(o + 2);
        if (len < 2) return null;
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
          if (o + 9 > b.length) return null;
          return { width: be16(o + 7), height: be16(o + 5) };
        }
        o += 2 + len;
      }
      return null;
    }
    default:
      return null;
  }
}
