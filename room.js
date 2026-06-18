'use strict';

// ── Utilities ──
const $ = id => document.getElementById(id);
function fmt(s) {
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
  return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
}
function randId(len=6) {
  return Math.random().toString(36).substr(2,len).toUpperCase();
}
function initials(name) {
  return name.split(' ').map(w=>w[0]).join('').substr(0,2).toUpperCase();
}

// ── Room state ──
const params  = new URLSearchParams(window.location.search);
let roomId    = params.get('r');
const isHost  = !roomId;
let myName    = '';
let myPeerId  = '';
let recording = false, paused = false;
let elapsed   = 0, startTime, timerInterval;
let markers   = [];
let mediaRecorder, chunks = [];
let audioCtx, analyser, stream;
let waveBuffer = [];
const WAVE_HISTORY = 700;

// Peer connections: peerId → { conn, audioConn, name, muted, chunks, meter }
const peers = {};
// Received file chunks from guests: peerId → Uint8Array[]
const receivedChunks = {};
const receivedMeta   = {};

// ── PeerJS setup ──
let peer;

// ── DOM refs ──
const nameScreen    = $('nameScreen');
const waitingScreen = $('waitingScreen');
const roomScreen    = $('roomScreen');
const enterBtn      = $('enterRoomBtn');
const nameInput     = $('participantName');
const nameError     = $('nameError');
const waitingName   = $('waitingName');
const onAir         = $('onAir');
const roomCodeEl    = $('roomCodeDisplay');
const copyLinkBtn   = $('copyLinkBtn');
const renameBtn     = $('renameRoomBtn');
const deleteBtn     = $('deleteRoomBtn');
const participantsList = $('participantsList');
const participantCount = $('participantCount');
const waitingQueue  = $('waitingQueue');
const waitingList   = $('waitingList');
const recBtn        = $('recBtn');
const pauseBtn      = $('pauseBtn');
const duration      = $('duration');
const durStatus     = $('durStatus');
const markerLog     = $('markerLog');
const transferCard  = $('transferCard');
const transferList  = $('transferList');
const dlSection     = $('dlSection');
const dlGrid        = $('dlGrid');
const waveCanvas    = $('waveCanvas');
const chatMessages  = $('chatMessages');
const chatInput     = $('chatInput');
const chatSend      = $('chatSend');
const m1=$('m1'),m2=$('m2'),m3=$('m3'),m4=$('m4');

// ── Room persistence (localStorage) ──
function getRooms() {
  try { return JSON.parse(localStorage.getItem('vox5000_rooms') || '{}'); } catch { return {}; }
}
function saveRooms(rooms) { localStorage.setItem('vox5000_rooms', JSON.stringify(rooms)); }
function saveRoom(id, data) {
  const rooms = getRooms(); rooms[id] = { ...rooms[id], ...data }; saveRooms(rooms);
}

// ── Entry point ──
enterBtn.addEventListener('click', enterRoom);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom(); });

function enterRoom() {
  const name = nameInput.value.trim();
  if (!name) { nameError.style.display = 'block'; return; }
  nameError.style.display = 'none';
  myName = name;
  nameScreen.style.display = 'none';

  if (isHost) {
    roomId = randId(6);
    saveRoom(roomId, { name: 'Interview Room', created: Date.now() });
    window.history.replaceState({}, '', `?r=${roomId}`);
    initPeer(`HOST-${roomId}`);
  } else {
    if (!isHost) {
      waitingScreen.style.display = 'flex';
      waitingName.textContent = `Joining as: ${name}`;
    }
    initPeer(`GUEST-${roomId}-${randId(4)}`);
  }
}

// ── PeerJS init ──
function initPeer(id) {
  myPeerId = id;
  peer = new Peer(id, {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', peerId => {
    console.log('Peer open:', peerId);
    if (isHost) {
      showRoom();
    } else {
      // Guest connects to host
      connectToHost();
    }
  });

  peer.on('connection', conn => {
    // Host receives guest data connections
    handleIncomingConn(conn);
  });

  peer.on('call', call => {
    // Accept audio calls from any peer
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(s => {
      call.answer(s);
      call.on('stream', remoteStream => {
        addRemoteAudio(call.peer, remoteStream);
      });
    });
  });

  peer.on('error', err => {
    console.error('Peer error:', err);
    if (!isHost && err.type === 'peer-unavailable') {
      addSystemChat('Could not connect to host. The room may not exist.');
    }
  });
}

