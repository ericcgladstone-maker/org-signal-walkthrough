// Random-access zip reader over a Blob (browser File, or Node's fs.openAsBlob).
//
// Reads only the central directory up front, then slices and inflates single
// entries on demand, so a multi-gigabyte export never has to fit in memory.
// Supports stored and deflate entries and Zip64. Inflation uses the platform's
// DecompressionStream('deflate-raw') (browsers, Node 20+).

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

async function readBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function u64(dv, o) {
  const lo = dv.getUint32(o, true), hi = dv.getUint32(o + 4, true);
  return hi * 2 ** 32 + lo;
}

export async function isZip(blob) {
  if (blob.size < 22) return false;
  const head = await readBytes(blob, 0, 4);
  return new DataView(head.buffer).getUint32(0, true) === SIG_LFH;
}

export async function openZip(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 22 + 65535 + 20);
  const tail = await readBytes(blob, size - tailLen, size);
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file, or the zip is truncated (no end-of-directory record).');

  let total = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== SIG_LOC64) throw new Error('Zip64 archive without a Zip64 locator.');
    const z64off = u64(dv, loc + 8);
    const z = await readBytes(blob, z64off, z64off + 56);
    const zdv = new DataView(z.buffer);
    if (zdv.getUint32(0, true) !== SIG_EOCD64) throw new Error('Corrupt Zip64 end-of-directory record.');
    total = u64(zdv, 32);
    cdSize = u64(zdv, 40);
    cdOffset = u64(zdv, 48);
  }

  const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
  const cdv = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let n = 0; n < total && p + 46 <= cd.length; n++) {
    if (cdv.getUint32(p, true) !== SIG_CDH) throw new Error('Corrupt zip central directory.');
    const flags = cdv.getUint16(p + 8, true);
    const method = cdv.getUint16(p + 10, true);
    const crc = cdv.getUint32(p + 16, true);
    let compSize = cdv.getUint32(p + 20, true);
    let size = cdv.getUint32(p + 24, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    let localOffset = cdv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? utf8.decode(nameBytes) : decodeName(nameBytes);
    // Zip64 extra field: present values replace the 0xFFFFFFFF placeholders, in this order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cdv.getUint16(e, true), len = cdv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cdv, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cdv, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cdv, q); q += 8; }
      }
      e += 4 + len;
    }
    entries.push(makeEntry(blob, { path: name, method, crc, compSize, size, localOffset, encrypted: !!(flags & 1) }));
    p = eEnd + commentLen;
  }
  return entries;
}

// Names without the UTF-8 flag are nominally CP437. In practice exporters
// often write UTF-8 without setting the flag, so try UTF-8 first.
function decodeName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return latin1.decode(bytes); }
}

function makeEntry(blob, z) {
  const isDir = z.path.endsWith('/');
  async function dataStart() {
    const h = await readBytes(blob, z.localOffset, z.localOffset + 30);
    const hdv = new DataView(h.buffer);
    if (hdv.getUint32(0, true) !== SIG_LFH) throw new Error(`Corrupt local header for ${z.path}`);
    return z.localOffset + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
  }
  function check() {
    if (z.encrypted) throw new Error(`${z.path} is encrypted; password-protected zips are not supported.`);
    if (z.method !== 0 && z.method !== 8) throw new Error(`${z.path} uses compression method ${z.method}, which is not supported (only stored and deflate).`);
  }
  return {
    path: z.path,
    size: z.size,
    compressedSize: z.compSize,
    crc: z.crc,
    // Password-protected entry (general-purpose bit 0): listed, never readable.
    encrypted: z.encrypted,
    isDir,
    // A ReadableStream of decompressed Uint8Array chunks.
    stream() {
      check();
      const raw = new ReadableStream({
        async start(controller) {
          const start = await dataStart();
          const reader = blob.slice(start, start + z.compSize).stream().getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        },
      });
      return z.method === 8 ? raw.pipeThrough(new DecompressionStream('deflate-raw')) : raw;
    },
    async bytes() {
      check();
      const start = await dataStart();
      if (z.method === 0) return readBytes(blob, start, start + z.compSize);
      return new Uint8Array(await new Response(this.stream()).arrayBuffer());
    },
    async text() { return decodeText(await this.bytes()); },
  };
}

// UTF-8 with BOM stripped; UTF-16 when a UTF-16 BOM is present.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  return utf8.decode(bytes);
}
