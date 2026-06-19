'use strict';

const $ = id => document.getElementById(id);
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);return[h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');}
function randId(len=6){return Math.random().toString(36).substr(2,len).toUpperCase();}
function initials(name){return name.split(' ').map(w=>w[0]||'').join('').substr(0,2).toUpperCase();}
function tsNow(){return new Date().toISOString();}

// ── State ──
const params=new URLSearchParams(window.location.search);
let roomId=params.get('r');
const isHost=!roomId;
let myName='',myPeerId='',myConsented=false,myIsObserver=false;
let recording=false,paused=false,elapsed=0,startTime,timerInterval;
let markers=[];
let mediaRecorder,chunks=[];
let audioCtx,analyser,localStream;
let waveBuffer=[];
const WAVE_HISTORY=700;
const peers={};
const receivedChunks={},receivedMeta={};
let peer;
const consentLog=[];
let hostReturning=false;

// ── Room storage ──
function getRooms(){try{return JSON.parse(localStorage.getItem('vox5000_rooms')||'{}');}catch{return{};}}
function saveRooms(r){localStorage.setItem('vox5000_rooms',JSON.stringify(r));}
function saveRoom(id,data){const r=getRooms();r[id]={...r[id],...data};saveRooms(r);}
function getHostSession(){try{return JSON.parse(sessionStorage.getItem('vox5000_host')||'null');}catch{return null;}}
function saveHostSession(data){sessionStorage.setItem('vox5000_host',JSON.stringify(data));}

// ── Visitor info ──
async function getVisitorInfo(){
  let ip='Unknown';
  try{const r=await fetch('https://api.ipify.org?format=json');const d=await r.json();ip=d.ip;}catch{}
  return{ip,browser:navigator.userAgent,platform:navigator.platform,language:navigator.language,screenRes:`${screen.width}x${screen.height}`};
}

// ── Navigation ──
function setupNav(){
  // Logo and Home nav both go home with warning if in active room
  ['logoHomeLink','navHome'].forEach(id=>{
    const el=$(id);if(!el)return;
    el.addEventListener('click',e=>{
      e.preventDefault();
      if(recording){
        if(!confirm('You are currently recording. Leaving will stop the recording and disconnect all guests. Are you sure?'))return;
        stopSession();
      } else if(isHost&&Object.values(peers).some(p=>!p.pending)){
        if(!confirm('You have guests connected. Leaving will disconnect them. Are you sure?'))return;
      }
      window.location.href='index.html';
    });
  });
}

// ── Check if host is returning to their own room ──
function checkHostReturn(){
  if(!isHost||!roomId) return false;
  const session=getHostSession();
  if(session&&session.roomId===roomId&&session.name){
    myName=session.name;
    myConsented=true;myIsObserver=false;
    hostReturning=true;
    return true;
  }
  return false;
}

// ── Headphone check ──
$('hasHeadphones').addEventListener('click',()=>{$('headphoneScreen').style.display='none';$('nameScreen').style.display='flex';});
$('noHeadphones').addEventListener('click',()=>{$('headphoneScreen').style.display='none';$('feedbackWarnScreen').style.display='flex';});
$('nowHasHeadphones').addEventListener('click',()=>{$('feedbackWarnScreen').style.display='none';$('nameScreen').style.display='flex';});
$('continueAnyway').addEventListener('click',()=>{$('feedbackWarnScreen').style.display='none';$('nameScreen').style.display='flex';});

// Show consent only for guests
if(!isHost) $('consentSection').style.display='block';
if(!isHost) $('consentCheck').addEventListener('change',()=>{myConsented=$('consentCheck').checked;myIsObserver=!myConsented;});

// ── Entry ──
$('enterRoomBtn').addEventListener('click',enterRoom);
$('participantName').addEventListener('keydown',e=>{if(e.key==='Enter')enterRoom();});

async function enterRoom(){
  const name=$('participantName').value.trim();
  if(!name){$('nameError').style.display='block';return;}
  $('nameError').style.display='none';
  myName=name;
  $('nameScreen').style.display='none';

  if(isHost){
    myConsented=true;myIsObserver=false;
    roomId=randId(6);
    saveRoom(roomId,{name:'Interview Room',created:Date.now()});
    saveHostSession({roomId,name:myName});
    window.history.replaceState({},'',`?r=${roomId}`);
    const info=await getVisitorInfo();
    consentLog.push({name:myName,role:'Host',consented:true,observer:false,timestamp:tsNow(),...info,roomId});
    showLoadingThenHostRoom();
  } else {
    myConsented=$('consentCheck').checked;
    myIsObserver=!myConsented;
    const info=await getVisitorInfo();
    consentLog.push({name:myName,role:'Guest',consented:myConsented,observer:myIsObserver,timestamp:tsNow(),...info,roomId});
    $('waitingScreen').style.display='flex';
    $('waitingTitle').textContent='Waiting to be admitted';
    $('waitingSub').textContent='The host will let you in shortly. Keep this page open.';
    $('waitingNameDisplay').textContent=`Joining as: ${name}${myIsObserver?' (Observer)':''}`;
    initPeer(`GUEST-${roomId}-${randId(4)}`);
  }
}

function showLoadingThenHostRoom(){
  $('waitingScreen').style.display='flex';
  $('waitingTitle').textContent='Setting up your room…';
  $('waitingSub').textContent='Just a moment while we connect.';
  $('waitingNameDisplay').textContent='';
  initPeer(`HOST-${roomId}`);
}

// ── PeerJS ──
function initPeer(id){
  myPeerId=id;
  peer=new Peer(id,{debug:0,config:{iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun2.l.google.com:19302'}
  ]}});
  peer.on('open',()=>{if(isHost)showHostRoom();else connectToHost();});
  peer.on('connection',conn=>handleIncomingConn(conn));
  peer.on('call',call=>{
    getMic().then(s=>{
      call.answer(myIsObserver?new MediaStream():s);
      call.on('stream',remote=>{addRemoteAudio(call.peer,remote);setupRemoteAnalyser(call.peer,remote);});
    });
  });
  peer.on('error',err=>{
    console.error('Peer error:',err);
    if(!isHost&&err.type==='peer-unavailable') guestSystemMsg('Could not connect to host. Check the link and try again.');
  });
}

