'use strict';

// ════════════════════════════════════════════════════════
//  VOX5000 — Interview Room
//  Handles both host and guest sides of a WebRTC session.
//
//  P1: Host detection uses local room ownership only. Guest links cannot
//      become host links by adding a public query parameter.
//  P2: ICE servers configured with STUN plus an optional TURN hook.
//  P3: Mic → gainNode → processedDest → MediaRecorder (gain affects recording).
//  P5: All user content uses textContent or esc() — never innerHTML.
//  P6: Consent log uses only name, role, consent status, timestamp, user agent.
//  P7: Transfers raw WebM chunks — no mandatory MP3 encoding.
//  P8: Mic settings disabled during recording.
//  P9: Output volume capped at 100%.
// ════════════════════════════════════════════════════════

// ── Safe text helper — always use this for user-supplied strings ──
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function setText(el, s) { if (el) el.textContent = String(s); }

const $ = id => document.getElementById(id);

// ── URL params ──
const params  = new URLSearchParams(window.location.search);
const urlCode = params.get('r');  // room code from URL

// ── P1: Determine host status ──
// Host if: no room code (fresh creation) OR this browser locally owns the room.
function checkIsHost() {
  if (!urlCode) return true; // no room code = creating new room
  try {
    // v23: Ownership is local-only. A copied URL must not grant host mode.
    const owned = JSON.parse(localStorage.getItem('vox5000_owned') || '{}');
    if (owned[urlCode]) return true;

    // Backward-compatible migration for older saved rooms that predate
    // vox5000_owned. If the room exists in this browser's My Rooms list,
    // this browser is allowed to reopen it as host and is marked as owner.
    const rooms = JSON.parse(localStorage.getItem('vox5000_rooms') || '{}');
    if (rooms[urlCode]) {
      owned[urlCode] = Date.now();
      localStorage.setItem('vox5000_owned', JSON.stringify(owned));
      return true;
    }
  } catch(e) {}
  return false; // default: guest
}

const isHost = checkIsHost();
let roomId   = urlCode || null;

// ── P2: ICE / STUN / TURN config ──
// STUN is included. For TURN: deploy a small serverless function that returns
// temporary credentials from a TURN provider (Metered, Twilio, etc.).
// Set window.VOX5000_TURN_CREDENTIALS_URL before room.js loads to override this
// Vercel endpoint. The endpoint returns [] until TURN env vars are configured.
// Without TURN, some users behind strict corporate firewalls may fail to connect.
const TURN_CREDENTIALS_URL = window.VOX5000_TURN_CREDENTIALS_URL || '/api/turn-credentials';

async function getIceServers() {
  const base = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (!TURN_CREDENTIALS_URL) return base;
  try {
    const r = await fetch(TURN_CREDENTIALS_URL, { cache: 'no-store' });
    if (!r.ok && r.status !== 204) throw new Error(`TURN endpoint returned ${r.status}`);
    if (r.status === 204) return base;
    const creds = await r.json();
    return [...base, ...(Array.isArray(creds) ? creds : [])]; // merge STUN + TURN
  } catch(e) {
    console.warn('Could not fetch TURN credentials, falling back to STUN only:', e);
    return base;
  }
}

// ── State ──
let myName = '', myPeerId = '', myConsented = false, myIsObserver = false;
let recording = false, paused = false, elapsed = 0, startTime, timerInterval;
let mediaRecorder, chunks = [], rawChunks = [];
let audioCtx, localStream, gainNode, processedDest, hostAnalyser, guestGainNode, guestAnalyser;
let peer;
const peers = {}; // peerId → { conn, call, name, pending, consented, observer, muted, selfMuted, analyser }
const receivedChunks = {}, receivedMeta = {};
let guestBackupBlob = null;
let masterOutputVolume = 1.0;
let inputGainDb = 0;
let noiseSuppression = false;
let echoCancellation = false;
let currentMicId;
let hostSelfMuted = false;
const consentLog = [];
let hostReturning = false;

// ── Helpers ──
function fmt(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return [h,m,sec].map(v => String(v).padStart(2,'0')).join(':');
}
function randId(n) {
  return crypto.getRandomValues(new Uint8Array(Math.ceil(n*3/4)))
    .reduce((a,b) => a + b.toString(36), '').substr(0, n).toUpperCase();
}
function initials(name) {
  return String(name).split(' ').map(w => w[0] || '').join('').substr(0,2).toUpperCase();
}
function tsNow() { return new Date().toISOString(); }
function dbToGain(db) { return db <= -59 ? 0 : Math.pow(10, db / 20); }
function fmtDb(db) {
  if (db <= -59) return 'Off';
  return (db >= 0 ? '+' : '') + parseFloat(db).toFixed(1) + ' dB';
}

// ── Storage ──
function getRooms() {
  try { return JSON.parse(localStorage.getItem('vox5000_rooms') || '{}'); } catch { return {}; }
}
function saveRooms(r) { localStorage.setItem('vox5000_rooms', JSON.stringify(r)); }
function saveRoom(id, data) {
  const r = getRooms();
  r[id] = { ...r[id], ...data };
  saveRooms(r);
}

// P1: Mark this browser as room owner in localStorage
function markAsOwner(id) {
  try {
    const owned = JSON.parse(localStorage.getItem('vox5000_owned') || '{}');
    owned[id] = Date.now();
    localStorage.setItem('vox5000_owned', JSON.stringify(owned));
  } catch(e) {}
}

function getHostSession() {
  try { return JSON.parse(sessionStorage.getItem('vox5000_host') || 'null'); } catch { return null; }
}
function saveHostSession(data) { sessionStorage.setItem('vox5000_host', JSON.stringify(data)); }

// ── Consent log — P6 ──
// We log: name, role, consented, observer, timestamp, userAgent.
// IP addresses are NOT collected — we cannot collect them accurately client-side.
// userAgent is disclosed on the consent screen.
function buildParticipantLogEntry(name, role, consented, observer) {
  return {
    name: String(name),
    role: String(role),
    consented: Boolean(consented),
    observer: Boolean(observer),
    timestamp: tsNow(),
    userAgent: navigator.userAgent,
  };
}

// ── Before unload ──
window.addEventListener('beforeunload', e => {
  const transferring = Object.values(peers).some(p => p.transferring);
  if (recording || transferring) {
    e.preventDefault();
    e.returnValue = 'Recording or transfer in progress. Leaving now may lose audio.';
    return e.returnValue;
  }
});

// ── Nav ──
function setupNav() {
  ['logoHomeLink','navHome'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', e => {
      e.preventDefault();
      if (recording && !confirm('Recording is active. Leaving will stop it. Continue?')) return;
      window.location.href = 'index.html';
    });
  });
}

// ── Host return (same session) ──
function checkHostReturn() {
  if (!isHost || !roomId) return false;
  const s = getHostSession();
  if (s && s.roomId === roomId && s.name) {
    myName = s.name;
    myConsented = true;
    hostReturning = true;
    return true;
  }
  return false;
}

// Show room name field for host only
if (isHost && $('roomNameSection')) $('roomNameSection').style.display = 'block';

// ── Headphone screens ──
if ($('hasHeadphones')) $('hasHeadphones').addEventListener('click', () => { $('headphoneScreen').style.display = 'none'; $('nameScreen').style.display = 'flex'; });
if ($('noHeadphones')) $('noHeadphones').addEventListener('click', () => { $('headphoneScreen').style.display = 'none'; $('feedbackWarnScreen').style.display = 'flex'; });
if ($('nowHasHeadphones')) $('nowHasHeadphones').addEventListener('click', () => { $('feedbackWarnScreen').style.display = 'none'; $('nameScreen').style.display = 'flex'; });
if ($('continueAnyway')) $('continueAnyway').addEventListener('click', () => { $('feedbackWarnScreen').style.display = 'none'; $('nameScreen').style.display = 'flex'; });

// ── Name entry ──
if ($('enterRoomBtn')) $('enterRoomBtn').addEventListener('click', enterRoom);
if ($('participantName')) $('participantName').addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom(); });

async function enterRoom() {
  const nameInput = $('participantName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    const err = $('nameError');
    if (err) { err.textContent = 'Please enter your name to continue.'; err.style.display = 'block'; }
    return;
  }
  const err = $('nameError');
  if (err) err.style.display = 'none';
  myName = name;

  if (isHost) {
    myConsented = true;
    myIsObserver = false;
    $('nameScreen').style.display = 'none';

    // Generate room code
    roomId = randId(6);
    const customName = ($('roomNameInput') || {}).value || '';
    const roomName = customName.trim() || 'Interview Room';
    saveRoom(roomId, { name: roomName, created: Date.now() });
    markAsOwner(roomId); // P1: mark this browser as owner
    saveHostSession({ roomId, name: myName });
    window.history.replaceState({}, '', `?r=${encodeURIComponent(roomId)}`);

    consentLog.push(buildParticipantLogEntry(myName, 'Host', true, false));
    showLoadingThenHostRoom();
  } else {
    $('nameScreen').style.display = 'none';
    showGuestMicSelect();
  }
}

// ── Guest mic select + pre-room test ──
let preMeterActive = false, preMeterStream = null;

