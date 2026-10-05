// Slack workspace export ("All channels & DMs", Business+), per docs/formats/slack.md:
//   users.json, channels.json, groups.json, dms.json, mpims.json, integration_logs.json
//   <channel name>/YYYY-MM-DD.json   public and private channels (folder = name)
//   <D id>/YYYY-MM-DD.json           1:1 DMs (folder = DM id)
//   <mpdm name>/YYYY-MM-DD.json      group DMs (folder = mpim name)
// A folder exists only for conversations with messages, a day file only for
// days with messages. Day files are bucketed in the workspace's zone, not UTC
// (the spec observed Los Angeles bucketing in a real export), so `ts` is the
// only reliable time. Thread replies sit in the day file of the day they were
// posted. Text is mrkdwn with &, <, > escaped and mentions as <@U...>.

import { zip, u8, groupBy } from './util.js';
import { MON, pad, parts } from '../time.js';

export function write({ world, ctx, records, ident, rng, native = {} }) {
  const r = rng.fork('slack');
  const { span } = world;
  const wsOffset = world.locs?.[0]?.offset ?? 0;
  const wsTz = world.locs?.[0]?.tz ?? 'UTC';
  const teamId = ident.teamId;
  const uid = i => ident.userId[i];
  const sec = t => Math.floor(t / 1000);

  // Bots get user ids and bot ids.
  const bots = ctx.bots.map(b => ({ ...b, userId: 'U0' + r.b36(9), botId: 'B0' + r.b36(9) }));
  const actorId = a => (a >= 0 ? uid(a) : bots[-1 - a].userId);
  // The importer keys a bot by its users.json id (bot_id -> profile.bot_id).
  native.botKeys = bots.map(b => 'slack:' + b.userId);

  // ---- conversation ids and names
  const conv = new Map(); // space index -> { id, folder, name, file: 'channels'|'groups'|'dms'|'mpims' }
  const mpimNames = new Set();
  // Public and private channels share one name space in a workspace, so two
  // teams that would both be "marketing-weiss-team" get -2, -3 ... as Slack
  // asks a user to do (folders are named after channels, so they must differ).
  const channelNames = new Set();
  ctx.spaces.forEach((s, si) => {
    if (s.kind === 'channel') {
      const priv = s.visibility === 'private';
      const id = (priv && r.chance(0.3) ? 'G0' : 'C0') + r.b36(9);
      let name = s.name;
      for (let k = 2; channelNames.has(name); k++) name = `${s.name}-${k}`;
      channelNames.add(name);
      conv.set(si, { id, folder: name, name, file: priv ? 'groups' : 'channels' });
    } else if (s.kind === 'dm') {
      const id = 'D0' + r.b36(9);
      conv.set(si, { id, folder: id, file: 'dms' });
    } else if (s.kind === 'group_dm') {
      let name = 'mpdm-' + s.members.map(m => ident.handle[m]).join('--') + '-1';
      while (mpimNames.has(name)) name = name.replace(/-(\d+)$/, (_, d) => '-' + (+d + 1));
      mpimNames.add(name);
      conv.set(si, { id: 'G0' + r.b36(9), folder: name, file: 'mpims' });
    }
  });

  // ---- messages: ts per conversation, unique
  const byConv = groupBy(records, rec => (conv.has(rec.space) ? rec.space : undefined));
  const tsOf = new Map(); // record id -> ts string
  for (const [, recs] of byConv) {
    const used = new Set();
    for (const rec of recs) {
      // Sub-millisecond jitter stays below half a millisecond, so the ts
      // rounds back to the record's own millisecond (importers round ts * 1000).
      let micro = (rec.t % 1000) * 1000 + r.int(500);
      let s = sec(rec.t);
      let ts;
      for (;;) { ts = `${s}.${String(micro).padStart(6, '0')}`; if (!used.has(ts)) break; micro++; if (micro >= 1e6) { micro = 0; s++; } }
      used.add(ts);
      tsOf.set(rec.id, ts);
    }
  }
  const authorOf = new Map(records.map(rec => [rec.id, rec.actor]));

  const userProfile = i => ({
    avatar_hash: r.hex(12), image_72: `https://avatars.slack-edge.example/${r.hex(8)}_72.png`,
    first_name: world.people.first[i], real_name: world.people.label[i], display_name: ident.handle[i].split('.')[0],
    team: teamId, name: ident.handle[i], is_restricted: false, is_ultra_restricted: false,
  });

  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const files = [];
  for (const [si, recs] of byConv) {
    const c = conv.get(si);
    const msgs = new Map(); // record id -> message object
    const out = [];
    for (const rec of recs) {
      const ts = tsOf.get(rec.id);
      let m;
      if (rec.kind === 'message') {
        if (rec.actor < 0) {
          const b = bots[-1 - rec.actor];
          m = { type: 'message', subtype: 'bot_message', text: escape(rec.text ?? ''), ts, username: b.name, bot_id: b.botId };
        } else {
          const ments = rec.mentions || [];
          const body = escape(rec.text ?? '');
          const text = ments.length ? `${ments.map(p => `<@${uid(p)}>`).join(' ')} ${body}`.trim() : body;
          m = { client_msg_id: r.uuid(), type: 'message', text, user: uid(rec.actor), ts, team: teamId, user_team: teamId, source_team: teamId, user_profile: userProfile(rec.actor) };
          m.blocks = [{ type: 'rich_text', block_id: r.b36(5), elements: [{ type: 'rich_text_section', elements: [
            ...ments.flatMap(p => [{ type: 'user', user_id: uid(p) }, { type: 'text', text: ' ' }]),
            ...(body ? [{ type: 'text', text: rec.text }] : []),
          ] }] }];
          if (rec.parent >= 0 && tsOf.has(rec.parent)) {
            m.thread_ts = tsOf.get(rec.parent);
            m.parent_user_id = actorId(authorOf.get(rec.parent));
          }
          if (r.chance(0.03)) m.edited = { user: m.user, ts: `${sec(rec.t) + 60 + r.int(600)}.000000` };
        }
      } else if (rec.kind === 'join' || rec.kind === 'leave') {
        m = { type: 'message', subtype: rec.kind === 'join' ? 'channel_join' : 'channel_leave', ts, user: uid(rec.actor), text: `<@${uid(rec.actor)}> has ${rec.kind === 'join' ? 'joined' : 'left'} the channel` };
      } else if (rec.kind === 'reaction') {
        const target = msgs.get(rec.parent);
        if (!target) continue;
        target.reactions ||= [];
        let rx = target.reactions.find(x => x.name === rec.emoji);
        if (!rx) target.reactions.push((rx = { name: rec.emoji, users: [], count: 0 }));
        const u = uid(rec.actor);
        if (!rx.users.includes(u)) { rx.users.push(u); rx.count++; }
        continue;
      } else continue;
      msgs.set(rec.id, m);
      out.push({ m, t: rec.t, rec });
    }
    // Thread roots carry reply bookkeeping.
    const byTs = new Map(out.map(x => [x.m.ts, x.m]));
    for (const { m } of out) {
      if (!m.thread_ts) continue;
      const root = byTs.get(m.thread_ts);
      if (!root) continue;
      root.thread_ts = root.ts;
      root.reply_count = (root.reply_count || 0) + 1;
      root._ru ||= [];
      if (!root._ru.includes(m.user)) root._ru.push(m.user);
      root.latest_reply = m.ts;
    }
    for (const { m } of out) if (m._ru) { m.reply_users = m._ru.slice(0, 5); m.reply_users_count = m._ru.length; delete m._ru; }
    // Day files in the workspace zone.
    const days = groupBy(out, x => { const p = parts(x.t, wsOffset); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; });
    for (const [day, list] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      files.push({ path: `${c.folder}/${day}.json`, bytes: u8(JSON.stringify(list.map(x => orderKeys(x.m)), null, 4)) });
    }
  }

  // ---- metadata files
  const leftAt = world.leftAt;
  const tzOffsetSec = i => Math.round(world.tzOffset[i] * 3600);
  const users = [];
  for (let i = 0; i < world.n; i++) {
    const a = world.people.attrs[i];
    users.push({
      id: uid(i), team_id: teamId, name: ident.handle[i], deleted: leftAt[i] < Infinity, color: r.hex(6), real_name: world.people.label[i],
      tz: a.tz || wsTz, tz_label: a.location ? `${a.location} Time` : 'Coordinated Universal Time', tz_offset: tzOffsetSec(i),
      profile: {
        title: a.title || '', phone: '', skype: '', real_name: world.people.label[i], real_name_normalized: world.people.label[i],
        display_name: ident.handle[i].split('.')[0], display_name_normalized: ident.handle[i].split('.')[0],
        fields: {}, status_text: '', status_emoji: '', avatar_hash: r.hex(12), email: world.people.email?.[i],
        first_name: world.people.first[i], last_name: world.people.last[i], image_72: `https://avatars.slack-edge.example/${r.hex(8)}_72.png`, team: teamId,
      },
      is_admin: i === 0, is_owner: i === 0, is_primary_owner: i === 0, is_restricted: false, is_ultra_restricted: false,
      is_bot: false, is_app_user: false, updated: sec(span.end) - r.int(86400 * 30),
    });
  }
  for (const b of bots) users.push({
    id: b.userId, team_id: teamId, name: b.name, deleted: false, real_name: b.label, tz: 'America/Los_Angeles', tz_label: 'Pacific Standard Time', tz_offset: -28800,
    profile: { real_name: b.label, display_name: '', bot_id: b.botId, always_active: true, team: teamId, first_name: b.label, last_name: '', image_72: `https://avatars.slack-edge.example/${r.hex(8)}_72.png` },
    is_admin: false, is_owner: false, is_primary_owner: false, is_restricted: false, is_ultra_restricted: false, is_bot: true, is_app_user: false, updated: sec(span.start),
  });

  const rosterAtEnd = s => {
    let m = s.members.slice();
    if (s.leftLater) m = m.filter(x => !s.leftLater.includes(x));
    if (s.joinedLater) m = [...new Set([...m, ...s.joinedLater])];
    return m.filter(x => leftAt[x] === Infinity).map(uid);
  };
  const created = () => sec(span.start) - (30 + r.int(900)) * 86400;
  const channels = [], groups = [], dms = [], mpims = [];
  ctx.spaces.forEach((s, si) => {
    const c = conv.get(si);
    if (!c) return;
    if (c.file === 'channels' || c.file === 'groups') {
      const creator = s.key === 'general' || s.key === 'random' ? uid(0) : uid(s.members[0]);
      const cr = created();
      const obj = {
        id: c.id, name: c.name, created: cr, creator, is_archived: false, is_general: s.key === 'general', members: rosterAtEnd(s),
        topic: { value: '', creator: '', last_set: 0 }, purpose: { value: s.purpose || '', creator, last_set: cr },
      };
      (c.file === 'channels' ? channels : groups).push(obj);
    } else if (c.file === 'dms') {
      dms.push({ id: c.id, created: created(), members: s.members.map(uid) });
    } else {
      const cr = created();
      mpims.push({ id: c.id, name: c.folder, created: cr, creator: uid(s.members[0]), is_archived: false, members: s.members.map(uid), topic: { value: '', creator: '', last_set: 0 }, purpose: { value: '', creator: '', last_set: 0 } });
    }
  });

  const meta = [
    { path: 'users.json', bytes: u8(JSON.stringify(users, null, 4)) },
    { path: 'channels.json', bytes: u8(JSON.stringify(channels, null, 4)) },
    { path: 'groups.json', bytes: u8(JSON.stringify(groups, null, 4)) },
    { path: 'dms.json', bytes: u8(JSON.stringify(dms, null, 4)) },
    { path: 'mpims.json', bytes: u8(JSON.stringify(mpims, null, 4)) },
    { path: 'integration_logs.json', bytes: u8('[]') },
  ];
  const all = [...meta, ...files];
  const d0 = new Date(span.start), d1 = new Date(span.end - 1);
  const label = d => `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
  const zipName = `${world.orgName} Slack export ${label(d0)} - ${label(d1)}.zip`;
  return [{ path: zipName, bytes: zip(all, span.end) }];
}

// Stable, Slack-like key order (type first, ts near the top).
const ORDER = ['client_msg_id', 'type', 'subtype', 'text', 'user', 'username', 'bot_id', 'ts', 'thread_ts', 'reply_count', 'reply_users_count', 'latest_reply', 'reply_users', 'parent_user_id', 'edited', 'team', 'user_team', 'source_team', 'user_profile', 'blocks', 'reactions'];
function orderKeys(m) {
  const o = {};
  for (const k of ORDER) if (m[k] !== undefined) o[k] = m[k];
  for (const k of Object.keys(m)) if (!(k in o)) o[k] = m[k];
  return o;
}
