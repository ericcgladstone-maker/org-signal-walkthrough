// DiscordChatExporter JSON, per docs/formats/discord.md section (b): one file
// per channel, `<Guild> - <Category> - <Channel> [<channelId>].json`, holding
// guild, channel, dateRange, exportedAt, messages[] and messageCount. Every
// message records its author, mentions, reactions (with the users who
// reacted) and, for replies, a reference to the parent message id. Ids are
// snowflakes (strings) derived from the post time. Timestamps carry an offset.

import { u8, safeFileName } from './util.js';
import { snowflake, DISCORD_EPOCH } from '../identity.js';
import { pad, parts } from '../time.js';

// Slack-style reaction names (from content.reaction) -> unicode emoji and DCE code.
export const EMOJI = {
  '+1': ['\u{1F44D}', 'thumbsup', '1f44d'], tada: ['\u{1F389}', 'tada', '1f389'], heart: ['\u{2764}\u{FE0F}', 'heart', '2764'],
  raised_hands: ['\u{1F64C}', 'raised_hands', '1f64c'], white_check_mark: ['\u{2705}', 'white_check_mark', '2705'], clap: ['\u{1F44F}', 'clap', '1f44f'],
  fire: ['\u{1F525}', 'fire', '1f525'], disappointed: ['\u{1F61E}', 'disappointed', '1f61e'], grimacing: ['\u{1F62C}', 'grimacing', '1f62c'],
  sob: ['\u{1F62D}', 'sob', '1f62d'], confused: ['\u{1F615}', 'confused', '1f615'], eyes: ['\u{1F440}', 'eyes', '1f440'],
  thinking_face: ['\u{1F914}', 'thinking', '1f914'], memo: ['\u{1F4DD}', 'pencil', '1f4dd'], pray: ['\u{1F64F}', 'pray', '1f64f'],
};

export function write({ world, ctx, records, ident, rng, native = {} }) {
  const r = rng.fork('discord');
  const { span } = world;
  const guild = { id: snowflake(span.start - 900 * 86400000, DISCORD_EPOCH, r), name: ctx.server?.name || 'Hobby Commons' };
  guild.iconUrl = `https://cdn.discordapp.example/icons/${guild.id}/${r.hex(32)}.png`;
  const categoryId = snowflake(span.start - 899 * 86400000, DISCORD_EPOCH, r);
  const bots = ctx.bots.map(b => ({ ...b, id: snowflake(span.start - 700 * 86400000, DISCORD_EPOCH, r) }));
  native.botKeys = bots.map(b => 'discord:' + b.id);
  const modSet = new Set(world.moderators || []);
  const color = i => (modSet.has(i) ? '#1F8B4C' : world.isCore?.[i] ? '#3498DB' : null);
  const roles = i => (modSet.has(i) ? [{ id: roleId('mod'), name: 'Moderators', color: '#1F8B4C', position: 3 }] : world.isCore?.[i] ? [{ id: roleId('reg'), name: 'Regulars', color: '#3498DB', position: 2 }] : []);
  const roleIds = {};
  function roleId(k) { return (roleIds[k] ||= snowflake(span.start - 800 * 86400000, DISCORD_EPOCH, r)); }
  const avatar = id => `https://cdn.discordapp.example/avatars/${id}/${id.slice(-8)}.png`;

  const user = (a, full = true) => {
    if (a < 0) {
      const b = bots[-1 - a];
      const u = { id: b.id, name: b.name, discriminator: '0000', nickname: b.label, color: null, isBot: true, roles: [], avatarUrl: avatar(b.id) };
      if (!full) { delete u.color; }
      return u;
    }
    const id = ident.userId[a];
    const u = { id, name: ident.handle[a], discriminator: '0000', nickname: world.people.first[a], color: color(a), isBot: false, roles: roles(a), avatarUrl: avatar(id) };
    if (!full) { delete u.color; delete u.roles; }
    return u;
  };
  const nick = a => (a < 0 ? bots[-1 - a].label : world.people.first[a]);

  const out = [];
  ctx.spaces.forEach((s, si) => {
    if (s.kind !== 'server_channel') return;
    const channel = { id: snowflake(span.start - (600 - si) * 86400000, DISCORD_EPOCH, r), type: 'GuildTextChat', categoryId, category: 'Text Channels', name: s.name, topic: s.words ? `Talk about ${s.words.slice(0, 3).join(', ')}` : null };
    const recs = records.filter(x => x.space === si);
    const msgs = [];
    const byRec = new Map();
    for (const rec of recs) {
      if (rec.kind === 'reaction') {
        const m = byRec.get(rec.parent);
        if (!m) continue;
        const [glyph, code, hex] = EMOJI[rec.emoji] || EMOJI['+1'];
        let rx = m.reactions.find(x => x.emoji.name === glyph);
        if (!rx) m.reactions.push((rx = { emoji: { id: '', name: glyph, code, isAnimated: false, imageUrl: `https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/${hex}.svg` }, count: 0, users: [] }));
        if (!rx.users.some(u => u.id === ident.userId[rec.actor])) { rx.count++; rx.users.push(user(rec.actor, false)); }
        continue;
      }
      if (rec.kind !== 'message' && rec.kind !== 'join') continue;
      const id = snowflake(rec.t, DISCORD_EPOCH, r);
      const isJoin = rec.kind === 'join';
      const parent = rec.parent >= 0 ? byRec.get(rec.parent) : null;
      const ments = (rec.mentions || []).filter(p => p >= 0);
      // DCE renders user mentions in content as @nickname.
      const content = isJoin ? 'Joined the server.' : (ments.map(p => '@' + nick(p)).join(' ') + (ments.length && rec.text ? ' ' : '') + (rec.text ?? ''));
      const m = {
        id, type: isJoin ? 'GuildMemberJoin' : parent ? 'Reply' : 'Default',
        timestamp: isoOffset(rec.t), timestampEdited: null, callEndedTimestamp: null, isPinned: false,
        content, author: user(rec.actor), attachments: [], embeds: [], stickers: [], reactions: [],
        mentions: ments.map(p => user(p)),
      };
      if (parent) m.reference = { type: 'Default', messageId: parent.id, channelId: channel.id, guildId: guild.id };
      m.inlineEmojis = [];
      byRec.set(rec.id, m);
      msgs.push(m);
    }
    const doc = { guild, channel, dateRange: { after: null, before: null }, exportedAt: isoOffset(span.end), messages: msgs, messageCount: msgs.length };
    out.push({ path: `${safeFileName(guild.name)} - Text Channels - ${safeFileName(s.name)} [${channel.id}].json`, bytes: u8(JSON.stringify(doc, null, 2)) });
  });
  return out;
}

// "2026-09-01T14:02:11.512+00:00": round-trip format with an explicit offset.
function isoOffset(t) {
  const p = parts(t);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(p.ms, 3)}+00:00`;
}
