// ── Friend list & ping module ──────────────────────────────────────────
// Friends are keyed by each friend's own persistent UUID. Display names and
// avatars are DISPLAY ONLY. A ping is one-way: the friend notifies the host
// and (optionally) shares their current session link. The HOST decides to
// end their own session and join the friend's — the viewer never sees a
// popup or invite.
let _friendSeenPings = 0;
let _friendLastToastKey = null;
let _friendLastInviteKey = null;

const FRIEND_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function _getFriendsPort() {
  if (typeof _getServerPort === 'function') return _getServerPort();
  const params = new URLSearchParams(window.location.search);
  return params.get('port') || window.location.port || '3000';
}

function toggleFriendPanel() {
  const panel = document.getElementById('friendPanel');
  const overlay = document.getElementById('friendOverlay');
  if (!panel || !overlay) return;
  const open = panel.style.transform === 'translateX(0%)';
  if (open) { closeFriendPanel(); return; }
  panel.style.transform = 'translateX(0%)';
  overlay.style.display = 'block';
  loadFriends();
  const badges = [document.getElementById('friendPingBadge'), document.getElementById('friendPromptPingBadge')].filter(Boolean);
  badges.forEach(b => { b.style.display = 'none'; b.classList.add('gone'); });
}

function closeFriendPanel() {
  const panel = document.getElementById('friendPanel');
  const overlay = document.getElementById('friendOverlay');
  if (panel) panel.style.transform = 'translateX(105%)';
  if (overlay) overlay.style.display = 'none';
}

function copyFriendUuid() {
  const el = document.getElementById('myFriendUuid');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent.trim()).then(() => {
    const btn = document.getElementById('myFriendUuidCopy');
    const t = typeof I18N !== 'undefined' ? I18N.t('Copied!') : 'Copied!';
    const orig = typeof I18N !== 'undefined' ? I18N.t('Copy') : 'Copy';
    if (btn) btn.textContent = t;
    setTimeout(() => { if (btn) btn.textContent = orig; }, 1500);
  }).catch(() => { });
}

function friendDisplayName(f) {
  return (f && f.name) || (f && f.uuid ? f.uuid.slice(0, 8) : '');
}

async function loadFriends() {
  try {
    const res = await fetch(`http://localhost:${_getFriendsPort()}/api/friends`);
    if (!res.ok) return;
    const data = await res.json();
    updateFriendSections(data.enabled);
    const toggle = document.getElementById('friendPingToggle');
    if (toggle && toggle.checked !== data.enabled) {
      toggle.checked = data.enabled;
      renderToggleState(data.enabled);
    }
    const uuidEl = document.getElementById('myFriendUuid');
    if (uuidEl && data.myUuid && uuidEl.textContent !== data.myUuid) uuidEl.textContent = data.myUuid;
    updateFriendWarning(data.enabled);
    renderFriendList(data.friends || []);
    renderFriendPings(data.pings || [], data.friends || []);
    maybeShowPingToast(data.pings || []);
    maybeShowInvitePopup(data.invites || []);
    const fPanel = document.getElementById('friendPanel');
    const panelOpen = fPanel && fPanel.style.transform === 'translateX(0%)';
    if (!panelOpen && (data.pings || []).length > _friendSeenPings) {
      const badges = [document.getElementById('friendPingBadge'), document.getElementById('friendPromptPingBadge')].filter(Boolean);
      const newCount = (data.pings || []).length - _friendSeenPings;
      badges.forEach(badge => {
        badge.textContent = newCount;
        badge.classList.remove('gone');
        badge.style.display = 'inline-block';
      });
    }
    _friendSeenPings = (data.pings || []).length;
  } catch (_) { }
}

