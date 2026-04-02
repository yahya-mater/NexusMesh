/**
 * NexusMesh — Local-First P2P Video/Voice/Data
 * Pure Vanilla JS · No backend · No framework
 *
 * Architecture:
 *  - Full Mesh topology: each peer holds its own RTCPeerConnection
 *  - Hybrid signaling: URL hash (Base64 compressed SDP) + copy/paste fallback
 *  - Data Channel: profile sync + chat over reliable ordered channel
 *  - STUN-only NAT traversal (works for ~85% of connections)
 */

'use strict';

/* ═══════════════════════════════════════════════════ CONFIG */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const MAX_AVATAR_PX = 72;   // px — keep Base64 small
const LINK_MAX_HASH = 4096; // chars before we warn about truncation

/* ═══════════════════════════════════════════════════ STATE */
const state = {
  peers: [],          // Array<PeerEntry>
  localStream: null,
  screenStream: null,
  isMuted: false,
  isHidden: false,
  chatOpen: false,
  unreadCount: 0,
  profile: loadProfile(),
};

/*
  PeerEntry = {
    id:          string (uuid)
    pc:          RTCPeerConnection
    dc:          RTCDataChannel | null
    remoteStream: MediaStream
    info:        { name, avatar } | null
    statusEl:    HTMLElement
    videoEl:     HTMLVideoElement
    tileEl:      HTMLElement
    status:      'new'|'connecting'|'connected'|'disconnected'|'failed'
  }
*/

/* ═══════════════════════════════════════════════════ DOM */
const $ = id => document.getElementById(id);

const DOM = {
  splash:          $('splash'),
  callScreen:      $('callScreen'),
  videoGrid:       $('videoGrid'),
  localVideo:      $('localVideo'),
  localTile:       $('localTile'),
  localName:       $('localName'),
  localAvatar:     $('localAvatar'),
  localNoCam:      $('localNoCam'),
  localPlaceholderAvatar: $('localPlaceholderAvatar'),
  globalDot:       $('globalStatusDot'),
  globalLabel:     $('globalStatusLabel'),
  // Topbar
  btnInitiate:     $('btnInitiate'),
  btnJoinFromSplash: $('btnJoinFromSplash'),
  btnAddPeer:      $('btnAddPeer'),
  btnEndCall:      $('btnEndCall'),
  // Media
  btnMuteAudio:    $('btnMuteAudio'),
  btnHideVideo:    $('btnHideVideo'),
  // Chat
  chatPanel:       $('chatPanel'),
  chatMessages:    $('chatMessages'),
  chatInput:       $('chatInput'),
  btnSendChat:     $('btnSendChat'),
  btnToggleChat:   $('btnToggleChat'),
  btnCloseChat:    $('btnCloseChat'),
  chatBadge:       $('chatBadge'),
  // Screen share
  btnShareScreen:  $('btnShareScreen'),
  // Signaling modal
  signalingModal:  $('signalingModal'),
  signalingTitle:  $('signalingTitle'),
  signalingBody:   $('signalingBody'),
  btnCloseSignaling: $('btnCloseSignaling'),
  // Settings modal
  settingsModal:   $('settingsModal'),
  settingsName:    $('settingsName'),
  avatarPreview:   $('avatarPreview'),
  avatarFile:      $('avatarFile'),
  btnClearAvatar:  $('btnClearAvatar'),
  btnSaveSettings: $('btnSaveSettings'),
  btnOpenSettings: $('btnOpenSettings'),
  btnOpenSettingsCall: $('btnOpenSettingsCall'),
  btnCloseSettings: $('btnCloseSettings'),
  toastContainer:  $('toastContainer'),
};

/* ═══════════════════════════════════════════════════ UTILS */
function uuid() {
  return crypto.randomUUID?.() ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

function encode(obj) {
  return btoa(encodeURIComponent(JSON.stringify(obj)));
}
function decode(str) {
  try { return JSON.parse(decodeURIComponent(atob(str))); }
  catch { return null; }
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ` ${type}` : '');
  el.textContent = msg;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => toast('Copied to clipboard!', 'success'))
    .catch(() => {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Copied!', 'success');
    });
}

function showModal(id) { $(id).classList.add('open'); }
function hideModal(id) { $(id).classList.remove('open'); }

