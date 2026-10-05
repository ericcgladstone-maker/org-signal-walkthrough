// Minimal XML reader for network files (GraphML, GEXF) that runs in Node and
// in workers, where DOMParser does not exist.
//
// Safety: DOCTYPE declarations are skipped entirely and only the five
// predefined entities plus numeric character references are expanded, so
// entity-expansion attacks ("billion laughs") and external entities cannot
// fire. It is not a validating parser; it accepts well-formed XML and reports
// structural errors (mismatched or unclosed tags) instead of guessing.
//
// Two layers:
//   XmlSax     push parser. write(chunk) as often as needed, then end().
//              Emits open(el), close(el), text(str) callbacks. Holds only the
//              unfinished tail of the input, so files can be streamed.
//   parseXml   whole-string convenience that returns a small element tree:
//              { name, local, prefix, ns, attrs, children[], text }

const PREDEF = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Out-of-range or surrogate code points are left as written rather than throwing.
      if (!(cp >= 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
    return PREDEF[e] ?? m; // unknown named entity: keep literal text
  });
}

// Attribute string -> [[qname, value], ...]
function parseAttrs(s, where) {
  const out = [];
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m, last = 0;
  while ((m = re.exec(s))) {
    if (s.slice(last, m.index).trim()) throw new Error(`Malformed attribute near "${s.slice(last, m.index).trim().slice(0, 30)}" in <${where}>`);
    // Attribute-value normalisation applies to literal whitespace only, before
    // references are expanded, so &#10; survives as a newline (XML 1.0 3.3.3).
    out.push([m[1], decodeEntities((m[3] ?? m[4]).replace(/[\t\n\r]/g, ' '))]);
    last = re.lastIndex;
  }
  if (s.slice(last).replace(/\/\s*$/, '').trim()) throw new Error(`Malformed attribute near "${s.slice(last).trim().slice(0, 30)}" in <${where}>`);
  return out;
}

export class XmlSax {
  constructor({ open, close, text } = {}) {
    this.onOpen = open || (() => {});
    this.onClose = close || (() => {});
    this.onText = text || (() => {});
    this.buf = '';
    this.stack = []; // { name, local, prefix, ns, attrs, nsMap }
    this.nsStack = [{ xml: 'http://www.w3.org/XML/1998/namespace', '': '' }];
    this.sawRoot = false;
    this.ended = false;
  }

  write(chunk) {
    this.buf += chunk;
    this._drain(false);
  }

  end() {
    this._drain(true);
    if (this.buf.trim()) throw new Error('Unexpected end of XML input (unterminated markup).');
    if (this.stack.length) throw new Error(`Unexpected end of XML: <${this.stack[this.stack.length - 1].name}> is not closed.`);
    if (!this.sawRoot) throw new Error('No XML root element found.');
    this.ended = true;
  }

  _drain(final) {
    let b = this.buf, p = 0;
    for (;;) {
      const lt = b.indexOf('<', p);
      if (lt < 0) {
        // Text up to the end. Keep a possibly incomplete entity for the next chunk.
        if (final) { this._text(b.slice(p)); p = b.length; }
        else {
          const amp = b.lastIndexOf('&');
          const cut = amp >= p && b.indexOf(';', amp) < 0 ? amp : b.length;
          this._text(b.slice(p, cut)); p = cut;
        }
        break;
      }
      if (lt > p) this._text(b.slice(p, lt));
      p = lt;
      let end;
      if (b.startsWith('<!--', p)) {
        end = b.indexOf('-->', p + 4); if (end < 0) break; p = end + 3; continue;
      }
      if (b.startsWith('<![CDATA[', p)) {
        end = b.indexOf(']]>', p + 9); if (end < 0) break;
        this._rawText(b.slice(p + 9, end)); p = end + 3; continue;
      }
      if (b.startsWith('<?', p)) {
        end = b.indexOf('?>', p + 2); if (end < 0) break; p = end + 2; continue;
      }
      if (b.startsWith('<!', p)) {
        // DOCTYPE, possibly with an internal subset in [...]. Skipped, never expanded.
        end = skipDoctype(b, p); if (end < 0) break; p = end; continue;
      }
      end = tagEnd(b, p + 1); if (end < 0) break;
      const inner = b.slice(p + 1, end);
      p = end + 1;
      if (inner[0] === '/') this._close(inner.slice(1).trim());
      else this._open(inner);
    }
    this.buf = b.slice(p);
  }

  _text(s) {
    if (!s) return;
    if (!this.stack.length) {
      if (s.trim()) throw new Error('Text outside the XML root element.');
      return;
    }
    this.onText(decodeEntities(s));
  }

