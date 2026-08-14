'use strict';

// Nearcade Gamepad Probe — renderer.
// Self-contained popup: one compact controller visual per pad, and a tiny
// delta log streamed to the terminal (one line per pad per second at most,
// immediate lines for button presses and big stick jumps). Nothing else.
// Ctrl+S saves the captured log via the main process (no UI buttons).

var MAX_LINES = 5000;

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp() {
  var d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad2(d.getMilliseconds());
}

// ── Pure logic (unit-tested by test-logic.js) ─────────────────────────────────

var Log = {
  lines: [],
  truncated: false,
  max: MAX_LINES,
  push: function (text) {
    var line = '[' + stamp() + '] ' + text;
    console.log(line);
    if (this.truncated) return false;
    if (this.lines.length >= this.max) {
      this.lines.push(line + ' TRUNCATED at ' + this.max + ' lines');
      this.truncated = true;
      return false;
    }
    this.lines.push(line);
    return true;
  }
};

function btnMask(gp) {
  var b = gp.buttons;
  var mask = 0;
  if (b[0] && b[0].pressed)  mask |= 0x0001;
  if (b[1] && b[1].pressed)  mask |= 0x0002;
  if (b[2] && b[2].pressed)  mask |= 0x0004;
  if (b[3] && b[3].pressed)  mask |= 0x0008;
  if (b[4] && b[4].pressed)  mask |= 0x0100;
  if (b[5] && b[5].pressed)  mask |= 0x0200;
  if (b[8] && b[8].pressed)  mask |= 0x2000;
  if (b[9] && b[9].pressed)  mask |= 0x1000;
  if (b[10] && b[10].pressed) mask |= 0x0400;
  if (b[11] && b[11].pressed) mask |= 0x0800;
  if (b[12] && b[12].pressed) mask |= 0x0010;
  if (b[13] && b[13].pressed) mask |= 0x0020;
  if (b[14] && b[14].pressed) mask |= 0x0040;
  if (b[15] && b[15].pressed) mask |= 0x0080;
  if (b[16] && b[16].pressed) mask |= 0x4000;
  return mask;
}

function axesInt16(gp, n) {
  var a = [];
  for (var k = 0; k < Math.min(n, gp.axes.length); k++) a.push(Math.round((gp.axes[k] || 0) * 32767));
  return a;
}

// One compact full-state line per pad. Format:
//   p<idx> b:<hex> lx:<int> ly:<int> rx:<int> ry:<int> lt:<0-255> rt:<0-255>
function deltaText(idx, mask, ax, lt, rt) {
  return 'p' + idx + ' b:' + mask.toString(16) + ' lx:' + ax[0] + ' ly:' + ax[1] + ' rx:' + ax[2] + ' ry:' + ax[3] + ' lt:' + lt + ' rt:' + rt;
}

// Decide whether a state line should be emitted for this pad this tick.
// Returns true if: a button changed (immediate), an axis jumped >= qBig
// (immediate), or anything changed and the last full line is older than
// sampleMs (cadence — one line per pad per second max).
function shouldLog(st, mask, ax, lt, rt, now, sampleMs, qBig) {
  var changed = mask !== st.mask;
  var big = false;
  for (var i = 0; i < 4; i++) {
    if (ax[i] !== st.ax[i]) changed = true;
    if (Math.abs(ax[i] - st.ax[i]) >= qBig) big = true;
  }
  if (Math.abs(lt - st.lt) >= 2 || Math.abs(rt - st.rt) >= 2) changed = true;
  return mask !== st.mask || big || (changed && now - st.t >= sampleMs);
}

// ── DOM ───────────────────────────────────────────────────────────────────────

var TICK_MS = 100;      // visual refresh
var SAMPLE_MS = 1000;   // max one full state line per pad per second
var Q_BIG = 4096;       // int16 — immediate line when an axis jumps this much

var stage = document.getElementById('stage');
var emptyEl = document.getElementById('empty');
var padEls = {};   // gp.index -> { root, svg, els: { knob, triggers, buttons } }
var logStates = {};// gp.index -> { mask, ax:[4], lt, rt, t }
var stats = {};    // gp.index -> { id, startT, ms, max:[4], ltMax, rtMax, startX, union }
var timer = null;
var lastTickAt = 0;
var lastHb = 0;

