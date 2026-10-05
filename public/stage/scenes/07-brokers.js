/* Chapter 7. Who are the brokers, and how sure can we be?
   The generated bridge-dependent workplace (seed 7): the map by department,
   rankings, rank stability under resampling, comparison with random
   networks, the recovery check against the planted brokers, and fragility. */
(function () {
  var world = [A.load({ generate: WORLDS.slack }), A.go('network'), A.select('Color by', 'Department', { noScroll: true, map: true }), A.scrollTop()];

  SCENE(7, [
    {
      id: 'broker-map', try: { href: 'https://orgsignal.graystoneindustries.co/#generate', label: 'Generate the workplace, then People › Betweenness' }, label: 'The map by department',
      question: 'Who are the brokers, and how sure can we be?',
      heading: 'Brokers sit where departments meet.',
      setup: world.concat([A.select('Color by', 'Department', { noScroll: true, map: true }), A.scrollTop()]),
      phases: [
        { note: 'Network: 120 people; the generated banner (recovery check summary) and Who stands out',
          do: [A.highlight('.view__intro', null, { pad: 8 }), A.highlight('.net-banner', null, { pad: 6 })], facts: { header: '.view__intro', banner: '.net-banner', standouts: '.standout__list' } },
        { note: 'The map colored by department: eight departments, each a cluster, with a few people between them',
          do: [A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { legend: '.net-legend' } },
        { note: 'The legend: department sizes; Operations largest, one Executive',
          do: [A.highlight('.net-legend', null, { pad: 6 })] },
        { note: 'Who stands out: most contacts, most often between others (Tove Delacroix), closest to everyone',
          do: [A.scrollTop(), A.highlight('.standout__list', null, { pad: 8 })], facts: { standouts: '.standout__list' } },
        { note: 'Tove Delacroix picked: her ties reach into several departments',
          do: [A.click('.standout__name|Tove Delacroix', { map: true }), A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { selection: '.split__side' } },
      ],
    },
    {
      id: 'broker-ranking', label: 'Ranking by betweenness',
      heading: 'A ranking is a description of this network, not a verdict on people.',
      setup: world.concat([A.go('people')]),
      phases: [
        { note: 'People sorted by betweenness: the top of the list',
          do: [A.sort('Betweenness'), A.scroll('.vt__head', { top: 200 }), A.highlight([{ css: '.vt__row', nth: 0 }, { css: '.vt__row', nth: 6 }], 'Top seven by betweenness', { pad: 4 }), A.tableCallout(7, 'Top 7 by betweenness')], frame: { fit: true }, facts: { table: '[role=grid], .vt' } },
        { note: 'The "Left?" flag on Ludmila Nakamura: her account was deactivated; her history still counts',
          do: [A.highlight('.vt__row|~Ludmila Nakamura', 'Deactivated account', { pad: 4 })] },
        { note: 'Tove Delacroix\'s profile, scrolled to Measures: each value with its rank of 120, and the betweenness note with this network\'s denominator',
          do: [A.click('.vt__row|~Tove Delacroix'), A.scrollIn('.split__side', '.split__side .metric-row|~Betweenness', { top: 10 }),
            A.highlight('.split__side .metric-row|~Betweenness', 'Betweenness: rank and denominator', { pad: 6 })], facts: { profile: '.split__side' } },
        { note: 'Interpretation of a ranking, opened: definition, scale, in this network, caution',
          do: [A.open('#main details.howto'), A.scroll('#main details.howto', { top: 300 }), A.highlight('#main details.howto[open]', null, { pad: 6 })], facts: { howto: '#main details.howto[open]' } },
      ],
    },
    {
      id: 'rank-stability', label: 'How stable is the ranking?',
      heading: 'Resampling asks whether the ranking survives small changes in the data.',
      setup: world.concat([A.go('people'), A.sort('Betweenness'), A.scrollTop()]),
      phases: [
        { note: 'Check how stable the betweenness ranking is: the data resampled many times, the ranking recomputed each time',
          do: [A.click('button|~Check how stable', { ifPresent: true }), A.idle(500), A.scroll('.stab', { top: 140 }), A.highlight('.stab', 'Rank stability', { pad: 6 })], facts: { stability: '.stab__list' } },
        { note: 'Each person\'s rank range across the resamples, and how often they make the top',
          do: [A.zoom('.stab', { pad: 20, max: 1.8 }), A.tableCallout(5, 'In the top 10 of the resamples', { col: 'In top', at: [1240, 820] })],
          facts: { intop: '.vt' } },
        { note: 'The reading in words: who is settled at their rank, and the caution about Ludmila Nakamura, who left during the data',
          do: [A.unzoom(), A.highlight(['.stab__verdict', 'details.stab > p.basis'], null, { pad: 6 })],
          facts: { verdict: '.stab__verdict', basis: 'details.stab > p.basis' } },
      ],
    },
    {
      id: 'vs-random', label: 'Different from chance?',
      heading: 'Random networks with the same degrees are the baseline.',
      setup: world,
      phases: [
        { note: 'Whole network: transitivity highlighted first (the informative one here), with modularity, density, reciprocity and clustering around it',
          do: [A.scroll('.net-summary', { top: 70 }), A.highlight('.net-summary .metric-row|~Transitivity', 'Transitivity', { pad: 6 }),
            A.highlight('.net-summary', null, { pad: 6, soft: true, noFrame: true })], facts: { summary: '.net-summary' } },
        { note: 'Compare with random networks: the same people and numbers of ties, connected at random; transitivity\'s verdict first',
          do: [A.click('button|Compare with random networks'), A.idle(600), A.scroll('.net-summary .metric-row|~Transitivity', { top: 140 }),
            A.highlight('.net-summary .metric-row|~Transitivity', 'Transitivity against random networks', { pad: 6 })], facts: { summary: '.net-summary' } },
        { note: 'Transitivity against random networks: friends of friends tied far more often than chance',
          do: [A.zoom('.net-summary .metric-row|~Transitivity', { pad: 20, max: 2 })] },
        { note: 'Modularity against random networks: the communities are real structure',
          do: [A.zoom('.net-summary .metric-row|~Modularity', { pad: 20, max: 2 })] },
      ],
    },
    {
      id: 'recovery-check', label: 'The recovery check',
      heading: 'Known structure tests the method, not the organization.',
      setup: world.concat([A.go('generate'), A.waitFor('.ob-recovery'), A.scroll('.ob-recovery', { top: 90 })]),
      phases: [
        { note: 'Recovery check: the generated world\'s ground truth against what the analysis found; 9 of 9 planted features recovered',
          do: [A.highlight('.ob-recovery', null, { pad: 6 })], facts: { recovery: '.ob-recovery' } },
        { note: 'How verdicts are given: recovered, partly, missed, and the chance baselines',
          do: [A.zoom('.ob-recovery p.ob-note:has(> strong)', { pad: 24, max: 1.9 })] },
        { note: 'Planted brokers rank high on betweenness: 7 of the 7 planted brokers are the 7 with the highest betweenness',
          do: [A.unzoom(), A.scroll('.ob-checks li|~Planted brokers', { top: 100 }), A.highlight('.ob-checks li|~Planted brokers', null, { pad: 6 })], facts: { brokers: '.ob-checks li|~Planted brokers' } },
        { note: 'The planted brokers and their betweenness ranks, 1 to 7',
          do: [A.zoom('.ob-brokers', { pad: 20, max: 1.9 })], facts: { table: '.ob-brokers' } },
        { note: 'Planted departments against detected communities, and measured against true betweenness',
          do: [A.unzoom(), A.scroll('.ob-checks li|~Planted departments', { top: 100 }), A.highlight(['.ob-checks li|~Planted departments', '.ob-checks li|~Measured betweenness'], null, { pad: 6 })], facts: { communities: '.ob-checks li|~Planted departments', truth: '.ob-checks li|~Measured betweenness' } },
        // C3: the export recorded every interaction, so the network as built is the true network. A stricter
        // construction loses ties; re-running the check shows what that costs the broker recovery.
        { note: 'Construction switched to replies only (mentions, direct messages and reactions off), then the recovery check run again: the planted brokers recovered less well',
          hold: true,   // several steps (drawer, rebuild, re-run the check): playback waits for them
          do: [A.nav('Network'), A.click('button|Construction settings', { noScroll: true }),
            A.click('.drawer label.check|Mentions'), A.click('.drawer label.check|Direct messages'), A.click('.drawer label.check|Reactions'),
            A.click('.drawer__foot button|Apply and rebuild'), A.idle(300), A.dismiss(),
            A.nav('Generate'), A.waitFor('.ob-recovery'),
            A.click('.ob-recovery .ob-warn button'),
            A.waitFor(function (ctx) { var g = ctx.store.get().generated; return !!(g && g.recovery && g.recoverySettings && g.recoverySettings.rules && g.recoverySettings.rules.mention && g.recoverySettings.rules.mention.on === false && !ctx.find('.ob-recovery p[role=status]')); }, { timeout: 120000 }),
            A.scroll('.ob-checks li|~Planted brokers', { top: 120 }),
            A.highlight('.ob-checks li|~Planted brokers', 'Replies only', { pad: 6 })],
          facts: { summary: '.ob-recovery .ob-text strong', settings: '.ob-recovery > p.ob-note:nth-of-type(3)', brokers: '.ob-checks li|~Planted brokers', table: '.ob-brokers' } },
      ],
    },
    {
      id: 'fragility', label: 'If the brokers left',
      heading: 'Fragility shows in longer routes, not only in pieces.',
      setup: world.concat([A.select('Color by', 'Department', { noScroll: true, map: true }), A.scroll('.net-frag', { top: 90 })]),
      phases: [
        { note: 'Is brokerage concentrated in a few people? The top 5 by betweenness and their share of all betweenness',
          do: [A.highlight('.net-frag', null, { pad: 6 })], facts: { fragility: '.net-frag' } },
        { note: 'Top 10 instead: the share they hold',
          do: [A.select('Top', '10'), A.highlight('.net-frag .verdict', null, { pad: 6 })], facts: { fragility: '.net-frag' } },
        { note: 'What if these people left? The network without them: ties, ties across departments, pieces, average steps',
          do: [A.click('button|~What if these'), A.highlight('.net-frag__table', null, { pad: 6 })], facts: { whatif: '.net-frag__table' } },
        { note: 'The table close up, with its caution: a what-if on this network, not a forecast',
          do: [A.zoom('.net-frag__table', { pad: 30, max: 1.9 })] },
      ],
    },
  ]);
})();