function getMic(){
  if(localStream) return Promise.resolve(localStream);
  return navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:{ideal:48000}}
  }).then(s=>{localStream=s;return s;});
}

// ── Guest → Host ──
function connectToHost(){
  const conn=peer.connect(`HOST-${roomId}`,{reliable:true,metadata:{name:myName}});
  conn.on('open',()=>{
    conn.send({type:'join_request',name:myName,peerId:myPeerId,consented:myConsented,observer:myIsObserver});
    peers['host']={conn,name:'Host'};
  });
  conn.on('data',data=>handleHostMessage(data,conn));
  conn.on('close',()=>guestSystemMsg('Disconnected from host.'));
  conn.on('error',err=>console.error('Guest conn error:',err));
}

function handleHostMessage(data,conn){
  if(data.type==='admitted'){
    $('waitingScreen').style.display='none';
    showGuestRoom();
    getMic().then(s=>{
      if(myIsObserver) s.getAudioTracks().forEach(t=>t.enabled=false);
      setupLocalAnalyser(s,'guestWaveCanvas');
      const call=peer.call(`HOST-${roomId}`,myIsObserver?new MediaStream():s);
      call.on('stream',remote=>addRemoteAudio('host',remote));
    });
    guestSystemMsg(`You're in the room${myIsObserver?' as an Observer':''}.`);
  }
  if(data.type==='denied'){
    $('waitingScreen').style.display='none';
    $('nameScreen').style.display='flex';
    $('nameError').textContent='The host did not admit you.';
    $('nameError').style.display='block';
  }
  if(data.type==='kicked') showThankyou('You have been removed from this session by the host.');
  if(data.type==='chat') guestAddChat(data.sender,data.text,false);

  // ── Countdown fix for mobile: use setTimeout chain instead of relying on rapid messages ──
  if(data.type==='countdown_start'){
    runGuestCountdown(data.from, ()=>{
      // countdown done — room will show on record_start
    });
  }
  if(data.type==='record_start'){
    // Ensure countdown screen is hidden and guest room is visible
    $('countdownScreen').style.display='none';
    $('guestRoom').style.display='block';
    if(!myIsObserver) startGuestRecording();
    $('guestStatusDisplay').textContent='Recording';
  }
  if(data.type==='record_stop'){if(!myIsObserver)stopGuestRecording(conn);}
  if(data.type==='record_pause'){if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.pause();$('guestStatusDisplay').textContent='Paused';}
  if(data.type==='record_resume'){if(mediaRecorder&&mediaRecorder.state==='paused')mediaRecorder.resume();$('guestStatusDisplay').textContent='Recording';}
  if(data.type==='mute_you'){if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=!data.muted);guestSystemMsg(data.muted?'You have been muted by the host.':'You have been unmuted.');}
  if(data.type==='timer_sync'){elapsed=data.elapsed;const el=$('guestRecDuration');if(el)el.textContent=fmt(Math.floor(elapsed));}
}

