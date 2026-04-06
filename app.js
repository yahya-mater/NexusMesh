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
const NTFY_BASE = 'https://ntfy-bqw1.onrender.com';//'https://ntfy.sh';
const NTFY_PREFIX = 'nexusmesh';
const NTFY_TTL        = 600;  // seconds — 10 min room offer lifetime
const NTFY_TTL_MS     = NTFY_TTL * 1000;
const ROOM_POLL_INTERVAL = 5000; // check for new joiners every 5 seconds

/* ═══════════════════════════════════════════════════ STATE */

const state = {
  peers: [],
  localStream: null,
  screenStream: null,
  isMuted: false,
  isHidden: false,
  chatOpen: false,
  unreadCount: 0,
  profile: loadProfile(),
  localPeerId: uuid(),
  room: {
    id:             null,
    link:           null,
    expiresAt:      null,
    answerPoller:   null,
    answerSSE:      null,
    seenAnswers:    new Set(),
    pc:             null,
    _manualPC:      null,
    _manualPeerId:  null,
    _countdownTimer: null,
  },
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
  btnCloseSignaling:   $('btnCloseSignaling'),
  btnToggleSignaling:  $('btnToggleSignaling'),
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

// Shorten a stableId to 8 chars for use in ntfy topic names
// ntfy has a 64-char topic limit — full UUIDs in combined topics exceed this
function shortId(stableId) {
  return stableId.replace(/-/g, '').slice(0, 8);
}

function uuid() {
  return crypto.randomUUID?.() ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

function encode(obj) {
  const json = JSON.stringify(obj);
  const compressed = pako.deflate(json);                     // Uint8Array
  const binary = String.fromCharCode(...compressed);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); // URL-safe Base64
}

function decode(str) {
  try {
    // ntfy may URL-encode the message on the way out — decode first
    let clean = str;
    try { clean = decodeURIComponent(str); } catch { /* already clean */ }

    // Restore URL-safe Base64 → standard Base64
    let b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';

    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const json = pako.inflate(bytes, { to: 'string' });
    const result = JSON.parse(json);
    console.log(`[decode] ✓ Success — type: ${result.type}`);
    return result;
  } catch (err) {
    console.warn(`[decode] ✗ Failed:`, err.message);
    console.warn(`[decode] Input (first 80 chars): ${String(str).slice(0, 80)}`);
    return null;
  }
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ` ${type}` : '');
  el.textContent = msg;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ═══════════════════════════════════════════════════ ROOM MANAGEMENT */

async function createOrRefreshRoom() {
  // If room still valid return existing link
  if (state.room.id && state.room.expiresAt && Date.now() < state.room.expiresAt) {
    console.log(`[room] Still valid — expires in ${Math.round((state.room.expiresAt - Date.now()) / 1000)}s`);
    return state.room.link;
  }

  console.log('[room] Creating/refreshing room offer…');

  // Stop existing answer poller
  if (state.room.answerPoller) {
    clearInterval(state.room.answerPoller);
    state.room.answerPoller = null;
  }

  // Generate new roomId or reuse existing
  const roomId = state.room.id || uuid().slice(0, 12);
  state.room.id = roomId;
  state.room.seenAnswers = new Set();

  // Create a generic room offer — this is not tied to a specific remote peer
  // Each joiner will use it to generate their own answer
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.room.pc = pc;

  // Add local tracks so the offer includes media
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  }

  // Need at least one data channel for the offer to be valid
  pc.createDataChannel('room-probe');

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForICE(pc);

  const finalSDP = pc.localDescription;
  const offerPayload = {
    type:     'room-offer',
    sdp:      finalSDP,
    roomId,
    hostId:   state.localPeerId,
  };

  // Publish to ntfy
  const topic = `${NTFY_PREFIX}-room-${roomId}`;
  console.log(`[room] Publishing offer to topic: ${topic}`);
  try {
    const res = await fetch(`${NTFY_BASE}/${topic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-TTL':        String(NTFY_TTL),
        'X-Title':      'NexusMesh Room',
      },
      body: encode(offerPayload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('[room] ✓ Room offer published');
  } catch (e) {
    console.error('[room] ✗ Failed to publish room offer:', e);
    toast('Failed to publish room — check your connection', 'error');
    return null;
  }

  const link = `${location.origin}${location.pathname}#room:${roomId}`;
  state.room.link      = link;
  state.room.expiresAt = Date.now() + NTFY_TTL_MS;

  // Start polling for answers from joiners
  startAnswerPoller(roomId);

  console.log(`[room] ✓ Room ready — link: ${link}`);
  return link;
}

function startAnswerPoller(roomId) {
  if (state.room.answerPoller) clearInterval(state.room.answerPoller);

  const answerTopic = `${NTFY_PREFIX}-room-${roomId}-answers`;
  const pollUrl     = `${NTFY_BASE}/${answerTopic}/json?poll=1&since=all`;

  console.log(`[room] Starting answer poller — topic: ${answerTopic}`);

  // Also open SSE for instant notification
  const sseUrl = `${NTFY_BASE}/${answerTopic}/sse`;
  const es = new EventSource(sseUrl);
  es.onopen  = () => console.log('[room:sse] ✓ Answer SSE open');
  es.onmessage = e => {
    try {
      const envelope = JSON.parse(e.data);
      if (envelope.event === 'open' || !envelope.message) return;
      let clean = envelope.message;
      try { clean = decodeURIComponent(clean); } catch {}
      const data = decode(clean);
      if (data?.type === 'room-answer') processRoomAnswer(data);
    } catch {}
  };
  es.onerror = () => {
    console.warn('[room:sse] SSE error — relying on poll fallback');
    es.close();
  };

  // Polling fallback
  async function poll() {
    if (!state.room.id) return;
    try {
      const res = await fetch(pollUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const text = await res.text();
      if (!text.trim()) return;
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const envelope = JSON.parse(line);
          if (envelope.event === 'open' || !envelope.message) continue;
          let clean = envelope.message;
          try { clean = decodeURIComponent(clean); } catch {}
          const data = decode(clean);
          if (data?.type === 'room-answer') processRoomAnswer(data);
        } catch { continue; }
      }
    } catch { /* network blip */ }
  }

  poll(); // immediate
  state.room.answerPoller = setInterval(poll, ROOM_POLL_INTERVAL);
  // Store SSE handle for cleanup
  state.room.answerSSE = es;
}

async function processRoomAnswer(data) {
  const { joinerStableId, sdp, roomId } = data;

  if (roomId !== state.room.id) {
    console.log(`[room] Answer for old room ${roomId} — ignoring`);
    return;
  }
  if (state.room.seenAnswers.has(joinerStableId)) {
    console.log(`[room] Already processed answer from ${joinerStableId}`);
    return;
  }
  if (joinerStableId === state.localPeerId) {
    console.log(`[room] Ignoring own answer`);
    return;
  }
  // Check if already connected
  if (state.peers.find(pe => pe.stableId === joinerStableId)) {
    console.log(`[room] Already connected to ${joinerStableId}`);
    return;
  }

  state.room.seenAnswers.add(joinerStableId);
  console.log(`[room] ✓ New joiner answer from ${joinerStableId} — creating connection`);
  toast('Peer joining — connecting…', '');

  const entry = createPeer(uuid());
  entry.stableId = joinerStableId;
  // Attach tile immediately so A can see someone is connecting
  attachPeerTile(entry);
  const pc = entry.pc;
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  }

  // The joiner already created their answer based on the room offer SDP
  // We need to create a fresh direct offer/answer pair for real media
  // Post a direct offer back to the joiner via ntfy
  const dc = pc.createDataChannel('nexus', { ordered: true });
  entry.dc = dc;
  setupDataChannel(entry);

  const directOffer = await pc.createOffer();
  await pc.setLocalDescription(directOffer);
  await waitForICE(pc);

  const finalSDP = pc.localDescription;

  // Send direct offer to this specific joiner
  const directTopic = `${NTFY_PREFIX}-d-${shortId(joinerStableId)}`;
  console.log(`[room] Sending direct offer to ${joinerStableId} via ${directTopic}`);

  try {
    await fetch(`${NTFY_BASE}/${directTopic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-TTL':        '120',
        'X-Title':      'NexusMesh Direct',
      },
      body: encode({
        type:       'direct-offer',
        sdp:        finalSDP,
        fromId:     state.localPeerId,
        roomId:     state.room.id,
      }),
    });
    console.log(`[room] ✓ Direct offer sent to ${joinerStableId}`);
  } catch (e) {
    console.error('[room] ✗ Failed to send direct offer:', e);
  }

  // Listen for direct answer from this joiner
  listenForDirectAnswer(entry, joinerStableId);
}

function listenForDirectAnswer(entry, joinerStableId) {
  const myDirectTopic = `${NTFY_PREFIX}-da-${shortId(state.localPeerId)}-${shortId(joinerStableId)}`;
  console.log(`[room] Listening for direct answer on topic: ${myDirectTopic} (len:${myDirectTopic.length})`);

  const listener = ntfyListen(myDirectTopic, null, data => {
    if (data.type !== 'direct-answer' || data.fromId !== joinerStableId) return;
    console.log(`[room] ✓ Got direct answer from ${joinerStableId}`);
    entry.pc.setRemoteDescription(new RTCSessionDescription({
      type: 'answer', sdp: data.sdp.sdp || data.sdp,
    })).then(() => {
      attachPeerTile(entry);
      console.log(`[room] ✓ Direct connection established with ${joinerStableId}`);
      toast(`${entry.info?.name || 'A peer'} joined`, 'success');
    }).catch(e => console.error('[room] setRemoteDescription failed:', e));
  }, err => {
    console.error('[room] Direct answer listener error:', err);
  });

  // Auto-cancel after 3 min — but only close the listener, never navigate
  setTimeout(() => {
    listener.close();
    console.log(`[room] Direct answer listener for ${joinerStableId} expired cleanly`);
  }, 180000);
}

// Called on the joiner side when they open a room link
async function joinRoom(roomId) {
  console.log(`[room] Joining room ${roomId}`);

  // Fetch room offer from ntfy
  const roomTopic  = `${NTFY_PREFIX}-room-${roomId}`;
  const pollUrl    = `${NTFY_BASE}/${roomTopic}/json?poll=1&since=all`;

  showJoinSpinner(roomId);

  let roomOffer = null;
  let attempts  = 0;
  while (!roomOffer && attempts < 10) {
    attempts++;
    console.log(`[room] Fetching room offer attempt ${attempts}…`);
    try {
      const res  = await fetch(pollUrl, { signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const envelope = JSON.parse(line);
          if (!envelope.message) continue;
          let clean = envelope.message;
          try { clean = decodeURIComponent(clean); } catch {}
          const data = decode(clean);
          if (data?.type === 'room-offer' && data.roomId === roomId) {
            roomOffer = data;
            break;
          }
        } catch { continue; }
      }
    } catch (e) {
      console.warn(`[room] Fetch attempt ${attempts} failed:`, e);
    }
    if (!roomOffer) await new Promise(r => setTimeout(r, 2000));
  }

  if (!roomOffer) {
    console.error('[room] Could not fetch room offer — expired or invalid');
    toast('Room link expired or invalid — ask host to refresh the link', 'error');
    hideModal('signalingModal');
    // Only go to splash if we have no active connections
    if (state.peers.length === 0) showSplash();
    return;
  }

  console.log(`[room] ✓ Got room offer from host ${roomOffer.hostId}`);
  hideModal('signalingModal');
  await startLocalMedia();
  showCallScreen();
  lockSettingsDuringCall();

  // Post our answer token to the answers topic so the host knows we want to join
  const answersTopic = `${NTFY_PREFIX}-room-${roomId}-answers`;
  try {
    await fetch(`${NTFY_BASE}/${answersTopic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-TTL':        '120',
        'X-Title':      'NexusMesh Join',
      },
      body: encode({
        type:            'room-answer',
        joinerStableId:  state.localPeerId,
        roomId,
        // We don't send real SDP here — host will send us a direct offer
      }),
    });
    console.log(`[room] ✓ Join request posted — waiting for direct offer from host`);
  } catch (e) {
    console.error('[room] Failed to post join request:', e);
    toast('Failed to join room', 'error');
    return;
  }

  // Listen for direct offer from host
  const directTopic = `${NTFY_PREFIX}-d-${shortId(state.localPeerId)}`;
  console.log(`[room] Listening for direct offer on: ${directTopic} (len:${directTopic.length})`);

  const listener = ntfyListen(directTopic, null, async data => {
    if (data.type !== 'direct-offer') return;
    console.log(`[room] ✓ Got direct offer from host ${data.fromId}`);

    const entry = createPeer(uuid());
    entry.stableId = data.fromId;
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => entry.pc.addTrack(t, state.localStream));
    }

    await entry.pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer', sdp: data.sdp.sdp || data.sdp,
    }));
    attachPeerTile(entry);

    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    await waitForICE(entry.pc);

    const finalSDP = entry.pc.localDescription;

    // Send answer back to host
    const replyTopic = `${NTFY_PREFIX}-da-${shortId(data.fromId)}-${shortId(state.localPeerId)}`;
    console.log(`[room] Posting direct answer to: ${replyTopic} (len:${replyTopic.length})`);
    await fetch(`${NTFY_BASE}/${replyTopic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-TTL':        '120',
        'X-Title':      'NexusMesh Answer',
      },
      body: encode({
        type:   'direct-answer',
        sdp:    finalSDP,
        fromId: state.localPeerId,
        roomId,
      }),
    });

    console.log(`[room] ✓ Direct answer sent to host — P2P handshake complete`);
    listener.close();
  }, err => {
    // Only show error — never navigate away if a P2P connection is already live
    console.error('[room] Direct offer listener error:', err);
    if (state.peers.length === 0) {
      toast('Connection timed out — try rejoining', 'error');
    } else {
      console.log('[room] Listener timed out but peer connections are live — ignoring');
    }
  });
}

function stopRoom() {
  if (state.room.answerPoller)   { clearInterval(state.room.answerPoller); state.room.answerPoller = null; }
  if (state.room.answerSSE)      { state.room.answerSSE.close(); state.room.answerSSE = null; }
  if (state.room._countdownTimer){ clearInterval(state.room._countdownTimer); state.room._countdownTimer = null; }
  if (state.room._manualPC)      { state.room._manualPC.close(); state.room._manualPC = null; }
  state.room.id            = null;
  state.room.link          = null;
  state.room.expiresAt     = null;
  state.room._manualPeerId = null;
  state.room.seenAnswers   = new Set();
  console.log('[room] Room stopped and cleaned up');
}

/* ═══════════════════════════════════════════════════ NTFY SIGNALING */
function ntfyTopic(roomId, leg) {
  const topic = `${NTFY_PREFIX}-${leg}-${roomId}`;
  console.log(`[ntfy] topic resolved → ${topic}`);
  return topic;
}

async function ntfyPublish(roomId, leg, payload) {
  const topic = ntfyTopic(roomId, leg);
  const url = `${NTFY_BASE}/${topic}`;
  const body = encode(payload);
  console.log(`[ntfy:publish] → POST ${url}`);
  console.log(`[ntfy:publish] payload type: ${payload.type}, body length: ${body.length} chars`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-TTL': String(NTFY_TTL),
        'X-Title': 'NexusMesh Signal',
      },
      body,
    });
  } catch (networkErr) {
    console.error(`[ntfy:publish] ✗ Network error (fetch threw):`, networkErr);
    throw networkErr;
  }

  console.log(`[ntfy:publish] ← HTTP ${res.status}`);

  if (!res.ok) {
    const errText = await res.text().catch(() => '(unreadable)');
    console.error(`[ntfy:publish] ✗ Server rejected publish:`, errText);
    throw new Error(`ntfy publish failed: ${res.status} — ${errText}`);
  }

  console.log(`[ntfy:publish] ✓ Offer published successfully to topic: ${topic}`);
}

function ntfyListen(roomIdOrTopic, leg, onMessage, onError) {
  // If leg is empty string, treat first arg as a full topic name
  const topic = (!leg) ? roomIdOrTopic : ntfyTopic(roomIdOrTopic, leg);
  const sseUrl  = `${NTFY_BASE}/${topic}/sse`;
  const pollUrl = `${NTFY_BASE}/${topic}/json?poll=1&since=all`;

  console.log(`[ntfy:listen] Starting listener — leg: ${leg}, roomId: ${roomIdOrTopic}`);
  console.log(`[ntfy:listen] SSE  URL: ${sseUrl}`);
  console.log(`[ntfy:listen] Poll URL: ${pollUrl}`);

  let closed         = false;
  let es             = null;
  let pollTimer      = null;
  let pollAttempts   = 0;
  let messageHandled = false;
  const MAX_POLL     = 90;
  const POLL_INTERVAL = 4000;

  function handleMessage(raw) {
    console.log(`[ntfy:listen] handleMessage called, already handled: ${messageHandled}, closed: ${closed}`);
    if (messageHandled || closed) {
      console.log(`[ntfy:listen] Skipping — already handled or closed`);
      return;
    }
    console.log(`[ntfy:listen] Raw message received (first 120 chars): ${String(raw).slice(0, 120)}…`);
    const data = decode(raw);
    if (!data) {
      console.warn(`[ntfy:listen] ✗ decode() returned null — message may be malformed or wrong encoding`);
      return;
    }
    console.log(`[ntfy:listen] ✓ Decoded payload type: ${data.type}, peerId: ${data.peerId}`);
    messageHandled = true;
    cleanup();
    onMessage(data);
  }

  function cleanup() {
    console.log(`[ntfy:listen] cleanup() called — closing SSE and poll timer`);
    closed = true;
    if (es)        { es.close(); es = null; console.log(`[ntfy:listen] SSE closed`); }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; console.log(`[ntfy:listen] Poll timer cleared`); }
  }

  // ── SSE
  function trySSE() {
    console.log(`[ntfy:listen:sse] Opening EventSource → ${sseUrl}`);
    try {
      es = new EventSource(sseUrl);

      es.onopen = () => {
        console.log(`[ntfy:listen:sse] ✓ Connection opened`);
        // Immediately do a one-shot poll to catch messages published
        // before we started listening (race condition between publish and subscribe)
        console.log(`[ntfy:listen:sse] Running catch-up poll for pre-existing messages…`);
        catchUpPoll();
      };

      es.onmessage = e => {
        console.log(`[ntfy:listen:sse] Raw SSE frame received`);
        console.log(`[ntfy:listen:sse] e.data (first 200):`, String(e.data).slice(0, 200));
        let envelope;
        try {
          envelope = JSON.parse(e.data);
        } catch (parseErr) {
          console.warn(`[ntfy:listen:sse] ✗ JSON parse failed on frame:`, parseErr);
          return;
        }
        console.log(`[ntfy:listen:sse] Envelope event type: "${envelope.event}", has message: ${!!envelope.message}`);
        if (envelope.event === 'open' || !envelope.message) {
          console.log(`[ntfy:listen:sse] Skipping keepalive/empty frame`);
          return;
        }
        handleMessage(envelope.message);
      };

      es.onerror = err => {
        if (closed) return;
        console.warn(`[ntfy:listen:sse] ✗ SSE error event fired — readyState: ${es?.readyState}`);
        console.warn(`[ntfy:listen:sse] Error detail:`, err);
        if (es) { es.close(); es = null; }
        console.log(`[ntfy:listen:sse] Falling back to polling`);
        startPolling();
      };

    } catch (initErr) {
      console.error(`[ntfy:listen:sse] ✗ EventSource constructor threw:`, initErr);
      startPolling();
    }
  }

  // ── One-shot catch-up poll (runs once after SSE opens)
  async function catchUpPoll() {
    if (closed || messageHandled) return;
    console.log(`[ntfy:catchup] One-shot poll → ${pollUrl}`);
    try {
      const res = await fetch(pollUrl, { signal: AbortSignal.timeout(8000) });
      console.log(`[ntfy:catchup] ← HTTP ${res.status}`);
      if (!res.ok) {
        console.warn(`[ntfy:catchup] Non-OK — skipping, SSE will handle live delivery`);
        return;
      }
      const text = await res.text();
      console.log(`[ntfy:catchup] Body length: ${text.length}`);
      if (!text.trim()) {
        console.log(`[ntfy:catchup] No cached messages — waiting on SSE for live delivery`);
        return;
      }
      const lines = text.trim().split('\n').filter(Boolean);
      console.log(`[ntfy:catchup] ${lines.length} line(s) to parse`);
      for (const [i, line] of lines.entries()) {
        let envelope;
        try { envelope = JSON.parse(line); }
        catch { console.warn(`[ntfy:catchup] Line ${i} parse failed`); continue; }
        console.log(`[ntfy:catchup] Line ${i} — event: "${envelope.event}", has message: ${!!envelope.message}`);
        if (envelope.event === 'open' || !envelope.message) continue;
        console.log(`[ntfy:catchup] ✓ Found cached message — handling`);
        handleMessage(envelope.message);
        return;
      }
      console.log(`[ntfy:catchup] No valid cached message found — SSE standing by for live delivery`);
    } catch (err) {
      console.warn(`[ntfy:catchup] fetch error:`, err);
    }
  }

  // ── Polling fallback
  function startPolling() {
    if (closed) { console.log(`[ntfy:listen:poll] Aborted — already closed`); return; }
    console.log(`[ntfy:listen:poll] Starting poll every ${POLL_INTERVAL}ms, max ${MAX_POLL} attempts`);

    async function poll() {
      if (closed) return;
      pollAttempts++;
      console.log(`[ntfy:listen:poll] Attempt ${pollAttempts}/${MAX_POLL} → GET ${pollUrl}`);

      if (pollAttempts > MAX_POLL) {
        console.error(`[ntfy:listen:poll] ✗ Max attempts reached — giving up`);
        cleanup();
        if (onError) onError(new Error('Timed out waiting for peer'));
        return;
      }

      let res;
      try {
        res = await fetch(pollUrl, { signal: AbortSignal.timeout(8000) });
      } catch (fetchErr) {
        console.warn(`[ntfy:listen:poll] ✗ fetch threw (network or timeout):`, fetchErr);
        return;
      }

      console.log(`[ntfy:listen:poll] ← HTTP ${res.status}`);

      if (!res.ok) {
        console.warn(`[ntfy:listen:poll] ✗ Non-OK response — rate limited or server error`);
        return;
      }

      let text;
      try {
        text = await res.text();
      } catch (readErr) {
        console.warn(`[ntfy:listen:poll] ✗ Failed to read response body:`, readErr);
        return;
      }

      console.log(`[ntfy:listen:poll] Response body length: ${text.length}, lines: ${text.trim().split('\n').filter(Boolean).length}`);

      if (!text.trim()) {
        console.log(`[ntfy:listen:poll] Empty response — no messages yet`);
        return;
      }

      const lines = text.trim().split('\n').filter(Boolean);
      console.log(`[ntfy:listen:poll] Parsing ${lines.length} line(s)…`);

      for (const [i, line] of lines.entries()) {
        let envelope;
        try {
          envelope = JSON.parse(line);
        } catch (parseErr) {
          console.warn(`[ntfy:listen:poll] ✗ Line ${i} JSON parse failed:`, parseErr);
          continue;
        }
        console.log(`[ntfy:listen:poll] Line ${i} — event: "${envelope.event}", has message: ${!!envelope.message}`);
        if (envelope.event === 'open' || !envelope.message) continue;
        handleMessage(envelope.message);
        return;
      }

      console.log(`[ntfy:listen:poll] No valid message found in this response — will retry`);
    }

    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL);
  }

  trySSE();

  return { close: cleanup };
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

function showModal(id) {
  $(id).classList.add('open');
  if (id === 'signalingModal') {
    DOM.btnToggleSignaling.style.display = 'flex';
    DOM.btnToggleSignaling.title = 'Hide invite panel';
    DOM.btnToggleSignaling.classList.add('active');
  }
}

function hideModal(id) {
  $(id).classList.remove('open');
  if (id === 'signalingModal') {
    // Don't hide the toggle button — let user re-open
    DOM.btnToggleSignaling.classList.remove('active');
    DOM.btnToggleSignaling.title = 'Show invite panel';
  }
}

function toggleSignalingModal() {
  const isOpen = DOM.signalingModal.classList.contains('open');
  if (isOpen) {
    hideModal('signalingModal');
  } else {
    showModal('signalingModal');
  }
}
/* ═══════════════════════════════════════════════════ PROFILE */
function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem('nexusmesh_profile')) ||
      { name: 'Anonymous', avatar: '' };
  } catch { return { name: 'Anonymous', avatar: '' }; }
}

function profileExplicitlySet() {
  return localStorage.getItem('nexusmesh_profile_set') === 'true';
}

function saveProfile(p) {
  localStorage.setItem('nexusmesh_profile', JSON.stringify(p));
  localStorage.setItem('nexusmesh_profile_set', 'true');
  state.profile = p;
  console.log(`[profile] Saved — name: "${p.name}", avatar: ${p.avatar ? 'yes' : 'no'}`);
}

function lockSettingsDuringCall() {
  // Make fields read-only
  DOM.settingsName.readOnly = true;
  DOM.settingsName.style.opacity = '.5';
  DOM.avatarFile.disabled = true;
  DOM.btnClearAvatar.disabled = true;
  DOM.btnClearAvatar.style.opacity = '.4';
  DOM.btnSaveSettings.style.display = 'none';
  $('settingsLockNotice').style.display = 'block';
  DOM.btnOpenSettingsCall.style.opacity = '.5';
  DOM.btnOpenSettingsCall.title = 'Profile is locked during a call';
  console.log('[profile] Settings locked for duration of call');
}

function unlockSettings() {
  DOM.settingsName.readOnly = false;
  DOM.settingsName.style.opacity = '';
  DOM.avatarFile.disabled = false;
  DOM.btnClearAvatar.disabled = false;
  DOM.btnClearAvatar.style.opacity = '';
  DOM.btnSaveSettings.style.display = '';
  $('settingsLockNotice').style.display = 'none';
  DOM.btnOpenSettingsCall.style.opacity = '';
  DOM.btnOpenSettingsCall.title = 'Profile';
  console.log('[profile] Settings unlocked');
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
  state.localStream = new MediaStream();

  // ── Mic
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    audioStream.getAudioTracks().forEach(t => {
      state.localStream.addTrack(t);
      console.log(`[media] ✓ Audio track acquired: ${t.label}`);
    });
  } catch (err) {
    console.warn('[media] ✗ Mic permission denied or unavailable:', err.message);
    toast('Mic unavailable — continuing without audio', 'error');
  }

  // ── Camera (asked separately so mic-only works if cam denied)
  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoStream.getVideoTracks().forEach(t => {
      state.localStream.addTrack(t);
      console.log(`[media] ✓ Video track acquired: ${t.label}`);
    });
  } catch (err) {
    console.warn('[media] ✗ Camera permission denied or unavailable:', err.message);
    toast('Camera unavailable — audio-only mode', '');
    DOM.localNoCam.classList.add('visible');
  }

  DOM.localVideo.srcObject = state.localStream;
  // Mirror local cam preview so it feels natural (does not affect sent video)
  const hasCam = state.localStream.getVideoTracks().length > 0;
  setLocalVideoMirror(hasCam);

  console.log(`[media] Stream ready — audio tracks: ${state.localStream.getAudioTracks().length}, video tracks: ${state.localStream.getVideoTracks().length}`);
  return state.localStream;
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

function setLocalVideoMirror(shouldMirror) {
  if (shouldMirror) {
    DOM.localVideo.classList.add('mirror');
  } else {
    DOM.localVideo.classList.remove('mirror');
  }
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
        setLocalVideoMirror(true);   // back to cam — restore mirror
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
    setLocalVideoMirror(false);  // screen share should never be mirrored
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
    dc:           null,
    remoteStream,
    info:         null,
    statusEl:     null,
    videoEl:      null,
    tileEl:       null,
    status:       'new',
    tileAttached: false,  // tile only added when handshake is confirmed
  };

  

  pc.ontrack = e => {
    e.streams[0]?.getTracks().forEach(t => remoteStream.addTrack(t));
    if (entry.videoEl) entry.videoEl.srcObject = remoteStream;
  };

  pc.onicecandidate = () => {};

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[${id}] connectionState →`, s);
    entry.status = s;

    // Tile is attached when setRemoteDescription is called — not here

    updatePeerTileStatus(entry);
    updateGlobalStatus();

    if (s === 'failed' || s === 'closed' || s === 'disconnected') {
      console.log(`[mesh] Peer ${id} — state: ${s}, scheduling cleanup`);
      setTimeout(() => {
        if (entry.status === 'failed' || entry.status === 'closed' || entry.status === 'disconnected') {
          console.log(`[mesh] Removing unrecovered peer ${id}`);
          const name = entry.info?.name || 'A peer';
          removePeer(id);
          addChatMessage('system', `${name} disconnected`);
        }
      }, 8000);
    }
  };

  pc.ondatachannel = e => {
    entry.dc = e.channel;
    setupDataChannel(entry);
  };

  state.peers.push(entry);
  // NO tile added here — tile added only when connection is real
  return entry;
}