function makePadSvg(idx) {
  var p = 'g' + idx;
  var svg = '<svg viewBox="0 0 440 300">'
    + '<path class="shell" d="M110,70 L330,70 C390,70 430,110 420,185 C410,240 360,260 330,250 L280,232 L160,232 L110,250 C80,260 30,240 20,185 C10,110 50,70 110,70 Z"/>'
    + '<rect id="' + p + 'b4" class="tl" x="80" y="48" width="76" height="18" rx="5"/>'
    + '<rect id="' + p + 'b5" class="tl" x="284" y="48" width="76" height="18" rx="5"/>'
    + '<rect id="' + p + 'b6" class="tl" x="88" y="16" width="60" height="32" rx="6"/>'
    + '<rect id="' + p + 'b7" class="tl" x="292" y="16" width="60" height="32" rx="6"/>'
    + '<g transform="translate(100,142)">'
    +   '<circle id="' + p + 'b12" class="btn" cx="0" cy="-23" r="13"/>'
    +   '<circle id="' + p + 'b13" class="btn" cx="0" cy="23" r="13"/>'
    +   '<circle id="' + p + 'b14" class="btn" cx="-23" cy="0" r="13"/>'
    +   '<circle id="' + p + 'b15" class="btn" cx="23" cy="0" r="13"/>'
    + '</g>'
    + '<g transform="translate(340,142)">'
    +   '<circle id="' + p + 'b3" class="btn" cx="0" cy="-32" r="16"/>'
    +   '<circle id="' + p + 'b0" class="btn" cx="0" cy="32" r="16"/>'
    +   '<circle id="' + p + 'b2" class="btn" cx="-32" cy="0" r="16"/>'
    +   '<circle id="' + p + 'b1" class="btn" cx="32" cy="0" r="16"/>'
    + '</g>'
    + '<rect id="' + p + 'b8" class="btn" x="178" y="120" width="28" height="11" rx="4"/>'
    + '<rect id="' + p + 'b9" class="btn" x="234" y="120" width="28" height="11" rx="4"/>'
    + '<circle id="' + p + 'b16" class="btn" cx="220" cy="100" r="16"/>'
    + '<g transform="translate(175,195)">'
    +   '<circle class="well" cx="0" cy="0" r="32"/>'
    +   '<circle id="' + p + 'b10" class="btn" cx="0" cy="0" r="26"/>'
    +   '<circle id="' + p + 'knobL" class="knob" cx="0" cy="0" r="22"/>'
    + '</g>'
    + '<g transform="translate(265,195)">'
    +   '<circle class="well" cx="0" cy="0" r="32"/>'
    +   '<circle id="' + p + 'b11" class="btn" cx="0" cy="0" r="26"/>'
    +   '<circle id="' + p + 'knobR" class="knob" cx="0" cy="0" r="22"/>'
    + '</g>'
    + '</svg>';
  return svg;
}

function buildPad(idx, gp) {
  var root = document.createElement('div');
  root.className = 'pad';
  root.innerHTML = makePadSvg(idx) + '<div class="pname"></div>';
  stage.appendChild(root);
  var els = { buttons: {}, knobs: {}, triggers: {}, name: root.querySelector('.pname') };
  var g = 'g' + idx;
  for (var i = 0; i < 17; i++) els.buttons[i] = root.querySelector('#' + g + 'b' + i);
  els.knobs.l = root.querySelector('#' + g + 'knobL');
  els.knobs.r = root.querySelector('#' + g + 'knobR');
  els.triggers.l = els.buttons[6];
  els.triggers.r = els.buttons[7];
  padEls[idx] = { root: root, els: els };
  els.name.textContent = gp.id;
}

function rebuildPads() {
  stage.innerHTML = '';
  padEls = {};
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  var n = 0;
  for (var i = 0; i < pads.length; i++) {
    var gp = pads[i];
    if (!gp || !gp.connected) continue;
    buildPad(gp.index, gp);
    n++;
  }
  emptyEl.classList.toggle('visible', n === 0);
}

function updateVisual(idx, gp) {
  var els = padEls[idx] && padEls[idx].els;
  if (!els) return;
  for (var i = 0; i < 17; i++) {
    els.buttons[i].classList.toggle('on', !!(gp.buttons[i] && gp.buttons[i].pressed));
  }
  var lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
  var rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;
  els.knobs.l.setAttribute('cx', Math.round(lx * 26));
  els.knobs.l.setAttribute('cy', Math.round(ly * 26));
  els.knobs.r.setAttribute('cx', Math.round(rx * 26));
  els.knobs.r.setAttribute('cy', Math.round(ry * 26));
}

