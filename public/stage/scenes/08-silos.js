/* Chapter 8. Is this organization siloed, and since when?
   The same workplace settings with the "siloed" scenario (seed 7): Groups
   (E-I index, mixing matrix, against random networks) and Time (the shift
   near the planted date, before and after). */
(function () {
  var SILO = WORLDS.silo;
  var silo = [A.load({ generate: SILO })];
  var ba = 'section[aria-labelledby=ba-h]', sh = 'section[aria-labelledby=sh-h]';

  SCENE(8, [
    {
      id: 'silo-generate', try: { href: 'https://orgsignal.graystoneindustries.co/#generate', label: 'Generate › Siloed, seed 7, then Groups and Time' }, label: 'A siloed workplace',
      question: 'Is this organization siloed, and since when?',
      heading: 'Same people, same seed, a different planted history.',
      setup: [A.load({ generate: WORLDS.slack }), A.go('generate'), A.waitFor('#ob-gen-size'), A.scrollTop(),
        A.click('.tlink|Show the loaded world', { noScroll: true }), A.scrollTop()],
      phases: [
        { note: 'Generate, set to the same workplace: Slack, 120 people, 180 days, seed 7',
          do: [A.highlight('form.ob-stack', null, { pad: 4, soft: true })], facts: { form: 'form.ob-stack' } },
        { note: 'Scenario: Siloed, cross-department traffic collapses at 40% of the period',
          do: [A.click('input[name=ob-gen-structure][value=siloed]'), A.highlight('label.radio|~Siloed', 'Planted: silos form at 40%', { pad: 6 })], facts: { scenario: 'fieldset|~3. Scenario' } },
        { note: 'Generate and analyze: the siloed world is generated, loaded and checked against its ground truth',
          do: [A.scrollTop(), A.cursor('button|Generate and analyze', { ripple: true }), A.load({ generate: SILO }), A.go('generate'), A.waitFor('.ob-recovery'),
            A.scroll('.ob-checks li|~Planted brokers', { top: 140 }), A.highlight('.ob-checks li|~Planted brokers', 'The partial one: brokers', { pad: 6 }),
            A.callout(function (ctx) {
              var li = ctx.find('.ob-checks li|~Planted silo'), sum = ctx.text('.ob-recovery .ob-text strong');
              if (!li) return sum;
              var name = (li.querySelector('.ob-checks__name') || {}).textContent || '', p = li.querySelector('p');
              var line = p ? p.textContent.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0] : '';
              return sum + '\n' + name.trim() + ': ' + line;
            }, { at: [1200, 660] })],
          facts: { recovery: '.ob-recovery', brokers: '.ob-checks li|~Planted brokers', silo: '.ob-checks li|~Planted silo' } },
        { note: 'Network for the siloed world: the departments pulled apart on the map',
          do: [A.nav('Network'), A.select('Color by', 'Department', { map: true }), A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
      ],
    },
    {
      id: 'silo-groups', label: 'Inside or across departments',
      heading: 'The E-I index compares ties across groups with ties inside them.',
      setup: silo.concat([A.go('groups'), A.select('Groups from', 'Department', { noScroll: true }), A.scrollTop()]),
      phases: [
        { note: 'Groups from department opens with cautions: a drop in crossing ties in the week of 17 Mar 2025, and departments recorded once (a snapshot)',
          do: [A.highlight('.gview__shift', 'Cautions first', { pad: 6 })], facts: { cautions: '.gview__shift', reading: '#main' } },
        { note: 'Assortativity by department, against what random networks give',
          do: [A.zoom('.verdict__plain|~Assortativity', { pad: 30, max: 2 })], facts: { assortativity: '.verdict__plain|~Assortativity' } },
        { note: 'The overall E-I index, against its random value: compare with chance, not with zero',
          do: [A.zoom('.verdict__plain|~Overall', { pad: 30, max: 2 })], facts: { ei: '.verdict__plain|~Overall' } },
        { note: 'Each department: ties within and across, its E-I index and E-I if random',
          do: [A.unzoom(), A.scroll('#gt-h', { top: 100 }), A.highlight('table', null, { pad: 6 })], facts: { table: 'table' } },
        { note: 'The mixing matrix: densities between every pair of departments; the diagonal dominates',
          do: [A.scroll('#mx-h', { top: 80 }), A.highlight('section[aria-labelledby=mx-h]', null, { pad: 6 })], facts: { matrix: '#main' } },
      ],
    },
    {
      id: 'silo-time', label: 'When did it change?',
      heading: 'A silo is a change over time, not only a pattern.',
      setup: silo.concat([A.go('time'), A.idle(500), A.scrollTop()]),
      phases: [
        { note: 'Time: each week gets its own network, built with the same construction settings',
          do: [A.highlight('.view__intro', null, { pad: 8 })], facts: { intro: '.view__intro' } },
        { note: 'Activity and structure week by week: events, ties, density, transitivity',
          do: [A.scroll('#ts-h', { top: 90 }), A.highlight('section[aria-labelledby=ts-h]', null, { pad: 6 })], facts: { charts: '#main' } },
        { note: 'Detected shifts: measures that depart from their recent level, the largest first',
          do: [A.scroll(sh, { top: 90 }), A.highlight(sh, null, { pad: 6 })], facts: { shifts: sh } },
        { note: 'The strongest shift opened: what changed, and when',
          do: [A.click(sh + ' .tview__rowbtn'), A.idle(300), A.highlight('tr.tview__detail', null, { pad: 4 })], facts: { detail: 'tr.tview__detail' } },
      ],
    },
    {
      id: 'silo-before-after', label: 'Before and after',
      heading: 'Compare equal periods either side of the date, against random splits.',
      setup: silo.concat([A.go('time'), A.idle(500), A.scroll(ba, { top: 90 })]),
      phases: [
        { note: 'Before and after a date: the date preset to the start of the strongest detected shift',
          do: [A.highlight(ba + ' form', null, { pad: 6 })], facts: { form: ba } },
        { note: 'Compare: whole-network measures before and after, with the E-I index by department',
          do: [A.click(ba + ' button|Compare', { hold: true }), A.idle(600), A.scroll(ba + ' .grid-2', { top: 100 }), A.highlight(ba + ' .grid-2 > :first-child', null, { pad: 6 })], facts: { compare: ba } },
        { note: 'The whole-network table close up: density and the E-I index, before against after',
          do: [A.zoom(ba + ' .grid-2 > :first-child', { pad: 20, max: 1.9 })] },
        { note: 'People whose numbers changed most, tested against random splits of the same messages',
          do: [A.unzoom(), A.highlight(ba + ' .grid-2 > :last-child', null, { pad: 6 })] },
      ],
    },
  ]);
})();