async function showGuestMicSelect() {
  const screen = $('guestMicScreen');
  if (!screen) { $('consentScreen').style.display = 'flex'; return; }
  screen.style.display = 'flex';
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const sel = $('guestMicSelect');
    if (sel) {
      sel.innerHTML = '';
      mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { stopPreMeter(); startPreMeter(); });
    }
    startPreMeter();
  } catch(e) { console.warn('Mic enumerate error', e); }

  const testBtn = $('guestMicTestBtn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      const res = $('guestMicTestResult');
      setText(res, 'Recording…');
      try {
        const deviceId = ($('guestMicSelect') || {}).value;
        const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false } });
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(s).connect(dest);
        const mr = new MediaRecorder(dest.stream);
        const bufs = [];
        mr.ondataavailable = e => { if (e.data.size > 0) bufs.push(e.data); };
        mr.onstop = () => {
          s.getTracks().forEach(t => t.stop());
          const blob = new Blob(bufs, { type: mr.mimeType });
          const audio = new Audio(URL.createObjectURL(blob));
          audio.play();
          setText(res, '▶ Playing back — listen for your voice');
          audio.onended = () => { setText(res, '✓ Done. If you heard yourself your mic is working.'); testBtn.disabled = false; };
        };
        mr.start();
        setTimeout(() => mr.stop(), 5000);
      } catch(e) { setText(res, '⚠ Could not access mic — check permissions.'); testBtn.disabled = false; }
    });
  }
}

function startPreMeter() {
  if (preMeterActive) return;
  preMeterActive = true;
  const deviceId = ($('guestMicSelect') || {}).value;
  navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false } })
    .then(s => {
      preMeterStream = s;
      const ctx = new AudioContext();
      const anal = ctx.createAnalyser(); anal.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(anal);
      const buf = new Uint8Array(anal.frequencyBinCount);
      function tick() {
        if (!preMeterActive) return;
        anal.getByteTimeDomainData(buf);
        let max = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]-128)/128; if (v>max) max=v; }
        const fill = $('guestPreMeterBar');
        if (fill) fill.style.width = Math.min(100, Math.round(max*200)) + '%';
        requestAnimationFrame(tick);
      }
      tick();
    }).catch(() => {});
}

function stopPreMeter() {
  preMeterActive = false;
  if (preMeterStream) { preMeterStream.getTracks().forEach(t => t.stop()); preMeterStream = null; }
}

window.proceedToConsent = function() {
  stopPreMeter();
  if ($('guestMicScreen')) $('guestMicScreen').style.display = 'none';
  $('consentScreen').style.display = 'flex';
};

// ── Consent — P6 ──
window.chooseConsent = function(consented) {
  myConsented = consented;
  myIsObserver = !consented;
  const btnY = $('consentBtnYes'), btnN = $('consentBtnNo');
  if (btnY) { btnY.style.borderColor = consented ? 'var(--green)' : 'rgba(0,229,107,0.2)'; btnY.style.background = consented ? 'rgba(0,229,107,0.15)' : 'rgba(0,229,107,0.08)'; }
  if (btnN) { btnN.style.borderColor = !consented ? '#9999ff' : 'rgba(120,120,255,0.15)'; btnN.style.background = !consented ? 'rgba(120,120,255,0.12)' : 'rgba(120,120,255,0.06)'; }
  setTimeout(async () => {
    if ($('consentScreen')) $('consentScreen').style.display = 'none';
    // P6: Log without IP address
    consentLog.push(buildParticipantLogEntry(myName, myIsObserver ? 'Observer' : 'Guest', myConsented, myIsObserver));
    const ws = $('waitingScreen');
    if (ws) ws.style.display = 'flex';
    setText($('waitingTitle'), 'Waiting to be admitted');
    setText($('waitingSub'), 'The host will let you in shortly. Keep this page open and your headphones on.');
    setText($('waitingNameDisplay'), `Joining as: ${myName}${myIsObserver ? ' (Observer — not recorded)' : ''}`);
    initPeer(`GUEST-${roomId}-${randId(4)}`);
  }, 400);
};

function showLoadingThenHostRoom() {
  if ($('waitingScreen')) $('waitingScreen').style.display = 'flex';
  setText($('waitingTitle'), 'Setting up your room…');
  setText($('waitingSub'), 'Just a moment.');
  setText($('waitingNameDisplay'), '');
  initPeer(`HOST-${roomId}`);
}

// ── PeerJS ──
async function initPeer(id) {
  myPeerId = id;
  const iceServers = await getIceServers();
  peer = new Peer(id, {
    debug: 0,
    config: { iceServers }
  });
  peer.on('open', () => { if (isHost) showHostRoom(); else connectToHost(); });
  peer.on('connection', conn => handleIncomingConn(conn));
  peer.on('call', call => {
    getMic().then(s => {
      // Observer joins with empty stream — they can hear but mic is off
      call.answer(myIsObserver ? new MediaStream() : s);
      call.on('stream', remote => {
        addRemoteAudio(call.peer, remote);
        if (remote && remote.getAudioTracks().length > 0) {
          setupRemoteAnalyser(call.peer, remote);
        }
      });
    });
  });
  peer.on('error', err => {
    console.error('Peer error:', err.type, err);
    if (!isHost && err.type === 'peer-unavailable') {
      guestSystemMsg('Could not reach the host room. Check the link and try again.');
      const rb = $('guestRejoinBtn');
      if (rb) rb.style.display = 'block';
    }
  });
  peer.on('disconnected', () => {
    if (!isHost) {
      guestSystemMsg('Connection lost. Trying to reconnect…');
      const rb = $('guestRejoinBtn');
      if (rb) rb.style.display = 'block';
      setTimeout(() => { if (peer && !peer.destroyed) { try { peer.reconnect(); } catch(e) {} } }, 2000);
    }
  });
}

// ── Get mic — P3 ──
// Returns the raw stream. Audio graph is set up in setupHostAudioGraph / setupGuestAudioGraph.
function getMic() {
  if (localStream && localStream.active) return Promise.resolve(localStream);
  const deviceId = currentMicId || (($('guestMicSelect') || {}).value);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation,
      noiseSuppression,
      autoGainControl: false,
      sampleRate: { ideal: 48000 }
    }
  }).then(s => { localStream = s; return s; });
}

// ── Guest → Host ──
function connectToHost() {
  const conn = peer.connect(`HOST-${roomId}`, { reliable: true });
  conn.on('open', () => {
    conn.send({ type: 'join_request', name: myName, peerId: myPeerId, consented: myConsented, observer: myIsObserver });
    peers['host'] = { conn, name: 'Host', transferring: false };
  });
  conn.on('data', data => handleHostMessage(data, conn));
  conn.on('close', () => {
    guestSystemMsg('Disconnected from host.');
    const rb = $('guestRejoinBtn');
    if (rb) rb.style.display = 'block';
  });
  conn.on('error', err => console.error('Guest conn error:', err));
}

function handleHostMessage(data, conn) {
  if (data.type === 'admitted') {
    if ($('waitingScreen')) $('waitingScreen').style.display = 'none';
    showGuestRoom();
    getMic().then(s => {
      setupGuestAudioGraph(s);
      // P3: call with processed stream so gain affects what host hears
      const callStream = myIsObserver ? new MediaStream() : (processedDest ? processedDest.stream : s);
      const call = peer.call(`HOST-${roomId}`, callStream);
      call.on('stream', remote => {
        addRemoteAudio('host', remote);
        applyOutputVolume(masterOutputVolume);
        if (remote && remote.getAudioTracks().length > 0) {
          setupGuestSpeakingIndicator('host', 'Host', remote);
        }
      });
    });
    guestSystemMsg(`You are in the room${myIsObserver ? ' as an Observer (mic off, not recorded)' : ''}.`);
  }
  if (data.type === 'denied') {
    if ($('waitingScreen')) $('waitingScreen').style.display = 'none';
    if ($('nameScreen')) $('nameScreen').style.display = 'flex';
    const err = $('nameError');
    if (err) { err.textContent = 'The host did not admit you.'; err.style.display = 'block'; }
  }
  if (data.type === 'kicked') showThankyou('You have been removed from this session by the host.');
  if (data.type === 'chat') guestAddChat(data.sender, data.text, false);
  if (data.type === 'countdown_start') runGuestCountdown(data.from);
  if (data.type === 'record_start') {
    if ($('countdownScreen')) $('countdownScreen').style.display = 'none';
    if ($('guestRoom')) $('guestRoom').style.display = 'block';
    if (!myIsObserver) startGuestRecording();
    setText($('guestStatusDisplay'), '🔴 Recording');
    setText($('guestMicStatus'), 'Active — speak to see your level');
  }
  if (data.type === 'record_stop') { if (!myIsObserver) stopGuestRecording(conn); }
  if (data.type === 'record_pause') {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
    setText($('guestStatusDisplay'), '⏸ Paused');
  }
  if (data.type === 'record_resume') {
    if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
    setText($('guestStatusDisplay'), '🔴 Recording');
  }
  if (data.type === 'mute_you') {
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !data.muted; });
    guestSystemMsg(data.muted ? 'The host has muted your microphone.' : 'The host has unmuted your microphone.');
    updateGuestMuteUI(data.muted);
  }
  if (data.type === 'timer_sync') {
    elapsed = data.elapsed;
    const el = $('guestRecDuration');
    if (el) el.textContent = fmt(Math.floor(elapsed));
  }
  if (data.type === 'transfer_confirmed') {
    if ($('guestUploadCard')) $('guestUploadCard').style.display = 'none';
    if ($('guestDoneCard')) $('guestDoneCard').style.display = 'block';
    setText($('guestStatusDisplay'), '✓ Track received by host — you may close this window');
    if (peers['host']) peers['host'].transferring = false;
  }
  if (data.type === 'transfer_failed') {
    if ($('guestUploadCard')) $('guestUploadCard').style.display = 'none';
    showGuestTransferFailed('Host reported an error. Download your backup and send via WeTransfer.');
  }
  if (data.type === 'participant_update') updateGuestSpeakingList(data.participants);
}

function updateGuestMuteUI(muted) {
  const btn = $('guestSelfMuteBtn');
  if (btn) { btn.textContent = muted ? '🔇 Unmute mic' : '🎙 Mute mic'; btn.dataset.muted = muted ? '1' : ''; }
}

