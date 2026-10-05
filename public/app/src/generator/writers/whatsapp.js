// WhatsApp "Export chat" text, per docs/formats/whatsapp.md. One export per
// conversation (WhatsApp has no bulk export), written the way the exporting
// (ego's) phone renders it:
//   iOS      `WhatsApp Chat - <Name>.zip` holding `_chat.txt`,
//            lines `[date, time] Author: body`; system notices carry an author
//            (the group name, or the affected person) and a U+200E mark;
//   Android  `WhatsApp Chat with <Name>.txt`, lines `date, time - Author: body`,
//            minute resolution, system notices without an author.
// Date and time shapes follow the device locale (spec variants A-H): en-US
// month-first 12h with U+202F before AM/PM, en-GB day-first 24h, de-DE dotted
// dates, es-ES `p. m.` with a no-break space, fi-FI `klo` and dotted times.
// Times are the phone's local wall clock with no zone.

import { zip, u8, safeFileName } from './util.js';
import { pad, parts } from '../time.js';

const LRM = '‎', NNBSP = ' ', NBSP = ' ';
const E2E_GROUP = 'Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.';
const E2E_ANDROID = 'Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.';
const MEDIA_IOS = { image: 'image omitted', video: 'video omitted', audio: 'audio omitted', sticker: 'sticker omitted', GIF: 'GIF omitted' };

// Locale formatting: header(t, platform) -> header text up to and including the separator before the author.
const LOCALES = {
  'en-US': { ios: p => `[${p.mo}/${p.d}/${yy(p)}, ${h12(p)}:${pad(p.mi)}:${pad(p.s)}${NNBSP}${ampm(p)}] `, android: p => `${p.mo}/${p.d}/${yy(p)}, ${h12(p)}:${pad(p.mi)}${NNBSP}${ampm(p)} - ` },
  'en-GB': { ios: p => `[${pad(p.d)}/${pad(p.mo)}/${p.y}, ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}] `, android: p => `${pad(p.d)}/${pad(p.mo)}/${p.y}, ${pad(p.h)}:${pad(p.mi)} - ` },
  'de-DE': { ios: p => `[${pad(p.d)}.${pad(p.mo)}.${yy(p)}, ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}] `, android: p => `${pad(p.d)}.${pad(p.mo)}.${yy(p)}, ${pad(p.h)}:${pad(p.mi)} - ` },
  'es-ES': { ios: p => `[${p.d}/${p.mo}/${yy(p)}, ${h12(p)}:${pad(p.mi)}:${pad(p.s)} ${p.h < 12 ? 'a.' + NBSP + 'm.' : 'p.' + NBSP + 'm.'}] `, android: p => `${pad(p.d)}/${pad(p.mo)}/${p.y}, ${h12(p)}:${pad(p.mi)} ${p.h < 12 ? 'a.' + NBSP + 'm.' : 'p.' + NBSP + 'm.'} - ` },
  'fi-FI': { ios: p => `[${p.d}.${p.mo}.${p.y} klo ${p.h}.${pad(p.mi)}.${pad(p.s)}] `, android: p => `${p.d}.${p.mo}.${p.y} klo ${p.h}.${pad(p.mi)} - ` },
};
const yy = p => pad(p.y % 100);
const h12 = p => (p.h % 12 === 0 ? 12 : p.h % 12);
const ampm = p => (p.h < 12 ? 'AM' : 'PM');

