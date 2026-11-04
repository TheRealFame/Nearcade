/**
 * src/scripts/extended/spatial-nav.js
 * Gamepad & TV Remote Virtual Cursor Engine
 */

let cursor = document.getElementById('virtual-cursor');
if (!cursor) {
  cursor = document.createElement('div');
  cursor.id = 'virtual-cursor';
  document.body.appendChild(cursor);
}

if (!document.getElementById('virtual-cursor-style')) {
  const st = document.createElement('style');
  st.id = 'virtual-cursor-style';
  st.textContent = `
    #virtual-cursor {
      position: fixed;
      width: 20px;
      height: 20px;
      background: rgba(var(--accent-rgb, 192, 132, 252), 0.6);
      border: 2px solid var(--text, #fff);
      border-radius: 50%;
      z-index: 9999999;
      pointer-events: none;
      display: none;
      box-shadow: 0 0 15px var(--accent, #c084fc);
      transition: transform 0.1s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #virtual-cursor.clicking {
      transform: scale(0.6);
      background: var(--text, #fff);
    }
    .spatial-hover,
    button.spatial-hover,
    .nav-btn.spatial-hover,
    .clickable.spatial-hover,
    .radio-card.spatial-hover,
    .more-card.spatial-hover,
    .select-picker-item.spatial-hover {
      outline: none !important;
      border-color: var(--accent, #c084fc) !important;
      box-shadow: 0 0 0 2px var(--accent, #c084fc), 0 0 16px rgba(var(--accent-rgb, 192, 132, 252), 0.5) !important;
    }
  `;
  document.head.appendChild(st);
}

let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
let lastTime = performance.now();
let lastGamepadInputTime = 0;
let vx = 0, vy = 0;
const keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };

try {
  window.focus();
  if (document.body) document.body.focus();
} catch (_) {}

function showCursor() {
  if (cursor) {
    cursor.style.display = 'block';
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';
  }
}

let lastInputType = 'mouse';

try {
  localStorage.removeItem('ns_handheld_mode');
  localStorage.removeItem('ns_handheld_session');
} catch (_) {}

const savedLayout = (() => {
  try {
    const raw = localStorage.getItem('ns_layout_mode');
    if (raw) return raw;
    const cfg = JSON.parse(localStorage.getItem('ns_app_config') || '{}');
    return cfg.layoutMode || null;
  } catch (_) { return null; }
})();

const isExplicitDefault = savedLayout === 'default';

if (isExplicitDefault) {
  document.documentElement.classList.remove('handheld-mode');
  try {
    localStorage.removeItem('ns_handheld_mode');
    localStorage.removeItem('ns_handheld_session');
    sessionStorage.removeItem('ns_handheld_session');
  } catch (_) {}
}

// In handheld mode or active handheld session, display virtual cursor immediately
const isHandheldActive = !isExplicitDefault && (
  document.documentElement.classList.contains('handheld-mode') ||
  new URLSearchParams(window.location.search).has('handheld') ||
  (typeof window.electronAPI !== 'undefined' && Boolean(window.electronAPI.isHandheld)) ||
  sessionStorage.getItem('ns_handheld_session') === 'true'
);

if (isHandheldActive) {
  document.documentElement.classList.add('handheld-mode');
  try {
    sessionStorage.setItem('ns_handheld_session', 'true');
  } catch (_) {}
}

if (window.electronAPI && typeof window.electronAPI.getCursorPos === 'function') {
  window.electronAPI.getCursorPos().then(pos => {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      cx = Math.max(0, Math.min(window.innerWidth, pos.x));
      cy = Math.max(0, Math.min(window.innerHeight, pos.y));
      if (lastInputType === 'gamepad') showCursor();
      updateVirtualCursorHover(cx, cy);
    }
  }).catch(() => {});
}

window.addEventListener('gamepadconnected', () => {
  try { window.focus(); } catch (_) {}
});

window.addEventListener('focus', () => {
  if (lastInputType === 'gamepad' && (document.documentElement.classList.contains('handheld-mode') || isHandheldActive)) {
    showCursor();
    updateVirtualCursorHover(cx, cy);
  }
});

let currentHoverTarget = null;

