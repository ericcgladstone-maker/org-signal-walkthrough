// Vocabulary for synthetic text: department and community topic words,
// message templates per register, affect phrases and diffusion seed terms.
//
// Affect phrases are written with words that VADER (vendor/vader.js) scores
// clearly positive or negative, so the affect the generator plants can be
// measured back from the text. Neutral templates avoid VADER lexicon words.

// Department bases. `division` is the function a department rolls up to, as
// the top level of a real HR export would record it: seven functions (plus
// the CEO's Executive) whatever the number of departments, so a regional
// department like "Sales Americas" sits in division "Sales".
export const DEPT_BASES = [
  { id: 'eng', division: 'Engineering', name: 'Engineering', role: 'Software Engineer', words: ['pull request', 'migration', 'staging deploy', 'API spec', 'test suite', 'incident review', 'build pipeline', 'schema change', 'load test', 'feature flag'] },
  { id: 'sales', division: 'Sales', name: 'Sales', role: 'Account Executive', words: ['pipeline review', 'renewal', 'pricing quote', 'forecast', 'demo', 'discovery call', 'territory plan', 'order form'] },
  { id: 'mkt', division: 'Marketing', name: 'Marketing', role: 'Marketing Specialist', words: ['campaign brief', 'landing page', 'launch copy', 'webinar', 'newsletter', 'brand guidelines', 'ad spend report'] },
  { id: 'fin', division: 'Finance', name: 'Finance', role: 'Financial Analyst', words: ['budget model', 'quarterly close', 'invoice batch', 'expense report', 'variance analysis', 'audit checklist'] },
  { id: 'people', division: 'Operations', name: 'People Operations', role: 'People Partner', words: ['onboarding plan', 'offer letter', 'review cycle', 'benefits update', 'hiring plan', 'engagement survey'] },
  { id: 'ops', division: 'Operations', name: 'Operations', role: 'Operations Specialist', words: ['vendor contract', 'runbook', 'capacity plan', 'shipping schedule', 'warehouse report', 'process map'] },
  { id: 'design', division: 'Product', name: 'Design', role: 'Product Designer', words: ['mockups', 'prototype', 'design review', 'user flow', 'style guide', 'usability notes'] },
  { id: 'product', division: 'Product', name: 'Product', role: 'Product Manager', words: ['roadmap', 'spec', 'PRD', 'release notes', 'backlog', 'customer interviews'] },
  { id: 'support', division: 'Customer Support', name: 'Customer Support', role: 'Support Specialist', words: ['ticket queue', 'escalation', 'help center article', 'CSAT report', 'macro update'] },
  { id: 'data', division: 'Engineering', name: 'Data', role: 'Data Analyst', words: ['dashboard', 'metrics definition', 'query', 'data model', 'experiment readout', 'pipeline backfill'] },
  { id: 'legal', division: 'Finance', name: 'Legal', role: 'Counsel', words: ['contract redline', 'NDA', 'policy draft', 'compliance checklist', 'processing addendum'] },
  { id: 'research', division: 'Product', name: 'Research', role: 'Research Scientist', words: ['literature review', 'experiment plan', 'results memo', 'paper draft', 'dataset audit'] },
  { id: 'it', division: 'Engineering', name: 'IT', role: 'Systems Administrator', words: ['laptop refresh', 'access request', 'SSO rollout', 'device inventory', 'patch window'] },
  { id: 'partner', division: 'Sales', name: 'Partnerships', role: 'Partner Manager', words: ['partner deck', 'co-marketing plan', 'integration brief', 'referral report'] },
  { id: 'facilities', division: 'Operations', name: 'Facilities', role: 'Workplace Coordinator', words: ['office move', 'desk booking', 'floor plan', 'catering order'] },
];

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'tomorrow', 'end of week', 'next week'];
export const TIMEWORDS = ['this afternoon', 'tomorrow morning', 'after standup', 'later today', 'on Thursday'];

export const WORK_CORE = [
  'Can you take a look at the {w} for {p} when you get a chance?',
  'Pushed an update to the {w}.',
  'Is the {w} still on track for {d}?',
  'Quick update on {p}: the {w} is in review.',
  'Who owns the {w} now?',
  'Moving the {w} discussion to the next sync.',
  'I left comments on the {w}.',
  'Can we pair on the {w} {tw}?',
  'Latest {w} is here: {link}',
  'Do you have the numbers for the {w}?',
  'Heads up, the {w} moved to {d}.',
  'Following up on the {w} from last week.',
  'Draft of the {w} is in the folder.',
  'What is the status of the {w} for {p}?',
  'Adding {p} to the agenda, mostly the {w}.',
  'Can someone confirm the {w} owner for {p}?',
];
export const WORK_REPLY = ['On it.', 'Will do, looking now.', 'Okay, noted.', 'By {d}.', 'Let me check and get back to you.',
  'Done, see the doc.', 'Can we talk about it in the sync?', 'Added a note to the {w}.', 'Taking a look now.', 'It is in the {w}.',
  'Not yet, will update by {d}.', 'Makes sense to me.', 'Same question here.', 'I can take that one.'];