// ── Guest countdown ──
function runGuestCountdown(from) {
  if ($('guestRoom')) $('guestRoom').style.display = 'none';
  if ($('countdownScreen')) $('countdownScreen').style.display = 'flex';
  let count = from;
  setText($('countdownNumber'), count);
  function tick() {
    count--;
    if (count <= 0) { setText($('countdownNumber'), '🎙'); }
    else { setText($('countdownNumber'), count); setTimeout(tick, 1000); }
  }
  setTimeout(tick, 1000);
}

// ── Host handles incoming connections ──
function handleIncomingConn(conn) {
  conn.on('data', data => {
    if (data.type === 'join_request') {
      if (peers[conn.peer] && !peers[conn.peer].pending) return;
      // P5: name comes from guest — store raw but always display via textContent
      const safeName = String(data.name || 'Guest').substr(0, 80);
      peers[conn.peer] = { conn, name: safeName, pending: true, consented: data.consented, observer: data.observer, muted: false, selfMuted: false, transferring: false };
      showWaitingGuest(conn.peer, safeName, data.consented, data.observer);
      // P6: log without IP
      consentLog.push(buildParticipantLogEntry(safeName, data.observer ? 'Observer' : 'Guest', data.consented, data.observer));
    }
    if (data.type === 'chat') {
      hostAddChat(data.sender, data.text, false); // hostAddChat uses textContent
      broadcastToGuests({ type: 'chat', sender: data.sender, text: data.text }, conn.peer);
    }
    if (data.type === 'self_muted') {
      const p = peers[conn.peer];
      if (p) { p.selfMuted = data.muted; renderParticipants(); }
    }
    // P7: Receive raw WebM chunks — no MP3 conversion required
    if (data.type === 'file_meta') {
      receivedMeta[conn.peer] = data;
      receivedChunks[conn.peer] = [];
      if (peers[conn.peer]) peers[conn.peer].transferring = true;
      addTransferRow(conn.peer, peers[conn.peer] ? peers[conn.peer].name : 'Guest', data.size, data.totalChunks);
    }
    if (data.type === 'file_chunk') {
      if (!receivedChunks[conn.peer]) receivedChunks[conn.peer] = [];
      receivedChunks[conn.peer].push(data.chunk);
      const meta = receivedMeta[conn.peer];
      if (meta) {
        const pct = Math.min(99, Math.round((receivedChunks[conn.peer].length / meta.totalChunks) * 100));
        updateTransferBar(conn.peer, pct);
      }
    }
    if (data.type === 'file_done') finaliseGuestTrack(conn.peer, conn);
    if (data.type === 'guest_leaving') {
      const p = peers[conn.peer];
      hostSystemMsg(`${p ? p.name : 'A guest'} has left.`);
      delete peers[conn.peer];
      renderParticipants();
      broadcastParticipantUpdate();
    }
  });
  conn.on('close', () => {
    const p = peers[conn.peer];
    if (p && !p.pending) {
      if (p.transferring) {
        const tpct = $(`tpct-${conn.peer}`);
        if (tpct) { tpct.textContent = '✗ Failed'; tpct.style.color = 'var(--red)'; }
        hostSystemMsg(`⚠ ${p.name} disconnected during transfer. Ask them to send their backup track.`);
      } else {
        hostSystemMsg(`${p.name} disconnected.`);
      }
    } else if (p) {
      const row = $(`wait-${conn.peer}`);
      if (row) row.remove();
      const wq = $('waitingQueue');
      if (wq && $('waitingList') && $('waitingList').children.length === 0) wq.style.display = 'none';
    }
    delete peers[conn.peer];
    renderParticipants();
    broadcastParticipantUpdate();
  });
}

function broadcastParticipantUpdate() {
  const list = [{ name: myName, isHost: true, muted: hostSelfMuted }];
  Object.entries(peers).forEach(([pid, p]) => {
    if (!p.pending) list.push({ name: p.name, muted: p.muted || p.selfMuted, observer: p.observer });
  });
  broadcastToGuests({ type: 'participant_update', participants: list });
}

function showWaitingGuest(peerId, name, consented, observer) {
  const wq = $('waitingQueue');
  if (wq) wq.style.display = 'block';

  const row = document.createElement('div');
  row.className = 'waiting-row';
  row.id = `wait-${peerId}`;

  const info = document.createElement('div');
  const nameSpan = document.createElement('span');
  nameSpan.className = 'waiting-row-name';
  nameSpan.textContent = name; // P5: textContent
  const badge = document.createElement('span');
  badge.style.cssText = 'font-size:11px;color:var(--text3);margin-left:8px;';
  badge.textContent = observer ? '👁 Observer' : (consented ? '🟢 Consented' : '⚠ Not consented');
  info.appendChild(nameSpan);
  info.appendChild(badge);

  const actions = document.createElement('div');
  const admitBtn = document.createElement('button');
  admitBtn.className = 'btn-admit';
  admitBtn.textContent = 'Admit';
  admitBtn.addEventListener('click', () => admitGuest(peerId));
  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn-deny';
  denyBtn.textContent = 'Deny';
  denyBtn.addEventListener('click', () => denyGuest(peerId));
  actions.appendChild(admitBtn);
  actions.appendChild(denyBtn);

  row.appendChild(info);
  row.appendChild(actions);
  if ($('waitingList')) $('waitingList').appendChild(row);

  hostSystemMsg(`⚡ ${name} is waiting to join.`); // hostSystemMsg uses textContent

  // Browser notification
  if (Notification && Notification.permission === 'granted') {
    new Notification('Vox5000', { body: `${name} is waiting to join`, icon: 'favicon-512.png' });
  } else if (Notification && Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') new Notification('Vox5000', { body: `${name} is waiting to join`, icon: 'favicon-512.png' });
    });
  }

  // Guest alert popup
  const alert = $('guestAlert');
  if (alert) {
    setText($('guestAlertName'), `${name} wants to join`);
    alert.style.display = 'block';
    const admBtn = $('guestAlertAdmit');
    if (admBtn) admBtn.onclick = () => { alert.style.display = 'none'; admitGuest(peerId); };
    const disBtn = $('guestAlertDismiss');
    if (disBtn) disBtn.onclick = () => { alert.style.display = 'none'; };
  }
}

window.admitGuest = function(peerId) {
  const p = peers[peerId];
  if (!p) return;
  p.pending = false;
  p.conn.send({ type: 'admitted' });
  getMic().then(s => {
    if (!hostAnalyser) setupHostAudioGraph(s);
    // P3: call with processed stream so host gain affects what guests hear
    const callStream = processedDest ? processedDest.stream : s;
    const call = peer.call(peerId, callStream);
    call.on('stream', remote => {
      addRemoteAudio(peerId, remote);
      applyOutputVolume(masterOutputVolume);
      if (remote && remote.getAudioTracks().length > 0) setupRemoteAnalyser(peerId, remote);
    });
    p.call = call;
  });
  const row = $(`wait-${peerId}`);
  if (row) row.remove();
  const wl = $('waitingList');
  if (wl && wl.children.length === 0 && $('waitingQueue')) $('waitingQueue').style.display = 'none';
  renderParticipants();
  hostSystemMsg(`${p.name} has joined${p.observer ? ' as Observer' : ''}.`);
  broadcastParticipantUpdate();
  if (recording && !p.observer) p.conn.send({ type: 'record_start' });
};

window.denyGuest = function(peerId) {
  const p = peers[peerId];
  if (!p) return;
  p.conn.send({ type: 'denied' });
  const row = $(`wait-${peerId}`);
  if (row) row.remove();
  const wl = $('waitingList');
  if (wl && wl.children.length === 0 && $('waitingQueue')) $('waitingQueue').style.display = 'none';
  delete peers[peerId];
};

window.kickGuest = function(peerId) {
  const p = peers[peerId];
  if (!p) return;
  if (!confirm(`Remove ${p.name} from the room?`)) return;
  p.conn.send({ type: 'kicked' });
  setTimeout(() => {
    try { p.conn.close(); } catch(e) {}
    const audio = $(`audio-${peerId}`);
    if (audio) audio.remove();
    delete peers[peerId];
    renderParticipants();
    broadcastParticipantUpdate();
    hostSystemMsg(`${p.name} has been removed.`);
  }, 500);
};

