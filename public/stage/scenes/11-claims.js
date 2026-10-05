/* Chapter 11. From analysis to a claim you can defend.
   Methods & Export for the generated workplace; Learn > About and limits. */
(function () {
  var world = [A.load({ generate: WORLDS.slack })];
  SCENE(11, [
    {
      id: 'methods-appendix', try: { href: 'https://orgsignal.graystoneindustries.co/#learn', label: 'Learn › About and limits' }, label: 'The methods appendix',
      question: 'How do you get from an analysis to a claim you can defend?',
      heading: 'Report the choices, so someone else can make them again.',
      setup: world.concat([A.go('methods')]),
      phases: [
        { note: 'Methods & Export: a methods appendix written from the choices actually made, files for other tools, a project file',
          do: [A.highlight('.view__intro, .view__head p', null, { pad: 8 })], facts: { intro: '#main' } },
        { note: 'The methods appendix: data, construction rules, measures and their formulas, null models, software',
          do: [A.scroll('#meth-h', { top: 90 }), A.highlight({ css: '#meth-h', next: 3 }, null, { pad: 6 })], facts: { appendix: 'section[aria-labelledby=meth-h]' } },
        { note: 'The appendix close up: the construction rules in words, direction and weights, exclusions, and the resulting network',
          do: [A.scroll('#main .md p|~Ties were built from', { top: 130 }),
            A.zoom(['#main .md p|~Ties were built from', '#main .md p|~The resulting network'], { pad: 16, max: 2, noScroll: true })] },
        { note: 'Network files: GraphML, GEXF, Pajek, UCINET and tables, with attributes and measures; contact details left out by default',
          do: [A.unzoom(), A.scroll('#exp-h', { top: 90 }), A.highlight('section[aria-labelledby=exp-h] table, #exp-h + *', null, { pad: 6 }), A.highlight('tr|~GEXF', 'GEXF for Gephi', { pad: 3 })], facts: { files: 'section[aria-labelledby=exp-h]' } },
        { note: 'Figures and summary: the network figure and a summary report that prints to PDF',
          do: [A.scroll('#fig-h', { top: 90 }), A.highlight({ css: '#fig-h', next: 2 }, null, { pad: 6 })], facts: { figures: '#main' } },
        { note: 'Project file: save the whole session, settings included, to pick up later or hand to someone else',
          do: [A.scroll('#proj-h', { top: 90 }), A.highlight({ css: '#proj-h', next: 3 }, null, { pad: 6 })], facts: { project: '#main' } },
      ],
    },
    {
      id: 'limits', label: 'About and limits',
      heading: 'Know what the numbers rest on, and what they cannot show.',
      setup: [A.go('learn'), A.scroll('#learn-about', { top: 90 })],
      phases: [
        { note: 'Learn > About Org Signal and its limits',
          do: [A.highlight('#learn-about-h', null, { pad: 6 })], facts: { about: '#learn-about' } },
        { note: 'Your data: everything runs in the browser; nothing is uploaded or kept',
          do: [A.scroll('#learn-about h3|Your data', { top: 90 }), A.highlight({ css: '#learn-about h3', text: 'Your data', next: 1 }, null, { pad: 6 })] },
        { note: 'How the numbers are checked: against published values and networkx on reference networks',
          do: [A.scroll('#learn-about h3|How the numbers', { top: 90 }), A.highlight({ css: '#learn-about h3', text: 'How the numbers', next: 1 }, null, { pad: 6 })] },
        { note: 'Known limitations: the Measurement group (sampling above about 3,000 people, rank intervals, shift detection, personal exports)',
          do: [A.scroll('.learn-about__group|Measurement', { top: 130 }), A.highlight('.learn-about__group|Measurement', 'Measurement', { pad: 6 })], facts: { limits: '#learn-about', measurement: '.learn-about__group|Measurement' } },
      ],
    },
    {
      id: 'close', label: 'Using it in a course',
      heading: 'The questions, answered by doing.',
      setup: [A.go('learn'), A.scroll('#learn-tasks', { top: 90 })],
      phases: [
        { note: 'Learn > Find it in the app: the questions of a first course, each with where to look and what to read',
          do: [A.highlight('#learn-tasks', null, { pad: 6, soft: true })], facts: { tasks: '#learn-tasks' } },
        { note: 'Worked examples: small networks to compute by hand, each with what to look for',
          do: [A.scroll('#learn-examples', { top: 90 }), A.highlight('#learn-examples', null, { pad: 6, soft: true })], facts: { examples: '#learn-examples' } },
        { note: 'Concepts: every measure in plain words, where it appears, and the common mistake',
          do: [A.scroll('#learn-concepts', { top: 90 }), A.highlight('#learn-concepts h2', null, { pad: 8 })] },
        { note: 'Back to the start: Data, where a course begins with drawing, a sample organization or its own exports',
          do: [A.load({ clear: true }), A.scrollTop(), A.highlight('.dv-start', null, { pad: 8 })], facts: { start: '.dv-start' } },
      ],
    },
  ]);
})();