// ── Guest connects to host ──
function connectToHost() {
  const hostId = `HOST-${roomId}`;
  const conn = peer.connect(hostId, { reliable: true, metadata: { name: myName, type: 'join' } });

  conn.on('open', () => {
    conn.send({ type: 'join_request', name: myName, peerId: myPeerId });
  });

  conn.on('data', data => handleHostMessage(data, conn));
  conn.on('error', err => console.error('Conn error:', err));
}

function handleHostMessage(data, conn) {
  if (data.type === 'admitted') {
    waitingScreen.style.display = 'none';
    showRoom();
    peers['host'] = { conn, name: 'Host' };
    // Now start audio call to host
    startAudioCall(`HOST-${roomId}`);
    addSystemChat(`You joined as ${myName}`);
    updateParticipantsList();
  }
  if (data.type === 'denied') {
    waitingScreen.style.display = 'none';
    nameScreen.style.display = 'flex';
    nameInput.value = '';
    nameError.textContent = 'The host did not admit you.';
    nameError.style.display = 'block';
  }
  if (data.type === 'chat') {
    addChatMessage(data.sender, data.text, false);
  }
  if (data.type === 'record_start') {
    startLocalRecording();
  }
  if (data.type === 'record_stop') {
    stopLocalRecording(() => sendFileToHost(conn));
  }
  if (data.type === 'record_pause') {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
    durStatus.textContent = 'Paused by host';
  }
  if (data.type === 'record_resume') {
    if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
    durStatus.textContent = 'Recording';
  }
  if (data.type === 'mute_you') {
    muteMyMic(data.muted);
  }
  if (data.type === 'participants') {
    updateParticipantsFromList(data.list);
  }
  if (data.type === 'timer_sync') {
    elapsed = data.elapsed;
    duration.textContent = fmt(Math.floor(elapsed));
  }
}

// ── Host handles incoming guest connections ──
function handleIncomingConn(conn) {
  conn.on('open', () => {
    const meta = conn.metadata;
    if (meta && meta.type === 'join') {
      // Add to waiting queue
      addToWaitingQueue(conn, meta.name);
    }
  });

  conn.on('data', data => {
    if (data.type === 'join_request') {
      addToWaitingQueue(conn, data.name);
    }
    if (data.type === 'chat') {
      addChatMessage(data.sender, data.text, false);
      broadcastToAll({ type: 'chat', sender: data.sender, text: data.text }, conn.peer);
    }
    if (data.type === 'file_meta') {
      receivedMeta[conn.peer] = data;
      updateTransferProgress(conn.peer, 0, data.totalChunks);
    }
    if (data.type === 'file_chunk') {
      if (!receivedChunks[conn.peer]) receivedChunks[conn.peer] = [];
      receivedChunks[conn.peer].push(data.chunk);
      const meta = receivedMeta[conn.peer];
      if (meta) {
        const pct = Math.round((receivedChunks[conn.peer].length / meta.totalChunks) * 100);
        updateTransferProgress(conn.peer, pct, meta.totalChunks);
      }
    }
    if (data.type === 'file_done') {
      finaliseGuestTrack(conn.peer);
    }
  });

  conn.on('close', () => {
    if (peers[conn.peer]) {
      addSystemChat(`${peers[conn.peer].name} disconnected`);
      delete peers[conn.peer];
      updateParticipantsList();
      broadcastParticipants();
    }
  });
}