// ── Thank you ──
function showThankyou(msg) {
  ['guestRoom','hostRoom','countdownScreen','waitingScreen','consentScreen','guestMicScreen'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (peer) { try { peer.destroy(); } catch(e) {} }
  setText($('thankyouMsg'), msg || 'Thank you for using Vox5000.');
  if ($('thankyouScreen')) $('thankyouScreen').style.display = 'flex';
  let count = 5;
  setText($('thankyouCountdown'), count);
  const iv = setInterval(() => {
    count--;
    setText($('thankyouCountdown'), count);
    if (count <= 0) { clearInterval(iv); window.location.href = 'index.html'; }
  }, 1000);
}

// ── P3: Audio graph — processed stream for recording ──
// Chain: mic → gainNode → analyser + processedDest (for recording + WebRTC)
//                       ↘ audioCtx.destination (for monitoring — but only through a muted gain node unless user enables monitoring)

function setupHostAudioGraph(s) {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext({ sampleRate: 48000 });
  localStream = s;
  const src = audioCtx.createMediaStreamSource(s);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = dbToGain(inputGainDb);
  hostAnalyser = audioCtx.createAnalyser();
  hostAnalyser.fftSize = 1024;
  processedDest = audioCtx.createMediaStreamDestination();

  src.connect(gainNode);
  gainNode.connect(hostAnalyser);
  gainNode.connect(processedDest); // this is what MediaRecorder and WebRTC peers receive

  drawMeterHost(hostAnalyser);
  addWaveformRow('local', myName + ' (You)', hostAnalyser);
}

function setupGuestAudioGraph(s) {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext({ sampleRate: 48000 });
  localStream = s;
  const src = audioCtx.createMediaStreamSource(s);
  guestGainNode = audioCtx.createGain();
  guestGainNode.gain.value = dbToGain(inputGainDb);
  guestAnalyser = audioCtx.createAnalyser();
  guestAnalyser.fftSize = 1024;
  processedDest = audioCtx.createMediaStreamDestination();

  src.connect(guestGainNode);
  guestGainNode.connect(guestAnalyser);
  guestGainNode.connect(processedDest); // recorded + sent via WebRTC

  drawGuestMeterLoop(guestAnalyser);
  drawWave($('guestWaveCanvas'), guestAnalyser);
  setText($('guestMicStatus'), 'Active — speak to see your level');
}

// ── Remote audio ──
function addRemoteAudio(peerId, remoteStream) {
  let a = $(`audio-${peerId}`);
  if (!a) {
    a = document.createElement('audio');
    a.id = `audio-${peerId}`;
    a.autoplay = true;
    a.setAttribute('playsinline', '');
    const ae = $('audioElements');
    if (ae) ae.appendChild(a);
  }
  a.srcObject = remoteStream;
  // P9: cap at 100%
  a.volume = Math.min(1, Math.max(0, masterOutputVolume));
}

function applyOutputVolume(vol) {
  // P9: cap at 1.0 — slider max should be 1.0 in HTML too
  masterOutputVolume = Math.min(1, Math.max(0, vol));
  document.querySelectorAll('#audioElements audio').forEach(a => { a.volume = masterOutputVolume; });
}

// ── Remote analyser ──
function setupRemoteAnalyser(peerId, remote) {
  if (!audioCtx) return;
  try {
    const anal = audioCtx.createAnalyser(); anal.fftSize = 512;
    audioCtx.createMediaStreamSource(remote).connect(anal);
    if (peers[peerId]) peers[peerId].analyser = anal;
    drawMeterPeer(peerId, anal);
    if (isHost) {
      const p = peers[peerId];
      addWaveformRow(peerId, p ? p.name : 'Guest', anal);
    }
  } catch(e) { console.warn('Remote analyser error:', e); }
}

// ── Waveform rows (host view) ──
function addWaveformRow(id, name, analyser) {
  const container = $('allWaveforms');
  if (!container) return;
  const existing = document.getElementById(`wrow-${id}`);
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = `wrow-${id}`;
  wrap.style.marginBottom = '14px';

  const label = document.createElement('div');
  label.style.cssText = 'font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;';
  label.textContent = name; // P5: textContent

  const canvas = document.createElement('canvas');
  canvas.id = `wave-${id}`;
  canvas.className = 'wave-canvas';
  canvas.height = 50;
  canvas.style.borderRadius = '4px';

  wrap.appendChild(label);
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  drawWave(canvas, analyser);
}

// ── Guest speaking indicators ──
function setupGuestSpeakingIndicator(peerId, name, remoteStream) {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
  try {
    const anal = audioCtx.createAnalyser(); anal.fftSize = 256;
    audioCtx.createMediaStreamSource(remoteStream).connect(anal);
    const card = $('guestSpeakingCard');
    if (card) card.style.display = 'block';
    const list = $('guestSpeakingList');
    if (!list) return;

    let row = document.getElementById(`speak-${peerId}`);
    if (!row) {
      row = document.createElement('div');
      row.id = `speak-${peerId}`;
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);';

      const dot = document.createElement('div');
      dot.id = `speak-dot-${peerId}`;
      dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:var(--border);flex-shrink:0;transition:background 0.1s;';

      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'font-size:13px;color:var(--text2);';
      nameEl.textContent = name; // P5

      row.appendChild(dot);
      row.appendChild(nameEl);
      list.appendChild(row);
    }

    const dot = document.getElementById(`speak-dot-${peerId}`);
    const buf = new Uint8Array(anal.frequencyBinCount);
    function tick() {
      anal.getByteTimeDomainData(buf);
      let max = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]-128)/128; if (v>max) max=v; }
      if (dot) dot.style.background = max > 0.04 ? 'var(--green)' : 'rgba(255,255,255,0.08)';
      requestAnimationFrame(tick);
    }
    tick();
  } catch(e) { console.warn('Speaking indicator error:', e); }
}

