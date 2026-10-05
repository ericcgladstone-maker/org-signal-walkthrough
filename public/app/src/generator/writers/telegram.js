// Telegram Desktop "Machine-readable JSON" export, per docs/formats/telegram.md
// (structure from tdesktop's export_output_json.cpp):
//   full export   DataExport_YYYY-MM-DD/result.json with about,
//                 personal_information, contacts, frequent_contacts, chats
//   single chat   ChatExport_YYYY-MM-DD/result.json with the chat object at the root
// Both are handed over zipped (users zip the export folder). Messages carry
// `date` (local wall clock, no offset) and `date_unixtime` (epoch seconds as a
// string); `text` is a string for one plain run and a mixed array otherwise,
// while `text_entities` is always an array. Service messages (joins, leaves,
// group creation) name people, not ids. Media is not included in the export,
// which tdesktop records with a placeholder string. The JSON is indented one
// space per level, as tdesktop writes it.

import { zip, u8 } from './util.js';
import { pad, parts, isoNoZone } from '../time.js';
import { fakePhone } from '../identity.js';

const NOT_INCLUDED = '(File not included. Change data exporting settings to download.)';

export function write({ world, ctx, records, ident, obs, spec, rng, native = {} }) {
  const r = rng.fork('telegram');
  const ego = obs.ego;
  const { span } = world;
  const off = spec.tzOffsetHours ?? world.tzOffset[ego] ?? 0;
  const uid = i => ident.userId[i];
  const fromId = i => 'user' + uid(i);
  const name = i => world.people.label[i];
  const local = t => isoNoZone(t, off);
  const unix = t => String(Math.floor(t / 1000));

  const chosen = [];
  ctx.spaces.forEach((s, si) => {
    if ((s.kind !== 'chat' && s.kind !== 'group_chat') || !s.members.includes(ego)) return;
    if (obs.view === 'chat' && !matchChat(obs, s)) return;
    chosen.push(si);
  });
  const bySpace = new Map(chosen.map(si => [si, []]));
  for (const rec of records) if (bySpace.has(rec.space)) bySpace.get(rec.space).push(rec);

  const msgCount = new Map();
  const chats = [];
  for (const si of chosen) {
    const s = ctx.spaces[si];
    const recs = bySpace.get(si);
    if (!recs.length) continue;
    const group = s.kind === 'group_chat';
    const other = group ? -1 : s.members.find(m => m !== ego);
    const chat = group
      ? { name: s.name, type: s.members.length > 12 ? 'private_supergroup' : 'private_group', id: Number(r.digits(10)), messages: [] }
      : { name: name(other), type: 'personal_chat', id: Number(uid(other)), messages: [] };
    let nextId = 1 + r.int(4000);
    const msgId = new Map();
    const add = m => { chat.messages.push(m); return m.id; };
    const head = (t, type) => ({ id: nextId++, type, date: local(t), date_unixtime: unix(t) });
    if (group && s.created >= span.start) {
      add({ ...head(s.created, 'service'), actor: name(s.creator), actor_id: fromId(s.creator), action: 'create_group', title: s.name, members: s.members.filter(m => m !== s.creator).map(name), text: '', text_entities: [] });
    }
    for (const rec of recs) {
      if (rec.kind === 'join') {
        const by = rec.meta?.by;
        if (by >= 0) add({ ...head(rec.t, 'service'), actor: name(by), actor_id: fromId(by), action: 'invite_members', members: [name(rec.actor)], text: '', text_entities: [] });
        else add({ ...head(rec.t, 'service'), actor: name(rec.actor), actor_id: fromId(rec.actor), action: 'join_group_by_link', inviter: 'Group', text: '', text_entities: [] });
        continue;
      }
      if (rec.kind === 'leave') {
        // A member leaving shows as remove_members whose actor is the member.
        add({ ...head(rec.t, 'service'), actor: name(rec.actor), actor_id: fromId(rec.actor), action: 'remove_members', members: [name(rec.actor)], text: '', text_entities: [] });
        continue;
      }
      if (rec.kind !== 'message' || rec.meta?.deleted) continue; // deleted messages are gone from exports
      const m = { ...head(rec.t, 'message'), from: name(rec.actor), from_id: fromId(rec.actor) };
      if (rec.parent >= 0 && msgId.has(rec.parent)) m.reply_to_message_id = msgId.get(rec.parent);
      if (rec.meta?.edited) { const te = rec.t + (2 + r.int(300)) * 1000; m.edited = local(te); m.edited_unixtime = unix(te); }
      const media = rec.meta?.media;
      if (media === 'image') { m.photo = NOT_INCLUDED; m.photo_file_size = 40000 + r.int(400000); m.width = 1280; m.height = 960; }
      else if (media === 'video') { m.file = NOT_INCLUDED; m.media_type = 'video_file'; m.mime_type = 'video/mp4'; m.duration_seconds = 3 + r.int(60); }
      else if (media === 'audio') { m.file = NOT_INCLUDED; m.media_type = 'voice_message'; m.mime_type = 'audio/ogg'; m.duration_seconds = 2 + r.int(40); }
      else if (media === 'sticker') { m.file = NOT_INCLUDED; m.media_type = 'sticker'; m.sticker_emoji = '\u{1F44D}'; m.width = 512; m.height = 512; }
      else if (media === 'GIF') { m.file = NOT_INCLUDED; m.media_type = 'animation'; m.mime_type = 'video/mp4'; m.width = 320; m.height = 240; }
      const runs = [];
      for (const p of (rec.mentions || []).filter(p => p >= 0 && p !== rec.actor)) runs.push({ type: 'mention_name', text: name(p), user_id: Number(uid(p)) }, { type: 'plain', text: ' ' });
      if (!media && rec.text) runs.push({ type: 'plain', text: rec.text });
      Object.assign(m, serializeText(runs));
      msgId.set(rec.id, add(m));
      msgCount.set(rec.actor, (msgCount.get(rec.actor) || 0) + 1);
    }
    chats.push(chat);
  }

  const p = parts(span.end);
  const stamp = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  if (obs.view === 'chat') {
    const chat = chats[0] || { name: 'Chat', type: 'personal_chat', id: 0, messages: [] };
    return [{ path: `ChatExport_${stamp}.zip`, bytes: zip([{ path: `ChatExport_${stamp}/result.json`, bytes: u8(JSON.stringify(chat, null, 1)) }], span.end) }];
  }

  // Contacts: the people the ego talks with one to one.
  const contacts = [];
  for (const si of chosen) {
    const s = ctx.spaces[si];
    if (s.kind !== 'chat') continue;
    const o = s.members.find(m => m !== ego);
    const t = span.start - r.int(900) * 86400000;
    contacts.push({ user_id: Number(uid(o)), first_name: world.people.first[o], last_name: world.people.last[o], phone_number: fakePhone(r, o), date: local(t), date_unixtime: unix(t) });
  }
  const top = [...msgCount].filter(([i]) => i !== ego).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10);
  const max = top[0]?.[1] || 1;
  native.frequent = top.map(([i, c]) => ({ person: i, rating: Math.round((c / max) * 1e6) / 1e6 }));
  const result = {
    about: 'Here is the data you requested. Remember: Telegram is ad free, it doesn\'t sell your data, and it doesn\'t use your messages to target you with ads.',
    personal_information: { user_id: Number(uid(ego)), first_name: world.people.first[ego], last_name: world.people.last[ego], phone_number: fakePhone(r, ego), username: '@' + world.people.first[ego].toLowerCase() + r.int(1000), bio: '' },
    contacts: { about: 'This is your contact list.', list: contacts },
    frequent_contacts: { about: 'This is the list of people you message most often.', list: top.map(([i, c]) => ({ id: Number(uid(i)), category: 'people', type: 'user', name: name(i), rating: Math.round((c / max) * 1e6) / 1e6 })) },
    chats: { about: 'This page lists all chats from this export.', list: chats },
  };
  return [{ path: `DataExport_${stamp}.zip`, bytes: zip([{ path: `DataExport_${stamp}/result.json`, bytes: u8(JSON.stringify(result, null, 1)) }], span.end) }];
}

// tdesktop SerializeText: "" when empty, a string for one plain run, otherwise
// an array of bare strings (plain runs) and entity objects. text_entities is
// always the full list of objects.
function serializeText(runs) {
  const merged = [];
  for (const x of runs) {
    const last = merged[merged.length - 1];
    if (x.type === 'plain' && last?.type === 'plain') last.text += x.text;
    else merged.push({ ...x });
  }
  const text = !merged.length ? '' : merged.length === 1 && merged[0].type === 'plain' ? merged[0].text : merged.map(x => (x.type === 'plain' ? x.text : x));
  return { text, text_entities: merged };
}

function matchChat(obs, s) {
  if (obs.chat != null) return s.key === obs.chat || s.name === obs.chat;
  if (obs.chatWith >= 0) return s.members.includes(obs.ego) && s.members.includes(obs.chatWith) && s.members.length === 2;
  return !!s.defaultChat;
}