export function write({ world, ctx, records, ident, obs, spec, rng }) {
  const r = rng.fork('whatsapp');
  const ego = obs.ego;
  const platform = spec.platform === 'android' ? 'android' : 'ios';
  const loc = LOCALES[spec.locale] || LOCALES['en-US'];
  const fmt = loc[platform];
  const off = spec.tzOffsetHours ?? world.tzOffset[ego] ?? 0;
  const { span } = world;
  const name = i => ident.display[i];

  // Conversations in the export: every chat the ego is in, or just the chosen one.
  const chosen = [];
  ctx.spaces.forEach((s, si) => {
    if ((s.kind !== 'chat' && s.kind !== 'group_chat') || !s.members.includes(ego)) return;
    if (obs.view === 'chat' && !matchChat(obs, s)) return;
    chosen.push(si);
  });
  const bySpace = new Map(chosen.map(si => [si, []]));
  for (const rec of records) if (bySpace.has(rec.space)) bySpace.get(rec.space).push(rec);

  const out = [];
  const usedNames = new Set();
  for (const si of chosen) {
    const s = ctx.spaces[si];
    const recs = bySpace.get(si);
    if (!recs.length) continue;
    const group = s.kind === 'group_chat';
    const title = group ? s.name : name(s.members.find(m => m !== ego));
    const lines = [];
    const header = t => fmt(parts(t, off));
    // An export holds the chat's whole history on the phone, so a group opens
    // with the encryption notice and then the creation notice, dated when the
    // group was made (often long before the span). That notice is the only
    // thing that marks a chat with one or two speakers as a group (spec:
    // conversation_type "prefer the system-message evidence").
    const created = group && Number.isFinite(s.created) && s.creator >= 0;
    const t0 = Math.min(recs[0].t, created ? s.created : Infinity) - 60000;
    const sys = (t, author, body) => {
      if (platform === 'ios') lines.push(`${LRM}${header(t)}${author}: ${LRM}${body}`);
      else lines.push(`${header(t)}${body}`);
    };
    if (platform === 'ios') sys(t0, title, E2E_GROUP);
    else sys(t0, null, E2E_ANDROID);
    if (created) {
      const who = s.creator === ego ? 'You' : name(s.creator);
      sys(s.created, title, `${who} created group "${s.name}"`);
    }
    for (const rec of recs) {
      if (rec.kind === 'join') {
        const by = rec.meta?.by;
        const adder = by === ego ? 'You' : by >= 0 ? name(by) : null;
        const added = rec.actor === ego ? 'you' : name(rec.actor);
        const body = adder ? `${adder} added ${added}` : `${name(rec.actor)} joined using this group's invite link`;
        // iOS puts the affected person in the author slot.
        sys(rec.t, name(rec.actor), platform === 'ios' ? body + '.' : body);
        continue;
      }
      if (rec.kind === 'leave') {
        sys(rec.t, name(rec.actor), `${rec.actor === ego ? 'You' : name(rec.actor)} left`);
        continue;
      }
      if (rec.kind !== 'message') continue;
      // iOS marks media and deletion lines with U+200E before the bracket too (spec variant K).
      const mark = platform === 'ios' && (rec.meta?.media || rec.meta?.deleted) ? LRM : '';
      lines.push(mark + header(rec.t) + `${name(rec.actor)}: ` + body(rec));
    }
    const text = lines.join('\n') + '\n';
    let fileTitle = safeFileName(title);
    while (usedNames.has(fileTitle)) fileTitle += ' ' + r.int(10);
    usedNames.add(fileTitle);
    if (platform === 'ios') out.push({ path: `WhatsApp Chat - ${fileTitle}.zip`, bytes: zip([{ path: '_chat.txt', bytes: u8(text) }], span.end) });
    else out.push({ path: `WhatsApp Chat with ${fileTitle}.txt`, bytes: u8(text) });
  }
  return out;

  function body(rec) {
    const m = rec.meta || {};
    if (m.media) return platform === 'ios' ? LRM + capital(MEDIA_IOS[m.media] || 'image omitted') : '<Media omitted>';
    if (m.deleted) {
      const own = rec.actor === ego;
      if (platform === 'ios') return LRM + (own ? 'You deleted this message.' : 'This message was deleted.');
      return own ? 'You deleted this message' : 'This message was deleted';
    }
    let t = rec.text ?? '';
    // Some messages run over two lines (continuation lines in the export).
    if (r.chance(0.08)) t = t.replace(/([.!?]) (?=\S)/, '$1\n');
    const ments = (rec.mentions || []).filter(p => p >= 0 && p !== rec.actor);
    if (ments.length) t = ments.map(p => `@⁨${name(p)}⁩`).join(' ') + (t ? ' ' + t : '');
    if (m.edited) t += platform === 'ios' ? ` ${LRM}<This message was edited.>` : ' <This message was edited>';
    return t;
  }
}

const capital = s => s[0].toUpperCase() + s.slice(1);

// Same matching rule as observe.js for a single-chat view.
function matchChat(obs, s) {
  if (obs.chat != null) return s.key === obs.chat || s.name === obs.chat;
  if (obs.chatWith >= 0) return s.members.includes(obs.ego) && s.members.includes(obs.chatWith) && s.members.length === 2;
  return !!s.defaultChat;
}
