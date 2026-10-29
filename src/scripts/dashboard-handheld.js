// ── Handheld & TV Console Mode Module ─────────────────────────────────
let handheldBarInitialized = false;

function initHandheldStatusBar() {
  const clockEl = document.getElementById('handheldClockText');
  const batteryFill = document.getElementById('handheldBatteryFill');
  const batteryText = document.getElementById('handheldBatteryText');
  const batteryBolt = document.getElementById('handheldBatteryBolt');
  const batteryContainer = document.getElementById('handheldBattery');
  const acIcon = document.getElementById('handheldAcIcon');
  const wifiContainer = document.getElementById('handheldWifi');
  const wifiBars = document.getElementById('handheldWifiBars');
  const ethernetIcon = document.getElementById('handheldEthernetIcon');

  function updateClock() {
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
  }
  updateClock();

  function updateNetworkDisplay(type, quality) {
    if (type === 'ethernet') {
      if (ethernetIcon) ethernetIcon.classList.remove('gone');
      if (wifiBars) wifiBars.classList.add('gone');
      if (wifiContainer) wifiContainer.title = 'Ethernet (Wired Connection)';
    } else {
      if (ethernetIcon) ethernetIcon.classList.add('gone');
      if (wifiBars) {
        wifiBars.classList.remove('gone');
        wifiBars.className = 'wifi-bars q-' + (quality !== undefined ? quality : 4);
      }
      if (wifiContainer) wifiContainer.title = 'Wi-Fi Connection';
    }
  }

  function updateBatteryDisplay(bat) {
    if (!batteryContainer) return;
    batteryContainer.style.display = 'flex';

    const hasBattery = bat && bat.hasBattery !== false && (bat.hasBattery || (typeof bat.level === 'number' && bat.level > 0));
    const acConnected = bat && (bat.acConnected || bat.charging || bat.isCharging);

    if (!hasBattery || (!hasBattery && acConnected)) {
      // Wall/AC power connected (desktop PC or docked handheld with no internal battery reading)
      if (acIcon) acIcon.classList.remove('gone');
      if (batteryBolt) batteryBolt.classList.add('gone');
      if (batteryFill) batteryFill.style.width = '100%';
      if (batteryText) batteryText.textContent = 'AC';
      batteryContainer.classList.remove('lvl-yellow', 'lvl-red');
      batteryContainer.classList.add('lvl-green');
      batteryContainer.title = 'AC Power Connected';
      return;
    }

    // Battery present
    const pct = Math.round(
      typeof bat.percent === 'number' ? bat.percent :
      (typeof bat.level === 'number' ? bat.level * 100 : 100)
    );
    const isCharging = !!(bat.isCharging || bat.charging);

    if (acIcon) {
      if (acConnected && pct >= 99) acIcon.classList.remove('gone');
      else acIcon.classList.add('gone');
    }

    if (batteryText) batteryText.textContent = pct + '%';
    if (batteryFill) batteryFill.style.width = Math.max(4, pct) + '%';
    if (batteryBolt) {
      if (isCharging) batteryBolt.classList.remove('gone');
      else batteryBolt.classList.add('gone');
    }

    batteryContainer.classList.remove('lvl-green', 'lvl-yellow', 'lvl-red');
    if (pct <= 15) batteryContainer.classList.add('lvl-red');
    else if (pct <= 30) batteryContainer.classList.add('lvl-yellow');
    else batteryContainer.classList.add('lvl-green');
    batteryContainer.title = isCharging ? ('Charging (' + pct + '%)') : ('Battery: ' + pct + '%');
  }

  function checkLocalNetwork() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.type === 'ethernet') {
      updateNetworkDisplay('ethernet');
      return;
    }
    let quality = 4;
    if (conn) {
      const rtt = conn.rtt || 30;
      const down = conn.downlink || 10;
      const eff = conn.effectiveType;
      if (eff === 'slow-2g' || eff === '2g' || rtt > 150 || down < 1.5) {
        quality = 1;
      } else if (eff === '3g' || rtt > 90 || down < 5) {
        quality = 2;
      } else if (rtt > 50 || down < 10) {
        quality = 3;
      } else {
        quality = 4;
      }
    }
    updateNetworkDisplay('wifi', quality);
  }

  function handleStatusPayload(data) {
    if (!data) return;
    if (data.network) {
      if (data.network.type === 'ethernet') {
        updateNetworkDisplay('ethernet');
      } else if (data.network.type === 'wifi') {
        updateNetworkDisplay('wifi');
      }
    }
    if (data.battery) {
      updateBatteryDisplay(data.battery);
    }
  }

  async function queryDeviceStatus() {
    try {
      if (window.electronAPI && typeof window.electronAPI.getDeviceStatus === 'function') {
        const data = await window.electronAPI.getDeviceStatus();
        if (data) handleStatusPayload(data);
        return;
      }
      const res = await fetch('/api/device-status');
      if (res.ok) {
        const data = await res.json();
        if (data) handleStatusPayload(data);
      }
    } catch (_) {}
  }

  checkLocalNetwork();
  queryDeviceStatus();

  if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    navigator.getBattery().then(battery => {
      function onBatteryChange() {
        updateBatteryDisplay({
          hasBattery: true,
          charging: battery.charging,
          level: battery.level
        });
      }
      onBatteryChange();
      if (!handheldBarInitialized) {
        battery.addEventListener('levelchange', onBatteryChange);
        battery.addEventListener('chargingchange', onBatteryChange);
      }
    }).catch(() => {
      updateBatteryDisplay({ hasBattery: false, acConnected: true });
    });
  } else {
    updateBatteryDisplay({ hasBattery: false, acConnected: true });
  }

  if (!handheldBarInitialized) {
    setInterval(updateClock, 15000);
    setInterval(queryDeviceStatus, 10000);

    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      conn.addEventListener('change', () => {
        checkLocalNetwork();
        queryDeviceStatus();
      });
    }

    window.addEventListener('online', () => {
      checkLocalNetwork();
      queryDeviceStatus();
    });
    window.addEventListener('offline', () => {
      updateNetworkDisplay('wifi', 0);
    });
  }

  handheldBarInitialized = true;
}

