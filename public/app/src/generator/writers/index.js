// Native export writers, one per medium. Each takes
//   { world, ctx, records, ident, obs, spec, rng }
// (records sorted by time) and returns [{ path, bytes: Uint8Array }] in the
// real export layout described in docs/formats/<format>.md.

import { write as slack } from './slack.js';
import { write as email } from './email.js';
import { write as calendar } from './calendar.js';
import { write as x } from './xarchive.js';
import { write as linkedin } from './linkedin.js';
import { write as whatsapp } from './whatsapp.js';
import { write as telegram } from './telegram.js';
import { write as discord } from './discord.js';
import { write as reddit } from './reddit.js';
import { write as survey } from './survey.js';
import { write as network } from './graphml.js';

export const WRITERS = { slack, email, calendar, x, linkedin, whatsapp, telegram, discord, reddit, survey, network };
