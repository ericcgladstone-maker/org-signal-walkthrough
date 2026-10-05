// Plain-text body of an iMessage `attributedBody` blob.
//
// On recent macOS the `message.text` column is often NULL and the body lives
// only in `attributedBody`, an NSArchiver *typedstream* (not a plist) holding an
// NSAttributedString. This is the heuristic decoder from docs/formats/imessage.md:
//   - the blob starts with "\x04\x0bstreamtyped";
//   - find the first "NSString" class marker;
//   - a few bytes later comes 0x2B ('+');
//   - then a length: one byte if < 0x81, 0x81 -> uint16 LE follows,
//     0x82 -> uint32 LE follows;
//   - then that many UTF-8 bytes: the message body.
// Formatting runs, mentions and multi-part ranges are ignored; the text is all
// Org Signal needs. A full port of crabstep would be needed for fidelity.

const MARKER = new TextEncoder().encode('NSString');
const HEADER = new TextEncoder().encode('streamtyped');
const utf8 = new TextDecoder('utf-8');

function indexOfSub(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// Returns the decoded string, or null when the blob does not have the expected shape.
export function decodeAttributedBody(u8) {
  if (!u8 || !u8.length) return null;
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  // The header sits within the first few bytes ("\x04\x0bstreamtyped"); tolerate its
  // absence but require the NSString marker.
  if (indexOfSub(u8.subarray(0, 32), HEADER) < 0 && indexOfSub(u8, MARKER) < 0) return null;
  let i = indexOfSub(u8, MARKER);
  if (i < 0) return null;
  i += MARKER.length;
  // "A few bytes later": bound the search so a malformed blob cannot make us read
  // an arbitrary later '+' as the length marker.
  const limit = Math.min(u8.length, i + 16);
  while (i < limit && u8[i] !== 0x2b) i++;
  if (i >= limit) return null;
  i++;
  if (i >= u8.length) return null;
  let len = u8[i++];
  if (len === 0x81) {
    if (i + 2 > u8.length) return null;
    len = u8[i] | (u8[i + 1] << 8); i += 2;
  } else if (len === 0x82) {
    if (i + 4 > u8.length) return null;
    len = new DataView(u8.buffer, u8.byteOffset + i, 4).getUint32(0, true); i += 4;
  }
  if (i + len > u8.length) return null;
  return utf8.decode(u8.subarray(i, i + len));
}