function applyLayoutMode(mode) {
  const root = document.documentElement;
  if (mode === 'handheld') {
    try {
      localStorage.setItem('ns_handheld_mode', 'true');
      localStorage.setItem('ns_handheld_session', 'true');
      sessionStorage.setItem('ns_handheld_session', 'true');
    } catch (_) {}
    root.classList.add('handheld-mode');
    root.classList.remove('portrait-mode');
    initHandheldStatusBar();
  } else if (mode === 'portrait') {
    try { sessionStorage.removeItem('ns_handheld_session'); } catch (_) {}
    root.classList.add('portrait-mode');
    root.classList.remove('handheld-mode');
  } else {
    try {
      localStorage.removeItem('ns_handheld_mode');
      sessionStorage.removeItem('ns_handheld_session');
    } catch (_) {}
    root.classList.remove('handheld-mode', 'portrait-mode');
  }
}

function detectDeviceLayout() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('handheld') || params.has('tv')) {
    try {
      localStorage.setItem('ns_handheld_mode', 'true');
      sessionStorage.setItem('ns_handheld_session', 'true');
    } catch (_) {}
    return 'handheld';
  }
  if (params.has('portrait')) {
    return 'portrait';
  }

  // Check Electron API flags
  if (typeof window !== 'undefined' && window.electronAPI) {
    if (window.electronAPI.isHandheld) {
      try {
        localStorage.setItem('ns_handheld_mode', 'true');
        sessionStorage.setItem('ns_handheld_session', 'true');
      } catch (_) {}
      return 'handheld';
    }
    if (window.electronAPI.isPortrait) {
      return 'portrait';
    }
  }

  // Retain active handheld session
  try {
    if (localStorage.getItem('ns_handheld_mode') === 'true' ||
        localStorage.getItem('ns_handheld_session') === 'true' ||
        sessionStorage.getItem('ns_handheld_session') === 'true') {
      return 'handheld';
    }
  } catch (_) {}

  if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected) {
        try { sessionStorage.setItem('ns_handheld_session', 'true'); } catch (_) {}
        return 'handheld';
      }
    }
  }

  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
  if (ua.includes('steam deck') || ua.includes('valve') || ua.includes('smart-tv') || ua.includes('googletv') || ua.includes('crkey') || ua.includes('firetv') || ua.includes('tizen') || ua.includes('webos')) {
    try { sessionStorage.setItem('ns_handheld_session', 'true'); } catch (_) {}
    return 'handheld';
  }

  const isPortraitScreen = window.innerWidth < window.innerHeight || (window.matchMedia && window.matchMedia('(orientation: portrait)').matches);
  const isMobileOrTablet = /android|iphone|ipad|ipod|mobile|tablet|fold/i.test(ua) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints && navigator.maxTouchPoints > 1 && window.innerWidth <= 1024);

  if (isPortraitScreen && (isMobileOrTablet || window.innerWidth <= 768)) {
    return 'portrait';
  }

  return 'default';
}