/* ═══════════════════════════════════════════════════ PROFILE */
function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem('nexusmesh_profile')) ||
      { name: 'Anonymous', avatar: '' };
  } catch { return { name: 'Anonymous', avatar: '' }; }
}
function saveProfile(p) {
  localStorage.setItem('nexusmesh_profile', JSON.stringify(p));
  state.profile = p;
}

function renderLocalProfile() {
  const p = state.profile;
  DOM.localName.textContent = p.name || 'You';
  setAvatarEl(DOM.localAvatar, p.avatar, p.name);
  setAvatarEl(DOM.localPlaceholderAvatar, p.avatar, p.name);
}

function setAvatarEl(el, avatar, name) {
  if (avatar) {
    el.innerHTML = `<img src="${avatar}" alt="avatar" />`;
  } else {
    el.textContent = (name || '?').charAt(0).toUpperCase();
  }
}

/* ═══════════════════════════════════════════════════ SCREEN TRANSITIONS */
function showCallScreen() {
  DOM.splash.classList.remove('active');
  DOM.callScreen.classList.add('active');
}
function showSplash() {
  DOM.callScreen.classList.remove('active');
  DOM.splash.classList.add('active');
}

/* ═══════════════════════════════════════════════════ MEDIA */
async function startLocalMedia() {
  if (state.localStream) return state.localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.localStream = stream;
    DOM.localVideo.srcObject = stream;
    return stream;
  } catch (e) {
    console.warn('getUserMedia failed:', e);
    toast('Camera/mic unavailable — audio-only mode', 'error');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      state.localStream = stream;
      return stream;
    } catch {
      // No media at all — still allow signaling
      state.localStream = new MediaStream();
      return state.localStream;
    }
  }
}

function toggleMute() {
  if (!state.localStream) return;
  state.isMuted = !state.isMuted;
  state.localStream.getAudioTracks().forEach(t => (t.enabled = !state.isMuted));
  DOM.btnMuteAudio.classList.toggle('muted', state.isMuted);
  DOM.btnMuteAudio.title = state.isMuted ? 'Unmute mic' : 'Mute mic';
  // Update SVG icon
  DOM.btnMuteAudio.innerHTML = state.isMuted
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4m-4 0h8"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4m-4 0h8"/></svg>`;
}

function toggleVideo() {
  if (!state.localStream) return;
  state.isHidden = !state.isHidden;
  state.localStream.getVideoTracks().forEach(t => (t.enabled = !state.isHidden));
  DOM.btnHideVideo.classList.toggle('hidden-cam', state.isHidden);
  DOM.localNoCam.classList.toggle('visible', state.isHidden);
  DOM.btnHideVideo.title = state.isHidden ? 'Show camera' : 'Hide camera';
}

async function toggleScreenShare() {
  if (state.screenStream) {
    // Stop screen share, restore camera
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
    DOM.btnShareScreen.classList.remove('active');
    if (state.localStream) {
      const camTrack = state.localStream.getVideoTracks()[0];
      if (camTrack) {
        state.peers.forEach(pe => {
          const sender = pe.pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(camTrack).catch(() => {});
        });
        DOM.localVideo.srcObject = state.localStream;
      }
    }
    return;
  }
  try {
    const ss = await navigator.mediaDevices.getDisplayMedia({ video: true });
    state.screenStream = ss;
    DOM.btnShareScreen.classList.add('active');
    const screenTrack = ss.getVideoTracks()[0];
    DOM.localVideo.srcObject = ss;
    state.peers.forEach(pe => {
      const sender = pe.pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack).catch(() => {});
    });
    screenTrack.onended = () => toggleScreenShare();
  } catch (e) {
    toast('Screen share cancelled', '');
  }
}

/* ═══════════════════════════════════════════════════ PEER CONNECTION */
function createPeer(id) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const remoteStream = new MediaStream();

  const entry = {
    id,
    pc,
    dc: null,
    remoteStream,
    info: null,
    statusEl: null,
    videoEl: null,
    tileEl: null,
    status: 'new',
  };

  // Add local tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  }

  // Remote tracks
  pc.ontrack = e => {
    e.streams[0]?.getTracks().forEach(t => remoteStream.addTrack(t));
    if (entry.videoEl) entry.videoEl.srcObject = remoteStream;
  };

  // ICE logging
  pc.onicecandidate = () => {};  // candidates gathered inline during createOffer

  // Connection state
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[${id}] connectionState →`, s);
    entry.status = s;
    updatePeerTileStatus(entry);
    updateGlobalStatus();
  };

  // Data channel (remote side)
  pc.ondatachannel = e => {
    entry.dc = e.channel;
    setupDataChannel(entry);
  };

  state.peers.push(entry);
  addRemoteTile(entry);
  return entry;
}

