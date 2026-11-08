/*
 * Colorblind Visualizer — interface
 *
 * State
 *   shared  Screens (views + layout per screen) and display settings. Persisted in
 *           localStorage and kept in sync between this window and the windows it opens.
 *   local   Per-window state: active screen, settings rail, focus view, etc.
 *   view    Zoom and pan, shared by every preview (and every linked window).
 *
 * Images are decoded once, capped at 3840x2160 worth of pixels, and each simulation is
 * computed once (in a Web Worker) into an ImageBitmap that every preview reuses.
 */
(function () {
  'use strict';

  var CVD = window.CVD;
  var TYPES = CVD.TYPES;
  var TYPE = {};
  TYPES.forEach(function (t) { TYPE[t.id] = t; });
  var ORDER = TYPES.map(function (t) { return t.id; });
  var PARTIAL = new Set(TYPES.filter(function (t) { return t.kind === 'partial'; }).map(function (t) { return t.id; }));

  var STORE_KEY = 'colorblind-visualizer:v1';
  var MAX_PIXELS = 3840 * 2160;
  var MAX_SCREENS = 9;
  var MAX_GRID = 9;
  var MAX_ZOOM = 32;
  var BACKDROPS = ['theme', 'black', 'grey', 'white', 'checker'];
  var GAPS = [0, 4, 12];
  var THEMES = ['system', 'light', 'dark'];
  var PRESETS = {
    all: ORDER.slice(),
    none: [],
    redgreen: ['original', 'protanopia', 'protanomaly', 'deuteranopia', 'deuteranomaly'],
    blueyellow: ['original', 'tritanopia', 'tritanomaly'],
    mono: ['original', 'achromatopsia', 'achromatomaly']
  };

  // ---------------------------------------------------------------- helpers

  function $(id) { return document.getElementById(id); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function icon(name) { return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image'; }

  function readStore() {
    try { var raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeStore(obj) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch (e) { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------- state

  function makeScreen(name, views) {
    return { id: uid(), name: name, views: (views || ['original']).slice(), cols: 'auto', rows: 'auto' };
  }

  function defaultShared() {
    return {
      screens: [makeScreen('Screen 1', ORDER)],
      severity: 0.6,
      labels: true,
      gap: 4,
      backdrop: 'theme',
      theme: 'system',
      ts: 0
    };
  }

  function sanitizeAxis(v) {
    var n = parseInt(v, 10);
    return v === 'auto' || !(n >= 1) ? 'auto' : Math.min(n, MAX_GRID);
  }

  function sanitizeShared(s) {
    var d = defaultShared();
    if (!s || typeof s !== 'object') return d;
    var ids = new Set();
    var screens = Array.isArray(s.screens) ? s.screens.slice(0, MAX_SCREENS).map(function (sc, i) {
      sc = sc || {};
      var id = typeof sc.id === 'string' && /^[\w-]{1,24}$/.test(sc.id) && !ids.has(sc.id) ? sc.id : uid();
      ids.add(id);
      var views = Array.isArray(sc.views) ? ORDER.filter(function (t) { return sc.views.indexOf(t) !== -1; }) : ['original'];
      return {
        id: id,
        name: typeof sc.name === 'string' && sc.name.trim() ? sc.name.slice(0, 40) : 'Screen ' + (i + 1),
        views: views,
        cols: sanitizeAxis(sc.cols),
        rows: sanitizeAxis(sc.rows)
      };
    }) : [];
    return {
      screens: screens.length ? screens : d.screens,
      severity: typeof s.severity === 'number' && isFinite(s.severity) ? clamp(s.severity, 0, 1) : d.severity,
      labels: typeof s.labels === 'boolean' ? s.labels : d.labels,
      gap: GAPS.indexOf(s.gap) !== -1 ? s.gap : d.gap,
      backdrop: BACKDROPS.indexOf(s.backdrop) !== -1 ? s.backdrop : d.backdrop,
      theme: THEMES.indexOf(s.theme) !== -1 ? s.theme : d.theme,
      ts: typeof s.ts === 'number' ? s.ts : 0
    };
  }

  var stored = readStore() || {};
  var shared = sanitizeShared(stored.shared);

  // A window opened from "Open in a new window" carries "cbv|<group>|<screenId>" in window.name.
  // Windows of the same group mirror each other; unrelated tabs do not.
  var popoutMatch = /^cbv\|(\w+)\|([\w-]+)$/.exec(window.name || '');
  var group;
  if (popoutMatch) {
    group = popoutMatch[1];
  } else {
    try { group = sessionStorage.getItem('cbv-group'); } catch (e) { group = null; }
    if (!group || !/^\w+$/.test(group)) {
      group = uid();
      try { sessionStorage.setItem('cbv-group', group); } catch (e) { /* ignore */ }
    }
  }

  var local = {
    popout: !!popoutMatch,
    wantedId: popoutMatch ? popoutMatch[2] : null,
    activeId: typeof stored.activeId === 'string' ? stored.activeId : null,
    railOpen: popoutMatch ? false : (stored.railOpen !== false && window.innerWidth > 860),
    uiHidden: false,
    solo: null,
    peek: false
  };

  var view = { zoom: 1, cx: 0.5, cy: 0.5 };
  var layout = null;

  function activeScreen() {
    for (var i = 0; i < shared.screens.length; i++) {
      if (shared.screens[i].id === local.activeId) return shared.screens[i];
    }
    return shared.screens[0];
  }

  function persist() {
    var current = readStore() || {};
    writeStore({
      shared: shared,
      activeId: local.popout ? current.activeId : local.activeId,
      railOpen: local.popout ? current.railOpen : local.railOpen
    });
  }

  function updateShared(mutate) {
    mutate(shared);
    shared.ts = Date.now();
    persist();
    Sync.send({ t: 'state', shared: shared });
    refresh();
  }

  // ---------------------------------------------------------------- window sync

  var Sync = (function () {
    var me = uid();
    var seen = new Set();
    var peers = new Set();
    var handler = function () {};
    var bc = null;

    function remember(id) {
      seen.add(id);
      if (seen.size > 400) seen.delete(seen.values().next().value);
    }
    function relay(msg, except) {
      peers.forEach(function (w) {
        if (w === except) return;
        try {
          if (w.closed) { peers.delete(w); return; }
          w.postMessage({ __cbv: msg }, '*');
        } catch (e) { peers.delete(w); }
      });
    }
    function receive(msg, source) {
      if (!msg || msg.group !== group || msg.from === me || seen.has(msg.mid)) return;
      remember(msg.mid);
      relay(msg, source);
      handler(msg);
    }

    try {
      bc = new BroadcastChannel('colorblind-visualizer');
      bc.onmessage = function (e) { receive(e.data, null); };
    } catch (e) { bc = null; }

    if (window.opener && window.opener !== window) peers.add(window.opener);

    window.addEventListener('message', function (e) {
      if (!e.data || !e.data.__cbv) return;
      if (location.origin !== 'null' && e.origin !== location.origin) return;
      if (e.source) peers.add(e.source);
      receive(e.data.__cbv, e.source);
    });

    return {
      on: function (fn) { handler = fn; },
      addPeer: function (w) { if (w) peers.add(w); },
      send: function (payload) {
        var msg = Object.assign({}, payload, { group: group, from: me, mid: uid() + uid() });
        remember(msg.mid);
        if (bc) { try { bc.postMessage(msg); } catch (e) { /* not cloneable here */ } }
        relay(msg, null);
      }
    };
  })();

  // ---------------------------------------------------------------- processing engine

  var Engine = {
    backend: null,
    ready: null,
    image: null,        // { id, name, width, height, origWidth, origHeight, sample }
    sourceBlob: null,
    loadingId: null,
    bitmaps: new Map(), // type -> { bmp, severity }
    inflight: new Map() // type -> severity
  };

  Engine.ready = CVD.createBackend(onEngineMessage).then(function (b) {
    Engine.backend = b;
    schedule();
    return b;
  });

  function severityFor(type) { return PARTIAL.has(type) ? shared.severity : 1; }

  function isFresh(type) {
    var e = Engine.bitmaps.get(type);
    return !!e && (type === 'original' || e.severity === severityFor(type));
  }

  function neededTypes() {
    var active = local.solo ? [local.solo] : activeScreen().views;
    var all = new Set();
    shared.screens.forEach(function (s) { s.views.forEach(function (v) { all.add(v); }); });
    if (local.solo) all.add(local.solo);
    var rest = ORDER.filter(function (t) { return all.has(t) && active.indexOf(t) === -1; });
    return active.concat(rest).filter(function (t) { return t !== 'original'; });
  }

  function schedule() {
    if (!Engine.image || !Engine.backend || Engine.loadingId) { updateBusy(); return; }
    neededTypes().forEach(function (type) {
      if (isFresh(type) || Engine.inflight.has(type)) return;
      var sev = severityFor(type);
      Engine.inflight.set(type, sev);
      Engine.backend.post({ cmd: 'run', imageId: Engine.image.id, type: type, severity: sev });
    });
    updateBusy();
  }

  function toDrawable(source) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(source).catch(function () { return canvasFrom(source); });
    }
    return Promise.resolve(canvasFrom(source));
  }

  function canvasFrom(source) {
    var c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    var ctx = c.getContext('2d');
    if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
    else ctx.drawImage(source, 0, 0);
    return c;
  }

  function releaseDrawable(d) { if (d && typeof d.close === 'function') d.close(); }

  function onEngineMessage(msg) {
    if (!msg || msg.cmd !== 'done') return;
    if (!Engine.image || msg.imageId !== Engine.image.id) return;
    Engine.inflight.delete(msg.type);
    var data = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
    toDrawable(data).then(function (bmp) {
      if (!Engine.image || msg.imageId !== Engine.image.id) { releaseDrawable(bmp); return; }
      var prev = Engine.bitmaps.get(msg.type);
      Engine.bitmaps.set(msg.type, { bmp: bmp, severity: msg.severity });
      cells.forEach(function (c) { if (c.type === msg.type || local.peek) drawCell(c); });
      if (prev) releaseDrawable(prev.bmp);
      schedule();
      resolveWaiters();
    });
  }

  var waiters = [];
  function whenReady(types) {
    return new Promise(function (resolve) {
      var check = function () { return types.every(isFresh); };
      if (check()) resolve();
      else waiters.push({ check: check, resolve: resolve });
    });
  }
  function resolveWaiters() {
    waiters = waiters.filter(function (w) {
      if (w.check()) { w.resolve(); return false; }
      return true;
    });
  }

  function decodeImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 1024;
        var h = img.naturalHeight || 1024;
        resolve({ source: img, width: w, height: h, release: function () { URL.revokeObjectURL(url); } });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  /**
   * Loads an image Blob. opts: { id, sample, broadcast }.
   * A newer call supersedes an older one that is still decoding.
   */
  function loadImage(blob, name, opts) {
    opts = opts || {};
    if (opts.sample && Engine.image && !Engine.image.sample) return Promise.resolve();
    var id = opts.id || uid();
    Engine.loadingId = id;
    updateBusy();

    return decodeImage(blob).then(function (decoded) {
      if (Engine.loadingId !== id) { decoded.release(); return; }
      var ow = decoded.width, oh = decoded.height;
      var k = Math.min(1, Math.sqrt(MAX_PIXELS / (ow * oh)));
      var w = Math.max(1, Math.round(ow * k));
      var h = Math.max(1, Math.round(oh * k));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded.source, 0, 0, w, h);
      decoded.release();
      var pixels = ctx.getImageData(0, 0, w, h);

      return Promise.all([toDrawable(canvas), Engine.ready]).then(function (res) {
        var original = res[0], backend = res[1];
        if (Engine.loadingId !== id) { releaseDrawable(original); return; }
        Engine.bitmaps.forEach(function (e) { releaseDrawable(e.bmp); });
        Engine.bitmaps.clear();
        Engine.inflight.clear();
        Engine.bitmaps.set('original', { bmp: original, severity: 1 });
        Engine.image = { id: id, name: name || 'image', width: w, height: h, origWidth: ow, origHeight: oh, sample: !!opts.sample };
        Engine.sourceBlob = blob;
        Engine.loadingId = null;
        backend.post({ cmd: 'load', imageId: id, width: w, height: h, buffer: pixels.data.buffer }, [pixels.data.buffer]);
        // Images from a linked window keep the shared zoom; local loads start from "fit".
        if (!opts.remote) view = { zoom: 1, cx: 0.5, cy: 0.5 };
        if (opts.broadcast) {
          Sync.send({ t: 'image', id: id, name: Engine.image.name, sample: !!opts.sample, blob: blob });
          Sync.send({ t: 'view', view: view });
        }
        renderGrid();
        schedule();
        updateStatus();
        resolveWaiters();
      });
    }).catch(function (err) {
      if (Engine.loadingId !== id) return;
      Engine.loadingId = null;
      updateBusy();
      console.error(err);
      toast('Could not open “' + (name || 'this file') + '”. Use a PNG, JPEG, WebP, GIF, AVIF, BMP or SVG image.');
    });
  }

  function openFile(file, name) {
    if (!file) return;
    loadImage(file, name || file.name || 'image', { broadcast: true });
  }

  // ---------------------------------------------------------------- DOM refs

  var app = $('app');
  var stage = $('stage');
  var grid = $('grid');
  var stageEmpty = $('stageEmpty');
  var tabs = $('tabs');
  var rail = $('rail');
  var viewList = $('viewList');
  var fileInput = $('fileInput');
  var toastEl = $('toast');
  var uiRestore = $('uiRestore');

  // ---------------------------------------------------------------- layout

  /**
   * Picks the grid for n previews of the given aspect inside W x H.
   * cols/rows are 'auto' or a number. When both are fixed and too small, rows grow to fit.
   */
  function computeLayout(n, W, H, aspect, gap, colsSet, rowsSet) {
    function fit(cols, rows) {
      var cw = (W - gap * (cols - 1)) / cols;
      var ch = (H - gap * (rows - 1)) / rows;
      var w = cw, h = cw / aspect;
      if (h > ch) { h = ch; w = ch * aspect; }
      return { cols: cols, rows: rows, w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) };
    }
    var fc = colsSet === 'auto' ? 0 : colsSet;
    var fr = rowsSet === 'auto' ? 0 : rowsSet;
    var cols, rows, note = null;
    if (fc && fr) {
      cols = fc; rows = fr;
      if (cols * rows < n) {
        rows = Math.ceil(n / cols);
        var added = rows - fr;
        note = fc + ' × ' + fr + ' holds ' + (fc * fr) + ' previews, so ' +
          (added === 1 ? 'a row was' : added + ' rows were') + ' added to show all ' + n + '.';
      }
    } else if (fc) {
      cols = fc; rows = Math.max(1, Math.ceil(n / cols));
    } else if (fr) {
      rows = fr; cols = Math.max(1, Math.ceil(n / rows));
    } else {
      var best = null;
      for (var c = 1; c <= Math.max(1, n); c++) {
        var r = Math.max(1, Math.ceil(n / c));
        if (c > 1 && (c - 1) * r >= n) continue; // would leave a whole column empty
        var f = fit(c, r);
        var area = f.w * f.h;
        if (!best || area > best.area * 1.0001) { best = f; best.area = area; }
      }
      cols = best.cols; rows = best.rows;
    }
    var out = fit(cols, rows);
    out.note = note;
    return out;
  }

  function stageBox() {
    var cs = getComputedStyle(stage);
    return {
      w: Math.max(0, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      h: Math.max(0, stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))
    };
  }

  function aspectRatio() {
    return Engine.image ? Engine.image.width / Engine.image.height : 16 / 10;
  }

  // ---------------------------------------------------------------- previews

  var cells = [];
  var placeholders = [];

  function shownTypes() {
    return local.solo ? [local.solo] : activeScreen().views;
  }

  function conesHtml(t) {
    var names = ['L', 'M', 'S'];
    var words = t.cones.map(function (v, i) {
      return names[i] + (v === 1 ? ' normal' : v === 0 ? ' missing' : ' weak');
    }).join(', ');
    return '<span class="cones" title="Cones: ' + words + '" aria-label="Cones: ' + words + '">' +
      t.cones.map(function (v, i) {
        return '<i data-s="' + (v === 1 ? 'ok' : v === 0 ? 'off' : 'weak') + '">' + names[i] + '</i>';
      }).join('') + '</span>';
  }

  function createCell(type) {
    var t = TYPE[type];
    var el = document.createElement('div');
    el.className = 'cell';
    el.dataset.type = type;
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t.name + ' (' + t.alias + ') preview');
    var label = document.createElement('div');
    label.className = 'cell-label';
    label.innerHTML = '<span class="name">' + esc(t.name) + '</span><span class="alias">' + esc(aliasText(t)) + '</span>' + conesHtml(t);
    var tools = document.createElement('div');
    tools.className = 'cell-tools';
    var solo = local.solo === type;
    tools.innerHTML =
      '<button type="button" data-act="compare" title="Hold to show the original" aria-label="Hold to show the original">' + icon('compare') + '</button>' +
      '<button type="button" data-act="download" title="Download ' + esc(t.name) + ' as PNG" aria-label="Download ' + esc(t.name) + ' as PNG">' + icon('download') + '</button>' +
      '<button type="button" data-act="solo" title="' + (solo ? 'Back to the grid (Esc)' : 'Show only this view') + '" aria-label="' + (solo ? 'Back to the grid' : 'Show only ' + esc(t.name)) + '">' + icon(solo ? 'unfocus' : 'focus') + '</button>';
    el.appendChild(canvas);
    el.appendChild(label);
    el.appendChild(tools);
    return { type: type, el: el, canvas: canvas, ctx: canvas.getContext('2d') };
  }

  function aliasText(t) {
    return PARTIAL.has(t.id) ? t.alias + ' · ' + Math.round(shared.severity * 100) + '%' : t.alias;
  }

  function renderGrid() {
    var types = shownTypes();
    var key = types.join(',') + '|' + (local.solo || '');
    if (grid.dataset.key !== key) {
      grid.dataset.key = key;
      grid.textContent = '';
      placeholders = [];
      cells = types.map(createCell);
      cells.forEach(function (c) { grid.appendChild(c.el); });
    }
    cells.forEach(function (c) {
      if (PARTIAL.has(c.type)) c.el.querySelector('.alias').textContent = aliasText(TYPE[c.type]);
    });
    var empty = types.length === 0;
    stageEmpty.hidden = !empty;
    grid.hidden = empty;
    grid.classList.toggle('no-labels', !shared.labels);
    layoutGrid();
  }

  function layoutGrid() {
    var types = shownTypes();
    var sc = activeScreen();
    var box = stageBox();
    var n = Math.max(1, types.length);
    var gap = shared.gap;
    layout = computeLayout(n, box.w, box.h, aspectRatio(), gap,
      local.solo ? 'auto' : sc.cols, local.solo ? 'auto' : sc.rows);

    grid.style.gridTemplateColumns = 'repeat(' + layout.cols + ', ' + layout.w + 'px)';
    grid.style.gridTemplateRows = 'repeat(' + layout.rows + ', ' + layout.h + 'px)';
    grid.style.gap = gap + 'px';

    var free = types.length ? layout.cols * layout.rows - types.length : 0;
    while (placeholders.length > free) placeholders.pop().remove();
    while (placeholders.length < free) {
      var ph = document.createElement('div');
      ph.className = 'cell is-placeholder';
      ph.setAttribute('aria-hidden', 'true');
      grid.appendChild(ph);
      placeholders.push(ph);
    }

    var dpr = window.devicePixelRatio || 1;
    var pw = Math.max(1, Math.round(layout.w * dpr));
    var ph2 = Math.max(1, Math.round(layout.h * dpr));
    cells.forEach(function (c) {
      if (c.canvas.width !== pw || c.canvas.height !== ph2) {
        c.canvas.width = pw;
        c.canvas.height = ph2;
      }
    });
    drawAll();
    renderLayoutControls();
    updateZoomStatus();
  }

  var layoutQueued = false;
  function requestLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () { layoutQueued = false; layoutGrid(); });
  }

  function drawCell(c) {
    var entry = Engine.bitmaps.get(local.peek ? 'original' : c.type);
    var canvas = c.canvas, ctx = c.ctx;
    var stale = !entry || Engine.loadingId !== null || (!local.peek && !isFresh(c.type));
    c.el.classList.toggle('is-loading', stale);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!entry) return;
    var bmp = entry.bmp;
    var iw = bmp.width, ih = bmp.height;
    var sw = iw / view.zoom, sh = ih / view.zoom;
    var sx = view.cx * iw - sw / 2, sy = view.cy * ih - sh / 2;
    var magnification = canvas.width / sw;
    ctx.imageSmoothingEnabled = magnification < 3; // show crisp pixels when zoomed far in
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }

  function drawAll() {
    cells.forEach(drawCell);
    grid.classList.toggle('is-zoomed', view.zoom > 1.001);
    grid.classList.toggle('is-peek', local.peek);
  }

  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; drawAll(); });
  }

  // ---------------------------------------------------------------- zoom & pan

  function clampView(v) {
    var zoom = clamp(+v.zoom || 1, 1, MAX_ZOOM);
    var half = 0.5 / zoom;
    return { zoom: zoom, cx: clamp(+v.cx || 0.5, half, 1 - half), cy: clamp(+v.cy || 0.5, half, 1 - half) };
  }

  var viewSyncTimer = null;
  function setView(v, fromRemote) {
    view = clampView(v);
    requestDraw();
    updateZoomStatus();
    if (!fromRemote && !viewSyncTimer) {
      viewSyncTimer = setTimeout(function () {
        viewSyncTimer = null;
        Sync.send({ t: 'view', view: view });
      }, 40);
    }
  }

  function zoomAt(cellEl, clientX, clientY, factor) {
    var r = cellEl.getBoundingClientRect();
    var px = (clientX - r.left) / r.width - 0.5;
    var py = (clientY - r.top) / r.height - 0.5;
    var u = view.cx + px / view.zoom;
    var v = view.cy + py / view.zoom;
    var z = clamp(view.zoom * factor, 1, MAX_ZOOM);
    setView({ zoom: z, cx: u - px / z, cy: v - py / z });
  }

  function zoomCenter(factor) {
    setView({ zoom: view.zoom * factor, cx: view.cx, cy: view.cy });
  }

  function resetView() { setView({ zoom: 1, cx: 0.5, cy: 0.5 }); }

  var pointers = new Map();
  var gesture = null;

  function previewCell(target) {
    var cell = target.closest ? target.closest('.cell') : null;
    return cell && !cell.classList.contains('is-placeholder') ? cell : null;
  }

  function beginGesture() {
    var pts = Array.from(pointers.values());
    if (pts.length === 1) {
      gesture = { type: 'pan', cell: pts[0].cell, x: pts[0].x, y: pts[0].y, start: Object.assign({}, view) };
    } else if (pts.length >= 2) {
      var a = pts[0], b = pts[1];
      var r = a.cell.getBoundingClientRect();
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      gesture = {
        type: 'pinch', cell: a.cell, rect: r,
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        px: (mx - r.left) / r.width - 0.5, py: (my - r.top) / r.height - 0.5,
        start: Object.assign({}, view)
      };
    } else {
      gesture = null;
    }
  }

  grid.addEventListener('wheel', function (e) {
    var cell = previewCell(e.target);
    if (!cell) return;
    e.preventDefault();
    var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    var k = e.ctrlKey ? 0.01 : 0.0018; // trackpad pinch arrives as ctrl+wheel with small deltas
    zoomAt(cell, e.clientX, e.clientY, Math.exp(-dy * k));
  }, { passive: false });

  grid.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.cell-tools')) return;
    var cell = previewCell(e.target);
    if (!cell) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { cell.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, cell: cell });
    beginGesture();
  });

  grid.addEventListener('pointermove', function (e) {
    var p = pointers.get(e.pointerId);
    if (!p || !gesture) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (gesture.type === 'pan') {
      var dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) grid.classList.add('is-panning');
      var r = gesture.cell.getBoundingClientRect();
      setView({
        zoom: gesture.start.zoom,
        cx: gesture.start.cx - dx / r.width / gesture.start.zoom,
        cy: gesture.start.cy - dy / r.height / gesture.start.zoom
      });
    } else if (gesture.type === 'pinch') {
      var pts = Array.from(pointers.values());
      if (pts.length < 2) return;
      var a = pts[0], b = pts[1];
      var dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      var g = gesture, rr = g.rect;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var nx = (mx - rr.left) / rr.width - 0.5, ny = (my - rr.top) / rr.height - 0.5;
      var z = clamp(g.start.zoom * dist / g.dist, 1, MAX_ZOOM);
      var u = g.start.cx + g.px / g.start.zoom, v = g.start.cy + g.py / g.start.zoom;
      setView({ zoom: z, cx: u - nx / z, cy: v - ny / z });
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    grid.classList.remove('is-panning');
    beginGesture();
  }
  grid.addEventListener('pointerup', endPointer);
  grid.addEventListener('pointercancel', endPointer);

  grid.addEventListener('dblclick', function (e) {
    if (e.target.closest('.cell-tools')) return;
    var cell = previewCell(e.target);
    if (!cell) return;
    if (view.zoom > 1.001) resetView();
    else zoomAt(cell, e.clientX, e.clientY, 4);
  });

  grid.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var cell = btn.closest('.cell');
    var type = cell && cell.dataset.type;
    if (!type) return;
    if (btn.dataset.act === 'solo') toggleSolo(type);
    else if (btn.dataset.act === 'download') downloadView(type);
  });

  // "Compare" button: show the original while pressed (touch-friendly alternative to Space).
  grid.addEventListener('pointerdown', function (e) {
    var btn = e.target.closest('[data-act="compare"]');
    if (!btn) return;
    e.preventDefault();
    setPeek(true);
    var stop = function () {
      setPeek(false);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });

  function setPeek(on) {
    if (local.peek === on) return;
    local.peek = on;
    drawAll();
  }

  function toggleSolo(type) {
    local.solo = local.solo === type ? null : type;
    renderGrid();
    schedule();
  }

  // ---------------------------------------------------------------- downloads & export

  function baseName() {
    if (!Engine.image) return 'image';
    if (Engine.image.sample) return 'sample';
    return slug(Engine.image.name.replace(/\.[a-z0-9]+$/i, ''));
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('encode failed')); }, 'image/png');
    });
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function downloadView(type) {
    if (!Engine.image) return;
    whenReady([type]).then(function () {
      var bmp = Engine.bitmaps.get(type).bmp;
      var c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return canvasToBlob(c);
    }).then(function (blob) {
      saveBlob(blob, baseName() + '-' + type + '.png');
    }).catch(function () {
      toast('The PNG could not be created. Try a smaller image.');
    });
  }

  function exportColors() {
    var bg;
    switch (shared.backdrop) {
      case 'black': bg = '#000000'; break;
      case 'grey': bg = '#808080'; break;
      case 'white': case 'checker': bg = '#ffffff'; break;
      default: bg = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#e4e4e4';
    }
    var probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = bg;
    var hex = probe.fillStyle; // normalised to #rrggbb
    var v = parseInt(hex.slice(1), 16);
    var lum = (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
    return lum > 0.5
      ? { bg: hex, fg: '#141414', muted: '#5f5f5f' }
      : { bg: hex, fg: '#f2f2f2', muted: '#a8a8a8' };
  }

  function exportScreen() {
    var sc = activeScreen();
    var types = sc.views.slice();
    if (!Engine.image) return;
    if (!types.length) { toast('This screen has no views to export.'); return; }
    var btn = $('btnExport');
    btn.disabled = true;
    whenReady(types).then(function () {
      var iw = Engine.image.width, ih = Engine.image.height;
      var box = stageBox();
      var L = computeLayout(types.length, box.w || 1600, box.h || 1000, iw / ih, shared.gap, sc.cols, sc.rows);
      var cols = L.cols, rows = L.rows;
      var MAX_SIDE = 8192, MAX_AREA = 40e6;
      var pad = Math.round(clamp(Math.min(iw, ih) * 0.025, 12, 64));
      var labelH = shared.labels ? Math.round(clamp(iw * 0.04, 22, 72)) : 0;
      var s = Math.min(1,
        (MAX_SIDE - pad * (cols + 1)) / (cols * iw),
        (MAX_SIDE - pad * (rows + 1) - rows * labelH) / (rows * ih),
        Math.sqrt(MAX_AREA / (cols * rows * iw * ih)));
      var cw = Math.max(1, Math.floor(iw * s)), ch = Math.max(1, Math.floor(ih * s));
      if (labelH) labelH = Math.round(clamp(cw * 0.04, 22, 72));
      var W = cols * cw + (cols + 1) * pad;
      var H = rows * (ch + labelH) + (rows + 1) * pad;
      var canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      var ctx = canvas.getContext('2d');
      var colors = exportColors();
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingQuality = 'high';
      var font = getComputedStyle(document.body).fontFamily;
      types.forEach(function (type, i) {
        var t = TYPE[type];
        var col = i % cols, row = Math.floor(i / cols);
        var x = pad + col * (cw + pad);
        var y = pad + row * (ch + labelH + pad);
        if (labelH) {
          var fs = Math.round(labelH * 0.5);
          ctx.textBaseline = 'middle';
          ctx.font = '600 ' + fs + 'px ' + font;
          ctx.fillStyle = colors.fg;
          ctx.fillText(t.name, x, y + labelH * 0.45);
          var nw = ctx.measureText(t.name).width;
          ctx.font = '400 ' + fs + 'px ' + font;
          ctx.fillStyle = colors.muted;
          var sub = type === 'original' ? t.alias
            : t.alias + (PARTIAL.has(type) ? ' · ' + Math.round(shared.severity * 100) + '%' : '');
          ctx.fillText(sub, x + nw + fs * 0.6, y + labelH * 0.45);
        }
        ctx.drawImage(Engine.bitmaps.get(type).bmp, 0, 0, iw, ih, x, y + labelH, cw, ch);
      });
      return canvasToBlob(canvas);
    }).then(function (blob) {
      saveBlob(blob, baseName() + '-' + slug(sc.name) + '.png');
    }).catch(function () {
      toast('The export could not be created. Try fewer views or a smaller image.');
    }).then(function () {
      btn.disabled = false;
    });
  }

  // ---------------------------------------------------------------- screens

  function setActive(id) {
    if (!shared.screens.some(function (s) { return s.id === id; })) return;
    if (local.activeId === id && !local.solo) return;
    local.activeId = id;
    local.solo = null;
    if (local.popout) window.name = 'cbv|' + group + '|' + id;
    else persist();
    refresh();
  }

  function cycleScreen(step) {
    var list = shared.screens;
    var i = list.indexOf(activeScreen());
    setActive(list[(i + step + list.length) % list.length].id);
  }

  function uniqueName(base) {
    var names = new Set(shared.screens.map(function (s) { return s.name; }));
    if (!names.has(base)) return base;
    for (var i = 2; i < 100; i++) if (!names.has(base + ' ' + i)) return base + ' ' + i;
    return base;
  }

  function addScreen() {
    if (shared.screens.length >= MAX_SCREENS) return;
    var s = makeScreen(uniqueName('Screen ' + (shared.screens.length + 1)), ['original']);
    updateShared(function (st) { st.screens.push(s); });
    setActive(s.id);
    setRail(true);
    toast('Added “' + s.name + '”. Choose its views in Settings.');
  }

  function duplicateScreen() {
    if (shared.screens.length >= MAX_SCREENS) return;
    var src = activeScreen();
    var s = makeScreen(uniqueName(src.name + ' copy'), src.views);
    s.cols = src.cols;
    s.rows = src.rows;
    updateShared(function (st) { st.screens.splice(st.screens.indexOf(src) + 1, 0, s); });
    setActive(s.id);
  }

  function deleteScreen() {
    if (shared.screens.length <= 1) return;
    var sc = activeScreen();
    var idx = shared.screens.indexOf(sc);
    updateShared(function (st) { st.screens.splice(idx, 1); });
    setActive(shared.screens[Math.max(0, idx - 1)].id);
    toast('Deleted “' + sc.name + '”.', 'Undo', function () {
      if (shared.screens.length >= MAX_SCREENS) return;
      updateShared(function (st) { st.screens.splice(Math.min(idx, st.screens.length), 0, sc); });
      setActive(sc.id);
    });
  }

  function openPopout(screenId) {
    var url = location.href.split('#')[0];
    var w = null;
    try {
      w = window.open(url, 'cbv|' + group + '|' + screenId, 'popup=yes,width=1280,height=800');
    } catch (e) { w = null; }
    if (!w) {
      toast('The new window was blocked. Allow pop-ups for this page, then try again.');
      return;
    }
    Sync.addPeer(w);
    try { w.focus(); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- rendering: chrome

  function renderTabs() {
    var focusedId = document.activeElement && document.activeElement.closest &&
      document.activeElement.closest('.tab') ? document.activeElement.dataset.id : null;
    tabs.textContent = '';
    shared.screens.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(s.id === activeScreen().id));
      b.setAttribute('aria-controls', 'stage');
      b.dataset.id = s.id;
      b.title = s.name + ' · ' + s.views.length + (s.views.length === 1 ? ' view' : ' views') +
        ' · key ' + (i + 1) + '. Double-click to rename.';
      b.innerHTML = '<span class="tab-key">' + (i + 1) + '</span><span class="tab-name"></span><span class="tab-count">' + s.views.length + '</span>';
      b.querySelector('.tab-name').textContent = s.name;
      tabs.appendChild(b);
      if (s.id === focusedId) b.focus();
    });
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'tab-add';
    add.id = 'tabAdd';
    add.title = 'New screen';
    add.setAttribute('aria-label', 'New screen');
    add.disabled = shared.screens.length >= MAX_SCREENS;
    add.innerHTML = icon('plus');
    tabs.appendChild(add);
    var active = tabs.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function buildViewList() {
    viewList.innerHTML = TYPES.map(function (t) {
      return '<li><label class="view-opt" title="' + esc(t.about) + '">' +
        '<input type="checkbox" id="view-' + t.id + '" value="' + t.id + '">' +
        '<span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' +
        '<span class="view-text"><span class="view-name">' + esc(t.name) + '</span>' +
        '<span class="view-sub" data-sub="' + t.id + '"></span></span>' +
        conesHtml(t) + '</label></li>';
    }).join('');
  }

  function modelText(t) {
    if (t.id === 'original') return t.alias;
    return t.alias + ' · ' + t.model + (PARTIAL.has(t.id) ? ' · ' + Math.round(shared.severity * 100) + '%' : '');
  }

  function renderPanel() {
    var sc = activeScreen();
    var idx = shared.screens.indexOf(sc);
    var nameInput = $('screenName');
    if (document.activeElement !== nameInput) nameInput.value = sc.name;
    $('screenMeta').textContent = (idx + 1) + ' of ' + shared.screens.length;
    $('btnAddScreen').disabled = shared.screens.length >= MAX_SCREENS;
    $('btnDuplicate').disabled = shared.screens.length >= MAX_SCREENS;
    $('btnDelete').disabled = shared.screens.length <= 1;

    TYPES.forEach(function (t) {
      $('view-' + t.id).checked = sc.views.indexOf(t.id) !== -1;
      viewList.querySelector('[data-sub="' + t.id + '"]').textContent = modelText(t);
    });
    $('viewsMeta').textContent = sc.views.length + ' of ' + TYPES.length;

    var sev = Math.round(shared.severity * 100);
    var sevInput = $('severity');
    if (document.activeElement !== sevInput) sevInput.value = String(sev);
    $('severityOut').textContent = sev + '%';
    $('labels').checked = shared.labels;
    setSeg('gap', String(shared.gap));
    setSeg('backdrop', shared.backdrop);
    setSeg('theme', shared.theme);
    $('btnExport').disabled = !Engine.image || !sc.views.length;
    renderLayoutControls();
  }

  function setSeg(name, value) {
    var seg = rail.querySelector('[data-setting="' + name + '"]');
    Array.prototype.forEach.call(seg.querySelectorAll('[role="radio"]'), function (b) {
      var on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function renderLayoutControls() {
    if (!layout) return;
    var sc = activeScreen();
    ['cols', 'rows'].forEach(function (axis) {
      var box = rail.querySelector('[data-axis="' + axis + '"]');
      var setting = sc[axis];
      var effective = layout[axis];
      var auto = setting === 'auto';
      box.querySelector('[data-auto]').setAttribute('aria-pressed', String(auto));
      box.querySelector('output').innerHTML = auto
        ? '<span class="auto-tag">' + effective + '</span>'
        : String(setting);
      var cur = auto ? effective : setting;
      box.querySelector('[data-step="-1"]').disabled = cur <= 1;
      box.querySelector('[data-step="1"]').disabled = cur >= MAX_GRID;
    });
    $('layoutMeta').textContent = local.solo ? 'Single view' : layout.cols + ' × ' + layout.rows;
    var note = $('layoutNote');
    note.hidden = !layout.note || !!local.solo;
    note.textContent = layout.note || '';
  }

  function applyDisplay() {
    stage.dataset.backdrop = shared.backdrop;
    if (shared.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', shared.theme);
    grid.classList.toggle('no-labels', !shared.labels);
  }

  function setRail(open) {
    local.railOpen = open;
    rail.hidden = !open;
    $('btnSettings').setAttribute('aria-pressed', String(open));
    if (!local.popout) persist();
    requestLayout();
  }

  function setUiHidden(hidden) {
    local.uiHidden = hidden;
    app.classList.toggle('ui-hidden', hidden);
    if (hidden) flashRestore();
    else uiRestore.classList.remove('is-visible');
    requestLayout();
  }

  var restoreTimer = null;
  function flashRestore() {
    uiRestore.classList.add('is-visible');
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(function () { uiRestore.classList.remove('is-visible'); }, 1800);
  }

  // ---------------------------------------------------------------- status

  function updateZoomStatus() {
    var el = $('statusZoom');
    if (!Engine.image || !layout || !layout.w) { el.textContent = ''; return; }
    var pct = Math.round(layout.w * view.zoom / Engine.image.width * 100);
    el.textContent = view.zoom > 1.001
      ? 'Zoom ' + view.zoom.toFixed(1) + '× (' + pct + '% of actual size)'
      : 'Fit (' + pct + '% of actual size)';
  }

  function updateBusy() {
    var el = $('statusBusy');
    if (Engine.loadingId) {
      el.hidden = false;
      el.textContent = 'Loading image';
    } else if (Engine.inflight.size) {
      el.hidden = false;
      el.textContent = 'Simulating ' + Engine.inflight.size + (Engine.inflight.size === 1 ? ' view' : ' views');
    } else {
      el.hidden = true;
    }
  }

  function updateStatus() {
    var img = Engine.image;
    $('statusFile').textContent = img ? (img.sample ? 'Sample image (open or drop your own)' : img.name) : 'No image';
    $('statusSize').textContent = img
      ? img.origWidth + ' × ' + img.origHeight + ' px' +
        (img.width !== img.origWidth ? ' (simulated at ' + img.width + ' × ' + img.height + ')' : '')
      : '';
    updateZoomStatus();
    updateBusy();
    var sc = activeScreen();
    $('btnExport').disabled = !img || !sc.views.length;
  }

  // ---------------------------------------------------------------- toast

  var toastTimer = null;
  function toast(text, actionLabel, action) {
    toastEl.textContent = '';
    var span = document.createElement('span');
    span.textContent = text;
    toastEl.appendChild(span);
    if (actionLabel && action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', function () { toastEl.hidden = true; action(); });
      toastEl.appendChild(b);
    }
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, actionLabel ? 6000 : 3500);
  }

  // ---------------------------------------------------------------- refresh

  function refresh() {
    if (local.wantedId && shared.screens.some(function (s) { return s.id === local.wantedId; })) {
      local.activeId = local.wantedId;
      local.wantedId = null;
    }
    if (!shared.screens.some(function (s) { return s.id === local.activeId; })) {
      local.activeId = shared.screens[0].id;
    }
    if (local.solo && activeScreen().views.indexOf(local.solo) === -1) local.solo = null;
    applyDisplay();
    renderTabs();
    renderPanel();
    renderGrid();
    schedule();
    updateStatus();
    document.title = local.popout ? activeScreen().name + ' · Colorblind Visualizer' : 'Colorblind Visualizer';
  }

  // ---------------------------------------------------------------- sample image

  function makeSample() {
    var W = 1600, H = 1000;
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext('2d');
    var font = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1f2633');
    bg.addColorStop(1, '#141922');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    g.fillStyle = '#f2f4f8';
    g.font = '600 34px ' + font;
    g.textBaseline = 'alphabetic';
    g.fillText('Sample · game UI palette', 60, 72);
    g.fillStyle = '#8b95a7';
    g.font = '400 20px ' + font;
    g.fillText('Open or drop your own image to replace it', 60, 104);

    // hue spectrum: saturated and pastel strips
    var x0 = 60, x1 = W - 60;
    for (var x = x0; x < x1; x++) {
      var hue = ((x - x0) / (x1 - x0)) * 360;
      g.fillStyle = 'hsl(' + hue + ',100%,50%)';
      g.fillRect(x, 136, 1, 44);
      g.fillStyle = 'hsl(' + hue + ',85%,75%)';
      g.fillRect(x, 180, 1, 24);
    }

    function roundRect(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    // item rarity cards
    var rarity = [
      ['Common', '#b4b4b4'], ['Uncommon', '#3fc853'], ['Rare', '#2f80e6'],
      ['Epic', '#a052e6'], ['Legendary', '#f39020']
    ];
    var cw = 276, gap = (x1 - x0 - cw * 5) / 4;
    rarity.forEach(function (r, i) {
      var x = x0 + i * (cw + gap), y = 244;
      roundRect(x, y, cw, 196, 14);
      g.fillStyle = '#232b3a';
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = r[1];
      g.stroke();
      // gem
      var cx = x + cw / 2, cy = y + 82;
      g.beginPath();
      g.moveTo(cx, cy - 46); g.lineTo(cx + 38, cy - 8); g.lineTo(cx, cy + 46); g.lineTo(cx - 38, cy - 8);
      g.closePath();
      g.fillStyle = r[1];
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.moveTo(cx, cy - 46); g.lineTo(cx + 38, cy - 8); g.lineTo(cx, cy - 8);
      g.closePath();
      g.fill();
      g.fillStyle = r[1];
      g.font = '600 24px ' + font;
      g.textAlign = 'center';
      g.fillText(r[0], cx, y + 170);
      g.textAlign = 'left';
    });

    // resource bars
    var bars = [
      ['Health', '#e0413a', 0.72], ['Stamina', '#45b54a', 0.48],
      ['Mana', '#3a7be2', 0.86], ['Energy', '#f2c230', 0.33]
    ];
    bars.forEach(function (b, i) {
      var y = 520 + i * 74;
      g.fillStyle = '#c9d0dc';
      g.font = '500 22px ' + font;
      g.fillText(b[0], 60, y + 26);
      roundRect(200, y + 4, 640, 30, 15);
      g.fillStyle = '#2a3242';
      g.fill();
      roundRect(200, y + 4, Math.max(30, 640 * b[2]), 30, 15);
      g.fillStyle = b[1];
      g.fill();
      g.fillStyle = '#c9d0dc';
      g.font = '500 20px ' + font;
      g.fillText(Math.round(b[2] * 100) + '%', 862, y + 26);
    });

    // minimap: enemies vs allies
    var mx = 1290, my = 660, mr = 170;
    g.save();
    g.beginPath();
    g.arc(mx, my, mr, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#2e3b2f';
    g.fillRect(mx - mr, my - mr, mr * 2, mr * 2);
    g.fillStyle = '#3c5a8a';
    g.beginPath();
    g.ellipse(mx - 70, my + 80, 90, 50, -0.4, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#7a6a4f';
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(mx - mr, my - 40); g.quadraticCurveTo(mx, my - 10, mx + mr, my - 90);
    g.stroke();
    g.restore();
    g.lineWidth = 3;
    g.strokeStyle = '#c9d0dc';
    g.beginPath();
    g.arc(mx, my, mr, 0, Math.PI * 2);
    g.stroke();
    function dot(x, y, color) {
      g.beginPath();
      g.arc(x, y, 11, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#10141b';
      g.stroke();
    }
    [[60, -90], [100, -30], [30, 40], [120, 60], [-20, -120]].forEach(function (p) { dot(mx + p[0], my + p[1], '#e53935'); });
    [[-90, -40], [-120, 20], [-50, -80], [-30, 110]].forEach(function (p) { dot(mx + p[0], my + p[1], '#43a047'); });
    // objective star
    g.beginPath();
    for (var k = 0; k < 10; k++) {
      var rad = k % 2 ? 9 : 20, ang = -Math.PI / 2 + k * Math.PI / 5;
      g.lineTo(mx + 80 + Math.cos(ang) * rad, my + 120 + Math.sin(ang) * rad);
    }
    g.closePath();
    g.fillStyle = '#ffd23f';
    g.fill();
    // player arrow
    g.beginPath();
    g.moveTo(mx, my - 18); g.lineTo(mx + 12, my + 14); g.lineTo(mx, my + 6); g.lineTo(mx - 12, my + 14);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();

    // legend under the minimap
    g.font = '500 18px ' + font;
    [['Enemy', '#e53935'], ['Ally', '#43a047'], ['Objective', '#ffd23f']].forEach(function (l, i) {
      var lx = 1150 + i * 110, ly = 870;
      g.fillStyle = l[1];
      g.beginPath();
      g.arc(lx, ly - 6, 7, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#c9d0dc';
      g.fillText(l[0], lx + 14, ly);
    });

    // status chips
    var chips = [['Success', '#2e9d4a'], ['Warning', '#e8a317'], ['Error', '#d93025'], ['Info', '#1a73e8'], ['Offline', '#6b7280']];
    var cxp = 60;
    g.font = '600 20px ' + font;
    chips.forEach(function (ch) {
      var w = g.measureText(ch[0]).width + 56;
      roundRect(cxp, 856, w, 44, 22);
      g.fillStyle = ch[1];
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(cxp + 22, 878, 6, 0, Math.PI * 2);
      g.fill();
      g.fillText(ch[0], cxp + 36, 885);
      cxp += w + 14;
    });

    return canvasToBlob(c);
  }

  function loadSample() {
    if (Engine.image && !Engine.image.sample) return;
    makeSample().then(function (blob) {
      loadImage(blob, 'sample.png', { sample: true });
    }).catch(function (err) { console.error(err); });
  }

  // ---------------------------------------------------------------- events: chrome

  $('btnOpen').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (f) openFile(f);
    fileInput.value = '';
  });

  tabs.addEventListener('click', function (e) {
    if (e.target.closest('#tabAdd')) { addScreen(); return; }
    var tab = e.target.closest('.tab');
    if (tab) setActive(tab.dataset.id);
  });
  tabs.addEventListener('dblclick', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    setRail(true);
    var input = $('screenName');
    input.focus();
    input.select();
  });

  $('btnSettings').addEventListener('click', function () { setRail(!local.railOpen); });
  $('railClose').addEventListener('click', function () { setRail(false); });
  $('btnChooseViews').addEventListener('click', function () {
    setRail(true);
    var first = $('view-original');
    if (first) first.focus();
  });
  $('btnFullscreen').addEventListener('click', toggleFullscreen);
  $('btnHideUi').addEventListener('click', function () { setUiHidden(true); });
  uiRestore.addEventListener('click', function () { setUiHidden(false); });
  $('btnPopout').addEventListener('click', function () { openPopout(activeScreen().id); });
  $('btnPopout2').addEventListener('click', function () { openPopout(activeScreen().id); });
  $('btnAddScreen').addEventListener('click', addScreen);
  $('btnDuplicate').addEventListener('click', duplicateScreen);
  $('btnDelete').addEventListener('click', deleteScreen);
  $('btnExport').addEventListener('click', exportScreen);

  $('screenName').addEventListener('input', function (e) {
    var sc = activeScreen();
    var value = e.target.value.slice(0, 40);
    updateShared(function () { sc.name = value.trim() ? value : sc.name; });
  });
  $('screenName').addEventListener('change', function (e) {
    if (!e.target.value.trim()) e.target.value = activeScreen().name;
  });
  $('screenName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') e.target.blur();
  });

  viewList.addEventListener('change', function (e) {
    var input = e.target;
    if (!input || input.type !== 'checkbox') return;
    var sc = activeScreen();
    updateShared(function () {
      var set = new Set(sc.views);
      if (input.checked) set.add(input.value);
      else set.delete(input.value);
      sc.views = ORDER.filter(function (t) { return set.has(t); });
    });
  });

  rail.querySelector('.presets').addEventListener('click', function (e) {
    var b = e.target.closest('[data-preset]');
    if (!b) return;
    var sc = activeScreen();
    updateShared(function () { sc.views = PRESETS[b.dataset.preset].slice(); });
  });

  Array.prototype.forEach.call(rail.querySelectorAll('.layout-controls'), function (box) {
    var axis = box.dataset.axis;
    box.addEventListener('click', function (e) {
      var sc = activeScreen();
      if (e.target.closest('[data-auto]')) {
        updateShared(function () { sc[axis] = 'auto'; });
        return;
      }
      var step = e.target.closest('[data-step]');
      if (!step || !layout) return;
      var cur = sc[axis] === 'auto' ? layout[axis] : sc[axis];
      var next = clamp(cur + parseInt(step.dataset.step, 10), 1, MAX_GRID);
      updateShared(function () { sc[axis] = next; });
    });
  });

  var severityTimer = null;
  $('severity').addEventListener('input', function (e) {
    var v = clamp(parseInt(e.target.value, 10) || 0, 0, 100);
    $('severityOut').textContent = v + '%';
    clearTimeout(severityTimer);
    severityTimer = setTimeout(function () {
      updateShared(function (st) { st.severity = v / 100; });
    }, 60);
  });

  $('labels').addEventListener('change', function (e) {
    var on = e.target.checked;
    updateShared(function (st) { st.labels = on; });
  });

  Array.prototype.forEach.call(rail.querySelectorAll('.seg'), function (seg) {
    var name = seg.dataset.setting;
    function choose(b) {
      var raw = b.dataset.value;
      updateShared(function (st) { st[name] = name === 'gap' ? parseInt(raw, 10) : raw; });
      var next = seg.querySelector('[data-value="' + raw + '"]');
      if (next) next.focus();
    }
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('[role="radio"]');
      if (b) choose(b);
    });
    seg.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) === -1) return;
      e.preventDefault();
      e.stopPropagation();
      var radios = Array.prototype.slice.call(seg.querySelectorAll('[role="radio"]'));
      var i = radios.indexOf(document.activeElement);
      var d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      choose(radios[(i + d + radios.length) % radios.length]);
    });
  });

  // ---------------------------------------------------------------- events: global

  function toggleFullscreen() {
    var doc = document;
    var el = doc.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    var current = doc.fullscreenElement || doc.webkitFullscreenElement;
    try {
      var p = current ? exit.call(doc) : (req ? req.call(el) : Promise.reject(new Error('unsupported')));
      if (p && p.catch) p.catch(fullscreenFailed);
    } catch (e) { fullscreenFailed(); }
  }
  function fullscreenFailed() {
    toast('Fullscreen is not available here. Use your browser’s fullscreen instead (F11 on Windows and Linux).');
  }
  function onFullscreenChange() {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    var b = $('btnFullscreen');
    b.innerHTML = icon(on ? 'shrink' : 'expand');
    b.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
    b.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  function isFormField(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  window.addEventListener('keydown', function (e) {
    if (e.defaultPrevented) return;
    var target = e.target;
    if (isFormField(target)) {
      if (e.key === 'Escape' && target.blur) target.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' || e.key === ' ') {
      if (target && target.tagName === 'BUTTON') return;
      e.preventDefault();
      if (!e.repeat) setPeek(true);
      return;
    }
    var k = e.key;
    if (k >= '1' && k <= '9') {
      var s = shared.screens[parseInt(k, 10) - 1];
      if (s) setActive(s.id);
    } else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'h' || k === 'H') setUiHidden(!local.uiHidden);
    else if (k === 's' || k === 'S') setRail(!local.railOpen);
    else if (k === 'o' || k === 'O') fileInput.click();
    else if (k === '0') resetView();
    else if (k === '+' || k === '=') zoomCenter(1.25);
    else if (k === '-' || k === '_') zoomCenter(0.8);
    else if (k === 'ArrowRight' || k === ']') cycleScreen(1);
    else if (k === 'ArrowLeft' || k === '[') cycleScreen(-1);
    else if (k === 'Escape') {
      if (local.solo) toggleSolo(local.solo);
      else if (local.uiHidden) setUiHidden(false);
      else if (local.railOpen && window.innerWidth <= 860) setRail(false);
      else return;
    } else return;
    e.preventDefault();
  });

  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space' || e.key === ' ') setPeek(false);
  });
  window.addEventListener('blur', function () { setPeek(false); });

  document.addEventListener('mousemove', function () { if (local.uiHidden) flashRestore(); });

  // drag & drop, paste
  var dropOverlay = $('dropOverlay');
  var dragDepth = 0;
  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
  }
  function pickImage(files) {
    return Array.prototype.find.call(files || [], function (f) {
      return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i.test(f.name || '');
    });
  }
  window.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    var file = pickImage(e.dataTransfer.files);
    if (file) openFile(file);
    else toast('That file is not an image. Drop a PNG, JPEG, WebP, GIF, AVIF, BMP or SVG.');
  });
  window.addEventListener('paste', function (e) {
    if (isFormField(e.target)) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) {
          e.preventDefault();
          openFile(f, f.name && f.name !== 'image.png' ? f.name : 'Pasted image.png');
          return;
        }
      }
    }
  });

  // resize, including moving the window to a monitor with another pixel density
  if (typeof ResizeObserver === 'function') new ResizeObserver(requestLayout).observe(stage);
  window.addEventListener('resize', requestLayout);
  (function watchDpr() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    var onChange = function () {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      requestLayout();
      watchDpr();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  })();

  // ---------------------------------------------------------------- sync handlers

  Sync.on(function (msg) {
    switch (msg.t) {
      case 'hello':
        Sync.send({ t: 'state', shared: shared });
        if (Engine.image && Engine.sourceBlob) {
          Sync.send({ t: 'image', id: Engine.image.id, name: Engine.image.name, sample: Engine.image.sample, blob: Engine.sourceBlob });
        }
        if (view.zoom > 1.001) Sync.send({ t: 'view', view: view });
        break;
      case 'state':
        if (msg.shared && msg.shared.ts > shared.ts) {
          shared = sanitizeShared(msg.shared);
          refresh();
        }
        break;
      case 'image':
        if (!msg.blob) break;
        if (Engine.image && Engine.image.id === msg.id) break;
        if (Engine.loadingId === msg.id) break;
        if (msg.sample && Engine.image && !Engine.image.sample) break;
        loadImage(msg.blob, msg.name, { id: msg.id, sample: !!msg.sample, remote: true });
        break;
      case 'view':
        if (msg.view) setView(msg.view, true);
        break;
    }
  });

  // ---------------------------------------------------------------- start

  buildViewList();
  rail.hidden = !local.railOpen;
  $('btnSettings').setAttribute('aria-pressed', String(local.railOpen));
  refresh();
  Sync.send({ t: 'hello' });
  if (local.popout) {
    // A new window first asks its siblings for the current image.
    setTimeout(function () { if (!Engine.image && !Engine.loadingId) loadSample(); }, 700);
  } else {
    loadSample();
  }
})();
