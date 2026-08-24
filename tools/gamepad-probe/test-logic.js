'use strict';
// Standalone tests for the probe's Nearcade simulation:
//   1. viewer-sim.js is extracted VERBATIM from src/scripts/viewer.js
//   2. The simulation behaves like the real viewer against the REAL
//      config/controllers.json, including the user's DualSense + Steam setup.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const results = [];
function check(name, cond, detail) {
  results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
}

// ── 1. Extraction integrity ───────────────────────────────────────────────────
const viewer = fs.readFileSync(path.join(__dirname, '../../src/scripts/viewer.js'), 'utf8');
const viewerSim = fs.readFileSync(path.join(__dirname, 'www/viewer-sim.js'), 'utf8');
const START = '// ── NEARCADE PROBE SIM CORE: START ─';
const END = '// ── NEARCADE PROBE SIM CORE: END ─';

const blocks = [];
let i = 0;
while (true) {
  const s = viewer.indexOf(START, i);
  if (s === -1) break;
  const e = viewer.indexOf(END, s);
  if (e === -1) throw new Error('unterminated marker');
  blocks.push(viewer.slice(s, e).replace(/^\/\/ ── NEARCADE PROBE SIM CORE: START ─.+\n/, ''));
  i = e;
}
check('sim core has 2 marker blocks in viewer.js', blocks.length === 2, 'blocks=' + blocks.length);
blocks.forEach((b, n) => check('viewer-sim.js contains block ' + (n + 1) + ' verbatim', viewerSim.includes(b), b.slice(0, 40).replace(/\n/g, ' ') + '...'));

const src = fs.readFileSync(path.join(__dirname, 'www/renderer.js'), 'utf8');
const logic = src.slice(0, src.indexOf('// ── DOM'));
const sandbox2 = { console: { log() {} }, Date, Math, JSON, Object, String, Array, Number };
vm.createContext(sandbox2);
vm.runInContext(logic + '\n;this.pure = { isMirrorPair, isVirtualSteamId, deltaText, isNearcadeBackend, stickStat, stickDone, newStickAcc, taskDone, taskExtra };', sandbox2);
const pure = sandbox2.pure;

// Mirror detection: identical buttons + near-identical sticks = virtual copy
check('isMirrorPair: identical pads = mirror', pure.isMirrorPair(0x1001, [100, -200, 300, -400], 0x1001, [100, -200, 300, -400], 1024) === true);
check('isMirrorPair: different buttons = not a mirror', pure.isMirrorPair(0x1001, [100, 0, 0, 0], 0x0001, [100, 0, 0, 0], 1024) === false);
check('isMirrorPair: diverging stick = not a mirror', pure.isMirrorPair(0x1001, [100, 0, 0, 0], 0x1001, [5000, 0, 0, 0], 1024) === false);
check('isMirrorPair: tiny axis wobble still a mirror', pure.isMirrorPair(0x1001, [100, 0, 0, 0], 0x1001, [110, -8, 0, 0], 1024) === true);
check('isVirtualSteamId: Steam virtual Xbox id flagged', pure.isVirtualSteamId('28de-11ff-Microsoft X-Box 360 pad 0 (STANDARD GAMEPAD)') === true);
check('isVirtualSteamId: DualSense not flagged', pure.isVirtualSteamId('054c-0ce6-DualSense Wireless Controller (STANDARD GAMEPAD)') === false);
check('deltaText S-line format', pure.deltaText('S', 0, 0x1001, [25869, -15521, -18970, 22420], 0, 0) ===
  'S0 b:1001 lx:25869 ly:-15521 rx:-18970 ry:22420 lt:0 rt:0');
check('Nearcade backend pad id flagged', pure.isNearcadeBackend('045e-028e-Xbox 360 Controller (STANDARD GAMEPAD)') === true);
check('Nearcade backend pad NOT flagged as Steam', pure.isVirtualSteamId('045e-028e-Xbox 360 Controller (STANDARD GAMEPAD)') === false);

// Guided stick checks: full rotation to full range passes, jabs and partial
// rotations must NOT pass.
let accFull = pure.newStickAcc();
for (let deg = 0; deg <= 360; deg += 15) {
  const r = deg * Math.PI / 180;
  accFull = pure.stickStat(accFull, Math.cos(r), Math.sin(r));
}
check('stick: full rotation full range passes', pure.stickDone(accFull) === true,
  'sweep=' + Math.round(accFull.sweep * 180 / Math.PI) + 'deg');
let accJab = pure.newStickAcc();
for (let j = 0; j < 10; j++) accJab = pure.stickStat(accJab, 0.5, -0.5);
check('stick: center jab without rotation fails', pure.stickDone(accJab) === false);
let accPartial = pure.newStickAcc();
for (let d = 0; d <= 90; d += 15) {
  const r = d * Math.PI / 180;
  accPartial = pure.stickStat(accPartial, Math.cos(r), Math.sin(r));
}
check('stick: quarter rotation with full range fails', pure.stickDone(accPartial) === false,
  'sweep=' + Math.round(accPartial.sweep * 180 / Math.PI) + 'deg');