// Guest countdown — self-contained timer, not dependent on repeated messages
function runGuestCountdown(from, cb){
  $('guestRoom').style.display='none';
  $('countdownScreen').style.display='flex';
  let count=from;
  $('countdownNumber').textContent=count;
  function tick(){
    count--;
    if(count<=0){
      // Don't hide here — wait for record_start message to show room
      // This prevents race condition on slow mobile connections
      $('countdownNumber').textContent='🎙';
      if(cb) cb();
    } else {
      $('countdownNumber').textContent=count;
      setTimeout(tick,1000);
    }
  }
  setTimeout(tick,1000);
}

// ── Host handles guests ──
function handleIncomingConn(conn){
  conn.on('data',data=>{
    if(data.type==='join_request'){
      if(peers[conn.peer]&&!peers[conn.peer].pending)return;
      peers[conn.peer]={conn,name:data.name,pending:true,consented:data.consented,observer:data.observer};
      showWaitingGuest(conn.peer,data.name,data.consented,data.observer);
      getVisitorInfo().then(info=>{
        consentLog.push({name:data.name,role:data.observer?'Observer':'Guest',consented:data.consented,observer:data.observer,timestamp:tsNow(),roomId,...info});
      });
    }
    if(data.type==='chat'){hostAddChat(data.sender,data.text,false);broadcastToGuests({type:'chat',sender:data.sender,text:data.text},conn.peer);}
    if(data.type==='file_meta'){receivedMeta[conn.peer]=data;receivedChunks[conn.peer]=[];addTransferRow(conn.peer,data.name);}
    if(data.type==='file_chunk'){
      if(!receivedChunks[conn.peer])receivedChunks[conn.peer]=[];
      receivedChunks[conn.peer].push(data.chunk);
      const meta=receivedMeta[conn.peer];
      if(meta)updateTransferBar(conn.peer,Math.round((receivedChunks[conn.peer].length/meta.totalChunks)*100));
    }
    if(data.type==='file_done')finaliseGuestTrack(conn.peer);
    if(data.type==='guest_leaving'){
      hostSystemMsg(`${peers[conn.peer]?.name||'A guest'} has left the room.`);
      delete peers[conn.peer];renderParticipants();
    }
  });
  conn.on('close',()=>{
    if(peers[conn.peer]&&!peers[conn.peer].pending){
      hostSystemMsg(`${peers[conn.peer].name} disconnected.`);
      delete peers[conn.peer];renderParticipants();
    } else if(peers[conn.peer]){
      const row=$(`wait-${conn.peer}`);if(row)row.remove();
      if($('waitingList').children.length===0)$('waitingQueue').style.display='none';
      delete peers[conn.peer];
    }
  });
}

function showWaitingGuest(peerId,name,consented,observer){
  $('waitingQueue').style.display='block';
  const badge=observer?'👁 Observer':(consented?'🟢 Consented':'⚠ Not consented');
  const row=document.createElement('div');
  row.className='waiting-row';row.id=`wait-${peerId}`;
  row.innerHTML=`
    <div>
      <span class="waiting-row-name">${name}</span>
      <span style="font-size:12px;color:#aaa;margin-left:8px;">${badge}</span>
    </div>
    <div>
      <button class="btn-admit" onclick="admitGuest('${peerId}')">Admit</button>
      <button class="btn-deny" onclick="denyGuest('${peerId}')">Deny</button>
    </div>`;
  $('waitingList').appendChild(row);
  hostSystemMsg(`${name} is waiting to join (${badge}).`);
}

window.admitGuest=function(peerId){
  const p=peers[peerId];if(!p)return;
  p.pending=false;
  p.conn.send({type:'admitted'});
  getMic().then(s=>{
    setupLocalAnalyser(s,'hostWaveCanvas');
    const call=peer.call(peerId,s);
    call.on('stream',remote=>{addRemoteAudio(peerId,remote);setupRemoteAnalyser(peerId,remote);});
    p.call=call;
  });
  const row=$(`wait-${peerId}`);if(row)row.remove();
  if($('waitingList').children.length===0)$('waitingQueue').style.display='none';
  renderParticipants();
  hostSystemMsg(`${p.name} has joined${p.observer?' as Observer':''}.`);
  if(recording&&!p.observer)p.conn.send({type:'record_start'});
};

window.denyGuest=function(peerId){
  const p=peers[peerId];if(!p)return;
  p.conn.send({type:'denied'});delete peers[peerId];
  const row=$(`wait-${peerId}`);if(row)row.remove();
  if($('waitingList').children.length===0)$('waitingQueue').style.display='none';
};

