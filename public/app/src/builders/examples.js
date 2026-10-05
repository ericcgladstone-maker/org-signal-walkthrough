// Worked examples: small networks a student can load, analyze and check by
// hand. Each one teaches one idea and says what to look for; the numbers in
// `lookFor` are asserted against the analysis in test/ui-build/examples.test.js,
// so the text never drifts from what the app shows.
//
//   EXAMPLES           [{ id, title, summary, kind: 'draw'|'ego', lookFor[] }]
//   exampleById(id)    one entry (or null)
//   exampleDoc(id)     a drawing (kind 'draw'), validated, with doc.example = id
//   exampleSession(id) an ego interview session (kind 'ego'), at its review step
//
// Every drawing is undirected with one tie type, so Build and Network count
// the same ties. 'clubs-two-mode' is a two-mode drawing (doc.twoMode), the
// worked example for affiliation networks. Fake names throughout.
//
// Pure module: runs in Node.

import { validateDoc } from './draw.js';
import * as E from './ego.js';

const RING_N = 20;

export const EXAMPLES = [
  {
    id: 'two-cliques-broker', kind: 'draw', title: 'Two teams and a broker',
    summary: 'Two close-knit teams joined only through one person.',
    lookFor: [
      'Hal Novak has the highest betweenness (0.571): all 16 shortest routes between an Engineering person and a Product person pass through him. In People, sort by Betweenness.',
      'Hal has 4 contacts, no more than Ava, Cai, Eli or Gus. Having the most ties and connecting groups are different things.',
      'The Network header reads 9 people and 16 ties.',
      'Delete Hal and analyze again: the network falls into two separate pieces (2 components).',
    ],
  },
  {
    id: 'path', kind: 'draw', title: 'A path of six people',
    summary: 'A, B, C, D, E and F in a line, for computing measures by hand.',
    lookFor: [
      'Contacts (degree): A and F have 1, everyone else 2.',
      'Betweenness: C and D 0.600, B and E 0.400, A and F 0. By hand C lies on 6 of the 10 pairs of other people: the app divides the count by (n − 1)(n − 2) / 2 = 10.',
      'Closeness (harmonic): A 0.457 = (1 + 1/2 + 1/3 + 1/4 + 1/5) / 5. The textbook formula, 5 divided by the sum of distances (15), gives 0.333 instead.',
      'Then open "A star of six people" (File, Start from an example) for the other half of the comparison.',
    ],
  },
  {
    id: 'star', kind: 'draw', title: 'A star of six people',
    summary: 'One hub tied to five others who are not tied to each other.',
    lookFor: [
      'The hub has 5 contacts and betweenness 1: it sits on every one of the 10 shortest routes between two other people. Every leaf has 0.',
      'Closeness (harmonic): the hub 1, each leaf 0.600 = (1 + 4 × 1/2) / 5. The textbook formula gives the leaves 5 / 9 = 0.556.',
      'Degree centralization in Network is 1: this is the most centralized network possible.',
    ],
  },
  {
    id: 'ring', kind: 'draw', title: 'A ring (compare with the small world)',
    summary: `${RING_N} people, each tied to the two nearest neighbors on each side.`,
    lookFor: [
      'Average path length 2.895 steps, clustering (transitivity) 0.500: neighbors of a person mostly know each other, but the far side of the ring is 5 steps away.',
      'Load "A small world" next: two extra ties make everyone much closer.',
    ],
  },
  {
    id: 'small-world', kind: 'draw', title: 'A small world (the ring plus two shortcuts)',
    summary: `The same ${RING_N}-person ring with two ties across the middle.`,
    lookFor: [
      'Only 2 more ties (42 instead of 40), yet the average path length drops from 2.895 to 2.347 steps.',
      'Clustering (transitivity) stays high: 0.441 against 0.500 in the ring. High clustering with short paths is what "small world" means (Watts and Strogatz).',
      'The four people at the ends of the shortcuts now have the highest betweenness.',
    ],
  },
  {
    id: 'class-friendships', kind: 'draw', title: 'Class friendships with majors',
    summary: 'Thirteen students in three majors; who is friends with whom. One has no friendships in the class yet.',
    lookFor: [
      'Groups, by major: 15 of the 18 friendships stay within a major, so the E-I index is (3 − 15) / 18 = −0.667 (−1 = all inside, +1 = all across).',
      'Assortativity by major is 0.750 (0 = no preference, 1 = only within), far above what random networks with the same number of ties per person give: friendship follows major (homophily).',
      'The three communities found in Network are exactly the three majors.',
      'Nora Quinn transferred in this term and has no friendships in the class yet: an isolate. Her contacts, betweenness and closeness are all 0, and she is a component on her own, so the network has 2 components. An isolate belongs to no community; it is still part of the network.',
    ],
  },
  {
    id: 'clubs-two-mode', kind: 'draw', title: 'Students and clubs (two-mode)',
    summary: 'Six students and the four clubs they belong to: a two-mode network, where ties run only between a student and a club.',
    lookFor: [
      'Network reads 10 nodes and 10 ties: 6 students and 4 clubs, every tie joining a student to a club. Two-mode density is 10 / (6 × 4) = 0.417.',
      'Two-mode degree divides by the size of the other mode: Dev Rao is in 2 of the 4 clubs (0.500) and Choir has 3 of the 6 students (0.500). Their plain degrees, 2 and 3, are not comparable.',
      'Two-mode betweenness (Borgatti-Everett): Cara Nunez 0.667 and Dev Rao 0.600 bridge the clubs. A student here can lie on at most 30 shortest routes between pairs; Cara lies on 20, and 20 / 30 = 0.667.',
      'Construction settings, Two-mode, project onto Students: Ana Silva and Ben Adler share 2 clubs, so their tie weighs 2; every other tie shares 1 club. In this projection Cara and Dev each have betweenness 0.600.',
      'Clustering is not applicable on the two-mode view (no two students are tied directly, so there are no triangles); two-mode clustering (Robins-Alexander) is 0.333.',
    ],
  },
  {
    id: 'ego-10', kind: 'ego', title: 'An ego network: you and 10 people',
    summary: 'One interview: family, college friends and coworkers, and who knows whom.',
    lookFor: [
      'Review shows size 10, density 0.267 (12 of the 45 pairs know each other), effective size 7.6 and constraint 0.292.',
      'Effective size by hand (Burt): 10 − 2 × 12 / 10 = 7.6. Every tie counts once, even for Ana, Kai and Lena, who are named under both questions.',
      '7.6 of the 10 contacts are non-redundant: the three settings barely know each other, so this person brokers between them.',
      'With 10 contacts constraint can only run from 0.100 (nobody knows anybody else) to 0.361 (everybody knows everybody). 0.292 sits high in that range because each setting is close-knit inside: compare constraint between people with similar numbers of contacts.',
    ],
  },
];

