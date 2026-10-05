/* Autoplay player for "Learning social network analysis by doing it", adapted
   from the network-structures talk's player. The deck iframe is the stage
   (stage/index.html), which drives a frozen copy of Org Signal; the hooks are
   the same (__seek, __state, __t, __nav, __time). The stage boots the app
   before it is ready, so the player waits for __deckReady instead of
   assuming it at the iframe's load event. The chapter menu groups states by
   chapter (the question each chapter answers).

   Notes from the network-structures player follow.

   Autoplay player (adapted from the Sandia presentation's player.js).

   Differences from Sandia: this deck has phases inside each page, keyed to
   the passage clock. The player pushes its clock into the deck every frame
   through __t(seconds), so pausing, stepping a passage or changing speed
   moves the visual and the prose together. A click or key inside the deck
   advances the deck by one phase; the player follows and pauses.

   Original notes follow.

   Autoplay player for the unmodified v13 deck.

   The deck advances one state per gesture, and every animation inside a state
   runs on the deck's own timers. So autoplay never needs to click anything: it
   only decides WHEN to advance, through the hooks the deck already exposes:
     __seek(i)  show state i with animation on (what a presenter's click does)
     __state()  the state currently on screen
   These are only reachable because the deck is served from the same origin as
   this page. Serve both together, and embed THIS page elsewhere if needed.

   Everything is scoped to a [data-sp="root"] element, parts are found by
   data-sp names inside it, and keyboard shortcuts only apply while focus is
   inside the player, so it can sit inside another site's page. */