// Called only when we know a real peer is on the other end
function attachPeerTile(entry) {
  if (entry.tileAttached) return;
  entry.tileAttached = true;
  console.log(`[tile] Attaching tile for peer ${entry.id}`);
  addRemoteTile(entry);
  refreshGridClass();
}

function setupDataChannel(entry) {
  const dc = entry.dc;
  dc.onopen = () => {
    console.log(`[${entry.id}] DataChannel open`);
    // Send identity first, then profile
    dc.send(JSON.stringify({
      type:     'identity',
      stableId: state.localPeerId,
      name:     state.profile.name,
    }));
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
  console.log(`[mesh] message from ${entry.id} — type: ${msg.type}`);
  switch (msg.type) {

    case 'identity':
      // Store the remote peer's stable ID — this is what we use for brokering
      entry.stableId = msg.stableId;
      console.log(`[mesh] identity registered — connection ${entry.id} = stable ${msg.stableId}`);
      break;

    case 'profile':
      entry.info = { name: msg.name, avatar: msg.avatar };
      updatePeerTileInfo(entry);
      addChatMessage('system', `${msg.name} joined`);
      // Broker introductions using stable IDs — wait a tick for identity to arrive
      setTimeout(() => brokerIntroductions(entry), 200);
      break;

    case 'chat':
      // Drop if we already processed this message (relay loop guard)
      if (seenMsgIds.has(msg.msgId)) {
        console.log(`[chat] Dropping duplicate msgId ${msg.msgId}`);
        break;
      }
      seenMsgIds.add(msg.msgId);
      addChatMessage('them', msg.text, msg.name);
      // Relay to all other peers except the one who sent it
      state.peers.forEach(pe => {
        if (pe.id !== entry.id && pe.dc?.readyState === 'open') {
          pe.dc.send(JSON.stringify(msg));
        }
      });
      break;

    // ── Mesh brokering ──────────────────────────────────────────
    case 'introduce-peers':
      // C receives list of existing peers from broker — initiate with each
      console.log(`[mesh] received peer list — ${msg.peers.length} peer(s) to connect`);
      msg.peers.forEach(peerInfo => handleIntroduction(peerInfo));
      break;

    case 'create-offer-for':
      console.log(`[mesh] create-offer-for ${msg.targetStableId} via broker ${msg.brokerId}`);
      // Guard: don't create offer for ourselves
      if (msg.targetStableId === state.localPeerId) {
        console.warn('[mesh] Ignoring create-offer-for targeting ourselves');
        return;
      }
      createBrokeredOffer(msg.targetStableId, msg.brokerId, entry);
      break;

    case 'broker-offer':
      if (msg.targetStableId === state.localPeerId) {
        // This offer is for us
        console.log(`[mesh] broker-offer for us from ${msg.fromStableId}`);
        handleBrokeredOffer(entry, msg);
      } else {
        // Forward to the target peer
        console.log(`[mesh] Forwarding broker-offer to stableId ${msg.targetStableId}`);
        const offerTarget = state.peers.find(pe => pe.stableId === msg.targetStableId);
        if (offerTarget?.dc?.readyState === 'open') {
          offerTarget.dc.send(JSON.stringify(msg));
          console.log(`[mesh] Forwarded broker-offer to ${msg.targetStableId}`);
        } else {
          console.warn(`[mesh] Cannot forward broker-offer — no DC for ${msg.targetStableId}`);
        }
      }
      break;

    case 'broker-answer':
      if (msg.targetStableId === state.localPeerId) {
        console.log(`[mesh] broker-answer for us from ${msg.fromStableId}`);
        handleBrokeredAnswer(msg);
      } else {
        console.log(`[mesh] Forwarding broker-answer to stableId ${msg.targetStableId}`);
        const answerTarget = state.peers.find(pe => pe.stableId === msg.targetStableId);
        if (answerTarget?.dc?.readyState === 'open') {
          answerTarget.dc.send(JSON.stringify(msg));
          console.log(`[mesh] Forwarded broker-answer to ${msg.targetStableId}`);
        } else {
          console.warn(`[mesh] Cannot forward broker-answer — no DC for ${msg.targetStableId}`);
        }
      }
      break;

    case 'broker-ice':
      if (msg.targetStableId === state.localPeerId) {
        handleBrokeredIce(msg);
      } else {
        const iceTarget = state.peers.find(pe => pe.stableId === msg.targetStableId);
        if (iceTarget?.dc?.readyState === 'open') {
          iceTarget.dc.send(JSON.stringify(msg));
        }
      }
      break;

    case 'introduce-peers':
      console.log(`[mesh] received peer list — ${msg.peers.length} peer(s) to connect`);
      msg.peers.forEach(peerInfo => {
        // Guard: don't introduce ourselves
        if (peerInfo.stableId === state.localPeerId) return;
        // Guard: don't duplicate existing connections
        if (state.peers.find(pe => pe.stableId === peerInfo.stableId)) return;
        console.log(`[mesh] Will connect to introduced peer ${peerInfo.stableId}`);
        // The broker will send us their offer via create-offer-for → broker-offer flow
        // We just pre-note we expect this peer
      });
      break;

    case 'peer-left':
      console.log(`[mesh] peer-left — stableId: ${msg.stableId}`);
      // Remove by stableId since that is what we reliably track
      const leftEntry = state.peers.find(pe => pe.stableId === msg.stableId);
      if (leftEntry) removePeer(leftEntry.id);
      addChatMessage('system', `${msg.name || 'A peer'} left`);
      break;

    // ── Selective muting ────────────────────────────────────────
    case 'mute-video':
      console.log(`[mesh] ${entry.id} asked us to pause video to them`);
      pauseTrackToPeer(entry.id, 'video');
      break;

    case 'unmute-video':
      console.log(`[mesh] ${entry.id} asked us to resume video to them`);
      resumeTrackToPeer(entry.id, 'video');
      break;

    case 'mute-audio':
      console.log(`[mesh] ${entry.id} asked us to pause audio to them`);
      pauseTrackToPeer(entry.id, 'audio');
      break;

    case 'unmute-audio':
      console.log(`[mesh] ${entry.id} asked us to resume audio to them`);
      resumeTrackToPeer(entry.id, 'audio');
      break;
  }
}

const seenMsgIds = new Set();

function broadcastChat(text) {
  const msgId = uuid();
  seenMsgIds.add(msgId); // mark as seen so we don't re-display if relayed back
  const payload = JSON.stringify({
    type:   'chat',
    text,
    name:   state.profile.name || 'You',
    sender: state.localPeerId,
    msgId,
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

  // Per-peer selective mute controls
  const peerControls = document.createElement('div');
  peerControls.className = 'tile-controls';

  const muteCamBtn = document.createElement('button');
  muteCamBtn.className = 'tile-btn';
  muteCamBtn.title = "Stop receiving their video";
  muteCamBtn.dataset.muteVideo = 'false';
  muteCamBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`;
  muteCamBtn.onclick = () => {
    const isMuted = muteCamBtn.dataset.muteVideo === 'true';
    const next = !isMuted;
    muteCamBtn.dataset.muteVideo = String(next);
    muteCamBtn.classList.toggle('muted', next);
    muteCamBtn.title = next ? 'Resume their video' : 'Stop receiving their video';
    // Tell that peer to stop/resume sending video to us
    sendMuteRequest(entry.id, 'video', next);
    // Visually hide their video tile
    if (entry.videoEl) entry.videoEl.style.visibility = next ? 'hidden' : 'visible';
    console.log(`[mute] ${next ? 'Muted' : 'Unmuted'} video from ${entry.id}`);
  };

  const muteAudioBtn = document.createElement('button');
  muteAudioBtn.className = 'tile-btn';
  muteAudioBtn.title = "Stop receiving their audio";
  muteAudioBtn.dataset.muteAudio = 'false';
  muteAudioBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4m-4 0h8"/></svg>`;
  muteAudioBtn.onclick = () => {
    const isMuted = muteAudioBtn.dataset.muteAudio === 'true';
    const next = !isMuted;
    muteAudioBtn.dataset.muteAudio = String(next);
    muteAudioBtn.classList.toggle('muted', next);
    muteAudioBtn.title = next ? 'Resume their audio' : 'Stop receiving their audio';
    sendMuteRequest(entry.id, 'audio', next);
    // Locally mute their audio track in the video element
    if (entry.videoEl) entry.videoEl.muted = next;
    console.log(`[mute] ${next ? 'Muted' : 'Unmuted'} audio from ${entry.id}`);
  };

  peerControls.appendChild(muteCamBtn);
  peerControls.appendChild(muteAudioBtn);
  overlay.appendChild(peerControls);
  overlay.appendChild(peerInfo);

  tile.appendChild(video);
  tile.appendChild(statusBadge);
  tile.appendChild(overlay);

  DOM.videoGrid.appendChild(tile);
  entry.videoEl = video;
  entry.statusEl = statusBadge;
  entry.tileEl = tile;
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

/* ═══════════════════════════════════════════════════ PRE-CALL PROFILE CHECK */
function checkProfileBeforeCall(onProceed) {
  if (profileExplicitlySet()) {
    console.log(`[profile] Already set as "${state.profile.name}" — proceeding`);
    onProceed();
    return;
  }

  console.log('[profile] Not explicitly set — showing pre-call prompt');
  DOM.signalingTitle.textContent = 'Before you join…';
  DOM.signalingBody.innerHTML = `
    <div style="
      background:var(--bg-3);
      border:1px solid var(--border-hi);
      border-radius:var(--radius);
      padding:1rem 1.1rem;
      margin-bottom:.75rem;
      display:flex;
      align-items:center;
      gap:.85rem;">
      <span style="font-size:2rem;line-height:1;">👤</span>
      <div>
        <div style="font-weight:700;font-size:.95rem;margin-bottom:.2rem;">
          You are joining as <span style="color:var(--accent);">"Anonymous"</span>
        </div>
        <div style="font-size:.82rem;color:var(--txt-2);line-height:1.5;">
          People in the call won't know who you are.<br/>
          You can set your name now — this cannot be changed once the call starts.
        </div>
      </div>
    </div>

    <label class="field-label">Your Name</label>
    <input
      type="text"
      id="preCallName"
      class="text-input"
      placeholder="Enter your name…"
      maxlength="32"
      style="margin-top:.35rem;"
      value="${state.profile.name !== 'Anonymous' ? state.profile.name : ''}"
    />

    <label class="field-label" style="margin-top:1rem;">Avatar <span style="color:var(--txt-3);font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
    <div class="avatar-picker" style="margin-top:.4rem;">
      <div class="avatar-preview" id="preCallAvatarPreview">
        ${state.profile.avatar
          ? `<img src="${state.profile.avatar}" alt="avatar"/>`
          : (state.profile.name !== 'Anonymous' ? state.profile.name.charAt(0).toUpperCase() : '?')}
      </div>
      <div class="avatar-actions">
        <label class="btn btn-ghost sm" for="preCallAvatarFile">Upload image</label>
        <input type="file" id="preCallAvatarFile" accept="image/*" style="display:none;" />
      </div>
    </div>

    <div class="btn-row" style="margin-top:1.4rem;">
      <button class="btn btn-primary" id="btnPreCallSave">
        Save &amp; Continue →
      </button>
      <button class="btn btn-ghost sm" id="btnPreCallSkip">
        Continue as Anonymous
      </button>
    </div>`;

  showModal('signalingModal');

  // Avatar upload inside pre-call prompt
  let pendingAvatar = state.profile.avatar || '';
  $('preCallAvatarFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = Math.min(MAX_AVATAR_PX, img.width, img.height);
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const s = Math.min(img.width, img.height);
        const ox = (img.width - s) / 2, oy = (img.height - s) / 2;
        ctx.drawImage(img, ox, oy, s, s, 0, 0, size, size);
        pendingAvatar = canvas.toDataURL('image/jpeg', 0.7);
        const prev = $('preCallAvatarPreview');
        if (prev) prev.innerHTML = `<img src="${pendingAvatar}" alt="avatar"/>`;
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  $('btnPreCallSave').onclick = () => {
    const nameVal = ($('preCallName').value || '').trim();
    const profile = {
      name:   nameVal || 'Anonymous',
      avatar: pendingAvatar,
    };
    saveProfile(profile);
    renderLocalProfile();
    console.log(`[profile] Pre-call profile saved — name: "${profile.name}"`);
    // Replace body with loading spinner immediately
    showSignalingModalLoading();
    onProceed();
  };

  $('btnPreCallSkip').onclick = () => {
    // Mark as explicitly set so we don't nag again
    localStorage.setItem('nexusmesh_profile_set', 'true');
    console.log('[profile] User chose to continue as Anonymous');
    showSignalingModalLoading();
    onProceed();
  };
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
  if (!isAddPeer) {
    showCallScreen();
    lockSettingsDuringCall();
    // Only show loading/request permissions if we don't have a stream yet
    if (!state.localStream) {
      showSignalingModalLoading();
      await startLocalMedia();
    }
  }

  const link = await createOrRefreshRoom();
  if (!link) return;

  showSignalingModal('offer-ntfy', {
    link,
    roomId: state.room.id,
  });
}


/**
 * JOINER FLOW:
 *  1. Decode offer from URL hash or textarea
 *  2. Create peer, set remote description
 *  3. Create answer, wait for ICE
 *  4. Encode answer → share back
 */
async function joinCall(offerData, roomId) {
  lockSettingsDuringCall();
  await startLocalMedia();
  showCallScreen();
  hideModal('signalingModal');

  const entry = createPeer(offerData.peerId || uuid());
  entry.roomId = roomId;
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => entry.pc.addTrack(t, state.localStream));
  }

  await entry.pc.setRemoteDescription(new RTCSessionDescription({
    type: 'offer', sdp: offerData.sdp.sdp || offerData.sdp,
  }));
  attachPeerTile(entry);

  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);

  await waitForICE(entry.pc);

  const finalSDP = entry.pc.localDescription;
  const answerPayload = { type: 'answer', sdp: finalSDP, peerId: entry.id, fromId: state.localPeerId };

  // Publish answer automatically — no manual step needed
  try {
    await ntfyPublish(roomId, 'answer', answerPayload);
    toast('Answer sent — connecting…', 'success');
  } catch (e) {
    // ntfy failed — fall back to manual
    const encoded = encode(answerPayload);
    const link = buildLink(encoded);
    showSignalingModal('answer', { entry, encoded, link });
    toast('Auto-connect failed — share answer manually', 'error');
    console.error(e);
  }
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
async function generateManualOffer() {
  // Create a fresh peer connection for manual signaling fallback
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  }
  pc.createDataChannel('nexus', { ordered: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForICE(pc);
  const payload = {
    type:   'offer',
    sdp:    pc.localDescription,
    peerId: uuid(),
    fromId: state.localPeerId,
  };
  // Store so we can finalize if someone uses the manual code
  state.room._manualPC = pc;
  state.room._manualPeerId = payload.peerId;
  return encode(payload);
}

function showSignalingModalLoading() {
  DOM.signalingTitle.textContent = 'Preparing Call…';
  DOM.signalingBody.innerHTML = `
    <div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 0;">
      <span class="conn-dot connecting" style="width:10px;height:10px;flex-shrink:0;"></span>
      <span style="font-family:var(--font-mono);font-size:.88rem;color:var(--txt-2);">
        Requesting camera and microphone…
      </span>
    </div>`;
  showModal('signalingModal');
}

function showSignalingModal(mode, ctx) {
  DOM.signalingTitle.textContent = mode === 'offer' ? 'Share Invite' :
    mode === 'answer' ? 'Send Your Answer' : 'Add Peer';

  const body = DOM.signalingBody;
  body.innerHTML = '';

  if (mode === 'offer-ntfy') {
    // Calculate time remaining
    const msLeft     = state.room.expiresAt ? Math.max(0, state.room.expiresAt - Date.now()) : NTFY_TTL_MS;
    const minLeft    = Math.max(1, Math.ceil(msLeft / 60000));
    const expiresTxt = `expires in ~${minLeft} min`;

    body.innerHTML = `
      <p class="step-label">Room Link</p>
      <p class="step-desc">
        Share this link — anyone who opens it joins the call automatically.
        The link is reusable until it expires.
      </p>
      <div class="link-box">
        <input type="text" id="offerLinkInput" readonly value="${ctx.link}" />
        <button class="btn btn-primary sm" id="btnCopyLink">Copy</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:.6rem;">
        <div style="display:flex;align-items:center;gap:.6rem;">
          <span class="conn-dot connecting" style="width:8px;height:8px;flex-shrink:0;"></span>
          <span style="font-size:.78rem;color:var(--txt-2);font-family:var(--font-mono);">
            Listening for new peers…
          </span>
        </div>
        <span style="font-size:.75rem;font-family:var(--font-mono);color:var(--txt-3);" id="roomExpiry">
          ${expiresTxt}
        </span>
      </div>
      <div class="btn-row" style="margin-top:1rem;">
        <button class="btn btn-ghost sm" id="btnRefreshRoom">↻ Refresh link</button>
        <button class="btn btn-ghost sm" id="btnHideInvite">Hide panel</button>
      </div>
      <div class="divider"><span>manual fallback</span></div>
      <p class="step-desc" style="font-size:.82rem;color:var(--txt-2);">
        If the link doesn't work, ask your peer to click
        <strong>Join a Call</strong> and paste the code below.
      </p>
      <p class="step-label">Join Code</p>
      <textarea class="sig-box" id="manualOfferBox" readonly style="min-height:70px;font-size:.72rem;"></textarea>
      <div class="btn-row">
        <button class="btn btn-ghost sm" id="btnCopyManualOffer">Copy Code</button>
      </div>`;

    showModal('signalingModal');

    $('btnCopyLink').onclick    = () => copyToClipboard(ctx.link);
    $('btnRefreshRoom').onclick = async () => {
      state.room.expiresAt = 0;
      await initiateCall(true);
    };
    $('btnHideInvite').onclick  = () => hideModal('signalingModal');

    // Populate manual offer code asynchronously
    generateManualOffer().then(code => {
      const box = $('manualOfferBox');
      if (box) box.value = code || '';
    });
    $('btnCopyManualOffer').onclick = () => {
      const box = $('manualOfferBox');
      if (box?.value) copyToClipboard(box.value);
    };

    // Live countdown — clears itself when element is gone
    if (state.room._countdownTimer) clearInterval(state.room._countdownTimer);
    state.room._countdownTimer = setInterval(() => {
      const el = $('roomExpiry');
      if (!el) {
        clearInterval(state.room._countdownTimer);
        state.room._countdownTimer = null;
        return;
      }
      const ms  = state.room.expiresAt ? Math.max(0, state.room.expiresAt - Date.now()) : 0;
      const min = Math.max(1, Math.ceil(ms / 60000));
      el.textContent = ms > 0 ? `expires in ~${min} min` : 'expired — click Refresh';
      el.style.color = ms < 120000 ? 'var(--danger)' : 'var(--txt-3)';
    }, 30000);

    return;
  }

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

/* ═══════════════════════════════════════════════════ MESH BROKERING */

// Called by A when a new peer (C) connects — introduce C to all existing peers
function brokerIntroductions(newEntry) {
  const existingPeers = state.peers.filter(pe =>
    pe.id !== newEntry.id &&
    pe.status === 'connected' &&
    pe.stableId // only peers whose identity we know
  );

  if (existingPeers.length === 0) {
    console.log('[mesh] No existing peers to introduce');
    return;
  }
  console.log(`[mesh] Brokering — new peer stableId: ${newEntry.stableId}, existing: ${existingPeers.length}`);

  // Tell new peer about everyone already here (using stable IDs)
  const peerList = existingPeers.map(pe => ({
    stableId: pe.stableId,
    name:     pe.info?.name || 'Unknown',
  }));

  if (newEntry.dc?.readyState === 'open') {
    newEntry.dc.send(JSON.stringify({
      type:        'introduce-peers',
      peers:       peerList,
      brokerId:    state.localPeerId, // so they know who to route through
    }));
    console.log(`[mesh] Sent peer list to ${newEntry.stableId}`);
  }

  // Tell each existing peer to create an offer for the new peer
  existingPeers.forEach(pe => {
    if (pe.dc?.readyState === 'open') {
      pe.dc.send(JSON.stringify({
        type:           'create-offer-for',
        targetStableId: newEntry.stableId,  // who to connect to
        brokerId:       state.localPeerId,  // route back through me
      }));
      console.log(`[mesh] Asked ${pe.stableId} to create offer for ${newEntry.stableId}`);
    }
  });
}

// C received introduction list — prepare to receive offers from each peer
function handleIntroduction(peerInfo) {
  console.log(`[mesh] Preparing for introduction to ${peerInfo.peerId}`);
  // Pre-create the peer entry so we are ready to receive the brokered offer
  if (!state.peers.find(pe => pe.id === peerInfo.peerId)) {
    const entry = createPeer(peerInfo.peerId);
    entry.isBrokered = true;
    console.log(`[mesh] Pre-created peer entry for ${peerInfo.peerId}`);
  }
}

// Existing peer (B) received instruction to create offer for new peer (C)
async function createBrokeredOffer(targetStableId, brokerId, brokerEntry) {
  console.log(`[mesh] Creating brokered offer for stableId: ${targetStableId}`);

  // Check we don't already have a connection to this stable peer
  if (state.peers.find(pe => pe.stableId === targetStableId)) {
    console.log(`[mesh] Already have connection to ${targetStableId} — skipping`);
    return;
  }

  const connId = uuid();
  const entry = createPeer(connId);
  entry.stableId = targetStableId;
  entry.isBrokered = true;
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => entry.pc.addTrack(t, state.localStream));
  }

  entry.dc = entry.pc.createDataChannel('nexus', { ordered: true });
  setupDataChannel(entry);

  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  await waitForICE(entry.pc);

  const finalSDP = entry.pc.localDescription;

  entry.pc.onicecandidate = e => {
    if (!e.candidate || !brokerEntry.dc || brokerEntry.dc.readyState !== 'open') return;
    brokerEntry.dc.send(JSON.stringify({
      type:            'broker-ice',
      fromStableId:    state.localPeerId,
      targetStableId:  targetStableId,
      candidate:       e.candidate,
    }));
  };

  if (brokerEntry.dc?.readyState === 'open') {
    brokerEntry.dc.send(JSON.stringify({
      type:            'broker-offer',
      fromStableId:    state.localPeerId,
      targetStableId:  targetStableId,
      sdp:             finalSDP,
    }));
    console.log(`[mesh] Sent broker-offer via ${brokerEntry.stableId} for ${targetStableId}`);
  }
}

// C receives a brokered offer from B (forwarded by A)
async function handleBrokeredOffer(brokerEntry, msg) {
  console.log(`[mesh] Handling brokered offer from ${msg.fromStableId}`);

  // Check we don't already have this connection
  if (state.peers.find(pe => pe.stableId === msg.fromStableId)) {
    console.log(`[mesh] Already connected to ${msg.fromStableId} — ignoring duplicate offer`);
    return;
  }

  const connId = uuid();
  const entry = createPeer(connId);
  entry.stableId = msg.fromStableId;
  entry.isBrokered = true;
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => entry.pc.addTrack(t, state.localStream));
  }

  await entry.pc.setRemoteDescription(new RTCSessionDescription({
    type: 'offer', sdp: msg.sdp.sdp || msg.sdp,
  }));
  attachPeerTile(entry);

  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);
  await waitForICE(entry.pc);

  const finalSDP = entry.pc.localDescription;

  entry.pc.onicecandidate = e => {
    if (!e.candidate || !brokerEntry.dc || brokerEntry.dc.readyState !== 'open') return;
    brokerEntry.dc.send(JSON.stringify({
      type:           'broker-ice',
      fromStableId:   state.localPeerId,
      targetStableId: msg.fromStableId,
      candidate:      e.candidate,
    }));
  };

  if (brokerEntry.dc?.readyState === 'open') {
    brokerEntry.dc.send(JSON.stringify({
      type:           'broker-answer',
      fromStableId:   state.localPeerId,
      targetStableId: msg.fromStableId,
      sdp:            finalSDP,
    }));
    console.log(`[mesh] Sent broker-answer via ${brokerEntry.stableId}`);
  }
}

