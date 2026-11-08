/*
 * Colorblind Visualizer — simulation core
 *
 * All simulations run in linear RGB (sRGB primaries, D65):
 *   sRGB 8-bit -> linear -> 3x3 matrix (or Brettel's two half-planes) -> sRGB 8-bit
 *
 * Models
 *   Protanopia / Deuteranopia / Tritanopia
 *     Brettel, Viénot & Mollon (1997), "Computerized simulation of color appearance
 *     for dichromats". Smith & Pokorny 1975 cone fundamentals, 475/575 nm anchors
 *     (protan, deutan) and 485/660 nm anchors (tritan), RGB white as the neutral axis.
 *     Matrices were precomputed for linear sRGB following the DaltonLens reference
 *     implementation (MIT, https://github.com/DaltonLens/DaltonLens-Python).
 *   Protanomaly / Deuteranomaly
 *     Machado, Oliveira & Fernandes (2009), "A physiologically-based model for
 *     simulation of color vision deficiency". Published matrices, severity 0.0-1.0
 *     in 0.1 steps, linearly interpolated in between.
 *   Tritanomaly
 *     Machado's tritan matrices are known to be inaccurate, so tritanomaly blends
 *     Brettel's tritanopia with the original image by severity (as DaltonLens does).
 *   Achromatopsia
 *     Relative luminance Y (Rec. 709 / sRGB coefficients) on all three channels.
 *   Achromatomaly
 *     Partial loss of colour: the image is blended toward Y by severity.
 *
 * The file exposes window.CVD. createCore() is self-contained so it can be
 * serialised into an inline Web Worker (this keeps the page working from file://).
 */
