// Facebook Messenger and Instagram DMs from Meta's "Download/Export your
// information" (JSON), plus the Messenger end-to-end-encrypted chat backup.
// Spec: docs/formats/meta-messenger-instagram.md.
//
// Meta gives display names only, no ids, so people are keyed by normalised
// name (nameKey) and the import says so. Standard exports carry the latin-1
// mojibake bug; every string is repaired with fixMojibakeDeep (idempotent, so
// it is also run on the E2EE backup, which is reported to be correct UTF-8).

import { parseJSON } from './lib/json.js';
import { fixMojibakeDeep, nameKey } from './lib/text.js';
import { peek } from '../core/fileset.js';
import { UploadError } from '../core/upload.js';

const SECTIONS = ['inbox', 'archived_threads', 'filtered_threads', 'message_requests', 'e2ee_cutover'];
// <prefix>messages/<section>/<thread folder>/message_<N>.json  (spec section 2)
const THREAD_RE = /(?:^|\/)messages\/(inbox|archived_threads|filtered_threads|message_requests|e2ee_cutover)\/([^/]+)\/message_(\d+)\.json$/i;
const HTML_RE = /(?:^|\/)messages\/(?:inbox|archived_threads|filtered_threads|message_requests|e2ee_cutover)\/[^/]+\/message_\d+\.html$/i;
// E2EE backup: flat "<Thread name>_<N>.json" files (spec section 2 / 3.2).
const E2EE_NAME_RE = /(?:^|\/)([^/]+)_(\d+)\.json$/;

// Deactivated accounts share one placeholder name, so they must not be merged
// into one person (exact labels are UNVERIFIED in the spec; match loosely).
const DEACTIVATED_RE = /^(facebook|instagram) ?user$/i;

function platformOf(rel) {
  const p = rel.toLowerCase();
  if (p.includes('your_instagram_activity/')) return 'instagram';
  if (p.includes('your_facebook_activity/') || p.includes('your_activity_across_facebook/')) return 'messenger';
  return null; // bare messages/inbox: ambiguous (spec section 8)
}

function classify(fs) {
  const standard = [];
  const html = [];
  const candidates = [];
  for (const e of fs.entries) {
    // FileSet.rel drops a shared top folder, which may be the messages/ folder
    // itself when the user drops it alone, so also test the full path.
    const m = THREAD_RE.exec(e.rel) || THREAD_RE.exec(e.path);
    if (m) { standard.push({ entry: e, section: m[1].toLowerCase(), folder: m[2], part: +m[3], platform: platformOf(e.path) }); continue; }
    if (HTML_RE.test(e.rel) || HTML_RE.test(e.path)) { html.push(e); continue; }
    if (/\.json$/i.test(e.rel) && E2EE_NAME_RE.test(e.rel)) candidates.push(e);
  }
  return { standard, html, candidates };
}

// Other files of a Meta "Download your information" export, for an export
// requested without Messages (followers, profile, posts only).
const META_EXPORT_RE = /(?:^|\/)(?:your_instagram_activity|your_facebook_activity|your_activity_across_facebook|connections\/followers_and_following|personal_information\/personal_information|logged_information|ads_information|security_and_login_information)\//i;

function platformWord(fs) {
  const p = fs.entries.map(e => e.path.toLowerCase()).join('\n') + '\n' + (fs.names || []).join('\n').toLowerCase();
  if (/instagram/.test(p)) return 'Instagram';
  if (/facebook/.test(p)) return 'Facebook';
  return 'Meta';
}

const JSON_STEPS = 'Accounts Center > Your information and permissions > Export your information > Create export > Export to device > Customize information: Messages; Format: JSON';

function htmlError(fs, nHtml) {
  return new UploadError('meta-html-format', `This ${platformWord(fs)} export is in HTML format (${nHtml} message_N.html file${nHtml === 1 ? '' : 's'}), which cannot be read: Meta's HTML pages change layout often and carry no reliable structure. Request a new export in JSON format (${JSON_STEPS}).`);
}

// One export delivered as several zips shares the name stem
// facebook-<user>-<date> / instagram-<user>-<date> (spec section 1a; the
// random suffix differs per part).
async function partKey(fs, { root } = {}) {
  const m = /^(facebook|instagram)-(.+)-(\d{4}-\d{2}-\d{2})-[A-Za-z0-9]+\/?$/i.exec(String(root || ''));
  return m ? `meta:${m[1].toLowerCase()}:${m[2].toLowerCase()}:${m[3]}` : null;
}