(function () {
  'use strict';

  var T = window.TIMELINE.states;
  var root = document.querySelector('[data-sp="root"]');
  var $ = function (name) { return root.querySelector('[data-sp="' + name + '"]'); };
  var frame = $('deck'), box = $('stage');
  var playBtn = $('play'), track = $('track'), jump = $('jump'), prose = $('prose');
  var panel = prose.parentNode;
  var now = $('now'), pos = $('pos');
  var head = $('head'), chapEl = $('chapter'), headEl = $('heading'), tryEl = $('try');

  var deck = null;          // the iframe's window once it has booted
  var cur = 0;              // state the player believes is on screen
  var t = 0;                // seconds elapsed inside the current state
  var navSeen = 0;          // deck's own navigation counter (clicks/keys inside the deck)
  var playing = false, speed = 1, last = 0;

  var starts = [], total = 0;
  T.forEach(function (s) { starts.push(total); total += s.duration; });

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  /* ---- scale the 1920x1080 deck viewport to the stage box --------------- */
  function fitDeck() {
    // letterboxed fit, so the same code serves the page layout and the expanded (fullscreen) stage
    var w = box.clientWidth, h = box.clientHeight || w * 9 / 16, s = Math.min(w / 1920, h / 1080);
    box.style.setProperty('--sp-s', s);
    frame.style.left = Math.max(0, (w - 1920 * s) / 2) + 'px'; frame.style.top = Math.max(0, (h - 1080 * s) / 2) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fitDeck).observe(box);
  else addEventListener('resize', fitDeck);
  fitDeck();

  /* ---- a transcript panel whose height never changes during playback ----
     Host pages can react to their own height changing (Graystone's background
     field regenerates on it), so the panel is sized once per width to the
     longest state's prose, capped against the viewport, and scrolls inside
     itself when a state is longer than that. */
  var sizedW = 0;
  function sizeTranscript() {
    var w = prose.clientWidth;
    if (!w || w === sizedW) return;
    sizedW = w;
    var probe = prose.cloneNode(false);
    probe.removeAttribute('data-sp');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:' + w + 'px';
    panel.appendChild(probe);
    var tallest = 0;
    T.forEach(function (s) {
      probe.innerHTML = '';
      s.paragraphs.forEach(function (p) {
        var el = document.createElement('p'); el.textContent = p.text; probe.appendChild(el);
      });
      tallest = Math.max(tallest, probe.offsetHeight);
    });
    panel.removeChild(probe);
    var cs = getComputedStyle(panel);
    var pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    var cap = Math.max(240, innerHeight * 0.7);
    panel.style.height = Math.ceil(Math.min(tallest + pad, cap)) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(sizeTranscript).observe(panel);
  else addEventListener('resize', sizeTranscript);

  /* The current-passage area holds one paragraph at a time. Its height is fixed
     to the longest paragraph at the current width for the same reason. */
  var nowW = 0;
  function sizeNow() {
    var w = now.clientWidth;
    if (!w || w === nowW) return;
    nowW = w;
    var probe = now.cloneNode(false);
    probe.removeAttribute('data-sp');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:' + w + 'px';
    now.parentNode.appendChild(probe);
    var tallest = 0;
    T.forEach(function (s) {
      s.paragraphs.forEach(function (p) {
        probe.innerHTML = '';
        var el = document.createElement('p'); el.textContent = p.text; probe.appendChild(el);
        tallest = Math.max(tallest, probe.offsetHeight);
      });
    });
    now.parentNode.removeChild(probe);
    // Embedded in a host page (?embed=1), reserve only the deck column's height when the passage sits
    // beside the deck, so the frame carries no empty space; a longer passage extends it while shown.
    if (document.documentElement.classList.contains('embed')) {
      var st = root.querySelector('.sp-stage'), ct = root.querySelector('.sp-controls');
      var beside = st && now.getBoundingClientRect().left > st.getBoundingClientRect().right - 1;
      if (beside) tallest = Math.min(tallest, st.offsetHeight + (ct ? ct.offsetHeight : 0));
    }
    now.style.minHeight = Math.ceil(tallest) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(sizeNow).observe(now);
  else addEventListener('resize', sizeNow);

  /* The heading block (chapter question, the state's heading, the Try link) keeps one height per
     width, sized to the longest, so the passage below it never jumps. */
  var headW = 0;
  function sizeHead() {
    if (!head) return;
    var w = head.clientWidth;
    if (!w || w === headW) return;
    headW = w;
    var probe = head.cloneNode(true);
    probe.removeAttribute('data-sp');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;min-height:0;width:' + w + 'px';
    head.parentNode.appendChild(probe);
    var tallest = 0;
    T.forEach(function (s) {
      fillHead(s, probe.querySelector('.sp-chapter'), probe.querySelector('.sp-heading'), probe.querySelector('.sp-try'));
      tallest = Math.max(tallest, probe.offsetHeight);
    });
    head.parentNode.removeChild(probe);
    head.style.minHeight = Math.ceil(tallest) + 'px';
  }
  function fillHead(s, c, h, a) {
    if (c) c.textContent = s.chapter ? 'Question ' + s.chapter + ' · ' + (s.chapterTitle || '') : (s.chapterTitle || '');
    if (h) h.textContent = s.heading || s.label;
    if (a) {
      if (s.try && s.try.href) { a.hidden = false; a.href = s.try.href; a.textContent = 'Try it in Org Signal: ' + s.try.label + ' ↗'; }
      else a.hidden = true;
    }
  }
  if (head && window.ResizeObserver) new ResizeObserver(sizeHead).observe(head);

  function showNow(s, on) {
    now.innerHTML = '';
    var el = document.createElement('p');
    if (s.paragraphs[on]) el.textContent = s.paragraphs[on].text;
    else { el.className = 'sp-empty'; el.textContent = 'Text for this part has not been added yet.'; }
    now.appendChild(el);
    var many = s.paragraphs.length > 1;
    pos.textContent = many ? (on + 1) + ' / ' + s.paragraphs.length : '';
  }

  /* One sequence (Eric, 2026-10-05): ‹ ›, the arrow keys and , . step one
     passage at a time, and the stage moves with the text (the clock is set to
     the passage's cue and pushed to the stage every frame). At either end of a
     part they cross into the next part's first passage or the previous part's
     last, so there is no separate level of navigation inside a part. */
  function step(d) {
    var s = T[cur], k = (shownOn < 0 ? 0 : shownOn) + d;
    setPlaying(false);
    if (k >= 0 && k < s.paragraphs.length) { t = s.paragraphs[k].at; renderTime(); return; }
    if (d > 0 && cur < T.length - 1) go(cur + 1);
    else if (d < 0 && cur > 0) {
      go(cur - 1);
      var ps = T[cur].paragraphs;
      if (ps.length) { t = ps[ps.length - 1].at; renderTime(); }
    }
  }

  /* keep the highlighted paragraph visible by scrolling the PANEL, never the page */
  function reveal(el) {
    var top = el.offsetTop, bottom = top + el.offsetHeight;
    var viewTop = panel.scrollTop, viewBottom = viewTop + panel.clientHeight;
    if (top >= viewTop && bottom <= viewBottom) return;
    var target = Math.max(0, top - 12);
    if (panel.scrollTo) panel.scrollTo({ top: target, behavior: reduceMotion ? 'auto' : 'smooth' });
    else panel.scrollTop = target;
  }
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var shownOn = -1;

  /* ---- static UI -------------------------------------------------------- */
  $('total').textContent = clock(total);
  T.forEach(function (s, i) {
    var seg = document.createElement('i');
    seg.style.flex = s.duration;
    seg.title = (i + 1) + '. ' + s.label;
    seg.appendChild(document.createElement('b'));
    seg.addEventListener('click', function () { go(i); });
    track.appendChild(seg);

    var o = document.createElement('option');
    o.value = i; o.textContent = (i + 1) + ' / ' + T.length + ' · ' + s.label;
    // one group per chapter, titled by the chapter's question
    if (s.chapterTitle && (i === 0 || T[i - 1].chapter !== s.chapter)) {
      var g = document.createElement('optgroup');
      g.label = s.chapter ? s.chapter + '. ' + s.chapterTitle : s.chapterTitle;
      jump.appendChild(g);
    }
    (jump.lastElementChild && jump.lastElementChild.tagName === 'OPTGROUP' ? jump.lastElementChild : jump).appendChild(o);
  });

  /* ---- navigation ------------------------------------------------------- */
  // cont: moving on by itself at the end of a state (continuous play), so the stage may pick up where it is
  function go(i, cont) {
    cur = Math.max(0, Math.min(T.length - 1, i));
    t = 0;
    if (deck) deck.__seek(cur, !!cont);
    renderState();
  }

  function setPlaying(on) {
    playing = on && !!deck;
    playBtn.textContent = playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.title = playing ? 'Pause' : 'Play';
  }

  playBtn.addEventListener('click', function () {
    if (!playing && cur === T.length - 1 && t >= T[cur].duration) go(0);
    // the stage already shows this state (a menu choice or ‹ › seeked it): no second seek (M3)
    else if (!playing && t === 0 && deck && deck.__state() !== cur) go(cur);
    setPlaying(!playing);
  });
  $('prev').addEventListener('click', function () { step(-1); });
  $('next').addEventListener('click', function () { step(1); });
  $('restart').addEventListener('click', function () { go(0); });
  // Expand shows the whole player (stage and narration) full screen, so the screen is large and the text
  // stays beside or under it (C1a); where an element cannot go full screen (phones), it fills the window.
  var expand = $('expand'), tap = $('tap');
  function setMax(on) {
    root.classList.toggle('sp--max', on);
    document.documentElement.classList.toggle('sp-maxed', on);
    if (expand) {
      expand.textContent = on ? '⤡ Exit full screen' : '⤢ Expand';
      expand.setAttribute('aria-label', on ? 'Exit full screen' : 'Show the walkthrough full screen, with its text');
    }
    nowW = 0; headW = 0;
    requestAnimationFrame(function () { fitDeck(); sizeNow(); sizeHead(); });
  }
  function toggleMax() {
    var on = !root.classList.contains('sp--max');
    if (on) {
      setMax(true);
      if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      setMax(false);
    }
  }
  if (expand) expand.addEventListener('click', toggleMax);
  var capBtn = $('caption');
  if (capBtn) capBtn.addEventListener('click', function () {
    var off = root.classList.toggle('sp--captionless');
    capBtn.textContent = off ? 'Show text' : 'Hide text';
    capBtn.setAttribute('aria-pressed', String(!off));
  });
  if (tap) tap.addEventListener('click', toggleMax);
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && root.classList.contains('sp--max')) setMax(false);
    fitDeck();
  });
  $('speed').addEventListener('change', function (e) { speed = +e.target.value; });
  jump.addEventListener('change', function (e) { go(+e.target.value); });

  root.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('button, select')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); playBtn.click(); }
    else if (e.key === '.') { e.preventDefault(); step(1); }
    else if (e.key === ',') { e.preventDefault(); step(-1); }
    else if (e.key === 'Escape' && root.classList.contains('sp--max')) { e.preventDefault(); toggleMax(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });

  /* ---- rendering -------------------------------------------------------- */
  function renderState() {
    var s = T[cur];
    jump.value = cur;
    $('count').textContent = 'Part ' + (cur + 1) + ' of ' + T.length + ': ' + (s.heading || s.label);
    fillHead(s, chapEl, headEl, tryEl);
    prose.innerHTML = '';
    panel.scrollTop = 0; shownOn = -1;
    if (!s.paragraphs.length) {
      var e = document.createElement('p');
      e.className = 'sp-empty';
      e.textContent = 'Text for this part has not been added yet.';
      prose.appendChild(e);
    }
    s.paragraphs.forEach(function (p) {
      var el = document.createElement('p');
      el.textContent = p.text;
      el.addEventListener('click', function () {
        /* selecting text should not move the clock */
        if (String(window.getSelection && getSelection())) return;
        t = p.at; renderTime();
      });
      prose.appendChild(el);
    });
    renderTime();
  }

  function renderTime() {
    var s = T[cur];
    $('elapsed').textContent = clock(starts[cur] + t);
    var segs = track.children;
    for (var i = 0; i < segs.length; i++) {
      segs[i].className = i < cur ? 'sp-done' : '';
      segs[i].firstChild.style.width = i === cur ? (100 * t / s.duration) + '%' : '';
    }
    var on = 0;
    s.paragraphs.forEach(function (p, k) { if (p.at <= t) on = k; });
    var ps = prose.querySelectorAll('p:not(.sp-empty)');
    for (var k = 0; k < ps.length; k++) ps[k].classList.toggle('sp-on', k === on);
    if (on !== shownOn) {
      shownOn = on;
      showNow(s, on);
      if (on > 0 && ps[on] && panel.offsetParent) reveal(ps[on]);
    }
  }

  /* ---- the clock -------------------------------------------------------- */
  function tick(now) {
    var dt = last ? Math.min((now - last) / 1000, 0.25) : 0;
    last = now;
    if (deck) {
      /* a visitor clicked or keyed inside the deck: follow it and pause */
      var seen = deck.__state(), nav = deck.__nav ? deck.__nav() : 0;
      if (seen !== cur || nav !== navSeen) {
        navSeen = nav; setPlaying(false);
        if (seen !== cur) { cur = seen; renderState(); }
        t = deck.__time ? Math.min(deck.__time(), T[cur].duration) : 0; renderTime();
      }
      else if (playing) {
        var held = (deck.__holding && deck.__holding()) || (speed > 2 && deck.__busy && deck.__busy());
        root.classList.toggle('sp-held', !!held);
        if (!held) t += dt * speed;
        if (t >= T[cur].duration) {
          if (cur < T.length - 1) go(cur + 1, true);
          else { t = T[cur].duration; setPlaying(false); }
        }
        renderTime();
      }
      if (deck.__t) deck.__t(t);
    }
    requestAnimationFrame(tick);
  }

  /* ---- boot ------------------------------------------------------------- */
  /* The deck boots on fonts.ready or after 350 ms, whichever comes first, and
     shows its start state then. Wait past that so our first seek is not undone. */
  // The stage starts the app inside itself first; wait for it (up to a minute).
  var tries = 0;
  function attach() {
    var w;
    try { w = frame.contentWindow; if (!w.__seek) throw 0; }
    catch (err) {
      prose.innerHTML = '<p class="sp-empty">The player cannot reach the stage. Open this page through a web server (see README), not by double-clicking the file.</p>';
      return;
    }
    if (!w.__deckReady) { if (++tries < 600) setTimeout(attach, 100); return; }
    deck = w; w.__seek(cur); navSeen = w.__nav ? w.__nav() : 0; renderState();
  }
  if (frame.contentDocument && frame.contentDocument.readyState === 'complete' && frame.contentWindow.__seek) attach();
  else frame.addEventListener('load', attach);

  sizeTranscript();
  sizeNow();
  sizeHead();
  renderState();
  requestAnimationFrame(tick);
})();