(function (global) {
  'use strict';

  /** Type catalogue. `cones` describes L, M, S: 1 = normal, 0.5 = anomalous, 0 = missing. */
  var TYPES = [
    {
      id: 'original', name: 'Original', alias: 'Normal vision', family: 'none', kind: 'none',
      cones: [1, 1, 1], model: 'No filter',
      about: 'The image as uploaded, with no simulation applied.'
    },
    {
      id: 'protanopia', name: 'Protanopia', alias: 'Red-blind', family: 'protan', kind: 'complete',
      cones: [0, 1, 1], model: 'Brettel 1997',
      about: 'No working red (L) cones. Reds look dark and are confused with greens.'
    },
    {
      id: 'protanomaly', name: 'Protanomaly', alias: 'Red-weak', family: 'protan', kind: 'partial',
      cones: [0.5, 1, 1], model: 'Machado 2009',
      about: 'Red (L) cones are shifted toward green. Reds look duller and darker.'
    },
    {
      id: 'deuteranopia', name: 'Deuteranopia', alias: 'Green-blind', family: 'deutan', kind: 'complete',
      cones: [1, 0, 1], model: 'Brettel 1997',
      about: 'No working green (M) cones. Reds and greens are confused.'
    },
    {
      id: 'deuteranomaly', name: 'Deuteranomaly', alias: 'Green-weak', family: 'deutan', kind: 'partial',
      cones: [1, 0.5, 1], model: 'Machado 2009',
      about: 'Green (M) cones are shifted toward red. The most common form of colour blindness.'
    },
    {
      id: 'tritanopia', name: 'Tritanopia', alias: 'Blue-blind', family: 'tritan', kind: 'complete',
      cones: [1, 1, 0], model: 'Brettel 1997',
      about: 'No working blue (S) cones. Blue is confused with green, and yellow with pink.'
    },
    {
      id: 'tritanomaly', name: 'Tritanomaly', alias: 'Blue-weak', family: 'tritan', kind: 'partial',
      cones: [1, 1, 0.5], model: 'Brettel 1997, blended',
      about: 'Blue (S) cones respond weakly. Blue–yellow differences fade.'
    },
    {
      id: 'achromatopsia', name: 'Achromatopsia', alias: 'Monochromacy', family: 'achroma', kind: 'complete',
      cones: [0, 0, 0], model: 'Luminance (Y)',
      about: 'No working cones. Only brightness is perceived.'
    },
    {
      id: 'achromatomaly', name: 'Achromatomaly', alias: 'Partial monochromacy', family: 'achroma', kind: 'partial',
      cones: [0.5, 0.5, 0.5], model: 'Blend to luminance',
      about: 'All cone types respond weakly. Colours are strongly desaturated.'
    }
  ];

  /**
   * Self-contained simulation core. Must not reference anything outside its own
   * body: it is stringified into the worker source.
   */
  function createCore() {
    var LUT_SIZE = 16384;
    var toLinear = new Float32Array(256);
    var toSrgb = new Uint8Array(LUT_SIZE + 1);
    var i;
    for (i = 0; i < 256; i++) {
      var c = i / 255;
      toLinear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    for (i = 0; i <= LUT_SIZE; i++) {
      var l = i / LUT_SIZE;
      var s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
      toSrgb[i] = Math.round(s * 255);
    }

    var IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    var YR = 0.2126, YG = 0.7152, YB = 0.0722;
    var GRAY = [YR, YG, YB, YR, YG, YB, YR, YG, YB];

    // Brettel 1997 in linear sRGB. m1 applies where dot(rgb, n) >= 0, m2 elsewhere.
    var BRETTEL = {
      protan: {
        m1: [0.145096, 1.201653, -0.346749, 0.104465, 0.853164, 0.042371, 0.004290, -0.006030, 1.001740],
        m2: [0.141152, 1.167822, -0.308974, 0.104947, 0.857298, 0.037755, 0.004309, -0.005860, 1.001550],
        n: [0.000485, 0.004156, -0.004640]
      },
      deutan: {
        m1: [0.361982, 0.867547, -0.229529, 0.260985, 0.645124, 0.093890, -0.019754, 0.026861, 0.992893],
        m2: [0.370090, 0.885402, -0.255492, 0.257669, 0.637821, 0.104511, -0.019503, 0.027414, 0.992089],
        n: [-0.002928, -0.006448, 0.009376]
      },
      tritan: {
        m1: [1.013542, 0.142682, -0.156224, -0.011805, 0.875612, 0.136194, 0.077073, 0.812081, 0.110847],
        m2: [0.933370, 0.199990, -0.133360, 0.058087, 0.825652, 0.116261, -0.379228, 1.138250, 0.240978],
        n: [0.039601, -0.028307, -0.011294]
      }
    };

    // Machado 2009, severity 0.0 .. 1.0 in steps of 0.1 (row-major 3x3).
    var MACHADO = {
      protan: [
        [1.000000, 0.000000, -0.000000, 0.000000, 1.000000, 0.000000, -0.000000, -0.000000, 1.000000],
        [0.856167, 0.182038, -0.038205, 0.029342, 0.955115, 0.015544, -0.002880, -0.001563, 1.004443],
        [0.734766, 0.334872, -0.069637, 0.051840, 0.919198, 0.028963, -0.004928, -0.004209, 1.009137],
        [0.630323, 0.465641, -0.095964, 0.069181, 0.890046, 0.040773, -0.006308, -0.007724, 1.014032],
        [0.539009, 0.579343, -0.118352, 0.082546, 0.866121, 0.051332, -0.007136, -0.011959, 1.019095],
        [0.458064, 0.679578, -0.137642, 0.092785, 0.846313, 0.060902, -0.007494, -0.016807, 1.024301],
        [0.385450, 0.769005, -0.154455, 0.100526, 0.829802, 0.069673, -0.007442, -0.022190, 1.029632],
        [0.319627, 0.849633, -0.169261, 0.106241, 0.815969, 0.077790, -0.007025, -0.028051, 1.035076],
        [0.259411, 0.923008, -0.182420, 0.110296, 0.804340, 0.085364, -0.006276, -0.034346, 1.040622],
        [0.203876, 0.990338, -0.194214, 0.112975, 0.794542, 0.092483, -0.005222, -0.041043, 1.046265],
        [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998]
      ],
      deutan: [
        [1.000000, 0.000000, -0.000000, 0.000000, 1.000000, 0.000000, -0.000000, -0.000000, 1.000000],
        [0.866435, 0.177704, -0.044139, 0.049567, 0.939063, 0.011370, -0.003453, 0.007233, 0.996220],
        [0.760729, 0.319078, -0.079807, 0.090568, 0.889315, 0.020117, -0.006027, 0.013325, 0.992702],
        [0.675425, 0.433850, -0.109275, 0.125303, 0.847755, 0.026942, -0.007950, 0.018572, 0.989378],
        [0.605511, 0.528560, -0.134071, 0.155318, 0.812366, 0.032316, -0.009376, 0.023176, 0.986200],
        [0.547494, 0.607765, -0.155259, 0.181692, 0.781742, 0.036566, -0.010410, 0.027275, 0.983136],
        [0.498864, 0.674741, -0.173604, 0.205199, 0.754872, 0.039929, -0.011131, 0.030969, 0.980162],
        [0.457771, 0.731899, -0.189670, 0.226409, 0.731012, 0.042579, -0.011595, 0.034333, 0.977261],
        [0.422823, 0.781057, -0.203881, 0.245752, 0.709602, 0.044646, -0.011843, 0.037423, 0.974421],
        [0.392952, 0.823610, -0.216562, 0.263559, 0.690210, 0.046232, -0.011910, 0.040281, 0.971630],
        [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881]
      ]
    };

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    function mix(a, b, t) {
      var out = new Array(9);
      for (var k = 0; k < 9; k++) out[k] = a[k] * (1 - t) + b[k] * t;
      return out;
    }

    function machado(table, severity) {
      var x = clamp01(severity) * 10;
      var lo = Math.floor(x);
      var hi = Math.min(lo + 1, 10);
      return mix(table[lo], table[hi], x - lo);
    }

    /** Returns { m1, m2, n }: m2/n are null for plain 3x3 transforms. */
    function plan(type, severity) {
      var s = clamp01(severity);
      var b;
      switch (type) {
        case 'protanopia': b = BRETTEL.protan; return { m1: b.m1, m2: b.m2, n: b.n };
        case 'deuteranopia': b = BRETTEL.deutan; return { m1: b.m1, m2: b.m2, n: b.n };
        case 'tritanopia': b = BRETTEL.tritan; return { m1: b.m1, m2: b.m2, n: b.n };
        case 'protanomaly': return { m1: machado(MACHADO.protan, s), m2: null, n: null };
        case 'deuteranomaly': return { m1: machado(MACHADO.deutan, s), m2: null, n: null };
        case 'tritanomaly':
          b = BRETTEL.tritan;
          return { m1: mix(IDENTITY, b.m1, s), m2: mix(IDENTITY, b.m2, s), n: b.n };
        case 'achromatopsia': return { m1: GRAY, m2: null, n: null };
        case 'achromatomaly': return { m1: mix(IDENTITY, GRAY, s), m2: null, n: null };
        default: return { m1: IDENTITY, m2: null, n: null };
      }
    }

    /** src, dst: RGBA Uint8ClampedArray of equal length. Alpha is copied as-is. */
    function apply(src, dst, p) {
      var a = p.m1, q = p.m2 || p.m1, n = p.n || [0, 0, 0];
      var split = !!p.m2;
      var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
      var b0 = q[0], b1 = q[1], b2 = q[2], b3 = q[3], b4 = q[4], b5 = q[5], b6 = q[6], b7 = q[7], b8 = q[8];
      var n0 = n[0], n1 = n[1], n2 = n[2];
      var lin = toLinear, enc = toSrgb, S = LUT_SIZE;
      for (var i = 0, len = src.length; i < len; i += 4) {
        var r = lin[src[i]], g = lin[src[i + 1]], bl = lin[src[i + 2]];
        var R, G, B;
        if (!split || r * n0 + g * n1 + bl * n2 >= 0) {
          R = a0 * r + a1 * g + a2 * bl;
          G = a3 * r + a4 * g + a5 * bl;
          B = a6 * r + a7 * g + a8 * bl;
        } else {
          R = b0 * r + b1 * g + b2 * bl;
          G = b3 * r + b4 * g + b5 * bl;
          B = b6 * r + b7 * g + b8 * bl;
        }
        dst[i] = enc[R <= 0 ? 0 : R >= 1 ? S : (R * S + 0.5) | 0];
        dst[i + 1] = enc[G <= 0 ? 0 : G >= 1 ? S : (G * S + 0.5) | 0];
        dst[i + 2] = enc[B <= 0 ? 0 : B >= 1 ? S : (B * S + 0.5) | 0];
        dst[i + 3] = src[i + 3];
      }
      return dst;
    }

    return {
      plan: plan,
      simulate: function (src, type, severity, dst) {
        dst = dst || new Uint8ClampedArray(src.length);
        if (type === 'original') { dst.set(src); return dst; }
        return apply(src, dst, plan(type, severity));
      }
    };
  }

  /** Worker entry point. Receives createCore as an argument (both are stringified). */
  function workerMain(createCore) {
    var core = createCore();
    var image = null; // { id, width, height, data }
    self.onmessage = function (e) {
      var msg = e.data;
      if (msg.cmd === 'ping') { self.postMessage({ cmd: 'pong' }); return; }
      if (msg.cmd === 'load') {
        image = { id: msg.imageId, width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
        return;
      }
      if (msg.cmd === 'run') {
        if (!image || image.id !== msg.imageId) return; // stale job for a replaced image
        var out = core.simulate(image.data, msg.type, msg.severity);
        self.postMessage({
          cmd: 'done', imageId: msg.imageId, type: msg.type, severity: msg.severity,
          width: image.width, height: image.height, buffer: out.buffer
        }, [out.buffer]);
      }
    };
  }

  /**
   * Creates a processing backend with the same message protocol either way:
   * an inline Web Worker when allowed, otherwise the main thread (deferred with setTimeout).
   * Resolves once the backend has answered a ping.
   */
  function createBackend(onMessage) {
    function mainThreadBackend() {
      var core = createCore();
      var image = null;
      return {
        kind: 'main-thread',
        post: function (msg) {
          setTimeout(function () {
            if (msg.cmd === 'load') {
              image = { id: msg.imageId, width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
            } else if (msg.cmd === 'run') {
              if (!image || image.id !== msg.imageId) return;
              var out = core.simulate(image.data, msg.type, msg.severity);
              onMessage({
                cmd: 'done', imageId: msg.imageId, type: msg.type, severity: msg.severity,
                width: image.width, height: image.height, buffer: out.buffer
              });
            }
          }, 0);
        }
      };
    }

    return new Promise(function (resolve) {
      var worker = null;
      var settled = false;
      function fallback() {
        if (settled) return;
        settled = true;
        if (worker) { try { worker.terminate(); } catch (err) { /* ignore */ } }
        resolve(mainThreadBackend());
      }
      try {
        var code = '(' + workerMain.toString() + ')(' + createCore.toString() + ');';
        var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        worker = new Worker(url);
        worker.onerror = fallback;
        worker.onmessage = function (e) {
          if (e.data && e.data.cmd === 'pong') {
            if (settled) return;
            settled = true;
            worker.onmessage = function (ev) { onMessage(ev.data); };
            resolve({
              kind: 'worker',
              post: function (msg, transfer) { worker.postMessage(msg, transfer || []); }
            });
          }
        };
        worker.postMessage({ cmd: 'ping' });
        setTimeout(fallback, 2500);
      } catch (err) {
        fallback();
      }
    });
  }

  global.CVD = {
    TYPES: TYPES,
    createCore: createCore,
    createBackend: createBackend
  };
})(typeof window !== 'undefined' ? window : globalThis);
