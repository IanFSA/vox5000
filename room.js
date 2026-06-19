'use strict';

// ── Utilities ──
const $ = id => document.getElementById(id);
function fmt(s) {
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
  return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
}
function randId(len=6) { return Math.random().toString(36).substr(2,len).toUpperCase(); }
function initials(name) { return name.split(' ').map(w=>w[0]||'').join('').substr(0,2).toUpperCase(); }

// ── State ──
const params = new URLSearchParams(window.location.search);
let roomId   = params.get('r');
const isHost = !roomId;
let myName   = '';
let myPeerId = '';
let recording= false, paused=false;
let elapsed  = 0, startTime, timerInterval;
let markers  = [];
let mediaRecorder, chunks=[];
let audioCtx, analyser, localStream;
let waveBuffer=[];
const WAVE_HISTORY=700;
const peers={};           // peerId → {conn, name, muted, pending, analyser}
const receivedChunks={};  // peerId → ArrayBuffer[]
const receivedMeta={};    // peerId → {name, totalChunks, size}
let peer;

// ── Rooms storage ──
function getRooms(){ try{return JSON.parse(localStorage.getItem('vox5000_rooms')||'{}');}catch{return{};} }
function saveRooms(r){ localStorage.setItem('vox5000_rooms',JSON.stringify(r)); }
function saveRoom(id,data){ const r=getRooms(); r[id]={...r[id],...data}; saveRooms(r); }

// ── Headphone check ──
$('hasHeadphones').addEventListener('click', () => {
  $('headphoneScreen').style.display='none';
  $('nameScreen').style.display='flex';
});
$('noHeadphones').addEventListener('click', () => {
  $('headphoneScreen').style.display='none';
  $('feedbackWarnScreen').style.display='flex';
});
$('nowHasHeadphones').addEventListener('click', () => {
  $('feedbackWarnScreen').style.display='none';
  $('nameScreen').style.display='flex';
});
$('continueAnyway').addEventListener('click', () => {
  $('feedbackWarnScreen').style.display='none';
  $('nameScreen').style.display='flex';
});

// ── Name entry ──
$('enterRoomBtn').addEventListener('click', enterRoom);
$('participantName').addEventListener('keydown', e=>{ if(e.key==='Enter') enterRoom(); });

function enterRoom(){
  const name=$('participantName').value.trim();
  if(!name){ $('nameError').style.display='block'; return; }
  $('nameError').style.display='none';
  myName=name;
  $('nameScreen').style.display='none';
  if(isHost){
    roomId=randId(6);
    saveRoom(roomId,{name:'Interview Room',created:Date.now()});
    window.history.replaceState({},'',`?r=${roomId}`);
    initPeer(`HOST-${roomId}`);
  } else {
    $('waitingScreen').style.display='flex';
    $('waitingNameDisplay').textContent=`Joining as: ${name}`;
    initPeer(`GUEST-${roomId}-${randId(4)}`);
  }
}

// ── PeerJS ──
function initPeer(id){
  myPeerId=id;
  peer=new Peer(id,{
    debug:0,
    config:{ iceServers:[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'},
      {urls:'stun:stun2.l.google.com:19302'}
    ]}
  });
  peer.on('open', peerId=>{
    console.log('Peer open:',peerId);
    if(isHost){ showHostRoom(); }
    else { connectToHost(); }
  });
  peer.on('connection', conn=>{ handleIncomingConn(conn); });
  peer.on('call', call=>{
    navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:{ideal:48000}}
    }).then(s=>{
      if(!localStream){ localStream=s; setupLocalAnalyser(s); }
      call.answer(localStream);
      call.on('stream', remote=>{ addRemoteAudio(call.peer,remote); setupRemoteAnalyser(call.peer,remote); });
    });
  });
  peer.on('error', err=>{
    console.error('Peer error:',err);
    if(!isHost && err.type==='peer-unavailable'){
      guestSystemMsg('Could not connect to host. Check the link and try again.');
    }
  });
}