  _rawText(s) { if (s && this.stack.length) this.onText(s); }

  _open(inner) {
    const selfClose = /\/\s*$/.test(inner);
    const body = selfClose ? inner.replace(/\/\s*$/, '') : inner;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new Error('Malformed XML tag.');
    const qname = m[1];
    if (!this.stack.length && this.sawRoot) throw new Error('More than one root element in XML.');
    this.sawRoot = true;
    const raw = parseAttrs(body.slice(qname.length), qname);
    const parentNs = this.nsStack[this.nsStack.length - 1];
    let nsMap = parentNs;
    for (const [k, v] of raw) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) {
        if (nsMap === parentNs) nsMap = { ...parentNs };
        nsMap[k === 'xmlns' ? '' : k.slice(6)] = v;
      }
    }
    const attrs = {};
    for (const [k, v] of raw) attrs[k] = v;
    const [prefix, local] = splitQ(qname);
    const el = { name: qname, local, prefix, ns: nsMap[prefix] ?? '', attrs, nsMap };
    this.stack.push(el);
    this.nsStack.push(nsMap);
    this.onOpen(el);
    if (selfClose) this._close(qname);
  }

  _close(qname) {
    const top = this.stack.pop();
    if (!top) throw new Error(`Unexpected closing tag </${qname}>.`);
    if (top.name !== qname) throw new Error(`Mismatched XML tags: <${top.name}> closed by </${qname}>.`);
    this.nsStack.pop();
    this.onClose(top);
  }
}

function splitQ(q) {
  const i = q.indexOf(':');
  return i < 0 ? ['', q] : [q.slice(0, i), q.slice(i + 1)];
}

// Index of the '>' that ends a tag starting after '<', honouring quoted attribute values.
function tagEnd(b, p) {
  let q = 0;
  for (let i = p; i < b.length; i++) {
    const c = b.charCodeAt(i);
    if (q) { if (c === q) q = 0; }
    else if (c === 34 || c === 39) q = c;
    else if (c === 62) return i;
  }
  return -1;
}

function skipDoctype(b, p) {
  let depth = 0, q = 0;
  for (let i = p + 2; i < b.length; i++) {
    const c = b[i];
    if (q) { if (c === q) q = 0; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return -1;
}

// Parse a whole document into a tree. Text is concatenated per element
// (mixed content is rare in network files; child text is not included).
export function parseXml(str) {
  let root = null;
  const stack = [];
  const sax = new XmlSax({
    open(el) {
      const node = { name: el.name, local: el.local, prefix: el.prefix, ns: el.ns, attrs: el.attrs, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].children.push(node); else root = node;
      stack.push(node);
    },
    close() { stack.pop(); },
    text(t) { stack[stack.length - 1].text += t; },
  });
  sax.write(str.replace(/^﻿/, ''));
  sax.end();
  return root;
}

// Tree helpers that ignore namespace prefixes (files vary in how they declare them).
export function kids(node, local) { return node.children.filter(c => c.local === local); }
export function kid(node, local) { return node.children.find(c => c.local === local) ?? null; }
export function* descend(node, local) {
  for (const c of node.children) { if (c.local === local) yield c; yield* descend(c, local); }
}

// Attribute by local name, ignoring any prefix (e.g. nc:caseId -> caseId).
export function attrLocal(node, local) {
  if (local in node.attrs) return node.attrs[local];
  for (const [k, v] of Object.entries(node.attrs)) if (k.endsWith(':' + local) && !k.startsWith('xmlns')) return v;
  return undefined;
}

// Root element name and namespace from the first few KB, for detect().
export function sniffRoot(head) {
  const s = head.replace(/^﻿/, '');
  const re = /<([^\s!?/>][^\s/>]*)([^>]*)>?/g;
  let m;
  // Skip declarations, comments and doctype by only matching tags that start with a name char.
  while ((m = re.exec(s))) {
    const before = s.slice(0, m.index);
    if ((before.match(/<!--/g) || []).length > (before.match(/-->/g) || []).length) continue;
    const [prefix, local] = splitQ(m[1]);
    const attrs = m[2] || '';
    const nsRe = new RegExp(`xmlns${prefix ? ':' + prefix.replace(/[^\w.-]/g, '') : ''}\\s*=\\s*["']([^"']*)["']`);
    const ns = (nsRe.exec(attrs) || [])[1] || '';
    return { local, prefix, ns, attrs };
  }
  return null;
}

// Escaping for writers.
// XML 1.0 forbids most C0 controls even as character references; chat text often has them.
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function xmlEscape(v) {
  return String(v).replace(ILLEGAL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Encoded so they survive attribute-value normalisation (harmless in text content).
    .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
}