// ── Kick guest ──
window.kickGuest=function(peerId){
  const p=peers[peerId];if(!p)return;
  if(!confirm(`Remove ${p.name} from the room?`))return;
  p.conn.send({type:'kicked'});
  setTimeout(()=>{
    try{p.conn.close();}catch(e){}
    const audio=$(`audio-${peerId}`);if(audio)audio.remove();
    delete peers[peerId];renderParticipants();
    hostSystemMsg(`${p.name} has been removed from the room.`);
  },500);
};

// ── Thank you screen ──
function showThankyou(msg){
  // Hide all room screens
  ['guestRoom','hostRoom','countdownScreen','waitingScreen'].forEach(id=>{
    const el=$(id);if(el)el.style.display='none';
  });
  // Stop any recording
  if(localStream)localStream.getTracks().forEach(t=>t.stop());
  if(peer){try{peer.destroy();}catch(e){}}
  const screen=$('thankyouScreen');
  $('thankyouMsg').textContent=msg||'Thank you for using Vox5000.';
  screen.style.display='flex';
  let count=5;
  $('thankyouCountdown').textContent=count;
  const iv=setInterval(()=>{
    count--;
    $('thankyouCountdown').textContent=count;
    if(count<=0){clearInterval(iv);window.location.href='index.html';}
  },1000);
}

// ── Audio ──
function addRemoteAudio(peerId,remoteStream){
  let a=$(`audio-${peerId}`);
  if(!a){a=document.createElement('audio');a.id=`audio-${peerId}`;a.autoplay=true;a.setAttribute('playsinline','');$('audioElements').appendChild(a);}
  a.srcObject=remoteStream;
}

function setupLocalAnalyser(s,canvasId){
  if(!audioCtx||audioCtx.state==='closed') audioCtx=new AudioContext({sampleRate:48000});
  if(!analyser){analyser=audioCtx.createAnalyser();analyser.fftSize=1024;}
  try{audioCtx.createMediaStreamSource(s).connect(analyser);}catch(e){}
  drawMeter('local',analyser);
  drawWave(canvasId,analyser);
}

function setupRemoteAnalyser(peerId,remote){
  if(!audioCtx)return;
  const a=audioCtx.createAnalyser();a.fftSize=512;
  try{audioCtx.createMediaStreamSource(remote).connect(a);}catch(e){}
  if(peers[peerId])peers[peerId].analyser=a;
  drawMeter(peerId,a);
}

function drawMeter(id,anal){
  const buf=new Uint8Array(anal.frequencyBinCount);
  function tick(){
    try{anal.getByteTimeDomainData(buf);}catch{return;}
    let max=0;for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>max)max=v;}
    const fill=$(`meter-${id}`);if(fill)fill.style.width=Math.min(100,Math.round(max*200))+'%';
    requestAnimationFrame(tick);
  }tick();
}

function drawWave(canvasId,anal){
  const canvas=$(canvasId);if(!canvas)return;
  const ctx=canvas.getContext('2d');
  let buf2=[];
  function tick(){
    const W=canvas.width=canvas.offsetWidth||600,H=canvas.height,mid=H/2;
    const buf=new Uint8Array(anal.frequencyBinCount);
    if(recording||!isHost){
      try{anal.getByteTimeDomainData(buf);}catch{}
      let peak=0,clip=false;
      for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>peak)peak=v;if(buf[i]>242||buf[i]<13)clip=true;}
      buf2.push({peak,clipping:clip});if(buf2.length>WAVE_HISTORY)buf2.shift();
    }
    ctx.fillStyle='#0e0e0e';ctx.fillRect(0,0,W,H);
    const clipH=H*0.07;
    ctx.fillStyle='rgba(255,68,68,0.1)';ctx.fillRect(0,0,W,clipH);ctx.fillRect(0,H-clipH,W,clipH);
    ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(W,mid);ctx.stroke();
    if(buf2.length===0){ctx.strokeStyle='rgba(232,255,71,0.15)';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(W,mid);ctx.stroke();}
    else{
      const bW=W/WAVE_HISTORY;
      for(let i=0;i<buf2.length;i++){
        const x=i*bW,{peak:p,clipping:c}=buf2[i],h=Math.max(1,p*(mid-clipH)*0.95);
        ctx.fillStyle=c?'#FF4444':`rgb(${Math.round(68+Math.min(1,p*2)*164)},255,${Math.round(136-Math.min(1,p*2)*136)})`;
        ctx.fillRect(x,mid-h,Math.max(1,bW-0.5),h*2);
      }
    }
    requestAnimationFrame(tick);
  }tick();
}