function looksE2EE(head) {
  return /"threadName"\s*:/.test(head) && /"participants"\s*:\s*\[\s*("|\])/.test(head);
}

async function detect(fs) {
  const { standard, html, candidates } = classify(fs);
  if (standard.length) {
    const head = await peek(standard[0].entry, 4096);
    if (/"participants"\s*:/.test(head) || /"messages"\s*:/.test(head)) return { score: 0.95, reason: `Meta message export (${standard.length} thread files)` };
  }
  for (const e of candidates.slice(0, 20)) {
    if (looksE2EE(await peek(e, 4096))) return { score: 0.9, reason: 'Messenger end-to-end-encrypted chat backup' };
  }
  if (html.length) return { score: 0.6, reason: 'Meta message export in HTML format (needs a JSON re-export)' };
  // A Meta export without its messages folder: claim it, so the import can
  // say what is missing instead of no importer recognizing it.
  const other = fs.entries.filter(e => META_EXPORT_RE.test(e.rel) || META_EXPORT_RE.test(e.path));
  if (other.length) return { score: 0.6, reason: `${platformWord(fs)} data export without messages`, files: other.map(e => e.rel) };
  return { score: 0 };
}

async function importMeta(fs, { builder, options = {}, progress, signal } = {}) {
  const { standard, html, candidates } = classify(fs);
  const e2ee = [];
  for (const e of candidates) if (looksE2EE(await peek(e, 4096))) e2ee.push(e);
  if (!standard.length && !e2ee.length) {
    if (html.length) throw htmlError(fs, html.length);
    const word = platformWord(fs);
    throw new UploadError('meta-no-messages', `This ${word} export has no messages folder (${word === 'Instagram' ? 'your_instagram_activity/messages/inbox' : 'your_activity_across_facebook/messages/inbox'}), so it holds no conversations: Messages was not selected when the export was requested. Followers and other lists are not read. Request a new export with Messages selected (${JSON_STEPS}).`);
  }
  const includeRequests = options.includeRequests ?? false;
  const platformOpt = options.platform ?? 'auto';
  const egoOpt = options.egoName ? String(options.egoName) : '';

  // ---- load and group threads by platform ----
  // threads: { platform, id, section, files[], data parts[], e2ee }
  const byPlatform = { messenger: new Map(), instagram: new Map() };
  let ambiguous = false;
  let skippedSections = 0;
  for (const s of standard) {
    if (!includeRequests && (s.section === 'message_requests' || s.section === 'filtered_threads')) { skippedSections++; continue; }
    let platform = platformOpt !== 'auto' ? platformOpt : s.platform;
    if (!platform) { platform = 'messenger'; ambiguous = true; }
    const map = byPlatform[platform] || byPlatform.messenger;
    // The thread folder name is the conversation id (spec section 2). The same
    // folder can appear in inbox and e2ee_cutover; both then share one context.
    const t = map.get(s.folder) || { id: s.folder, files: [], e2ee: false, sections: new Set() };
    t.files.push(s);
    t.sections.add(s.section);
    map.set(s.folder, t);
  }
  for (const e of e2ee) {
    const id = e.rel.split('/').pop().replace(/\.json$/i, '');
    byPlatform.messenger.set(`e2ee:${id}`, { id, files: [{ entry: e, part: 1 }], e2ee: true, sections: new Set(['e2ee']) });
  }

  const totalFiles = standard.length + e2ee.length;
  let done = 0;
  for (const platform of ['messenger', 'instagram']) {
    const threads = byPlatform[platform];
    if (!threads.size) continue;
    const fileNames = [...threads.values()].flatMap(t => t.files.map(f => f.entry.rel));
    builder.beginSource({ format: 'meta', family: 'personal', medium: platform, view: 'ego', context: 'personal', tz: 'UTC', fileNames, egoKey: null });
    const ns = platform;
    builder.warn('identity-by-name', 'Meta exports give display names only (no account ids), so people are identified by name. Two people with the same name are merged; a person who renamed appears under the current name.');
    if (ambiguous && platformOpt === 'auto') builder.warn('platform-ambiguous', 'The export uses the old messages/inbox layout, which looks the same for Facebook and Instagram. It was read as Messenger; set the "Platform" option if it is Instagram.');
    if (skippedSections) builder.warn('requests-excluded', 'Message requests and filtered threads were skipped. Turn on "Include message requests" to import them.', skippedSections);
    // Threads in HTML beside JSON ones: a second export made with Format: HTML.
    if (html.length) builder.warn('meta-html-skipped', `${html.length} conversation file${html.length === 1 ? ' is' : 's are'} in HTML (message_N.html, from an export made with Format: HTML) and ${html.length === 1 ? 'was' : 'were'} not read; only the JSON conversations are in the network. To include them, request that export again in JSON format (${JSON_STEPS}).`, html.length);
    // Long threads are split newest-first into message_1.json, message_2.json, ...;
    // a gap means a zip of a multi-part export was not loaded.
    const cut = [...threads.values()].filter(t => !t.e2ee && gapIn(t.files.map(f => f.part)));
    if (cut.length) builder.warn('meta-thread-part-missing', `${cut.length} conversation${cut.length === 1 ? ' is' : 's are'} missing ${cut.length === 1 ? 'one of its' : 'some of their'} files (message_1.json holds the newest messages, message_2.json and on go back in time). Meta splits a large export into several zips, and a thread can be cut across them. Load all the zips of the export together.`, cut.length);

    // Parse every thread first: the ego is the participant common to all threads.
    const parsed = [];
    for (const t of threads.values()) {
      signal?.throwIfAborted();
      t.files.sort((a, b) => a.part - b.part);
      let title = null, participants = [], msgs = [], threadType = null, still = null;
      for (const f of t.files) {
        let doc;
        try { doc = fixMojibakeDeep(parseJSON(await f.entry.text())); }
        catch (err) { builder.warn('bad-json', `A message file could not be read as JSON (${f.entry.rel}: ${err.message}).`); continue; }
        done++;
        progress?.(0.8 * done / totalFiles, 'Reading Meta message files');
        if (t.e2ee) {
          title = doc.threadName ?? title;
          participants = (doc.participants || []).map(p => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
          for (const m of doc.messages || []) msgs.push({
            sender: m.senderName, t: Number(m.timestamp), text: m.text || null, type: m.type || 'Generic',
            unsent: !!m.isUnsent, reactions: m.reactions || [], users: null,
          });
        } else {
          title = doc.title ?? title;
          if (Array.isArray(doc.participants)) participants = doc.participants.map(p => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
          threadType = doc.thread_type ?? threadType;
          if (doc.is_still_participant !== undefined) still = doc.is_still_participant;
          for (const m of doc.messages || []) msgs.push({
            sender: m.sender_name, t: Number(m.timestamp_ms), text: m.content ?? null, type: m.type || 'Generic',
            unsent: !!m.is_unsent, reactions: m.reactions || [], users: Array.isArray(m.users) ? m.users.map(u => u?.name).filter(Boolean) : null,
            share: m.share, callDuration: m.call_duration, missed: m.missed,
          });
        }
      }
      // Standard files are newest-first and message_1 is the newest file, so the
      // concatenation is newest-first overall; reversing gives chronological
      // order, and a stable sort fixes anything out of place (E2EE order is
      // unspecified).
      if (!t.e2ee) msgs.reverse();
      msgs.sort((a, b) => (a.t || 0) - (b.t || 0));
      parsed.push({ t, title, participants, msgs, threadType, still });
    }

    // ---- ego ----
    let egoName = null;
    if (egoOpt) egoName = nameKey(egoOpt);
    else {
      const sets = parsed.filter(p => p.participants.length).map(p => new Set(p.participants.map(nameKey)));
      if (sets.length >= 2) {
        const common = [...sets[0]].filter(k => sets.every(s => s.has(k)));
        if (common.length === 1) egoName = common[0];
      }
    }
    let ego = -1;
    if (egoName) {
      const label = parsed.flatMap(p => p.participants).find(n => nameKey(n) === egoName) || egoOpt || egoName;
      ego = builder.node(`${ns}:${egoName}`, { label, attrs: { meta_ego: true } });
      builder.source.egoKey = `${ns}:${egoName}`;
    } else {
      builder.warn('ego-unknown', 'The account owner could not be identified (no single name appears in every thread). Set "Your name as shown in Messenger/Instagram" to mark direct messages correctly.');
    }

    // ---- events ----
    const seen = new Set(); // dedupe across standard + E2EE: (sender, ms, text)
    let latest = -Infinity;
    for (const p of parsed) {
      const { t } = p;
      const person = (name, thread) => {
        const k = nameKey(name);
        if (!k) return -1;
        if (DEACTIVATED_RE.test(k.replace(/\s+/g, ' '))) {
          builder.warn('deactivated-users', 'Deactivated accounts share a placeholder name; each thread\'s placeholder is kept as a separate person.');
          return builder.node(`${ns}:deactivated:${thread}`, { label: name, attrs: { deactivated: true } });
        }
        return builder.node(`${ns}:${k}`, { label: name });
      };
      const memberIdx = new Set();
      for (const n of p.participants) { const i = person(n, t.id); if (i >= 0) memberIdx.add(i); }
      for (const m of p.msgs) { const i = person(m.sender, t.id); if (i >= 0) memberIdx.add(i); }
      // People who left can be missing from participants while their messages
      // remain (spec section 4), so observed senders count toward group size.
      const group = p.participants.length > 2 || p.threadType === 'RegularGroup' || memberIdx.size > 2;
      const kind = group ? 'group_dm' : 'dm';
      const ctx = builder.context(`${ns}:${kind}:${t.id}`, { name: p.title || t.id, kind, visibility: group ? 'group' : 'direct', members: [...memberIdx] });
      builder.stat(group ? 'group-threads' : 'direct-threads');
      // The other party of a 1:1 thread.
      const pIdx = p.participants.map(n => person(n, t.id));
      const otherOf = actor => {
        if (group) return -1;
        const others = pIdx.filter(i => i >= 0 && i !== actor);
        return others.length === 1 ? others[0] : -1;
      };

      let idx = 0;
      for (const m of p.msgs) {
        const actor = person(m.sender, t.id);
        if (actor < 0) { builder.warn('no-sender', 'Messages without a sender name were skipped.'); continue; }
        const tm = Number.isFinite(m.t) ? m.t : NaN;
        const dkey = `${actor}|${tm}|${m.text ?? ''}`;
        if (seen.has(dkey)) { builder.stat('duplicates-removed'); continue; }
        seen.add(dkey);
        if (tm > latest) latest = tm;
        const key = `${ns}:msg:${t.id}:${idx++}`;
        const type = m.type;
        if (type === 'Subscribe' || type === 'Unsubscribe') {
          const evType = type === 'Subscribe' ? 'join' : 'leave';
          // `users` (who was added/removed) is UNVERIFIED in the spec; without it
          // the sender is taken as the person joining or leaving.
          if (m.users && m.users.length) {
            for (const u of m.users) {
              const who = person(u, t.id);
              if (who < 0) continue;
              builder.event({ type: evType, t: tm, actor: who, targets: who !== actor ? [[actor, 'subject']] : [], context: ctx, text: m.text });
              builder.stat(evType === 'join' ? 'joins' : 'leaves');
            }
          } else {
            builder.event({ type: evType, t: tm, actor, targets: [], context: ctx, text: m.text });
            builder.stat(evType === 'join' ? 'joins' : 'leaves');
          }
          continue;
        }
        if (type === 'Call') {
          if (m.missed || !(m.callDuration > 0)) { builder.stat('missed-calls'); continue; }
          const other = otherOf(actor);
          builder.event({ type: 'copresence', t: tm, actor, targets: other >= 0 ? [[other, 'attendee']] : [], context: ctx, weight: 1 });
          builder.stat('calls');
          continue;
        }
        // Instagram writes reactions twice: in reactions[] and as an English
        // system message. Skip the notice (localised variants pass through).
        if (typeof m.text === 'string' && /^Reacted .+ to your message$/.test(m.text)) { builder.stat('reaction-notices-skipped'); continue; }
        const targets = [];
        const other = otherOf(actor);
        if (other >= 0) targets.push([other, 'dm']);
        let text = m.text;
        if (!text && m.share?.link) text = m.share.link;
        if (m.unsent) builder.stat('unsent');
        builder.event({ type: 'message', t: tm, actor, targets, context: ctx, key, text: text || null });
        builder.stat('messages');
        for (const r of m.reactions || []) {
          const ra = person(r?.actor, t.id);
          if (ra < 0) continue;
          builder.event({ type: 'reaction', t: NaN, actor: ra, targets: [[actor, 'subject']], context: ctx, parentKey: key, text: r.reaction ?? null });
          builder.stat('reactions');
          builder.warn('undated-reactions', 'Meta does not export when a reaction was made, so reactions have no time.');
        }
      }
    }
    if (platform === 'messenger' && !parsed.some(p => p.t.e2ee) && parsed.length) {
      builder.warn('e2ee-missing', 'Since 2024 most Messenger chats are end-to-end encrypted and are not in this export. Download them separately (Messenger > Chat history > Download chat backup) and import both together.');
    }
    if (parsed.some(p => p.t.sections.has('e2ee_cutover'))) builder.stat('e2ee-cutover-threads');
  }
  progress?.(1, 'Meta import done');
}

function gapIn(parts) {
  const ns = [...new Set(parts)].sort((a, b) => a - b);
  return ns.length > 0 && ns.some((n, i) => n !== i + 1);
}

export default {
  id: 'meta',
  label: 'Facebook Messenger / Instagram messages (Meta export, JSON)',
  family: 'personal',
  detect,
  options: [
    { key: 'egoName', label: 'Your name as shown in Messenger/Instagram (optional)', type: 'text', default: '' },
    { key: 'platform', label: 'Platform', type: 'choice', default: 'auto', choices: ['auto', 'messenger', 'instagram'] },
    { key: 'includeRequests', label: 'Include message requests and filtered threads', type: 'boolean', default: false },
  ],
  partKey,
  import: importMeta,
};

export { detect };