const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[onclick]',
  '[role="button"]',
  '[tabindex]',
  '.nav-btn',
  '.clickable',
  '.more-card',
  '.radio-card',
  '.toggle',
  '.custom-select',
  '.select-picker-item',
  '.chip',
  '.prompt-chip',
  '.sidebar-item',
  '.setting-row',
  '.device-row',
  '.action-btn',
  '.btn',
  '.icon-btn',
  '.tab',
  '.setting-item',
  '.close-modal',
  '.modal-btn',
  '.card-clickable',
  '.lang-switcher'
].join(', ');

function getClickTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === document.body || el === document.documentElement) return null;
  const clickable = el.closest(CLICKABLE_SELECTOR);
  if (clickable) return clickable;
  if (el.closest('.lang-switcher')) return el.closest('.lang-switcher');
  if (typeof el.onclick === 'function' || el.hasAttribute('onclick') || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SELECT' || el.tagName === 'INPUT') {
    return el;
  }
  return null;
}

function updateVirtualCursorHover(x, y) {
  if (lastInputType === 'mouse') {
    if (currentHoverTarget) {
      currentHoverTarget.classList.remove('spatial-hover', 'virtual-hover');
      currentHoverTarget = null;
    }
    return;
  }
  const target = getClickTargetAt(x, y);
  if (target !== currentHoverTarget) {
    if (currentHoverTarget) {
      currentHoverTarget.classList.remove('spatial-hover', 'virtual-hover');
      try {
        currentHoverTarget.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientX: x, clientY: y }));
        currentHoverTarget.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: x, clientY: y }));
      } catch (_) {}
    }
    currentHoverTarget = target;
    if (currentHoverTarget) {
      currentHoverTarget.classList.add('spatial-hover', 'virtual-hover');
      try {
        currentHoverTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
        currentHoverTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      } catch (_) {}
    }
  }
}

window.setVirtualCursorPos = function(x, y) {
  cx = Math.max(0, Math.min(window.innerWidth, x));
  cy = Math.max(0, Math.min(window.innerHeight, y));
  showCursor();
  updateVirtualCursorHover(cx, cy);
  if (window.electronAPI && typeof window.electronAPI.syncCursorPos === 'function') {
    window.electronAPI.syncCursorPos(cx, cy);
  }
};

window.addEventListener('mousemove', (e) => {
  lastInputType = 'mouse';
  // If recent gamepad movement occurred, ignore synthetic mousemove recentering / jitter
  if (performance.now() - lastGamepadInputTime < 350) {
    if (Math.hypot(e.movementX || 0, e.movementY || 0) < 10) return;
  }
  cx = e.clientX;
  cy = e.clientY;
  // Physical mouse moved: hide the virtual gamepad cursor so it does not render on top of the OS mouse
  if (cursor && cursor.style.display !== 'none') {
    cursor.style.display = 'none';
  }
  if (currentHoverTarget) {
    currentHoverTarget.classList.remove('spatial-hover', 'virtual-hover');
    currentHoverTarget = null;
  }
}, { passive: true });

window.addEventListener('touchstart', (e) => {
  lastInputType = 'mouse';
  if (e.touches && e.touches[0]) {
    cx = e.touches[0].clientX;
    cy = e.touches[0].clientY;
    if (cursor && cursor.style.display !== 'none') {
      cursor.style.display = 'none';
    }
    if (currentHoverTarget) {
      currentHoverTarget.classList.remove('spatial-hover', 'virtual-hover');
      currentHoverTarget = null;
    }
  }
}, { passive: true });

window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') {
    lastInputType = 'mouse';
    if (cursor && cursor.style.display !== 'none') {
      cursor.style.display = 'none';
    }
  }
}, { passive: true });

window.addEventListener('click', () => {
  try { window.focus(); } catch (_) {}
}, { passive: true });

// Persistent per-gamepad button states across animation frames
const gpButtonStates = new Map();

const hardwareGamepad = {
  axes: [0, 0, 0, 0, 0, 0, 0, 0],
  buttons: {}
};