// ── Show rooms ──
function showHostRoom(){
  $('waitingScreen').style.display='none';
  $('hostRoom').style.display='block';
  const rd=getRooms()[roomId]||{};
  $('roomCodeDisplay').textContent=roomId;
  $('roomNameDisplay').textContent=rd.name||'Interview Room';
  document.title=`Vox5000 — ${rd.name||'Interview Room'}`;
  getMic().then(s=>setupLocalAnalyser(s,'hostWaveCanvas'));
  renderParticipants();setupHostControls();
}

function showGuestRoom(){
  $('guestRoom').style.display='block';
  $('guestNameDisplay').textContent=myName;
  $('guestRoomCode').textContent=roomId;
  $('guestStatusDisplay').textContent=myIsObserver?'Observer — mic off, listen only':'Connected — waiting for host to start';
  if(myIsObserver){
    $('observerBanner').style.display='block';
    $('guestConsentBadge').textContent='👁 Observer';
    $('guestConsentBadge').className='badge-observer';
  } else {
    $('guestConsentBadge').textContent='🟢 Consented';
    $('guestConsentBadge').className='badge-consented';
  }
  setupGuestControls();
}

// ── Participants ──
function renderParticipants(){
  const list=$('participantsList');list.innerHTML='';
  list.appendChild(makeParticipantRow(myPeerId,myName,true,true,true,false));
  Object.entries(peers).forEach(([pid,p])=>{
    if(p.pending)return;
    list.appendChild(makeParticipantRow(pid,p.name,false,false,p.consented,p.observer));
  });
  const total=1+Object.values(peers).filter(p=>!p.pending).length;
  $('participantCount').textContent=`${total}/4`;
}

function makeParticipantRow(pid,name,isHostUser,isMe,consented,observer){
  const div=document.createElement('div');
  div.className='participant-row'+(isHostUser?' is-host':'');
  div.id=`prow-${pid}`;
  const p=peers[pid]||{};
  const badge=isHostUser?'<span style="font-size:11px;color:var(--yellow);">🎙 Host</span>'
    :observer?'<span style="font-size:11px;color:#8888ff;">👁 Observer</span>'
    :consented?'<span style="font-size:11px;color:var(--green);">🟢 Consented</span>'
    :'<span style="font-size:11px;color:#FF8844;">⚠ Not consented</span>';
  div.innerHTML=`
    <div class="participant-avatar">${initials(name)}</div>
    <div style="flex:1;min-width:0;">
      <div class="participant-name">${name}${isMe?' (You)':''}</div>
      <div class="participant-role">${badge}</div>
    </div>
    <div class="participant-meter"><div class="participant-meter-fill" id="meter-${pid}"></div></div>
    ${(!isMe&&!isHostUser)?`
      <div style="display:flex;gap:4px;">
        <button class="btn-mute${p.muted?' muted':''}" onclick="toggleMute('${pid}')">${p.muted?'Unmute':'Mute'}</button>
        <button class="btn-mute" onclick="kickGuest('${pid}')" style="color:#FF4444;border-color:rgba(255,68,68,0.3);">Kick</button>
      </div>`:''}
  `;
  return div;
}

window.toggleMute=function(peerId){
  const p=peers[peerId];if(!p)return;
  p.muted=!p.muted;
  p.conn.send({type:'mute_you',muted:p.muted});
  renderParticipants();
};

// ── Host controls ──
function setupHostControls(){
  $('copyLinkBtn').addEventListener('click',()=>{
    navigator.clipboard.writeText(`${location.origin}${location.pathname}?r=${roomId}`).then(()=>{
      $('copyLinkBtn').textContent='✓ Copied!';
      setTimeout(()=>{$('copyLinkBtn').textContent='📋 Copy invite link';},2000);
    });
  });

  $('renameRoomBtn').addEventListener('click',()=>{
    const rooms=getRooms(),current=(rooms[roomId]&&rooms[roomId].name)||'Interview Room';
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
      const r=getRooms();delete r[roomId];saveRooms(r);
      broadcastToGuests({type:'chat',sender:'System',text:'The host has ended this session.'});
      setTimeout(()=>{window.location.href='index.html';},800);
    }
  });

  $('recBtn').addEventListener('click',()=>{recording?stopSession():startSession();});

  $('pauseBtn').addEventListener('click',()=>{
    if(!recording)return;
    if(!paused){
      paused=true;
      if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.pause();
      broadcastToGuests({type:'record_pause'});
      $('pauseBtn').textContent='▶ Resume';$('hostDurStatus').textContent='Paused';$('onAir').classList.remove('visible');
    } else {
      paused=false;startTime=Date.now()-elapsed*1000;
      if(mediaRecorder&&mediaRecorder.state==='paused')mediaRecorder.resume();
      broadcastToGuests({type:'record_resume'});
      $('pauseBtn').textContent='⏸ Pause';$('hostDurStatus').textContent='Recording';$('onAir').classList.add('visible');
    }
  });

  ['m1','m2','m3','m4'].forEach(id=>{
    const labels={m1:'Intro',m2:'Break',m3:'Outro',m4:'Clip'};
    $(id).addEventListener('click',()=>{
      if(!recording||paused)return;
      const t=fmt(Math.floor(elapsed));
      markers.push({label:labels[id],time:t});
      $('markerLog').innerHTML=markers.map(mk=>`<span style="color:#888">${mk.label}</span> @ <span style="color:#E8FF47">${mk.time}</span>`).join(' · ');
    });
  });

  $('hostChatSend').addEventListener('click',()=>hostSendChat());
  $('hostChatInput').addEventListener('keydown',e=>{if(e.key==='Enter')hostSendChat();});
}