function updateFriendSections(enabled) {
  const enablePopup = document.getElementById('friendEnablePopup');
  const section = document.getElementById('friendEnabledSection');
  if (enablePopup) enablePopup.style.display = enabled ? 'none' : 'block';
  if (section) section.style.display = enabled ? 'flex' : 'none';
  const floatBtn = document.getElementById('friendFloatBtn');
  const enableBanner = document.getElementById('friendEnableFloatBanner');
  if (floatBtn) floatBtn.style.display = enabled ? 'flex' : 'none';
  if (enableBanner) enableBanner.style.display = enabled ? 'none' : 'block';
}

function updateFriendWarning(enabled) {
  const warn = document.getElementById('friendWarning');
  if (warn) warn.style.display = enabled ? 'block' : 'none';
}

function renderToggleState(enabled) {
  const bg = document.getElementById('friendPingToggleBg');
  const knob = document.getElementById('friendPingToggleKnob');
  if (bg) bg.style.background = enabled ? 'var(--accent,#c084fc)' : '#3a3745';
  if (knob) knob.style.transform = enabled ? 'translateX(18px)' : 'translateX(0)';
}

async function setFriendPingEnabled(enabled) {
  renderToggleState(enabled);
  updateFriendWarning(enabled);
  updateFriendSections(enabled);
  try {
    await fetch(`http://localhost:${_getFriendsPort()}/api/friends/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    loadFriends();
  } catch (_) { }
}

function maybeShowPingToast(pings) {
  if (!pings.length) return;
  const newest = pings[0];
  const key = newest.uuid + ':' + newest.at;
  if (key === _friendLastToastKey) return;
  _friendLastToastKey = key;
  showFriendPingToast(newest);
}

function showFriendPingToast(ping) {
  const existing = document.getElementById('friendInviteToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'friendInviteToast';
  toast.style.cssText = 'position:fixed; bottom:70px; right:16px; z-index:1600; background:var(--surface,#16151d); border:1px solid var(--border,#2a2833); border-radius:12px; padding:14px 16px; width:290px; box-shadow:0 10px 30px rgba(0,0,0,0.45); display:flex; flex-direction:column; gap:10px;';
  const name = ping.name || friendDisplayName({ uuid: ping.uuid });
  const tHeader = typeof I18N !== 'undefined' ? I18N.t('{name} pinged you').replace('{name}', name) : `${name} pinged you`;
  const tDismiss = typeof I18N !== 'undefined' ? I18N.t('Dismiss') : 'Dismiss';
  const tJoin = typeof I18N !== 'undefined' ? I18N.t('Join their session') : 'Join their session';

  toast.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <img src="/assets/avatars/avatar-${ping.avatar || 1}.svg" style="width:36px; height:36px; border-radius:50%; background:#11111b; border:2px solid var(--accent,#c084fc); flex-shrink:0;"
        onerror="this.style.display='none'">
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:700; color:var(--text,#e8e6ef); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${tHeader}</div>
        ${ping.url ? `<div style="font-size:11px; color:var(--muted,#888); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ping.url.replace(/^https?:\/\//, '')}</div>` : ''}
      </div>
      <button onclick="this.parentElement.parentElement.remove()" title="${tDismiss}"
        style="background:transparent; border:none; color:var(--muted,#888); cursor:pointer; font-size:16px; line-height:1; padding:2px 4px;">×</button>
    </div>
    ${ping.url ? `<button onclick="joinFriendSession('${ping.url}', this)"
      style="background:#fff; border:none; border-radius:8px; padding:9px; color:#111; font-weight:700; font-size:12px; cursor:pointer; font-family:inherit; width:100%;">${tJoin}</button>` : ''}
  `;
  document.body.appendChild(toast);
}

function maybeShowInvitePopup(invites) {
  if (!invites || !invites.length) return;
  const newest = invites[0];
  const key = newest.fromUuid + ':' + newest.at;
  if (key === _friendLastInviteKey) return;
  _friendLastInviteKey = key;
  showP2PInvitePopup(newest);
}

function showP2PInvitePopup(invite) {
  const existing = document.getElementById('friendP2PInvitePopup');
  if (existing) existing.remove();
  const popup = document.createElement('div');
  popup.id = 'friendP2PInvitePopup';
  popup.style.cssText = 'position:fixed; bottom:70px; right:16px; z-index:1650; background:var(--surface,#16151d); border:1px solid var(--accent,#c084fc); border-radius:12px; padding:14px 16px; width:300px; box-shadow:0 10px 30px rgba(0,0,0,0.45); display:flex; flex-direction:column; gap:10px;';
  const name = String(invite.fromName || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const tTitle = typeof I18N !== 'undefined' ? I18N.t('{name} invited you to their session').replace('{name}', name) : `${name} invited you to their session`;
  const tSub = typeof I18N !== 'undefined' ? I18N.t('They are streaming directly to you over peer-to-peer.') : 'They are streaming directly to you over peer-to-peer.';
  const tDismiss = typeof I18N !== 'undefined' ? I18N.t('Dismiss') : 'Dismiss';
  const tAccept = typeof I18N !== 'undefined' ? I18N.t('Join their P2P session') : 'Join their P2P session';

  popup.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:700; color:var(--text,#e8e6ef);">${tTitle}</div>
        <div style="font-size:11px; color:var(--muted,#888); margin-top:2px;">${tSub}</div>
      </div>
      <button onclick="dismissP2PInvite('${invite.fromUuid}'); this.closest('#friendP2PInvitePopup').remove()" title="${tDismiss}"
        style="background:transparent; border:none; color:var(--muted,#888); cursor:pointer; font-size:16px; line-height:1; padding:2px 4px;">×</button>
    </div>
    <button onclick="acceptP2PInvite('${invite.roomCode}')"
      style="background:var(--accent,#c084fc); border:none; border-radius:8px; padding:9px; color:#111; font-weight:700; font-size:12px; cursor:pointer; font-family:inherit; width:100%;">${tAccept}</button>
  `;
  document.body.appendChild(popup);
}

function acceptP2PInvite(roomCode) {
  const popup = document.getElementById('friendP2PInvitePopup');
  if (popup) popup.remove();
  dismissP2PInvite('');
  window.location.href = `/?host=p2p://${encodeURIComponent(roomCode)}`;
}

function dismissP2PInvite(fromUuid) {
  if (!fromUuid) return;
  fetch(`http://localhost:${_getFriendsPort()}/api/p2p-invite/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromUuid })
  }).catch(() => { });
}

async function joinFriendSession(url, btn) {
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = typeof I18N !== 'undefined' ? I18N.t('Joining...') : 'Joining...';
  try {
    await fetch(`http://localhost:${_getFriendsPort()}/api/capture/stop`, { method: 'POST' });
  } catch (_) { }
  setTimeout(() => {
    const t = document.getElementById('friendInviteToast');
    if (t) t.remove();
    window.location.href = url;
  }, 600);
}

async function addFriend() {
  const input = document.getElementById('friendUuidInput');
  const uuid = (input.value || '').trim().toLowerCase();
  const errEl = document.getElementById('friendAddErr');
  const myUuidEl = document.getElementById('myFriendUuid');
  if (!FRIEND_UUID_RE.test(uuid)) {
    if (errEl) errEl.textContent = typeof I18N !== 'undefined' ? I18N.t('Enter a valid friend ID (the full UUID from their app).') : 'Enter a valid friend ID.';
    return;
  }
  if (myUuidEl && myUuidEl.textContent.trim() === uuid) {
    if (errEl) errEl.textContent = typeof I18N !== 'undefined' ? I18N.t('You can\'t add yourself as a friend.') : "You can't add yourself as a friend.";
    return;
  }
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch(`http://localhost:${_getFriendsPort()}/api/friends/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    const data = await res.json();
    if (!data.ok) {
      if (errEl) errEl.textContent = data.error === 'cannot add yourself' ? (typeof I18N !== 'undefined' ? I18N.t('You can\'t add yourself as a friend.') : "You can't add yourself as a friend.") : (data.error || 'Failed to add friend.');
      return;
    }
    input.value = '';
    renderFriendList(data.friends || []);
    if (data.secret) showPairNotice(uuid, data.secret);
  } catch (_) { }
}

function showPairNotice(uuid, secret) {
  const el = document.getElementById('friendPairNotice');
  if (!el) return;
  const tHeader = typeof I18N !== 'undefined' ? I18N.t('Send this pairing code to your friend (along with your Friend ID):') : 'Send this pairing code to your friend:';
  const tCopy = typeof I18N !== 'undefined' ? I18N.t('Copy Pairing Code') : 'Copy Pairing Code';
  const tDesc = typeof I18N !== 'undefined' ? I18N.t('Tell your friend: this code proves their pings and invites really come from them. They paste it in their own app — Dashboard → Enter Pairing Code, or their profile → Pairing Code — along with your Friend ID. Until they do, their pings to you are rejected.') : 'Tell your friend to enter this pairing code in their app.';

  el.style.display = 'block';
  el.innerHTML =
    '<div style="font-weight:600; margin-bottom:4px;">' + tHeader + '</div>' +
    '<code style="display:block; user-select:all; word-break:break-all; background:#211f28; border:1px solid var(--border,#2a2833); border-radius:6px; padding:8px; font-size:12px; color:var(--accent,#c084fc);">' + secret + '</code>' +
    '<button onclick="copyPairCode(\'' + secret + '\')" style="margin-top:8px; background:#fff; border:none; border-radius:6px; padding:6px 12px; color:#111; font-weight:700; font-size:12px; cursor:pointer; font-family:inherit;">' + tCopy + '</button>' +
    '<div style="margin-top:6px; color:var(--muted,#888);">' + tDesc + '</div>';
}

async function copyPairCode(secret) {
  try {
    await navigator.clipboard.writeText(secret);
    const btn = document.querySelector('#friendPairNotice button');
    if (btn && btn.dataset.copyBusy === '1') return;
    if (btn) btn.dataset.copyBusy = '1';
    if (btn) btn.textContent = typeof I18N !== 'undefined' ? I18N.t('Copied!') : 'Copied!';
    setTimeout(() => {
      const b2 = document.querySelector('#friendPairNotice button');
      if (b2 && b2.dataset.copyBusy === '1') {
        b2.textContent = typeof I18N !== 'undefined' ? I18N.t('Copy Pairing Code') : 'Copy Pairing Code';
        b2.dataset.copyBusy = '0';
      }
    }, 1500);
  } catch (_) { }
}

async function showFriendPairCode(uuid) {
  try {
    const res = await fetch(`http://localhost:${_getFriendsPort()}/api/friends/paircode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    const data = await res.json();
    if (data.ok && data.secret) showPairNotice(uuid, data.secret);
  } catch (_) { }
}

async function enterPairCode() {
  const uuidEl = document.getElementById('friendPairUuidInput');
  const secEl = document.getElementById('friendPairSecretInput');
  const errEl = document.getElementById('friendPairErr');
  const uuid = (uuidEl.value || '').trim().toLowerCase();
  const secret = (secEl.value || '').trim().toLowerCase();
  if (errEl) errEl.style.color = '#f66';
  if (!FRIEND_UUID_RE.test(uuid)) {
    if (errEl) errEl.textContent = typeof I18N !== 'undefined' ? I18N.t('Enter a valid friend ID.') : 'Enter a valid friend ID.';
    return;
  }
  if (!/^[0-9a-f]{48}$/.test(secret)) {
    if (errEl) errEl.textContent = typeof I18N !== 'undefined' ? I18N.t('Enter a valid 48-character pairing code.') : 'Enter a valid 48-character pairing code.';
    return;
  }
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch(`http://localhost:${_getFriendsPort()}/api/friends/secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, secret })
    });
    const data = await res.json();
    if (data.ok) {
      if (errEl) errEl.style.color = '#22c55e';
      if (errEl) errEl.textContent = typeof I18N !== 'undefined' ? I18N.t('Pairing saved — their pings and invites will now be accepted.') : 'Pairing saved.';
      uuidEl.value = '';
      secEl.value = '';
    } else if (errEl) {
      errEl.textContent = data.error === 'invalid pairing code' ? (typeof I18N !== 'undefined' ? I18N.t('Enter a valid 48-character pairing code.') : 'Enter a valid 48-character pairing code.') : (data.error || 'Failed to save pairing code.');
    }
  } catch (_) {
    if (errEl) errEl.textContent = typeof I18N !== 'undefined' ? I18N.t('Failed to save pairing code.') : 'Failed to save pairing code.';
  }
}

async function removeFriend(uuid) {
  try {
    const res = await fetch(`http://localhost:${_getFriendsPort()}/api/friends/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    const data = await res.json();
    if (data.ok) renderFriendList(data.friends || []);
  } catch (_) { }
}

async function renameFriend(uuid) {
  const promptText = typeof I18N !== 'undefined' ? I18N.t('Enter a display name for this friend:') : 'Enter a display name for this friend:';
  const name = window.prompt(promptText);
  if (name === null) return;
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) return;
  try {
    const res = await fetch(`http://localhost:${_getFriendsPort()}/api/friends/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, name: trimmed })
    });
    const data = await res.json();
    if (data.ok) renderFriendList(data.friends || []);
  } catch (_) { }
}

async function copyFriendId(uuid) {
  try {
    await navigator.clipboard.writeText(uuid);
    const btn = document.querySelector('#friendMenu-' + uuid + ' .menu-copy');
    if (btn) {
      const t = btn.textContent;
      btn.textContent = typeof I18N !== 'undefined' ? I18N.t('Copied!') : 'Copied!';
      setTimeout(() => { btn.textContent = t; }, 1500);
    }
  } catch (_) { }
}

function toggleFriendMenu(uuid) {
  document.querySelectorAll('.friend-row-menu').forEach(m => {
    if (m.id !== 'friendMenu-' + uuid && m.style.display !== 'none') m.style.display = 'none';
  });
  const menu = document.getElementById('friendMenu-' + uuid);
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.friend-row-menu')) {
    document.querySelectorAll('.friend-row-menu').forEach(m => { m.style.display = 'none'; });
  }
});

function renderFriendList(friends) {
  const list = document.getElementById('friendList');
  const empty = document.getElementById('friendEmpty');
  if (!list) return;
  if (empty) empty.style.display = friends.length ? 'none' : 'block';
  list.innerHTML = '';
  const sorted = [...friends].sort((a, b) => {
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;
    const an = (a.name || '').toLowerCase(), bn = (b.name || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
  sorted.forEach(f => {
    const row = document.createElement('div');
    const safeName = String(f.name || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    const fallbackText = typeof I18N !== 'undefined' ? I18N.t('Unknown friend') : 'Unknown friend';
    const nameText = safeName || `<span style="color:var(--muted,#888);font-style:italic;">${fallbackText}</span>`;
    const tOnline = typeof I18N !== 'undefined' ? I18N.t('Online') : 'Online';
    const tOffline = typeof I18N !== 'undefined' ? I18N.t('Offline') : 'Offline';
    const tActions = typeof I18N !== 'undefined' ? I18N.t('Friend actions') : 'Friend actions';
    const tCopyId = typeof I18N !== 'undefined' ? I18N.t('Copy Friend ID') : 'Copy Friend ID';
    const tShowPair = typeof I18N !== 'undefined' ? I18N.t('Show Pairing Code') : 'Show Pairing Code';
    const tRename = typeof I18N !== 'undefined' ? I18N.t('Rename') : 'Rename';
    const tRemove = typeof I18N !== 'undefined' ? I18N.t('Remove friend') : 'Remove friend';

    row.style.cssText = 'position:relative; display:flex; align-items:center; gap:10px; background:#211f28; border-radius:8px; padding:8px 10px; opacity:' + (f.online ? 1 : 0.55) + ';';
    row.innerHTML = `
      <span title="${f.online ? tOnline : tOffline}"
        style="width:8px; height:8px; border-radius:50%; background:${f.online ? '#22c55e' : '#ef4444'}; flex-shrink:0;"></span>
      <img src="/assets/avatars/avatar-${f.avatar || 1}.svg" style="width:32px; height:32px; border-radius:50%; background:#11111b; border:2px solid var(--border,#2a2833); flex-shrink:0;"
        onerror="this.style.display='none'">
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:600; color:var(--text,#e8e6ef); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${nameText}</div>
        <div style="font-size:11px; color:var(--muted,#888);">${f.uuid.slice(0, 13)}…</div>
      </div>
      <button onclick="event.stopPropagation(); toggleFriendMenu('${f.uuid}')" title="${tActions}"
        style="background:transparent; border:none; color:var(--muted,#a6adc8); cursor:pointer; font-size:16px; line-height:1; padding:2px 6px; letter-spacing:1px;">⋮</button>
      <div id="friendMenu-${f.uuid}" class="friend-row-menu"
        style="display:none; position:absolute; right:8px; top:38px; z-index:60; background:#1c1a24; border:1px solid var(--border,#2a2833); border-radius:8px; min-width:180px; box-shadow:0 8px 24px rgba(0,0,0,0.5); padding:4px;">
        <button class="menu-copy" onclick="copyFriendId('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text,#e8e6ef); font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${tCopyId}</button>
        <button onclick="showFriendPairCode('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text,#e8e6ef); font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${tShowPair}</button>
        <button onclick="renameFriend('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text,#e8e6ef); font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${tRename}</button>
        <button onclick="removeFriend('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:#f66; font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${tRemove}</button>
      </div>
    `;
    list.appendChild(row);
  });
}

function renderFriendPings(pings, friends) {
  const list = document.getElementById('friendPingList');
  if (!list) return;
  list.innerHTML = '';
  if (!pings.length) {
    list.textContent = typeof I18N !== 'undefined' ? I18N.t('No pings yet.') : 'No pings yet.';
    return;
  }
  const onlineMap = {};
  (friends || []).forEach(f => { onlineMap[f.uuid] = !!f.online; });
  pings.forEach(p => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const when = timeAgo(p.at);
    const name = p.name || friendDisplayName({ uuid: p.uuid });
    const online = !!onlineMap[p.uuid];
    const tOnline = typeof I18N !== 'undefined' ? I18N.t('Online') : 'Online';
    const tOffline = typeof I18N !== 'undefined' ? I18N.t('Offline') : 'Offline';
    const tPinged = typeof I18N !== 'undefined' ? I18N.t('{name} pinged you').replace('{name}', name) : `${name} pinged you`;

    row.innerHTML = `
      <span title="${online ? tOnline : tOffline}"
        style="width:7px; height:7px; border-radius:50%; background:${online ? '#22c55e' : '#ef4444'}; flex-shrink:0;"></span>
      <img src="/assets/avatars/avatar-${p.avatar || 1}.svg" style="width:20px; height:20px; border-radius:50%; background:#11111b; flex-shrink:0;"
        onerror="this.style.display='none'">
      <span style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${tPinged}</span>
      <span style="font-size:11px; color:var(--muted2,#666); flex-shrink:0;">${when}</span>
    `;
    list.appendChild(row);
  });
}

function timeAgo(at) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

setInterval(loadFriends, 8000);