function changeLayoutMode(mode) {
  localStorage.setItem('ns_layout_mode', mode);
  const select = document.getElementById('settingSelectLayoutMode');
  if (select && select.value !== mode) select.value = mode;

  if (mode === 'auto') {
    const detected = detectDeviceLayout();
    applyLayoutMode(detected);
  } else {
    applyLayoutMode(mode);
  }
}

function initLayoutMode() {
  let saved = localStorage.getItem('ns_layout_mode');
  if (!saved) {
    let sessionIsHandheld = false;
    try { sessionIsHandheld = sessionStorage.getItem('ns_handheld_session') === 'true'; } catch (_) {}
    if (localStorage.getItem('ns_handheld_mode') === 'true' || sessionIsHandheld) {
      saved = 'handheld';
    } else {
      saved = 'auto';
    }
  }

  const select = document.getElementById('settingSelectLayoutMode');
  if (select) select.value = saved;

  if (saved === 'auto') {
    const detected = detectDeviceLayout();
    applyLayoutMode(detected);
  } else {
    applyLayoutMode(saved);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('gamepadconnected', () => {
      const currentSaved = localStorage.getItem('ns_layout_mode');
      if (currentSaved === 'auto' || !currentSaved) {
        applyLayoutMode('handheld');
      }
    });
  }
}

function toggleHandheldMode() {
  const current = document.documentElement.classList.contains('handheld-mode');
  const nextMode = current ? 'default' : 'handheld';
  changeLayoutMode(nextMode);
}