export const WORK_SOCIAL = ['Anyone up for lunch at the noodle place?', 'Coffee run in 10, who wants something?', 'Who left the cake in the kitchen?',
  'Reminder: book club is on {d}.', 'The office plants have opinions today.', 'Is the third floor printer working?', 'Bike rack is full again.'];
export const WORK_POS = ['Great work on this, thank you!', 'Really appreciate the help here.', 'This looks excellent.', 'Nice job, the team did amazing work.',
  'Love this, thanks for pushing it through.', 'Glad we sorted it out, good stuff.', 'Happy with how this turned out.', 'Thanks, this is a big help.',
  'Awesome progress, well done.', 'Brilliant, thank you all.'];
export const WORK_NEG = ['Honestly this is so frustrating and bad.', 'I am worried we will miss the deadline again.', 'This is a mess and nobody owns it.',
  'Annoyed that it broke again.', 'Really unhappy with how this went.', 'This keeps failing and it is exhausting.', 'Ugh, terrible timing.',
  'I am stressed about this, it is a problem.', 'Disappointed we lost another week.', 'This is painful and confusing.'];

export const CASUAL_CORE = ['are we still on for {e}?', 'running late, be there in 10', 'did you see the {thing}?', 'can you grab {food} on the way',
  'what time works for {e}?', 'just landed', 'call me after work', 'on my way', 'home now', 'who is bringing the {food}?',
  'what are we doing for {e}', 'pics from {e}', 'leaving now', 'is {e} still at 7?', 'did anyone find my {thing}?', 'ok see you at 7',
  'yep', 'haha', 'lol', 'omg', 'wait what', 'ok', 'on it', 'can someone send the address', 'sending the link now', 'remind me tomorrow'];
export const CASUAL_POS = ['love you guys', 'that was so much fun!', 'best day ever', 'thank you so much, you are amazing', 'so happy for you!!',
  'awesome', 'love and miss you all', 'yay great news', 'this made me so happy', 'love it'];
export const CASUAL_NEG = ['ugh I am so tired of this', 'honestly that hurt, I am sad', 'I am really upset about it', 'this is so stressful', 'feeling awful today',
  'so annoyed rn', 'worst week', 'sad and lonely tonight', 'I hate this', 'that was rude'];
export const EVENTS = ['dinner', 'the barbecue', 'Sunday lunch', 'game night', 'the hike', 'movie night', 'the birthday', 'brunch', 'the trip', 'karaoke'];
export const THINGS = ['photos', 'umbrella', 'charger', 'keys', 'recipe', 'video', 'tickets', 'playlist', 'book'];
export const FOODS = ['bread', 'dessert', 'snacks', 'drinks', 'salad', 'dumplings', 'pie', 'ice cream'];
export const EMOJI = ['\u{1F602}', '\u{2764}\u{FE0F}', '\u{1F44D}', '\u{1F64F}', '\u{1F389}', '\u{1F605}', '\u{1F60D}', '\u{1F973}', '\u{1F648}', '\u{2615}'];

export const ONLINE_COMMUNITIES = [
  { id: 'civic-a', name: 'Greenline supporters', political: 'a', words: ['transit funding', 'rent caps', 'public broadband', 'Greenline coalition', 'bike lanes'], tags: ['Greenline', 'TransitNow', 'RentCaps'] },
  { id: 'civic-b', name: 'Stonebridge supporters', political: 'b', words: ['tax relief', 'local control', 'road expansion', 'Stonebridge alliance', 'small business'], tags: ['Stonebridge', 'LocalControl', 'TaxRelief'] },
  { id: 'tech', name: 'Tech', words: ['open source', 'self-hosting', 'compilers', 'home lab', 'type systems'], tags: ['opensource', 'homelab', 'devlog'] },
  { id: 'sports', name: 'Sports', words: ['the Harbor Hawks', 'transfer window', 'derby day', 'the playoffs', 'season tickets'], tags: ['HawksNation', 'DerbyDay', 'matchday'] },
  { id: 'food', name: 'Food', words: ['sourdough', 'ramen', 'fermentation', 'cast iron', 'street food'], tags: ['sourdough', 'homecooking', 'ferment'] },
  { id: 'games', name: 'Games', words: ['speedruns', 'indie games', 'patch notes', 'the new expansion', 'retro consoles'], tags: ['indiedev', 'speedrun', 'retrogaming'] },
  { id: 'science', name: 'Science', words: ['exoplanets', 'gene editing', 'climate models', 'the telescope data', 'protein folding'], tags: ['astronomy', 'sciencetwitter', 'climate'] },
  { id: 'books', name: 'Books', words: ['the new novel', 'book club picks', 'translated fiction', 'audiobooks', 'poetry'], tags: ['amreading', 'booktok', 'poetry'] },
];
export const POST_CORE = ['Thread on {w}: what nobody tells you', 'New piece on {w} {link}', 'Hot take: {w} is overrated', '{w} update {link}',
  'Reading about {w} tonight', 'Anyone else following the {w} story?', 'Big day for {w}.', 'Three things I learned about {w} this week',
  'Quick question for people into {w}', 'Notes from the {w} meetup {link}', 'Still thinking about {w}', 'Today in {w}:'];