// ── Guest controls ──
function setupGuestControls(){
  $('guestLeaveBtn').addEventListener('click',()=>{
    if(!confirm('Leave this room?'))return;
    if(peers['host']&&peers['host'].conn){
      try{peers['host'].conn.send({type:'guest_leaving'});}catch(e){}
    }
    showThankyou('Thank you for using Vox5000. We hope to see you again soon!');
  });
  $('guestChatSend').addEventListener('click',()=>guestSendChat());
  $('guestChatInput').addEventListener('keydown',e=>{if(e.key==='Enter')guestSendChat();});
}

// ── Session ──
function startSession(){
  if(!localStream){$('hostDurStatus').textContent='Mic not ready';return;}
  const countFrom=5;
  // Send a single countdown_start message — guest handles its own timer
  broadcastToGuests({type:'countdown_start',from:countFrom});
  // Host countdown
  $('hostRoom').style.display='none';
  $('countdownScreen').style.display='flex';
  let count=countFrom;
  $('countdownNumber').textContent=count;
  const iv=setInterval(()=>{
    count--;
    if(count<=0){
      clearInterval(iv);
      $('countdownScreen').style.display='none';
      $('hostRoom').style.display='block';
      beginRecording();
      // Tell guests to start recording — this also triggers showing their room
      broadcastToGuests({type:'record_start'});
    } else {$('countdownNumber').textContent=count;}
  },1000);
}

function beginRecording(){
  chunks=[];markers=[];waveBuffer=[];$('markerLog').textContent='';
  recording=true;paused=false;elapsed=0;startTime=Date.now();
  timerInterval=setInterval(tickTimer,500);
  $('recBtn').classList.add('recording');$('recBtn').innerHTML='<span class="rec-dot"></span> Stop Recording';
  $('pauseBtn').disabled=false;$('pauseBtn').textContent='⏸ Pause';
  ['m1','m2','m3','m4'].forEach(id=>$(id).disabled=false);
  $('onAir').classList.add('visible');$('hostDurStatus').textContent='Recording';
  startLocalRecording();hostSystemMsg('Recording started.');
}

function stopSession(){
  recording=false;paused=false;
  clearInterval(timerInterval);
  $('onAir').classList.remove('visible');
  $('recBtn').classList.remove('recording');$('recBtn').innerHTML='<span class="rec-dot"></span> Record';
  $('pauseBtn').disabled=true;$('pauseBtn').textContent='⏸ Pause';
  ['m1','m2','m3','m4'].forEach(id=>$(id).disabled=true);
  $('hostDurStatus').textContent='Finishing…';
  broadcastToGuests({type:'record_stop'});
  hostSystemMsg('Recording stopped. Collecting tracks…');
  stopLocalRecording(async()=>{
    await buildHostDownload();
    generateConsentLog();
    const guests=Object.values(peers).filter(p=>!p.pending&&!p.observer);
    if(guests.length>0){$('transferCard').style.display='block';}
    else{$('hostDurStatus').textContent='Done';$('dlSection').style.display='block';}
  });
}

function tickTimer(){
  if(!paused){elapsed=(Date.now()-startTime)/1000;$('hostDuration').textContent=fmt(elapsed);broadcastToGuests({type:'timer_sync',elapsed});}
}

function startLocalRecording(){
  if(!localStream)return;chunks=[];
  const opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:320000}:{};
  mediaRecorder=new MediaRecorder(localStream,opts);
  mediaRecorder.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
  mediaRecorder.start(1000);
}