// Other names links may use: the Learn view's pair links open the first of
// the pair, whose notes point to the second.
const ALIASES = { 'path-and-star': 'path', 'ring-small-world': 'ring', 'two-teams': 'two-cliques-broker', 'class-majors': 'class-friendships', 'ego-ten': 'ego-10', 'two-mode': 'clubs-two-mode', clubs: 'clubs-two-mode' };

export function exampleById(id) { const k = ALIASES[id] || id; return EXAMPLES.find(x => x.id === k) || null; }

// ---- drawings -----------------------------------------------------------------

const node = (id, label, x, y, group = null, attrs = {}) => ({ id, label, x, y, group, attrs });
const ties = pairs => pairs.map(([s, t], i) => ({ id: 'x' + i, source: s, target: t, type: 'tie', weight: 1, directed: false }));
const clique = ids => ids.flatMap((a, i) => ids.slice(i + 1).map(b => [a, b]));

function twoTeams() {
  const eng = ['ava', 'ben', 'cai', 'dee'], prod = ['eli', 'fay', 'gus', 'ivy'];
  return {
    groups: [{ id: 'eng', name: 'Engineering' }, { id: 'prod', name: 'Product' }],
    nodes: [
      node('ava', 'Ava Lind', -170, -70, 'eng'), node('ben', 'Ben Ortiz', -300, -70, 'eng'),
      node('cai', 'Cai Mora', -170, 70, 'eng'), node('dee', 'Dee Patel', -300, 70, 'eng'),
      node('eli', 'Eli Brandt', 170, -70, 'prod'), node('fay', 'Fay Kim', 300, -70, 'prod'),
      node('gus', 'Gus Romero', 170, 70, 'prod'), node('ivy', 'Ivy Chen', 300, 70, 'prod'),
      node('hal', 'Hal Novak', 0, 0),
    ],
    edges: ties([...clique(eng), ...clique(prod), ['hal', 'ava'], ['hal', 'cai'], ['hal', 'eli'], ['hal', 'gus']]),
  };
}

