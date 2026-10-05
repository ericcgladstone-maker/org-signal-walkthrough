// Platform identities: how each synthetic person appears in a given medium
// (Slack user id, email address, X account id, Discord snowflake ...), and the
// dataset node key an importer would most likely give them. Native writers and
// the dataset sink both use these, so a native export re-imported through the
// real importer lands on the same keys where the importer follows its spec.

import { slug, ascii } from './names.js';

export const KEY_PREFIX = {
  slack: 'slack', email: 'email', calendar: 'email', x: 'x', bluesky: 'bsky', mastodon: 'mastodon', linkedin: 'linkedin',
  whatsapp: 'whatsapp', imessage: 'imessage', telegram: 'telegram', discord: 'discord', reddit: 'reddit', survey: 'survey', network: 'net',
};

// Snowflake from a time: Discord epoch 2015-01-01, X epoch 2010-11-04.
export function snowflake(t, epoch, rng) {
  const ms = BigInt(Math.max(0, Math.floor(t - epoch)));
  return ((ms << 22n) | BigInt(rng.int(1 << 22))).toString();
}
export const X_EPOCH = 1288834974657;
export const DISCORD_EPOCH = 1420070400000;

export function makeIdentities(world, medium, rng) {
  const r = rng.fork('ids:' + medium);
  const n = world.n;
  const P = world.people;
  const key = new Array(n), label = P.label.slice(), platformIds = new Array(n);
  const used = new Set();
  const uniq = gen => { let v; do { v = gen(); } while (used.has(v)); used.add(v); return v; };
  const id = { medium };
  switch (medium) {
    case 'slack': {
      id.teamId = 'T0' + r.b36(9);
      id.userId = []; id.handle = [];
      const hu = new Set();
      for (let i = 0; i < n; i++) {
        id.userId[i] = uniq(() => (r.chance(0.85) ? 'U0' : 'W0') + r.b36(r.chance(0.7) ? 9 : 8));
        let h = `${ascii(P.first[i])}.${ascii(P.last[i])}`.toLowerCase().replace(/[^a-z0-9.]+/g, '');
        while (hu.has(h)) h += r.int(10);
        hu.add(h); id.handle[i] = h;
        key[i] = 'slack:' + id.userId[i];
        platformIds[i] = { slack: id.userId[i] };
      }
      break;
    }
    case 'email': case 'calendar': {
      for (let i = 0; i < n; i++) { key[i] = 'email:' + P.email[i].toLowerCase(); platformIds[i] = { email: P.email[i] }; }
      break;
    }
    case 'x': case 'bluesky': case 'mastodon': {
      id.accountId = []; id.handle = P.handle || [];
      for (let i = 0; i < n; i++) {
        const h = P.handle[i];
        if (medium === 'x') { id.accountId[i] = uniq(() => r.chance(0.6) ? r.digits(r.intRange(8, 10)) : snowflake(world.span.start - (P.attrs[i].account_age_days || 400) * 86400000, X_EPOCH, r)); key[i] = 'x:' + id.accountId[i]; platformIds[i] = { x: id.accountId[i], handle: h }; }
        else if (medium === 'bluesky') { id.accountId[i] = uniq(() => 'did:plc:' + base32(r, 24)); key[i] = 'bsky:' + id.accountId[i]; platformIds[i] = { did: id.accountId[i], handle: `${h.replace(/[_.]/g, '-')}.pds.example` }; }
        else { id.accountId[i] = `@${h.replace(/\./g, '_')}@${['social.example', 'toot.example', 'fedi.example'][i % 3]}`; key[i] = 'mastodon:' + id.accountId[i].slice(1); platformIds[i] = { mastodon: id.accountId[i] }; }
      }
      break;
    }
    case 'linkedin': {
      id.slug = [];
      for (let i = 0; i < n; i++) {
        id.slug[i] = uniq(() => `${slug(P.first[i])}-${slug(P.last[i])}${r.chance(0.6) ? '-' + r.hex(6) : ''}`);
        id.url = id.url || [];
        id.url[i] = `https://www.linkedin.com/in/${id.slug[i]}`;
        key[i] = 'linkedin:' + id.slug[i];
        platformIds[i] = { linkedin: id.url[i] };
      }
      break;
    }
    case 'whatsapp': {
      // Names as the ego's phone shows them; a few group-only people are unsaved (push name or number).
      id.display = [];
      for (let i = 0; i < n; i++) {
        const unsaved = world.unsaved?.[i];
        id.display[i] = unsaved === 'phone' ? fakePhone(r, i) : unsaved === 'push' ? `~ ${P.first[i]}` : P.label[i];
        // Same key rule as the WhatsApp importer: phone numbers by digits, names lower-cased (NFC).
        key[i] = unsaved === 'phone' ? 'whatsapp:+' + id.display[i].replace(/\D/g, '')
          : 'whatsapp:' + (unsaved === 'push' ? P.first[i] : P.label[i]).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
        platformIds[i] = {};
      }
      break;
    }
    case 'imessage': {
      id.handle = [];
      for (let i = 0; i < n; i++) { id.handle[i] = r.chance(0.6) ? fakePhone(r, i).replace(/[\s()-]/g, '') : `${ascii(P.first[i]).toLowerCase()}${r.int(100)}@icloud.example`; key[i] = 'imessage:' + id.handle[i]; platformIds[i] = { imessage: id.handle[i] }; }
      break;
    }
    case 'telegram': {
      id.userId = [];
      for (let i = 0; i < n; i++) { id.userId[i] = uniq(() => r.digits(r.chance(0.5) ? 9 : 10)); key[i] = 'telegram:user' + id.userId[i]; platformIds[i] = { telegram: 'user' + id.userId[i] }; }
      break;
    }
    case 'discord': {
      id.userId = []; id.handle = [];
      for (let i = 0; i < n; i++) {
        id.userId[i] = uniq(() => snowflake(world.span.start - r.int(5 * 365) * 86400000, DISCORD_EPOCH, r));
        id.handle[i] = (P.handle?.[i] || slug(P.label[i])).replace(/[^a-z0-9_.]/g, '_').slice(0, 32);
        key[i] = 'discord:' + id.userId[i];
        platformIds[i] = { discord: id.userId[i] };
      }
      break;
    }
    case 'reddit': {
      id.username = [];
      for (let i = 0; i < n; i++) { id.username[i] = (P.handle?.[i] || slug(P.label[i])).replace(/[^A-Za-z0-9_-]/g, '_'); key[i] = 'reddit:' + id.username[i]; platformIds[i] = { reddit: id.username[i] }; }
      break;
    }
    case 'survey': {
      // A roster form names people only by name, and the survey importer keys
      // them `survey:<normalised name>`; interview exports keep roster ids.
      const byName = world.recall?.variant === 'roster-matrix';
      id.rosterId = [];
      for (let i = 0; i < n; i++) { id.rosterId[i] = 'R' + String(i + 1).padStart(3, '0'); key[i] = byName ? 'survey:' + normName(P.label[i]) : 'survey:' + id.rosterId[i]; platformIds[i] = {}; }
      break;
    }
    default: {
      for (let i = 0; i < n; i++) { key[i] = 'net:n' + i; platformIds[i] = {}; }
    }
  }
  return { ...id, key, label, platformIds };
}

// Same normalisation as the survey and Network Canvas importers (normName in
// src/importers/network-canvas.js): NFKD, accents dropped, lower case, spaces collapsed.
export function normName(s) {
  return String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function base32(r, n) { const al = 'abcdefghijklmnopqrstuvwxyz234567'; let s = ''; for (let i = 0; i < n; i++) s += al[r.int(32)]; return s; }

// Numbers in reserved fictional ranges (UK Ofcom drama range 07700 900xxx; US 555-01xx).
export function fakePhone(r, i) {
  if (i % 2) return `+44 7700 900${String(r.int(1000)).padStart(3, '0')}`;
  return `+1 (555) 01${String(r.int(100)).padStart(2, '0')}`;
}
