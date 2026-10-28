/**
 * src/scripts/extended/spatial-nav.js
 * Gamepad & TV Remote Virtual Cursor Engine
 */

const cursor = document.getElementById('virtual-cursor');
let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
let lastTime = performance.now();
let vx = 0, vy = 0;
const keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };

// Persistent per-gamepad button states across animation frames
const gpButtonStates = new Map();

function getClickTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const clickable = el.closest('button, a, input, select, textarea, [onclick], .nav-btn, .clickable, .more-card, .radio-card, .toggle, .custom-select');
  return clickable || el;
}

window.triggerSpatialNavClick = function() {
  if (cursor) {
    cursor.classList.add('clicking');
    setTimeout(() => { if (cursor) cursor.classList.remove('clicking'); }, 150);
  }

  let target = null;
  if (cursor && cursor.style.display !== 'none') {
    target = getClickTargetAt(cx, cy);
  }

  if (!target && document.activeElement && document.activeElement !== document.body) {
    target = document.activeElement;
  }

  if (target) {
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      target.focus();
    }
    if (typeof target.click === 'function') {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }
};

function updateGamepad(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.1); // Cap delta time at 100ms
  lastTime = time;

  // TV Remote (Keyboard) Acceleration
  const accel = 3500;
  const maxSpeed = 1200;
  const friction = 0.8;

  if (keys.ArrowUp) vy -= accel * dt;
  if (keys.ArrowDown) vy += accel * dt;
  if (keys.ArrowLeft) vx -= accel * dt;
  if (keys.ArrowRight) vx += accel * dt;

  if (!keys.ArrowUp && !keys.ArrowDown) vy *= Math.pow(friction, dt * 60);
  if (!keys.ArrowLeft && !keys.ArrowRight) vx *= Math.pow(friction, dt * 60);

  const currentSpeed = Math.sqrt(vx * vx + vy * vy);
  if (currentSpeed > maxSpeed) {
    vx = (vx / currentSpeed) * maxSpeed;
    vy = (vy / currentSpeed) * maxSpeed;
  }

  let totalDx = vx * dt;
  let totalDy = vy * dt;

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;

    const layout = typeof window.detectGamepadLayout === 'function' ? window.detectGamepadLayout(p) : 'xbox';
    if (typeof window.updateHandheldPromptGlyphs === 'function' && window._lastNavLayout !== layout) {
      window._lastNavLayout = layout;
      window.updateHandheldPromptGlyphs(layout);
    }

    let state = gpButtonStates.get(p.index);
    if (!state) {
      state = { select: false, back: false, docs: false, friends: false, start: false };
      gpButtonStates.set(p.index, state);
    }

    // Read Thumbsticks and D-Pad
    const gdx = p.axes[0] || 0;
    const gdy = p.axes[1] || 0;
    const deadzone = 0.18;
    const speed = 900;

    let sx = Math.abs(gdx) > deadzone ? gdx : 0;
    let sy = Math.abs(gdy) > deadzone ? gdy : 0;

    if (p.buttons[12] && p.buttons[12].pressed) sy = -1;
    if (p.buttons[13] && p.buttons[13].pressed) sy = 1;
    if (p.buttons[14] && p.buttons[14].pressed) sx = -1;
    if (p.buttons[15] && p.buttons[15].pressed) sx = 1;

    totalDx += sx * speed * dt;
    totalDy += sy * speed * dt;

    // Face buttons: Nintendo swaps Confirm (A / button 1) and Cancel (B / button 0)
    const selectBtn = (layout === 'nintendo') ? p.buttons[1] : p.buttons[0];
    const backBtn = (layout === 'nintendo') ? p.buttons[0] : p.buttons[1];
    const docsBtn = p.buttons[2];
    const friendsBtn = p.buttons[3];
    const pauseBtn = p.buttons[9];

    // Select / Confirm
    const selectPressed = !!(selectBtn && (selectBtn.pressed || selectBtn.value > 0.5));
    if (selectPressed) {
      if (!state.select) {
        state.select = true;
        window.triggerSpatialNavClick();
      }
    } else {
      state.select = false;
    }

    // Back / Cancel
    const backPressed = !!(backBtn && (backBtn.pressed || backBtn.value > 0.5));
    if (backPressed) {
      if (!state.back) {
        state.back = true;
        if (typeof handleHandheldBack === 'function') handleHandheldBack();
      }
    } else {
      state.back = false;
    }

    // Docs (X)
    const docsPressed = !!(docsBtn && (docsBtn.pressed || docsBtn.value > 0.5));
    if (docsPressed) {
      if (!state.docs) {
        state.docs = true;
        if (typeof openDocs === 'function') openDocs();
      }
    } else {
      state.docs = false;
    }

    // Friends (Y)
    const friendsPressed = !!(friendsBtn && (friendsBtn.pressed || friendsBtn.value > 0.5));
    if (friendsPressed) {
      if (!state.friends) {
        state.friends = true;
        if (typeof toggleFriendPanel === 'function') toggleFriendPanel();
      }
    } else {
      state.friends = false;
    }

    // Pause / Start (Button 9)
    const pausePressed = !!(pauseBtn && (pauseBtn.pressed || pauseBtn.value > 0.5));
    if (pausePressed) {
      if (!state.start) {
        state.start = true;
        const gpModal = document.getElementById('gpModal');
        if (gpModal && (gpModal.classList.contains('open') || gpModal.style.display === 'flex')) {
          gpModal.classList.remove('open');
          gpModal.style.display = 'none';
        } else {
          let closed = false;
          if (typeof handleHandheldBack === 'function') {
            closed = handleHandheldBack();
          }
          if (!closed && typeof exitNearcadeApp === 'function') {
            exitNearcadeApp();
          }
        }
      }
    } else {
      state.start = false;
    }
  }

  // Hover precision friction (no reverse magnetism so pointer never jumps)
  if (Math.abs(totalDx) > 0.1 || Math.abs(totalDy) > 0.1) {
    const clickables = document.querySelectorAll('button, input, select, a, .nav-btn, .clickable, .more-card');
    let hovered = false;
    for (const el of clickables) {
      if (!el.offsetParent) continue;
      const rect = el.getBoundingClientRect();
      if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
        hovered = true;
        break;
      }
    }
    if (hovered) {
      totalDx *= 0.65;
      totalDy *= 0.65;
    }
  }

  cx += totalDx;
  cy += totalDy;

  cx = Math.max(0, Math.min(window.innerWidth, cx));
  cy = Math.max(0, Math.min(window.innerHeight, cy));

  if (Math.abs(totalDx) > 0.05 || Math.abs(totalDy) > 0.05) {
    if (cursor) {
      cursor.style.display = 'block';
      cursor.style.left = cx + 'px';
      cursor.style.top = cy + 'px';
    }
  }

  requestAnimationFrame(updateGamepad);
}

// Start loop immediately
requestAnimationFrame(updateGamepad);

window.addEventListener('keydown', (e) => {
  if (keys.hasOwnProperty(e.key)) {
    e.preventDefault();
    keys[e.key] = true;
    if (cursor) cursor.style.display = 'block';
  } else if (e.key === 'Enter') {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      const btnConnect = document.getElementById('btnConnect');
      if (btnConnect && typeof btnConnect.click === 'function') {
        btnConnect.click();
      }
      return;
    }
    e.preventDefault();
    window.triggerSpatialNavClick();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (typeof handleHandheldBack === 'function') handleHandheldBack();
  }
});

window.addEventListener('keyup', (e) => {
  if (keys.hasOwnProperty(e.key)) {
    e.preventDefault();
    keys[e.key] = false;
  }
});