function tick() {
  var now = Date.now();
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  var seen = {};
  var n = 0;
  var any = false;
  for (var i = 0; i < pads.length; i++) {
    var gp = pads[i];
    if (!gp || !gp.connected) continue;
    n++;
    seen[gp.index] = true;
    updateVisual(gp.index, gp);

    var idx = gp.index;
    var mask = btnMask(gp);
    if (!stats[idx]) {
      stats[idx] = { id: gp.id, startT: now, ms: 0, max: [0, 0, 0, 0], ltMax: 0, rtMax: 0, startX: 0, union: 0 };
      padStatesMask[idx] = mask;
      Log.push('CONNECT idx=' + idx + ' id="' + gp.id + '"');
      any = true;
    }
    var st = stats[idx];
    st.ms += now - lastTickAt;
    var ax = axesInt16(gp, 4);
    var lt = Math.round((gp.buttons[6] ? gp.buttons[6].value : 0) * 255);
    var rt = Math.round((gp.buttons[7] ? gp.buttons[7].value : 0) * 255);
    st.union |= mask;
    st.ltMax = Math.max(st.ltMax, lt);
    st.rtMax = Math.max(st.rtMax, rt);
    if (mask & 0x1000 && !(padStatesMask[idx] & 0x1000)) st.startX++;
    padStatesMask[idx] = mask;
    for (var k = 0; k < 4; k++) if (Math.abs(ax[k]) > st.max[k]) st.max[k] = Math.abs(ax[k]);

    var ls = logStates[idx];
    if (!ls) ls = logStates[idx] = { mask: -1, ax: [-99999, -99999, -99999, -99999], lt: -1, rt: -1, t: 0 };
    if (shouldLog(ls, mask, ax, lt, rt, now, SAMPLE_MS, Q_BIG)) {
      Log.push(deltaText(idx, mask, ax, lt, rt));
      ls.mask = mask; ls.ax = ax.slice(); ls.lt = lt; ls.rt = rt; ls.t = now;
      any = true;
    }
  }
  for (var idx2 in padEls) {
    if (!seen[idx2]) {
      padEls[idx2].root.remove();
      delete padEls[idx2];
      Log.push('DISCONNECT idx=' + idx2);
      any = true;
    }
  }
  emptyEl.classList.toggle('visible', n === 0);
  if (!any && now - lastHb >= 30000) {
    lastHb = now;
    Log.push('hb pads=' + n);
  }
  lastTickAt = now;
}

window.addEventListener('gamepadconnected', function () { rebuildPads(); });
window.addEventListener('gamepaddisconnected', function () { rebuildPads(); });
window.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    var d = new Date();
    var fname = 'nearcade-gamepad-probe-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.txt';
    var header = [
      'Nearcade Gamepad Probe log',
      'Date: ' + d.toString(),
      'Send this file to the Nearcade developer.',
      ''
    ].join('\n') + '\n';
    window.probe.saveLog(fname, header + Log.lines.join('\n') + '\n').then(function (res) {
      if (res.ok) console.log('[probe] log saved: ' + res.path);
    });
  }
});
window.addEventListener('beforeunload', function () {
  var dur = Math.round((Date.now() - lastTickAt) / 1000);
  Log.push('TEST STOP dur=' + dur + 's lines=' + Log.lines.length);
  for (var idx in stats) {
    var st = stats[idx];
    Log.push('sum p' + idx + ' ms=' + Math.round(st.ms / 1000) + 's maxlx=' + st.max[0] + ' maxly=' + st.max[1] +
      ' maxrx=' + st.max[2] + ' maxry=' + st.max[3] + ' ltmax=' + st.ltMax + ' rtmax=' + st.rtMax +
      ' startx=' + st.startX + ' btns=0x' + st.union.toString(16));
  }
});

var padStatesMask = {};
(function boot() {
  rebuildPads();
  var d = new Date();
  Log.push('TEST START date=' + d.toISOString() + ' platform=' + navigator.platform);
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  var connected = [];
  for (var i = 0; i < pads.length; i++) {
    if (pads[i] && pads[i].connected) {
      connected.push('"' + (pads[i].id.length > 70 ? pads[i].id.slice(0, 67) + '...' : pads[i].id) + '"');
      padStatesMask[pads[i].index] = btnMask(pads[i]);
    }
  }
  Log.push(connected.length ? 'pads=' + connected.length + ': ' + connected.join(' | ')
    : 'WARN no pads visible to the browser. Press a button on the controller.');
  lastTickAt = Date.now();
  lastHb = lastTickAt;
  timer = setInterval(tick, TICK_MS);
  setTimeout(function () {
    var pads2 = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var j = 0; j < pads2.length; j++) {
      if (pads2[j] && pads2[j].connected) padStatesMask[pads2[j].index] = btnMask(pads2[j]);
    }
  }, 100);
})();