// ── Guest connects to host ──
function connectToHost(){
  const hostId=`HOST-${roomId}`;
  const conn=peer.connect(hostId,{reliable:true,metadata:{name:myName,type:'guest_join'}});
  conn.on('open',()=>{
    conn.send({type:'join_request',name:myName,peerId:myPeerId});
    peers['host']={conn,name:'Host'};
  });
  conn.on('data', data=>handleHostMessage(data,conn));
  conn.on('error', err=>console.error('Guest conn error:',err));
  conn.on('close',()=>{ guestSystemMsg('Disconnected from host.'); });
}

function handleHostMessage(data,conn){
  if(data.type==='admitted'){
    $('waitingScreen').style.display='none';
    showGuestRoom();
    // Start audio call to host
    navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:{ideal:48000}}
    }).then(s=>{
      localStream=s;
      setupLocalAnalyser(s,'guestWaveCanvas');
      const call=peer.call(`HOST-${roomId}`,s);
      call.on('stream',remote=>{ addRemoteAudio('host',remote); });
    });
    guestSystemMsg(`You're in. Welcome ${myName}!`);
  }
  if(data.type==='denied'){
    $('waitingScreen').style.display='none';
    $('nameScreen').style.display='flex';
    $('nameError').textContent='The host did not admit you.';
    $('nameError').style.display='block';
  }
  if(data.type==='chat'){ guestAddChat(data.sender,data.text,false); }
  if(data.type==='countdown'){ showCountdown(data.count); }
  if(data.type==='record_start'){ startGuestRecording(); }
  if(data.type==='record_stop'){ stopGuestRecording(conn); }
  if(data.type==='record_pause'){
    if(mediaRecorder&&mediaRecorder.state==='recording') mediaRecorder.pause();
    $('guestStatusDisplay').textContent='Recording paused';
  }
  if(data.type==='record_resume'){
    if(mediaRecorder&&mediaRecorder.state==='paused') mediaRecorder.resume();
    $('guestStatusDisplay').textContent='Recording';
  }
  if(data.type==='mute_you'){
    if(localStream) localStream.getAudioTracks().forEach(t=>t.enabled=!data.muted);
    guestSystemMsg(data.muted?'You have been muted by the host.':'You have been unmuted.');
  }
  if(data.type==='timer_sync'){
    elapsed=data.elapsed;
    $('guestRecDuration').textContent=fmt(Math.floor(elapsed));
  }
}

// ── Host handles incoming connections ──
function handleIncomingConn(conn){
  conn.on('open',()=>{
    const meta=conn.metadata||{};
    if(meta.type==='guest_join'||true){
      // Wait for join_request data
    }
  });
  conn.on('data',data=>{
    if(data.type==='join_request'){
      // Don't add duplicates
      if(peers[conn.peer]&&!peers[conn.peer].pending) return;
      peers[conn.peer]={conn,name:data.name,pending:true};
      showWaitingGuest(conn.peer,data.name);
    }
    if(data.type==='chat'){
      hostAddChat(data.sender,data.text,false);
      broadcastToGuests({type:'chat',sender:data.sender,text:data.text},conn.peer);
    }
    if(data.type==='file_meta'){
      receivedMeta[conn.peer]=data;
      receivedChunks[conn.peer]=[];
      addTransferRow(conn.peer,data.name);
    }
    if(data.type==='file_chunk'){
      if(!receivedChunks[conn.peer]) receivedChunks[conn.peer]=[];
      receivedChunks[conn.peer].push(data.chunk);
      const meta=receivedMeta[conn.peer];
      if(meta){
        const pct=Math.round((receivedChunks[conn.peer].length/meta.totalChunks)*100);
        updateTransferBar(conn.peer,pct);
      }
    }
    if(data.type==='file_done'){ finaliseGuestTrack(conn.peer); }
  });
  conn.on('close',()=>{
    if(peers[conn.peer]&&!peers[conn.peer].pending){
      hostSystemMsg(`${peers[conn.peer].name} disconnected.`);
      delete peers[conn.peer];
      renderParticipants();
    } else if(peers[conn.peer]){
      // Remove from waiting
      const row=$(`wait-${conn.peer}`);
      if(row) row.remove();
      delete peers[conn.peer];
    }
  });
}