function stopLocalRecording(cb){
  if(!mediaRecorder||mediaRecorder.state==='inactive'){if(cb)cb();return;}
  mediaRecorder.onstop=()=>{if(cb)cb();};
  mediaRecorder.stop();
}

// ── Guest recording ──
function startGuestRecording(){
  if(!localStream)return;chunks=[];
  const opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:320000}:{};
  mediaRecorder=new MediaRecorder(localStream,opts);
  mediaRecorder.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
  mediaRecorder.start(1000);
  $('guestRecordingCard').style.display='block';
  $('onAir').classList.add('visible');
}

function stopGuestRecording(hostConn){
  $('onAir').classList.remove('visible');$('guestRecordingCard').style.display='none';
  $('guestStatusDisplay').textContent='Sending track to host…';$('guestUploadCard').style.display='block';
  if(!mediaRecorder||mediaRecorder.state==='inactive'){sendFileToHost(hostConn);return;}
  mediaRecorder.onstop=()=>sendFileToHost(hostConn);
  mediaRecorder.stop();
}

// ── File transfer ──
function sendFileToHost(hostConn){
  const blob=new Blob(chunks,{type:'audio/webm'});
  const CHUNK=65536,totalChunks=Math.ceil(blob.size/CHUNK);
  hostConn.send({type:'file_meta',name:myName,totalChunks,size:blob.size,mimeType:'audio/webm'});
  let offset=0;
  function next(){
    if(offset>=blob.size){
      hostConn.send({type:'file_done',name:myName});
      $('guestUploadCard').style.display='none';$('guestDoneCard').style.display='block';
      $('guestStatusDisplay').textContent='Track sent ✓';return;
    }
    const reader=new FileReader();
    reader.onload=e=>{
      hostConn.send({type:'file_chunk',chunk:e.target.result});
      offset+=CHUNK;
      const pct=Math.min(100,Math.round(offset/blob.size*100));
      $('guestUploadBar').style.width=pct+'%';$('guestUploadPct').textContent=pct+'%';
      setTimeout(next,10);
    };
    reader.readAsArrayBuffer(blob.slice(offset,offset+CHUNK));
  }next();
}

function addTransferRow(peerId,name){
  const row=document.createElement('div');row.className='transfer-item';row.id=`trow-${peerId}`;
  row.innerHTML=`<span class="transfer-name">${name}</span><div class="transfer-bar-wrap"><div class="transfer-bar-fill" id="tbar-${peerId}"></div></div><span class="transfer-pct" id="tpct-${peerId}">0%</span>`;
  $('transferList').appendChild(row);
}
function updateTransferBar(peerId,pct){
  const b=$(`tbar-${peerId}`);if(b)b.style.width=pct+'%';
  const e=$(`tpct-${peerId}`);if(e)e.textContent=pct+'%';
}

async function finaliseGuestTrack(peerId){
  const p=peers[peerId];if(!p)return;
  const b=$(`tbar-${peerId}`);if(b){b.style.width='100%';b.style.background='var(--green)';}
  const e=$(`tpct-${peerId}`);if(e)e.innerHTML='<span class="transfer-done">✓</span>';
  const allChunks=receivedChunks[peerId];if(!allChunks||allChunks.length===0)return;
  const blob=new Blob(allChunks.map(c=>new Uint8Array(c)),{type:'audio/webm'});
  try{
    if(!audioCtx||audioCtx.state==='closed')audioCtx=new AudioContext({sampleRate:48000});
    const decoded=await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const wavBlob=encodeWav(decoded,16);
    const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safe=p.name.replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(`${safe}_${ts}.wav`,`${p.name} · Guest Track · WAV 16-bit · ${(wavBlob.size/1048576).toFixed(1)} MB`,URL.createObjectURL(wavBlob),`${safe}_${ts}.wav`);
    hostSystemMsg(`✓ ${p.name}'s track received.`);
  }catch(err){console.error('Guest WAV error:',err);}
  checkAllDone();
}

async function buildHostDownload(){
  if(!chunks.length)return;
  const blob=new Blob(chunks,{type:'audio/webm'});
  try{
    if(!audioCtx||audioCtx.state==='closed')audioCtx=new AudioContext({sampleRate:48000});
    const decoded=await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const wavBlob=encodeWav(decoded,16);
    const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safe=myName.replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(`${safe}_HOST_${ts}.wav`,`${myName} (Host) · WAV 16-bit · ${(wavBlob.size/1048576).toFixed(1)} MB`,URL.createObjectURL(wavBlob),`${safe}_HOST_${ts}.wav`);
    $('dlSection').style.display='block';
  }catch(e){console.error('Host WAV error:',e);}
}