// B receives the answer from C (forwarded by A) — finalize B↔C connection
async function handleBrokeredAnswer(msg) {
  const entry = state.peers.find(pe => pe.stableId === msg.fromStableId);
  if (!entry) {
    console.warn(`[mesh] broker-answer — no entry for stableId ${msg.fromStableId}`);
    return;
  }
  await entry.pc.setRemoteDescription(new RTCSessionDescription({
    type: 'answer', sdp: msg.sdp.sdp || msg.sdp,
  }));
  attachPeerTile(entry);
  console.log(`[mesh] ✓ Brokered connection finalized with ${msg.fromStableId}`);
}

// Apply a relayed ICE candidate
async function handleBrokeredIce(msg) {
  const entry = state.peers.find(pe => pe.stableId === msg.targetStableId);
  if (!entry) {
    console.warn(`[mesh] broker-ice — no entry for stableId ${msg.targetStableId}`);
    return;
  }
  try {
    await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch (e) {
    console.warn(`[mesh] ICE candidate failed:`, e);
  }
}


// A needs to forward broker messages between B and C
function forwardBrokerMessage(fromEntry, msg) {
  const targetEntry = state.peers.find(pe => pe.id === msg.targetId);
  if (!targetEntry) {
    console.warn(`[mesh] forward — no entry for target ${msg.targetId}`);
    return;
  }
  if (targetEntry.dc?.readyState === 'open') {
    // Rewrite fromId so the recipient knows who it came from
    targetEntry.dc.send(JSON.stringify({ ...msg, brokeredBy: fromEntry.id }));
    console.log(`[mesh] Forwarded ${msg.type} from ${fromEntry.id} → ${msg.targetId}`);
  }
}

/* ═══════════════════════════════════════════════════ SELECTIVE MUTING */

function pauseTrackToPeer(peerId, kind) {
  const entry = state.peers.find(pe => pe.id === peerId);
  if (!entry) return;
  const sender = entry.pc.getSenders().find(s => s.track?.kind === kind);
  if (sender) {
    sender.replaceTrack(null);
    console.log(`[mute] Paused ${kind} track to ${peerId}`);
  }
}

function resumeTrackToPeer(peerId, kind) {
  const entry = state.peers.find(pe => pe.id === peerId);
  if (!entry) return;
  const track = kind === 'video'
    ? (state.screenStream?.getVideoTracks()[0] || state.localStream?.getVideoTracks()[0])
    : state.localStream?.getAudioTracks()[0];
  if (!track) return;
  const sender = entry.pc.getSenders().find(s => s.track === null && s.track?.kind === kind)
    || entry.pc.getSenders().find(s => {
        // find the right kind sender even if track is null
        const params = s.getParameters();
        return params?.encodings && kind === 'video'
          ? !entry.pc.getSenders().find(x => x !== s && x.track?.kind === 'audio')
          : true;
      });
  // More reliable: find sender by checking transceiver direction
  const transceiver = entry.pc.getTransceivers().find(t =>
    t.sender === entry.pc.getSenders().find(s =>
      (s.track?.kind === kind) || (s.track === null)
    ) && t.receiver.track?.kind === kind
  );
  const correctSender = entry.pc.getSenders().find(s =>
    s.track?.kind === kind || (s.track === null && kind === (transceiver?.receiver.track?.kind))
  );
  if (correctSender) {
    correctSender.replaceTrack(track);
    console.log(`[mute] Resumed ${kind} track to ${peerId}`);
  }
}

// Send a mute/unmute request to a specific peer
function sendMuteRequest(peerId, kind, mute) {
  const entry = state.peers.find(pe => pe.id === peerId);
  if (!entry?.dc || entry.dc.readyState !== 'open') return;
  const type = `${mute ? 'mute' : 'unmute'}-${kind}`;
  entry.dc.send(JSON.stringify({ type }));
  console.log(`[mute] Sent ${type} request to ${peerId}`);
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
    name:   DOM.settingsName.value.trim() || 'Anonymous',
    avatar: state._pendingAvatar !== undefined ? state._pendingAvatar : state.profile.avatar,
  };
  saveProfile(profile);
  state._pendingAvatar = undefined;
  renderLocalProfile();
  // No re-broadcast — profile is immutable once call starts
  hideModal('settingsModal');
  toast('Profile saved!', 'success');
});

