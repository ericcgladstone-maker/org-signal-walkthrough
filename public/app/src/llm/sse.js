// Minimal Server-Sent Events reader over a fetch Response body.
//
// All three providers stream with SSE (event:/data: lines, blank line between
// events). We parse it ourselves instead of using EventSource because
// EventSource cannot POST or send auth headers, and it does not exist in Node.
// Follows the WHATWG rules that matter here: \n, \r\n or \r line endings,
// multi-line data joined with \n, ':' comment lines ignored, one optional space
// after the field colon.

export async function* readSSE(body, { signal } = {}) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data = [];
  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      // Process every complete line; keep the trailing partial line in buf.
      while ((m = /\r\n|\n|\r/.exec(buf))) {
        // A lone \r at the very end might be the first half of \r\n: wait for more.
        if (m[0] === '\r' && m.index === buf.length - 1) break;
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = ''; data = [];
          continue;
        }
        if (line[0] === ':') continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let val = c < 0 ? '' : line.slice(c + 1);
        if (val[0] === ' ') val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
    }
    buf += decoder.decode();
    if (buf && buf !== '\r') {
      for (const line of buf.split(/\r\n|\n|\r/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
    }
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// Build a Response-like body from a string, for tests and fixtures. Splits the
// text into small chunks so the parser's line-boundary handling is exercised.
export function streamFromString(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= bytes.length) { ctrl.close(); return; }
      ctrl.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}