// ── Waiting queue UI ──
function showWaitingGuest(peerId,name){
  $('waitingQueue').style.display='block';
  const row=document.createElement('div');
  row.className='waiting-row'; row.id=`wait-${peerId}`;
  row.innerHTML=`
    <span class="waiting-row-name">⏳ ${name} wants to join</span>
    <div>
      <button class="btn-admit" onclick="admitGuest('${peerId}')">Admit</button>
      <button class="btn-deny" onclick="denyGuest('${peerId}')">Deny</button>
    </div>`;
  $('waitingList').appendChild(row);
  hostSystemMsg(`${name} is waiting to join.`);
}

window.admitGuest=function(peerId){
  const p=peers[peerId]; if(!p) return;
  p.pending=false;
  p.conn.send({type:'admitted'});
  // Call guest for audio
  navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:{ideal:48000}}
  }).then(s=>{
    if(!localStream){ localStream=s; setupLocalAnalyser(s,'hostWaveCanvas'); }
    const call=peer.call(peerId,localStream);
    call.on('stream',remote=>{ addRemoteAudio(peerId,remote); setupRemoteAnalyser(peerId,remote); });
    p.call=call;
  });
  const row=$(`wait-${peerId}`); if(row) row.remove();
  if($('waitingList').children.length===0) $('waitingQueue').style.display='none';
  renderParticipants();
  hostSystemMsg(`${p.name} has joined the room.`);
  if(recording) p.conn.send({type:'record_start'});
};

window.denyGuest=function(peerId){
  const p=peers[peerId]; if(!p) return;
  p.conn.send({type:'denied'});
  delete peers[peerId];
  const row=$(`wait-${peerId}`); if(row) row.remove();
  if($('waitingList').children.length===0) $('waitingQueue').style.display='none';
};

// ── Audio ──
function addRemoteAudio(peerId,remoteStream){
  let audio=$(`audio-${peerId}`);
  if(!audio){
    audio=document.createElement('audio');
    audio.id=`audio-${peerId}`; audio.autoplay=true;
    $('audioElements').appendChild(audio);
  }
  audio.srcObject=remoteStream;
}

function setupLocalAnalyser(s,canvasId='hostWaveCanvas'){
  if(!audioCtx) audioCtx=new AudioContext({sampleRate:48000});
  analyser=audioCtx.createAnalyser(); analyser.fftSize=1024;
  const src=audioCtx.createMediaStreamSource(s);
  src.connect(analyser);
  drawMeter('local',analyser);
  drawWave(canvasId,analyser);
}

function setupRemoteAnalyser(peerId,remote){
  if(!audioCtx) return;
  const anal=audioCtx.createAnalyser(); anal.fftSize=512;
  const src=audioCtx.createMediaStreamSource(remote);
  src.connect(anal);
  if(peers[peerId]) peers[peerId].analyser=anal;
  drawMeter(peerId,anal);
}

function drawMeter(id,anal){
  const buf=new Uint8Array(anal.frequencyBinCount);
  function tick(){
    anal.getByteTimeDomainData(buf);
    let max=0;
    for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>max)max=v;}
    const fill=$(`meter-${id}`);
    if(fill) fill.style.width=Math.min(100,Math.round(max*200))+'%';
    requestAnimationFrame(tick);
  }
  tick();
}