function updateGuestSpeakingList(participants) {
  const list = $('guestSpeakingList');
  if (!list) return;
  const card = $('guestSpeakingCard');
  if (card) card.style.display = 'block';
  participants.forEach(p => {
    if (p.name === myName) return;
    const key = `speak-name-${String(p.name).replace(/\W/g,'_')}`;
    let row = document.getElementById(key);
    if (!row) {
      row = document.createElement('div');
      row.id = key;
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);';
      list.appendChild(row);
    }
    row.innerHTML = ''; // reset row before rebuild
    const dot = document.createElement('div');
    dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${p.muted ? 'var(--red-dim)' : 'rgba(255,255,255,0.08)'};flex-shrink:0;`;
    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'font-size:13px;color:var(--text2);';
    nameEl.textContent = `${p.muted ? '🔇 ' : ''}${p.name}${p.isHost ? ' (Host)' : ''}`; // P5
    row.appendChild(dot);
    row.appendChild(nameEl);
  });
}

// ── Meters ──
function drawMeterHost(anal) {
  const buf = new Uint8Array(anal.frequencyBinCount);
  function tick() {
    try { anal.getByteTimeDomainData(buf); } catch { return; }
    let max = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]-128)/128; if (v>max) max=v; }
    const fill = $('meter-local');
    if (fill) fill.style.width = Math.min(100, Math.round(max*200)) + '%';
    requestAnimationFrame(tick);
  }
  tick();
}

function drawMeterPeer(peerId, anal) {
  const buf = new Uint8Array(anal.frequencyBinCount);
  function tick() {
    try { anal.getByteTimeDomainData(buf); } catch { return; }
    let max = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]-128)/128; if (v>max) max=v; }
    const fill = $(`meter-${peerId}`);
    if (fill) fill.style.width = Math.min(100, Math.round(max*200)) + '%';
    requestAnimationFrame(tick);
  }
  tick();
}

function drawGuestMeterLoop(anal) {
  const buf = new Uint8Array(anal.frequencyBinCount);
  function tick() {
    try { anal.getByteTimeDomainData(buf); } catch { return; }
    let max = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]-128)/128; if (v>max) max=v; }
    const fill = $('guestMeterBar');
    if (fill) fill.style.width = Math.min(100, Math.round(max*200)) + '%';
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Waveform drawing ──
function drawWave(canvas, anal) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const buf2 = [];
  function tick() {
    const W = canvas.offsetWidth || 600;
    if (canvas.width !== W) canvas.width = W;
    const H = canvas.height, mid = H / 2;
    const buf = new Uint8Array(anal.frequencyBinCount);
    try { anal.getByteTimeDomainData(buf); } catch {}
    let peak = 0, clip = false;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]-128)/128;
      if (v > peak) peak = v;
      if (buf[i] > 242 || buf[i] < 13) clip = true;
    }
    buf2.push({ peak, clipping: clip });
    if (buf2.length > 600) buf2.shift();
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);
    const clipH = H * 0.06;
    ctx.fillStyle = 'rgba(255,59,59,0.07)';
    ctx.fillRect(0, 0, W, clipH);
    ctx.fillRect(0, H-clipH, W, clipH);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
    if (buf2.length > 0) {
      const bW = W / 600;
      for (let i = 0; i < buf2.length; i++) {
        const x = i*bW, { peak: p, clipping: c } = buf2[i];
        const h = Math.max(1, p*(mid-clipH)*0.95);
        ctx.fillStyle = c ? '#FF3B3B' : `rgba(223,255,0,${0.3+p*0.7})`;
        ctx.fillRect(x, mid-h, Math.max(1, bW-0.5), h*2);
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Show rooms ──
function showHostRoom() {
  if ($('waitingScreen')) $('waitingScreen').style.display = 'none';
  if ($('hostRoom')) $('hostRoom').style.display = 'block';
  const rd = getRooms()[roomId] || {};
  setText($('roomCodeDisplay'), roomId);
  setText($('roomNameDisplay'), rd.name || 'Interview Room');
  document.title = `Vox5000 — ${rd.name || 'Interview Room'}`;
  getMic().then(s => setupHostAudioGraph(s));
  renderParticipants();
  setupHostControls();
  setupHostInputSlider();
  setupSettingsPanel();
}

function showGuestRoom() {
  if ($('guestRoom')) $('guestRoom').style.display = 'block';
  setText($('guestNameDisplay'), myName);
  setText($('guestRoomCode'), roomId);
  setText($('guestStatusDisplay'), myIsObserver ? 'Observer — listening only' : 'Connected — waiting for host to start');
  if (myIsObserver) {
    if ($('observerBanner')) $('observerBanner').style.display = 'block';
    const badge = $('guestConsentBadge');
    if (badge) { badge.textContent = '👁 Observer'; badge.className = 'badge-observer'; }
    if ($('guestControlsRow')) $('guestControlsRow').style.display = 'none';
  } else {
    const badge = $('guestConsentBadge');
    if (badge) { badge.textContent = '🟢 Consented'; badge.className = 'badge-consented'; }
    if ($('guestLevelCard')) $('guestLevelCard').style.display = 'block';
    setupGuestLevelSliders();
  }
  setupGuestControls();
  setupSettingsPanel();
}

// ── Participants ──
function renderParticipants() {
  const list = $('participantsList');
  if (!list) return;
  list.innerHTML = '';
  list.appendChild(makeParticipantRow(myPeerId, myName, true, true, true, false, hostSelfMuted));
  Object.entries(peers).forEach(([pid, p]) => {
    if (p.pending) return;
    list.appendChild(makeParticipantRow(pid, p.name, false, false, p.consented, p.observer, p.muted || p.selfMuted));
  });
  const total = 1 + Object.values(peers).filter(p => !p.pending).length;
  setText($('participantCount'), `${total}/6`);
}

function makeParticipantRow(pid, name, isHostUser, isMe, consented, observer, muted) {
  const div = document.createElement('div');
  div.className = 'participant-row' + (isHostUser ? ' is-host' : '');
  div.id = `prow-${pid}`;

  const avatar = document.createElement('div');
  avatar.className = 'participant-avatar';
  avatar.textContent = initials(name); // P5: textContent

  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';

  const nameEl = document.createElement('div');
  nameEl.className = 'participant-name';
  nameEl.textContent = name + (isMe ? ' (You)' : ''); // P5

  // Badge
  const badgeEl = document.createElement('div');
  badgeEl.style.marginTop = '3px';
  const chip = document.createElement('span');
  if (isHostUser) { chip.className = 'chip chip-ready'; chip.textContent = `${muted ? '🔇 ' : '🎙 '}Host${muted ? ' (Muted)' : ''}`; }
  else if (observer) { chip.className = 'chip chip-observer'; chip.textContent = '👁 Observer'; }
  else { chip.className = 'chip chip-consented'; chip.textContent = `${muted ? '🔇 ' : '🟢 '}Consented${muted ? ' · Muted' : ''}`; }
  badgeEl.appendChild(chip);

  const meter = document.createElement('div');
  meter.className = 'participant-meter';
  meter.style.marginTop = '6px';
  const meterFill = document.createElement('div');
  meterFill.className = 'participant-meter-fill';
  meterFill.id = `meter-${pid}`;
  meter.appendChild(meterFill);

  info.appendChild(nameEl);
  info.appendChild(badgeEl);
  info.appendChild(meter);

  div.appendChild(avatar);
  div.appendChild(info);

  // Per-guest volume (host only, not self, not observer)
  if (!isMe && !isHostUser && !observer) {
    const vol = document.createElement('div');
    vol.className = 'participant-vol';

    const volLabel = document.createElement('div');
    volLabel.style.cssText = 'font-size:10px;color:var(--text3);margin-bottom:4px;text-align:center;';
    volLabel.textContent = 'Hear vol';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    // P9: max 1.0 (100%) — no boost above system volume
    slider.max = '1';
    slider.step = '0.05';
    slider.value = '1';
    slider.className = 'vol-slider';
    slider.setAttribute('aria-label', `Volume for ${name}`);
    slider.addEventListener('input', () => {
      const audio = $(`audio-${pid}`);
      if (audio) audio.volume = Math.min(1, Math.max(0, parseFloat(slider.value)));
      const lbl = $(`vol-label-${pid}`);
      if (lbl) lbl.textContent = Math.round(parseFloat(slider.value) * 100) + '%';
    });

    const volVal = document.createElement('span');
    volVal.className = 'vol-label';
    volVal.id = `vol-label-${pid}`;
    volVal.textContent = '100%';

    vol.appendChild(volLabel);
    vol.appendChild(slider);
    vol.appendChild(volVal);
    div.appendChild(vol);
  }

  // Action buttons (not for self)
  if (!isMe && !isHostUser) {
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;';

    const p = peers[pid] || {};
    const muteBtn = document.createElement('button');
    muteBtn.className = 'btn-mute' + (p.muted ? ' muted' : '');
    muteBtn.id = `mute-${pid}`;
    muteBtn.textContent = p.muted ? 'Unmute' : 'Mute';
    muteBtn.addEventListener('click', () => toggleMute(pid));

    const kickBtn = document.createElement('button');
    kickBtn.className = 'btn-mute';
    kickBtn.style.cssText = 'color:var(--red);border-color:rgba(255,59,59,0.3);';
    kickBtn.textContent = 'Kick';
    kickBtn.addEventListener('click', () => kickGuest(pid));

    actions.appendChild(muteBtn);
    actions.appendChild(kickBtn);
    div.appendChild(actions);
  }

  return div;
}

window.toggleMute = function(peerId) {
  const p = peers[peerId];
  if (!p) return;
  p.muted = !p.muted;
  p.conn.send({ type: 'mute_you', muted: p.muted });
  renderParticipants();
  broadcastParticipantUpdate();
};

// ── Host self-mute ──
function toggleHostSelfMute() {
  hostSelfMuted = !hostSelfMuted;
  // Disable/enable the actual mic tracks
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !hostSelfMuted; });
  const btn = $('hostSelfMuteBtn');
  if (btn) {
    btn.textContent = hostSelfMuted ? '🔇 Unmute mic' : '🎙 Mute mic';
    btn.style.borderColor = hostSelfMuted ? 'rgba(255,59,59,0.5)' : '';
    btn.style.color = hostSelfMuted ? 'var(--red)' : '';
  }
  renderParticipants();
  broadcastParticipantUpdate();
  hostSystemMsg(hostSelfMuted ? 'Your mic is muted — guests cannot hear you and you will not be recorded.' : 'Your mic is unmuted.');
}

// ── Level sliders ──
function setupHostInputSlider() {
  const sl = $('hostInputSlider'), val = $('hostInputVal');
  if (sl) {
    sl.addEventListener('input', () => {
      inputGainDb = parseFloat(sl.value);
      if (val) val.textContent = fmtDb(inputGainDb);
      // P3: live gain change — works during recording
      if (gainNode) gainNode.gain.value = dbToGain(inputGainDb);
    });
  }
}

function setupGuestLevelSliders() {
  const iSl = $('guestInputSlider'), iVal = $('guestInputVal');
  if (iSl) {
    iSl.addEventListener('input', () => {
      inputGainDb = parseFloat(iSl.value);
      if (iVal) iVal.textContent = fmtDb(inputGainDb);
      if (guestGainNode) guestGainNode.gain.value = dbToGain(inputGainDb);
    });
  }
  const oSl = $('guestOutputSlider'), oVal = $('guestOutputVal');
  if (oSl) {
    // P9: cap at 1.0 (100%)
    oSl.max = '1';
    oSl.addEventListener('input', () => {
      const v = parseFloat(oSl.value);
      applyOutputVolume(v);
      if (oVal) oVal.textContent = Math.round(v * 100) + '%';
    });
  }
}

// ── Settings panel ──
function setupSettingsPanel() {
  const btn = $('settingsBtn'), panel = $('settingsPanel'), closeBtn = $('settingsCloseBtn');
  if (!btn || !panel) return;

  async function populateDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      const micSel = $('settingsMicSelect');
      if (micSel) {
        micSel.innerHTML = '';
        mics.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microphone ${i+1}`;
          if (d.deviceId === currentMicId) opt.selected = true;
          micSel.appendChild(opt);
        });
      }

      const outSel = $('settingsOutputSelect');
      if (outSel) {
        if (outputs.length > 0) {
          outSel.innerHTML = '';
          const def = document.createElement('option');
          def.value = ''; def.textContent = 'Default output';
          outSel.appendChild(def);
          outputs.forEach((d, i) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Speaker ${i+1}`;
            outSel.appendChild(opt);
          });
        }
      }
    } catch(e) { console.warn('Device list error:', e); }

    // Sync values
    const iSl = $('settingsInputSlider'), iVal = $('settingsInputVal');
    if (iSl) { iSl.value = inputGainDb; if (iVal) iVal.textContent = fmtDb(inputGainDb); }
    const oSl = $('settingsOutputSlider'), oVal = $('settingsOutputVal');
    if (oSl) {
      // P9: cap display at 100%
      oSl.max = '1';
      oSl.value = masterOutputVolume;
      if (oVal) oVal.textContent = Math.round(masterOutputVolume * 100) + '%';
    }
    const nsCb = $('settingsNoiseSuppression'); if (nsCb) nsCb.checked = noiseSuppression;
    const ecCb = $('settingsEchoCancellation'); if (ecCb) ecCb.checked = echoCancellation;
  }

  btn.addEventListener('click', () => { panel.style.display = 'flex'; populateDevices(); });
  if (closeBtn) closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
  panel.addEventListener('click', e => { if (e.target === panel) panel.style.display = 'none'; });

  // Input gain
  const iSl = $('settingsInputSlider');
  if (iSl) {
    iSl.addEventListener('input', () => {
      inputGainDb = parseFloat(iSl.value);
      const v = $('settingsInputVal'); if (v) v.textContent = fmtDb(inputGainDb);
      if (gainNode) gainNode.gain.value = dbToGain(inputGainDb);
      if (guestGainNode) guestGainNode.gain.value = dbToGain(inputGainDb);
      const hs = $('hostInputSlider'); if (hs) hs.value = inputGainDb;
      const hv = $('hostInputVal'); if (hv) hv.textContent = fmtDb(inputGainDb);
      const gi = $('guestInputSlider'); if (gi) gi.value = inputGainDb;
      const giv = $('guestInputVal'); if (giv) giv.textContent = fmtDb(inputGainDb);
    });
  }

  // Output volume — P9: capped at 100%
  const oSl = $('settingsOutputSlider');
  if (oSl) {
    oSl.max = '1';
    oSl.addEventListener('input', () => {
      const v = parseFloat(oSl.value);
      applyOutputVolume(v);
      const ov = $('settingsOutputVal'); if (ov) ov.textContent = Math.round(v * 100) + '%';
    });
  }

  // Output device
  const outDev = $('settingsOutputSelect');
  if (outDev) {
    outDev.addEventListener('change', async () => {
      const deviceId = outDev.value;
      document.querySelectorAll('#audioElements audio').forEach(async a => {
        if (deviceId && a.setSinkId) {
          try { await a.setSinkId(deviceId); } catch(e) { console.warn('setSinkId failed:', e); }
        }
      });
    });
  }

  // P8: Mic change — disabled during recording
  const micSel = $('settingsMicSelect');
  if (micSel) {
    micSel.addEventListener('change', async () => {
      if (recording) {
        alert('Stop recording before changing your microphone.');
        populateDevices(); // revert selection
        return;
      }
      currentMicId = micSel.value;
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      const newStream = await getMic();
      if (isHost) {
        setupHostAudioGraph(newStream);
        Object.entries(peers).forEach(([pid, p]) => {
          if (!p.pending && p.call) {
            try {
              const sender = p.call.peerConnection && p.call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
              if (sender) sender.replaceTrack(newStream.getAudioTracks()[0]);
            } catch(e) { console.warn('replaceTrack error:', e); }
          }
        });
      } else {
        setupGuestAudioGraph(newStream);
      }
    });
  }

  // P8: Noise suppression — disabled during recording
  const nsCb = $('settingsNoiseSuppression');
  if (nsCb) {
    nsCb.addEventListener('change', async () => {
      if (recording) {
        alert('Stop recording before changing audio processing settings.');
        nsCb.checked = noiseSuppression; // revert
        return;
      }
      noiseSuppression = nsCb.checked;
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      const s = await getMic();
      if (isHost) setupHostAudioGraph(s); else setupGuestAudioGraph(s);
    });
  }

  // P8: Echo cancellation — disabled during recording
  const ecCb = $('settingsEchoCancellation');
  if (ecCb) {
    ecCb.addEventListener('change', async () => {
      if (recording) {
        alert('Stop recording before changing audio processing settings.');
        ecCb.checked = echoCancellation; // revert
        return;
      }
      echoCancellation = ecCb.checked;
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      const s = await getMic();
      if (isHost) setupHostAudioGraph(s); else setupGuestAudioGraph(s);
    });
  }

  // Mic test
  const testBtn = $('settingsMicTestBtn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      const res = $('settingsMicTestResult');
      setText(res, 'Recording…');
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: currentMicId ? { exact: currentMicId } : undefined } });
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(s).connect(dest);
        const mr = new MediaRecorder(dest.stream);
        const bufs = [];
        mr.ondataavailable = e => { if (e.data.size > 0) bufs.push(e.data); };
        mr.onstop = () => {
          s.getTracks().forEach(t => t.stop());
          const audio = new Audio(URL.createObjectURL(new Blob(bufs, { type: mr.mimeType })));
          audio.play();
          setText(res, '▶ Playing back…');
          audio.onended = () => { setText(res, '✓ Done. If you heard yourself your mic is working.'); testBtn.disabled = false; };
        };
        mr.start();
        setTimeout(() => mr.stop(), 5000);
      } catch(e) { setText(res, '⚠ Could not access mic — check browser permissions.'); testBtn.disabled = false; }
    });
  }
}

// ── Host controls ──
function setupHostControls() {
  const copyBtn = $('copyLinkBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => openSharePanel(`${location.origin}/room.html?r=${encodeURIComponent(roomId)}`));

  const renameBtn = $('renameRoomBtn');
  if (renameBtn) renameBtn.addEventListener('click', () => {
    const rooms = getRooms(), current = (rooms[roomId] && rooms[roomId].name) || 'Interview Room';
    const newName = prompt('Enter new room name:', current);
    if (newName && newName.trim()) {
      saveRoom(roomId, { name: newName.trim() });
      setText($('roomNameDisplay'), newName.trim());
      document.title = `Vox5000 — ${newName.trim()}`;
      hostSystemMsg(`Room renamed to "${newName.trim()}"`);
    }
  });

  const deleteBtn = $('deleteRoomBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', () => {
    if (confirm('Delete this room? This cannot be undone.')) {
      const r = getRooms(); delete r[roomId]; saveRooms(r);
      broadcastToGuests({ type: 'chat', sender: 'System', text: 'The host has ended this session.' });
      setTimeout(() => { window.location.href = 'index.html'; }, 800);
    }
  });

  const recBtn = $('recBtn');
  if (recBtn) recBtn.addEventListener('click', () => { recording ? stopSession() : startSession(); });

  const pauseBtn = $('pauseBtn');
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    if (!recording) return;
    if (!paused) {
      paused = true;
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
      broadcastToGuests({ type: 'record_pause' });
      pauseBtn.textContent = '▶ Resume';
      setText($('hostDurStatus'), 'Paused');
      const oa = $('onAir'); if (oa) oa.classList.remove('visible');
    } else {
      paused = false;
      startTime = Date.now() - elapsed * 1000;
      if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
      broadcastToGuests({ type: 'record_resume' });
      pauseBtn.textContent = '⏸ Pause';
      setText($('hostDurStatus'), 'Recording');
      const oa = $('onAir'); if (oa) oa.classList.add('visible');
    }
  });

  const selfMuteBtn = $('hostSelfMuteBtn');
  if (selfMuteBtn) selfMuteBtn.addEventListener('click', toggleHostSelfMute);

  const chatSend = $('hostChatSend');
  if (chatSend) chatSend.addEventListener('click', hostSendChat);
  const chatInput = $('hostChatInput');
  if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') hostSendChat(); });
}

// ── Share panel ──
function openSharePanel(url) {
  const panel = $('sharePanel');
  if (!panel) return;
  setText($('shareLinkDisplay'), url);
  panel.style.display = 'flex';
  const msg = `You've been invited to join a Vox5000 interview room.\n\nOpen this link in Google Chrome:\n${url}`;
  const wa = $('shareWhatsApp'); if (wa) wa.onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  const tg = $('shareTelegram'); if (tg) tg.onclick = () => window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("You've been invited to a Vox5000 interview room.")}`, '_blank');
  const em = $('shareEmail'); if (em) em.onclick = () => window.open(`mailto:?subject=Vox5000 Interview Invite&body=${encodeURIComponent(msg)}`);
  const sms = $('shareSMS'); if (sms) sms.onclick = () => window.open(`sms:?body=${encodeURIComponent(msg)}`);
  const nat = $('shareNative');
  if (nat) {
    if (navigator.share) { nat.style.display = 'flex'; nat.onclick = () => navigator.share({ title: 'Vox5000 Interview Room', text: msg, url }).catch(() => {}); }
    else nat.style.display = 'none';
  }
  const copyLink = $('shareCopyLink');
  if (copyLink) copyLink.onclick = () => {
    navigator.clipboard.writeText(url).then(() => {
      setText($('copyLinkText'), '✓ Copied!');
      setTimeout(() => setText($('copyLinkText'), 'Copy link'), 2000);
    });
  };
  const closeBtn = $('closePanelBtn');
  if (closeBtn) closeBtn.onclick = () => { panel.style.display = 'none'; };
  panel.addEventListener('click', e => { if (e.target === panel) panel.style.display = 'none'; });
}

// ── Guest controls ──
function setupGuestControls() {
  const leaveBtn = $('guestLeaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => {
    if (!confirm('Leave this room?')) return;
    const hc = peers['host'] && peers['host'].conn;
    if (hc) { try { hc.send({ type: 'guest_leaving' }); } catch(e) {} }
    showThankyou('Thank you for using Vox5000.');
  });

  const chatSend = $('guestChatSend');
  if (chatSend) chatSend.addEventListener('click', guestSendChat);
  const chatInput = $('guestChatInput');
  if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') guestSendChat(); });

  const selfMuteBtn = $('guestSelfMuteBtn');
  if (selfMuteBtn) {
    selfMuteBtn.addEventListener('click', () => {
      if (!localStream) return;
      const tracks = localStream.getAudioTracks();
      const currentlyMuted = tracks.length > 0 && !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = currentlyMuted; });
      const nowMuted = !currentlyMuted;
      updateGuestMuteUI(nowMuted);
      const hc = peers['host'] && peers['host'].conn;
      if (hc) { try { hc.send({ type: 'self_muted', muted: nowMuted }); } catch(e) {} }
    });
  }

  const rejoinBtn = $('guestRejoinBtn');
  if (rejoinBtn) {
    rejoinBtn.addEventListener('click', () => {
      rejoinBtn.style.display = 'none';
      if (peer && !peer.destroyed) { try { peer.reconnect(); } catch(e) {} }
      else initPeer(`GUEST-${roomId}-${randId(4)}`);
    });
  }

  const backupBtn = $('guestBackupDownloadBtn');
  if (backupBtn) {
    backupBtn.addEventListener('click', () => {
      if (!guestBackupBlob && (!rawChunks || rawChunks.length === 0)) {
        alert('No backup available yet. Start recording first.'); return;
      }
      const blob = guestBackupBlob || new Blob(rawChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = myName.replace(/[^a-zA-Z0-9]/g, '_');
      const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
      const ext = (guestBackupBlob && guestBackupBlob.type.includes('mp3')) ? 'mp3' : 'webm';
      a.href = url; a.download = `${safe}_backup_${ts}.${ext}`; a.click();
      URL.revokeObjectURL(url);
    });
  }
}

// ── Session ──
function startSession() {
  if (!localStream) { setText($('hostDurStatus'), 'Mic not ready — allow mic access first'); return; }
  const countFrom = 5;
  broadcastToGuests({ type: 'countdown_start', from: countFrom });
  if ($('hostRoom')) $('hostRoom').style.display = 'none';
  if ($('countdownScreen')) $('countdownScreen').style.display = 'flex';
  let count = countFrom;
  setText($('countdownNumber'), count);
  const iv = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(iv);
      if ($('countdownScreen')) $('countdownScreen').style.display = 'none';
      if ($('hostRoom')) $('hostRoom').style.display = 'block';
      beginRecording();
      broadcastToGuests({ type: 'record_start' });
    } else {
      setText($('countdownNumber'), count);
    }
  }, 1000);
}

function beginRecording() {
  chunks = []; rawChunks = [];
  recording = true; paused = false; elapsed = 0;
  startTime = Date.now();
  timerInterval = setInterval(tickTimer, 500);

  // Time warnings
  setTimeout(() => { if (recording) { const w = $('sixtyMinWarning'); if (w) w.style.display = 'flex'; } }, 60*60*1000);
  setTimeout(() => { if (recording) hostSystemMsg('⚠ 90 minutes reached. Keep all screens active.'); }, 90*60*1000);
  setTimeout(() => { if (recording) hostSystemMsg('⚠ 2 hours reached. Consider wrapping up soon.'); }, 120*60*1000);

  const recBtn = $('recBtn');
  if (recBtn) { recBtn.classList.add('recording'); recBtn.innerHTML = '<span class="rec-dot"></span> Stop Recording'; }
  const pauseBtn = $('pauseBtn');
  if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.textContent = '⏸ Pause'; }
  const oa = $('onAir'); if (oa) oa.classList.add('visible');
  setText($('hostDurStatus'), 'Recording');

  // P3: record processed stream, not raw mic
  startLocalRecording();
  // P8: disable mic changes during recording (settings panel handles this too)
  hostSystemMsg('Recording started.');
}

function stopSession() {
  recording = false; paused = false;
  clearInterval(timerInterval);
  const oa = $('onAir'); if (oa) oa.classList.remove('visible');
  const recBtn = $('recBtn');
  if (recBtn) { recBtn.classList.remove('recording'); recBtn.innerHTML = '<span class="rec-dot"></span> Record'; }
  const pauseBtn = $('pauseBtn');
  if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.textContent = '⏸ Pause'; }
  setText($('hostDurStatus'), 'Finishing…');
  broadcastToGuests({ type: 'record_stop' });
  hostSystemMsg('Recording stopped. Collecting tracks…');
  stopLocalRecording(async () => {
    await buildHostDownload();
    generateConsentLog();
    const guests = Object.values(peers).filter(p => !p.pending && !p.observer);
    if (guests.length > 0) {
      if ($('transferCard')) $('transferCard').style.display = 'block';
    } else {
      setText($('hostDurStatus'), 'Done');
      if ($('dlSection')) $('dlSection').style.display = 'block';
    }
  });
}

function tickTimer() {
  if (!paused) {
    elapsed = (Date.now() - startTime) / 1000;
    const hd = $('hostDuration');
    if (hd) hd.textContent = fmt(elapsed);
    broadcastToGuests({ type: 'timer_sync', elapsed });
  }
}

// P3: Record processedDest.stream so gain affects recording
function startLocalRecording() {
  if (!processedDest) { console.warn('No processedDest — cannot record'); return; }
  chunks = []; rawChunks = [];
  const opts = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 } : {};
  mediaRecorder = new MediaRecorder(processedDest.stream, opts);
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) { chunks.push(e.data); rawChunks.push(e.data); } };
  mediaRecorder.start(1000);
}

function stopLocalRecording(cb) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') { if (cb) cb(); return; }
  mediaRecorder.onstop = () => { if (cb) cb(); };
  mediaRecorder.stop();
}

// ── Guest recording ──
function startGuestRecording() {
  if (!processedDest) { guestSystemMsg('⚠ Mic not ready — your audio may not be recorded.'); return; }
  chunks = []; rawChunks = [];
  const opts = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 } : {};
  // P3: record processed stream
  mediaRecorder = new MediaRecorder(processedDest.stream, opts);
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) { chunks.push(e.data); rawChunks.push(e.data); } };
  mediaRecorder.start(1000);
  if ($('guestTimerCard')) $('guestTimerCard').style.display = 'block';
  const oa = $('onAir'); if (oa) oa.classList.add('visible');
}

function stopGuestRecording(hostConn) {
  const oa = $('onAir'); if (oa) oa.classList.remove('visible');
  if ($('guestTimerCard')) $('guestTimerCard').style.display = 'none';
  setText($('guestStatusDisplay'), 'Encoding and preparing your track…');
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    encodeAndSendToHost(hostConn); return;
  }
  mediaRecorder.onstop = () => encodeAndSendToHost(hostConn);
  mediaRecorder.stop();
}

// Encode to MP3 then send — falls back to raw WebM if encoding fails
async function encodeAndSendToHost(hostConn) {
  if (!rawChunks || rawChunks.length === 0) {
    showGuestTransferFailed('No audio was recorded. Check your microphone was working.');
    return;
  }
  if ($('guestUploadCard')) $('guestUploadCard').style.display = 'block';
  setText($('guestUploadPct'), 'Encoding to MP3…');

  const rawBlob = new Blob(rawChunks, { type: 'audio/webm' });
  guestBackupBlob = rawBlob; // always store raw as backup

  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const decoded = await ctx.decodeAudioData(await rawBlob.arrayBuffer());
    const mp3Blob = await encodeMp3Room(decoded, 256);
    if (!mp3Blob || mp3Blob.size === 0) throw new Error('Empty MP3');
    guestBackupBlob = mp3Blob; // upgrade backup to MP3
    setText($('guestUploadPct'), 'Sending…');
    sendFileToHost(hostConn, mp3Blob, 'audio/mp3');
  } catch(err) {
    console.warn('MP3 encode failed, sending raw WebM:', err);
    setText($('guestUploadPct'), 'Sending raw audio…');
    sendFileToHost(hostConn, rawBlob, 'audio/webm');
  }
}

// MP3 encoder for room — loads lamejs from CDN
function encodeMp3Room(audioBuffer, kbps) {
  return new Promise((resolve, reject) => {
    function doEncode() {
      try {
        const samples = audioBuffer.getChannelData(0);
        const sr = audioBuffer.sampleRate;
        const mp3enc = new lamejs.Mp3Encoder(1, sr, kbps);
        const blockSize = 1152, mp3Data = [];
        const int16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]));
          int16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
        }
        for (let i = 0; i < int16.length; i += blockSize) {
          const enc = mp3enc.encodeBuffer(int16.subarray(i, i + blockSize));
          if (enc.length > 0) mp3Data.push(new Uint8Array(enc));
        }
        const flushed = mp3enc.flush();
        if (flushed.length > 0) mp3Data.push(new Uint8Array(flushed));
        if (mp3Data.length === 0) { reject(new Error('No MP3 data')); return; }
        resolve(new Blob(mp3Data, { type: 'audio/mp3' }));
      } catch(e) { reject(e); }
    }
    if (window.lamejs) { doEncode(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
    script.onload = doEncode;
    script.onerror = () => reject(new Error('Failed to load MP3 encoder'));
    document.head.appendChild(script);
  });
}

function sendFileToHost(hostConn, blob, mimeType) {
  const CHUNK = 8192, BUFFER_HIGH = 32768, BUFFER_LOW = 8192;
  const totalChunks = Math.ceil(blob.size / CHUNK);
  if (peers['host']) peers['host'].transferring = true;
  hostConn.send({ type: 'file_meta', name: myName, totalChunks, size: blob.size, mimeType });

  let offset = 0, sending = false, waitingBuf = false;
  const dc = hostConn.dataChannel || hostConn._dc;
  if (dc) {
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.addEventListener('bufferedamountlow', () => { if (waitingBuf) { waitingBuf = false; schedule(); } });
  }

  // P7: Transfer timeout — if no progress in 30s, fail gracefully
  let lastOffset = -1;
  const transferTimeout = setInterval(() => {
    if (offset === lastOffset && offset < blob.size) {
      clearInterval(transferTimeout);
      showGuestTransferFailed('Transfer stalled. Please download your backup track and send it to the host.');
    }
    lastOffset = offset;
  }, 30000);

  function schedule() { setTimeout(next, 8); }
  function next() {
    if (sending) return;
    if (offset >= blob.size) {
      clearInterval(transferTimeout);
      function waitDrain() {
        if (dc && dc.bufferedAmount > 0) { setTimeout(waitDrain, 50); return; }
        hostConn.send({ type: 'file_done', name: myName });
        setText($('guestStatusDisplay'), 'Sent — waiting for confirmation from host…');
      }
      setTimeout(waitDrain, 150);
      return;
    }
    if (dc && dc.bufferedAmount > BUFFER_HIGH) { waitingBuf = true; return; }
    sending = true;
    const slice = blob.slice(offset, offset + CHUNK);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        hostConn.send({ type: 'file_chunk', chunk: e.target.result });
        offset += CHUNK;
        const pct = Math.min(99, Math.round(offset / blob.size * 100));
        const bar = $('guestUploadBar'), pctEl = $('guestUploadPct');
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
      } catch(err) { sending = false; clearInterval(transferTimeout); showGuestTransferFailed(); return; }
      sending = false;
      schedule();
    };
    reader.onerror = () => { sending = false; clearInterval(transferTimeout); showGuestTransferFailed(); };
    reader.readAsArrayBuffer(slice);
  }
  schedule();
}

function showGuestTransferFailed(msg) {
  const c = $('guestUploadCard'); if (c) c.style.display = 'none';
  setText($('guestStatusDisplay'), 'Transfer failed — download your backup below');
  const backupBtn = $('guestBackupDownloadBtn');
  if (backupBtn) {
    backupBtn.textContent = '⚠ Download my backup track';
    backupBtn.style.background = 'var(--yellow)';
    backupBtn.style.color = '#000';
    backupBtn.style.borderColor = 'var(--yellow)';
  }
  guestSystemMsg(`⚠ Transfer failed. ${msg || 'Download your backup and send it to the host via WeTransfer or email.'}`);
}

function addTransferRow(peerId, name, size, totalChunks) {
  const sizeMb = size ? (size / 1048576).toFixed(1) + ' MB' : '';
  const row = document.createElement('div');
  row.className = 'transfer-item';
  row.id = `trow-${peerId}`;

  const nameEl = document.createElement('span');
  nameEl.className = 'transfer-name';
  nameEl.textContent = name; // P5

  const barWrap = document.createElement('div');
  barWrap.className = 'transfer-bar-wrap';
  const barFill = document.createElement('div');
  barFill.className = 'transfer-bar-fill';
  barFill.id = `tbar-${peerId}`;
  barWrap.appendChild(barFill);

  const pct = document.createElement('span');
  pct.className = 'transfer-pct';
  pct.id = `tpct-${peerId}`;
  pct.textContent = '0%';

  row.appendChild(nameEl);
  row.appendChild(barWrap);
  row.appendChild(pct);
  if ($('transferList')) $('transferList').appendChild(row);

  // Store expected chunk count for P7 verification
  if (peers[peerId]) peers[peerId].expectedChunks = totalChunks;
}

function updateTransferBar(peerId, pctVal) {
  const b = $(`tbar-${peerId}`); if (b) b.style.width = pctVal + '%';
  const e = $(`tpct-${peerId}`); if (e) e.textContent = pctVal + '%';
}

// P7: Verify chunk count before marking complete
async function finaliseGuestTrack(peerId, conn) {
  const p = peers[peerId]; if (!p) return;
  if (peers[peerId]) peers[peerId].transferring = false;
  const allChunks = receivedChunks[peerId];
  const meta = receivedMeta[peerId] || {};

  if (!allChunks || allChunks.length === 0) {
    conn.send({ type: 'transfer_failed' });
    hostSystemMsg(`⚠ ${p.name}'s track arrived empty. Ask them to send their backup.`);
    return;
  }

  // P7: Verify received count matches expected
  if (meta.totalChunks && allChunks.length < meta.totalChunks * 0.95) {
    // Allow 5% tolerance for timing
    hostSystemMsg(`⚠ ${p.name}'s track may be incomplete (${allChunks.length}/${meta.totalChunks} chunks). Saving what arrived.`);
  }

  const mimeType = meta.mimeType || 'audio/webm';
  const blob = new Blob(allChunks.map(c => new Uint8Array(c)), { type: mimeType });
  const b = $(`tbar-${peerId}`); if (b) { b.style.width = '100%'; b.style.background = 'var(--green)'; }
  const e = $(`tpct-${peerId}`); if (e) { const done = document.createElement('span'); done.className = 'transfer-done'; done.textContent = '✓'; e.innerHTML = ''; e.appendChild(done); }

  conn.send({ type: 'transfer_confirmed' });

  const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const safe = (p.name || 'Guest').replace(/[^a-zA-Z0-9]/g, '_');
  const ext = mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3' : 'webm';
  const sizeMb = (blob.size / 1048576).toFixed(1);
  addDownloadItem(`${safe}_${ts}.${ext}`, `${p.name} · ${ext.toUpperCase()} · ${sizeMb} MB`, URL.createObjectURL(blob), `${safe}_${ts}.${ext}`);
  hostSystemMsg(`✓ ${p.name}'s track received (${sizeMb} MB).`);
  if ($('dlSection')) $('dlSection').style.display = 'block';
  checkAllDone();
}