let accHalf = pure.newStickAcc();
for (let d = 0; d <= 180; d += 15) {
  const r = d * Math.PI / 180;
  accHalf = pure.stickStat(accHalf, Math.cos(r), Math.sin(r));
}
check('stick: half rotation (180deg) still fails', pure.stickDone(accHalf) === false,
  'sweep=' + Math.round(accHalf.sweep * 180 / Math.PI) + 'deg');
let acc3q = pure.newStickAcc();
for (let d = 0; d <= 300; d += 15) {
  const r = d * Math.PI / 180;
  acc3q = pure.stickStat(acc3q, Math.cos(r), Math.sin(r));
}
check('stick: 300deg rotation full range passes', pure.stickDone(acc3q) === true,
  'sweep=' + Math.round(acc3q.sweep * 180 / Math.PI) + 'deg');

// Forced checklist evaluators: each task pass requires its OWN inputs, and the
// ordering/locking is enforced by advanceChecklist (covered by the harness).
check('task A/B/X/Y passes only with all four face buttons',
  pure.taskDone(2, { union: 0x000F }, pure.newStickAcc(), pure.newStickAcc()) === true);
check('task A/B/X/Y does NOT pass with A+X only',
  pure.taskDone(2, { union: 0x0005 }, pure.newStickAcc(), pure.newStickAcc()) === false);
check('task LB/RB passes with both bumpers',
  pure.taskDone(3, { union: 0x0300 }, pure.newStickAcc(), pure.newStickAcc()) === true);
check('task LB/RB fails with LB only',
  pure.taskDone(3, { union: 0x0100 }, pure.newStickAcc(), pure.newStickAcc()) === false);
check('task LT/RT passes at exactly 230 each',
  pure.taskDone(4, { union: 0, ltMax: 230, rtMax: 230 }, pure.newStickAcc(), pure.newStickAcc()) === true);
check('task LT/RT fails at 229',
  pure.taskDone(4, { union: 0, ltMax: 229, rtMax: 230 }, pure.newStickAcc(), pure.newStickAcc()) === false);
check('task D-PAD passes with all four directions',
  pure.taskDone(5, { union: 0x00F0 }, pure.newStickAcc(), pure.newStickAcc()) === true);
check('task START/SELECT passes with both system buttons',
  pure.taskDone(6, { union: 0x3000 }, pure.newStickAcc(), pure.newStickAcc()) === true);
check('task START/SELECT fails with START only',
  pure.taskDone(6, { union: 0x1000 }, pure.newStickAcc(), pure.newStickAcc()) === false);
check('task left-stick rotation passes with a full circle',
  pure.taskDone(0, { union: 0 }, accFull, pure.newStickAcc()) === true);
check('task extra: left-stick evidence carries range + sweep',
  pure.taskExtra(0, accFull, pure.newStickAcc(), 255, 255) ===
    ' (range lx -32767..32767 ly -32767..32767 sweep 360\u00b0)');
check('task extra: trigger evidence carries lt/rt maxes',
  pure.taskExtra(4, pure.newStickAcc(), pure.newStickAcc(), 240, 212) === ' (lt 240 rt 212)');
check('task extra: button tasks carry no evidence text',
  pure.taskExtra(2, pure.newStickAcc(), pure.newStickAcc(), 0, 0) === '');

// ── 2. Behavior against the real config ───────────────────────────────────────
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/controllers.json'), 'utf8'));

const sandbox = {
  window: {},
  console: { log() {} },
  Int32Array, Array, Math, JSON, Object, String, Number, Date, performance: { now: () => 0 }
};
vm.createContext(sandbox);
vm.runInContext(viewerSim + '\n;this.fns = window.NearcadeSim;', sandbox);
sandbox.window._globalDeadzone = 0.05;
sandbox.window._globalSens = 1.0;
const fns = sandbox.fns;
sandbox.window.NearcadeSim.smartDb = db; // what probe:load-config does at runtime

function gp(id, axes, pressed) {
  return {
    id, index: 0, mapping: 'standard', connected: true,
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!pressed[i], value: pressed[i] ? 1 : 0 }))
  };
}
function freshCache() { return { axes: new Int32Array(4), btns: new Int32Array(16) }; }
function freshState() { return { axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) }; }

const dualsense = gp('054c-0ce6-DualSense Wireless Controller (STANDARD GAMEPAD)', [-0.608, -0.537, -0.812, -0.655], { 9: true });
const steamPad = gp('28de-11ff-Microsoft X-Box 360 pad 0 (STANDARD GAMEPAD)', [-0.6081, -0.537, -0.8121, -0.655], {});
const steamMasked = gp('045e-02ea-Microsoft X-Box One S pad (STANDARD GAMEPAD)', [0.5, 0, 0, 0], {});

// Map resolution (real viewer lookupCalibMap)
check('DualSense exact-id map found in real config', !!fns.lookupCalibMap(dualsense),
  JSON.stringify(fns.lookupCalibMap(dualsense)).slice(0, 80));