function setupDataChannel(entry) {
  const dc = entry.dc;
  dc.onopen = () => {
    console.log(`[${entry.id}] DataChannel open`);
    // Send our profile
    sendProfile(entry);
  };
  dc.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      handleDataMessage(entry, msg);
    } catch (err) {
      console.warn('DC message parse error', err);
    }
  };
  dc.onerror = err => console.warn('DC error', err);
}

function sendProfile(entry) {
  if (!entry.dc || entry.dc.readyState !== 'open') return;
  entry.dc.send(JSON.stringify({
    type: 'profile',
    name: state.profile.name || 'Anonymous',
    avatar: state.profile.avatar || '',
  }));
}

function handleDataMessage(entry, msg) {
  switch (msg.type) {
    case 'profile':
      entry.info = { name: msg.name, avatar: msg.avatar };
      updatePeerTileInfo(entry);
      addChatMessage('system', `${msg.name} joined`);
      break;
    case 'chat':
      addChatMessage('them', msg.text, msg.name);
      break;
  }
}

function broadcastChat(text) {
  const payload = JSON.stringify({
    type: 'chat',
    text,
    name: state.profile.name || 'You',
  });
  state.peers.forEach(pe => {
    if (pe.dc?.readyState === 'open') pe.dc.send(payload);
  });
}

/* ═══════════════════════════════════════════════════ TILE MANAGEMENT */
function addRemoteTile(entry) {
  const tile = document.createElement('div');
  tile.className = 'video-tile remote-tile';
  tile.dataset.peerId = entry.id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = entry.remoteStream;

  const statusBadge = document.createElement('div');
  statusBadge.className = 'peer-conn-status';
  statusBadge.textContent = 'Connecting…';

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';

  const peerInfo = document.createElement('div');
  peerInfo.className = 'peer-info';
  peerInfo.innerHTML = `
    <span class="peer-avatar" data-avatar-for="${entry.id}">?</span>
    <span class="peer-name" data-name-for="${entry.id}">Connecting…</span>`;

  overlay.appendChild(peerInfo);
  tile.appendChild(video);
  tile.appendChild(statusBadge);
  tile.appendChild(overlay);

  DOM.videoGrid.appendChild(tile);
  entry.videoEl = video;
  entry.statusEl = statusBadge;
  entry.tileEl = tile;

  refreshGridClass();
}

function refreshGridClass() {
  const count = state.peers.length;
  DOM.videoGrid.className = 'video-grid';
  if (count === 1) DOM.videoGrid.classList.add('peers-1');
  else if (count === 2) DOM.videoGrid.classList.add('peers-2');
  else if (count >= 3) DOM.videoGrid.classList.add('peers-3');
}

function updatePeerTileStatus(entry) {
  if (!entry.statusEl) return;
  const labels = {
    new: 'New', connecting: 'Connecting…', connected: 'Connected',
    disconnected: 'Reconnecting…', failed: 'Failed', closed: 'Closed',
  };
  entry.statusEl.textContent = labels[entry.status] || entry.status;
  entry.statusEl.style.color = entry.status === 'connected' ? '#00e676' :
    entry.status === 'failed' ? 'var(--danger)' : 'var(--txt-2)';
}

function updatePeerTileInfo(entry) {
  if (!entry.info) return;
  const nameEl = entry.tileEl?.querySelector(`[data-name-for="${entry.id}"]`);
  const avatarEl = entry.tileEl?.querySelector(`[data-avatar-for="${entry.id}"]`);
  if (nameEl) nameEl.textContent = entry.info.name;
  if (avatarEl) setAvatarEl(avatarEl, entry.info.avatar, entry.info.name);
}

function updateGlobalStatus() {
  const statuses = state.peers.map(p => p.status);
  let label = 'Idle'; let cls = '';
  if (statuses.includes('connected')) { label = 'Connected'; cls = 'connected'; }
  else if (statuses.includes('connecting') || statuses.includes('new')) { label = 'Connecting…'; cls = 'connecting'; }
  else if (statuses.includes('failed')) { label = 'Failed'; cls = 'failed'; }
  DOM.globalDot.className = 'conn-dot ' + cls;
  DOM.globalLabel.textContent = label;
}

