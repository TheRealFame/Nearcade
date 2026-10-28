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

function toggleHandheldMode() {
  const current = document.documentElement.classList.contains('handheld-mode');
  const next = !current;
  localStorage.setItem('ns_handheld_mode', next ? 'true' : 'false');
  if (next) {
    document.documentElement.classList.add('handheld-mode');
    initHandheldStatusBar();
  } else {
    document.documentElement.classList.remove('handheld-mode');
  }
  const track = document.getElementById('settingTrackHandheldMode');
  if (track) track.classList.toggle('on', next);
}

function handleHandheldBack() {
  const openModal = document.querySelector('.modal.open');
  if (openModal) {
    openModal.classList.remove('open');
    return;
  }
  const fPanel = document.getElementById('friendPanel');
  if (fPanel && fPanel.style.transform === 'translateX(0%)') {
    if (typeof closeFriendPanel === 'function') closeFriendPanel();
    return;
  }
  const currentTab = document.querySelector('.panel.active');
  if (currentTab && currentTab.id !== 'panel-connect') {
    if (typeof switchTab === 'function') switchTab('connect');
    return;
  }
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

  if (layout === 'playstation') {
    if (bFriends) { bFriends.textContent = '△'; bFriends.className = 'btn-badge btn-ps-triangle'; }
    if (bDocs) { bDocs.textContent = '□'; bDocs.className = 'btn-badge btn-ps-square'; }
    if (bSelect) { bSelect.textContent = '×'; bSelect.className = 'btn-badge btn-ps-cross'; }
    if (bBack) { bBack.textContent = '○'; bBack.className = 'btn-badge btn-ps-circle'; }
    if (bQuit) { bQuit.textContent = '≡'; bQuit.className = 'btn-badge btn-menu'; }
  } else if (layout === 'nintendo') {
    if (bFriends) { bFriends.textContent = 'X'; bFriends.className = 'btn-badge btn-nin-x'; }
    if (bDocs) { bDocs.textContent = 'Y'; bDocs.className = 'btn-badge btn-nin-y'; }
    if (bSelect) { bSelect.textContent = 'A'; bSelect.className = 'btn-badge btn-nin-a'; }
    if (bBack) { bBack.textContent = 'B'; bBack.className = 'btn-badge btn-nin-b'; }
    if (bQuit) { bQuit.textContent = '+'; bQuit.className = 'btn-badge btn-nin-plus'; }
  } else {
    if (bFriends) { bFriends.textContent = 'Y'; bFriends.className = 'btn-badge btn-y'; }
    if (bDocs) { bDocs.textContent = 'X'; bDocs.className = 'btn-badge btn-x'; }
    if (bSelect) { bSelect.textContent = 'A'; bSelect.className = 'btn-badge btn-a'; }
    if (bBack) { bBack.textContent = 'B'; bBack.className = 'btn-badge btn-b'; }
    if (bQuit) { bQuit.textContent = '≡'; bQuit.className = 'btn-badge btn-menu'; }
  }
}

window.detectGamepadLayout = detectGamepadLayout;
window.updateHandheldPromptGlyphs = updateHandheldPromptGlyphs;
window.triggerHandheldSelect = triggerHandheldSelect;
window.getActiveGamepadLayout = () => currentGamepadLayout;

window.addEventListener('gamepadconnected', (e) => {
  const layout = detectGamepadLayout(e.gamepad);
  updateHandheldPromptGlyphs(layout);
});

window.addEventListener('gamepaddisconnected', () => {
  const layout = detectGamepadLayout();
  updateHandheldPromptGlyphs(layout);
});