function drawWave(canvasId,anal){
  const canvas=$(canvasId); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const buf=new Uint8Array(anal.frequencyBinCount);
  let buf2=[];
  function tick(){
    const W=canvas.width=canvas.offsetWidth||600;
    const H=canvas.height; const mid=H/2;
    if(recording||(!isHost)){
      anal.getByteTimeDomainData(buf);
      let peak=0,clip=false;
      for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>peak)peak=v;if(buf[i]>242||buf[i]<13)clip=true;}
      buf2.push({peak,clipping:clip});
      if(buf2.length>WAVE_HISTORY) buf2.shift();
    }
    ctx.fillStyle='#0e0e0e'; ctx.fillRect(0,0,W,H);
    const clipH=H*0.07;
    ctx.fillStyle='rgba(255,68,68,0.1)';
    ctx.fillRect(0,0,W,clipH); ctx.fillRect(0,H-clipH,W,clipH);
    ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,mid); ctx.lineTo(W,mid); ctx.stroke();
    if(buf2.length===0){
      ctx.strokeStyle='rgba(232,255,71,0.15)'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(0,mid); ctx.lineTo(W,mid); ctx.stroke();
    } else {
      const bW=W/WAVE_HISTORY;
      for(let i=0;i<buf2.length;i++){
        const x=i*bW,{peak:p,clipping:c}=buf2[i],h=Math.max(1,p*(mid-clipH)*0.95);
        ctx.fillStyle=c?'#FF4444':`rgb(${Math.round(68+Math.min(1,p*2)*164)},255,${Math.round(136-Math.min(1,p*2)*136)})`;
        ctx.fillRect(x,mid-h,Math.max(1,bW-0.5),h*2);
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Show rooms ──
function showHostRoom(){
  $('hostRoom').style.display='block';
  const rooms=getRooms(), rd=rooms[roomId]||{};
  $('roomCodeDisplay').textContent=roomId;
  $('roomNameDisplay').textContent=rd.name||'Interview Room';
  document.title=`Vox5000 — ${rd.name||'Interview Room'}`;
  setupHostMic();
  renderParticipants();
  setupHostControls();
}

function setupHostMic(){
  navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:{ideal:48000}}
  }).then(s=>{ localStream=s; setupLocalAnalyser(s,'hostWaveCanvas'); });
}

function showGuestRoom(){
  $('guestRoom').style.display='block';
  $('guestNameDisplay').textContent=myName;
  $('guestRoomCode').textContent=roomId;
  $('guestStatusDisplay').textContent='Connected — waiting for host to start recording';
  setupGuestControls();
}

// ── Participants list ──
function renderParticipants(){
  const list=$('participantsList'); list.innerHTML='';
  // Host row
  list.appendChild(makeParticipantRow(myPeerId,myName,true,true));
  // Guest rows
  Object.entries(peers).forEach(([pid,p])=>{
    if(p.pending) return;
    list.appendChild(makeParticipantRow(pid,p.name,false,false));
  });
  const total=1+Object.values(peers).filter(p=>!p.pending).length;
  $('participantCount').textContent=`${total}/4`;
}

function makeParticipantRow(pid,name,isHostUser,isMe){
  const div=document.createElement('div');
  div.className='participant-row'+(isHostUser?' is-host':'');
  div.id=`prow-${pid}`;
  const p=peers[pid]||{};
  div.innerHTML=`
    <div class="participant-avatar">${initials(name)}</div>
    <div style="flex:1;min-width:0;">
      <div class="participant-name">${name}${isMe?' (You)':''}${isHostUser?' 🎙':''}</div>
      <div class="participant-role">${isHostUser?'Host':'Guest'}</div>
    </div>
    <div class="participant-meter"><div class="participant-meter-fill" id="meter-${pid}"></div></div>
    ${(!isMe&&!isHostUser)?`<button class="btn-mute${p.muted?' muted':''}" onclick="toggleMute('${pid}')">${p.muted?'Unmute':'Mute'}</button>`:''}
  `;
  return div;
}