function removePeer(id) {
  const idx = state.peers.findIndex(p => p.id === id);
  if (idx === -1) return;
  const entry = state.peers[idx];
  entry.pc.close();
  entry.tileEl?.remove();
  state.peers.splice(idx, 1);
  refreshGridClass();
  updateGlobalStatus();
}

/* ═══════════════════════════════════════════════════ SIGNALING FLOW */

/**
 * INITIATOR FLOW:
 *  1. Create peer
 *  2. Create data channel
 *  3. Create offer, wait for ICE to complete
 *  4. Encode offer → URL hash / textarea
 */
async function initiateCall(isAddPeer = false) {
  await startLocalMedia();
  showCallScreen();

  const peerId = uuid();
  const entry = createPeer(peerId);

  // Initiator opens the data channel
  entry.dc = entry.pc.createDataChannel('nexus', { ordered: true });
  setupDataChannel(entry);

  // Create offer
  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete
  await waitForICE(entry.pc);

  const finalSDP = entry.pc.localDescription;
  const encoded = encode({ type: 'offer', sdp: finalSDP, peerId });
  const link = buildLink(encoded);

  showSignalingModal('offer', { entry, encoded, link });
}

/**
 * JOINER FLOW:
 *  1. Decode offer from URL hash or textarea
 *  2. Create peer, set remote description
 *  3. Create answer, wait for ICE
 *  4. Encode answer → share back
 */
async function joinCall(offerData) {
  await startLocalMedia();
  showCallScreen();
  hideModal('signalingModal');

  const entry = createPeer(offerData.peerId || uuid());

  await entry.pc.setRemoteDescription(new RTCSessionDescription({
    type: 'offer', sdp: offerData.sdp.sdp || offerData.sdp,
  }));

  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);

  await waitForICE(entry.pc);

  const finalSDP = entry.pc.localDescription;
  const encoded = encode({ type: 'answer', sdp: finalSDP, peerId: entry.id });
  const link = buildLink(encoded);

  showSignalingModal('answer', { entry, encoded, link });
}

/**
 * FINALIZE (initiator receives answer)
 */
async function finalizeCall(entry, answerData) {
  await entry.pc.setRemoteDescription(new RTCSessionDescription({
    type: 'answer', sdp: answerData.sdp.sdp || answerData.sdp,
  }));
  toast('Handshake complete — connecting…', 'success');
  hideModal('signalingModal');
}

function waitForICE(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Safety timeout — 8 seconds
    setTimeout(() => { pc.removeEventListener('icegatheringstatechange', check); resolve(); }, 8000);
  });
}

function buildLink(encoded) {
  return `${location.origin}${location.pathname}#${encoded}`;
}

