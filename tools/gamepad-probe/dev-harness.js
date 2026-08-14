'use strict';
// Dev harness: loads www/index.html in a hidden window, injects TWO fake
// gamepads (DualSense + Steam virtual Xbox, like the user's setup) — Steam's
// virtual mirror must be COMPLETELY INVISIBLE to the probe — and verifies:
//   (a) visuals + badges (HOST PICK — YOURS / NEARCADE VIRTUAL)
//   (b) the stage shows the real pad + the synthesized Nearcade backend pad,
//       separated by the vertical divider, backend shoved right
//   (c) nothing is logged before the user performs checklist actions
//   (d) the guided CHECKLIST auto-completes and the report auto-finalizes
// Usage: npx electron dev-harness.js [steam-first]  (from tools/gamepad-probe)

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT_DIR = '/tmp/opencode/probe-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('enable-logging');
app.commandLine.appendSwitch('disable-gpu');

ipcMain.handle('probe:load-config', () => {
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'controllers.json');
    const db = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ok: true, path: p, count: Object.keys(db).length, db };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = new BrowserWindow({
      width: 900, height: 560, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, sandbox: true
      }
    });
    win.webContents.setBackgroundThrottling(false);
    const consoleLines = [];
    win.webContents.on('console-message', (_e, _level, message) => consoleLines.push(message));
    await win.loadFile(path.join(__dirname, 'www', 'index.html'));

    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
      console.log('SHOT ' + name);
    };
    const js = (code) => win.webContents.executeJavaScript(code);

    // Two pads, order decides which index the real DualSense gets. The Steam
    // virtual pad must NEVER appear: no pad element, no badge, no log line.
    const steamFirst = process.argv[2] === 'steam-first';
    const steamIdx = steamFirst ? 0 : 1;
    const dualIdx = steamFirst ? 1 : 0;
    const ids = steamFirst
      ? ['28de-11ff-Microsoft X-Box 360 pad 0 (STANDARD GAMEPAD)', '054c-0ce6-DualSense Wireless Controller (STANDARD GAMEPAD)']
      : ['054c-0ce6-DualSense Wireless Controller (STANDARD GAMEPAD)', '28de-11ff-Microsoft X-Box 360 pad 0 (STANDARD GAMEPAD)'];
    await js(`(() => {
      window.__fake = [
        { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) },
        { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }
      ];
      const pads = [
        { index: 0, connected: true, mapping: 'standard', id: ${JSON.stringify(ids[0])}, axes: window.__fake[0].axes, buttons: window.__fake[0].buttons },
        { index: 1, connected: true, mapping: 'standard', id: ${JSON.stringify(ids[1])}, axes: window.__fake[1].axes, buttons: window.__fake[1].buttons }
      ];
      Object.defineProperty(navigator, 'getGamepads', { value: () => pads, configurable: true });
      window.dispatchEvent(new Event('gamepadconnected'));
    })();`);
    await sleep(1200); // let config load + first ticks run

    // Steam must be invisible + log gating: empty log, and only ONE pad (the
    // DualSense) + the synthesized backend pad, divider between, backend right.
    const gateDiag = JSON.parse(await js(`JSON.stringify({
      padCount: document.querySelectorAll('#stage .pad').length,
      log: document.getElementById('log').textContent.trim(),
      divider: !!document.getElementById('divider'),
      dividerW: document.getElementById('divider') ? getComputedStyle(document.getElementById('divider')).width : '0px',
      spacer: !!document.getElementById('padspr'),
      badges: [...document.querySelectorAll('.badge')].map(b => b.textContent),
      names: [...document.querySelectorAll('.pname')].map(n => n.textContent),
      geom: (() => {
        const x = (el) => (el ? el.getBoundingClientRect().x : -1);
        const w = (el) => (el ? el.getBoundingClientRect().width : -1);
        const pads = [...document.querySelectorAll('.pad')];
        return {
          padLeft: x(pads[0]), padRight: x(pads[pads.length - 1]),
          pad0w: w(pads[0]), padNw: w(pads[pads.length - 1]),
          spacer: x(document.getElementById('padspr')),
          divider: x(document.getElementById('divider')),
          win: window.innerWidth
        };
      })()
    })`));
    const g = gateDiag.geom;
    const gateOk = gateDiag.log === '' && gateDiag.divider && gateDiag.dividerW !== '0px' && gateDiag.spacer &&
      gateDiag.padCount === 2 && // real + backend ONLY
      !gateDiag.badges.some(b => /STEAM/.test(b)) &&
      !gateDiag.names.some(n => /28de|Steam|X-Box 360 pad/.test(n)) &&
      gateDiag.badges[0] === 'HOST PICK — YOURS' && gateDiag.badges[1] === 'NEARCADE VIRTUAL' &&
      g.padLeft < g.spacer && g.spacer < g.divider && g.divider < g.padRight && g.padRight > g.win * 0.6 &&
      g.pad0w > g.padNw * 1.4; // the MAIN (real) pad owns the real-estate
    console.log('GATE ' + (gateOk ? 'PASS' : 'FAIL') + ' pads=' + gateDiag.badges.length +
      ' dividerW=' + gateDiag.dividerW + ' x=' + [g.padLeft, g.spacer, g.divider, g.padRight].map(v => Math.round(v)).join(',') +
      ' w=' + [Math.round(g.pad0w), Math.round(g.padNw)].join('/'));
    if (!gateOk) app.exit(1);

    // Stick push on the REAL pad (left stick 0.8/-0.5, right stick -0.6/0.7)
    // + buttons A + Start
    await js(`window.__fake[${dualIdx}].axes[0] = 0.8; window.__fake[${dualIdx}].axes[1] = -0.5;
      window.__fake[${dualIdx}].axes[2] = -0.6; window.__fake[${dualIdx}].axes[3] = 0.7;
      window.__fake[${dualIdx}].buttons[0].pressed = true; window.__fake[${dualIdx}].buttons[0].value = 1;
      window.__fake[${dualIdx}].buttons[9].pressed = true; window.__fake[${dualIdx}].buttons[9].value = 1;`);
    await sleep(600);
    await shot('01-input.png');

    const diag = JSON.parse(await js(`JSON.stringify({
      padCount: document.querySelectorAll('#stage .pad').length,
      knobL: document.getElementById('g${dualIdx}knobL').getAttribute('cx') + ',' + document.getElementById('g${dualIdx}knobL').getAttribute('cy'),
      aOn: document.getElementById('g${dualIdx}b0').classList.contains('on'),
      startOn: document.getElementById('g${dualIdx}b9').classList.contains('on'),
      badges: [...document.querySelectorAll('.badge')].map(b => b.textContent)
    })`));
    console.log('DIAG ' + JSON.stringify(diag));
    const selLines = consoleLines.filter(l => /sel /.test(l));
    console.log('SELLINE ' + (selLines.length ? selLines[selLines.length - 1] : 'NONE'));

    const ok =
      diag.padCount === 2 && // real + backend ONLY (Steam mirror filtered out)
      diag.knobL === '21,-13' &&
      diag.aOn === true && diag.startOn === true &&
      diag.badges[0] === 'HOST PICK — YOURS' && diag.badges[1] === 'NEARCADE VIRTUAL' &&
      selLines.length > 0 && selLines[selLines.length - 1].includes('->' + dualIdx) &&
      // action-only log: no raw controller data lines, no steam anywhere
      !consoleLines.some(l => /(^|[^0-9A-Za-z])[pS]\d+ b:[0-9a-f]/.test(l.replace(/^\[[^\]]*\] /, ''))) &&
      !consoleLines.some(l => /28de|STEAM VIRTUAL/i.test(l));
    console.log('RESULT ' + (ok ? 'PASS' : 'FAIL'));
    if (!ok) app.exit(1);

    // ── Steam invisibility: the Steam virtual pad beats the real input for
    //    2+ seconds — the probe must still see ONLY the DualSense ──
    await js(`window.__fake[${steamIdx}].axes[0] = 0.8; window.__fake[${steamIdx}].axes[1] = -0.5;
      window.__fake[${steamIdx}].axes[2] = -0.6; window.__fake[${steamIdx}].axes[3] = 0.7;
      window.__fake[${steamIdx}].buttons[0].pressed = true; window.__fake[${steamIdx}].buttons[0].value = 1;
      window.__fake[${steamIdx}].buttons[9].pressed = true; window.__fake[${steamIdx}].buttons[9].value = 1;`);
    await sleep(2600);
    await shot('02-steam-invisible.png');
    const steamDiag = JSON.parse(await js(`JSON.stringify({
      padCount: document.querySelectorAll('#stage .pad').length,
      badges: [...document.querySelectorAll('.badge')].map(b => b.textContent),
      log: document.getElementById('log').textContent
    })`));
    const steamOk = steamDiag.padCount === 2 &&
      !steamDiag.badges.some(b => /STEAM/.test(b)) &&
      !/28de|STEAM VIRTUAL|X-Box 360 pad/i.test(steamDiag.log) &&
      !/MIRROR/.test(steamDiag.log); // nothing mirrors — the mirror is invisible
    console.log('STEAMHIDE ' + (steamOk ? 'PASS' : 'FAIL') + ' pads=' + steamDiag.padCount +
      ' steamInLog=' + (/28de|STEAM VIRTUAL/i.test(steamDiag.log)));
    if (!steamOk) app.exit(1);

    // ── Guided checklist: rotate BOTH sticks in full circles, press every
    //    button and fully pull both triggers on the REAL pad → auto-finalize ──
    const taskPad = dualIdx;
    await js(`(() => {
      const F = window.__fake[${taskPad}];
      [0,1,2,3,4,5,8,9,12,13,14,15].forEach(i => { F.buttons[i].pressed = true; F.buttons[i].value = 1; });
      F.buttons[6].pressed = true; F.buttons[6].value = 1;
      F.buttons[7].pressed = true; F.buttons[7].value = 1;
      window.__taskAng = 0;
      window.__taskAnim = setInterval(() => {
        window.__taskAng += 15 * Math.PI / 180;
        F.axes[0] = Math.cos(window.__taskAng);
        F.axes[1] = Math.sin(window.__taskAng);
        F.axes[2] = Math.cos(window.__taskAng + Math.PI);
        F.axes[3] = Math.sin(window.__taskAng + Math.PI);
      }, 40);
      setTimeout(() => clearInterval(window.__taskAnim), 1500);
    })();`);
    await shot('03-checks-running.png');

    let stopText = '';
    for (let w = 0; w < 50 && stopText !== 'REPORTED'; w++) {
      await sleep(200);
      stopText = await js(`document.getElementById('btnStop').textContent`);
    }
    const repDiag = JSON.parse(await js(`JSON.stringify({
      log: document.getElementById('log').textContent,
      copyDisabled: document.getElementById('btnCopy').disabled,
      stopText: document.getElementById('btnStop').textContent,
      chipsDone: [...document.querySelectorAll('.tchip')].filter(c => c.classList.contains('done')).length,
      badges: [...document.querySelectorAll('.badge')].map(b => b.textContent)
    })`));
    console.log('AUTO ' + (stopText === 'REPORTED' ? 'PASS' : 'FAIL') + ' stop=' + stopText + ' chips=' + repDiag.chipsDone + '/7');
    const repOk =
      stopText === 'REPORTED' && repDiag.copyDisabled === false &&
      repDiag.chipsDone === 7 &&
      /NEARCADE GAMEPAD PROBE REPORT/.test(repDiag.log) &&
      /NEARCADE VIRTUALIZATION/.test(repDiag.log) &&
      /CHECKLIST \(p/.test(repDiag.log) &&
      /CHECKLIST RESULT: ALL CHECKS PASS/.test(repDiag.log) &&
      /PASS — LEFT STICK — full rotation \(range lx/.test(repDiag.log) &&
      /PASS — RIGHT STICK — full rotation \(range rx/.test(repDiag.log) &&
      /PASS — LT \/ RT TRIGGERS \(lt \d+ rt \d+\)/.test(repDiag.log) &&
      /TASK PASS — LEFT STICK — full rotation \(range lx/.test(repDiag.log) &&
      /REAL — YOUR CONTROLLER/.test(repDiag.log) &&
      /your physical controller: p/.test(repDiag.log) &&
      /log policy: action-only/.test(repDiag.log) &&
      /\[REAL — YOUR CONTROLLER\][^\n]+cfg MAP/.test(repDiag.log) &&
      !/p\d+ b:[0-9a-f]/i.test(repDiag.log) &&
      !/28de|STEAM VIRTUAL/i.test(repDiag.log) &&
      !repDiag.badges.some(b => /STEAM/.test(b));
    console.log('REPORT ' + (repOk ? 'PASS' : 'FAIL') + (steamFirst ? ' (steam-first)' : ''));
    await shot('04-report-final.png');

    await js(`document.getElementById('btnCopy').disabled = false; document.getElementById('btnStop').click()`);
    const stillReported = await js(`document.getElementById('btnStop').textContent`);
    console.log('MANUAL ' + (stillReported === 'REPORTED' ? 'PASS' : 'FAIL'));

    // RESET flow: wipes log + checklist evidence; RESET is idempotent, and a
    // fresh run can NEVER inherit old commits (no task can be skipped on
    // stale data from the previous session). Release all sim input first —
    // a reset with held buttons legitimately starts recording.
    await js(`window.__fake[${dualIdx}].axes[0] = 0; window.__fake[${dualIdx}].axes[1] = 0;
      window.__fake[${dualIdx}].axes[2] = 0; window.__fake[${dualIdx}].axes[3] = 0;
      for (const b of window.__fake[${dualIdx}].buttons) { b.pressed = false; b.value = 0; }`);
    await js(`document.getElementById('btnReset').click()`);
    await sleep(400);
    const rst = JSON.parse(await js(`JSON.stringify({
      stopText: document.getElementById('btnStop').textContent,
      chipsDone: [...document.querySelectorAll('.tchip')].filter(c => c.classList.contains('done')).length,
      log: document.getElementById('log').textContent.trim(),
      hint: document.getElementById('chkhint').textContent
    })`));
    await js(`document.getElementById('btnReset').click()`);
    const rst2 = JSON.parse(await js(`JSON.stringify({
      stopText: document.getElementById('btnStop').textContent,
      log: document.getElementById('log').textContent.trim()
    })`));
    const resetBaseOk = rst.stopText === 'STOP & REPORT' && rst.chipsDone === 0 && rst.log === '' &&
      rst2.stopText === 'STOP & REPORT' && rst2.log === '';
    await js(`document.getElementById('btnStop').click()`);
    await sleep(300);
    const rstLog = await js(`document.getElementById('log').textContent`);
    const resetOk = resetBaseOk &&
      /NOTE: no checklist actions were performed before reporting/.test(rstLog) &&
      !/TASK PASS|PASS — |ALL CHECKS PASS/.test(rstLog); // no stale/skipped evidence
    console.log('RESET ' + (resetOk ? 'PASS' : 'FAIL') +
      ' stop=' + rst.stopText + ' chips=' + rst.chipsDone + ' freshLog=' + (rst.log === '') +
      ' staleEvid=' + /TASK PASS|PASS — /.test(rstLog));
    await shot('05-reset.png');

    const allOk = ok && gateOk && steamOk && repOk && stillReported === 'REPORTED' && resetOk;
    console.log('RESULT ' + (allOk ? 'PASS' : 'FAIL'));
    app.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('HARNESS FAILED: ' + (e && e.stack || e));
    app.exit(2);
  }
});