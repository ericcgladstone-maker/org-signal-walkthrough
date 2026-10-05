// Context and medium registries for the generator.

import * as workplace from './contexts/workplace.js';
import * as online from './contexts/online.js';
import * as professional from './contexts/professional.js';
import * as personal from './contexts/personal.js';
import * as community from './contexts/community.js';
import * as survey from './contexts/survey.js';
import { simSlack, simEmail, simCalendar } from './sim/workplace.js';
import { simSocial } from './sim/online.js';
import { simLinkedIn } from './sim/professional.js';
import { simChats } from './sim/personal.js';
import { simDiscord, simReddit } from './sim/community.js';
import { simSurvey, simNetwork } from './sim/survey.js';

export const CONTEXTS = {
  workplace: { ...workplace, label: 'Workplace', description: 'An organization: departments, reporting lines, teams, offices; chat, email and meetings.' },
  online: { ...online, label: 'Online public', description: 'A public social platform: a follow graph with interest and political communities, influencers and bots.' },
  professional: { ...professional, label: 'Professional network', description: 'LinkedIn-like connections from shared employers and school cohorts, with job changes over time.' },
  personal: { ...personal, label: 'Personal', description: 'One person and their circle: family, friends and coworkers in closeness layers, with group chats.' },
  community: { ...community, label: 'Community', description: 'Forums and servers: spaces with core and peripheral members, moderators and topic threads.' },
  survey: { ...survey, label: 'Survey', description: 'A bounded roster (class or team) with true ties and simulated name-generator answers with recall error.' },
};

export const SIMS = {
  slack: simSlack, email: simEmail, calendar: simCalendar,
  x: simSocial, bluesky: simSocial, mastodon: simSocial,
  linkedin: simLinkedIn,
  whatsapp: simChats, telegram: simChats, imessage: simChats,
  discord: simDiscord, reddit: simReddit,
  survey: simSurvey, network: simNetwork,
};

// The observation a native export implies, whatever the spec asked for.
export const NATIVE_VIEW = {
  slack: () => 'full',
  email: () => 'ego',
  calendar: () => 'ego',
  x: () => 'ego',
  linkedin: () => 'ego',
  whatsapp: spec => (viewOf(spec) === 'chat' ? 'chat' : 'ego'),
  telegram: spec => (viewOf(spec) === 'chat' ? 'chat' : 'ego'),
  discord: () => 'full',
  reddit: spec => (viewOf(spec) === 'sample' ? 'sample' : 'full'),
  survey: () => 'full',
  network: () => 'full',
};

function viewOf(spec) { return typeof spec.observation === 'string' ? spec.observation : spec.observation?.view; }
