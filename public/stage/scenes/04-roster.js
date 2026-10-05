/* Chapter 4. How do you survey a whole group, and what is a tie when two people disagree?
   Build > Roster with a fictional seminar of eight students: the share link,
   one respondent's view (a second browser window), eight fictional responses
   combined; then the worked example "Class friendships with majors" for
   homophily. Names are fictional. */
(function () {
  var CLASS = ['Amara Okoye', 'Ben Hollis', 'Chloe Tran', 'Diego Alvarez', 'Elena Petrova', 'Farah Haddad', 'Gabe Lindqvist', 'Hana Sato'];
  // Who names whom as a friend (fictional answers): some named back, some not.
  var NAMES = { p1: ['p2', 'p3', 'p5'], p2: ['p1', 'p4'], p3: ['p1', 'p5', 'p6'], p4: ['p2', 'p7'], p5: ['p3', 'p8'], p6: ['p3', 'p7', 'p8'], p7: ['p4', 'p6'], p8: ['p6'] };
  var SHARE = { id: 's-seminar', createdAt: '2026-09-14T15:00:00.000Z', title: 'Friendships in our seminar', intro: 'For our session on networks. Answer for yourself; it takes a minute.' };
  function model(withShare) {
    return {
      version: 1, name: 'Seminar friendships',
      people: CLASS.map(function (n, i) { return { id: 'p' + (i + 1), label: n, attrs: {} }; }),
      attrColumns: [],
      relations: [{ id: 'r-friend', name: 'Friendship', question: 'Whom in this seminar do you consider a personal friend?', scale: 'binary', max: 5, fields: [] }],
      mode: 'multi', ties: {}, tieAttrs: {}, responses: null, mergeRule: 'union',
      share: withShare ? { id: SHARE.id, createdAt: SHARE.createdAt, title: SHARE.title, intro: SHARE.intro } : undefined,
    };
  }
  var KEY = 'orgsignal.build.roster';
  function rosterSetup(withShare, step) {
    return [
      A.load({ clear: true }),
      A.js(function () {
        localStorage.setItem(KEY, JSON.stringify(model(withShare)));
        localStorage.setItem('orgsignal.build.tab', JSON.stringify('roster'));
        Object.keys(localStorage).forEach(function (k) { if (/^orgsignal\.respond\./.test(k)) localStorage.removeItem(k); });
      }, 'roster model'),
      A.go('build'), A.remount(), A.click('#obtab-roster', { noScroll: true }),
      step ? A.click('.ob-steps button|' + step, { noScroll: true }) : [],
      A.scrollTop(),
    ];
  }
  async function surveyDef(ctx) {
    var S = await ctx.B.imp('../app/src/builders/share.js');
    return S.surveyFromRoster(model(true), { id: SHARE.id, title: SHARE.title, intro: SHARE.intro, createdAt: SHARE.createdAt });
  }
  async function shareURL(ctx) {
    var S = await ctx.B.imp('../app/src/builders/share.js');
    var def = await surveyDef(ctx);
    return S.surveyLink(def, new URL('../app/index.html', location.href).href).url;
  }
  // The eight responses as the text each respondent would email back.
  async function responsesText(ctx) {
    var S = await ctx.B.imp('../app/src/builders/share.js');
    var def = await surveyDef(ctx);
    return Object.keys(NAMES).map(function (pid, i) {
      var ans = {}; NAMES[pid].forEach(function (q) { ans[q] = { value: 1 }; });
      var label = CLASS[+pid.slice(1) - 1];
      return S.responseToText(S.makeResponse(def, { personId: pid, label: label }, { 'r-friend': ans }, { now: Date.UTC(2026, 8, 15, 9, i * 7) }));
    }).join('\n');
  }
  var pasteAll = A.js(async function (ctx) {
    var text = await responsesText(ctx);
    var el = await ctx.need('#ob-roster-resp-paste');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    ctx.setValue(el, text); ctx.ev(el, 'input');
  }, 'paste responses');
  function respondedSetup() {
    return [rosterSetup(true, 'Collect ties'), pasteAll, A.click('button|Read the pasted responses', { noScroll: true }), A.scrollTop()];
  }

  SCENE(4, [
    {
      id: 'roster-setup', try: { href: 'https://orgsignal.graystoneindustries.co/#build?example=class-friendships', label: 'Build › Draw › Class friendships with majors' }, label: 'Surveying a whole group',
      question: 'How do you survey a whole group, and what is a tie when two people disagree?',
      heading: 'A bounded network starts from a roster.',
      setup: rosterSetup(false, 'Roster'),
      phases: [
        { note: 'Build > Roster: the steps (roster, relations, collect ties, review); the roster of eight students in a fictional seminar',
          do: [A.cursor('#obtab-roster'), A.scroll('.ob-steps', { top: 100 }), A.highlight('#obpanel-roster table, #obpanel-roster .tbl', 'The roster: everyone in the group', { pad: 6 })], facts: { roster: '#obpanel-roster' } },
        { note: 'Relations: Friendship, with the question each student will answer',
          do: [A.click('.ob-steps button|Relations'), A.highlight('#obpanel-roster .tbl', 'One relation, one question', { pad: 6 })], facts: { relations: '#obpanel-roster .tbl' } },
        { note: 'Collect ties: who answers. One informant could fill the grid; here each member answers a survey',
          do: [A.click('.ob-steps button|Collect ties'), A.click('button|Each member answers a survey'), A.highlight('fieldset|~Who answers', null, { pad: 6 })] },
        { note: 'Make a share link: the survey travels inside the link; nothing is uploaded',
          do: [A.click('button|Make a share link'), A.scroll('#ob-roster-share-url', { top: 220 }), A.highlight('#ob-roster-share-url', 'The share link', { pad: 6 })], facts: { share: '.ob-share' } },
        { note: 'The privacy note under the link: respondents see names only; answers stay on their device until they send them',
          do: [A.highlight('.ob-share .ob-note|~The link carries only', null, { pad: 8 })], facts: { note: '.ob-share .ob-note|~The link carries only' } },
      ],
    },
    {
      id: 'roster-respondent', label: 'The respondent\'s side',
      heading: 'Each person answers for themselves, about everyone on the roster.',
      setup: rosterSetup(true, 'Collect ties').concat([A.scroll('#ob-roster-share-url', { top: 220 })]),
      phases: [
        { note: 'A second window: the share link opened as a respondent would, the survey only, with the privacy promise',
          do: [A.highlight('#ob-roster-share-url', null, { pad: 6 }), A.pip(shareURL, { title: 'A respondent\'s browser: the share link' }), A.highlight({ css: '.view__head', frame: 'pip' }, null, { pad: 6 })],
          facts: { respondent: { css: '#main', frame: 'pip' } } },
        { note: 'Step 1, who are you: Chloe Tran types and picks her own name',
          do: [A.type({ css: '#rs-who', frame: 'pip' }, 'Chloe'), A.click({ css: '[role=option]', text: 'Chloe Tran', frame: 'pip' }), A.highlight({ css: '.rs-me', frame: 'pip' }, null, { pad: 6 })] },
        { note: 'Step 2, the friendship question: Chloe ticks Amara Okoye, Elena Petrova and Farah Haddad',
          do: [A.click({ css: '.btn--primary', text: 'Next', frame: 'pip' }),
            A.click({ css: '.rs-person', text: 'Amara Okoye', frame: 'pip' }), A.click({ css: '.rs-person', text: 'Elena Petrova', frame: 'pip' }), A.click({ css: '.rs-person', text: 'Farah Haddad', frame: 'pip' }),
            A.highlight({ css: '.rs-people', frame: 'pip' }, null, { pad: 6 })], facts: { answers: { css: '.rs-people', frame: 'pip' } } },
        { note: 'Finish: her answers in words, and a response file to send back (or the same as text for an email)',
          do: [A.click({ css: '.btn--primary', text: 'Finish', frame: 'pip' }), A.highlight({ css: '.ob-kv, dl', frame: 'pip' }, 'What she is sending', { pad: 6 })], facts: { summary: { css: '#main', frame: 'pip' } } },
        { note: 'The respondent window closes; back with the organizer, a place to read the response files or pasted text',
          do: [A.pipClose(), A.scroll('h3|2. Collect the responses', { top: 120 }), A.highlight('#ob-roster-resp-paste', 'Responses come back here', { pad: 6 })] },
      ],
    },
    {
      id: 'roster-combine', label: 'Combining the answers',
      heading: 'A reported tie is directed; reciprocation is a choice.',
      setup: rosterSetup(true, 'Collect ties').concat([A.scroll('h3|2. Collect the responses', { top: 120 })]),
      phases: [
        { note: 'Eight responses pasted from email, one block per student',
          do: [pasteAll, A.highlight('#ob-roster-resp-paste', 'Eight responses', { pad: 6 })] },
        { note: 'Read the pasted responses: who responded, who did not, anything rejected',
          do: [A.click('button|Read the pasted responses'), A.highlight('.ob-notes', null, { pad: 8 })], facts: { notes: '.ob-notes' } },
        { note: 'Combine the self-reports: union (either says so), reciprocated only (both say so), or as reported (directed)',
          do: [A.scroll('fieldset|~Combine the self-reports', { top: 120 }), A.highlight('fieldset|~Combine the self-reports', null, { pad: 6 })], facts: { rules: 'fieldset|~Combine the self-reports' } },
        { note: 'Review with union: the friendship ties, reciprocated pairs and one-sided pairs',
          do: [A.click('.ob-steps button|Review'), A.highlight('#obpanel-roster .tbl', 'Union', { pad: 6 })], facts: { review: '#obpanel-roster .tbl', kind: '#obpanel-roster .ob-kv' } },
        { note: 'Back to Collect ties: switch the rule to reciprocated only',
          do: [A.click('.ob-steps button|Collect ties'), A.scroll('fieldset|~Combine the self-reports', { top: 120 }), A.click('label.radio|Reciprocated only'), A.highlight('label.radio|Reciprocated only', null, { pad: 4 })] },
        { note: 'Review with reciprocated only: fewer ties; only pairs who both named each other remain',
          do: [A.click('.ob-steps button|Review'), A.highlight('#obpanel-roster .tbl', 'Reciprocated only', { pad: 6 })], facts: { review: '#obpanel-roster .tbl', kind: '#obpanel-roster .ob-kv' } },
        { note: 'Analyze this network: the reciprocated friendship network in Network',
          do: [A.click('button|Analyze this network', { map: true }), A.dismiss(), A.highlight('.view__intro', null, { pad: 8 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
      ],
    },
    {
      id: 'class-majors', label: 'Friendship and majors',
      heading: 'Homophily: ties form more often between similar people.',
      setup: [A.load({ clear: true }), A.load({ example: 'class-friendships' }), A.scroll('svg[role=application]', { top: 40 })],
      phases: [
        { note: 'Build > Draw, worked example "Class friendships with majors": thirteen students, three majors drawn as groups; Nora Quinn has no friendships',
          do: [A.click('#obpanel-draw .btn--sm|=+', { noScroll: true }), A.click('#obpanel-draw .btn--sm|=+', { noScroll: true }), A.highlight('svg[role=application]', 'Thirteen students, three majors', { pad: 2 })], facts: { drawing: '.ob-kv', lookFor: '.ob-example' } },
        { note: 'Analyze: Network colored by the group (major); most ties stay inside a major',
          do: [A.scrollTop(), A.click('button|Analyze this network', { map: true }), A.dismiss(), A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { header: '.view__intro', legend: '.net-legend' } },
        { note: 'Color by community instead: the communities found are exactly the three majors',
          do: [A.select('Color by', 'Community', { map: true }), A.highlight('.net-legend', null, { pad: 6 })], facts: { legend: '.net-legend', summary: '.net-summary' } },
        { note: 'Nora Quinn, found by name: no friendships in the class yet; contacts, betweenness and closeness all 0, an isolate',
          do: [A.type('#net-search', 'Nora'), A.click('[role=option]|Nora Quinn', { map: true }), A.scroll('.split__side', { top: 90 }), A.highlight('.split__side', 'An isolate', { pad: 6 })], facts: { selection: '.split__side' } },
        { note: 'Whole network: 2 components, Nora on her own; she belongs to no community but is still in the network',
          do: [A.js(function (ctx) { ctx.store.actions.select([]); }), A.click('.net__zoom button[aria-label^="Fit"]', { after: 600 }), A.scroll('.net-summary', { top: 70 }), A.highlight('.net-summary .metric-row|~Components', 'Components', { pad: 6 })], facts: { summary: '.net-summary' } },
        { note: 'The worked example card: 15 of 18 friendships inside a major',
          do: [A.scroll('.standout__example', { top: 120 }), A.highlight('.standout__example', 'What to look for', { pad: 8 })], facts: { lookFor: '.standout__example' } },
      ],
    },
    {
      id: 'class-homophily', label: 'Homophily against chance',
      heading: 'Compare with random networks, not with zero.',
      setup: [A.example('class-friendships'), A.go('groups'), A.select('Groups from', 'Major'), A.scrollTop()],
      phases: [
        { note: 'Groups, groups from Group (the major): the reading at the top',
          do: [A.highlight('label.field|Groups from', null, { pad: 6 }), A.highlight('section[aria-labelledby=reading-h]', null, { pad: 6 })], facts: { reading: '#main' } },
        { note: 'Assortativity by major 0.750 against random networks with the same ties per person',
          do: [A.zoom('.verdict__plain|~Assortativity', { pad: 30, max: 2 }), A.highlight('.verdict__plain|~Assortativity', null, { pad: 6, noScroll: true })], facts: { assortativity: '.verdict__plain|~Assortativity' } },
        { note: 'The E-I index -0.667 and what random networks give for groups of these sizes',
          do: [A.zoom('.verdict__plain|~Overall', { pad: 30, max: 2 }), A.highlight('.verdict__plain|~Overall', null, { pad: 6, noScroll: true })], facts: { ei: '.verdict__plain|~Overall' } },
        { note: 'The group table: ties within and across each major, E-I per group and E-I if random',
          // the 11 px column headings set the size here: frame at 1.95x
          do: [A.unzoom(), A.scroll('#gt-h', { top: 100 }), A.highlight('table', null, { pad: 6 })], frame: { min: 1.95 }, facts: { table: 'table' } },
        { note: 'The mixing matrix: rows send, columns receive; the diagonal holds most of the ties',
          do: [A.scroll('#mx-h', { top: 100 }), A.highlight('section[aria-labelledby=mx-h]', null, { pad: 6 })], facts: { matrix: '#main' } },
      ],
    },
  ]);
})();
