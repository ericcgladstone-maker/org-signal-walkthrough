/* Chapter 6. What is a tie, really?
   The generated Slack workplace (seed 7) under three constructions: replies
   only; the default; everything including reactions. Then one tie traced back
   to its messages. */
(function () {
  var WORLD = { generate: WORLDS.slack };
  var world = [A.load(WORLD), A.go('network'), A.select('Color by', 'Department', { noScroll: true, map: true }), A.scrollTop()];
  var openDrawer = A.click('button|Construction settings', { noScroll: true });
  // Rebuild notices stay up while the passage is read (the app pauses its
  // notice timers while a person is reading one; the talk does the same).
  var holdNotices = A.js(function (ctx) { ctx.store.actions.pauseNotices && ctx.store.actions.pauseNotices(); }, 'hold notices');
  var apply = [A.click('.drawer__foot button|Apply and rebuild'), A.idle(300), holdNotices];
  function toggle(name) { return A.click('.drawer label.check|' + name); }

  SCENE(6, [
    {
      id: 'construction', try: { href: 'https://orgsignal.graystoneindustries.co/#generate', label: 'Generate the workplace, then Network › Construction settings' }, label: 'Construction settings',
      question: 'What is a tie, really?',
      heading: 'A tie is a rule applied to records.',
      setup: world,
      phases: [
        { note: 'The Network header for the generated Slack workplace: 120 people and the ties built by the default rules',
          do: [A.highlight('.view__intro', null, { pad: 8 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
        { note: 'Construction settings open: the rules that turn messages into ties, each with its count of evidence',
          do: [openDrawer, A.highlight('.drawer .section', 'Rules with evidence in this data', { pad: 4 })], facts: { rules: '.drawer .section' } },
        { note: 'Replies, mentions, direct messages and reactions are all on by default, each with its count of evidence',
          do: [A.zoom('.drawer .section', { pad: 16, max: 1.9 })] },
        { note: 'Ties: direction, tie weight (count of evidence), minimum weight, and the broadcast cutoff at 25 recipients',
          do: [A.unzoom(), A.scrollIn('.drawer__body', { css: '.drawer .section', nth: 1 }), A.highlight({ css: '.drawer .section', nth: 1 }, null, { pad: 4, noScroll: true })], facts: { ties: '.drawer' } },
        { note: 'Bots: accounts marked as bots, left out of the network',
          do: [A.scrollIn('.drawer__body', { css: '.drawer .section', last: true }), A.highlight({ css: '.drawer .section', last: true }, null, { pad: 4, noScroll: true })] },
      ],
    },
    {
      id: 'replies-only', label: 'Replies only',
      heading: 'A stricter rule keeps fewer ties.',
      setup: world,
      phases: [
        { note: 'Construction settings: mentions, direct messages and reactions switched off, so only replies make ties',
          do: [openDrawer, toggle('Mentions'), toggle('Direct messages'), toggle('Reactions'), A.highlight('.drawer .section', 'Replies only', { pad: 4 })] },
        { note: 'Apply and rebuild: the notice says what changed, ties and communities before and after',
          do: apply.concat([A.highlight('.notices', 'What the rebuild changed', { pad: 6, noScroll: true })]), facts: { notice: '.notices' } },
        { note: 'The header and Who stands out under replies only',
          do: [A.highlight('.view__intro', null, { pad: 8 }), A.highlight('.standout__list', null, { pad: 8 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
        { note: 'People sorted by betweenness under replies only: the top five',
          do: [A.nav('People'), A.sort('Betweenness'), A.scroll('.vt__head', { top: 200 }), A.highlight([{ css: '.vt__row', nth: 0 }, { css: '.vt__row', nth: 4 }], 'Top five, replies only', { pad: 4 }), A.tableCallout(5, 'Top 5 by betweenness, replies only')], frame: { fit: true }, facts: { table: '[role=grid], .vt' } },
      ],
    },
    {
      id: 'replies-mentions', label: 'Replies and mentions',
      heading: 'Each rule says what counts as a relationship.',
      setup: world,
      phases: [
        { note: 'Construction settings: direct messages and reactions off; replies and mentions count',
          do: [openDrawer, toggle('Direct messages'), toggle('Reactions'), A.highlight('.drawer .section', 'Replies and mentions', { pad: 4 })] },
        { note: 'Apply and rebuild: the notice reports the change against the default construction',
          do: apply.concat([A.highlight('.notices', 'What the rebuild changed', { pad: 6, noScroll: true })]), facts: { notice: '.notices' } },
        { note: 'The header and Who stands out with replies and mentions',
          do: [A.highlight('.view__intro', null, { pad: 8 }), A.highlight('.standout__list', null, { pad: 8 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
        { note: 'People sorted by betweenness with replies and mentions: the top five',
          do: [A.nav('People'), A.sort('Betweenness'), A.scroll('.vt__head', { top: 200 }), A.highlight([{ css: '.vt__row', nth: 0 }, { css: '.vt__row', nth: 4 }], 'Top five, replies and mentions', { pad: 4 }), A.tableCallout(5, 'Top 5 by betweenness, replies and mentions')], frame: { fit: true }, facts: { table: '[role=grid], .vt' } },
      ],
    },
    {
      id: 'everything', label: 'Everything, reactions included',
      heading: 'Reactions add weight here, not new ties.',
      setup: world.concat([A.go('people'), A.sort('Betweenness'), A.scroll('.vt__head', { top: 200 })]),
      phases: [
        { note: 'The default construction counts everything: replies, mentions, direct messages and reactions. People by betweenness, the top five',
          do: [A.highlight([{ css: '.vt__row', nth: 0 }, { css: '.vt__row', nth: 4 }], 'Top five, everything', { pad: 4 }), A.tableCallout(5, 'Top 5 by betweenness, everything')], frame: { fit: true }, facts: { table: '[role=grid], .vt' } },
        { note: 'Construction settings: reactions switched off, to see what they contribute',
          do: [A.nav('Network'), openDrawer, toggle('Reactions'), A.highlight('.drawer .rule-row|~Reactions', 'Reactions', { pad: 4 })] },
        { note: 'Apply and rebuild: the same ties, with less weight; every reaction here sits on a pair that already exchanged messages',
          do: apply.concat([A.highlight('.notices', 'What the rebuild changed', { pad: 6, noScroll: true })]), facts: { notice: '.notices', header: '.view__intro' } },
        { note: 'People by betweenness without reactions: the ranking under different weights',
          do: [A.nav('People'), A.sort('Betweenness'), A.scroll('.vt__head', { top: 200 }), A.highlight([{ css: '.vt__row', nth: 0 }, { css: '.vt__row', nth: 4 }], 'Top five, without reactions', { pad: 4 }), A.tableCallout(5, 'Top 5 by betweenness, without reactions')], frame: { fit: true }, facts: { table: '[role=grid], .vt' } },
      ],
    },
    {
      id: 'tie-evidence', label: 'A tie and its evidence',
      heading: 'Every tie can be traced to the messages behind it.',
      setup: world,
      phases: [
        { note: 'Tove Delacroix selected from Who stands out: her ties on the map; contacts, betweenness and constraint in the side panel',
          do: [A.click('.standout__name|Tove Delacroix', { map: true }), A.scroll('.split__side .metric-row|~Contacts', { top: 160 }),
            A.highlight(['.split__side .metric-row|~Contacts', '.split__side .metric-row|~Constraint'], 'Tove Delacroix', { pad: 6 })], facts: { selection: '.split__side' } },
        { note: 'Her ties listed with their weights, strongest first',
          do: [A.click('.split__side button|~Show all', { noScroll: true }), A.highlight('.net-ties', 'Her ties', { pad: 6 })], facts: { ties: '.net-ties' } },
        { note: 'One tie opened: the evidence behind it, message by message (replies, mentions, direct messages)',
          do: [A.click({ css: '.net-ties__btn', text: 'Wes Corrigan', mode: 'has' }), A.idle(400), A.scroll('.net-evidence', { top: 160 }), A.highlight('.net-evidence', 'The evidence for one tie', { pad: 6 })],
          facts: { evidence: '.net-evidence' } },
        { note: 'The first messages close up: when, where, which rule, and the text',
          do: [A.zoom([{ css: '.net-evidence > li', nth: 0 }, { css: '.net-evidence > li', nth: 2 }], { pad: 16, max: 2.2 })] },
      ],
    },
  ]);
})();