function getOrCreateSelectPickerModal() {
  let modal = document.getElementById('selectPickerModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'selectPickerModal';
    modal.className = 'modal-bg';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:none;align-items:center;justify-content:center;z-index:999999;backdrop-filter:blur(6px);';
    modal.innerHTML = `
      <div class="modal-content select-picker-content" style="background:var(--surface,#141414);border:1px solid var(--border,#333);border-radius:14px;width:90%;max-width:480px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,0.8);overflow:hidden;">
        <div style="padding:16px 20px;background:#0d0d0d;border-bottom:1px solid var(--border,#262626);display:flex;align-items:center;justify-content:space-between;">
          <span id="selectPickerTitle" style="font-weight:700;font-size:16px;color:var(--text,#fff);letter-spacing:0.02em;">Select Option</span>
          <button type="button" class="close-modal" id="closeSelectPickerBtn" style="background:transparent;border:none;color:var(--muted,#888);font-size:20px;cursor:pointer;padding:4px 8px;">✕</button>
        </div>
        <div id="selectPickerList" style="padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;max-height:calc(80vh - 70px);"></div>
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
    const parentRow = selectEl.closest('.setting-row, .form-group, .input-row, label') || selectEl.parentElement;
    if (parentRow) {
      const label = parentRow.querySelector('label, h3, h4, .setting-label, span');
      if (label && label !== selectEl) title = label.textContent.trim();
    }
  }
  if (!title) {
    title = selectEl.id || 'Select Option';
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
      if (rect.width > 0 && rect.height > 0 && typeof window.setVirtualCursorPos === 'function') {
        window.setVirtualCursorPos(rect.left + rect.width / 2, rect.top + rect.height / 2);
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

function closeActivePopupOrModal() {
  if (closeSelectPickerModal()) {
    return true;
  }
  const gpModal = document.getElementById('gpModal');
  if (gpModal && (gpModal.classList.contains('open') || gpModal.style.display === 'flex')) {
    gpModal.classList.remove('open');
    gpModal.style.display = '';
    return true;
  }
  const docsModal = document.getElementById('docsModal');
  if (docsModal && docsModal.style.display !== 'none' && docsModal.style.display !== '') {
    if (typeof closeDocs === 'function') closeDocs();
    else docsModal.style.display = 'none';
    return true;
  }
  const aboutModal = document.getElementById('aboutModal');
  if (aboutModal && aboutModal.style.display !== 'none' && aboutModal.style.display !== '') {
    if (typeof closeAbout === 'function') closeAbout();
    else aboutModal.style.display = 'none';
    return true;
  }
  const mobileAuthModal = document.getElementById('mobileAuthModal');
  if (mobileAuthModal && (mobileAuthModal.classList.contains('open') || !mobileAuthModal.classList.contains('gone'))) {
    mobileAuthModal.classList.add('gone');
    mobileAuthModal.classList.remove('open');
    return true;
  }
  const mobileLinkModal = document.getElementById('mobileLinkModal');
  if (mobileLinkModal && (mobileLinkModal.classList.contains('open') || !mobileLinkModal.classList.contains('gone'))) {
    mobileLinkModal.classList.add('gone');
    mobileLinkModal.classList.remove('open');
    return true;
  }
  const wivrnModal = document.getElementById('wivrnModal');
  if (wivrnModal && (wivrnModal.classList.contains('open') || !wivrnModal.classList.contains('gone'))) {
    wivrnModal.classList.add('gone');
    wivrnModal.classList.remove('open');
    return true;
  }
  const updateModal = document.getElementById('updateModal');
  if (updateModal && (updateModal.classList.contains('open') || (updateModal.style.display !== 'none' && updateModal.style.display !== ''))) {
    updateModal.classList.remove('open');
    updateModal.style.display = 'none';
    return true;
  }
  const openModals = document.querySelectorAll('.modal-bg.open, .modal.open, .modal-bg:not(.gone):not([style*="display: none"])');
  for (const m of openModals) {
    if (m.id === 'handheldPromptBar') continue;
    m.classList.remove('open');
    m.classList.add('gone');
    m.style.display = 'none';
    return true;
  }
  const fPanel = document.getElementById('friendPanel');
  if (fPanel && (fPanel.style.transform === 'translateX(0%)' || fPanel.style.transform === 'translateX(0px)')) {
    if (typeof closeFriendPanel === 'function') closeFriendPanel();
    return true;
  }
  return false;
}

function handleHandheldBack() {
  if (closeActivePopupOrModal()) {
    return true;
  }
  const currentTab = document.querySelector('.panel.active');
  if (currentTab && currentTab.id !== 'panel-connect') {
    if (typeof switchTab === 'function') switchTab('connect');
    return true;
  }
  return false;
}

function triggerHandheldSelect() {
  if (typeof window.triggerSpatialNavClick === 'function') {
    window.triggerSpatialNavClick();
    return;
  }
  const active = document.activeElement;
  if (active && typeof active.click === 'function') {
    active.click();
  }
}

let currentGamepadLayout = 'xbox';

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
  currentGamepadLayout = layout || 'xbox';
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

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'NEARCADE_CLOSE_GP_MODAL') {
    const gpModal = document.getElementById('gpModal');
    if (gpModal) {
      gpModal.classList.remove('open');
      gpModal.style.display = 'none';
    }
  }
});

window.detectGamepadLayout = detectGamepadLayout;
window.updateHandheldPromptGlyphs = updateHandheldPromptGlyphs;
window.triggerHandheldSelect = triggerHandheldSelect;
window.getActiveGamepadLayout = () => currentGamepadLayout;
window.applyLayoutMode = applyLayoutMode;
window.detectDeviceLayout = detectDeviceLayout;
window.changeLayoutMode = changeLayoutMode;
window.initLayoutMode = initLayoutMode;
window.openHandheldSelectModal = openHandheldSelectModal;
window.closeSelectPickerModal = closeSelectPickerModal;
window.cycleSelectOption = cycleSelectOption;

window.addEventListener('gamepadconnected', (e) => {
  const layout = detectGamepadLayout(e.gamepad);
  updateHandheldPromptGlyphs(layout);
  const saved = localStorage.getItem('ns_layout_mode') || 'auto';
  if (saved === 'auto') {
    applyLayoutMode('handheld');
  }
});

window.addEventListener('gamepaddisconnected', () => {
  const layout = detectGamepadLayout();
  updateHandheldPromptGlyphs(layout);
  const saved = localStorage.getItem('ns_layout_mode') || 'auto';
  if (saved === 'auto') {
    const detected = detectDeviceLayout();
    applyLayoutMode(detected);
  }
});

window.addEventListener('resize', () => {
  const saved = localStorage.getItem('ns_layout_mode') || 'auto';
  if (saved === 'auto') {
    let sessionIsHandheld = false;
    try { sessionIsHandheld = sessionStorage.getItem('ns_handheld_session') === 'true'; } catch (_) {}
    if (sessionIsHandheld) {
      applyLayoutMode('handheld');
      return;
    }
    const detected = detectDeviceLayout();
    applyLayoutMode(detected);
  }
});