export const POST_REPLY = ['Source?', 'Exactly this.', 'Not sure about that.', 'Say more?', 'Same here.', 'This one.', 'Point taken on {w}.',
  'Bookmarking this.', 'Hard disagree on {w}.', 'Wait, really?'];
export const POST_POS = ['This is brilliant.', 'Absolutely love this.', 'So hopeful about this.', 'Fantastic news.', 'Great thread, thank you.', 'Wonderful work.'];
export const POST_NEG = ['This is a disgrace.', 'Pathetic and dishonest.', 'So angry about this.', 'Terrible take.', 'What an awful mess.', 'Sick of the lies.'];
export const BOT_POSTS = ['BREAKING {w} {link}', 'Must read on {w} {link}', 'You will not believe this {w} {link}', 'Share this on {w} {link}'];

export const COMMUNITY_SPACES = [
  { id: 'brew', name: 'fermentcraft', words: ['yeast starter', 'gravity reading', 'dry hopping', 'kegging', 'sanitizer'] },
  { id: 'bike', name: 'pedalcommute', words: ['panniers', 'chain lube', 'rain gear', 'bike lane map', 'tubeless setup'] },
  { id: 'boardgames', name: 'meeplehall', words: ['worker placement', 'the expansion', 'solo mode', 'rules question', 'game night setup'] },
  { id: 'plants', name: 'leafcorner', words: ['repotting', 'fungus gnats', 'grow lights', 'propagation', 'soil mix'] },
  { id: 'astro', name: 'backyardskies', words: ['dobsonian', 'light pollution', 'star party', 'collimation', 'eyepieces'] },
  { id: 'synth', name: 'patchcables', words: ['modular rack', 'sequencer', 'filter sweep', 'oscillator drift', 'MIDI clock'] },
  { id: 'trail', name: 'trailmix_runners', words: ['trail shoes', 'elevation gain', 'race report', 'hydration vest', 'taper week'] },
  { id: 'knit', name: 'loopandpurl', words: ['sock yarn', 'cable pattern', 'blocking', 'gauge swatch', 'sweater pattern'] },
];
export const COMM_CORE = ['Has anyone tried {w}?', 'Finally got my {w} sorted, write-up inside', 'Beginner question about {w}', 'Weekly thread: {w}',
  'Is {w} worth it?', 'PSA about {w}', 'My {w} setup after a year', 'Need advice on {w}', 'Show and tell: {w}'];
export const COMM_REPLY = ['Same thing happened to me.', 'Try {w} first.', 'This is the way.', 'Depends on your {w}.', 'Following.',
  'Check the wiki on {w}.', 'Did that last month, worked fine.', 'Not in my experience.', 'Pics?', 'What did you end up doing?'];
export const COMM_POS = ['This is awesome, thanks for sharing!', 'Great write-up, really helpful.', 'Love this community.', 'Beautiful work!', 'So glad this worked.'];
export const COMM_NEG = ['This is useless advice.', 'Terrible experience, avoid.', 'So frustrated with this.', 'Awful, broke again.', 'Hate when this happens.'];

export const PRO_CORE = ['Congrats on the new role at {c}!', 'Thanks for connecting, {f}.', 'Would you be open to a quick chat about a {r} opening at {c}?',
  'Great to meet you at the {ev}.', 'Happy work anniversary!', 'Are you hiring for {r} roles this quarter?', 'Saw your post about {w}, would love to hear more.',
  'Could you introduce me to someone on the {w} team at {c}?', 'Following up on our chat about {w}.'];
export const PRO_REPLY = ['Thanks, appreciate it!', 'Sure, happy to chat next week.', 'Not right now, but keep in touch.', 'Will do.', 'Sending you the details.'];
export const PRO_EVENTS = ['industry summit', 'alumni mixer', 'meetup', 'conference', 'career fair'];

// Invented words for planted diffusion. None is an English word, so a match is the seed term.
export const SEED_TERMS = ['flumecast', 'glimmerboard', 'snackwave', 'quillstack', 'brightcrumb', 'murmurly', 'zestgrid', 'hoverleaf',
  'pinecasting', 'driftlog', 'cobblesync', 'lumenpatch'];

export const REACTIONS_POS = ['+1', 'tada', 'heart', 'raised_hands', 'white_check_mark', 'clap', 'fire'];
export const REACTIONS_NEG = ['disappointed', 'grimacing', 'sob', 'confused'];
export const REACTIONS_NEU = ['eyes', 'thinking_face', 'memo', '+1', 'pray'];
