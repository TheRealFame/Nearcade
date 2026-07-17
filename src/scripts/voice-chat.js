// ── VOICE CHAT OVERLAY ──────────────────────────────────────────────
(function initVoiceChat() {
  const VC_KEY = 'ns_vc_tab_pos';
  let vcConnected = true;
  let vcUsers = [];

  // Mic icon URLs
  const MIC_ON = '/assets/icons/mic.svg';
  const MIC_OFF = '/assets/icons/mic-off.svg';

  window.vcUpdateSelf = function (name, color, avatar) {
    if (vcUsers[0]) {
      if (name !== undefined) vcUsers[0].name = name;
      if (color !== undefined) vcUsers[0].bg = color;
      if (avatar !== undefined) vcUsers[0].avatar = avatar;
      vcRender();
    }
  };

  let _lastRenderHtml = '';
  function vcRender() {
    if (document.activeElement && document.activeElement.classList.contains('vc-vol-slider')) {
      return;
    }
    const wrap = document.getElementById('vcListWrap');
    if (!wrap) return;
    if (!vcConnected) {
      const html = `
        <div class="vc-disconnected" style="padding:20px;text-align:center;font-size:10px;color:var(--muted)">
          <p>Disconnected from voice.<br>Click to reconnect.</p>
          <button style="margin-top:6px;padding:4px 12px;border-radius:4px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:9px;" onclick="vcReconnect()">Reconnect</button>
        </div>`;
      if (wrap.innerHTML !== html) wrap.innerHTML = html;
      document.getElementById('vcMini')?.classList.remove('show');
      return;
    }
    let html = '';
    if (vcUsers.length === 0) {
      html = '<div style="padding:10px;text-align:center;font-size:8px;color:var(--muted)">No one talking</div>';
    } else {
      html = '<div class="vc-list">';
      vcUsers.forEach((u, i) => {
        const talking = u.talking;
        const muted = u.serverMuted;
        const isSelf = u.isMe;
        const btnCls = 'vc-mute-btn' + (muted ? ' muted' : '');
        const micImg = muted ? MIC_OFF : MIC_ON;
        const safe = (u.name || '').replace(/</g, '&lt;');
        const nameHtml = u.isHost
          ? safe + ' <span style="font-size:7px;opacity:.5">(Host)</span>'
          : safe;
        const style = 'color:' + u.bg + ';';
        html += `<div class="vc-user${talking ? ' talking' : ''}${muted ? ' muted' : ''}">
          <div class="vc-av" style="background:${u.bg};">
            ${u.avatar ? `<img src="/assets/avatars/avatar-${u.avatar}.svg" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : u.name[0]}
            <span class="vc-ring" style="border-color:${u.bg}"></span>
          </div>
          <div class="vc-info">
            <div class="vc-name" style="${style}">${nameHtml}</div>
            <div class="vc-vol-wrap">
              <input type="range" class="vc-vol-slider" min="0" max="100" value="${u.vol}" oninput="vcSetVol(${i},this.value,this)">
              <span class="vc-vol-pct">${u.vol}%</span>
            </div>
          </div>
          <button class="${btnCls}" onclick="event.stopPropagation();vcToggleMute(${i})"><img src="${micImg}" alt="Mute"></button>
        </div>`;
      });
      html += '</div>';
      const talkers = vcUsers.filter(u => u.talking);
      const firstTalker = talkers.length > 0 ? talkers[0] : null;
      const panelOpen = document.getElementById('vcPanel')?.classList.contains('open');
      if (!panelOpen && firstTalker) { vcShowMini(firstTalker); }
      else { document.getElementById('vcMini')?.classList.remove('show'); }
    }

    vcSyncMic();
    if (wrap.innerHTML !== html) wrap.innerHTML = html;
  }

  function vcShowMini(u) {
    const el = document.getElementById('vcMini');
    const av = document.getElementById('vcMiniAv');
    av.style.background = u.bg;
    if (u.avatar) {
      av.innerHTML = `<img src="/assets/avatars/avatar-${u.avatar}.svg" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"><span class="vc-ring" style="border-color:${u.bg}"></span>`;
    } else {
      av.innerHTML = `${u.name[0]}<span class="vc-ring" style="border-color:${u.bg}"></span>`;
    }
    document.getElementById('vcMiniName').textContent = u.name;
    el.classList.add('show');
  }

  window.vcTogglePanel = function () {
    const panel = document.getElementById('vcPanel');
    const tab = document.getElementById('vcTab');
    const isOpened = panel.classList.toggle('open');
    tab.classList.toggle('open', isOpened);
    if (isOpened) {
      document.getElementById('vcMini').classList.remove('show');
      if (typeof vcShowTab === 'function') vcShowTab();
    } else {
      vcRender();
    }
  };

  window.vcToggleConnection = function () {
    const overlay = document.getElementById('vcOverlay');
    const btn = document.getElementById('voiceToggleBtn');
    if (vcConnected && overlay.style.display !== 'none') {
      vcLeave();
      overlay.style.display = 'none';
      if (btn) btn.classList.remove('ns-btn-active');
    } else {
      if (!vcConnected) vcReconnect();
      overlay.style.display = '';
      document.getElementById('vcPanel').classList.add('open');
      document.getElementById('vcTab').classList.add('open');
      document.getElementById('vcMini').classList.remove('show');
      if (btn) btn.classList.add('ns-btn-active');
    }
  };

  window.vcOpenPanel = function () {
    document.getElementById('vcOverlay').style.display = '';
    document.getElementById('vcPanel').classList.add('open');
    document.getElementById('vcTab').classList.add('open');
    document.getElementById('vcMini').classList.remove('show');
  };

  // ── Draggable ──
  let vcDragY = 0, vcDragPos = 0, vcDragging = false;
  const vcTab = document.getElementById('vcTab');
  vcTab.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    vcDragY = e.clientY;
    vcDragPos = parseFloat(getComputedStyle(vcTab).getPropertyValue('--vc-tab-pos')) || 50;
    vcDragging = true;
    vcTab.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!vcDragging) return;
    const dy = e.clientY - vcDragY;
    const vh = window.innerHeight;
    let p = ((vcDragPos / 100 * vh + dy) / vh * 100);
    p = Math.max(5, Math.min(95, p));
    vcTab.style.setProperty('--vc-tab-pos', p + '%');
    document.getElementById('vcPanel').style.setProperty('--vc-tab-pos', p + '%');
    document.getElementById('vcMini').style.setProperty('--vc-tab-pos', p + '%');
  });
  document.addEventListener('mouseup', () => {
    if (!vcDragging) return;
    vcDragging = false;
    vcTab.style.cursor = 'grab';
    const pos = parseFloat(getComputedStyle(vcTab).getPropertyValue('--vc-tab-pos'));
    localStorage.setItem(VC_KEY, String(pos));
  });

  // Restore saved position
  const saved = localStorage.getItem(VC_KEY);
  if (saved) {
    const p = Math.max(5, Math.min(95, parseFloat(saved)));
    vcTab.style.setProperty('--vc-tab-pos', p + '%');
    document.getElementById('vcPanel').style.setProperty('--vc-tab-pos', p + '%');
    document.getElementById('vcMini').style.setProperty('--vc-tab-pos', p + '%');
  }

  // ── Actions ──
  window.vcSetVol = function (i, v, el) {
    const u = vcUsers[i];
    if (!u) return;
    const newVol = parseInt(v);
    u.vol = newVol;

    if (newVol > 0 && u.serverMuted) {
      u.serverMuted = false;
    } else if (newVol === 0 && !u.serverMuted) {
      u.serverMuted = true;
    }

    if (i > 0 && window.setUserVolume) window.setUserVolume(u.id || u.name, newVol);

    if (el) {
      const wrap = el.closest('.vc-user');
      if (wrap) {
        const pct = wrap.querySelector('.vc-vol-pct');
        if (pct) pct.textContent = newVol + '%';

        const muteBtn = wrap.querySelector('.vc-mute-btn');
        if (muteBtn) {
          if (u.serverMuted) {
            muteBtn.classList.add('muted');
            muteBtn.innerHTML = '<img src="/assets/icons/mic-off.svg" alt="Mute">';
            wrap.classList.add('muted');
          } else {
            muteBtn.classList.remove('muted');
            muteBtn.innerHTML = '<img src="/assets/icons/mic.svg" alt="Mute">';
            wrap.classList.remove('muted');
          }
        }
      }
    } else {
      vcRender();
    }
  };

  window.vcToggleMute = async function (i) {
    const u = vcUsers[i];
    if (!u) return;
    if (i === 0) {
      if (typeof window.toggleMic === 'function') await window.toggleMic();
      vcSyncMic();
      vcRender();
      return;
    }

    u.serverMuted = !u.serverMuted;
    if (u.serverMuted) {
      u._prevVol = u.vol;
      u.vol = 0;
    } else {
      u.vol = u._prevVol !== undefined ? u._prevVol : 100;
      if (u.vol === 0) u.vol = 100;
    }

    if (window.setUserVolume) window.setUserVolume(u.id || u.name, u.vol);
    vcRender();
  };

  window.vcLeave = function () {
    vcConnected = false;
    if (typeof micEnabled !== 'undefined' && micEnabled && typeof disableMic === 'function') disableMic();
    document.getElementById('vcPanel').classList.remove('open');
    document.getElementById('vcTab').classList.remove('open');
    document.getElementById('vcMini').classList.remove('show');
    vcRender();
  };

  window.vcReconnect = function () {
    vcConnected = true;
    if (typeof window.enableMic === 'function') window.enableMic();
    vcRender();
  };

  // ── Hook into viewer.js mic state ──
  function vcSyncMic() {
    if (vcUsers[0]) {
      vcUsers[0].serverMuted = typeof micEnabled !== 'undefined' ? !micEnabled : true;
    }
  }
  // Patch toggleMic to sync VC state after the async operation completes
  const _origToggleMic = window.toggleMic;
  if (typeof _origToggleMic === 'function') {
    window.toggleMic = async function () {
      const ret = _origToggleMic.apply(this, arguments);
      if (ret && typeof ret.then === 'function') await ret;
      vcSyncMic();
      vcRender();
      return ret;
    };
  }
  // Sync on a short interval to catch external changes (avoid full re-render if unchanged)
  setInterval(() => {
    const prev = vcUsers[0]?.serverMuted;
    vcSyncMic();
    if (vcUsers[0]?.serverMuted !== prev) vcRender();
  }, 2000);

  // ── Show overlay — only on explicit user action ──
  window.showVoiceOverlay = function () {
    document.getElementById('voiceToggleBtn').style.display = '';
  };

  // ── Auto-hide tab when user interacts with game ──
  let vcTabTimer = null;
  function vcShowTab() {
    const t = document.getElementById('vcTab');
    if (t) { t.classList.remove('hidden'); }
    clearTimeout(vcTabTimer);
  }
  function vcHideTabAfter(delay) {
    clearTimeout(vcTabTimer);
    vcTabTimer = setTimeout(() => {
      const t = document.getElementById('vcTab');
      const p = document.getElementById('vcPanel');
      if (t && !t.matches(':hover') && !p.classList.contains('open')) t.classList.add('hidden');
    }, delay || 3000);
  }
  document.addEventListener('mousemove', e => {
    if (e.clientX < 40) vcShowTab();
    else vcHideTabAfter(2500);
  });
  document.addEventListener('click', e => {
    const video = document.getElementById('video');
    if (video && video.contains(e.target)) vcHideTabAfter(500);
  });

  // ── Init ──
  const myName = localStorage.getItem('ns_name') || 'Guest';
  const myColor = localStorage.getItem('ns_chat_color') || '#5865f2';
  const myAvatar = localStorage.getItem('ns_avatar');
  vcUsers = [
    { name: myName, bg: myColor, avatar: myAvatar, talking: false, serverMuted: false, vol: 100, isMe: true },
  ];
  document.getElementById('vcOverlay').style.setProperty('--vc-ring-color', myColor);
  vcSyncMic();
  vcRender();
  setTimeout(() => { document.getElementById('vcTab')?.classList.add('hidden'); }, 2000);

  // ── Externally callable ──
  window.vcSetTalking = function (id, talking) {
    if (id === 'self') {
      if (vcUsers[0]) vcUsers[0].talking = !!talking;
    } else {
      const idx = vcUsers.findIndex(u => u.id === id);
      if (idx >= 0) vcUsers[idx].talking = !!talking;
    }
    vcRender();
  };
  window.vcUpdateTalking = function (activeIds) {
    const set = new Set(activeIds || []);
    vcUsers.forEach(u => {
      if (u.id && set.has(u.id)) u.talking = true;
      else if (u.id) u.talking = false;
    });
    vcRender();
  };
  window.vcSetTournament = function (enabled) {
    const el = document.getElementById('vcOverlay');
    if (el) el.style.display = enabled ? 'none' : '';
    if (!enabled) vcRender();
  };

  if (localStorage.getItem('ns_app_tournamentMode') === 'true') {
    document.getElementById('vcOverlay').style.display = 'none';
  }

  window.vcSyncRoster = function (viewers, myId) {
    const self = vcUsers[0] || {};
    const myName = localStorage.getItem('ns_name') || 'Me';
    const myColor = localStorage.getItem('ns_chat_color') || '#5865f2';
    self.name = myName;
    self.bg = myColor;
    self.talking = !!self.talking;
    self.serverMuted = !!self.serverMuted;
    self.vol = self.vol || 100;
    self.isHost = false;
    self.isMe = true;
    const others = (viewers || []).filter(v =>
      v.name &&
      !v.name.startsWith('Guest') &&
      !(myId && v.id && v.id.startsWith(myId))
    ).map(v => ({
      id: v.id,
      name: v.name.replace(/ \d+$/, ''),
      bg: v.color || '#5865f2',
      avatar: v.avatar || null,
      isHost: !!v.isHost,
      isMe: false,
      talking: false,
      serverMuted: false,
      vol: 100,
    }));
    vcUsers = [self, ...others];
    vcRender();
  };
})();
