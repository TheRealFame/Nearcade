'use strict';

// Nearcade Gamepad Probe — renderer.
// Self-contained popup: one compact controller visual per pad, a live in-window
// log (capped at 120 lines), and a plain-English report that describes the
// issue (e.g. Steam Input virtual duplicates) so the log can be sent as-is.
// The simulation runs the real viewer code (www/viewer-sim.js, extracted from
// src/scripts/viewer.js) against the real config/controllers.json.

var MAX_LINES = 250; // hard cap; the action log is far below this in practice

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp() {
  var d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad2(d.getMilliseconds());
}

// ── Pure logic (unit-tested by test-logic.js) ─────────────────────────────────

// Logging is GATED: nothing is recorded until the user actually starts doing the
// checklist actions. Pre-action lines are held in pendingLines and flushed the
// moment the user moves a stick or presses a button.
var userActive = false;
var pendingLines = [];
var Log = {
  lines: [],
  truncated: false,
  max: MAX_LINES,
  push: function (text) {
    if (!userActive) { pendingLines.push(text); return true; }
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

function activateUser() {
  if (userActive) return;
  userActive = true;
  var i;
  for (i = 0; i < pendingLines.length; i++) {
    var line = '[' + stamp() + '] ' + pendingLines[i];
    console.log(line);
    Log.lines.push(line);
  }
  pendingLines = [];
}

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

// One compact full-state line. Format:
//   p<idx> b:<hex> lx:<int> ly:<int> rx:<int> ry:<int> lt:<0-255> rt:<0-255>
// (prefix 'S' = the simulated Nearcade host transmit for the picked pad)
function deltaText(prefix, idx, mask, ax, lt, rt) {
  return prefix + idx + ' b:' + mask.toString(16) + ' lx:' + ax[0] + ' ly:' + ax[1] + ' rx:' + ax[2] + ' ry:' + ax[3] + ' lt:' + lt + ' rt:' + rt;
}

// Decide whether a state line should be emitted this tick.
// True if: a button changed (immediate), an axis jumped >= qBig (immediate),
// or anything changed and the last full line is older than sampleMs.
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

// True when two pads report the same buttons and (nearly) the same stick
// values — i.e. one physical controller exposed twice (Steam Input).
function isMirrorPair(maskA, axA, maskB, axB, tol) {
  if (maskA !== maskB) return false;
  for (var i = 0; i < 4; i++) {
    if (Math.abs(axA[i] - axB[i]) >= tol) return false;
  }
  return true;
}

function isVirtualSteamId(id) {
  return /28de|steam|virtual|imput/i.test(id);
}

// The Nearcade Linux virtualization backend (src/sidecar/input_backends/
// linux_uinput.py) injects a virtual Xbox 360 controller via uinput:
// vendor 0x045E, product 0x028E, name "Xbox 360 Controller". The probe
// synthesizes that pad so the probe mirrors what a Nearcade host exposes.
var BACKEND_PAD_ID = '045e-028e-Xbox 360 Controller (STANDARD GAMEPAD)';
var BACKEND_IDX = 100;

function isNearcadeBackend(id) { return id === BACKEND_PAD_ID; }

// ── Guided task checks (done on the user's real pad) ─────────────────────────
// Sticks must reach full range in all four directions AND be rotated at least
// 270° — free jabs do not count, which is the whole point of the checklist.

function newStickAcc() {
  return { minX: 1, maxX: -1, minY: 1, maxY: -1, sweep: 0, lastAng: null };
}

function stickStat(acc, x, y) {
  acc.minX = Math.min(acc.minX, x);
  acc.maxX = Math.max(acc.maxX, x);
  acc.minY = Math.min(acc.minY, y);
  acc.maxY = Math.max(acc.maxY, y);
  var m = Math.hypot(x, y);
  if (m > 0.3) {
    var a = Math.atan2(y, x);
    if (acc.lastAng !== null) {
      var d = a - acc.lastAng;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      acc.sweep += Math.abs(d);
    }
    acc.lastAng = a;
  }
  return acc;
}

function stickDone(a) {
  return a.maxX >= 0.9 && a.minX <= -0.9 && a.maxY >= 0.9 && a.minY <= -0.9 &&
    a.sweep >= 270 * Math.PI / 180;
}

function taskDone(i, ts, stickL, stickR) {
  switch (i) {
    case 0: return stickDone(stickL);
    case 1: return stickDone(stickR);
    case 2: return (ts.union & 0x000F) === 0x000F;
    case 3: return (ts.union & 0x0300) === 0x0300;
    case 4: return ts.ltMax >= 230 && ts.rtMax >= 230;
    case 5: return (ts.union & 0x00F0) === 0x00F0;
    case 6: return (ts.union & 0x3000) === 0x3000;
  }
  return false;
}

// The measured evidence for a passed check — the action that was recorded.
function taskExtra(i, stickL, stickR, ltMax, rtMax) {
  if (i === 0) {
    return ' (range lx ' + Math.round(stickL.minX * 32767) + '..' + Math.round(stickL.maxX * 32767) +
      ' ly ' + Math.round(stickL.minY * 32767) + '..' + Math.round(stickL.maxY * 32767) +
      ' sweep ' + Math.round(stickL.sweep * 180 / Math.PI) + '\u00b0)';
  }
  if (i === 1) {
    return ' (range rx ' + Math.round(stickR.minX * 32767) + '..' + Math.round(stickR.maxX * 32767) +
      ' ry ' + Math.round(stickR.minY * 32767) + '..' + Math.round(stickR.maxY * 32767) +
      ' sweep ' + Math.round(stickR.sweep * 180 / Math.PI) + '\u00b0)';
  }
  if (i === 4) return ' (lt ' + ltMax + ' rt ' + rtMax + ')';
  return '';
}

// Ordered checklist: each task ONLY counts when the one above it is done.
// The user cannot skip ahead — hence the checklist's forcing nature.
var TASKS = [
  { label: 'LEFT STICK — full rotation', hint: 'rotate the LEFT stick in full circles, reaching all edges' },
  { label: 'RIGHT STICK — full rotation', hint: 'rotate the RIGHT stick in full circles, reaching all edges' },
  { label: 'A / B / X / Y', hint: 'press A, B, X, Y once each' },
  { label: 'LB / RB BUMPERS', hint: 'press LB and RB once' },
  { label: 'LT / RT TRIGGERS', hint: 'pull LT and RT all the way to the end' },
  { label: 'D-PAD 4 WAYS', hint: 'press all four D-Pad directions once' },
  { label: 'START / SELECT', hint: 'press START and SELECT once' }
];

var STICK_TASK_0 = 0, STICK_TASK_1 = 1, TRIGGER_TASK = 4;

// ── DOM ───────────────────────────────────────────────────────────────────────

var TICK_MS = 100;      // visual refresh
var SAMPLE_MS = 1000;   // max one full state line per pad per second
var Q_BIG = 4096;       // int16 — immediate line when an axis jumps this much
var MIRROR_TOL = 1024;  // int16 — axes tolerance for mirror detection
var MIRROR_TICKS = 20;  // consecutive ticks (2s) of identical input = mirror

var stage = document.getElementById('stage');
var emptyEl = document.getElementById('empty');
var logEl = document.getElementById('log');
var btnStop = document.getElementById('btnStop');
var btnReset = document.getElementById('btnReset');
var btnCopy = document.getElementById('btnCopy');
var copiedEl = document.getElementById('copied');
var seperatorBuilt = false;
var spacerEl = null;
var dividerEl = null;
var backendEl = null;
var padEls = {};    // gp.index -> { root, els }
var stats = {};     // gp.index -> { id, ms, max:[4], ltMax, rtMax, startX, prevMask, union, mirrored }
var mirrorTicks = {}; // gp.index -> consecutive mirror ticks
var timer = null;
var taskStick = { l: newStickAcc(), r: newStickAcc() };
var taskPadId = null;    // controller the checklist is bound to; switch → restart
var taskLis = [];
var taskCommitted = [];
var chkHint = null;
var backendSrc = -1;
var lastTickAt = 0;
var lastHb = 0;
var simSel = -1;      // gp.index of the simulated host pick
var lastSimSel = -1;
var simMapOn = {};    // gp.index -> bool (lookupCalibMap found a map)
var recording = true;
var startAt = Date.now();
var mirrorDeclared = {}; // gp.index -> bool

// The viewer reads these from localStorage; the probe pins the same defaults
// the shipped config relies on (0.05 deadzone / 1.0 sensitivity).
window._globalDeadzone = 0.05;
window._globalSens = 1.0;

function renderLog() {
  logEl.textContent = Log.lines.join('\n');
}

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
  root.className = 'pad' + (idx === BACKEND_IDX ? ' backend' : '');
  root.innerHTML = makePadSvg(idx) + '<div class="pname"></div><div class="badge"></div>';
  if (idx === BACKEND_IDX) {
    // The Nearcade-simulated pad lives in its own section, cut off by a large
    // vertical divider and shoved to the far right.
    if (!seperatorBuilt) {
      seperatorBuilt = true;
      spacerEl = document.createElement('div');
      spacerEl.id = 'padspr';
      stage.appendChild(spacerEl);
      dividerEl = document.createElement('div');
      dividerEl.id = 'divider';
      stage.appendChild(dividerEl);
    }
    backendEl = root;
    stage.appendChild(root);
  } else if (dividerEl) {
    stage.insertBefore(root, dividerEl); // real pads always stay left of the line
  } else {
    stage.appendChild(root);
  }
  var els = { buttons: {}, knobs: {}, triggers: {}, name: root.querySelector('.pname'), badge: root.querySelector('.badge') };
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
  seperatorBuilt = false;
  spacerEl = null;
  dividerEl = null;
  backendEl = null;
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  var n = 0;
  for (var i = 0; i < pads.length; i++) {
    var gp = pads[i];
    if (!gp || !gp.connected || isVirtualSteamId(gp.id)) continue; // never show Steam mirrors
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

// ── Viewer simulation (all math lives in viewer-sim.js, extracted verbatim
//    from src/scripts/viewer.js) ──────────────────────────────────────────────

var sim = {
  cache: {}, // gp.index -> { axes: Int32Array(4), btns: Int32Array(16) }
  state: {}, // gp.index -> { axes:[4], buttons:[16] }
  dz: {},    // gp.index -> per-stick overrides (viewer gpDeadzones)
  sens: {}   // gp.index -> per-stick overrides (viewer gpSens)
};

// Same selection rule as pollGamepad — standard pads WITH a calibration
// profile win, then any standard pad, then the first connected pad. A
// profile-less duplicate must never be picked over one the config maps.
function pickBestGp(pads) {
  var first = null;
  var std = null;
  var stdProfiled = null;
  for (var i = 0; i < pads.length; i++) {
    var gp = pads[i];
    if (!gp || !gp.connected) continue;
    if (isNearcadeBackend(gp.id)) continue; // the injected virtual pad is not a pickable "real" pad
    if (!first) first = gp;
    if (gp.mapping === 'standard') {
      if (!std) std = gp;
      if (!stdProfiled && !!window.NearcadeSim.lookupCalibMap(gp)) stdProfiled = gp;
    }
  }
  return stdProfiled || std || first;
}

// Runs one viewer tick for the picked pad and returns the EXACT JSON payload
// a real host would receive: {buttons, lx, ly, rx, ry, lt, rt}.
function simulateViewer(pads) {
  var gp = pickBestGp(pads);
  if (!gp) return null;
  var idx = gp.index;
  if (!sim.cache[idx]) sim.cache[idx] = { axes: new Int32Array(4), btns: new Int32Array(16) };
  if (!sim.state[idx]) sim.state[idx] = {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, function () { return { pressed: false, value: 0 }; })
  };
  window.NearcadeSim.applyGamepadDzSens(gp, sim.cache[idx], sim.state[idx], sim.dz, sim.sens);
  window.NearcadeSim.applyCalibration(gp, sim.state[idx]);
  return JSON.parse(window.NearcadeSim.packGamepadJson(0, sim.state[idx]));
}

function makeBackendPad(src) {
  return {
    index: BACKEND_IDX,
    connected: true,
    mapping: 'standard',
    id: BACKEND_PAD_ID,
    axes: src.axes.slice(0, 4),
    buttons: src.buttons.map(function (b) { return { pressed: !!b.pressed, value: b.value || 0 }; })
  };
}

// Commit the first UNdone task only when it passes — everything below stays
// locked. Returns how many tasks are committed and the active (forced next)
// task index, or -1 when all done.
function advanceChecklist(ts, stickL, stickR) {
  var firstOpen = 0;
  while (firstOpen < TASKS.length && taskCommitted[firstOpen]) firstOpen++;
  if (firstOpen < TASKS.length && ts && taskDone(firstOpen, ts, stickL, stickR)) {
    taskCommitted[firstOpen] = true;
    Log.push('TASK PASS — ' + TASKS[firstOpen].label + taskExtra(firstOpen, stickL, stickR, ts.ltMax, ts.rtMax));
  }
  firstOpen = 0;
  while (firstOpen < TASKS.length && taskCommitted[firstOpen]) firstOpen++;
  for (var i = 0; i < taskLis.length; i++) {
    taskLis[i].classList.toggle('done', taskCommitted[i]);
    taskLis[i].classList.toggle('active', i === firstOpen && firstOpen < TASKS.length);
  }
  chkHint.textContent = firstOpen < TASKS.length ? TASKS[firstOpen].hint : 'ALL CHECKS PASS — log auto-finalized';
  return firstOpen;
}

function updateTasks(realPad, stickL, stickR) {
  var ts = realPad ? stats[realPad.index] : null;
  if (!ts) {
    chkHint.textContent = 'no controller detected yet';
    return 0;
  }
  return advanceChecklist(ts, stickL, stickR);
}

function committedCount() {
  var c = 0;
  for (var i = 0; i < taskCommitted.length; i++) if (taskCommitted[i]) c++;
  return c;
}

function tick() {
  if (!recording) return;
  var now = Date.now();
  // Steam Input mirror pads (28de:11ff uinput virtual Xbox 360) are filtered
  // out ENTIRELY — the probe never sees them, needs nothing closed beforehand,
  // and works the same whether Steam is running or not.
  var browserPads = [];
  var rawPads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (var rpi = 0; rpi < rawPads.length; rpi++) {
    var rawGp = rawPads[rpi];
    if (rawGp && rawGp.connected && !isVirtualSteamId(rawGp.id)) browserPads.push(rawGp);
  }
  var i, k;
  // "your" real pad — prefer the one with a calibration profile so the
  // checklist tests exactly what the host will transmit and calibrate.
  var realPad = null;
  var realStd = null;
  var realProfiled = null;
  for (i = 0; i < browserPads.length; i++) {
    var rp = browserPads[i];
    if (!rp || !rp.connected) continue;
    if (isNearcadeBackend(rp.id)) continue;
    if (!realStd) realStd = rp;
    if (!realProfiled && !!window.NearcadeSim.lookupCalibMap(rp)) realProfiled = rp;
  }
  realPad = realProfiled || realStd;

  // The pick only ever runs over real pads — with Steam mirrors filtered out
  // upstream, the first standard-mapped pad IS the real controller.
  var hostPads = [];
  for (i = 0; i < browserPads.length; i++) {
    if (browserPads[i] && browserPads[i].connected) hostPads.push(browserPads[i]);
  }
  if (!hostPads.length) hostPads = [].slice.call(browserPads);

  // Nearcade virtualization backend sim: a virtual Xbox 360 pad that mirrors
  // the real pad (what linux_uinput.py injects into the OS).
  var bestGp = pickBestGp(hostPads);
  var srcPad = realPad || bestGp;
  if (srcPad && !padEls[BACKEND_IDX]) {
    buildPad(BACKEND_IDX, makeBackendPad(srcPad));
    if (!stats[BACKEND_IDX]) {
      Log.push('CONNECT p' + BACKEND_IDX + ' [NEARCADE VIRTUAL] id="' + BACKEND_PAD_ID + '"');
      Log.push('  NOTE: this is what Nearcade\'s virtualization backend (linux_uinput.py)');
      Log.push('  injects into the OS — a virtual Xbox 360 pad mirroring your controller.');
    }
    backendSrc = srcPad.index;
  }

  var pads = [];
  for (i = 0; i < browserPads.length; i++) {
    if (browserPads[i] && browserPads[i].connected) pads.push(browserPads[i]);
  }
  if (srcPad && padEls[BACKEND_IDX]) pads.push(makeBackendPad(srcPad));

  var seen = {};
  var n = 0;
  var any = false;
  var picked = null;

  for (i = 0; i < pads.length; i++) {
    var gp = pads[i];
    if (!gp || !gp.connected) continue;
    n++;
    seen[gp.index] = true;
    updateVisual(gp.index, gp);

    var idx = gp.index;
    var mask = btnMask(gp);
    var ax = axesInt16(gp, 4);
    if (!stats[idx]) {
      stats[idx] = { id: gp.id, ms: 0, max: [0, 0, 0, 0], ltMax: 0, rtMax: 0, startX: 0, prevMask: 0, union: 0, mirrored: false, mirrorSrc: -1 };
      if (isNearcadeBackend(gp.id)) {
        Log.push('CONNECT p' + idx + ' [NEARCADE VIRTUAL] id="' + gp.id + '"');
      } else {
        Log.push('CONNECT p' + idx + ' [REAL] id="' + gp.id + '"');
      }
      any = true;
    }
    var st = stats[idx];
    st.ms += now - lastTickAt;
    var lt = Math.round((gp.buttons[6] ? gp.buttons[6].value : 0) * 255);
    var rt = Math.round((gp.buttons[7] ? gp.buttons[7].value : 0) * 255);
    st.union |= mask;
    st.ltMax = Math.max(st.ltMax, lt);
    st.rtMax = Math.max(st.rtMax, rt);
    if (mask & 0x1000 && !(st.prevMask & 0x1000)) st.startX++;
    st.prevMask = mask;
    for (k = 0; k < 4; k++) if (Math.abs(ax[k]) > st.max[k]) st.max[k] = Math.abs(ax[k]);
    // NOTE: controller data lines are intentionally NOT logged — the action
    // log records checklist behavior only (TASK PASS lines carry the evidence).
  }
  for (var idx2 in padEls) {
    if (!seen[idx2]) {
      padEls[idx2].root.remove();
      delete padEls[idx2];
      Log.push('DISCONNECT p' + idx2);
      any = true;
    }
  }

  // Guided tasks on the user's real pad (or the pick if no real pad exists)
  var taskPad = realPad || bestGp;
  if (taskPad) {
    if (taskPadId === null) taskPadId = taskPad.id;
    else if (taskPad.id !== taskPadId) {
      // A different controller took over mid-checklist: all evidence from the
      // previous one is stale — restart the tasks so the user can't skip them
      // on the strength of old input.
      taskPadId = taskPad.id;
      taskStick.l = newStickAcc();
      taskStick.r = newStickAcc();
      for (var tci = 0; tci < taskCommitted.length; tci++) taskCommitted[tci] = false;
      Log.push('TASK RESTART — controller changed; checklist starts fresh');
      firstOpen = 0;
      for (i = 0; i < taskLis.length; i++) {
        taskLis[i].classList.remove('done', 'active');
      }
    }
    taskStick.l = stickStat(taskStick.l, taskPad.axes[0] || 0, taskPad.axes[1] || 0);
    taskStick.r = stickStat(taskStick.r, taskPad.axes[2] || 0, taskPad.axes[3] || 0);
  }

  // No logging until the user actually performs checklist actions (a stick
  // moved, button pressed or trigger pulled). Pending boot lines flush here.
  if (!userActive && taskPad) {
    var actMask = btnMask(taskPad);
    var actAx = axesInt16(taskPad, 4);
    var actLt = Math.round((taskPad.buttons[6] ? taskPad.buttons[6].value : 0) * 255);
    var actRt = Math.round((taskPad.buttons[7] ? taskPad.buttons[7].value : 0) * 255);
    var live = actMask !== 0 || actLt > 0 || actRt > 0;
    for (i = 0; i < 4; i++) if (Math.abs(actAx[i]) > 200) live = true;
    if (live) activateUser();
  }

  var firstOpen = updateTasks(taskPad, taskStick.l, taskStick.r);

  // Simulated host transmit for the picked pad (never a Steam virtual pad)
  var simPkt = simulateViewer(hostPads);
  simSel = bestGp ? bestGp.index : -1;
  if (bestGp) picked = { index: bestGp.index, mask: btnMask(bestGp), ax: axesInt16(bestGp, 4) };

  if (simSel !== lastSimSel) {
    if (lastSimSel >= 0 || simSel >= 0) {
      Log.push('sel ' + (lastSimSel < 0 ? 'none' : lastSimSel) + '->' + (simSel < 0 ? 'none' : simSel));
      any = true;
    }
    lastSimSel = simSel;
  }

  // Mirror detection between real pads (Steam mirrors never reach this loop —
  // the synthesized backend pad is excluded as it is a copy by construction).
  for (i = 0; i < browserPads.length; i++) {
    var mg = browserPads[i];
    if (!mg || !mg.connected || mg.index === BACKEND_IDX) continue;
    if (!picked || mg.index === picked.index) continue;
    var same = isMirrorPair(picked.mask, picked.ax, btnMask(mg), axesInt16(mg, 4), MIRROR_TOL);
    mirrorTicks[mg.index] = same ? (mirrorTicks[mg.index] || 0) + 1 : 0;
    if (!mirrorDeclared[mg.index] || !mirrorDeclared[picked.index]) {
      mirrorDeclared[mg.index] = true;
      mirrorDeclared[picked.index] = true;
      Log.push('MIRROR p' + mg.index + ' repeats p' + picked.index + ' exactly');
      if (stats[mg.index]) { stats[mg.index].mirrored = true; stats[mg.index].mirrorSrc = picked.index; }
      any = true;
    }
  }
  for (var mi2 in mirrorTicks) {
    if (picked && Number(mi2) !== picked.index && !seen[mi2]) mirrorTicks[mi2] = 0;
  }

  for (i = 0; i < pads.length; i++) {
    var pg = pads[i];
    if (!pg || !pg.connected) continue;
    var on = !!window.NearcadeSim.lookupCalibMap(pg);
    if (on !== simMapOn[pg.index]) {
      simMapOn[pg.index] = on;
      Log.push('map p' + pg.index + ' near=' + (on ? 'MAP' : 'NOMAP'));
      any = true;
    }
  }
  // (transmit runs internally; per-tick payloads are not logged)

  for (var vi in padEls) {
    var st = stats[vi];
    var isSel = Number(vi) === simSel;
    var label;
    if (st && isNearcadeBackend(st.id)) label = 'NEARCADE VIRTUAL';
    else if (isSel) label = 'HOST PICK — YOURS';
    else label = 'YOUR CONTROLLER';
    padEls[vi].root.classList.toggle('sel', isSel);
    // The user's real pad gets most of the stage real-estate; the Nearcade
    // backend pad sits tucked behind the divider at 1x width.
    padEls[vi].root.classList.toggle('main', !!st && !isNearcadeBackend(st.id));
    padEls[vi].els.badge.textContent = label;
  }

  emptyEl.classList.toggle('visible', n === 0);
  if (!any && now - lastHb >= 30000) {
    lastHb = now;
    Log.push('hb pads=' + n + ' sim=' + (simSel < 0 ? 'none' : simSel));
  }
  lastTickAt = now;
  renderLog(); // unconditional — the action log is small; always stay fresh

  // All guided checks passed → the log is complete, auto-finalize
  var allDone = firstOpen >= TASKS.length || !taskPad;
  if (taskPad && allDone) finalize('TASKS');
  // Safety cap — but NEVER finalize on it while zero tasks are done: the
  // checklist must not be skippable, ever. Rusty evidence from random input
  // without completing checks is not a valid result.
  else if (Log.lines.length >= MAX_LINES - 8 && committedCount() > 0) finalize('AUTO');
}

// ── Report ────────────────────────────────────────────────────────────────────
function padName(id) {
  var short = id.replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/, '').replace(/\(.*?\)/g, '').trim();
  return short || id;
}

function fullScale(n) { return n >= 32500 ? 'FULL RANGE' : n >= 16000 ? 'HALF RANGE' : n > 100 ? 'PARTIAL' : 'NONE'; }

function finalize(reason) {
  if (!recording) return;
  recording = false;
  clearInterval(timer);
  btnStop.classList.add('finalized');
  btnStop.textContent = 'REPORTED';
  btnCopy.disabled = false;
  // Un-gate: the report must always be fully written, flushing any boot lines
  // that were held because the user had not performed checklist actions yet.
  if (!userActive) {
    Log.push('NOTE: no checklist actions were performed before reporting.');
    activateUser();
  }

  var dur = Math.round((Date.now() - startAt) / 1000);
  var padCount = Object.keys(stats).length;
  var mir = [];
  for (var idx in stats) {
    if (stats[idx].mirrored) mir.push(idx);
  }

  Log.push('===== NEARCADE GAMEPAD PROBE REPORT =====');
  Log.push('pads found: ' + padCount +
    (stats[BACKEND_IDX] ? ' (incl. 1 Nearcade virtual backend pad)' : ''));
  for (var rIdx in stats) {
    var st = stats[rIdx];
    var real;
    if (isNearcadeBackend(st.id)) real = 'NEARCADE VIRTUAL';
    else real = 'REAL — YOUR CONTROLLER';
    var line = '  p' + rIdx + ' [' + real + '] ' + padName(st.id) +
      '  cfg ' + (window.NearcadeSim.lookupCalibMap({ id: st.id, mapping: 'standard' }) ? 'MAP (profile found — sim can drive it)' : 'NOMAP (no profile in config)');
    if (st.mirrored && st.mirrorSrc >= 0 && stats[st.mirrorSrc]) {
      line += ' — copies p' + st.mirrorSrc + ' (' + padName(stats[st.mirrorSrc].id).slice(0, 30) + ')';
    } else if (isNearcadeBackend(st.id) && backendSrc >= 0 && stats[backendSrc]) {
      line += ' — backend injection, mirrors p' + backendSrc;
    }
    Log.push(line);
  }
  if (stats[BACKEND_IDX]) {
    Log.push('NEARCADE VIRTUALIZATION: p' + BACKEND_IDX + ' is what linux_uinput.py injects');
    Log.push('  into the OS (045e:028e Xbox 360). It carries the same input as your pad.');
  }
  if (mir.length) {
    Log.push('MIRROR: p' + mir.join(', p') + ' repeats the pick exactly — duplicate device.');
  }
  for (var yIdx in stats) {
    if (!isNearcadeBackend(stats[yIdx].id)) {
      Log.push('your physical controller: p' + yIdx + ' (' + padName(stats[yIdx].id).slice(0, 45) + ')');
      break;
    }
  }
  var pickVirt = false;
  Log.push('host picks: p' + (simSel < 0 ? 'none' : simSel) +
    (simSel >= 0 && stats[simSel] ? ' (' + padName(stats[simSel].id).slice(0, 40) + ')' : '') +
    (pickVirt ? ' — Steam virtual pad; same input as the real pad' : '') +
    ' — first standard REAL pad with a calibration profile; Steam Input mirrors are filtered out entirely');
  var pickMapped = simSel >= 0 && stats[simSel] &&
    !!window.NearcadeSim.lookupCalibMap({ id: stats[simSel].id, mapping: 'standard' });
  if (simSel >= 0 && !pickMapped) {
    Log.push('  WARNING: the picked pad has NO calibration profile (cfg NOMAP). Its input');
    Log.push('  reaches the host RAW — deadzone, sensitivity and curve are NOT applied.');
    Log.push('  If a sibling pad with the same Vendor:Product has a profile, unplug the');
    Log.push('  unprofiled duplicate (USB+Bluetooth double registration) and retest.');
  }
  Log.push('  log policy: action-only — checklist dance steps are recorded,');
  Log.push('  raw per-tick controller data is not.');

  // Checklist result lines, in the forced order the user had to follow
  var taskPadIdx = -1;
  for (var tp in stats) {
    if (!isNearcadeBackend(stats[tp].id)) { taskPadIdx = Number(tp); break; }
  }
  Log.push('CHECKLIST' + (taskPadIdx >= 0 ? ' (p' + taskPadIdx + ' — your controller):' : ': no physical pad seen'));
  var allPass = taskPadIdx >= 0;
  for (var t = 0; t < TASKS.length; t++) {
    var d = taskCommitted[t] === true;
    if (!d) allPass = false;
    var extra = '';
    if (t === STICK_TASK_0) {
      extra = taskExtra(t, taskStick.l, taskStick.r, 0, 0);
    } else if (t === STICK_TASK_1) {
      extra = taskExtra(t, taskStick.l, taskStick.r, 0, 0);
    } else if (t === TRIGGER_TASK && taskPadIdx >= 0) {
      extra = taskExtra(t, taskStick.l, taskStick.r, stats[taskPadIdx].ltMax, stats[taskPadIdx].rtMax);
    }
    Log.push('  ' + (d ? 'PASS' : 'NOT DONE') + ' — ' + TASKS[t].label + extra);
  }
  Log.push('CHECKLIST RESULT: ' + (allPass ? 'ALL CHECKS PASS — controller works' : 'NOT ALL CHECKS DONE — send this log'));

  for (var sIdx in stats) {
    var s = stats[sIdx];
    Log.push('  p' + sIdx + ' sticks max: lx ' + s.max[0] + ' ly ' + s.max[1] + ' rx ' + s.max[2] + ' ry ' + s.max[3] +
      ' (' + fullScale(Math.max.apply(null, s.max)) + ')  lt ' + s.ltMax + ' rt ' + s.rtMax +
      '  start x' + s.startX + '  btns 0x' + s.union.toString(16));
  }
  Log.push('recording: ' + dur + 's, lines: ' + Log.lines.length +
    (reason === 'AUTO' ? ' (auto-stopped at line cap)' : reason === 'TASKS' ? ' (all checks passed)' : ''));
  Log.push('===== END REPORT — click COPY LOG and paste it in the chat =====');
  renderLog();
}

// ── UI ────────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', function () { finalize('MANUAL'); });
btnReset.addEventListener('click', resetProbe);

function bootLog() {
  var d = new Date();
  Log.push('TEST START date=' + d.toISOString() + ' platform=' + navigator.platform);
  Log.push('CHECKLIST: do each check below — the log auto-finalizes when ALL PASS, then COPY.');
  var padsN = navigator.getGamepads ? navigator.getGamepads() : [];
  var connectedN = [];
  for (var iN = 0; iN < padsN.length; iN++) {
    if (padsN[iN] && padsN[iN].connected) {
      connectedN.push('"' + (padsN[iN].id.length > 70 ? padsN[iN].id.slice(0, 67) + '...' : padsN[iN].id) + '"');
    }
  }
  Log.push(connectedN.length ? 'pads=' + connectedN.length + ': ' + connectedN.join(' | ')
    : 'WARN no pads visible yet. Plug in your controller and press any button.');
}

function resetProbe() {
  // Full restart: wipe the log, the gating state and every piece of checklist
  // evidence. Old commits (even from the same session) must never carry over
  // into a new run — the tasks start at zero again, always.
  clearInterval(timer);
  recording = true;
  Log.truncated = false;
  Log.lines = [];
  pendingLines = [];
  userActive = false;
  taskPadId = null;
  taskStick.l = newStickAcc();
  taskStick.r = newStickAcc();
  for (var i = 0; i < taskCommitted.length; i++) taskCommitted[i] = false;
  for (i = 0; i < taskLis.length; i++) taskLis[i].classList.remove('done', 'active');
  btnStop.classList.remove('finalized');
  btnStop.textContent = 'STOP & REPORT';
  btnCopy.disabled = true;
  copiedEl.textContent = '';
  simMapOn = {};
  lastTickAt = Date.now();
  lastHb = lastTickAt;
  startAt = lastTickAt;
  bootLog();
  renderLog();
  timer = setInterval(tick, TICK_MS);
}
btnCopy.addEventListener('click', function () {
  var d = new Date();
  var header = 'Nearcade Gamepad Probe log\n' +
    'Date: ' + d.toString() + '\n' +
    'Simulation: src/scripts/viewer.js (NEARCADE PROBE SIM CORE) + config/controllers.json\n' +
    'Send this to the Nearcade developer.\n';
  window.probe.copyText(header + Log.lines.join('\n') + '\n').then(function (ok) {
    copiedEl.textContent = ok ? 'COPIED!' : 'copy failed';
    setTimeout(function () { copiedEl.textContent = ''; }, 2500);
  });
});
window.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    var d = new Date();
    var fname = 'nearcade-gamepad-probe-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.txt';
    var header = [
      'Nearcade Gamepad Probe log',
      'Date: ' + d.toString(),
      'Simulation: src/scripts/viewer.js (NEARCADE PROBE SIM CORE) + config/controllers.json',
      'Send this file to the Nearcade developer.',
      ''
    ].join('\n') + '\n';
    window.probe.saveLog(fname, header + Log.lines.join('\n') + '\n').then(function (res) {
      if (res.ok) console.log('[probe] log saved: ' + res.path);
    });
  }
});
window.addEventListener('beforeunload', function () {
  if (recording) finalize('CLOSE');
});

window.addEventListener('gamepadconnected', function () { rebuildPads(); });
window.addEventListener('gamepaddisconnected', function () { rebuildPads(); });

// ── Boot ──────────────────────────────────────────────────────────────────────
(function boot() {
  rebuildPads();
  var tasksEl = document.getElementById('tasks');
  for (var t = 0; t < TASKS.length; t++) {
    var chip = document.createElement('span');
    chip.className = 'tchip';
    chip.textContent = TASKS[t].label;
    tasksEl.appendChild(chip);
    taskLis.push(chip);
    taskCommitted.push(false);
  }
  chkHint = document.getElementById('chkhint');
  bootLog();
  window.probe.loadConfig().then(function (res) {
    if (res.ok) {
      window.NearcadeSim.smartDb = res.db;
      Log.push('cfg profiles=' + res.count + ' — real Nearcade config loaded');
    } else {
      Log.push('cfg FAILED: ' + res.error + ' — simulation runs with an empty db');
    }
    renderLog();
  });
  renderLog();
  lastTickAt = Date.now();
  lastHb = lastTickAt;
  timer = setInterval(tick, TICK_MS);
})();