function handleHardwareGamepadMessage(d) {
  if (!d) return;
  if (d.type === 'axis') {
    hardwareGamepad.axes[d.num] = d.val;
    if (Math.abs(d.val) > 0.18) {
      lastInputType = 'gamepad';
      showCursor();
    }
  } else if (d.type === 'button') {
    hardwareGamepad.buttons[d.num] = d.pressed;
    if (d.pressed) {
      lastInputType = 'gamepad';
      showCursor();
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'NEARCADE_HARDWARE_GAMEPAD') {
      handleHardwareGamepadMessage(e.data.data);
    }
  });
  if (window.electronAPI && typeof window.electronAPI.onHardwareGamepad === 'function') {
    window.electronAPI.onHardwareGamepad(handleHardwareGamepadMessage);
  }
}

// ── Gamepad Layout & Prompts ────────────────────────────────────────────────
function detectGamepadLayout(gamepad) {
  if (!gamepad && typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p) {
        gamepad = p;
        break;
      }
    }
  }
  const id = (gamepad && gamepad.id ? gamepad.id : '').toLowerCase();
  if (id.includes('playstation') || id.includes('dualshock') || id.includes('dualsense') || id.includes('054c') || id.includes('sony')) {
    return 'playstation';
  }
  if (id.includes('nintendo') || id.includes('joy-con') || id.includes('switch') || id.includes('057e')) {
    return 'nintendo';
  }
  if (id.includes('xbox') || id.includes('x-box') || id.includes('xinput') || id.includes('microsoft') || id.includes('045e') || id.includes('valve') || id.includes('steam')) {
    return 'xbox';
  }
  return 'xbox';
}

function updateHandheldPromptGlyphs(layout) {
  const bFriends = document.getElementById('promptBadgeFriends');
  const bDocs = document.getElementById('promptBadgeDocs');
  const bSelect = document.getElementById('promptBadgeSelect');
  const bBack = document.getElementById('promptBadgeBack');
  const bQuit = document.getElementById('promptBadgeQuit');
  const bGpClose = document.getElementById('gpModalBadgePause');

  if (layout === 'playstation') {
    if (bFriends) { bFriends.textContent = '△'; bFriends.className = 'btn-badge btn-ps-triangle'; }
    if (bDocs) { bDocs.textContent = '□'; bDocs.className = 'btn-badge btn-ps-square'; }
    if (bSelect) { bSelect.textContent = '×'; bSelect.className = 'btn-badge btn-ps-cross'; }
    if (bBack) { bBack.textContent = '○'; bBack.className = 'btn-badge btn-ps-circle'; }
    if (bQuit) { bQuit.textContent = '≡'; bQuit.className = 'btn-badge btn-menu'; }
    if (bGpClose) { bGpClose.textContent = '≡'; bGpClose.className = 'btn-badge btn-menu'; }
  } else if (layout === 'nintendo') {
    if (bFriends) { bFriends.textContent = 'X'; bFriends.className = 'btn-badge btn-nin-x'; }
    if (bDocs) { bDocs.textContent = 'Y'; bDocs.className = 'btn-badge btn-nin-y'; }
    if (bSelect) { bSelect.textContent = 'A'; bSelect.className = 'btn-badge btn-nin-a'; }
    if (bBack) { bBack.textContent = 'B'; bBack.className = 'btn-badge btn-nin-b'; }
    if (bQuit) { bQuit.textContent = '+'; bQuit.className = 'btn-badge btn-nin-plus'; }
    if (bGpClose) { bGpClose.textContent = '+'; bGpClose.className = 'btn-badge btn-nin-plus'; }
  } else {
    if (bFriends) { bFriends.textContent = 'Y'; bFriends.className = 'btn-badge btn-y'; }
    if (bDocs) { bDocs.textContent = 'X'; bDocs.className = 'btn-badge btn-x'; }
    if (bSelect) { bSelect.textContent = 'A'; bSelect.className = 'btn-badge btn-a'; }
    if (bBack) { bBack.textContent = 'B'; bBack.className = 'btn-badge btn-b'; }
    if (bQuit) { bQuit.textContent = '≡'; bQuit.className = 'btn-badge btn-menu'; }
    if (bGpClose) { bGpClose.textContent = '≡'; bGpClose.className = 'btn-badge btn-menu'; }
  }
}

window.detectGamepadLayout = detectGamepadLayout;
window.updateHandheldPromptGlyphs = updateHandheldPromptGlyphs;