window.toggleMute=function(peerId){
  const p=peers[peerId]; if(!p) return;
  p.muted=!p.muted;
  p.conn.send({type:'mute_you',muted:p.muted});
  renderParticipants();
  hostSystemMsg(p.muted?`${p.name} has been muted.`:`${p.name} has been unmuted.`);
};

// ── Host controls ──
function setupHostControls(){
  $('copyLinkBtn').addEventListener('click',()=>{
    const url=`${location.origin}${location.pathname}?r=${roomId}`;
    navigator.clipboard.writeText(url).then(()=>{
      $('copyLinkBtn').textContent='✓ Copied!';
      setTimeout(()=>{ $('copyLinkBtn').textContent='📋 Copy invite link'; },2000);
    });
  });

  $('renameRoomBtn').addEventListener('click',()=>{
    const rooms=getRooms();
    const current=(rooms[roomId]&&rooms[roomId].name)||'Interview Room';
    const newName=prompt('Enter new room name:',current);
    if(newName&&newName.trim()){
      saveRoom(roomId,{name:newName.trim()});
      $('roomNameDisplay').textContent=newName.trim();
      document.title=`Vox5000 — ${newName.trim()}`;
      hostSystemMsg(`Room renamed to "${newName.trim()}"`);
    }
  });

  $('deleteRoomBtn').addEventListener('click',()=>{
    if(confirm('Delete this room? This cannot be undone.')){
      const r=getRooms(); delete r[roomId]; saveRooms(r);
      broadcastToGuests({type:'chat',sender:'System',text:'The host has ended this session.'});
      setTimeout(()=>{ window.location.href='index.html'; },800);
    }
  });

  $('recBtn').addEventListener('click',()=>{ recording?stopSession():startSession(); });

  $('pauseBtn').addEventListener('click',()=>{
    if(!recording) return;
    if(!paused){
      paused=true;
      if(mediaRecorder&&mediaRecorder.state==='recording') mediaRecorder.pause();
      broadcastToGuests({type:'record_pause'});
      $('pauseBtn').innerHTML='<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,2 11,7 3,12" fill="currentColor"/></svg> Resume';
      $('hostDurStatus').textContent='Paused';
      $('onAir').classList.remove('visible');
    } else {
      paused=false;
      startTime=Date.now()-elapsed*1000;
      if(mediaRecorder&&mediaRecorder.state==='paused') mediaRecorder.resume();
      broadcastToGuests({type:'record_resume'});
      $('pauseBtn').innerHTML='<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="3.5" height="10" rx="1" fill="currentColor"/><rect x="8.5" y="2" width="3.5" height="10" rx="1" fill="currentColor"/></svg> Pause';
      $('hostDurStatus').textContent='Recording';
      $('onAir').classList.add('visible');
    }
  });

  ['m1','m2','m3','m4'].forEach(id=>{
    const labels={m1:'Intro',m2:'Break',m3:'Outro',m4:'Clip'};
    $(id).addEventListener('click',()=>{
      if(!recording||paused) return;
      const t=fmt(Math.floor(elapsed));
      markers.push({label:labels[id],time:t});
      $('markerLog').innerHTML=markers.map(mk=>`<span style="color:#888">${mk.label}</span> @ <span style="color:#E8FF47">${mk.time}</span>`).join(' · ');
    });
  });

  // Host chat
  $('hostChatSend').addEventListener('click',()=>hostSendChat());
  $('hostChatInput').addEventListener('keydown',e=>{ if(e.key==='Enter') hostSendChat(); });
}

// ── Guest controls ──
function setupGuestControls(){
  $('guestChatSend').addEventListener('click',()=>guestSendChat());
  $('guestChatInput').addEventListener('keydown',e=>{ if(e.key==='Enter') guestSendChat(); });
}

