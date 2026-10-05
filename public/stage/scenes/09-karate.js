/* Chapter 9. Can structure predict how a group splits?
   Classic dataset: Zachary's karate club (1977), loaded from the library. */
(function () {
  var classicItem = 'li.classic|~Zachary';
  SCENE(9, [
    {
      id: 'karate-load', try: { href: 'https://orgsignal.graystoneindustries.co/#learn', label: 'Learn › Classic datasets › Zachary’s karate club' }, label: 'Zachary\'s karate club',
      question: 'Can structure predict how a group splits?',
      heading: 'A classic dataset comes with a documented result.',
      setup: [A.load({ clear: true }), A.go('learn'), A.scroll('#learn-classic', { top: 90 })],
      phases: [
        { note: 'Learn > Classic datasets: published networks with what the study found and reference values to check against',
          do: [A.highlight('#learn-classic', null, { pad: 6, soft: true })], facts: { library: '#learn-classic' } },
        { note: 'Zachary\'s karate club: 34 members, friendship outside club meetings, observed 1970 to 1972',
          do: [A.scroll(classicItem, { top: 160 }), A.highlight(classicItem, null, { pad: 6 })], facts: { card: classicItem } },
        { note: 'Load: the network opens in Network; header 34 people and 78 ties',
          do: [A.click(classicItem + ' >> button|Load', { map: true }), A.idle(300), A.dismiss(), A.scrollTop(), A.highlight('.view__intro', null, { pad: 8 })], facts: { header: '.view__intro' } },
        { note: 'Who stands out: John A. most contacts; Mr. Hi most often between others; the two leaders whose conflict split the club',
          do: [A.highlight('.standout__list', null, { pad: 8 })], facts: { standouts: '.standout__list' } },
        { note: 'What to look for, and the study\'s card: what Zachary found and the reference values (the faction each member joined)',
          do: [A.scroll('.standout__example', { top: 100 }), A.highlight('.standout__example', null, { pad: 8 })], facts: { lookFor: '.standout__example' } },
      ],
    },
    {
      id: 'karate-split', label: 'Communities and the split',
      heading: 'Community detection finds dense groups; the split is a fact to compare against.',
      setup: [A.load({ classic: 'karate' }), A.go('network')],
      phases: [
        { note: 'The map colored by detected community: 4 communities found by modularity',
          do: [A.select('Color by', 'Community', { noScroll: true, map: true }), A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { legend: '.net-legend' } },
        { note: 'Modularity, compared with random networks with the same degrees',
          do: [A.scroll('.net-summary', { top: 70 }), A.click('button|Compare with random networks'), A.idle(500), A.highlight('.net-summary .metric-row|~Modularity', null, { pad: 6 })], facts: { summary: '.net-summary' } },
        { note: 'The same map colored by faction, the club each member joined after the split',
          do: [A.scrollTop(), A.select('Color by', 'Faction', { map: true }), A.scroll('.net__canvas', { top: 70 }), A.highlight('.split__main .net', null, { pad: 4 })], facts: { legend: '.net-legend' } },
        { note: 'Groups from faction: E-I index -0.718; most ties stay inside the side each member later joined',
          do: [A.nav('Groups'), A.select('Groups from', 'Faction'), A.highlight('section[aria-labelledby=reading-h]', null, { pad: 6 })], facts: { reading: '#main' } },
        { note: 'The two factions in the group table: ties within and across',
          do: [A.scroll('#gt-h', { top: 100 }), A.highlight('table', null, { pad: 6 })], facts: { table: 'table' } },
        { note: 'Groups from detected communities: four dense groups, each mostly one faction; a callout names the one member who is the exception',
          do: [A.scrollTop(), A.select('Groups from', 'Detected'), A.scroll('#gt-h', { top: 100 }), A.highlight('table', null, { pad: 6 }),
            A.callout(function (ctx) {
              // the member whose faction differs from the faction most of their community joined
              var st = ctx.store.get(), ds = st.dataset, c = st.communities, ids = st.network && st.network.nodeIds;
              if (!ds || !c || !ids) return '';
              var key = Object.keys(ds.nodes.attrs[ids[0]] || {}).find(function (k) { return /faction/i.test(k); }) || 'faction';
              var tally = {};
              for (var v = 0; v < ids.length; v++) { var m = c.membership[v], f = (ds.nodes.attrs[ids[v]] || {})[key]; tally[m] = tally[m] || {}; tally[m][f] = (tally[m][f] || 0) + 1; }
              var major = function (m) { return Object.keys(tally[m]).sort(function (a, b) { return tally[m][b] - tally[m][a]; })[0]; };
              var out = [];
              for (var w = 0; w < ids.length; w++) { var mm = c.membership[w], ff = (ds.nodes.attrs[ids[w]] || {})[key]; if (ff !== major(mm)) out.push(ds.nodes.labels[ids[w]] + ' joined ' + ff + '\'s side but sits in community ' + (mm + 1) + ', which is mostly ' + major(mm)); }
              return out.length ? 'The exception: ' + out.join('; ') : '';
            }, { at: [1060, 880] })], facts: { table: 'table' } },
      ],
    },
  ]);
})();