function path() {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  return { nodes: ids.map((id, i) => node(id, id, -250 + i * 100, 0)), edges: ties(ids.slice(1).map((id, i) => [ids[i], id])) };
}

function star() {
  const leaves = ['L1', 'L2', 'L3', 'L4', 'L5'];
  return {
    nodes: [node('hub', 'Hub', 0, 0), ...leaves.map((id, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / leaves.length;
      return node(id, id, Math.round(150 * Math.cos(a)), Math.round(150 * Math.sin(a)));
    })],
    edges: ties(leaves.map(l => ['hub', l])),
  };
}

const RING_NAMES = ['Ada', 'Bo', 'Cy', 'Dot', 'Eve', 'Fin', 'Gil', 'Hana', 'Ike', 'Jun', 'Kit', 'Lou', 'Max', 'Nia', 'Oli', 'Pia', 'Quin', 'Rae', 'Sol', 'Tess'];

function ring(shortcuts = []) {
  const ids = RING_NAMES.slice(0, RING_N).map(s => s.toLowerCase());
  const nodes = ids.map((id, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / RING_N;
    return node(id, RING_NAMES[i], Math.round(260 * Math.cos(a)), Math.round(260 * Math.sin(a)));
  });
  const pairs = [];
  for (let i = 0; i < RING_N; i++) for (const d of [1, 2]) pairs.push([ids[i], ids[(i + d) % RING_N]]);
  for (const [a, b] of shortcuts) pairs.push([ids[a], ids[b]]);
  return { nodes, edges: ties(pairs) };
}

function classMajors() {
  const majors = [
    ['cs', 'CS', [['leo', 'Leo Park'], ['priya', 'Priya Shah'], ['sam', 'Sam Okoro'], ['mina', 'Mina Cho']]],
    ['econ', 'Economics', [['diego', 'Diego Ruiz'], ['farah', 'Farah Aziz'], ['ben', 'Ben Hall'], ['chloe', 'Chloe Martin']]],
    ['soc', 'Sociology', [['aisha', 'Aisha Bello'], ['emma', 'Emma Lund'], ['gabe', 'Gabe Turner'], ['omar', 'Omar Haddad']]],
  ];
  const nodes = [];
  majors.forEach(([gid, , people], g) => {
    // Spaced so names never collide at the zoom a laptop canvas allows.
    const cx = [-340, 340, 0][g], cy = [-120, -120, 170][g];
    people.forEach(([id, label], i) => nodes.push(node(id, label, cx + [-90, 90, -90, 90][i], cy + [-55, -55, 55, 55][i], gid)));
  });
  // An isolate: a Sociology transfer student with no friendships in the class yet,
  // beside her major's group.
  nodes.push(node('nora', 'Nora Quinn', 250, 225, 'soc'));
  return {
    groupKey: 'major',
    groups: majors.map(([id, name]) => ({ id, name })),
    nodes,
    edges: ties([
      ['leo', 'priya'], ['leo', 'sam'], ['priya', 'sam'], ['sam', 'mina'], ['priya', 'mina'],
      ['diego', 'farah'], ['diego', 'ben'], ['farah', 'chloe'], ['ben', 'chloe'], ['farah', 'ben'],
      ['aisha', 'emma'], ['aisha', 'gabe'], ['emma', 'omar'], ['gabe', 'omar'], ['emma', 'gabe'],
      ['mina', 'diego'], ['chloe', 'aisha'], ['leo', 'omar'],
    ]),
  };
}