// ── Handheld Select Picker Modal ────────────────────────────────────────────
function getOrCreateSelectPickerModal() {
  let modal = document.getElementById('selectPickerModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'selectPickerModal';
    modal.className = 'modal-bg';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;z-index:999999;';
    modal.innerHTML = `
      <div class="modal" style="width:420px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;background:#141416;border:1px solid rgba(255,255,255,0.15);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.8);overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.1);background:#1a1a1f;">
          <h3 id="selectPickerTitle" style="margin:0;font-size:16px;font-weight:700;color:#fff;">Choose Option</h3>
          <button type="button" id="closeSelectPickerBtn" class="close-modal nav-btn clickable" style="background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;">✕</button>
        </div>
        <div id="selectPickerList" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSelectPickerModal();
    });
    const closeBtn = modal.querySelector('#closeSelectPickerBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeSelectPickerModal);
  }
  return modal;
}

function openHandheldSelectModal(selectEl) {
  if (!selectEl || !selectEl.options || selectEl.options.length === 0) return;
  const modal = getOrCreateSelectPickerModal();
  const titleEl = modal.querySelector('#selectPickerTitle');
  const listEl = modal.querySelector('#selectPickerList');

  let title = selectEl.getAttribute('aria-label') || selectEl.title;
  if (!title) {
    if (selectEl.id === 'langSelect' || selectEl.classList.contains('lang-select')) {
      title = 'Language';
    } else {
      const parentRow = selectEl.closest('.setting-row, .form-group, .input-row, label') || selectEl.parentElement;
      if (parentRow) {
        const label = parentRow.querySelector('label, h3, h4, .setting-label, span');
        if (label && label !== selectEl) title = label.textContent.trim();
      }
    }
  }
  if (!title || title === 'langSelect') {
    title = (selectEl.id === 'langSelect') ? 'Language' : (selectEl.id || 'Choose Option');
  }
  if (titleEl) titleEl.textContent = title;

  listEl.innerHTML = '';
  const currentVal = selectEl.value;

  Array.from(selectEl.options).forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'select-picker-item nav-btn clickable';
    const isSelected = opt.value === currentVal || opt.selected;
    if (isSelected) btn.classList.add('selected');
    btn.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 14px 18px;
      background: ${isSelected ? 'rgba(var(--accent-rgb, 192, 132, 252), 0.18)' : '#1e1e1e'};
      border: 1px solid ${isSelected ? 'var(--accent, #c084fc)' : 'var(--border, #333)'};
      border-radius: 10px;
      color: ${isSelected ? '#fff' : '#ccc'};
      font-size: 15px;
      font-weight: ${isSelected ? '700' : '500'};
      text-align: left;
      cursor: pointer;
      transition: all 0.15s ease;
    `;
    btn.innerHTML = `
      <span>${opt.text || opt.value}</span>
      ${isSelected ? '<span style="color:var(--accent, #c084fc);font-weight:bold;font-size:16px;">✓</span>' : ''}
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectEl.value = opt.value;
      selectEl.selectedIndex = idx;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      selectEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof selectEl.onchange === 'function') {
        selectEl.onchange();
      }
      closeSelectPickerModal();
    });

    listEl.appendChild(btn);
  });

  modal.classList.add('open');
  modal.style.display = 'flex';

  requestAnimationFrame(() => {
    const selectedBtn = listEl.querySelector('.select-picker-item.selected') || listEl.querySelector('.select-picker-item');
    if (selectedBtn) {
      const rect = selectedBtn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        if (performance.now() - lastGamepadInputTime < 3000) {
          window.setVirtualCursorPos(rect.left + rect.width / 2, rect.top + rect.height / 2);
        }
      }
    }
  });
}

function closeSelectPickerModal() {
  const modal = document.getElementById('selectPickerModal');
  if (modal && (modal.classList.contains('open') || modal.style.display === 'flex')) {
    modal.classList.remove('open');
    modal.style.display = 'none';
    return true;
  }
  return false;
}

function cycleSelectOption(selectEl, direction) {
  if (!selectEl || !selectEl.options || selectEl.options.length === 0) return;
  let idx = selectEl.selectedIndex;
  if (direction > 0) {
    idx = (idx + 1) % selectEl.options.length;
  } else {
    idx = (idx - 1 + selectEl.options.length) % selectEl.options.length;
  }
  selectEl.selectedIndex = idx;
  selectEl.value = selectEl.options[idx].value;
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  selectEl.dispatchEvent(new Event('input', { bubbles: true }));
  if (typeof selectEl.onchange === 'function') {
    selectEl.onchange();
  }
}

window.openHandheldSelectModal = openHandheldSelectModal;
window.closeSelectPickerModal = closeSelectPickerModal;
window.cycleSelectOption = cycleSelectOption;

window.triggerSpatialNavClick = function() {
  showCursor();
  if (cursor) {
    cursor.classList.add('clicking');
    setTimeout(() => { if (cursor) cursor.classList.remove('clicking'); }, 150);
  }

  const target = getClickTargetAt(cx, cy);
  if (!target) return;

  const sel = (target.tagName === 'SELECT')
    ? target
    : (target.closest('select') || (target.closest('.lang-switcher') ? target.closest('.lang-switcher').querySelector('select') : null) || (target.querySelector ? target.querySelector('select') : null));
  if (sel) {
    openHandheldSelectModal(sel);
    return;
  }

  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    target.focus();
  }

  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
  try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
  try { target.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
  if (typeof target.click === 'function') {
    target.click();
  } else {
    try { target.dispatchEvent(new MouseEvent('click', opts)); } catch (_) {}
  }
};

// Intercept clicks and pointerdown on native select elements and language switchers in handheld mode / Gamescope
function interceptSelectActivation(e) {
  // If user clicked with a physical mouse or is on desktop, do not intercept with the handheld modal
  if (lastInputType === 'mouse' || e.pointerType === 'mouse') {
    return;
  }
  if (!document.documentElement.classList.contains('handheld-mode') && !window.location.search.includes('handheld=1')) {
    return;
  }

  const isHandheldActive = document.documentElement.classList.contains('handheld-mode') ||
    (typeof window.electronAPI !== 'undefined' && Boolean(window.electronAPI.isHandheld)) ||
    window.location.search.includes('handheld=1') ||
    sessionStorage.getItem('ns_handheld_session') === 'true';

  if (!isHandheldActive) return;

  const switcher = e.target.closest('.lang-switcher');
  const sel = switcher ? (switcher.querySelector('select') || document.getElementById('langSelect')) : e.target.closest('select');
  if (sel) {
    e.preventDefault();
    e.stopPropagation();
    openHandheldSelectModal(sel);
  }
}

document.addEventListener('pointerdown', interceptSelectActivation, true);
document.addEventListener('click', interceptSelectActivation, true);

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

  let activeSx = 0, activeSy = 0;
  let hasGamepadActivity = false;

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let foundPad = false;
  for (const p of pads) {
    if (!p) continue;
    foundPad = true;

    const layout = detectGamepadLayout(p);
    if (window._lastNavLayout !== layout) {
      window._lastNavLayout = layout;
      updateHandheldPromptGlyphs(layout);
    }

    let state = gpButtonStates.get(p.index);
    if (!state) {
      state = { select: false, back: false, docs: false, friends: false, start: false, dpadLR: false };
      gpButtonStates.set(p.index, state);
    }

    // Read Thumbsticks: Left Stick (axes 0 & 1) and Right Stick / Trackpad (axes 2 & 3)
    const deadzone = 0.18;
    const lx = p.axes[0] || 0;
    const ly = p.axes[1] || 0;
    const rx = (p.axes.length >= 4) ? (p.axes[2] || 0) : 0;
    const ry = (p.axes.length >= 4) ? (p.axes[3] || 0) : 0;

    let sx = Math.abs(lx) > deadzone ? lx : 0;
    let sy = Math.abs(ly) > deadzone ? ly : 0;

    // If left stick is idle, fall back to right stick / trackpad
    if (Math.abs(sx) === 0 && Math.abs(sy) === 0) {
      if (Math.abs(rx) > deadzone) sx = rx;
      if (Math.abs(ry) > deadzone) sy = ry;
    }

    if (p.buttons[12] && (p.buttons[12].pressed || p.buttons[12].value > 0.5)) sy = -1;
    if (p.buttons[13] && (p.buttons[13].pressed || p.buttons[13].value > 0.5)) sy = 1;
    if (p.buttons[14] && (p.buttons[14].pressed || p.buttons[14].value > 0.5)) sx = -1;
    if (p.buttons[15] && (p.buttons[15].pressed || p.buttons[15].value > 0.5)) sx = 1;

    // Linux evdev/xpad D-Pad axes fallback (axes 6 & 7)
    if (p.axes.length >= 8) {
      const dpx = p.axes[6] || 0;
      const dpy = p.axes[7] || 0;
      if (Math.abs(dpx) > 0.5 && Math.abs(sx) === 0) sx = Math.sign(dpx);
      if (Math.abs(dpy) > 0.5 && Math.abs(sy) === 0) sy = Math.sign(dpy);
    }

    // Pick maximum stick deflection across controllers without summing drift
    if (Math.hypot(sx, sy) > Math.hypot(activeSx, activeSy)) {
      activeSx = sx;
      activeSy = sy;
    }

    // D-Pad Left / Right option cycling when on a select element
    const dpadLeft = !!(p.buttons[14] && (p.buttons[14].pressed || p.buttons[14].value > 0.5));
    const dpadRight = !!(p.buttons[15] && (p.buttons[15].pressed || p.buttons[15].value > 0.5));

    if (dpadLeft || dpadRight) {
      const hoverEl = getClickTargetAt(cx, cy);
      const selTarget = (hoverEl && (hoverEl.tagName === 'SELECT' || hoverEl.closest('select'))) ? (hoverEl.tagName === 'SELECT' ? hoverEl : hoverEl.closest('select')) : (document.activeElement && document.activeElement.tagName === 'SELECT' ? document.activeElement : null);
      if (selTarget && !state.dpadLR) {
        state.dpadLR = true;
        cycleSelectOption(selTarget, dpadRight ? 1 : -1);
      }
    } else {
      state.dpadLR = false;
    }

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
        if (closeSelectPickerModal()) {
          // Handled closing select picker
        } else if (typeof handleHandheldBack === 'function') {
          handleHandheldBack();
        }
      }
    } else {
      state.back = false;
    }

    // Docs / Settings (X)
    const docsPressed = !!(docsBtn && (docsBtn.pressed || docsBtn.value > 0.5));
    if (docsPressed) {
      if (!state.docs) {
        state.docs = true;
        if (typeof handleHandheldX === 'function') handleHandheldX();
        else if (typeof openDocs === 'function') openDocs();
      }
    } else {
      state.docs = false;
    }

    // Friends / Viewers (Y)
    const friendsPressed = !!(friendsBtn && (friendsBtn.pressed || friendsBtn.value > 0.5));
    if (friendsPressed) {
      if (!state.friends) {
        state.friends = true;
        if (typeof handleHandheldY === 'function') handleHandheldY();
        else if (typeof toggleFriendPanel === 'function') toggleFriendPanel();
      }
    } else {
      state.friends = false;
    }

    // Pause / Start (Button 9)
    const pausePressed = !!(pauseBtn && (pauseBtn.pressed || pauseBtn.value > 0.5));
    if (pausePressed) {
      if (!state.start) {
        state.start = true;
        if (closeSelectPickerModal()) {
          // Closed select picker modal
        } else {
          const gpModal = document.getElementById('gpModal');
          if (gpModal && (gpModal.classList.contains('open') || gpModal.style.display === 'flex')) {
            gpModal.classList.remove('open');
            gpModal.style.display = '';
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
      }
    } else {
      state.start = false;
    }

    if (Math.abs(sx) > 0 || Math.abs(sy) > 0 || selectPressed || backPressed || docsPressed || friendsPressed || pausePressed) {
      hasGamepadActivity = true;
    }
  }

  // Direct Linux hardware joystick bridge fallback when Web Gamepad API has no pads (e.g. Steam Deck gesture requirement)
  if (!foundPad) {
    const hwAxes = hardwareGamepad.axes;
    const hwButtons = hardwareGamepad.buttons;

    const layout = 'xbox';
    if (window._lastNavLayout !== layout) {
      window._lastNavLayout = layout;
      updateHandheldPromptGlyphs(layout);
    }

    let state = gpButtonStates.get('hardware');
    if (!state) {
      state = { select: false, back: false, docs: false, friends: false, start: false, dpadLR: false };
      gpButtonStates.set('hardware', state);
    }

    const deadzone = 0.18;
    const lx = hwAxes[0] || 0;
    const ly = hwAxes[1] || 0;
    const rx = hwAxes[3] || 0;
    const ry = hwAxes[4] || 0;

    let sx = Math.abs(lx) > deadzone ? lx : 0;
    let sy = Math.abs(ly) > deadzone ? ly : 0;

    if (Math.abs(sx) === 0 && Math.abs(sy) === 0) {
      if (Math.abs(rx) > deadzone) sx = rx;
      if (Math.abs(ry) > deadzone) sy = ry;
    }

    // D-Pad (axes 6 & 7)
    const dpx = hwAxes[6] || 0;
    const dpy = hwAxes[7] || 0;
    if (Math.abs(dpx) > 0.5 && Math.abs(sx) === 0) sx = Math.sign(dpx);
    if (Math.abs(dpy) > 0.5 && Math.abs(sy) === 0) sy = Math.sign(dpy);

    activeSx = sx;
    activeSy = sy;

    // D-Pad Left / Right option cycling when on a select element
    const dpadLeft = dpx < -0.5;
    const dpadRight = dpx > 0.5;

    if (dpadLeft || dpadRight) {
      const hoverEl = getClickTargetAt(cx, cy);
      const selTarget = (hoverEl && (hoverEl.tagName === 'SELECT' || hoverEl.closest('select'))) ? (hoverEl.tagName === 'SELECT' ? hoverEl : hoverEl.closest('select')) : (document.activeElement && document.activeElement.tagName === 'SELECT' ? document.activeElement : null);
      if (selTarget && !state.dpadLR) {
        state.dpadLR = true;
        cycleSelectOption(selTarget, dpadRight ? 1 : -1);
      }
    } else {
      state.dpadLR = false;
    }

    const selectPressed = !!hwButtons[0]; // A
    const backPressed = !!hwButtons[1];   // B
    const docsPressed = !!hwButtons[2];   // X
    const friendsPressed = !!hwButtons[3];// Y
    const pausePressed = !!hwButtons[7];  // Start/Menu

    if (selectPressed) {
      if (!state.select) {
        state.select = true;
        window.triggerSpatialNavClick();
      }
    } else {
      state.select = false;
    }

    if (backPressed) {
      if (!state.back) {
        state.back = true;
        if (closeSelectPickerModal()) {
        } else if (typeof handleHandheldBack === 'function') {
          handleHandheldBack();
        }
      }
    } else {
      state.back = false;
    }

    if (docsPressed) {
      if (!state.docs) {
        state.docs = true;
        if (typeof handleHandheldX === 'function') handleHandheldX();
        else if (typeof openDocs === 'function') openDocs();
      }
    } else {
      state.docs = false;
    }

    if (friendsPressed) {
      if (!state.friends) {
        state.friends = true;
        if (typeof handleHandheldY === 'function') handleHandheldY();
        else if (typeof toggleFriendPanel === 'function') toggleFriendPanel();
      }
    } else {
      state.friends = false;
    }

    if (pausePressed) {
      if (!state.start) {
        state.start = true;
        if (closeSelectPickerModal()) {
        } else {
          const gpModal = document.getElementById('gpModal');
          if (gpModal && (gpModal.classList.contains('open') || gpModal.style.display === 'flex')) {
            gpModal.classList.remove('open');
            gpModal.style.display = '';
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
      }
    } else {
      state.start = false;
    }

    if (Math.abs(sx) > 0 || Math.abs(sy) > 0 || selectPressed || backPressed || docsPressed || friendsPressed || pausePressed) {
      hasGamepadActivity = true;
    }
  }

  if (hasGamepadActivity) {
    lastGamepadInputTime = performance.now();
    showCursor();
  }

  totalDx += activeSx * 900 * dt;
  totalDy += activeSy * 900 * dt;

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

  updateVirtualCursorHover(cx, cy);

  if (Math.abs(totalDx) > 0.05 || Math.abs(totalDy) > 0.05) {
    showCursor();
    if (window.electronAPI && typeof window.electronAPI.syncCursorPos === 'function') {
      window.electronAPI.syncCursorPos(cx, cy);
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
    if (closeSelectPickerModal()) {
      return;
    }
    if (typeof handleHandheldBack === 'function') handleHandheldBack();
  }
});

window.addEventListener('keyup', (e) => {
  if (keys.hasOwnProperty(e.key)) {
    e.preventDefault();
    keys[e.key] = false;
  }
});
