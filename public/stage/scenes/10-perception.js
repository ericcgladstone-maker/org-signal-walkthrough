/* Chapter 10. Do people see their own network accurately?
   Classic dataset: Krackhardt's high-tech managers (1987); the advice
   perceptions in Build > Perceived (cognitive social structures). */
(function () {
  var item = 'li.classic|~Krackhardt';
  SCENE(10, [
    {
      id: 'krackhardt-advice', try: { href: 'https://orgsignal.graystoneindustries.co/#build?perceived=krackhardt:advice', label: 'Build › Perceived › Krackhardt’s managers' }, label: 'Krackhardt\'s managers',
      question: 'Do people see their own network accurately?',
      heading: 'Each manager reported the whole advice network.',
      setup: [A.load({ classic: 'krackhardt' }), A.go('network')],
      phases: [
        { note: 'Krackhardt\'s high-tech managers: 21 managers, the advice network as observed (each manager\'s own ties)',
          do: [A.highlight('.view__intro', null, { pad: 8 })], facts: { header: '.view__intro' } },
        { note: 'Who stands out: Manager 2 asked for advice most; Manager 18 most often between others',
          do: [A.highlight('.standout__list', null, { pad: 8 })], facts: { standouts: '.standout__list' } },
        { note: 'What to look for: reciprocity of advice 0.474; and each manager also reported every other pair',
          do: [A.scroll('.standout__example', { top: 100 }), A.highlight('.standout__example', null, { pad: 8 })], facts: { lookFor: '.standout__example' } },
        { note: 'Learn > Classic datasets: "Advice perceptions in Build" opens the perceived networks',
          do: [A.nav('Learn'), A.scroll(item, { top: 160 }), A.highlight(item + ' >> button|Advice perceptions', null, { pad: 6 })] },
      ],
    },
    {
      id: 'perceived-reports', label: 'Perceived networks',
      heading: 'A cognitive social structure is twenty-one networks, one per informant.',
      setup: [A.load({ clear: true }), A.load({ perceived: 'krackhardt:advice' }), A.scrollTop(), A.click('.ob-steps button|People', { noScroll: true }), A.scrollTop()],
      phases: [
        { note: 'Build > Perceived: several informants each report the whole network as they see it (Krackhardt\'s cognitive social structures)',
          do: [A.cursor('#obtab-perceived'), A.highlight('#obpanel-perceived .ob-subhead', null, { pad: 8 })], facts: { lede: '#obpanel-perceived .ob-subhead' } },
        { note: 'People: the 21 managers in the study',
          do: [A.scroll('.ob-steps', { top: 120 }), A.highlight('#obpanel-perceived .ob-stack', null, { pad: 4, noScroll: true })], facts: { people: '#obpanel-perceived' } },
        { note: 'Informants: every manager answered about every pair',
          do: [A.click('.ob-steps button|Informants'), A.highlight('#obpanel-perceived .ob-stack', null, { pad: 4, noScroll: true })], facts: { informants: '#obpanel-perceived' } },
        { note: 'Reports: one manager\'s view of who goes to whom for advice',
          do: [A.click('.ob-steps button|Reports'), A.highlight('#obpanel-perceived .ob-stack', null, { pad: 4, noScroll: true })], facts: { reports: '#obpanel-perceived' } },
      ],
    },
    {
      id: 'perceived-accuracy', label: 'Consensus and accuracy',
      heading: 'Accuracy is agreement with the others, one informant left out at a time.',
      setup: [A.load({ clear: true }), A.load({ perceived: 'krackhardt:advice' }), A.click('.ob-steps button|Compare', { noScroll: true }), A.scrollTop()],
      phases: [
        { note: 'Compare: "Manager 8 perceives the network best", highest Jaccard against the consensus of the others, 0.58',
          do: [A.scroll('.ob-steps', { top: 120 }), A.highlight('#obpanel-perceived .verdict, #obpanel-perceived .ob-verdict', null, { pad: 6 })], facts: { compare: '#obpanel-perceived' } },
        { note: 'The consensus threshold: a tie is in the consensus when at least half the informants report it',
          do: [A.highlight('#ob-css-th', 'Consensus threshold', { pad: 10 })] },
        { note: 'How each informant compares: ties reported, hits, false alarms, hit rate, Jaccard',
          do: [A.scroll('table', { top: 100 }), A.highlight('table', null, { pad: 6 })], facts: { table: 'table' } },
        { note: 'Manager 8\'s row against Manager 1\'s: fewer ties reported, far fewer false alarms',
          do: [A.zoom('table', { pad: 10, max: 1.6 }), A.highlight({ css: 'td, th', text: 'Manager 8', mode: 'exact', next: 5 }, null, { pad: 3, noScroll: true }), A.highlight({ css: 'td, th', text: 'Manager 1', mode: 'exact', next: 5 }, null, { pad: 3, noScroll: true })] },
        { note: 'Ties informants disagree about most: an even split gives disagreement 1',
          do: [A.unzoom(), A.scroll({ css: 'table', nth: 1 }, { top: 120 }), A.highlight({ css: 'table', nth: 1 }, null, { pad: 6 })], facts: { disagree: { css: 'table', nth: 1 } } },
        { note: 'Network to analyze: the consensus, or each tie judged by its two people (either, or both say yes)',
          do: [A.highlight('#ob-css-view', null, { pad: 8 })], facts: { view: '#ob-css-view' } },
      ],
    },
  ]);
})();