function checkAllDone(){
  const guests=Object.values(peers).filter(p=>!p.pending&&!p.observer);
  const done=document.querySelectorAll('.transfer-done').length;
  if(done>=guests.length&&guests.length>0){
    $('transferNote').innerHTML='<strong style="color:var(--green)">✓ All tracks received.</strong>';
    $('hostDurStatus').textContent='Done';$('dlSection').style.display='block';
  }
}

// ── Consent log ──
function generateConsentLog(){
  const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const lines=[
    'VOX5000 RECORDING CONSENT LOG','==============================',
    `Room ID: ${roomId}`,`Room Name: ${(getRooms()[roomId]||{}).name||'Interview Room'}`,
    `Session date: ${new Date().toUTCString()}`,`Log generated: ${tsNow()}`,'',
    'IMPORTANT: This log is a record of consent to recording and may be used as legal evidence.','',
    '------------------------------','PARTICIPANT CONSENT RECORDS','------------------------------',''
  ];
  consentLog.forEach((entry,i)=>{
    lines.push(`Participant ${i+1}`);
    lines.push(`  Name:        ${entry.name}`);
    lines.push(`  Role:        ${entry.role}`);
    lines.push(`  Consented:   ${entry.consented?'YES':'NO — joined as observer only'}`);
    lines.push(`  Observer:    ${entry.observer?'Yes':'No'}`);
    lines.push(`  Timestamp:   ${entry.timestamp}`);
    lines.push(`  IP Address:  ${entry.ip||'Unknown'}`);
    lines.push(`  Browser:     ${entry.browser||'Unknown'}`);
    lines.push(`  Platform:    ${entry.platform||'Unknown'}`);
    lines.push(`  Language:    ${entry.language||'Unknown'}`);
    lines.push(`  Screen:      ${entry.screenRes||'Unknown'}`);
    lines.push('');
  });
  lines.push('------------------------------','END OF CONSENT LOG','');
  lines.push('Generated by Vox5000 (vox5000.com). Host is responsible for retaining this record.');
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=$('consentLogBtn');a.href=url;a.download=`Vox5000_Consent_Log_${roomId}_${ts}.txt`;
  $('consentNotice').style.display='block';
  hostSystemMsg('📋 Consent log ready — download it below.');
}

// ── WAV encoder ──
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
  const out=new Uint8Array(44+s16.byteLength);out.set(new Uint8Array(buf),0);out.set(new Uint8Array(s16.buffer),44);
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
  const text=$('hostChatInput').value.trim();if(!text)return;
  $('hostChatInput').value='';hostAddChat(myName,text,true);
  broadcastToGuests({type:'chat',sender:myName,text});
}
function hostAddChat(sender,text,isMe){
  const div=document.createElement('div');div.className='chat-msg';
  div.innerHTML=`<span class="chat-msg-sender ${isMe?'is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
  $('hostChatMessages').appendChild(div);$('hostChatMessages').scrollTop=$('hostChatMessages').scrollHeight;
}
function hostSystemMsg(text){
  const div=document.createElement('div');div.className='chat-system';div.textContent=text;
  $('hostChatMessages').appendChild(div);$('hostChatMessages').scrollTop=$('hostChatMessages').scrollHeight;
}
function guestSendChat(){
  const text=$('guestChatInput').value.trim();if(!text)return;
  $('guestChatInput').value='';guestAddChat(myName,text,true);
  if(peers['host']&&peers['host'].conn){try{peers['host'].conn.send({type:'chat',sender:myName,text});}catch(e){}}
}
function guestAddChat(sender,text,isMe){
  const div=document.createElement('div');div.className='chat-msg';
  div.innerHTML=`<span class="chat-msg-sender ${isMe?'is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
  $('guestChatMessages').appendChild(div);$('guestChatMessages').scrollTop=$('guestChatMessages').scrollHeight;
}
function guestSystemMsg(text){
  const div=document.createElement('div');div.className='chat-system';div.textContent=text;
  $('guestChatMessages').appendChild(div);$('guestChatMessages').scrollTop=$('guestChatMessages').scrollHeight;
}
function broadcastToGuests(data,excludePeer){
  Object.entries(peers).forEach(([pid,p])=>{
    if(pid!==excludePeer&&p.conn&&!p.pending){try{p.conn.send(data);}catch(e){}}
  });
}

// ── Init ──
setupNav();

// Check if host is returning to their own room
if(isHost&&roomId&&checkHostReturn()){
  // Skip all screens, go straight in
  $('headphoneScreen').style.display='none';
  showLoadingThenHostRoom();
} else {
  // Normal flow — headphone screen first
}