/* ═══════════════════════════════════════════════════ END CALL */
function endCall() {
  // Notify all peers before closing
  const leaveMsg = JSON.stringify({
    type:     'peer-left',
    stableId: state.localPeerId,
    name:     state.profile.name,
  });
  state.peers.forEach(pe => {
    if (pe.dc?.readyState === 'open') pe.dc.send(leaveMsg);
    pe.pc.close();
  });
  state.localPeerId = null;

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
  stopRoom();
  history.replaceState(null, '', location.pathname);
  refreshGridClass();
  unlockSettings();
  showSplash();
}

/* ═══════════════════════════════════════════════════ AUTO-JOIN FROM HASH */
function checkUrlHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  history.replaceState(null, '', location.pathname);

  // New flow — short room link
  if (hash.startsWith('room:')) {
    const roomId = hash.slice(5);
    if (!roomId) return;
    checkProfileBeforeCall(() => joinRoom(roomId));
    return;
  }

  // Legacy flow — full SDP in hash (pako encoded)
  const data = decode(hash);
  if (!data) return;
  if (data.type === 'offer') {
    DOM.btnJoinFromSplash.click();
    setTimeout(() => joinCall(data, null), 600);
  }
}

function showJoinSpinner(roomId) {
  // Show a "fetching offer…" state on the splash while ntfy delivers
  DOM.signalingTitle.textContent = 'Joining Call…';
  DOM.signalingBody.innerHTML = `
    <div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 0;">
      <span class="conn-dot connecting" style="width:10px;height:10px;flex-shrink:0;"></span>
      <span style="font-family:var(--font-mono);font-size:.88rem;color:var(--txt-2);">
        Fetching invite from ntfy.sh…
      </span>
    </div>
    <p class="step-desc">This only takes a moment. If it hangs, the invite may have expired (5 min limit).</p>
    <div class="btn-row" style="margin-top:.5rem;">
      <button class="btn btn-ghost sm" id="btnCancelJoin">Cancel</button>
    </div>`;
  showModal('signalingModal');

  $('btnCancelJoin').onclick = () => {
    listener.close();
    hideModal('signalingModal');
  };

  const listener = ntfyListen(roomId, 'offer', async (offerData) => {
    hideModal('signalingModal');
    lockSettingsDuringCall();
    await startLocalMedia();
    showCallScreen();
    await joinCall(offerData, roomId);
  }, (err) => {
    console.error('Offer fetch error:', err);
    $('btnCancelJoin')?.closest('.modal-body')
      ?.querySelector('div')
      ?.querySelector('span:last-child')
      && ($('btnCancelJoin').closest('.modal-body').querySelector('[style*="font-mono"]').textContent
        = 'Failed to fetch invite — ask for the manual code.');
    toast('Could not fetch invite — use manual code', 'error');
  });
}