check('Steam 28de-11ff virtual pad: NOMAP (like the viewer)', fns.lookupCalibMap(steamPad) === null);
check('Steam-masked 045e-02ea falls back to DualSense map', !!fns.lookupCalibMap(steamMasked),
  'map=' + JSON.stringify(fns.lookupCalibMap(steamMasked)).slice(0, 60));

// Axis math (real applyGamepadDzSens: dz 0.05 / sens 1.0, int16, jitter filter)
let cache = freshCache(), state = freshState();
fns.applyGamepadDzSens(dualsense, cache, state, {}, {});
const expLx = Math.round((Math.sign(-0.608) * ((Math.abs(-0.608) - 0.05) / 0.95)) * 32767);
check('applyGamepadDzSens lx math matches viewer formula', state.axes[0] * 32767 === expLx,
  'got=' + Math.round(state.axes[0] * 32767) + ' expected=' + expLx);

// Micro-jitter filter: a change smaller than 32/32767 is ignored
cache = freshCache(); state = freshState();
const tiny = gp('x', [0.0005, 0, 0, 0], {});
fns.applyGamepadDzSens(tiny, cache, state, {}, {});
check('jitter filter: sub-32 change ignored', state.axes[0] === 0 && cache.axes[0] === 0, 'axes0=' + state.axes[0]);

// packGamepadJson: the exact host payload
cache = freshCache(); state = freshState();
fns.applyGamepadDzSens(dualsense, cache, state, {}, {});
fns.applyCalibration(dualsense, state);
const pkt = JSON.parse(fns.packGamepadJson(0, state));
check('packGamepadJson has Start bit 0x1000', (pkt.buttons & 0x1000) !== 0, '0x' + pkt.buttons.toString(16));
check('packGamepadJson lx is int16', Math.abs(pkt.lx) <= 32767 && pkt.lx === Math.round(pkt.lx), 'lx=' + pkt.lx);
check('packGamepadJson lt/rt normalized 0..1', pkt.lt >= 0 && pkt.lt <= 1 && pkt.rt >= 0 && pkt.rt <= 1, 'lt=' + pkt.lt + ' rt=' + pkt.rt);

// Runtime calibration override (SAVE_CONTROLLER_CALIB → calibMaps[safeId])
const safeId = fns.getSafeGamepadId(dualsense);
fns.smartDb = {};
fns.calibMaps[safeId] = { lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3, ldz: 0.10, lsens: 2.0, rdz: 0.10, rsens: 2.0 };
check('runtime calib map (calibMaps[safeId]) overrides db', fns.lookupCalibMap(dualsense) === fns.calibMaps[safeId]);
cache = freshCache(); state = freshState();
fns.applyGamepadDzSens(dualsense, cache, state, {}, {});
fns.applyCalibration(dualsense, state);
// Viewer quirk: map ldz/lsens only ever affect the RIGHT stick (applyCalibration
// uses m.rdz/m.rsens); the left stick always uses gpDeadzones/gpSens + globals.
// Also: sens is clamped to ±1.0 BEFORE the deadzone is applied.
const clamped = Math.max(-1.0, Math.min(1.0, -0.812 * 2.0));
const expR = Math.round((Math.sign(clamped) * ((Math.abs(clamped) - 0.10) / 0.90)) * 32767);
check('calibrated rx uses map rdz/rsens', state.axes[2] * 32767 === expR, 'got=' + Math.round(state.axes[2] * 32767) + ' expected=' + expR);

// Full pipeline: which pad does the host receive? (mirror of pollGamepad selectBest)
sandbox.window.NearcadeSim.smartDb = db;
const gen = gp('9999-0001-Generic PS5 Controller (STANDARD GAMEPAD)', [0.25, 0, 0, 0], {});
const ds = gp('054c-0ce6-DualSense Wireless Controller (STANDARD GAMEPAD)', [-0.3, 0, 0, 0], {});
function selectBest(pads) {
  let bestGp = null, bestStd = null, bestStdProfiled = null, isTouch = false;
  for (const g of pads) {
    if (!g || !g.connected) continue;
    if (!bestGp) bestGp = g;
    if (g.mapping === 'standard') {
      if (!bestStd) bestStd = g;
      if (!bestStdProfiled && fns.lookupCalibMap(g)) bestStdProfiled = g;
    }
  }
  bestGp = bestStdProfiled || bestStd || bestGp;
  return bestGp;
}
check('selection: NOMAP generic first, PROFILE DualSense second → profiled wins', selectBest([gen, ds]) === ds, selectBest([gen, ds]) && selectBest([gen, ds]).id.slice(0, 30));
check('selection: PROFILE DualSense first → profiled wins', selectBest([ds, gen]) === ds);
check('selection: NOMAP only → first standard wins', selectBest([gen, steamPad]) === gen);

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL'));
console.log(fails.length ? fails.length + ' FAILURES' : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