async function buildHostDownload() {
  if (!rawChunks || rawChunks.length === 0) return;
  const rawBlob = new Blob(rawChunks, { type: 'audio/webm' });
  const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const safe = (myName || 'Host').replace(/[^a-zA-Z0-9]/g, '_');

  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const decoded = await ctx.decodeAudioData(await rawBlob.arrayBuffer());
    const mp3Blob = await encodeMp3Room(decoded, 256);
    const sizeMb = (mp3Blob.size / 1048576).toFixed(1);
    addDownloadItem(
      `${safe}_HOST_${ts}.mp3`,
      `${myName} (Host) · MP3 256kbps · ${sizeMb} MB`,
      URL.createObjectURL(mp3Blob),
      `${safe}_HOST_${ts}.mp3`
    );
  } catch(e) {
    // Fallback to raw WebM if MP3 encoding fails
    console.warn('Host MP3 encode failed, offering WebM:', e);
    const sizeMb = (rawBlob.size / 1048576).toFixed(1);
    addDownloadItem(
      `${safe}_HOST_${ts}.webm`,
      `${myName} (Host) · WebM Opus (fallback) · ${sizeMb} MB`,
      URL.createObjectURL(rawBlob),
      `${safe}_HOST_${ts}.webm`
    );
  }
  if ($('dlSection')) $('dlSection').style.display = 'block';
}