// ── Waiting queue ──
function addToWaitingQueue(conn, name) {
  // Don't add duplicates
  if (peers[conn.peer]) return;

  waitingQueue.style.display = 'block';
  const row = document.createElement('div');
  row.className = 'waiting-row';
  row.id = `wait-${conn.peer}`;
  row.innerHTML = `
    <span class="waiting-row-name">${name}</span>
    <div>
      <button class="btn-admit" onclick="admitGuest('${conn.peer}')">Admit</button>
      <button class="btn-deny" onclick="denyGuest('${conn.peer}')">Deny</button>
    </div>
  `;
  waitingList.appendChild(row);

  // Store pending
  peers[conn.peer] = { conn, name, pending: true };
}

window.admitGuest = function(peerId) {
  const p = peers[peerId];
  if (!p) return;
  p.pending = false;
  p.conn.send({ type: 'admitted' });

  // Call the guest for audio
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  }).then(s => {
    if (!stream) stream = s;
    const call = peer.call(peerId, stream);
    call.on('stream', remoteStream => {
      addRemoteAudio(peerId, remoteStream);
      setupRemoteAnalyser(peerId, remoteStream);
    });
    p.call = call;
  });

  // Remove from waiting list
  const row = $(`wait-${peerId}`);
  if (row) row.remove();
  if (waitingList.children.length === 0) waitingQueue.style.display = 'none';

  updateParticipantsList();
  broadcastParticipants();
  addSystemChat(`${p.name} joined the room`);

  // If already recording, tell them to start
  if (recording) {
    p.conn.send({ type: 'record_start' });
  }
};

window.denyGuest = function(peerId) {
  const p = peers[peerId];
  if (p) { p.conn.send({ type: 'denied' }); delete peers[peerId]; }
  const row = $(`wait-${peerId}`);
  if (row) row.remove();
  if (waitingList.children.length === 0) waitingQueue.style.display = 'none';
};

// ── Audio call (guest to host) ──
function startAudioCall(targetId) {
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: { ideal: 48000 } }
  }).then(s => {
    stream = s;
    setupLocalAnalyser(s);
    const call = peer.call(targetId, s);
    call.on('stream', remoteStream => {
      addRemoteAudio(targetId, remoteStream);
    });
  });
}

function addRemoteAudio(peerId, remoteStream) {
  const existing = $(`audio-${peerId}`);
  if (existing) { existing.srcObject = remoteStream; return; }
  const audio = document.createElement('audio');
  audio.id = `audio-${peerId}`;
  audio.autoplay = true;
  audio.srcObject = remoteStream;
  $('audioElements').appendChild(audio);
}

// ── Local audio setup ──
function setupLocalAnalyser(s) {
  audioCtx = new AudioContext({ sampleRate: 48000 });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const src = audioCtx.createMediaStreamSource(s);
  src.connect(analyser);
  drawMeter('local', analyser);
  drawWave();
}

function setupRemoteAnalyser(peerId, remoteStream) {
  if (!audioCtx) return;
  const analyserR = audioCtx.createAnalyser();
  analyserR.fftSize = 512;
  const src = audioCtx.createMediaStreamSource(remoteStream);
  src.connect(analyserR);
  if (peers[peerId]) peers[peerId].analyser = analyserR;
  drawMeter(peerId, analyserR);
}

