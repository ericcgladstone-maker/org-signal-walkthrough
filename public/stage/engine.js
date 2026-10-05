/* Stage engine: drives the frozen Org Signal build in #app from the scene
   scripts, in step with the player's clock.

   Player contract (the same hooks as the network-structures deck):
     __seek(i)   show state i: its setup and phase 0
     __state()   the state on screen (the one last asked for)
     __t(sec)    the player's clock inside the state, pushed every frame;
                 phase k runs when the clock enters passage k (TIMELINE cue `at`)
     __nav() / __time()   a visitor's click on the stage steps one phase; the
                 player notices the counter, pauses and takes the clock from __time()
   For the QA tools: __go(i, k) (settled replay), __phase(), __phases(i),
   __settled(), __facts(), __errors().

   Playback rules
   - Moving forward one passage runs that phase animated: the cursor travels
     to each control and clicks it with real DOM events, so the app responds
     as it would to a person.
   - Anything else (a seek, stepping back, jumping ahead) replays the state's
     setup and phases 0..k instantly (no cursor travel, no waits), then shows
     phase k settled. The same passage therefore always shows the same picture.
   - Reduced motion (OS setting), ?anim=0 or ?capture=1: every phase settled.
   - Generated and classic datasets are cached for the session, so returning
     to a world does not regenerate it.

   Coordinates: the app runs at a 1600x900 CSS viewport scaled 1.2 to fill the
   1920x1080 stage (see README for why); #cam adds zoom and pan on top. */