// ── Session start/stop ──
function startSession(){
  if(!localStream){ $('hostDurStatus').textContent='Mic not ready'; return; }
  // 5 second countdown on all screens
  runCountdown(5,()=>{
    beginRecording();
    broadcastToGuests({type:'record_start'});
  });
  // Tell guests countdown is starting
  for(let i=5;i>=1;i--){
    setTimeout(()=>{ broadcastToGuests({type:'countdown',count:i}); },(5-i)*1000);
  }
}

function runCountdown(from,cb){
  $('countdownScreen').style.display='flex';
  $('hostRoom').style.display='none';
  let count=from;
  $('countdownNumber').textContent=count;
  const iv=setInterval(()=>{
    count--;
    if(count<=0){
      clearInterval(iv);
      $('countdownScreen').style.display='none';
      $('hostRoom').style.display='block';
      cb();
    } else {
      $('countdownNumber').textContent=count;
    }
  },1000);
}

function showCountdown(count){
  if(count>0){
    $('guestRoom').style.display='none';
    $('countdownScreen').style.display='flex';
    $('countdownNumber').textContent=count;
  } else {
    $('countdownScreen').style.display='none';
    $('guestRoom').style.display='block';
  }
}

function beginRecording(){
  chunks=[]; markers=[]; waveBuffer=[];
  $('markerLog').textContent='';
  recording=true; paused=false; elapsed=0;
  startTime=Date.now();
  timerInterval=setInterval(tickTimer,500);
  $('recBtn').classList.add('recording');
  $('recBtn').innerHTML='<span class="rec-dot"></span> Stop Recording';
  $('pauseBtn').disabled=false;
  ['m1','m2','m3','m4'].forEach(id=>$(id).disabled=false);
  $('onAir').classList.add('visible');
  $('hostDurStatus').textContent='Recording';
  startLocalRecording();
  hostSystemMsg('Recording started.');
}

function stopSession(){
  recording=false; paused=false;
  clearInterval(timerInterval);
  $('onAir').classList.remove('visible');
  $('recBtn').classList.remove('recording');
  $('recBtn').innerHTML='<span class="rec-dot"></span> Record';
  $('pauseBtn').disabled=true;
  ['m1','m2','m3','m4'].forEach(id=>$(id).disabled=true);
  $('hostDurStatus').textContent='Finishing…';
  broadcastToGuests({type:'record_stop'});
  hostSystemMsg('Recording stopped. Collecting guest tracks…');
  stopLocalRecording(()=>{
    buildHostDownload();
    const guestPeers=Object.entries(peers).filter(([,p])=>!p.pending);
    if(guestPeers.length>0){
      $('transferCard').style.display='block';
    } else {
      $('hostDurStatus').textContent='Done';
      $('dlSection').style.display='block';
    }
  });
}

function tickTimer(){
  if(!paused){
    elapsed=(Date.now()-startTime)/1000;
    $('hostDuration').textContent=fmt(elapsed);
    broadcastToGuests({type:'timer_sync',elapsed});
  }
}

// ── Local recording ──
function startLocalRecording(){
  if(!localStream) return;
  chunks=[];
  const opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ?{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:320000}:{};
  mediaRecorder=new MediaRecorder(localStream,opts);
  mediaRecorder.ondataavailable=e=>{ if(e.data.size>0) chunks.push(e.data); };
  mediaRecorder.start(1000);
}

function stopLocalRecording(cb){
  if(!mediaRecorder||mediaRecorder.state==='inactive'){if(cb)cb();return;}
  mediaRecorder.onstop=()=>{if(cb)cb();};
  mediaRecorder.stop();
}

// ── Guest recording ──
function startGuestRecording(){
  chunks=[];
  const opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ?{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:320000}:{};
  mediaRecorder=new MediaRecorder(localStream,opts);
  mediaRecorder.ondataavailable=e=>{ if(e.data.size>0) chunks.push(e.data); };
  mediaRecorder.start(1000);
  $('guestRecordingCard').style.display='block';
  $('guestStatusDisplay').textContent='Recording';
  $('onAir').classList.add('visible');
}

