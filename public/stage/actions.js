/* Scene vocabulary. Scene files (scenes/*.js) describe the talk as data:

     SCENE(chapter, [ { id, label, heading, setup: [actions], phases: [ { note, do: [actions], facts } ] } ])

   Each state is one entry in the player's chapter menu; each phase runs when
   the player's clock enters the matching passage of PROSE.md. `note` is the
   one-line description of what is on screen (it becomes the stage note in
   PROSE.md); `facts` names the panels whose text tools/facts.mjs records for
   the narrator ({ label: selector }).

   Selectors: a CSS selector, optionally with a text filter after "|":
     'button|Analyze'      the first <button> whose text starts with "Analyze"
     'li|~Hal Novak'       ... whose text contains "Hal Novak"
     'td|=0.571'           ... whose text is exactly "0.571"
   or an object { css, text, nth, frame: 'pip' } for the respondent window.

   This file is plain data helpers; engine.js runs the actions. It also loads
   in Node (tools read the scenes), so it touches no DOM. */
(function (g) {
  'use strict';
  var SCENES = g.SCENES || (g.SCENES = []);
  // The generated worlds the talk uses (DESIGN.md): the same workplace with two planted histories.
  var slack = { context: 'workplace', medium: 'slack', structure: 'bridge-dependent', size: 120, seed: 7, timespan: { days: 180 }, content: 'full', observation: 'full' };
  g.WORLDS = { slack: slack, silo: Object.assign({}, slack, { structure: 'siloed' }) };
  g.SCENE = function (chapter, states) {
    states.forEach(function (s) { s.chapter = chapter; SCENES.push(s); });
  };
  function o(a, extra) { var x = { a: a }; for (var k in extra) if (extra[k] !== undefined) x[k] = extra[k]; return x; }
  g.A = {
    // ---- navigation and data (setup or visible) ----
    go: function (view) { return o('go', { view: view }); },                    // switch view directly (no cursor)
    nav: function (label) { return o('nav', { label: label }); },               // click the masthead link
    load: function (spec) { return o('load', { spec: spec }); },                 // { generate } | { classic } | { example } | { perceived } | { clear }
    hash: function (h) { return o('hash', { hash: h }); },                       // set the app's location hash
    remount: function () { return o('remount', {}); },                           // fresh view-local state for the current view
    js: function (fn, label) { return o('js', { fn: fn, label: label }); },      // escape hatch: fn(ctx), may return a promise
    storage: function (key, value) { return o('storage', { key: key, value: value }); },
    // ---- visible actions ----
    click: function (sel, opt) { return o('click', Object.assign({ sel: sel }, opt)); },
    cursor: function (sel, opt) { return o('cursor', Object.assign({ sel: sel }, opt)); },
    type: function (sel, text, opt) { return o('type', Object.assign({ sel: sel, text: text }, opt)); },
    select: function (sel, value, opt) { return o('select', Object.assign({ sel: sel, value: value }, opt)); },
    scroll: function (sel, opt) { return o('scroll', Object.assign({ sel: sel }, opt)); },
    scrollTop: function (opt) { return o('scroll', Object.assign({ sel: null, y: 0 }, opt)); },
    scrollIn: function (box, sel, opt) { return o('scrollIn', Object.assign({ box: box, sel: sel }, opt)); },
    highlight: function (sel, label, opt) { return o('highlight', Object.assign({ sel: sel, label: label }, opt)); },
    clear: function () { return o('clear', {}); },
    open: function (sel, opt) { return o('open', Object.assign({ sel: sel }, opt)); },     // a <details> note: open it if closed
    close: function (sel, opt) { return o('close', Object.assign({ sel: sel }, opt)); },   // fold a note that is open
    zoom: function (sel, opt) { return o('zoom', Object.assign({ sel: sel }, opt)); },
    unzoom: function () { return o('unzoom', {}); },
    callout: function (text, opt) { return o('callout', Object.assign({ text: text }, opt)); },
    pip: function (url, opt) { return o('pip', Object.assign({ url: url }, opt)); },
    pipClose: function () { return o('pipClose', {}); },
    dismiss: function () { return o('dismiss', {}); },
    // ---- timing ----
    wait: function (ms) { return o('wait', { ms: ms }); },
    until: function (share) { return o('until', { share: share }); },             // playback: wait for this share of the passage                       // animated playback only
    waitFor: function (sel, opt) { return o('waitFor', Object.assign({ sel: sel }, opt)); },
    idle: function (ms) { return o('idle', { ms: ms }); },
    map: function () { return o('map', {}); },
    // A large callout restating the top n rows of People's table: each name with the sorted column's value
    // (read from the table on screen, so it always matches the app).
    tableCallout: function (n, title, opt) {
      return o('callout', Object.assign({ at: [1180, 640], text: function (ctx) {
        var heads = ctx.findAll('.vt__head [role=columnheader]'), si = -1;
        heads.forEach(function (h, i) { if (opt && opt.col ? (h.textContent || '').indexOf(opt.col) >= 0 : h.classList.contains('is-sorted')) si = i; });
        if (si < 0) return '';
        var col = (heads[si].textContent || '').replace(/\s+/g, ' ').trim();
        var rows = ctx.findAll('.vt__row').slice(0, n).map(function (r, i) {
          var cells = r.querySelectorAll('[role=gridcell]');
          var name = (r.querySelector('.vt-name__text') || cells[0] || {}).textContent || '';
          return (i + 1) + '. ' + name.trim() + '  ' + ((cells[si] || {}).textContent || '').trim();
        });
        return (title || col) + '\n' + rows.join('\n');
      } }, opt));
    },
    sort: function (label, dir) { return o('sort', { label: label, dir: dir || 'descending' }); }, // People: sort by a column                                    // wait for the network map to draw
    // ---- macros (arrays are flattened when run) ----
    // A worked example drawn in Build and handed to the analysis, as "Analyze this network" does.
    example: function (id) { return [o('load', { spec: { clear: true } }), o('load', { spec: { example: id } }), o('click', { sel: 'button|Analyze this network', noScroll: true }), o('dismiss', {})]; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