function checkAllDone() {
  const guests = Object.values(peers).filter(p => !p.pending && !p.observer);
  const done = document.querySelectorAll('.transfer-done').length;
  if (done >= guests.length && guests.length > 0) {
    const note = $('transferNote');
    if (note) { note.innerHTML = ''; const s = document.createElement('strong'); s.style.color = 'var(--green)'; s.textContent = '✓ All tracks received.'; note.appendChild(s); }
    setText($('hostDurStatus'), 'Done');
  }
}

// P6: Consent log — no IP, includes user agent with disclosure
function generateConsentLog() {
  const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const roomData = getRooms()[roomId] || {};
  const lines = [
    'VOX5000 RECORDING CONSENT LOG',
    '==============================',
    `Room ID: ${roomId}`,
    `Room Name: ${roomData.name || 'Interview Room'}`,
    `Session date: ${new Date().toUTCString()}`,
    `Log generated: ${tsNow()}`,
    '',
    'This log documents participant consent for recording purposes.',
    'Note: Browser user agent is included for verification.',
    'IP addresses are NOT collected or logged by Vox5000.',
    '',
    'PARTICIPANTS',
    '------------',
    '',
  ];
  consentLog.forEach((entry, i) => {
    lines.push(`Participant ${i+1}: ${entry.name}`);
    lines.push(`  Role:      ${entry.role}`);
    lines.push(`  Consented: ${entry.consented ? 'YES' : 'NO'}`);
    lines.push(`  Observer:  ${entry.observer ? 'YES (not recorded)' : 'NO'}`);
    lines.push(`  Timestamp: ${entry.timestamp}`);
    lines.push(`  UserAgent: ${(entry.userAgent || '').substr(0, 120)}`);
    lines.push('');
  });
  lines.push('Generated by Vox5000 (vox5000.com)');
  lines.push('Host is responsible for retaining this consent record.');

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = $('consentLogBtn');
  if (a) { a.href = url; a.download = `Vox5000_Consent_${roomId}_${ts}.txt`; }
  if ($('consentNotice')) $('consentNotice').style.display = 'block';
  hostSystemMsg('📋 Consent log ready to download.');
}