function drawMeter(id, anal) {
  const buf = new Uint8Array(anal.frequencyBinCount);
  function tick() {
    anal.getByteTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]-128)/128; if(v>max)max=v; }
    const pct = Math.min(100, Math.round(max*200));
    const fill = $(`meter-${id}`);
    if (fill) fill.style.width = pct + '%';
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Waveform ──
const wCtx = waveCanvas.getContext('2d');
function drawWave() {
  const buf = new Uint8Array(analyser ? analyser.frequencyBinCount : 512);
  function tick() {
    const W = waveCanvas.width = waveCanvas.offsetWidth || 500;
    const H = waveCanvas.height;
    const mid = H/2;
    if (analyser && recording) {
      analyser.getByteTimeDomainData(buf);
      let peak=0, clip=false;
      for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>peak)peak=v;if(buf[i]>242||buf[i]<13)clip=true;}
      waveBuffer.push({peak,clipping:clip});
      if(waveBuffer.length>WAVE_HISTORY)waveBuffer.shift();
    }
    wCtx.fillStyle='#0e0e0e'; wCtx.fillRect(0,0,W,H);
    const clipH=H*0.07;
    wCtx.fillStyle='rgba(255,68,68,0.1)';
    wCtx.fillRect(0,0,W,clipH); wCtx.fillRect(0,H-clipH,W,clipH);
    wCtx.strokeStyle='rgba(255,255,255,0.05)'; wCtx.lineWidth=1;
    wCtx.beginPath(); wCtx.moveTo(0,mid); wCtx.lineTo(W,mid); wCtx.stroke();
    if(waveBuffer.length===0){
      wCtx.strokeStyle='rgba(232,255,71,0.15)'; wCtx.lineWidth=1.5;
      wCtx.beginPath(); wCtx.moveTo(0,mid); wCtx.lineTo(W,mid); wCtx.stroke();
    } else {
      const bW=W/WAVE_HISTORY;
      for(let i=0;i<waveBuffer.length;i++){
        const x=i*bW,{peak:p,clipping:c}=waveBuffer[i],h=Math.max(1,p*(mid-clipH)*0.95);
        wCtx.fillStyle=c?'#FF4444':`rgb(${Math.round(68+Math.min(1,p*2)*164)},255,${Math.round(136-Math.min(1,p*2)*136)})`;
        wCtx.fillRect(x,mid-h,Math.max(1,bW-0.5),h*2);
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Show room ──
function showRoom() {
  roomScreen.style.display = 'block';
  roomCodeEl.textContent = roomId;

  if (isHost) {
    setupHostMic();
    updateParticipantsList();
  }

  // Load rooms list for rename/delete
  const rooms = getRooms();
  const roomData = rooms[roomId] || {};
  if (roomData.name) document.title = `Vox5000 — ${roomData.name}`;
}

function setupHostMic() {
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: { ideal: 48000 } }
  }).then(s => {
    stream = s;
    setupLocalAnalyser(s);
  });
}

// ── Participant list ──
function updateParticipantsList() {
  participantsList.innerHTML = '';
  let count = 1;

  // Host (me if host)
  const hostRow = createParticipantRow(myPeerId, myName, true, isHost, false);
  participantsList.appendChild(hostRow);

  // Guests
  Object.entries(peers).forEach(([pid, p]) => {
    if (p.pending) return;
    count++;
    const row = createParticipantRow(pid, p.name, false, false, isHost);
    participantsList.appendChild(row);
  });

  participantCount.textContent = `${count}/4`;
}

function createParticipantRow(pid, name, isHostUser, isMe, showMuteBtn) {
  const div = document.createElement('div');
  div.className = 'participant-row' + (isHostUser ? ' is-host' : '');
  div.id = `prow-${pid}`;
  const p = peers[pid] || {};
  const muted = p.muted || false;
  div.innerHTML = `
    <div class="participant-avatar">${initials(name)}</div>
    <div class="participant-info">
      <div class="participant-name">${name}${isMe ? ' (You)' : ''}${isHostUser ? ' 🎙' : ''}</div>
      <div class="participant-role">${isHostUser ? 'Host' : 'Guest'}</div>
    </div>
    <div class="participant-meter"><div class="participant-meter-fill" id="meter-${pid}"></div></div>
    ${showMuteBtn && !isMe ? `<div class="participant-actions"><button class="btn-mute ${muted?'muted':''}" onclick="toggleMute('${pid}')">${muted?'Unmute':'Mute'}</button></div>` : ''}
  `;
  return div;
}

window.toggleMute = function(peerId) {
  const p = peers[peerId];
  if (!p) return;
  p.muted = !p.muted;
  p.conn.send({ type: 'mute_you', muted: p.muted });
  updateParticipantsList();
};

function muteMyMic(muted) {
  if (stream) stream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  addSystemChat(muted ? 'You have been muted by the host.' : 'You have been unmuted.');
}