/* ═══════════════════════════════════════════════════ SIGNALING MODAL UI */
function showSignalingModal(mode, ctx) {
  DOM.signalingTitle.textContent = mode === 'offer' ? 'Share Invite' :
    mode === 'answer' ? 'Send Your Answer' : 'Add Peer';

  const body = DOM.signalingBody;
  body.innerHTML = '';

  if (mode === 'offer') {
    const tooLong = ctx.link.length > LINK_MAX_HASH;
    body.innerHTML = `
      <p class="step-label">Step 1 — Share this link with your peer</p>
      <p class="step-desc">Send the link below. The WebRTC offer is embedded in the URL. If the link gets truncated, use the manual code instead.</p>
      <div class="link-box">
        <input type="text" id="offerLinkInput" readonly value="${ctx.link}" />
        <button class="btn btn-primary sm" id="btnCopyLink">Copy</button>
      </div>
      ${tooLong ? '<p style="color:var(--danger);font-size:.8rem;margin-top:.3rem;">⚠ Link may be too long for some apps — use the code below.</p>' : ''}
      <div class="divider"><span>or share the code manually</span></div>
      <p class="step-label">Offer Code</p>
      <textarea class="sig-box" id="offerCodeBox" readonly>${ctx.encoded}</textarea>
      <div class="btn-row">
        <button class="btn btn-ghost sm" id="btnCopyCode">Copy Code</button>
      </div>
      <p class="step-label" style="margin-top:1.2rem;">Step 2 — Paste Answer from your peer</p>
      <p class="step-desc">Once they respond with their Answer code or link, paste it here:</p>
      <textarea class="sig-box" id="answerInput" placeholder="Paste answer code or URL here…"></textarea>
      <div class="btn-row">
        <button class="btn btn-primary" id="btnSubmitAnswer">Connect →</button>
      </div>`;

    showModal('signalingModal');

    $('btnCopyLink').onclick = () => copyToClipboard(ctx.link);
    $('btnCopyCode').onclick = () => copyToClipboard(ctx.encoded);
    $('btnSubmitAnswer').onclick = async () => {
      let raw = $('answerInput').value.trim();
      if (!raw) { toast('Paste the answer first', 'error'); return; }
      // Support pasting full URL
      if (raw.includes('#')) raw = raw.split('#').pop();
      const data = decode(raw);
      if (!data || data.type !== 'answer') { toast('Invalid answer code', 'error'); return; }
      await finalizeCall(ctx.entry, data);
    };
  }

  if (mode === 'answer') {
    body.innerHTML = `
      <p class="step-label">Your Answer is ready</p>
      <p class="step-desc">Send this link or code back to the person who invited you. They will paste it to complete the connection.</p>
      <div class="link-box">
        <input type="text" id="answerLinkInput" readonly value="${ctx.link}" />
        <button class="btn btn-primary sm" id="btnCopyAnswerLink">Copy</button>
      </div>
      <div class="divider"><span>or</span></div>
      <p class="step-label">Answer Code</p>
      <textarea class="sig-box" id="answerCodeBox" readonly>${ctx.encoded}</textarea>
      <div class="btn-row">
        <button class="btn btn-ghost sm" id="btnCopyAnswerCode">Copy Code</button>
        <button class="btn btn-primary" id="btnDoneAnswer">Done ✓</button>
      </div>`;

    showModal('signalingModal');

    $('btnCopyAnswerLink').onclick = () => copyToClipboard(ctx.link);
    $('btnCopyAnswerCode').onclick = () => copyToClipboard(ctx.encoded);
    $('btnDoneAnswer').onclick = () => hideModal('signalingModal');
  }
}

/* ═══════════════════════════════════════════════════ CHAT */
function addChatMessage(role, text, name = '') {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  if (name && role === 'them') {
    const nameEl = document.createElement('div');
    nameEl.className = 'chat-msg-name';
    nameEl.textContent = name;
    msg.appendChild(nameEl);
  }
  const textEl = document.createElement('span');
  textEl.textContent = text;
  msg.appendChild(textEl);
  DOM.chatMessages.appendChild(msg);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;

  if (!state.chatOpen && role !== 'me' && role !== 'system') {
    state.unreadCount++;
    DOM.chatBadge.textContent = state.unreadCount;
    DOM.chatBadge.classList.remove('hidden');
  }
}

function sendChatMessage() {
  const text = DOM.chatInput.value.trim();
  if (!text) return;
  DOM.chatInput.value = '';
  addChatMessage('me', text);
  broadcastChat(text);
}

function toggleChat() {
  state.chatOpen = !state.chatOpen;
  DOM.chatPanel.classList.toggle('open', state.chatOpen);
  DOM.btnToggleChat.classList.toggle('active', state.chatOpen);
  if (state.chatOpen) {
    state.unreadCount = 0;
    DOM.chatBadge.classList.add('hidden');
    DOM.chatInput.focus();
  }
}

/* ═══════════════════════════════════════════════════ SETTINGS */
function openSettings() {
  DOM.settingsName.value = state.profile.name || '';
  renderAvatarPreview(state.profile.avatar);
  showModal('settingsModal');
}

function renderAvatarPreview(avatar) {
  if (avatar) {
    DOM.avatarPreview.innerHTML = `<img src="${avatar}" alt="avatar"/>`;
  } else {
    DOM.avatarPreview.textContent = (state.profile.name || '?').charAt(0).toUpperCase();
  }
}

DOM.avatarFile.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    // Downscale avatar to keep Base64 small
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = Math.min(MAX_AVATAR_PX, img.width, img.height);
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Crop to square
      const s = Math.min(img.width, img.height);
      const ox = (img.width - s) / 2, oy = (img.height - s) / 2;
      ctx.drawImage(img, ox, oy, s, s, 0, 0, size, size);
      state._pendingAvatar = canvas.toDataURL('image/jpeg', 0.7);
      renderAvatarPreview(state._pendingAvatar);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

DOM.btnClearAvatar.addEventListener('click', () => {
  state._pendingAvatar = '';
  renderAvatarPreview('');
});