/* ═══════════════════════════════════════════════════ EVENT WIRING */

// Splash
DOM.btnInitiate.onclick = () => {
  checkProfileBeforeCall(() => initiateCall(false));
};

DOM.btnJoinFromSplash.onclick = () => {
  checkProfileBeforeCall(async () => {
    showCallScreen();
    openJoinModal();
  });
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
    if (!data) { toast('Invalid code', 'error'); return; }
    hideModal('signalingModal');
    if (data.type === 'offer') {
      await joinCall(data, null);
    } else if (data.type === 'room-offer' && data.roomId) {
      await joinRoom(data.roomId);
    } else {
      toast('Unrecognised code format', 'error');
    }
  };
}

DOM.btnToggleSignaling.onclick = toggleSignalingModal;
// Topbar
DOM.btnAddPeer.onclick = async () => {
  // If modal already open just toggle it
  if (DOM.signalingModal.classList.contains('open')) {
    hideModal('signalingModal');
    return;
  }
  // Refresh room offer if expired or not yet created
  const needsRefresh = !state.room.expiresAt || Date.now() >= state.room.expiresAt;
  if (needsRefresh) {
    console.log('[room] Link expired or missing — regenerating before showing panel');
    state.room.expiresAt = 0; // force refresh
  }
  await initiateCall(true);
};
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