function stopGuestRecording(hostConn){
  $('onAir').classList.remove('visible');
  $('guestRecordingCard').style.display='none';
  $('guestStatusDisplay').textContent='Sending track to host…';
  $('guestUploadCard').style.display='block';
  if(!mediaRecorder||mediaRecorder.state==='inactive'){
    sendFileToHost(hostConn); return;
  }
  mediaRecorder.onstop=()=>sendFileToHost(hostConn);
  mediaRecorder.stop();
}

// ── File transfer ──
function sendFileToHost(hostConn){
  const blob=new Blob(chunks,{type:'audio/webm'});
  const CHUNK=65536;
  const totalChunks=Math.ceil(blob.size/CHUNK);
  hostConn.send({type:'file_meta',name:myName,totalChunks,size:blob.size,mimeType:'audio/webm'});
  let offset=0;
  function next(){
    if(offset>=blob.size){
      hostConn.send({type:'file_done',name:myName});
      $('guestUploadCard').style.display='none';
      $('guestDoneCard').style.display='block';
      $('guestStatusDisplay').textContent='Track sent ✓';
      return;
    }
    const slice=blob.slice(offset,offset+CHUNK);
    const reader=new FileReader();
    reader.onload=e=>{
      hostConn.send({type:'file_chunk',chunk:e.target.result});
      offset+=CHUNK;
      const pct=Math.min(100,Math.round(offset/blob.size*100));
      $('guestUploadBar').style.width=pct+'%';
      $('guestUploadPct').textContent=pct+'%';
      setTimeout(next,10);
    };
    reader.readAsArrayBuffer(slice);
  }
  next();
}

function addTransferRow(peerId,name){
  const row=document.createElement('div');
  row.className='transfer-item'; row.id=`trow-${peerId}`;
  row.innerHTML=`
    <span class="transfer-name">${name}</span>
    <div class="transfer-bar-wrap"><div class="transfer-bar-fill" id="tbar-${peerId}"></div></div>
    <span class="transfer-pct" id="tpct-${peerId}">0%</span>`;
  $('transferList').appendChild(row);
}

function updateTransferBar(peerId,pct){
  const bar=$(`tbar-${peerId}`); if(bar) bar.style.width=pct+'%';
  const el=$(`tpct-${peerId}`); if(el) el.textContent=pct+'%';
}

async function finaliseGuestTrack(peerId){
  const p=peers[peerId]; if(!p) return;
  const bar=$(`tbar-${peerId}`); if(bar){bar.style.width='100%';bar.style.background='var(--green)';}
  const el=$(`tpct-${peerId}`); if(el) el.innerHTML='<span class="transfer-done">✓ Done</span>';

  const allChunks=receivedChunks[peerId];
  if(!allChunks||allChunks.length===0) return;
  const blob=new Blob(allChunks.map(c=>new Uint8Array(c)),{type:'audio/webm'});
  try{
    if(!audioCtx) audioCtx=new AudioContext({sampleRate:48000});
    const decoded=await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const wavBlob=encodeWav(decoded,16);
    const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safe=p.name.replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(`${safe}_${ts}.wav`,`${p.name} · WAV · 16-bit · ${(wavBlob.size/1048576).toFixed(1)} MB`,URL.createObjectURL(wavBlob),`${safe}_${ts}.wav`);
    hostSystemMsg(`${p.name}'s track received.`);
  }catch(e){ console.error('Guest WAV error:',e); hostSystemMsg(`Error processing ${p.name}'s track.`); }

  checkAllDone();
}

async function buildHostDownload(){
  const blob=new Blob(chunks,{type:'audio/webm'});
  try{
    if(!audioCtx) audioCtx=new AudioContext({sampleRate:48000});
    const decoded=await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const wavBlob=encodeWav(decoded,16);
    const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safe=myName.replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(`${safe}_HOST_${ts}.wav`,`${myName} (Host) · WAV · 16-bit · ${(wavBlob.size/1048576).toFixed(1)} MB`,URL.createObjectURL(wavBlob),`${safe}_HOST_${ts}.wav`);
    $('dlSection').style.display='block';
  }catch(e){ console.error('Host WAV error:',e); }
}