function broadcastParticipants() {
  const list = [{ name: myName, peerId: myPeerId, isHost: true }];
  Object.entries(peers).forEach(([pid, p]) => {
    if (!p.pending) list.push({ name: p.name, peerId: pid, isHost: false });
  });
  broadcastToAll({ type: 'participants', list });
}

function updateParticipantsFromList(list) {
  participantsList.innerHTML = '';
  list.forEach(p => {
    const row = createParticipantRow(p.peerId, p.name, p.isHost, p.peerId === myPeerId, false);
    participantsList.appendChild(row);
  });
  participantCount.textContent = `${list.length}/4`;
}

function broadcastToAll(data, excludePeer) {
  Object.entries(peers).forEach(([pid, p]) => {
    if (pid !== excludePeer && p.conn && !p.pending) {
      try { p.conn.send(data); } catch(e) {}
    }
  });
}

// ── Copy link ──
copyLinkBtn.addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}?r=${roomId}`;
  navigator.clipboard.writeText(url).then(() => {
    copyLinkBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyLinkBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 4V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6a1 1 0 001 1h1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Copy invite link'; }, 2000);
  });
});

// ── Rename / delete room ──
renameBtn.addEventListener('click', () => {
  const newName = prompt('Enter new room name:', getRooms()[roomId]?.name || 'Interview Room');
  if (newName && newName.trim()) {
    saveRoom(roomId, { name: newName.trim() });
    document.title = `Vox5000 — ${newName.trim()}`;
    addSystemChat(`Room renamed to "${newName.trim()}"`);
  }
});

deleteBtn.addEventListener('click', () => {
  if (confirm('Delete this room? This cannot be undone.')) {
    const rooms = getRooms();
    delete rooms[roomId];
    saveRooms(rooms);
    broadcastToAll({ type: 'chat', sender: 'System', text: 'The host has ended and deleted this room.' });
    setTimeout(() => { window.location.href = 'index.html'; }, 1000);
  }
});

// ── Recording ──
recBtn.addEventListener('click', () => {
  if (!isHost) return;
  recording ? stopSession() : startSession();
});

function startSession() {
  if (!stream) { durStatus.textContent = 'Mic not ready'; return; }
  waveBuffer = [];
  chunks = []; markers = [];
  markerLog.textContent = '';
  recording = true; paused = false; elapsed = 0;
  startTime = Date.now();
  timerInterval = setInterval(tickTimer, 500);
  recBtn.classList.add('recording');
  recBtn.innerHTML = '<span class="rec-dot"></span> Stop';
  pauseBtn.disabled = false;
  [m1,m2,m3,m4].forEach(b=>b.disabled=false);
  onAir.classList.add('visible');
  durStatus.textContent = 'Recording';

  // Start local recording
  startLocalRecording();

  // Tell all guests to start recording
  broadcastToAll({ type: 'record_start' });
  addSystemChat('Recording started');
}

function stopSession() {
  recording = false; paused = false;
  clearInterval(timerInterval);
  onAir.classList.remove('visible');
  recBtn.classList.remove('recording');
  recBtn.innerHTML = '<span class="rec-dot"></span> Record';
  pauseBtn.disabled = true;
  [m1,m2,m3,m4].forEach(b=>b.disabled=true);
  durStatus.textContent = 'Finishing up…';

  // Tell guests to stop and send their files
  broadcastToAll({ type: 'record_stop' });
  addSystemChat('Recording stopped — collecting tracks…');

  // Stop host recording
  stopLocalRecording(() => {
    // Show transfer card
    transferCard.style.display = 'block';
    // Add host's own track immediately
    buildHostDownload();
    // Set up transfer rows for each guest
    Object.entries(peers).forEach(([pid, p]) => {
      if (!p.pending) addTransferRow(pid, p.name);
    });
    checkAllTransfersDone();
  });
}

function startLocalRecording() {
  if (!stream) return;
  chunks = [];
  const opts = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 320000 }
    : {};
  mediaRecorder = new MediaRecorder(stream, opts);
  mediaRecorder.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
  mediaRecorder.start(1000);
  if (!isHost) { durStatus.textContent = 'Recording'; onAir.classList.add('visible'); }
}

function stopLocalRecording(cb) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') { if(cb) cb(); return; }
  mediaRecorder.onstop = () => { if(cb) cb(); };
  mediaRecorder.stop();
  if (!isHost) { onAir.classList.remove('visible'); durStatus.textContent = 'Uploading track…'; }
}

function tickTimer() {
  if (!paused) {
    elapsed = (Date.now() - startTime) / 1000;
    duration.textContent = fmt(elapsed);
    // Sync timer to guests
    if (isHost) broadcastToAll({ type: 'timer_sync', elapsed });
  }
}

// ── Pause ──
pauseBtn.addEventListener('click', () => {
  if (!isHost || !recording) return;
  if (!paused) {
    paused = true;
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
    broadcastToAll({ type: 'record_pause' });
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,2 11,7 3,12" fill="currentColor"/></svg> Resume';
    durStatus.textContent = 'Paused';
    onAir.classList.remove('visible');
  } else {
    paused = false;
    startTime = Date.now() - elapsed * 1000;
    if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
    broadcastToAll({ type: 'record_resume' });
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="3.5" height="10" rx="1" fill="currentColor"/><rect x="8.5" y="2" width="3.5" height="10" rx="1" fill="currentColor"/></svg> Pause';
    durStatus.textContent = 'Recording';
    onAir.classList.add('visible');
  }
});

// ── Markers ──
const markerLabels = {m1:'Intro',m2:'Break',m3:'Outro',m4:'Clip'};
[m1,m2,m3,m4].forEach(btn => {
  btn.addEventListener('click', () => {
    if (!recording||paused) return;
    const t = fmt(Math.floor(elapsed));
    markers.push({label:markerLabels[btn.id],time:t});
    markerLog.innerHTML = markers.map(mk=>`<span style="color:#888">${mk.label}</span> @ <span style="color:#E8FF47">${mk.time}</span>`).join(' · ');
  });
});

// ── File transfer: guest → host ──
function sendFileToHost(hostConn) {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks
  const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);

  hostConn.send({ type: 'file_meta', name: myName, totalChunks, size: blob.size, mimeType: 'audio/webm' });

  let offset = 0;
  function sendNext() {
    if (offset >= blob.size) {
      hostConn.send({ type: 'file_done', name: myName });
      durStatus.textContent = 'Track sent ✓';
      return;
    }
    const slice = blob.slice(offset, offset + CHUNK_SIZE);
    const reader = new FileReader();
    reader.onload = e => {
      hostConn.send({ type: 'file_chunk', chunk: e.target.result });
      offset += CHUNK_SIZE;
      const pct = Math.min(100, Math.round(offset / blob.size * 100));
      durStatus.textContent = `Uploading… ${pct}%`;
      setTimeout(sendNext, 10);
    };
    reader.readAsArrayBuffer(slice);
  }
  sendNext();
}

// ── Transfer progress UI ──
function addTransferRow(peerId, name) {
  receivedChunks[peerId] = [];
  const row = document.createElement('div');
  row.className = 'transfer-item';
  row.id = `trow-${peerId}`;
  row.innerHTML = `
    <span class="transfer-name">${name}</span>
    <div class="transfer-bar-wrap"><div class="transfer-bar-fill" id="tbar-${peerId}"></div></div>
    <span class="transfer-pct" id="tpct-${peerId}">0%</span>
  `;
  transferList.appendChild(row);
}

function updateTransferProgress(peerId, pct, total) {
  const bar = $(`tbar-${peerId}`);
  const pctEl = $(`tpct-${peerId}`);
  if (bar) bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
}

function finaliseGuestTrack(peerId) {
  const p = peers[peerId];
  if (!p) return;
  const pctEl = $(`tpct-${peerId}`);
  if (pctEl) pctEl.innerHTML = '<span class="transfer-done">✓ Done</span>';
  const bar = $(`tbar-${peerId}`);
  if (bar) { bar.style.width = '100%'; bar.style.background = 'var(--green)'; }

  // Reassemble chunks
  const allChunks = receivedChunks[peerId];
  if (!allChunks || allChunks.length === 0) return;
  const blob = new Blob(allChunks.map(c => new Uint8Array(c)), { type: 'audio/webm' });

  // Decode and re-encode as WAV
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
      const decoded = await audioCtx.decodeAudioData(e.target.result);
      const wavBlob = encodeWav(decoded, 16);
      const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
      const safeName = p.name.replace(/[^a-zA-Z0-9]/g,'_');
      addDownload(`${safeName}_${ts}.wav`, `${p.name} · WAV · 16-bit · ${(wavBlob.size/1048576).toFixed(1)} MB`, URL.createObjectURL(wavBlob), `${safeName}_${ts}.wav`);
      checkAllTransfersDone();
    } catch(err) { console.error('Guest WAV encode error:', err); }
  };
  reader.readAsArrayBuffer(blob);
}

async function buildHostDownload() {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
  try {
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const wavBlob = encodeWav(decoded, 16);
    const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safeName = myName.replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(`${safeName}_HOST_${ts}.wav`, `${myName} (Host) · WAV · 16-bit · ${(wavBlob.size/1048576).toFixed(1)} MB`, URL.createObjectURL(wavBlob), `${safeName}_HOST_${ts}.wav`);
  } catch(e) { console.error('Host WAV encode error:', e); }
}

function checkAllTransfersDone() {
  const guestCount = Object.values(peers).filter(p => !p.pending).length;
  const doneCount = document.querySelectorAll('.transfer-done').length;
  if (doneCount >= guestCount && guestCount > 0) {
    $('transferNote').textContent = 'All tracks received. You can now download below.';
    buildMixedTrack();
  }
  dlSection.style.display = 'block';
}

async function buildMixedTrack() {
  // Simple mix: decode all downloaded blobs and sum them
  const dlItems = dlGrid.querySelectorAll('.dl-btn');
  if (dlItems.length < 2) return;
  addSystemChat('Building mixed track…');
  // Mixed track message — full mixing would require storing all decoded buffers
  // For now note it's available as individual tracks
  const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  addSystemChat('Individual tracks ready. Mixed track coming in a future update.');
}

// ── WAV encoder ──
function encodeWav(audioBuffer, bits) {
  const ch = audioBuffer.getChannelData(0), n = ch.length, sr = audioBuffer.sampleRate;
  const bps=bits/8, blockAlign=bps, byteRate=sr*bps, dataSize=n*bps;
  const buf=new ArrayBuffer(44); const v=new DataView(buf);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+dataSize,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,byteRate,true);
  v.setUint16(32,blockAlign,true);v.setUint16(34,bits,true);str(36,'data');v.setUint32(40,dataSize,true);
  const samples=new Int16Array(n);
  for(let i=0;i<n;i++){const s=Math.max(-1,Math.min(1,ch[i]));samples[i]=s<0?s*0x8000:s*0x7FFF;}
  const out=new Uint8Array(44+samples.byteLength);
  out.set(new Uint8Array(buf),0);out.set(new Uint8Array(samples.buffer),44);
  return new Blob([out],{type:'audio/wav'});
}

function addDownload(name, meta, url, filename) {
  dlSection.style.display = 'block';
  dlGrid.insertAdjacentHTML('beforeend', `
    <div class="dl-item">
      <div class="dl-info">
        <div class="dl-name">${name}</div>
        <div class="dl-meta">${meta}</div>
      </div>
      <a class="dl-btn" href="${url}" download="${filename}">↓ Download</a>
    </div>
  `);
}

// ── Chat ──
chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); });

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  addChatMessage(myName, text, true);
  broadcastToAll({ type: 'chat', sender: myName, text });
  if (!isHost && peers['host']) {
    try { peers['host'].conn.send({ type: 'chat', sender: myName, text }); } catch(e) {}
  }
}

function addChatMessage(sender, text, isMe) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="chat-msg-sender ${isMe?'is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemChat(text) {
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Room rooms management link on homepage ──
// Add a "My Rooms" link to index.html nav — handled separately