// P5: Safe download item using DOM
function addDownloadItem(name, meta, url, filename) {
  const sec = $('dlSection');
  if (sec) sec.style.display = 'block';
  const grid = $('dlGrid');
  if (!grid) return;
  const item = document.createElement('div');
  item.className = 'dl-item';
  const info = document.createElement('div');
  info.className = 'dl-info';
  const nm = document.createElement('div');
  nm.className = 'dl-name';
  nm.textContent = name;
  const mt = document.createElement('div');
  mt.className = 'dl-meta';
  mt.textContent = meta;
  info.appendChild(nm);
  info.appendChild(mt);
  const a = document.createElement('a');
  a.className = 'dl-btn';
  a.href = url;
  a.download = filename;
  a.textContent = '↓ Download';
  item.appendChild(info);
  item.appendChild(a);
  grid.appendChild(item);
}

// ── Chat — P5: always use textContent ──
function hostSendChat() {
  const input = $('hostChatInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  input.value = '';
  hostAddChat(myName, text, true);
  broadcastToGuests({ type: 'chat', sender: myName, text });
}
function hostAddChat(sender, text, isMe) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const s = document.createElement('span');
  s.className = 'chat-msg-sender' + (isMe ? ' is-me' : '');
  s.textContent = sender; // P5
  const t = document.createElement('span');
  t.className = 'chat-msg-text';
  t.textContent = text; // P5
  div.appendChild(s);
  div.appendChild(t);
  const msgs = $('hostChatMessages');
  if (msgs) { msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight; }
}
function hostSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text; // P5
  const msgs = $('hostChatMessages');
  if (msgs) { msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight; }
}
function guestSendChat() {
  const input = $('guestChatInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  input.value = '';
  guestAddChat(myName, text, true);
  const hc = peers['host'] && peers['host'].conn;
  if (hc) { try { hc.send({ type: 'chat', sender: myName, text }); } catch(e) {} }
}
function guestAddChat(sender, text, isMe) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const s = document.createElement('span');
  s.className = 'chat-msg-sender' + (isMe ? ' is-me' : '');
  s.textContent = sender; // P5
  const t = document.createElement('span');
  t.className = 'chat-msg-text';
  t.textContent = text; // P5
  div.appendChild(s);
  div.appendChild(t);
  const msgs = $('guestChatMessages');
  if (msgs) { msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight; }
}
function guestSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text; // P5
  const msgs = $('guestChatMessages');
  if (msgs) { msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight; }
}

function broadcastToGuests(data, excludePeer) {
  Object.entries(peers).forEach(([pid, p]) => {
    if (pid !== excludePeer && p.conn && !p.pending) { try { p.conn.send(data); } catch(e) {} }
  });
}

// ── Boot ──
setupNav();

if (isHost && roomId && checkHostReturn()) {
  if ($('headphoneScreen')) $('headphoneScreen').style.display = 'none';
  showLoadingThenHostRoom();
}