function checkAllDone(){
  const guests=Object.values(peers).filter(p=>!p.pending);
  const done=document.querySelectorAll('.transfer-done').length;
  if(done>=guests.length&&guests.length>0){
    $('transferNote').innerHTML='<strong style="color:var(--green)">✓ All tracks received. Download below.</strong>';
    $('hostDurStatus').textContent='Done';
    $('dlSection').style.display='block';
  }
}

function encodeWav(audioBuffer,bits){
  const ch=audioBuffer.getChannelData(0),n=ch.length,sr=audioBuffer.sampleRate;
  const bps=bits/8,byteRate=sr*bps,dataSize=n*bps;
  const buf=new ArrayBuffer(44);const v=new DataView(buf);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+dataSize,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,byteRate,true);
  v.setUint16(32,bps,true);v.setUint16(34,bits,true);str(36,'data');v.setUint32(40,dataSize,true);
  const s16=new Int16Array(n);
  for(let i=0;i<n;i++){const s=Math.max(-1,Math.min(1,ch[i]));s16[i]=s<0?s*0x8000:s*0x7FFF;}
  const out=new Uint8Array(44+s16.byteLength);
  out.set(new Uint8Array(buf),0);out.set(new Uint8Array(s16.buffer),44);
  return new Blob([out],{type:'audio/wav'});
}

function addDownload(name,meta,url,filename){
  $('dlSection').style.display='block';
  $('dlGrid').insertAdjacentHTML('beforeend',`
    <div class="dl-item">
      <div><div class="dl-name">${name}</div><div class="dl-meta">${meta}</div></div>
      <a class="dl-btn" href="${url}" download="${filename}">↓ Download</a>
    </div>`);
}

// ── Chat ──
function hostSendChat(){
  const text=$('hostChatInput').value.trim(); if(!text) return;
  $('hostChatInput').value='';
  hostAddChat(myName,text,true);
  broadcastToGuests({type:'chat',sender:myName,text});
}
function hostAddChat(sender,text,isMe){
  const div=document.createElement('div'); div.className='chat-msg';
  div.innerHTML=`<span class="chat-msg-sender ${isMe?'is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
  $('hostChatMessages').appendChild(div);
  $('hostChatMessages').scrollTop=$('hostChatMessages').scrollHeight;
}
function hostSystemMsg(text){
  const div=document.createElement('div'); div.className='chat-system'; div.textContent=text;
  $('hostChatMessages').appendChild(div);
  $('hostChatMessages').scrollTop=$('hostChatMessages').scrollHeight;
}

function guestSendChat(){
  const text=$('guestChatInput').value.trim(); if(!text) return;
  $('guestChatInput').value='';
  guestAddChat(myName,text,true);
  if(peers['host']&&peers['host'].conn){
    try{peers['host'].conn.send({type:'chat',sender:myName,text});}catch(e){}
  }
}
function guestAddChat(sender,text,isMe){
  const div=document.createElement('div'); div.className='chat-msg';
  div.innerHTML=`<span class="chat-msg-sender ${isMe?'is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
  $('guestChatMessages').appendChild(div);
  $('guestChatMessages').scrollTop=$('guestChatMessages').scrollHeight;
}
function guestSystemMsg(text){
  const div=document.createElement('div'); div.className='chat-system'; div.textContent=text;
  $('guestChatMessages').appendChild(div);
  $('guestChatMessages').scrollTop=$('guestChatMessages').scrollHeight;
}

function broadcastToGuests(data,excludePeer){
  Object.entries(peers).forEach(([pid,p])=>{
    if(pid!==excludePeer&&p.conn&&!p.pending){
      try{p.conn.send(data);}catch(e){}
    }
  });
}
