/* Chapter 5. Where does a network come from when nobody drew it?
   Generate: a 120-person workplace on Slack, bridge-dependent, seed 7, 180
   days, written by the generator as a real Slack workspace export (zip); then
   that zip imported through Data, so the real detection and import review show. */
(function () {
  var SPEC = WORLDS.slack;
  // The zip a Slack admin export of this world would be, made once per session
  // by the app's own generator service (output: 'native').
  async function slackZip(ctx) {
    if (ctx.cache.has('slack-zip')) return ctx.cache.get('slack-zip');
    var svc = await ctx.B.imp('../app/src/ui/generate/service.js');
    var run = svc.startGenerate(Object.assign({}, SPEC, { output: 'native' }));
    var res = await run.promise;
    var z = { name: res.download.name, bytes: res.download.bytes, type: res.download.type || 'application/zip' };
    ctx.cache.set('slack-zip', z);
    return z;
  }
  // Choosing the file: the zip handed to the Data view's own file input, as the
  // file picker would, so detection and the review are the app's real ones.
  var chooseZip = A.js(async function (ctx) {
    var z = await slackZip(ctx);
    var input = await ctx.need('input[type=file]:not([webkitdirectory])');
    if (!input) return;
    var W = ctx.app.win;
    var dt = new W.DataTransfer();
    dt.items.add(new W.File([z.bytes], z.name, { type: z.type }));
    input.files = dt.files;
    input.dispatchEvent(new W.Event('change', { bubbles: true }));
    var btn = await ctx.need('.dv-actions button|Import', 120000);
    for (var i = 0; btn && btn.disabled && i < 1200; i++) { await ctx.sleep(100); btn = ctx.find('.dv-actions button|Import') || btn; }
  }, 'choose the Slack zip');
  chooseZip.hold = true;   // the first time in a session the zip is generated here (several seconds): playback waits
  var startImport = A.click('.dv-actions button|Import');
  var waitReview = A.waitFor('.dv-report article.dv-source', { timeout: 240000 });
  function toReview() { return [A.load({ clear: true }), A.go('data'), chooseZip, A.click('.dv-actions button|Import', { noScroll: true }), waitReview, A.dismiss(), A.scrollTop()]; }
  // The Generate form set to this world, through the form itself.
  var formWorld = [
    A.click('input[name=ob-gen-context][value=workplace]', { noScroll: true }),
    A.click('.seg button|=Slack', { noScroll: true }),
    A.click('input[name=ob-gen-structure][value=bridge-dependent]', { noScroll: true }),
    A.type('#ob-gen-size', '120', { noScroll: true }), A.type('#ob-gen-days', '180', { noScroll: true }), A.type('#ob-gen-seed', '7', { noScroll: true }),
  ];

  SCENE(5, [
    {
      id: 'generate-world', try: { href: 'https://orgsignal.graystoneindustries.co/#generate', label: 'Generate › Workplace, Slack, bridge-dependent, seed 7' }, label: 'A world with known structure',
      question: 'Where does a network come from when nobody drew it?',
      heading: 'Generate builds an organization whose structure we know.',
      setup: [A.load({ clear: true }), A.go('generate'), A.waitFor('#ob-gen-size'), A.scrollTop()],
      phases: [
        { note: 'Generate: choose a setting, a medium, a scenario and what an export shows; Workplace selected',
          do: [A.click('input[name=ob-gen-context][value=workplace]'), A.highlight('fieldset|~1. Setting', 'Setting', { pad: 6 })], facts: { form: 'form.ob-stack' } },
        { note: 'Medium: Slack. The people in this world talk in channels, threads and direct messages',
          do: [A.click('.seg button|=Slack'), A.highlight('fieldset|~2. Medium', null, { pad: 6 })] },
        { note: 'Scenario: Bridge-dependent, departments joined by a few brokers (one leaves at 55%)',
          do: [A.click('input[name=ob-gen-structure][value=bridge-dependent]'), A.highlight('label.radio|~Bridge-dependent', 'Planted: a few brokers', { pad: 6 })], facts: { scenario: 'fieldset|~3. Scenario' } },
        { note: 'Size 120 people; 180 days; random seed 7, so anyone can make the same world again',
          do: [A.type('#ob-gen-size', '120'), A.scroll('fieldset|~7. Time', { top: 300 }), A.type('#ob-gen-days', '180'), A.type('#ob-gen-seed', '7'),
            A.highlight(['fieldset|~4. Size', 'fieldset|~7. Time'], null, { pad: 6 })], facts: { size: 'fieldset|~4. Size', time: 'fieldset|~7. Time' } },
        { note: 'What will be generated: the plain-language summary of the world and its planted ground truth',
          do: [A.scrollTop(), A.highlight('.ob-cols.side > :last-child', 'What will be generated', { pad: 6 })], facts: { summary: '.ob-cols.side > :last-child' } },
        { note: '"Download as native export files": the world written as a real Slack workspace export, a zip of users, channels and daily message files',
          do: [A.cursor('button|Download as native export files'), A.highlight('button|Download as native export files', null, { pad: 8 }), A.highlight('p|~Native files', null, { pad: 6 })], facts: { native: 'p|~Native files' } },
      ],
    },
    {
      id: 'slack-import', label: 'Importing a Slack export',
      heading: 'Traces are records of behavior, not reports of relationships.',
      setup: [A.load({ clear: true }), A.go('data'), A.scroll('#dv-import', { top: 100 })],
      phases: [
        { note: 'Data: "Analyze your own exports"; everything runs in the browser and nothing is uploaded',
          do: [A.highlight('#dv-import', null, { pad: 6 })], facts: { import: '#dv-import' } },
        { note: 'The generated Slack export (a .zip) chosen; Org Signal detects what it is from the files inside, then the import starts',
          // in playback the import starts as this passage ends, so the review is ready for the next one (M1);
          // a settled replay stops at the detection. startsWork: the phase ends with work for the next passage
          // (the playback check does not count that time as the subject arriving late)
          startsWork: true,
          do: [A.cursor('.dv-drop button'), chooseZip, A.scroll('.dv-actions', { top: 300 }), A.highlight('.dv-source, .src', 'Detected', { pad: 6 }),
            A.until(0.6), A.click('.dv-actions button|Import', { animOnly: true, noScroll: true, noWait: true })], facts: { detected: '#main' } },
        { note: 'The import finishes: the review of what was read appears (playback waits for it)',
          do: [A.click('.dv-actions button|Import', { ifPresent: true, hold: true }), waitReview, A.dismiss(), A.scroll('.dv-report', { top: 140 }), A.highlight('.dv-report article.dv-source', null, { pad: 6 })], facts: { review: '#main' } },
      ],
    },
    {
      id: 'import-review', label: 'What the export can and cannot show',
      heading: 'Observation is not the network.',
      continues: true,   // played on from slack-import, the review on screen is used as it is (no second import)
      setup: toReview(),
      phases: [
        { note: 'Review before analysis: what these records support and the limits of these records',
          do: [A.scroll('.dv-report', { top: 140 }), A.highlight('article.dv-source', null, { pad: 6 })], facts: { review: '.dv-report' } },
        { note: 'What these records support: the structure of the whole group in this export',
          do: [A.zoom('.src__cols', { pad: 24, max: 1.8 })], facts: { cols: '.src__cols' } },
        { note: 'Limits of these records: interaction outside this export (other tools, meetings, hallways) or in conversations the export left out',
          do: [A.zoom('.src__cols', { pad: 24, max: 1.8 }), A.highlight('.src__cols > :last-child', null, { pad: 8, noScroll: true })] },
        { note: 'Records available for tie construction: one rule per kind of record, with its count (replies, mentions, direct messages, turn-taking, reactions)',
          do: [A.unzoom(), A.scroll('.dv-rules', { top: 160 }), A.zoom('.dv-rules', { pad: 24, max: 1.9 })], facts: { rules: '.dv-rules' } },
        { note: 'What was read: people, events, conversations by kind, one bot (Deploy Bot), one deactivated account (Ludmila Nakamura)',
          do: [A.unzoom(), A.scroll('dl.dv-kv', { top: 160 }), A.highlight(['dl.dv-kv', 'p.dv-gone'], null, { pad: 6 })], facts: { counts: 'dl.dv-kv', gone: 'p.dv-gone' } },
        { note: 'In total, and the cautions: the bot is left out of the network, which shows 120 people; the departed account\'s history still counts',
          do: [A.scroll('.dv-report__totals', { top: 120 }), A.highlight(['.dv-report__totals', 'ul.dv-notes'], null, { pad: 6 })], facts: { totals: '.dv-report__totals', notes: 'ul.dv-notes' } },
        { note: 'Load into analysis: the network built from the export, 120 people',
          do: [A.click('.dv-actions button|Load into analysis'), A.idle(500), A.dismiss(), A.nav('Network'), A.highlight('.view__intro', null, { pad: 8 })], facts: { header: '.view__intro', standouts: '.standout__list' } },
      ],
    },
  ]);
})();