// Two-mode: students (circles) tied to the clubs they belong to (squares).
// Cara (Choir and Drama) and Dev (Drama and Robotics) chain the clubs
// together; Chess and Choir share both Ana and Ben.
function clubs() {
  const students = [['ana', 'Ana Silva'], ['ben', 'Ben Adler'], ['cara', 'Cara Nunez'], ['dev', 'Dev Rao'], ['eli', 'Eli Moss'], ['fay', 'Fay Quinn']];
  const clubs = [['chess', 'Chess'], ['choir', 'Choir'], ['drama', 'Drama'], ['robotics', 'Robotics']];
  const nodes = [
    ...students.map(([id, label], i) => ({ ...node(id, label, -170, -250 + i * 100), mode: 0 })),
    ...clubs.map(([id, label], i) => ({ ...node(id, label, 170, -190 + i * 125), mode: 1 })),
  ];
  return {
    twoMode: { labels: ['Students', 'Clubs'] },
    nodes,
    edges: ties([['ana', 'chess'], ['ana', 'choir'], ['ben', 'chess'], ['ben', 'choir'], ['cara', 'choir'], ['cara', 'drama'],
      ['dev', 'drama'], ['dev', 'robotics'], ['eli', 'robotics'], ['fay', 'robotics']]),
  };
}

const DRAWINGS = {
  'clubs-two-mode': clubs,
  'two-cliques-broker': twoTeams, path, star,
  ring: () => ring(), 'small-world': () => ring([[0, RING_N / 2], [RING_N / 4, (3 * RING_N) / 4]]),
  'class-friendships': classMajors,
};

// The drawing for an example id; null for an unknown id or an ego example.
export function exampleDoc(id = 'two-cliques-broker') {
  const ex = exampleById(id);
  if (!ex || ex.kind !== 'draw') return null;
  const d = DRAWINGS[ex.id]();
  return validateDoc({
    version: 1, name: `Example: ${ex.title}`, example: ex.id,
    groups: d.groups || [], groupKey: d.groupKey, attrColumns: [], edgeTypes: ['tie'], ...(d.twoMode ? { twoMode: d.twoMode } : {}),
    nodes: d.nodes, edges: d.edges,
  }).doc;
}

// ---- the ego interview --------------------------------------------------------

// Ten people from three settings. Kai, Lena and Ana are named under both
// questions; the setting exceptions are one added pair (Ana knows Kai) and one
// removed pair (Raf and Zoe do not know each other).
export function exampleSession(id = 'ego-10', { now = Date.UTC(2026, 8, 1) } = {}) {
  const ex = exampleById(id);
  if (!ex || ex.kind !== 'ego') return null;
  let s = E.newSession({ egoLabel: 'You (example)', caseId: 'example', now });
  s = E.addGenerator(s, { preset: 'discuss', cap: 10 });
  s = E.addGenerator(s, { preset: 'social' });
  s = E.addInterpreter(s, { preset: 'relationship' });
  s = E.addInterpreter(s, { preset: 'closeness' });
  const people = [
    ['Mom', 'family', 5, ['discuss']], ['Dad', 'family', 4, ['discuss']], ['Ana', 'family', 5, ['discuss', 'social']],
    ['Kai', 'friend', 5, ['discuss', 'social']], ['Lena', 'friend', 4, ['discuss', 'social']], ['Raf', 'friend', 3, ['social']], ['Zoe', 'friend', 3, ['social']],
    ['Priya', 'coworker', 4, ['discuss']], ['Tom', 'coworker', 2, ['social']], ['Jo', 'coworker', 2, ['social']],
  ];
  const ids = new Map();
  for (const [name, rel, close, gens] of people) {
    for (const g of gens) {
      const r = E.addAlter(s, name, g);
      s = r.session;
      ids.set(name, r.alter.id);
    }
    s = E.setInterpreter(s, ids.get(name), 'relationship', rel);
    s = E.setInterpreter(s, ids.get(name), 'closeness', String(close));
  }
  const settings = [['Family', ['Mom', 'Dad', 'Ana']], ['College', ['Kai', 'Lena', 'Raf', 'Zoe']], ['Work', ['Priya', 'Tom', 'Jo']]];
  for (const [name, members] of settings) {
    s = E.addContext(s, name, { fromAnswers: false });
    const c = s.contexts[s.contexts.length - 1];
    for (const m of members) s = E.assignContext(s, ids.get(m), c.id, true);
  }
  s = E.setTie(s, ids.get('Ana'), ids.get('Kai'), true);
  s = E.setTie(s, ids.get('Raf'), ids.get('Zoe'), false);
  return { ...s, protocolName: `Example: ${ex.title}`, example: ex.id, step: 'review' };
}
