/* Chapter 3. What does my own network look like: closed or brokering?
   Build > Ego network with the worked example ego-10 (a fictional respondent). */
SCENE(3, [
  {
    id: 'ego-interview', try: { href: 'https://orgsignal.graystoneindustries.co/#build?example=ego-10', label: 'Build › Ego network › the worked example' }, label: 'An ego network interview',
    question: 'What does my own network look like: closed or brokering?',
    heading: 'An ego network is one person\'s view of the people around them.',
    setup: [A.load({ clear: true }), A.load({ example: 'ego-10' }), A.click('button|Collect names', { noScroll: true }), A.scrollTop()],
    phases: [
      { note: 'Build > Ego network: one respondent, interviewed here; the steps of the interview across the top',
        do: [A.cursor('#obtab-ego'), A.highlight('#obpanel-ego .ob-subhead', null, { pad: 8 })], facts: { lede: '#obpanel-ego .ob-subhead' } },
      { note: 'Collect names: two name generators, "important matters" and "socializing", and the people named under each',
        do: [A.scroll('#obpanel-ego h3, #obpanel-ego .ob-h', { top: 100 }), A.highlight('#obpanel-ego .ob-stack', 'Name generators', { pad: 6, noScroll: true })], facts: { names: '#obpanel-ego' } },
      { note: 'Describe: the name interpreters, the same questions about each person named (relationship, closeness, how often)',
        do: [A.click('button|Describe'), A.scrollTop(), A.scroll('#ego-step-title', { top: 80 }), A.highlight(['#ego-step-title', '#obpanel-ego .ob-navrow'], 'Name interpreters', { pad: 6, noScroll: true })], facts: { describe: '#obpanel-ego' } },
      { note: 'Who knows whom: the respondent says which of the people named know each other',
        do: [A.click('button|Who knows whom'), A.scrollTop(), A.scroll('#ego-step-title', { top: 80 }), A.highlight(['#ego-step-title', '#obpanel-ego .ob-navrow'], 'Ties among the people named', { pad: 6, noScroll: true })], facts: { ties: '#obpanel-ego' } },
      { note: 'Review and export: the ego network measured: size, density, effective size and constraint',
        do: [A.click('button|Review and export'), A.scrollTop(), A.scroll('dl.ego-measures__list', { top: 200 }), A.highlight('dl.ego-measures__list', 'This ego network', { pad: 8 })], facts: { review: '#obpanel-ego' } },
    ],
  },
  {
    id: 'ego-review', label: 'Closure or brokerage',
    heading: 'Effective size and constraint say how redundant the contacts are.',
    setup: [A.load({ clear: true }), A.load({ example: 'ego-10' }), A.scrollTop()],
    phases: [
      { note: 'The reading: "Brokering": most of the people named do not know each other',
        do: [A.scroll('dl.ego-measures__list', { top: 330 }), A.highlight('.ob-ego-reading, .ob-verdict, .verdict', 'The reading', { pad: 8 })], facts: { reading: '#obpanel-ego' } },
      { note: 'Size 10 people named; density 0.267: 12 of 45 pairs know each other',
        do: [A.zoom([{ css: 'dt', text: 'Size', mode: 'exact' }, { css: 'dt', text: 'Constraint', mode: 'exact', next: 1 }], { pad: 40 }), A.highlight([{ css: 'dt', text: 'Size', mode: 'exact', next: 1 }, { css: 'dt', text: 'Density', mode: 'exact', next: 1 }], 'Size and density', { pad: 6, noScroll: true })] },
      { note: 'Effective size 7.600: 10 minus 2 times 12 divided by 10, Burt\'s non-redundant contacts',
        do: [A.zoom([{ css: 'dt', text: 'Size', mode: 'exact' }, { css: 'dt', text: 'Constraint', mode: 'exact', next: 1 }], { pad: 40 }), A.highlight({ css: 'dt', text: 'Effective size', mode: 'exact', next: 1 }, 'Effective size', { pad: 6, noScroll: true })] },
      { note: 'Constraint 0.292, with its possible range for ten contacts, 0.100 to 0.361',
        do: [A.zoom([{ css: 'dt', text: 'Size', mode: 'exact' }, { css: 'dt', text: 'Constraint', mode: 'exact', next: 1 }], { pad: 40 }), A.highlight({ css: 'dt', text: 'Constraint', mode: 'exact', next: 1 }, 'Constraint', { pad: 6, noScroll: true })] },
      { note: 'Interpretation, opened (definition, scale, in this network, caution): closure (Coleman) against brokerage (Burt)',
        do: [A.unzoom(), A.open('#obpanel-ego details.howto'), A.scroll('#obpanel-ego details.howto', { top: 160 }), A.highlight('#obpanel-ego details.howto', null, { pad: 8 })], facts: { howto: '#obpanel-ego details.howto' } },
      { note: 'The interview summary: what an ego network is and is not; ties among alters are as the respondent sees them',
        do: [A.scroll('#obpanel-ego dl.ob-kv:not(.ego-measures__list)', { top: 120 }), A.highlight('#obpanel-ego dl.ob-kv:not(.ego-measures__list)', null, { pad: 8 })], facts: { interview: '#obpanel-ego' } },
      { note: 'Analyze this network: the ego network in Network, eleven people; ego sits in the middle of three clusters',
        do: [A.click('button|Analyze this network', { map: true }), A.dismiss(), A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
    ],
  },
]);
