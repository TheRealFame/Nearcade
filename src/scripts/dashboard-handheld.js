// ── Handheld & TV Console Mode Module ─────────────────────────────────
let handheldBarInitialized = false;

function initHandheldStatusBar() {
  const clockEl = document.getElementById('handheldClockText');
  const batteryFill = document.getElementById('handheldBatteryFill');
  const batteryText = document.getElementById('handheldBatteryText');
  const batteryBolt = document.getElementById('handheldBatteryBolt');
  const batteryContainer = document.getElementById('handheldBattery');
  const wifiBars = document.getElementById('handheldWifiBars');

  function updateClock() {
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
  }
  updateClock();

  if (!handheldBarInitialized) {
    setInterval(updateClock, 15000);
  }

  if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    navigator.getBattery().then(battery => {
      function updateBattery() {
        const pct = Math.round(battery.level * 100);
        if (batteryText) batteryText.textContent = pct + '%';
        if (batteryFill) batteryFill.style.width = Math.max(4, pct) + '%';
        if (batteryBolt) {
          if (battery.charging) batteryBolt.classList.remove('gone');
          else batteryBolt.classList.add('gone');
        }
        if (batteryContainer) {
          batteryContainer.classList.remove('lvl-green', 'lvl-yellow', 'lvl-red');
          if (pct <= 15) batteryContainer.classList.add('lvl-red');
          else if (pct <= 30) batteryContainer.classList.add('lvl-yellow');
          else batteryContainer.classList.add('lvl-green');
        }
      }
      updateBattery();
      if (!handheldBarInitialized) {
        battery.addEventListener('levelchange', updateBattery);
        battery.addEventListener('chargingchange', updateBattery);
      }
    }).catch(() => {
      if (batteryContainer) batteryContainer.style.display = 'none';
    });
  } else {
    if (batteryContainer) batteryContainer.style.display = 'none';
  }

  function updateNetwork() {
    if (!wifiBars) return;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
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
    wifiBars.className = 'wifi-bars q-' + quality;
  }
  updateNetwork();
  if (!handheldBarInitialized) {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      conn.addEventListener('change', updateNetwork);
    }
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