(function () {
  'use strict';
  var Q = new URLSearchParams(location.search);
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var STILL = Q.get('anim') === '0' || Q.get('capture') === '1' || reduce;
  document.documentElement.classList.add(STILL ? 'still' : 'anim');
  var SC = window.SCENES || [];
  var TL = (window.TIMELINE && window.TIMELINE.states) || [];
  var K = 1.2, APP_W = 1600, APP_H = 900, W = 1920, H = 1080;
  // The respondent's window nearly fills the stage (CSS 1022x535 at 1.8), so its text is legible in a small embed.
  var PIP = { left: 40, top: 32 + 45, s: 1.8, w: 1840, h: 963, cssW: 1022, cssH: 535 };

  var $ = function (s) { return document.querySelector(s); };
  var appF = $('#app'), pipF = $('#pipframe'), camEl = $('#cam'), hlsEl = $('#hls'), cursorEl = $('#cursor'), overlay = $('#overlay');
  var pipEl = $('#pip'), cardEl = $('#card'), veilEl = $('#veil');
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };
  var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  var errors = [];
  function fail(msg) {
    var where = running.i >= 0 && SC[running.i] ? SC[running.i].id + ' phase ' + running.k : 'setup';
    var m = '[stage] ' + where + ': ' + msg;
    errors.push(m);
    console.error(m);
  }

  /* ---- the app frames --------------------------------------------------- */
  var app = { el: appF, win: null, doc: null, B: null, kind: 'app' };
  var pip = { el: pipF, win: null, doc: null, B: null, kind: 'pip' };

  function clearAppStorage() {
    // The talk starts from a fresh app: no drafts, no remembered tabs or forms.
    try {
      Object.keys(localStorage).forEach(function (k) { if (/^orgsignal\./.test(k)) localStorage.removeItem(k); });
      localStorage.setItem('orgsignal.explain', 'on');
    } catch (e) { /* storage blocked: the app falls back to its defaults */ }
  }

  function attachFrame(f, src) {
    return new Promise(function (resolve) {
      f.el.addEventListener('load', function onload() {
        f.el.removeEventListener('load', onload);
        f.win = f.el.contentWindow; f.doc = f.el.contentDocument;
        // Confirmation dialogs ("replace the current drawing?") are part of
        // what a person would click through; the talk always says yes.
        try { f.win.confirm = function () { return true; }; f.win.alert = function () {}; } catch (e) {}
        var s = f.doc.createElement('script');
        s.type = 'module'; s.src = new URL('bridge.js', location.href).href;
        f.doc.head.appendChild(s);
        (function poll(n) {
          var B = f.win.__bridge;
          // The analysis shell registers store actions; respondent mode (a share link) shows the survey only.
          var up = B && B.store && (f.kind === 'pip' ? f.doc.querySelector('.view__title, #rs-who') : B.store.actions && B.store.actions.loadDataset);
          if (up) { f.B = B; resolve(f); }
          else if (n > 600) { fail('the app did not start in ' + f.kind); resolve(f); }
          else setTimeout(function () { poll(n + 1); }, 25);
        })(0);
      });
      f.el.src = src;
    });
  }

  /* ---- selectors -------------------------------------------------------- */
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function parse(sel) {
    if (sel && typeof sel === 'object' && !Array.isArray(sel)) return sel;
    var s = String(sel), i = s.indexOf('|');
    if (i < 0) return { css: s };
    var t = s.slice(i + 1), mode = 'start';
    if (t[0] === '~') { mode = 'has'; t = t.slice(1); } else if (t[0] === '=') { mode = 'exact'; t = t.slice(1); }
    return { css: s.slice(0, i), text: t, mode: mode };
  }
  function frameOf(sel) { return sel && typeof sel === 'object' && sel.frame === 'pip' ? pip : app; }
  function visible(el) { return !!(el.getClientRects().length) && getComputedStyleSafe(el).visibility !== 'hidden'; }
  function getComputedStyleSafe(el) { try { return el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { return {}; } }
  // 'outer >> inner': inner matches inside the first visible outer match (each part may carry a |text filter).
  function findAll(sel, scope) {
    if (typeof sel === 'string' && sel.indexOf(' >> ') > 0) {
      var cut = sel.indexOf(' >> '), outer = find(sel.slice(0, cut), scope);
      return outer ? findAll(sel.slice(cut + 4), outer) : [];
    }
    var p = parse(sel), f = frameOf(sel);
    if (!f.doc) return [];
    var list;
    try { list = Array.prototype.slice.call((scope || f.doc).querySelectorAll(p.css)); } catch (e) { fail('bad selector ' + p.css); return []; }
    if (p.text != null) {
      var t = norm(p.text);
      list = list.filter(function (el) {
        var x = norm(el.textContent || el.value || el.getAttribute('aria-label'));
        return p.mode === 'exact' ? x === t : p.mode === 'has' ? x.indexOf(t) >= 0 : x.indexOf(t) === 0;
      });
    }
    var vis = list.filter(visible);
    if (vis.length) list = vis;
    if (p.nth != null) list = list[p.nth] ? [list[p.nth]] : [];
    if (p.last) list = list.length ? [list[list.length - 1]] : [];
    return list;
  }
  function find(sel, scope) { return findAll(sel, scope)[0] || null; }
  async function need(sel, ms) {
    var until = Date.now() + (ms || 12000);
    for (;;) {
      var el = find(sel);
      if (el) return el;
      if (Date.now() > until) { fail('missing element ' + JSON.stringify(sel)); return null; }
      await sleep(60);
    }
  }

  /* ---- geometry: app CSS px -> stage px ---------------------------------- */
  var cam = { x: 0, y: 0, s: 1 };
  function toStage(r, f) {
    if (f === pip) return { x: PIP.left + PIP.s * r.left, y: PIP.top + PIP.s * r.top, w: PIP.s * r.width, h: PIP.s * r.height };
    return { x: cam.x + cam.s * K * r.left, y: cam.y + cam.s * K * r.top, w: cam.s * K * r.width, h: cam.s * K * r.height };
  }
  function rectOf(sel) {
    var sels = Array.isArray(sel) ? sel : [sel];
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, f = app, any = false;
    sels.forEach(function (s) {
      var p = parse(s);
      var els = p.all ? findAll(s) : [find(s)];
      if (p.next) els = els.concat(els.map(function (el) { var n = el, out = []; for (var j = 0; j < p.next && n; j++) { n = n.nextElementSibling; if (n) out.push(n); } return out; }).reduce(function (a, b) { return a.concat(b); }, []));
      els.forEach(function (el) {
        if (!el) return;
        f = frameOf(s);
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        any = true;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      });
    });
    if (!any) return null;
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, right: x1, bottom: y1, frame: f };
  }

  function setCam(c) {
    // keep the cursor on the same point of the app while the camera moves
    if (cursorShown && cam.s) { var ax = (cpos.x - cam.x) / cam.s, ay = (cpos.y - cam.y) / cam.s; placeCursor({ x: c.x + c.s * ax, y: c.y + c.s * ay }); }
    setCamOnly(c);
  }
  function setCamOnly(c) { cam = c; camEl.style.transform = 'translate(' + c.x.toFixed(2) + 'px,' + c.y.toFixed(2) + 'px) scale(' + c.s.toFixed(4) + ')'; }
  async function tweenCam(to, fast, ms) {
    if (fast) { setCam(to); return; }
    var from = cam, t0 = performance.now(), d = ms || 1100;
    for (;;) {
      var t = Math.min(1, (performance.now() - t0) / d), e = ease(t);
      setCam({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, s: from.s + (to.s - from.s) * e });
      if (t >= 1 || isFast()) { setCam(to); return; }
      await frame();
    }
  }
  function camFor(r, opt) {
    var pad = opt.pad == null ? 28 : opt.pad;
    var w = (r.width + 2 * pad) * K, h = (r.height + 2 * pad) * K;
    var s = opt.scale || Math.min(W * 0.94 / w, H * 0.9 / h);
    s = Math.max(1, Math.min(opt.max || 2.4, s));
    var cx = (r.left + r.width / 2) * K, cy = (r.top + r.height / 2) * K;
    var x = W / 2 - s * cx, y = H / 2 - s * cy;
    x = Math.min(0, Math.max(W - W * s, x)); y = Math.min(0, Math.max(H - H * s, y));
    return { x: x, y: y, s: s };
  }

  // Legibility-aware framing (C1). The talk is sized for a ~1000 px embed (stage 994 px, player scale
  // LEG): a subject's text should reach >= 12 px there, so a subject whose own text is font f px needs a
  // camera scale of 12.6 / (f x 1.2 x LEG). If the whole subject fits at that scale it is centred; if it
  // does not, the camera keeps the needed scale and anchors on the subject's top-left (where reading
  // starts), so part of it shows legibly rather than all of it unreadably. opt.fit: fit the whole rect.
  var LEG = 994 / 1920, TARGET_PX = 13.2;
  // SVG text is drawn through the drawing's own transform, so its CSS font-size is not what is seen:
  // use the rendered line box (about 1.15 x the font size) for SVG text.
  function seenFont(pe, box, cs) {
    var fs = parseFloat(cs.fontSize);
    if (pe.closest && pe.closest('svg') && box && box.height) fs = box.height / 1.15;
    return fs;
  }
  function subjectFont(r, f) {
    f = f || app;
    if (!f.doc || !f.doc.body) return null;
    var w = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT), rg = f.doc.createRange(), sizes = [];
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      var tx = n.nodeValue; if (!tx || !tx.trim()) continue;
      var pe = n.parentElement; if (!pe || /^(SCRIPT|STYLE|OPTION)$/.test(pe.tagName)) continue;
      rg.selectNodeContents(n); var b = rg.getBoundingClientRect();
      if (!b.width) continue;
      var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cx < r.left || cx > r.left + r.width || cy < r.top || cy > r.top + r.height) continue;
      var cs = getComputedStyleSafe(pe); if (cs.visibility === 'hidden' || +cs.opacity === 0 || pe.closest('.visually-hidden')) continue;
      var fs = seenFont(pe, b, cs), c = Math.min(tx.trim().length, 60);
      for (var j = 0; j < c; j++) sizes.push(fs);
    }
    if (!sizes.length) return null;
    sizes.sort(function (a, b) { return a - b; });
    return sizes[Math.floor((sizes.length - 1) / 2)];
  }
  function frameRect(r, opt) {
    opt = opt || {};
    var pad = opt.pad == null ? 26 : opt.pad, max = opt.max || 2.4;
    // only what is visible below the app's sticky header can be framed
    var top = Math.max(r.top, opt.header ? 0 : headerBottom(app)), bottom = Math.min(r.top + r.height, APP_H);
    var left = Math.max(r.left, 0), right = Math.min(r.left + r.width, APP_W);
    if (bottom - top < 4 || right - left < 4) return null;
    var v = { left: left, top: top, width: right - left, height: bottom - top };
    var fit = camFor(v, { pad: pad, max: max, scale: opt.scale });
    if (opt.fit || opt.scale) return fit;
    var font = subjectFont(v), need = Math.max(font ? TARGET_PX / (font * K * LEG) : 1, opt.min || 1);   // opt.min: a floor on the scale
    if (!font || fit.s >= need - 0.01) return fit;
    var sc = Math.min(Math.max(need, fit.s), max);
    var wpx = (v.width + 2 * pad) * K * sc, hpx = (v.height + 2 * pad) * K * sc, x, y;
    x = wpx <= W * 0.96 ? W / 2 - sc * K * (v.left + v.width / 2) : 24 - sc * K * (v.left - pad);
    y = hpx <= H * 0.92 ? H / 2 - sc * K * (v.top + v.height / 2) : 40 - sc * K * (v.top - pad);
    x = Math.min(0, Math.max(W - W * sc, x)); y = Math.min(0, Math.max(H - H * sc, y));
    return { x: x, y: y, s: sc };
  }

  /* ---- cursor ----------------------------------------------------------- */
  var cpos = { x: 1500, y: 980 }, cursorShown = false;
  function placeCursor(p) { cpos = p; cursorEl.style.transform = 'translate(' + (p.x - 6).toFixed(1) + 'px,' + (p.y - 4).toFixed(1) + 'px)'; }
  async function moveCursor(p, fast) {
    if (!cursorShown) { cursorShown = true; cursorEl.classList.remove('hidden'); }
    if (fast) { placeCursor(p); return; }
    var from = cpos, dist = Math.hypot(p.x - from.x, p.y - from.y), d = Math.max(380, Math.min(1000, 300 + dist * 0.55)), t0 = performance.now();
    for (;;) {
      var t = Math.min(1, (performance.now() - t0) / d), e = ease(t);
      // a slight arc, as a hand moves
      var arc = Math.sin(Math.PI * e) * Math.min(40, dist * 0.06);
      placeCursor({ x: from.x + (p.x - from.x) * e, y: from.y + (p.y - from.y) * e - arc });
      if (t >= 1 || isFast()) { placeCursor(p); return; }
      await frame();
    }
  }
  function ripple(p) {
    var r = document.createElement('div');
    r.className = 'ripple'; r.style.left = p.x + 'px'; r.style.top = p.y + 'px';
    overlay.appendChild(r);
    setTimeout(function () { r.remove(); }, 700);
  }
  cursorEl.classList.add('hidden');
  placeCursor(cpos);

  /* ---- highlights and callouts (re-placed every frame: they follow scrolling and zoom) */
  var marks = [];
  function addMark(m) {
    var d = document.createElement('div');
    d.className = m.kind === 'callout' ? 'callout' : 'hl' + (m.opt.dim ? ' hl--dim' : '') + (m.opt.soft ? ' hl--soft' : '');
    if (m.kind === 'callout') d.textContent = m.text;
    else if (m.label) { var l = document.createElement('span'); l.className = 'hl__label' + (m.opt.below ? ' hl__label--below' : ''); l.textContent = m.label; d.appendChild(l); }
    hlsEl.appendChild(d);
    m.div = d; marks.push(m);
    placeMarks();
  }
  function clearMarks() { marks.forEach(function (m) { m.div.remove(); }); marks = []; }
  function placeMarks() {
    marks.forEach(function (m) {
      var r = m.sel ? rectOf(m.sel) : null;
      if (m.kind === 'callout') {
        var x, y;
        if (m.opt.at) { x = m.opt.at[0]; y = m.opt.at[1]; }
        else if (r) {
          var s = toStage(r, r.frame), side = m.opt.side || 'right';
          var cw = m.div.offsetWidth, ch = m.div.offsetHeight;
          x = side === 'left' ? s.x - cw - 24 : side === 'below' ? s.x : side === 'above' ? s.x : s.x + s.w + 24;
          y = side === 'below' ? s.y + s.h + 18 : side === 'above' ? s.y - ch - 18 : s.y;
          x = Math.max(24, Math.min(W - cw - 24, x)); y = Math.max(24, Math.min(H - ch - 24, y));
        } else { m.div.style.display = 'none'; return; }
        m.div.style.display = ''; m.div.style.left = x + 'px'; m.div.style.top = y + 'px';
        return;
      }
      if (!r) { m.div.style.display = 'none'; return; }
      var st = toStage(r, r.frame), pad = m.opt.pad == null ? 8 : m.opt.pad;
      m.div.style.display = '';
      m.div.style.left = (st.x - pad) + 'px'; m.div.style.top = (st.y - pad) + 'px';
      m.div.style.width = (st.w + 2 * pad) + 'px'; m.div.style.height = (st.h + 2 * pad) + 'px';
      // a label that would sit under the app's sticky header (or off the top) moves down, just below the header
      var lab = m.div.querySelector('.hl__label:not(.hl__label--below)');
      if (lab) {
        var hdr = r.frame === app && !m.opt.inHeader ? cam.y + cam.s * K * headerBottom(app) : 0;
        var want = st.y - pad - lab.offsetHeight - 8, minY = Math.max(6, hdr + 6);
        lab.style.bottom = want < minY ? 'auto' : '';
        lab.style.top = want < minY ? (minY - (st.y - pad)) + 'px' : '';
      }
    });
  }
  (function loop() { placeMarks(); requestAnimationFrame(loop); })();

  // The app's sticky masthead (taller when data is loaded: the loaded-data chip has its own row).
  function headerBottom(f) {
    if (!f || f !== app || !f.doc) return 0;
    var h = f.doc.querySelector('.app-header');
    if (!h) return 0;
    var cs = getComputedStyleSafe(h);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') return 0;
    return Math.max(0, h.getBoundingClientRect().bottom);
  }

  /* ---- scrolling -------------------------------------------------------- */
  function scroller(f) { return f.doc && (f.doc.scrollingElement || f.doc.documentElement); }
  async function scrollTo(f, y, fast, box) {
    var el = box || scroller(f);
    if (!el) return;
    var max = el.scrollHeight - el.clientHeight;
    y = Math.max(0, Math.min(max, Math.round(y)));
    var from = el.scrollTop;
    if (Math.abs(y - from) < 2) return;
    if (fast) { el.scrollTop = y; await frame(); return; }
    var d = Math.max(450, Math.min(1200, 350 + Math.abs(y - from) * 0.6)), t0 = performance.now();
    for (;;) {
      var t = Math.min(1, (performance.now() - t0) / d);
      el.scrollTop = from + (y - from) * ease(t);
      if (t >= 1 || isFast()) { el.scrollTop = y; return; }
      await frame();
    }
  }
  // Bring an element into the app viewport if it is not comfortably inside it.
  async function reveal(el, f, fast, opt) {
    opt = opt || {};
    // room for the sticky header plus a highlight label above the target
    var hb = headerBottom(f), r = el.getBoundingClientRect(), vh = f === pip ? PIP.cssH : APP_H, top = Math.max(opt.top == null ? 90 : opt.top, hb + 44);
    var box = scrollParent(el, f);
    if (box) {
      var br = box.getBoundingClientRect();
      if (r.top < br.top || r.bottom > br.bottom) await scrollTo(f, box.scrollTop + (r.top - br.top) - 16, fast, box);
      r = el.getBoundingClientRect();
    }
    if (r.top >= Math.max(60, hb + 44) && r.bottom <= vh - 40 && !opt.force) return;
    var se = scroller(f);
    var y = opt.block === 'center' ? se.scrollTop + r.top + r.height / 2 - vh / 2 : se.scrollTop + r.top - top;
    await scrollTo(f, y, fast);
  }
  function scrollParent(el, f) {
    for (var p = el.parentElement; p && p !== f.doc.body && p !== f.doc.documentElement; p = p.parentElement) {
      var cs = getComputedStyleSafe(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  }

  /* ---- events ----------------------------------------------------------- */
  function center(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function fire(el, f) {
    var c = center(el), W2 = f.win;
    var base = { bubbles: true, cancelable: true, composed: true, clientX: c.x, clientY: c.y, button: 0, view: W2 };
    try {
      el.dispatchEvent(new W2.PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }, base)));
      el.dispatchEvent(new W2.MouseEvent('mousedown', Object.assign({ buttons: 1 }, base)));
      if (el.focus) try { el.focus({ preventScroll: true }); } catch (e) {}
      el.dispatchEvent(new W2.PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base)));
      el.dispatchEvent(new W2.MouseEvent('mouseup', base));
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new W2.MouseEvent('click', base));
    } catch (e) { fail('click failed: ' + e.message); }
  }
  function setValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? el.ownerDocument.defaultView.HTMLSelectElement.prototype : el.ownerDocument.defaultView.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }
  function ev(el, type) { el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true })); }

  /* ---- app state helpers ------------------------------------------------ */
  function store() { return app.B && app.B.store; }
  function appBusy() {
    var S = store();
    if (!S) return true;
    if ((S.get().jobs || []).length) return true;
    return !!(app.doc && app.doc.querySelector('.status__job'));
  }
  // After a phase: wait for the app to finish what the phase started, holding the player's clock meanwhile
  async function idleHeld() {
    if (STILL || !appBusy()) return idle();
    holding++;
    try { await idle(); } finally { holding--; }
  }
  async function idle(ms) {
    var until = Date.now() + 240000;
    while (appBusy() && Date.now() < until) await sleep(60);
    await frame(); await frame();
    if (ms) await sleep(ms);
  }
  async function mapReady() {
    // The Network map: wait for the layout, the canvas and the camera.
    var until = Date.now() + 30000;
    for (;;) {
      var d = app.doc;
      var waiting = d && (d.querySelector('.net__empty') || (d.querySelector('.net') && !d.querySelector('.net__canvas canvas')));
      if (!waiting || Date.now() > until) break;
      await sleep(80);
    }
    await sleep(STILL || isFast() ? 650 : 500);
  }
  function dismissNotices() {
    var S = store();
    if (!S) return;
    (S.get().notices || []).forEach(function (n) { try { S.actions.dismiss(n.id); } catch (e) {} });
    S.set({ notices: [], notice: null });
  }

  // Build > Draw refits a drawing to its group outlines a moment after it loads;
  // wait until the canvas transform has held still for 400 ms (at most 4 s).
  async function drawingSettled() {
    var until = Date.now() + 4000, last = null, since = Date.now();
    while (Date.now() < until) {
      var g = app.doc && app.doc.querySelector('svg[role=application] > g');
      if (!g) return;
      var t = g.getAttribute('transform');
      if (t !== last) { last = t; since = Date.now(); }
      else if (Date.now() - since >= 400) return;
      await frame();
    }
  }

  /* ---- data: generated worlds, classic datasets, cached for the session -- */
  var cache = new Map();
  var loaded = null; // { key, ds }
  async function load(spec) {
    var S = store(), B = app.B;
    if (spec.clear) { S.actions.startOver(); loaded = null; await idle(); return; }
    if (spec.example) {
      // wait for this example itself: the previous Build tab could satisfy a generic selector (M2)
      var EX = await B.imp('../app/src/builders/examples.js'), ex = EX.exampleById(spec.example);
      app.win.location.hash = '#build?example=' + spec.example;
      var untilEx = Date.now() + 15000, okEx = false;
      while (Date.now() < untilEx && !okEx) {
        var d0 = app.doc, ep = d0.querySelector('#obpanel-ego'), card = d0.querySelector('#obpanel-draw .ob-example');
        okEx = ex && ex.kind === 'ego' ? !!(ep && ep.textContent.indexOf(ex.title) >= 0)
          : !!(card && ex && card.textContent.indexOf(ex.title) >= 0 && d0.querySelector('[data-node]'));
        if (!okEx) await sleep(60);
      }
      if (!okEx) fail('example ' + spec.example + ' did not open');
      await idle(300);
      await drawingSettled();
      dismissNotices(); return;
    }
    if (spec.perceived) {
      app.win.location.hash = '#build?perceived=' + spec.perceived;
      await need('#obtab-perceived', 15000);
      // the study arrives asynchronously; its notice says so
      var until = Date.now() + 15000;
      while (Date.now() < until && !(app.doc.querySelector('#obpanel-perceived table') || (store().get().notices || []).some(function (n) { return /informants/.test(n.text); }))) await sleep(80);
      await idle(300); dismissNotices(); return;
    }
    var key = JSON.stringify(spec);
    var st = S.get();
    if (loaded && loaded.key === key && st.dataset === loaded.ds && !st.lastRebuild) { return; }
    var c = cache.get(key);
    if (c) {
      await S.actions.loadDataset(c.ds, { mode: 'replace' });
      S.set({ datasets: [c.ds], generated: c.gen || null });
    } else if (spec.generate) {
      var G = await B.imp('../app/src/ui/generate/index.js');
      await G.generateAndAnalyze(Object.assign({ content: 'full', observation: 'full' }, spec.generate));
      var until = Date.now() + 240000;
      while (!(S.get().generated && S.get().generated.recovery) && Date.now() < until) await sleep(150);
      st = S.get();
      c = { ds: st.dataset, gen: st.generated };
      cache.set(key, c);
    } else if (spec.classic) {
      var C = await B.imp('../app/src/core/classic.js');
      var ds = await C.loadClassic(spec.classic);
      await S.actions.loadDataset(ds, { mode: 'replace' });
      S.set({ datasets: [ds] });
      c = { ds: ds, gen: null };
      cache.set(key, c);
    } else { fail('unknown load spec ' + key); return; }
    loaded = { key: key, ds: c.ds };
    await idle();
    dismissNotices();
  }

  /* ---- running actions -------------------------------------------------- */
  var running = { i: -1, k: -1, fast: true };
  var holding = 0;   // >0 while playback waits for the app (the player holds its clock)
  var waitingClock = 0;   // >0 while a step waits for the player's clock (never hold the clock then)
  var hurry = false;
  function isFast() { return running.fast || hurry || STILL; }
  var ctx = {
    get app() { return app; }, get pip() { return pip; }, get store() { return store(); }, get B() { return app.B; },
    find: find, findAll: findAll, need: need, sleep: sleep, idle: idle, fail: fail, cache: cache,
    fast: function () { return isFast(); }, setValue: setValue, ev: ev,
    text: function (sel) { var e = find(sel); return e ? norm(e.innerText || e.textContent) : ''; }
  };

  async function settle(fast, ms) {
    await idle();
    if (!fast) await sleep(ms == null ? 260 : ms);
  }

  // animOnly: only in animated playback (a settled replay skips it). ifPresent: skip quietly when
  // the element is absent. hold (and every waitFor): the player's clock waits while it runs.
  async function exec(a) {
    var fast = isFast();
    if (a.animOnly && fast) return;
    if (a.ifPresent && a.sel && !find(a.sel)) { if (!fast) await sleep(250); if (!find(a.sel)) return; }
    // holds apply in playback even when catching up (fast); only the settled QA mode (STILL) has no player clock to hold
    var h = !STILL && (a.hold || a.a === 'waitFor' || a.a === 'load');   // loading a dataset holds the clock too
    if (h) holding++;
    try { return await exec1(a); } finally { if (h) holding--; }
  }
  async function exec1(a) {
    var fast = isFast(), el, f, r, p;
    switch (a.a) {
      case 'go':
        store().actions.setView(a.view, { focus: false });
        await idle(); await scrollTo(app, 0, true);
        if (a.view === 'network') await mapReady();
        return;
      case 'nav':
        el = await need('.app-nav a|' + a.label);
        if (!el) return;
        await pointAt(el, app, fast); fire(el, app);
        await settle(fast); await scrollTo(app, 0, true);
        if (/^Network/.test(a.label)) await mapReady();
        return;
      case 'hash': app.win.location.hash = a.hash; await sleep(fast ? 120 : 400); await idle(); return;
      case 'load': await load(a.spec); return;
      case 'remount': store().set({ epoch: (store().get().epoch || 0) + 1 }); await idle(150); return;
      case 'storage': try { localStorage.setItem(a.key, JSON.stringify(a.value)); } catch (e) {} return;
      case 'js':
        try { await a.fn(ctx); } catch (e) { fail('js ' + (a.label || '') + ': ' + (e && e.message)); }
        await idle(); return;
      case 'click':
      case 'cursor':
        f = frameOf(a.sel);
        el = await need(a.sel, a.timeout);
        if (!el) return;
        // a control that is still busy (detection, a job) is disabled: wait for it, as a person would
        for (var w = 0; el.disabled && w < 1200; w++) { await sleep(100); if (!el.isConnected) el = await need(a.sel, a.timeout); if (!el) return; }
        if (el.disabled) fail('control stayed disabled: ' + JSON.stringify(a.sel));
        if (!a.noScroll) await reveal(el, f, fast, a);
        await pointAt(el, f, fast);
        if (a.a === 'click') {
          if (!fast) { ripple(cpos); await sleep(110); }
          fire(el, f);
          if (a.hl) addMark({ kind: 'hl', sel: a.sel, label: a.label, opt: a });
          if (a.noWait) { await frame(); return; }   // start something and move on (a later step waits for it)
          await settle(fast, a.after);
          if (a.map) await mapReady();
        } else {
          if (a.ripple && !fast) { ripple(cpos); await sleep(200); }
          if (a.hl) addMark({ kind: 'hl', sel: a.sel, label: a.label, opt: a });
        }
        return;
      case 'type':
        f = frameOf(a.sel);
        el = await need(a.sel);
        if (!el) return;
        await reveal(el, f, fast, a);
        await pointAt(el, f, fast);
        if (!fast) { ripple(cpos); await sleep(120); }
        try { el.focus({ preventScroll: true }); } catch (e) {}
        if (fast || a.instant) { setValue(el, a.text); ev(el, 'input'); }
        else {
          var s0 = a.append ? el.value : '';
          for (var j = 1; j <= a.text.length; j++) { setValue(el, s0 + a.text.slice(0, j)); ev(el, 'input'); await sleep(isFast() ? 0 : 55); }
        }
        ev(el, 'change');
        if (a.enter) { el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
        await settle(fast);
        return;
      case 'select':
        f = frameOf(a.sel);
        el = await need(selectSel(a.sel));
        if (!el) return;
        if (el.tagName !== 'SELECT') el = el.querySelector('select');
        if (!el) { fail('no <select> for ' + JSON.stringify(a.sel)); return; }
        await reveal(el, f, fast, a);
        await pointAt(el, f, fast);
        if (!fast) { ripple(cpos); await sleep(300); }
        var opts = Array.prototype.map.call(el.options, function (o) { return o.value; });
        var val = a.value;
        if (opts.indexOf(val) < 0) {
          var byText = Array.prototype.find.call(el.options, function (o) { return norm(o.textContent).indexOf(a.value) === 0; });
          if (byText) val = byText.value; else { fail('select ' + JSON.stringify(a.sel) + ' has no option ' + a.value + ' (' + opts.join(', ') + ')'); return; }
        }
        setValue(el, val); ev(el, 'input'); ev(el, 'change');
        if (a.hl) addMark({ kind: 'hl', sel: a.sel, label: a.label, opt: a });
        await settle(fast, a.after);
        if (a.map) await mapReady();
        return;
      case 'scroll':
        f = frameOf(a.sel);
        if (a.sel == null) { await scrollTo(f, a.y || 0, fast); return; }
        el = await need(a.sel);
        if (!el) return;
        await reveal(el, f, fast, Object.assign({ force: true }, a));
        return;
      case 'scrollIn':
        el = await need(a.sel); var box = await need(a.box);
        if (!el || !box) return;
        await scrollTo(app, 0, true, null);
        r = el.getBoundingClientRect(); var br = box.getBoundingClientRect();
        await scrollTo(app, box.scrollTop + r.top - br.top - (a.top || 0), fast, box);
        return;
      case 'highlight':
        var first = Array.isArray(a.sel) ? a.sel[0] : a.sel;
        el = await need(first);
        if (!el) return;
        if (!a.noScroll) await reveal(el, frameOf(first), fast, a);
        addMark({ kind: 'hl', sel: a.sel, label: a.label, opt: a });
        if (!fast) await sleep(a.hold == null ? 500 : a.hold);
        return;
      case 'clear': clearMarks(); return;
      case 'open':
        // a <details> note: click its summary only when it is closed (notes may start open), else point at it
        el = await need(a.sel);
        if (!el) return;
        var det = el.closest('details') || el;
        var sum = det.querySelector(':scope > summary') || el;
        if (!a.noScroll) await reveal(sum, frameOf(a.sel), fast, a);
        await pointAt(sum, frameOf(a.sel), fast);
        if (!det.open) { if (!fast) { ripple(cpos); await sleep(110); } fire(sum, frameOf(a.sel)); await settle(fast); }
        return;
      case 'close':
        // the opposite: fold a note that pushes the subject off screen
        el = find(a.sel);
        if (!el) return;
        var det2 = el.closest('details') || el;
        if (det2.open) { var sum2 = det2.querySelector(':scope > summary'); if (sum2) { if (!fast) { await pointAt(sum2, app, fast); ripple(cpos); await sleep(110); } fire(sum2, app); await settle(fast); } }
        return;
      case 'callout':
        // text may be a function of the screen (ctx), so a restated value always matches the app
        var ctext = typeof a.text === 'function' ? await a.text(ctx) : a.text;
        if (!ctext) { fail('callout: no text'); return; }
        addMark({ kind: 'callout', sel: a.sel || null, text: ctext, opt: a });
        if (!fast) await sleep(400);
        return;
      case 'zoom':
        el = await need(Array.isArray(a.sel) ? a.sel[0] : a.sel);
        if (!el) return;
        var rr = el.getBoundingClientRect();
        if (!a.noScroll && (rr.top < 0 || rr.bottom > APP_H)) {
          if (cam.s !== 1) await tweenCam({ x: 0, y: 0, s: 1 }, fast, 500);
          await reveal(el, app, fast, Object.assign({ block: 'center' }, a));
        }
        r = rectOf(a.sel);
        var to = r ? frameRect(r, a) : null;
        if (to) { if (Math.abs(to.s - cam.s) > 0.01 || Math.abs(to.x - cam.x) > 2 || Math.abs(to.y - cam.y) > 2) await tweenCam(to, fast); }
        return;
      case 'unzoom': await tweenCam({ x: 0, y: 0, s: 1 }, fast, 900); return;
      case 'pip':
        pipEl.hidden = false;
        if (a.title) $('#pip-title').textContent = a.title;
        var url = typeof a.url === 'function' ? await a.url(ctx) : a.url;
        if (!fast) { pipEl.animate([{ opacity: 0, transform: 'translateY(30px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: 'ease-out' }); }
        await attachFrame(pip, url);
        await sleep(fast ? 200 : 700);
        return;
      case 'pipClose':
        if (!pipEl.hidden) { pipEl.hidden = true; pip.el.src = 'about:blank'; pip.win = pip.doc = pip.B = null; }
        return;
      case 'dismiss': dismissNotices(); await frame(); return;
      case 'wait': if (!fast || a.always) await sleep(a.ms); return;
      case 'until':
        // playback only: wait until the player clock reaches this share of the passage's reading time
        if (fast) return;
        var ci = running.i, ck = running.k, c0 = cueOf(ci, ck), ps0 = (TL[ci] && TL[ci].paragraphs) || [];
        var c1 = ps0[ck + 1] ? ps0[ck + 1].at : (TL[ci] ? TL[ci].duration : c0 + 10);
        var target = c0 + a.share * (c1 - c0);
        // only while the talk plays: a visitor stepping with ‹ › has paused the clock, so the step finishes now
        waitingClock++;
        try { while (clock < target && !stale() && !hurry && playerPlaying) await sleep(50); } finally { waitingClock--; }
        return;
      case 'waitFor':
        if (typeof a.sel === 'function') { var until = Date.now() + (a.timeout || 30000); while (!a.sel(ctx) && Date.now() < until) await sleep(80); if (!a.sel(ctx)) fail('waitFor timed out'); }
        else await need(a.sel, a.timeout || 30000);
        await idle();
        return;
      case 'idle': await idle(a.ms); return;
      case 'map': await mapReady(); return;
      case 'sort':
        // People's table: click a column heading until it sorts the way asked (the view remembers its last sort)
        for (var c = 0; c < 3; c++) {
          el = await need('.vt__sort|' + a.label);
          if (!el) return;
          var th = el.closest('[role=columnheader]');
          if (th && th.getAttribute('aria-sort') === (a.dir || 'descending')) break;
          await pointAt(el, app, fast); if (!fast) { ripple(cpos); await sleep(110); }
          fire(el, app); await settle(fast);
        }
        return;
      default: fail('unknown action ' + a.a);
    }
  }
  // A select given by its field label ("Color by") or by a CSS selector.
  function selectSel(sel) {
    if (typeof sel === 'string' && !/[.#\[\]>:|]/.test(sel) && !/^select\b/.test(sel)) return 'label.field|' + sel;
    return sel;
  }
  async function pointAt(el, f, fast) {
    var c = center(el), r = el.getBoundingClientRect();
    // aim a little inside the left part of wide targets, as a person would
    var x = r.width > 160 ? r.left + Math.min(70, r.width * 0.25) : c.x;
    var s = toStage({ left: x, top: c.y, width: 0, height: 0 }, f);
    await moveCursor({ x: s.x, y: s.y }, fast);
  }

  function flat(list) { var out = []; (list || []).forEach(function (x) { if (Array.isArray(x)) out.push.apply(out, flat(x)); else if (x) out.push(x); }); return out; }
  // phase.hold: a long multi-step phase holds the player's clock until it has run (playback only)
  async function runPhase(i, k, fast) {
    var ph = phaseOf(i, k), h = ph.hold && !STILL;
    if (h) holding++;
    try { await runList(ph.do, fast); } finally { if (h) holding--; }
  }
  async function runList(list, fast) {
    list = flat(list);
    running.fast = fast;
    for (var j = 0; j < (list || []).length; j++) {
      if (stale()) running.fast = true;
      try { await exec(list[j]); } catch (e) { fail((list[j] && list[j].a) + ': ' + (e && e.message)); }
    }
  }
  // Auto-framing (C1): after a phase runs, the camera frames the phase's subject, the union of its
  // highlight boxes in the app, when that makes it larger; a phase with no highlight shows the whole
  // stage. A phase that moves the camera itself (zoom/unzoom) or sets frame: false is left alone;
  // frame: { sel, max, pad } frames something else. Capped at 2.2x.
  async function frameSubject(i, k, fast) {
    var ph = phaseOf(i, k);
    if (ph.frame === false || Q.get('frame') === '0') return;   // ?frame=0: no auto-framing (QA comparison)
    var acts = flat(ph.do);
    if (acts.some(function (a) { return a.a === 'zoom'; })) return;   // an explicit zoom frames the phase itself
    var opt = typeof ph.frame === 'object' ? ph.frame : {};
    var r = null;
    if (opt.sel) r = rectOf(opt.sel);
    else {
      var sels = marks.filter(function (m) { return m.kind === 'hl' && m.sel && !m.opt.noFrame; }).map(function (m) { return m.sel; });
      var inApp = sels.filter(function (sl) { var f0 = frameOf(Array.isArray(sl) ? sl[0] : sl); return f0 === app; });
      if (inApp.length) r = rectOf([].concat.apply([], inApp.map(function (x) { return Array.isArray(x) ? x : [x]; })));
    }
    var to = { x: 0, y: 0, s: 1 };
    if (r) {
      var c = frameRect(r, { pad: opt.pad == null ? 26 : opt.pad, max: opt.max || 2.4, fit: opt.fit, header: opt.header, min: opt.min });
      if (c && c.s >= 1.12) to = c;
    }
    if (Math.abs(to.s - cam.s) > 0.01 || Math.abs(to.x - cam.x) > 2 || Math.abs(to.y - cam.y) > 2) await tweenCam(to, fast, 900);
  }
  function phaseOf(i, k) { var p = SC[i].phases[k]; return Array.isArray(p) ? { do: p } : p; }

  // Every state starts from the same place, whatever came before it.
  async function baseReset() {
    clearMarks();
    if (!pipEl.hidden) await exec({ a: 'pipClose' });
    setCam({ x: 0, y: 0, s: 1 });
    var S = store();
    if (!S) return;
    S.actions.closeDrawer && S.actions.closeDrawer();
    S.actions.select([]);
    // a fresh mount of the view: its own local state (an open tie's evidence, open panels) goes too
    S.set({ ui: Object.assign({}, S.get().ui || {}, { drawer: false, profile: null, menuOpen: false }), epoch: (S.get().epoch || 0) + 1 });
    dismissNotices();
    if (S.actions.resumeNotices) S.actions.resumeNotices();
  }

  /* ---- the runner ------------------------------------------------------- */
  var cur = { i: -1, k: -1 };          // on screen (the last phase completed)
  var goal = { i: 0, k: 0, anim: false, reset: true, n: 0 };
  var pumping = false, seq = 0, resetting = false, veilT0 = null;
  function stale() { return goal.i !== running.i || goal.reset; }
  function request(i, k, opt) {
    opt = opt || {};
    goal = { i: i, k: k, anim: !!opt.anim && !STILL, reset: !!opt.reset, cont: !!opt.cont, n: ++seq };
    if (pumping) hurry = true;
    pump();
  }
  async function pump() {
    if (pumping || !ready) return;
    pumping = true;
    try {
      while (goal.reset || cur.i !== goal.i || cur.k !== goal.k) {
        hurry = false;
        var g = goal;
        if (g.cont && SC[g.i].continues && g.k === 0 && cur.i === g.i - 1 && cur.k === SC[cur.i].phases.length - 1) {
          // Continuous play into a state that picks up where the previous one ended
          // (state.continues): keep the app as it is, no reset and no setup (M1).
          goal = Object.assign({}, g, { reset: false, cont: false });
          running.i = g.i; running.k = 0;
          clearMarks();
          cur = { i: g.i, k: -1 };
          await runPhase(g.i, 0, STILL || !g.anim);
          await frameSubject(g.i, 0, STILL || !g.anim);
          await idleHeld();
          cur = { i: g.i, k: 0 };
          continue;
        }
        if (g.reset || g.i !== cur.i || g.k < cur.k) {
          goal = Object.assign({}, g, { reset: false, cont: false });
          resetting = true;
          var veilT = veilT0 = STILL ? null : setTimeout(function () { veilEl.hidden = false; }, 600);
          running.i = g.i; running.k = -1;
          await baseReset();
          await runList(SC[g.i].setup, true);
          await idle();
          cur = { i: g.i, k: -1 };
          var stop = false;
          for (var k = 0; k < g.k; k++) {
            running.k = k;
            if (goal.i !== g.i || goal.reset) { stop = true; break; }
            clearMarks();
            await runList(phaseOf(g.i, k).do, true);
            await frameSubject(g.i, k, true);
            cur.k = k;
          }
          clearTimeout(veilT); veilEl.hidden = true;
          resetting = false;
          if (stop) continue;
          running.k = g.k;
          clearMarks();
          await runPhase(g.i, g.k, !g.anim);
          await frameSubject(g.i, g.k, !g.anim);
          await idleHeld();
          cur = { i: g.i, k: g.k };
        } else {
          var next = cur.k + 1;
          running.i = g.i; running.k = next;
          clearMarks();
          var fastNext = STILL || !(goal.anim && next === goal.k);
          await runPhase(g.i, next, fastNext);
          await frameSubject(g.i, next, fastNext);
          await idleHeld();
          cur = { i: g.i, k: next };
        }
      }
    } catch (e) { fail('runner: ' + (e && e.stack || e)); }
    finally { pumping = false; hurry = false; running.fast = true; resetting = false; clearTimeout(veilT0); veilEl.hidden = true; }
  }

  /* ---- clock and player hooks ------------------------------------------ */
  var clock = 0, navCount = 0, ready = false, playerPlaying = true;
  function phaseAt(i, t) {
    var ps = (TL[i] && TL[i].paragraphs) || [], k = 0;
    ps.forEach(function (p, j) { if (p.at <= t + 1e-6) k = j; });
    return Math.min(k, Math.max(0, SC[i].phases.length - 1));
  }
  function cueOf(i, k) { var ps = (TL[i] && TL[i].paragraphs) || []; return ps[k] ? ps[k].at : 0; }

  var cardTimer = null;
  function showCard(i) {
    if (STILL || !SC[i]) return;
    var first = i === 0 || SC[i - 1].chapter !== SC[i].chapter;
    if (!first) return;
    $('#card-k').textContent = SC[i].chapter === 0 ? 'Learning network analysis with Org Signal' : 'Question ' + SC[i].chapter;
    $('#card-h').textContent = SC[i].question || (TL[i] && TL[i].heading) || SC[i].heading || SC[i].label;
    cardEl.hidden = false;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(function () { cardEl.hidden = true; }, 3600);
  }

  // cont: the player moved here by itself at the end of the previous state (continuous play)
  window.__seek = function (i, cont) {
    i = Math.max(0, Math.min(SC.length - 1, i | 0));
    clock = 0;
    showCard(i);
    request(i, 0, { anim: true, reset: true, cont: !!cont });
  };
  window.__go = function (i, k) { clock = cueOf(i, k || 0); request(i, k || 0, { anim: false, reset: true }); };
  // Step to phase k of the current state without the player (QA): forward runs only the new phases.
  window.__step = function (k) { clock = cueOf(goal.i, k); request(goal.i, k, { anim: false }); };
  window.__state = function () { return goal.i; };
  window.__phase = function () { return goal.k; };
  window.__shown = function () { return [cur.i, cur.k]; };
  window.__phases = function (i) { return SC[i == null ? goal.i : i].phases.length; };
  window.__states = function () { return SC.map(function (s) { return { id: s.id, label: s.label, chapter: s.chapter, phases: s.phases.length }; }); };
  window.__nav = function () { return navCount; };
  window.__time = function () { return clock; };
  window.__t = function (sec) {
    clock = sec;
    var k = phaseAt(goal.i, sec);
    if (k !== goal.k) request(goal.i, k, { anim: k === goal.k + 1 });
  };
  // The player reports whether it is playing (every frame); a host that never calls this counts as playing.
  window.__play = function (on) { playerPlaying = !!on; };
  window.__settled = function () { return ready && !pumping && !goal.reset && cur.i === goal.i && cur.k === goal.k && !appBusy(); };
  window.__errors = function () { return errors.slice(); };
  // The player holds its clock while this is true: a state is being prepared (behind the veil) or
  // playback waits for the app (an import, a generation).
  window.__holding = function () { return !!(ready && (resetting || holding > 0)); };
  // True while a step is still running (cursor travel, clicks, loads). The player waits on it at
  // reading speeds above 2x, so each step finishes before the next passage starts.
  window.__busy = function () { return !!(ready && pumping && !waitingClock); };
  window.__cam = function () { return cam; };
  window.__frameDebug = function () {
    var sels = marks.filter(function (m) { return m.kind === 'hl' && m.sel && !m.opt.noFrame; }).map(function (m) { return m.sel; });
    var r = sels.length ? rectOf([].concat.apply([], sels.map(function (x) { return Array.isArray(x) ? x : [x]; }))) : null;
    return { sels: sels, r: r && { left: r.left, top: r.top, width: r.width, height: r.height }, hb: headerBottom(app), font: r ? subjectFont(r) : null, to: r ? frameRect(r, {}) : null };
  };

  // Facts for the narrator: the text of the panels a phase names, and all the
  // text visible in the app's viewport (and the respondent window when open).
  function visibleText(f, vw, vh) {
    if (!f.doc || !f.doc.body) return '';
    var out = [], lastBlock = null, walker = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT);
    var range = f.doc.createRange();
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var t = n.nodeValue; if (!t || !t.trim()) continue;
      var pe = n.parentElement; if (!pe || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(pe.tagName)) continue;
      range.selectNodeContents(n);
      var r = range.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      var cs = getComputedStyleSafe(pe);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (pe.closest && pe.closest('.visually-hidden, .sr-only, .app-nav')) continue;
      var block = pe.closest('p, li, td, th, h1, h2, h3, h4, dt, dd, label, button, summary, caption, figcaption, div');
      out.push(block !== lastBlock && out.length ? '\n' : ' ');
      lastBlock = block;
      out.push(t.replace(/\s+/g, ' '));
    }
    return out.join('').replace(/ +([,.;:)])/g, '$1').replace(/\( +/g, '(').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').replace(/ {2,}/g, ' ').trim();
  }
  // What should be on screen, in a form playback can be compared against (tools/playback-check.mjs).
  function signature() {
    var S = store(), st = S ? S.get() : {};
    var d = app.doc, tab = d && d.querySelector('[role=tab][aria-selected=true]');
    return { view: st.view || null, dataset: (st.dataset && st.dataset.meta && st.dataset.meta.name) || null,
      tab: tab ? (tab.id || tab.textContent.trim()) : null, drawer: !!(st.ui && st.ui.drawer), pip: !pipEl.hidden,
      marks: marks.filter(function (m) { return m.kind === 'hl'; }).length, zoom: +cam.s.toFixed(2) };
  }
  window.__sig = signature;
  // Legibility of the passage's subject (QA, tools/legibility.mjs), measured as the learner/visual
  // audit did: on-screen px = font size x app scale x camera zoom x player scale (sps). The subject is
  // the phase's callouts if it has any, else the text inside its highlight boxes, else all visible text.
  window.__legibility = function (sps) {
    var boxes = [], callouts = [];
    marks.forEach(function (m) {
      if (m.div.style.display === 'none') return;
      var r = m.div.getBoundingClientRect();
      if (m.kind === 'callout') callouts.push(parseFloat(getComputedStyle(m.div).fontSize) * sps);
      else boxes.push(r);
    });
    var stageRect = document.getElementById('stage').getBoundingClientRect(), scaleDoc = stageRect.width / W || 1;
    // a highlight that is hidden or wholly outside the stage: the passage's subject is off screen
    var off = marks.filter(function (m) {
      if (m.kind !== 'hl') return false;
      if (m.div.style.display === 'none') return true;
      var r = m.div.getBoundingClientRect(), x0 = (r.left - stageRect.left) / scaleDoc, y0 = (r.top - stageRect.top) / scaleDoc, x1 = x0 + r.width / scaleDoc, y1 = y0 + r.height / scaleDoc;
      return x1 < 4 || y1 < 4 || x0 > W - 4 || y0 > H - 4;
    }).length;
    if (off) return { kind: 'offscreen', median: null, n: off, zoom: +cam.s.toFixed(2) };
    if (callouts.length) return { kind: 'callout', median: Math.min.apply(null, callouts), n: callouts.length };
    var sizes = [], hits = 0;
    [[app, K, 0, 0, APP_W, APP_H, true], [pip, PIP.s, PIP.left, PIP.top, PIP.cssW, PIP.cssH, false]].forEach(function (fr) {
      var f = fr[0]; if (!f.doc || !f.doc.body || (f === pip && pipEl.hidden)) return;
      var w = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT), rg = f.doc.createRange();
      for (var n = w.nextNode(); n; n = w.nextNode()) {
        var tx = n.nodeValue; if (!tx || !tx.trim()) continue;
        var pe = n.parentElement; if (!pe || /^(SCRIPT|STYLE|OPTION)$/.test(pe.tagName)) continue;
        rg.selectNodeContents(n); var r = rg.getBoundingClientRect();
        if (!r.width || r.bottom < 0 || r.top > fr[5] || r.right < 0 || r.left > fr[4]) continue;
        var cs = getComputedStyleSafe(pe); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        if (pe.closest('.visually-hidden')) continue;
        var cz = fr[6] ? cam.s : 1, ox = fr[6] ? cam.x : 0, oy = fr[6] ? cam.y : 0;
        var sx = ox + cz * (fr[2] + fr[1] * (r.left + r.width / 2)), sy = oy + cz * (fr[3] + fr[1] * (r.top + r.height / 2));
        if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        // app text behind the open respondent window is not on screen
        if (fr[6] && !pipEl.hidden && sx >= PIP.left && sx <= PIP.left + PIP.w && sy >= PIP.top - 45 && sy <= PIP.top + PIP.h) continue;
        if (boxes.length) {
          var inside = boxes.some(function (b) { var bx = (b.left - stageRect.left) / scaleDoc, by = (b.top - stageRect.top) / scaleDoc; return sx >= bx && sx <= bx + b.width / scaleDoc && sy >= by && sy <= by + b.height / scaleDoc; });
          if (!inside) continue;
        }
        hits++;
        var px = seenFont(pe, r, cs) * fr[1] * cz * sps, c = Math.min(tx.trim().length, 60);
        for (var j = 0; j < c; j++) sizes.push(px);
      }
    });
    sizes.sort(function (a, b) { return a - b; });
    var med = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : null;
    return { kind: boxes.length ? (sizes.length ? 'highlight' : 'graphic') : 'screen', median: med, n: hits, zoom: +cam.s.toFixed(2) };
  };
  window.__facts = function () {
    var res = { state: SC[cur.i] && SC[cur.i].id, phase: cur.k, panels: {}, visible: '', pip: '' };
    var ph = SC[cur.i] && phaseOf(cur.i, cur.k);
    var spec = (ph && ph.facts) || {};
    Object.keys(spec).forEach(function (label) {
      var sels = Array.isArray(spec[label]) ? spec[label] : [spec[label]];
      var txt = sels.map(function (s) { var els = findAll(s); return els.map(function (e) { return (e.innerText || e.textContent || '').trim(); }).join('\n'); }).filter(Boolean).join('\n');
      res.panels[label] = txt || null;
      if (!txt) fail('facts: nothing found for "' + label + '"');
    });
    res.visible = visibleText(app, APP_W, APP_H);
    if (!pipEl.hidden) res.pip = visibleText(pip, PIP.cssW, PIP.cssH);
    res.notices = app.doc ? Array.prototype.map.call(app.doc.querySelectorAll('.notice'), function (n) { return n.innerText.trim(); }) : [];
    res.callouts = marks.filter(function (m) { return m.kind === 'callout'; }).map(function (m) { return m.text; });
    res.zoomed = cam.s !== 1;
    res.sig = signature();
    return res;
  };

  // A visitor's click on the stage (or Enter / Space on it): one phase forward (the player pauses and follows).
  overlay.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); overlay.click(); }
  });
  overlay.addEventListener('click', function () {
    if (!ready) return;
    navCount++;
    var i = goal.i, k = goal.k;
    if (k + 1 < SC[i].phases.length) { clock = cueOf(i, k + 1); request(i, k + 1, { anim: true }); }
    else if (i + 1 < SC.length) { window.__seek(i + 1); }
  });

  /* ---- boot ------------------------------------------------------------- */
  clearAppStorage();
  attachFrame(app, new URL('../app/index.html#data', location.href).href).then(function () {
    ready = true;
    window.__deckReady = true;
    var s0 = Q.get('s'), p0 = Q.get('p');
    if (s0 != null) window.__go(+s0, +(p0 || 0));
    else if (seq) pump();                       // the player asked for a state while the app was starting
    else request(0, 0, { anim: false, reset: true });
  });
})();