DOM.btnSaveSettings.addEventListener('click', () => {
  const profile = {
    name: DOM.settingsName.value.trim() || 'Anonymous',
    avatar: state._pendingAvatar !== undefined ? state._pendingAvatar : state.profile.avatar,
  };
  saveProfile(profile);
  state._pendingAvatar = undefined;
  renderLocalProfile();
  // Re-broadcast profile to all connected peers
  state.peers.forEach(pe => sendProfile(pe));
  hideModal('settingsModal');
  toast('Profile saved!', 'success');
});

/* ═══════════════════════════════════════════════════ END CALL */
function endCall() {
  state.peers.forEach(pe => pe.pc.close());
  // Remove all remote tiles
  state.peers.forEach(pe => pe.tileEl?.remove());
  state.peers.length = 0;
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
  }
  DOM.localVideo.srcObject = null;
  DOM.chatMessages.innerHTML = '';
  state.chatOpen = false;
  DOM.chatPanel.classList.remove('open');
  DOM.globalDot.className = 'conn-dot';
  DOM.globalLabel.textContent = 'Idle';
  // Clear URL hash
  history.replaceState(null, '', location.pathname);
  refreshGridClass();
  showSplash();
}

/* ═══════════════════════════════════════════════════ AUTO-JOIN FROM HASH */
function checkUrlHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const data = decode(hash);
  if (!data) return;
  // Clear hash so back-button works cleanly
  history.replaceState(null, '', location.pathname);

  if (data.type === 'offer') {
    // Auto-trigger join flow
    DOM.btnJoinFromSplash.click();
    // Small delay so media loads first
    setTimeout(() => joinCall(data), 600);
  } else if (data.type === 'answer') {
    // Someone opened the answer link — this is unusual but handle gracefully
    toast('Paste this answer code into the initiator\'s window', '');
    // Show manual paste UI
    showSignalingModal('paste-answer-hint', {});
  }
}

/* ═══════════════════════════════════════════════════ EVENT WIRING */

// Splash
DOM.btnInitiate.onclick = async () => {
  await initiateCall(false);
};

DOM.btnJoinFromSplash.onclick = async () => {
  // Show a "join" modal to paste offer
  await startLocalMedia();
  showCallScreen();
  openJoinModal();
};

function openJoinModal() {
  DOM.signalingTitle.textContent = 'Join a Call';
  DOM.signalingBody.innerHTML = `
    <p class="step-label">Paste invite link or code</p>
    <p class="step-desc">Paste the invite link or the Offer code that was shared with you:</p>
    <textarea class="sig-box" id="joinOfferInput" placeholder="Paste link or offer code here…" style="min-height:110px;"></textarea>
    <div class="btn-row" style="margin-top:.5rem;">
      <button class="btn btn-primary" id="btnSubmitJoin">Join Call →</button>
    </div>`;
  showModal('signalingModal');
  $('btnSubmitJoin').onclick = async () => {
    let raw = $('joinOfferInput').value.trim();
    if (!raw) { toast('Paste the offer first', 'error'); return; }
    if (raw.includes('#')) raw = raw.split('#').pop();
    const data = decode(raw);
    if (!data || data.type !== 'offer') { toast('Invalid offer code', 'error'); return; }
    hideModal('signalingModal');
    await joinCall(data);
  };
}

// Topbar
DOM.btnAddPeer.onclick = () => initiateCall(true);
DOM.btnEndCall.onclick = () => { if (confirm('End the call?')) endCall(); };
DOM.btnOpenSettings.onclick = openSettings;
DOM.btnOpenSettingsCall.onclick = openSettings;

// Media controls
DOM.btnMuteAudio.onclick = toggleMute;
DOM.btnHideVideo.onclick = toggleVideo;
DOM.btnShareScreen.onclick = toggleScreenShare;

// Chat
DOM.btnToggleChat.onclick = toggleChat;
DOM.btnCloseChat.onclick = toggleChat;
DOM.btnSendChat.onclick = sendChatMessage;
DOM.chatInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } };

// Modal close buttons
DOM.btnCloseSignaling.onclick = () => hideModal('signalingModal');
DOM.btnCloseSettings.onclick = () => hideModal('settingsModal');

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

/* ═══════════════════════════════════════════════════ BOOT */
(function init() {
  renderLocalProfile();
  checkUrlHash();
  // If URL had an offer, the join flow already fired
})();