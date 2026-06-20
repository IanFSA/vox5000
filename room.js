'use strict';

const $ = id => document.getElementById(id);
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);return[h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');}
function randId(len=6){return crypto.getRandomValues(new Uint8Array(Math.ceil(len*3/4))).reduce((a,b)=>a+b.toString(36),'').substr(0,len).toUpperCase();}
function initials(name){return name.split(' ').map(w=>w[0]||'').join('').substr(0,2).toUpperCase();}
function tsNow(){return new Date().toISOString();}
function dbToGain(db){return db<=-59?0:Math.pow(10,db/20);}
function fmtDb(db){return db<=-59?'Off':(db>=0?'+':'')+parseFloat(db).toFixed(1)+' dB';}

// ── State ──
const params=new URLSearchParams(window.location.search);
let roomId=params.get('r');
const isHost=!roomId;
let myName='',myPeerId='',myConsented=false,myIsObserver=false;
let recording=false,paused=false,elapsed=0,startTime,timerInterval;
let markers=[];
let mediaRecorder,chunks=[],rawChunks=[];
let audioCtx,localStream;
let gainNode,monitorGainNode; // host audio nodes
let guestGainNode,guestMonitorGainNode,guestAnalyser; // guest audio nodes
let hostAnalyser; // separate analyser for host waveform/meter
const WAVE_HISTORY=600;
const peers={};
const receivedChunks={},receivedMeta={};
const remoteGainNodes={};
let peer;
const consentLog=[];
let hostReturning=false;
let guestBackupBlob=null;

// ── Storage ──
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

// ── Before unload ──
window.addEventListener('beforeunload',e=>{
  const transferring=Object.values(peers).some(p=>p.transferring);
  if(recording||transferring){
    e.preventDefault();
    e.returnValue='Recording or transfer is in progress. Audio may be lost.';
    return e.returnValue;
  }
});

// ── Nav ──
function setupNav(){
  ['logoHomeLink','navHome'].forEach(id=>{
    const el=$(id);if(!el)return;
    el.addEventListener('click',e=>{
      e.preventDefault();
      if(recording){if(!confirm('Recording is active. Leaving will stop it and disconnect guests. Are you sure?'))return;stopSession();}
      else if(isHost&&Object.values(peers).some(p=>!p.pending)){if(!confirm('Guests are connected. Leaving will disconnect them. Are you sure?'))return;}
      window.location.href='index.html';
    });
  });
}

// ── Host return ──
function checkHostReturn(){
  if(!isHost||!roomId)return false;
  const s=getHostSession();
  if(s&&s.roomId===roomId&&s.name){myName=s.name;myConsented=true;myIsObserver=false;hostReturning=true;return true;}
  return false;
}

// ── Room name (host only) ──
if(isHost)$('roomNameSection').style.display='block';

// ── Headphone screens ──
$('hasHeadphones').addEventListener('click',()=>{$('headphoneScreen').style.display='none';$('nameScreen').style.display='flex';});
$('noHeadphones').addEventListener('click',()=>{$('headphoneScreen').style.display='none';$('feedbackWarnScreen').style.display='flex';});
$('nowHasHeadphones').addEventListener('click',()=>{$('feedbackWarnScreen').style.display='none';$('nameScreen').style.display='flex';});
$('continueAnyway').addEventListener('click',()=>{$('feedbackWarnScreen').style.display='none';$('nameScreen').style.display='flex';});

// ── Name entry ──
$('enterRoomBtn').addEventListener('click',enterRoom);
$('participantName').addEventListener('keydown',e=>{if(e.key==='Enter')enterRoom();});

async function enterRoom(){
  const name=$('participantName').value.trim();
  if(!name){
    $('nameError').textContent='Please enter your name to continue.';
    $('nameError').style.display='block';
    return;
  }
  $('nameError').style.display='none';
  myName=name;

  if(isHost){
    myConsented=true;myIsObserver=false;
    $('nameScreen').style.display='none';
    roomId=randId(6);
    const customName=$('roomNameInput').value.trim();
    const roomName=customName||'Interview Room';
    saveRoom(roomId,{name:roomName,created:Date.now()});
    saveHostSession({roomId,name:myName});
    window.history.replaceState({},'',`?r=${roomId}`);
    const info=await getVisitorInfo();
    consentLog.push({name:myName,role:'Host',consented:true,observer:false,timestamp:tsNow(),...info,roomId});
    showLoadingThenHostRoom();
  } else {
    // Guest — go to mic selector, then consent
    $('nameScreen').style.display='none';
    showGuestMicSelect();
  }
}

// ── Guest mic selector ──
async function showGuestMicSelect(){
  const screen=$('guestMicScreen');
  if(!screen){
    // No mic screen in HTML — go straight to consent
    $('consentScreen').style.display='flex';
    return;
  }
  screen.style.display='flex';
  try{
    const tmp=await navigator.mediaDevices.getUserMedia({audio:true});
    tmp.getTracks().forEach(t=>t.stop());
    const devices=await navigator.mediaDevices.enumerateDevices();
    const mics=devices.filter(d=>d.kind==='audioinput');
    const sel=$('guestMicSelect');
    if(sel){
      sel.innerHTML='';
      mics.forEach((d,i)=>{
        const opt=document.createElement('option');
        opt.value=d.deviceId;
        opt.textContent=d.label||`Microphone ${i+1}`;
        sel.appendChild(opt);
      });
    }
  }catch(e){console.warn('Mic enum error',e);}
}

window.proceedToConsent=function(){
  const screen=$('guestMicScreen');
  if(screen)screen.style.display='none';
  $('consentScreen').style.display='flex';
};

// ── Consent ──
window.chooseConsent=function(consented){
  myConsented=consented;myIsObserver=!consented;
  const btnY=$('consentBtnYes'),btnN=$('consentBtnNo');
  if(btnY&&btnN){
    btnY.style.borderColor=consented?'var(--green)':'rgba(0,229,107,0.2)';
    btnY.style.background=consented?'rgba(0,229,107,0.15)':'rgba(0,229,107,0.08)';
    btnN.style.borderColor=!consented?'#9999ff':'rgba(120,120,255,0.15)';
    btnN.style.background=!consented?'rgba(120,120,255,0.12)':'rgba(120,120,255,0.06)';
  }
  setTimeout(async()=>{
    $('consentScreen').style.display='none';
    const info=await getVisitorInfo();
    consentLog.push({name:myName,role:myIsObserver?'Observer':'Guest',consented:myConsented,observer:myIsObserver,timestamp:tsNow(),...info,roomId});
    $('waitingScreen').style.display='flex';
    $('waitingTitle').textContent='Waiting to be admitted';
    $('waitingSub').textContent='The host will let you in shortly. Keep this page open.';
    $('waitingNameDisplay').textContent=`Joining as: ${myName}${myIsObserver?' (Observer)':''}`;
    initPeer(`GUEST-${roomId}-${randId(4)}`);
  },400);
};

function showLoadingThenHostRoom(){
  $('waitingScreen').style.display='flex';
  $('waitingTitle').textContent='Setting up your room…';
  $('waitingSub').textContent='Just a moment.';
  $('waitingNameDisplay').textContent='';
  initPeer(`HOST-${roomId}`);
}

// ── PeerJS ──
function initPeer(id){
  myPeerId=id;
  peer=new Peer(id,{debug:0,config:{iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
  ]}});
  peer.on('open',()=>{if(isHost)showHostRoom();else connectToHost();});
  peer.on('connection',conn=>handleIncomingConn(conn));
  peer.on('call',call=>{
    getMic().then(s=>{
      // Answer — if observer send empty stream, else send mic
      call.answer(myIsObserver?new MediaStream():s);
      call.on('stream',remote=>{
        addRemoteAudio(call.peer,remote);
        // Only set up analyser if remote stream has tracks
        if(remote&&remote.getAudioTracks().length>0){
          setupRemoteAnalyser(call.peer,remote);
        }
      });
    });
  });
  peer.on('error',err=>{
    console.error('Peer error:',err.type,err);
    if(!isHost&&err.type==='peer-unavailable')guestSystemMsg('Could not connect to host. Check the link and try again.');
  });
}

// ── Get mic ──
function getMic(){
  if(localStream&&localStream.active)return Promise.resolve(localStream);
  const guestMicSel=$('guestMicSelect');
  const deviceId=guestMicSel?guestMicSel.value:undefined;
  return navigator.mediaDevices.getUserMedia({
    audio:{
      deviceId:deviceId?{exact:deviceId}:undefined,
      echoCancellation:false,
      noiseSuppression:false,
      autoGainControl:false,
      sampleRate:{ideal:48000}
    }
  }).then(s=>{localStream=s;return s;});
}

// ── Guest → Host connection ──
function connectToHost(){
  const conn=peer.connect(`HOST-${roomId}`,{reliable:true});
  conn.on('open',()=>{
    conn.send({type:'join_request',name:myName,peerId:myPeerId,consented:myConsented,observer:myIsObserver});
    peers['host']={conn,name:'Host',transferring:false};
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
      // Set up audio graph BEFORE calling
      setupGuestAudioGraph(s);
      // Call host with mic stream (or empty if observer)
      const callStream=myIsObserver?new MediaStream():s;
      const call=peer.call(`HOST-${roomId}`,callStream);
      call.on('stream',remote=>{
        // Host audio comes back — play it directly via audio element
        addRemoteAudio('host',remote);
      });
    });
    guestSystemMsg(`You're in the room${myIsObserver?' as an Observer':''}.`);
  }
  if(data.type==='denied'){
    $('waitingScreen').style.display='none';$('nameScreen').style.display='flex';
    $('nameError').textContent='The host did not admit you.';$('nameError').style.display='block';
  }
  if(data.type==='kicked')showThankyou('You have been removed from this session by the host.');
  if(data.type==='chat')guestAddChat(data.sender,data.text,false);
  if(data.type==='countdown_start')runGuestCountdown(data.from);
  if(data.type==='record_start'){
    $('countdownScreen').style.display='none';
    $('guestRoom').style.display='block';
    if(!myIsObserver)startGuestRecording();
    $('guestStatusDisplay').textContent='🔴 Recording';
  }
  if(data.type==='record_stop'){if(!myIsObserver)stopGuestRecording(conn);}
  if(data.type==='record_pause'){
    if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.pause();
    $('guestStatusDisplay').textContent='⏸ Paused';
  }
  if(data.type==='record_resume'){
    if(mediaRecorder&&mediaRecorder.state==='paused')mediaRecorder.resume();
    $('guestStatusDisplay').textContent='🔴 Recording';
  }
  if(data.type==='mute_you'){
    if(localStream)localStream.getAudioTracks().forEach(t=>{t.enabled=!data.muted;});
    guestSystemMsg(data.muted?'You have been muted by the host.':'You have been unmuted by the host.');
    updateGuestMuteUI(data.muted);
  }
  if(data.type==='timer_sync'){
    elapsed=data.elapsed;
    const el=$('guestRecDuration');if(el)el.textContent=fmt(Math.floor(elapsed));
  }
  if(data.type==='transfer_confirmed'){
    $('guestUploadCard').style.display='none';
    $('guestDoneCard').style.display='block';
    $('guestStatusDisplay').textContent='✓ Track received by host';
    if(peers['host'])peers['host'].transferring=false;
  }
  if(data.type==='transfer_failed'){
    $('guestUploadCard').style.display='none';
    showGuestTransferFailed();
  }
}

function updateGuestMuteUI(muted){
  const btn=$('guestSelfMuteBtn');
  if(btn){btn.textContent=muted?'🔇 Unmute mic':'🎙 Mute mic';btn.dataset.muted=muted?'1':'';}
}

// ── Guest countdown ──
function runGuestCountdown(from){
  $('guestRoom').style.display='none';
  $('countdownScreen').style.display='flex';
  let count=from;
  $('countdownNumber').textContent=count;
  function tick(){
    count--;
    if(count<=0){$('countdownNumber').textContent='🎙';}
    else{$('countdownNumber').textContent=count;setTimeout(tick,1000);}
  }
  setTimeout(tick,1000);
}

// ── Host handles incoming connections ──
function handleIncomingConn(conn){
  conn.on('data',data=>{
    if(data.type==='join_request'){
      if(peers[conn.peer]&&!peers[conn.peer].pending)return;
      peers[conn.peer]={conn,name:data.name,pending:true,consented:data.consented,observer:data.observer,muted:false,transferring:false};
      showWaitingGuest(conn.peer,data.name,data.consented,data.observer);
      getVisitorInfo().then(info=>{
        consentLog.push({name:data.name,role:data.observer?'Observer':'Guest',consented:data.consented,observer:data.observer,timestamp:tsNow(),roomId,...info});
      });
    }
    if(data.type==='chat'){hostAddChat(data.sender,data.text,false);broadcastToGuests({type:'chat',sender:data.sender,text:data.text},conn.peer);}
    if(data.type==='file_meta'){
      receivedMeta[conn.peer]=data;
      receivedChunks[conn.peer]=[];
      if(peers[conn.peer])peers[conn.peer].transferring=true;
      addTransferRow(conn.peer,data.name,data.size);
    }
    if(data.type==='file_chunk'){
      if(!receivedChunks[conn.peer])receivedChunks[conn.peer]=[];
      receivedChunks[conn.peer].push(data.chunk);
      const meta=receivedMeta[conn.peer];
      if(meta){
        const pct=Math.min(99,Math.round((receivedChunks[conn.peer].length/meta.totalChunks)*100));
        updateTransferBar(conn.peer,pct);
      }
    }
    if(data.type==='file_done')finaliseGuestTrack(conn.peer,conn);
    if(data.type==='guest_leaving'){
      hostSystemMsg(`${peers[conn.peer]?.name||'A guest'} has left.`);
      delete peers[conn.peer];renderParticipants();
    }
  });
  conn.on('close',()=>{
    const p=peers[conn.peer];
    if(p&&!p.pending){
      if(p.transferring){
        const tpct=$(`tpct-${conn.peer}`);
        if(tpct)tpct.innerHTML='<span style="color:var(--red)">✗ Failed</span>';
        hostSystemMsg(`⚠ ${p.name} disconnected during transfer. Ask them to send their backup track.`);
      } else {
        hostSystemMsg(`${p.name} disconnected.`);
      }
    } else if(p){
      const row=$(`wait-${conn.peer}`);if(row)row.remove();
      if($('waitingList').children.length===0)$('waitingQueue').style.display='none';
    }
    delete peers[conn.peer];renderParticipants();
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
      <span style="font-size:11px;color:var(--text3);margin-left:8px;">${badge}</span>
    </div>
    <div>
      <button class="btn-admit" onclick="admitGuest('${peerId}')">Admit</button>
      <button class="btn-deny" onclick="denyGuest('${peerId}')">Deny</button>
    </div>`;
  $('waitingList').appendChild(row);
  hostSystemMsg(`⚡ ${name} is waiting to join.`);
  showGuestWaitingAlert(peerId,name);
}

// ── Guest waiting alert ──
function showGuestWaitingAlert(peerId,name){
  const alert=$('guestAlert');
  if(!alert)return;
  $('guestAlertName').textContent=`${name} wants to join`;
  alert.style.display='block';
  $('guestAlertAdmit').onclick=()=>{alert.style.display='none';admitGuest(peerId);};
  $('guestAlertDismiss').onclick=()=>{alert.style.display='none';};
  // Browser notification
  if(Notification&&Notification.permission==='granted'){
    new Notification('Vox5000',{body:`${name} is waiting to join your room`,icon:'favicon-512.png'});
  } else if(Notification&&Notification.permission!=='denied'){
    Notification.requestPermission().then(p=>{
      if(p==='granted')new Notification('Vox5000',{body:`${name} is waiting to join`,icon:'favicon-512.png'});
    });
  }
  // Tab title badge
  document.title=`⚡ ${name} waiting — Vox5000`;
  setTimeout(()=>{document.title=`Vox5000 — ${(getRooms()[roomId]||{}).name||'Interview Room'}`;},8000);
}

window.admitGuest=function(peerId){
  const p=peers[peerId];if(!p)return;
  p.pending=false;
  p.conn.send({type:'admitted'});
  getMic().then(s=>{
    // Set up host audio graph if not done
    if(!hostAnalyser)setupHostAudioGraph(s);
    // Call guest with host mic
    const call=peer.call(peerId,s);
    call.on('stream',remote=>{
      addRemoteAudio(peerId,remote);
      if(remote&&remote.getAudioTracks().length>0)setupRemoteAnalyser(peerId,remote);
    });
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
  p.conn.send({type:'denied'});
  const row=$(`wait-${peerId}`);if(row)row.remove();
  if($('waitingList').children.length===0)$('waitingQueue').style.display='none';
  delete peers[peerId];
};

window.kickGuest=function(peerId){
  const p=peers[peerId];if(!p)return;
  if(!confirm(`Remove ${p.name} from the room?`))return;
  p.conn.send({type:'kicked'});
  setTimeout(()=>{
    try{p.conn.close();}catch(e){}
    const audio=$(`audio-${peerId}`);if(audio)audio.remove();
    delete peers[peerId];renderParticipants();
    hostSystemMsg(`${p.name} has been removed.`);
  },500);
};

// ── Thank you ──
function showThankyou(msg){
  ['guestRoom','hostRoom','countdownScreen','waitingScreen','consentScreen','guestMicScreen'].forEach(id=>{
    const el=$(id);if(el)el.style.display='none';
  });
  if(localStream)localStream.getTracks().forEach(t=>t.stop());
  if(peer){try{peer.destroy();}catch(e){}}
  $('thankyouMsg').textContent=msg||'Thank you for using Vox5000.';
  $('thankyouScreen').style.display='flex';
  let count=5;$('thankyouCountdown').textContent=count;
  const iv=setInterval(()=>{count--;$('thankyouCountdown').textContent=count;if(count<=0){clearInterval(iv);window.location.href='index.html';}},1000);
}

// ── AUDIO GRAPH ──
// HOST: mic → gainNode → hostAnalyser → [NOT to speakers — avoid flanging]
// The host hears guests via WebRTC audio elements only
// Monitor is a separate optional path: gainNode → monitorGain → speakers
function setupHostAudioGraph(s){
  if(!audioCtx||audioCtx.state==='closed')audioCtx=new AudioContext({sampleRate:48000});
  localStream=s;
  const src=audioCtx.createMediaStreamSource(s);
  gainNode=audioCtx.createGain();gainNode.gain.value=1; // 0dB default
  hostAnalyser=audioCtx.createAnalyser();hostAnalyser.fftSize=1024;
  monitorGainNode=audioCtx.createGain();monitorGainNode.gain.value=0; // monitor OFF by default
  src.connect(gainNode);
  gainNode.connect(hostAnalyser);
  // Monitor path — optional headphone monitoring
  gainNode.connect(monitorGainNode);
  monitorGainNode.connect(audioCtx.destination);
  // Start meter and waveform
  drawMeter('local',hostAnalyser);
  drawWave('hostWaveCanvas',hostAnalyser);
}

// GUEST: mic → gainNode → guestAnalyser → [stream goes to WebRTC]
// Monitor is separate: guestAnalyser → monitorGain → speakers (OFF by default)
// This ensures the guest's mic goes OUT via WebRTC cleanly without double-routing
function setupGuestAudioGraph(s){
  if(!audioCtx||audioCtx.state==='closed')audioCtx=new AudioContext({sampleRate:48000});
  localStream=s;
  const src=audioCtx.createMediaStreamSource(s);
  guestGainNode=audioCtx.createGain();guestGainNode.gain.value=1;
  guestAnalyser=audioCtx.createAnalyser();guestAnalyser.fftSize=1024;
  guestMonitorGainNode=audioCtx.createGain();guestMonitorGainNode.gain.value=0; // OFF by default
  src.connect(guestGainNode);
  guestGainNode.connect(guestAnalyser);
  // Monitor only — does NOT connect guestAnalyser to destination to avoid feedback
  guestGainNode.connect(guestMonitorGainNode);
  guestMonitorGainNode.connect(audioCtx.destination);
  // Meter and waveform
  drawGuestMeter(guestAnalyser);
  drawWave('guestWaveCanvas',guestAnalyser);
}

// Remote audio — straight to audio element (WebRTC handles it)
function addRemoteAudio(peerId,remoteStream){
  let a=$(`audio-${peerId}`);
  if(!a){
    a=document.createElement('audio');
    a.id=`audio-${peerId}`;
    a.autoplay=true;
    a.setAttribute('playsinline','');
    $('audioElements').appendChild(a);
  }
  a.srcObject=remoteStream;
}

// Remote analyser for level metering of guests (host side)
function setupRemoteAnalyser(peerId,remote){
  if(!audioCtx)return;
  try{
    const gain=audioCtx.createGain();gain.gain.value=1;
    remoteGainNodes[peerId]=gain;
    const anal=audioCtx.createAnalyser();anal.fftSize=512;
    const src=audioCtx.createMediaStreamSource(remote);
    src.connect(gain);
    gain.connect(anal);
    // Note: do NOT connect to audioCtx.destination here
    // Audio is already playing through the <audio> element
    // Connecting to destination too would cause double playback
    if(peers[peerId])peers[peerId].analyser=anal;
    drawMeter(peerId,anal);
    monitorPeerClipping(peerId,anal);
  }catch(e){console.warn('Remote analyser error:',e);}
}

window.setGuestVolume=function(peerId,val){
  // Control volume of the audio element directly
  const audio=$(`audio-${peerId}`);
  if(audio)audio.volume=Math.max(0,Math.min(2,parseFloat(val)));
  const label=$(`vol-label-${peerId}`);
  if(label)label.textContent=Math.round(parseFloat(val)*100)+'%';
};

// ── Meters ──
function drawMeter(id,anal){
  const buf=new Uint8Array(anal.frequencyBinCount);
  function tick(){
    try{anal.getByteTimeDomainData(buf);}catch{return;}
    let max=0;
    for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>max)max=v;}
    const fill=$(`meter-${id}`);
    if(fill)fill.style.width=Math.min(100,Math.round(max*200))+'%';
    requestAnimationFrame(tick);
  }tick();
}

function drawGuestMeter(anal){
  const buf=new Uint8Array(anal.frequencyBinCount);
  function tick(){
    try{anal.getByteTimeDomainData(buf);}catch{return;}
    let max=0;
    for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>max)max=v;}
    const fill=$('guestMeterBar');
    if(fill)fill.style.setProperty('--level',Math.min(100,Math.round(max*200))+'%');
    requestAnimationFrame(tick);
  }tick();
}

// ── Waveform ──
function drawWave(canvasId,anal){
  const canvas=$(canvasId);if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const buf2=[];
  function tick(){
    const W=canvas.offsetWidth||600;
    if(canvas.width!==W)canvas.width=W;
    const H=canvas.height,mid=H/2;
    const buf=new Uint8Array(anal.frequencyBinCount);
    // Only accumulate waveform data while recording/active
    if(recording||!isHost){
      try{anal.getByteTimeDomainData(buf);}catch{}
      let peak=0,clip=false;
      for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128;if(v>peak)peak=v;if(buf[i]>242||buf[i]<13)clip=true;}
      buf2.push({peak,clipping:clip});
      if(buf2.length>WAVE_HISTORY)buf2.shift();
    }
    ctx.fillStyle='#0a0a0a';ctx.fillRect(0,0,W,H);
    const clipH=H*0.06;
    ctx.fillStyle='rgba(255,59,59,0.07)';ctx.fillRect(0,0,W,clipH);ctx.fillRect(0,H-clipH,W,clipH);
    ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(W,mid);ctx.stroke();
    if(buf2.length>0){
      const bW=W/WAVE_HISTORY;
      for(let i=0;i<buf2.length;i++){
        const x=i*bW,{peak:p,clipping:c}=buf2[i];
        const h=Math.max(1,p*(mid-clipH)*0.95);
        ctx.fillStyle=c?'#FF3B3B':`rgba(223,255,0,${0.3+p*0.7})`;
        ctx.fillRect(x,mid-h,Math.max(1,bW-0.5),h*2);
      }
    } else {
      ctx.strokeStyle='rgba(223,255,0,0.08)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(W,mid);ctx.stroke();
    }
    requestAnimationFrame(tick);
  }tick();
}

function monitorPeerClipping(peerId,anal){
  const buf=new Uint8Array(anal.frequencyBinCount);
  let clipTimeout;
  function tick(){
    try{anal.getByteTimeDomainData(buf);}catch{return;}
    let clipping=false;
    for(let i=0;i<buf.length;i++){if(buf[i]>242||buf[i]<13){clipping=true;break;}}
    const warn=$(`clip-warn-${peerId}`);
    if(warn&&clipping){
      warn.style.display='block';
      clearTimeout(clipTimeout);
      clipTimeout=setTimeout(()=>{warn.style.display='none';},2000);
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
  getMic().then(s=>setupHostAudioGraph(s));
  renderParticipants();
  setupHostControls();
  setupHostLevelSliders();
}

function showGuestRoom(){
  $('guestRoom').style.display='block';
  $('guestNameDisplay').textContent=myName;
  $('guestRoomCode').textContent=roomId;
  $('guestStatusDisplay').textContent=myIsObserver?'Observer — listening only':'Connected — waiting for host to start';
  if(myIsObserver){
    $('observerBanner').style.display='block';
    $('guestConsentBadge').textContent='👁 Observer';
    $('guestConsentBadge').className='badge-observer';
  } else {
    $('guestConsentBadge').textContent='🟢 Consented';
    $('guestConsentBadge').className='badge-consented';
    $('guestLevelCard').style.display='block';
    setupGuestLevelSliders();
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
  $('participantCount').textContent=`${total}/6`;
}

function makeParticipantRow(pid,name,isHostUser,isMe,consented,observer){
  const div=document.createElement('div');
  div.className='participant-row'+(isHostUser?' is-host':'');
  div.id=`prow-${pid}`;
  const p=peers[pid]||{};

  const badge=isHostUser
    ?'<span class="chip chip-ready">🎙 Host</span>'
    :observer?'<span class="chip chip-observer">👁 Observer</span>'
    :consented?'<span class="chip chip-consented">🟢 Consented</span>'
    :'<span style="font-size:11px;color:#FF8844;">⚠ Not consented</span>';

  // Volume slider — controls audio element volume (0-150%)
  const volControls=(!isMe&&!isHostUser&&!observer)?`
    <div class="participant-vol">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-align:center;">Hear vol</div>
      <input type="range" min="0" max="1.5" step="0.05" value="1"
        class="vol-slider"
        oninput="setGuestVolume('${pid}',this.value)"
        aria-label="Volume for ${name}" />
      <span class="vol-label" id="vol-label-${pid}">100%</span>
      <div id="clip-warn-${pid}" style="display:none;font-size:10px;color:var(--red);margin-top:3px;text-align:center;">⚠ Clipping</div>
    </div>`:'';

  const actionBtns=(!isMe&&!isHostUser)?`
    <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
      <button class="btn-mute${p.muted?' muted':''}" onclick="toggleMute('${pid}')" id="mute-${pid}">${p.muted?'Unmute':'Mute'}</button>
      <button class="btn-mute" onclick="kickGuest('${pid}')" style="color:var(--red);border-color:rgba(255,59,59,0.3);">Kick</button>
    </div>`:'';

  div.innerHTML=`
    <div class="participant-avatar">${initials(name)}</div>
    <div style="flex:1;min-width:0;">
      <div class="participant-name">${name}${isMe?' (You)':''}</div>
      <div style="margin-top:3px;">${badge}</div>
      <div class="participant-meter" style="margin-top:6px;"><div class="participant-meter-fill" id="meter-${pid}"></div></div>
    </div>
    ${volControls}
    ${actionBtns}`;
  return div;
}

window.toggleMute=function(peerId){
  const p=peers[peerId];if(!p)return;
  p.muted=!p.muted;
  p.conn.send({type:'mute_you',muted:p.muted});
  // Update button immediately
  const btn=$(`mute-${peerId}`);
  if(btn){btn.textContent=p.muted?'Unmute':'Mute';btn.classList.toggle('muted',p.muted);}
};

// ── Level sliders ──
function setupHostLevelSliders(){
  const inputSl=$('hostInputSlider'),monSl=$('hostMonitorSlider');
  const inputV=$('hostInputVal'),monV=$('hostMonitorVal');
  if(inputSl){
    inputSl.addEventListener('input',()=>{
      const db=parseFloat(inputSl.value);
      if(inputV)inputV.textContent=fmtDb(db);
      if(gainNode)gainNode.gain.value=dbToGain(db);
    });
  }
  if(monSl){
    monSl.value='-60'; // ensure monitor starts at OFF
    monSl.addEventListener('input',()=>{
      const db=parseFloat(monSl.value);
      if(monV)monV.textContent=fmtDb(db);
      if(monitorGainNode)monitorGainNode.gain.value=dbToGain(db);
    });
  }
}

function setupGuestLevelSliders(){
  const inputSl=$('guestInputSlider'),monSl=$('guestMonitorSlider');
  const inputV=$('guestInputVal'),monV=$('guestMonitorVal');
  if(inputSl){
    inputSl.addEventListener('input',()=>{
      const db=parseFloat(inputSl.value);
      if(inputV)inputV.textContent=fmtDb(db);
      if(guestGainNode)guestGainNode.gain.value=dbToGain(db);
    });
  }
  if(monSl){
    monSl.value='-60'; // monitor OFF by default
    monSl.addEventListener('input',()=>{
      const db=parseFloat(monSl.value);
      if(monV)monV.textContent=fmtDb(db);
      if(guestMonitorGainNode)guestMonitorGainNode.gain.value=dbToGain(db);
    });
  }
}

// ── Host controls ──
function setupHostControls(){
  $('copyLinkBtn').addEventListener('click',()=>{
    const url=`${location.origin}/room.html?r=${roomId}`;
    openSharePanel(url);
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
      $('pauseBtn').textContent='▶ Resume';$('hostDurStatus').textContent='Paused';
      $('onAir').classList.remove('visible');
    } else {
      paused=false;startTime=Date.now()-elapsed*1000;
      if(mediaRecorder&&mediaRecorder.state==='paused')mediaRecorder.resume();
      broadcastToGuests({type:'record_resume'});
      $('pauseBtn').textContent='⏸ Pause';$('hostDurStatus').textContent='Recording';
      $('onAir').classList.add('visible');
    }
  });
  ['m1','m2','m3','m4'].forEach(id=>{
    const labels={m1:'Intro',m2:'Break',m3:'Outro',m4:'Clip'};
    $(id).addEventListener('click',()=>{
      if(!recording||paused)return;
      const t=fmt(Math.floor(elapsed));
      markers.push({label:labels[id],time:t});
      $('markerLog').innerHTML=markers.map(mk=>`<span style="color:var(--text3)">${mk.label}</span>@<span style="color:var(--yellow)">${mk.time}</span>`).join(' · ');
    });
  });
  $('hostChatSend').addEventListener('click',()=>hostSendChat());
  $('hostChatInput').addEventListener('keydown',e=>{if(e.key==='Enter')hostSendChat();});
}

// ── Share panel ──
function openSharePanel(url){
  const panel=$('sharePanel');
  $('shareLinkDisplay').textContent=url;
  panel.style.display='flex';
  const msg=`You've been invited to join a Vox5000 interview room.\n\nOpen this link in Google Chrome:\n${url}`;
  $('shareWhatsApp').onclick=()=>window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`,'_blank');
  $('shareTelegram').onclick=()=>window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("You've been invited to a Vox5000 interview room.")}`,'_blank');
  $('shareEmail').onclick=()=>window.open(`mailto:?subject=Vox5000 Interview Invite&body=${encodeURIComponent(msg)}`);
  $('shareSMS').onclick=()=>window.open(`sms:?body=${encodeURIComponent(msg)}`);
  if(navigator.share){
    $('shareNative').style.display='flex';
    $('shareNative').onclick=()=>navigator.share({title:'Vox5000 Interview Room',text:msg,url}).catch(()=>{});
  }
  $('shareCopyLink').onclick=()=>{
    navigator.clipboard.writeText(url).then(()=>{
      $('copyLinkText').textContent='✓ Copied!';
      setTimeout(()=>{$('copyLinkText').textContent='Copy link';},2000);
    });
  };
  $('closePanelBtn').onclick=()=>{panel.style.display='none';};
  panel.addEventListener('click',e=>{if(e.target===panel)panel.style.display='none';});
}

// ── Guest controls ──
function setupGuestControls(){
  $('guestLeaveBtn').addEventListener('click',()=>{
    if(!confirm('Leave this room?'))return;
    if(peers['host']&&peers['host'].conn){try{peers['host'].conn.send({type:'guest_leaving'});}catch(e){}}
    showThankyou('Thank you for using Vox5000.');
  });
  $('guestChatSend').addEventListener('click',()=>guestSendChat());
  $('guestChatInput').addEventListener('keydown',e=>{if(e.key==='Enter')guestSendChat();});

  // Self-mute button for guest
  const selfMuteBtn=$('guestSelfMuteBtn');
  if(selfMuteBtn){
    selfMuteBtn.addEventListener('click',()=>{
      if(!localStream)return;
      const tracks=localStream.getAudioTracks();
      const currentlyMuted=tracks.length>0&&!tracks[0].enabled;
      tracks.forEach(t=>{t.enabled=currentlyMuted;});
      updateGuestMuteUI(!currentlyMuted);
    });
  }

  // Fallback download
  const fallbackBtn=$('guestFallbackBtn');
  if(fallbackBtn){
    fallbackBtn.addEventListener('click',()=>{
      if(guestBackupBlob){
        const url=URL.createObjectURL(guestBackupBlob);
        const a=document.createElement('a');
        const safe=myName.replace(/[^a-zA-Z0-9]/g,'_');
        const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
        a.href=url;a.download=`${safe}_backup_${ts}.mp3`;a.click();
        URL.revokeObjectURL(url);
      }
    });
  }
}

// ── Session ──
function startSession(){
  if(!localStream){$('hostDurStatus').textContent='Mic not ready — allow mic access first';return;}
  const countFrom=5;
  broadcastToGuests({type:'countdown_start',from:countFrom});
  $('hostRoom').style.display='none';
  $('countdownScreen').style.display='flex';
  let count=countFrom;$('countdownNumber').textContent=count;
  const iv=setInterval(()=>{
    count--;
    if(count<=0){
      clearInterval(iv);
      $('countdownScreen').style.display='none';
      $('hostRoom').style.display='block';
      beginRecording();
      broadcastToGuests({type:'record_start'});
    } else {$('countdownNumber').textContent=count;}
  },1000);
}

function beginRecording(){
  chunks=[];rawChunks=[];markers=[];
  $('markerLog').textContent='';
  recording=true;paused=false;elapsed=0;startTime=Date.now();
  timerInterval=setInterval(tickTimer,500);
  // 60 min warning
  setTimeout(()=>{if(recording){const w=$('sixtyMinWarning');if(w)w.style.display='flex';}},60*60*1000);
  $('recBtn').classList.add('recording');
  $('recBtn').innerHTML='<span class="rec-dot"></span> Stop Recording';
  $('pauseBtn').disabled=false;$('pauseBtn').textContent='⏸ Pause';
  ['m1','m2','m3','m4'].forEach(id=>$(id).disabled=false);
  $('onAir').classList.add('visible');$('hostDurStatus').textContent='Recording';
  startLocalRecording();
  hostSystemMsg('Recording started.');
}

function stopSession(){
  recording=false;paused=false;
  clearInterval(timerInterval);
  $('onAir').classList.remove('visible');
  $('recBtn').classList.remove('recording');
  $('recBtn').innerHTML='<span class="rec-dot"></span> Record';
  $('pauseBtn').disabled=true;$('pauseBtn').textContent='⏸ Pause';
  ['m1','m2','m3','m4'].forEach(id=>$(id).disabled=true);
  $('hostDurStatus').textContent='Finishing…';
  broadcastToGuests({type:'record_stop'});
  hostSystemMsg('Recording stopped. Collecting tracks…');
  stopLocalRecording(async()=>{
    await buildHostDownload();
    generateConsentLog();
    const guests=Object.values(peers).filter(p=>!p.pending&&!p.observer);
    if(guests.length>0){
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

function startLocalRecording(){
  if(!localStream)return;
  chunks=[];rawChunks=[];
  const opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ?{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:256000}:{};
  mediaRecorder=new MediaRecorder(localStream,opts);
  mediaRecorder.ondataavailable=e=>{if(e.data&&e.data.size>0){chunks.push(e.data);rawChunks.push(e.data);}};
  mediaRecorder.start(1000);
}

function stopLocalRecording(cb){
  if(!mediaRecorder||mediaRecorder.state==='inactive'){if(cb)cb();return;}
  mediaRecorder.onstop=()=>{if(cb)cb();};
  mediaRecorder.stop();
}

// ── Guest recording ──
function startGuestRecording(){
  if(!localStream)return;
  chunks=[];rawChunks=[];
  const opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ?{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:256000}:{};
  mediaRecorder=new MediaRecorder(localStream,opts);
  mediaRecorder.ondataavailable=e=>{if(e.data&&e.data.size>0){chunks.push(e.data);rawChunks.push(e.data);}};
  mediaRecorder.start(1000);
  $('guestTimerCard').style.display='block';
  $('onAir').classList.add('visible');
}

function stopGuestRecording(hostConn){
  $('onAir').classList.remove('visible');
  $('guestTimerCard').style.display='none';
  $('guestStatusDisplay').textContent='Preparing your track…';
  if(!mediaRecorder||mediaRecorder.state==='inactive'){
    encodeAndSend(hostConn);return;
  }
  mediaRecorder.onstop=()=>encodeAndSend(hostConn);
  mediaRecorder.stop();
}

// ── Encode to MP3 then send ──
async function encodeAndSend(hostConn){
  $('guestUploadCard').style.display='block';
  $('guestUploadPct').textContent='Encoding to MP3…';
  $('guestUploadBar').style.width='0%';

  if(!rawChunks||rawChunks.length===0){
    showGuestTransferFailed('No audio was recorded. Make sure your microphone was working.');
    return;
  }

  const rawBlob=new Blob(rawChunks,{type:'audio/webm'});

  try{
    if(!audioCtx||audioCtx.state==='closed')audioCtx=new AudioContext({sampleRate:48000});
    const arrayBuffer=await rawBlob.arrayBuffer();
    const decoded=await audioCtx.decodeAudioData(arrayBuffer);
    const mp3Blob=await encodeMp3(decoded,256);

    if(!mp3Blob||mp3Blob.size===0){
      throw new Error('MP3 encoding produced empty file');
    }

    guestBackupBlob=mp3Blob;
    // Show fallback button now we have the file
    const fallbackBtn=$('guestFallbackBtn');
    if(fallbackBtn)fallbackBtn.style.display='block';

    $('guestUploadPct').textContent='Sending…';
    sendFileToHost(hostConn,mp3Blob,'audio/mp3');

  }catch(err){
    console.error('Encode error:',err);
    // Fall back to raw webm
    if(rawBlob.size>0){
      guestBackupBlob=rawBlob;
      const fallbackBtn=$('guestFallbackBtn');
      if(fallbackBtn)fallbackBtn.style.display='block';
      $('guestUploadPct').textContent='Sending raw audio…';
      sendFileToHost(hostConn,rawBlob,'audio/webm');
    } else {
      showGuestTransferFailed('Could not encode your audio. Please download your backup track.');
    }
  }
}

// ── MP3 encoder ──
async function encodeMp3(audioBuffer,kbps){
  return new Promise((resolve,reject)=>{
    function doEncode(){
      try{
        const samples=audioBuffer.getChannelData(0);
        const sr=audioBuffer.sampleRate;
        const mp3enc=new lamejs.Mp3Encoder(1,sr,kbps);
        const blockSize=1152,mp3Data=[];
        const int16=new Int16Array(samples.length);
        for(let i=0;i<samples.length;i++){
          const s=Math.max(-1,Math.min(1,samples[i]));
          int16[i]=s<0?Math.round(s*0x8000):Math.round(s*0x7FFF);
        }
        for(let i=0;i<int16.length;i+=blockSize){
          const chunk=int16.subarray(i,i+blockSize);
          const enc=mp3enc.encodeBuffer(chunk);
          if(enc.length>0)mp3Data.push(new Uint8Array(enc));
        }
        const flushed=mp3enc.flush();
        if(flushed.length>0)mp3Data.push(new Uint8Array(flushed));
        if(mp3Data.length===0){reject(new Error('No MP3 data produced'));return;}
        resolve(new Blob(mp3Data,{type:'audio/mp3'}));
      }catch(e){reject(e);}
    }
    if(window.lamejs){doEncode();return;}
    const script=document.createElement('script');
    script.src='https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
    script.onload=doEncode;
    script.onerror=()=>reject(new Error('Failed to load MP3 encoder'));
    document.head.appendChild(script);
  });
}

// ── File transfer with backpressure ──
function sendFileToHost(hostConn,blob,mimeType){
  const CHUNK=8192;
  const BUFFER_HIGH=32768;
  const BUFFER_LOW=8192;
  const totalChunks=Math.ceil(blob.size/CHUNK);

  if(peers['host'])peers['host'].transferring=true;
  hostConn.send({type:'file_meta',name:myName,totalChunks,size:blob.size,mimeType});

  let offset=0,sending=false,waitingBuf=false;

  const dc=hostConn.dataChannel||hostConn._dc;
  if(dc){
    dc.bufferedAmountLowThreshold=BUFFER_LOW;
    dc.addEventListener('bufferedamountlow',()=>{if(waitingBuf){waitingBuf=false;schedule();}});
  }

  function schedule(){setTimeout(next,8);}

  function next(){
    if(sending)return;
    if(offset>=blob.size){
      // Wait for buffer to drain then send file_done
      function waitDrain(){
        if(dc&&dc.bufferedAmount>0){setTimeout(waitDrain,50);return;}
        hostConn.send({type:'file_done',name:myName});
        $('guestStatusDisplay').textContent='Sent — waiting for confirmation…';
      }
      setTimeout(waitDrain,150);
      return;
    }
    if(dc&&dc.bufferedAmount>BUFFER_HIGH){waitingBuf=true;return;}
    sending=true;
    const slice=blob.slice(offset,offset+CHUNK);
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        hostConn.send({type:'file_chunk',chunk:e.target.result});
        offset+=CHUNK;
        const pct=Math.min(99,Math.round(offset/blob.size*100));
        const bar=$('guestUploadBar');const pctEl=$('guestUploadPct');
        if(bar)bar.style.width=pct+'%';
        if(pctEl)pctEl.textContent=pct+'%';
      }catch(err){sending=false;showGuestTransferFailed();return;}
      sending=false;schedule();
    };
    reader.onerror=()=>{sending=false;showGuestTransferFailed();};
    reader.readAsArrayBuffer(slice);
  }
  schedule();
}

function showGuestTransferFailed(msg){
  const c=$('guestUploadCard');if(c)c.style.display='none';
  $('guestStatusDisplay').textContent='Transfer failed';
  const card=document.createElement('div');
  card.className='card';
  card.style.cssText='margin-bottom:14px;border-color:rgba(255,59,59,0.3);background:var(--red-dim);';
  card.innerHTML=`
    <div style="font-size:14px;font-weight:700;color:var(--red);margin-bottom:8px;">⚠ Transfer failed</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">${msg||'Your track could not be sent to the host.'} Download your backup and send it via WeTransfer, Google Drive or email.</p>
    <button class="btn btn-record btn-sm" id="guestFallbackBtnFailed">↓ Download my backup track</button>`;
  const done=$('guestDoneCard');if(done)done.before(card);
  const btn=document.getElementById('guestFallbackBtnFailed');
  if(btn&&guestBackupBlob){
    btn.addEventListener('click',()=>{
      const url=URL.createObjectURL(guestBackupBlob);
      const a=document.createElement('a');
      const safe=myName.replace(/[^a-zA-Z0-9]/g,'_');
      const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
      a.href=url;a.download=`${safe}_backup_${ts}.mp3`;a.click();
      URL.revokeObjectURL(url);
    });
  }
}

// ── Transfer received ──
function addTransferRow(peerId,name,size){
  const sizeMb=size?(size/1048576).toFixed(1)+' MB':'';
  const row=document.createElement('div');row.className='transfer-item';row.id=`trow-${peerId}`;
  row.innerHTML=`
    <span class="transfer-name">${name}${sizeMb?' <span style="font-size:10px;color:var(--text3)">('+sizeMb+')</span>':''}</span>
    <div class="transfer-bar-wrap"><div class="transfer-bar-fill" id="tbar-${peerId}"></div></div>
    <span class="transfer-pct" id="tpct-${peerId}">0%</span>`;
  $('transferList').appendChild(row);
}

function updateTransferBar(peerId,pct){
  const b=$(`tbar-${peerId}`);if(b)b.style.width=pct+'%';
  const e=$(`tpct-${peerId}`);if(e)e.textContent=pct+'%';
}

async function finaliseGuestTrack(peerId,conn){
  const p=peers[peerId];if(!p)return;
  if(peers[peerId])peers[peerId].transferring=false;

  const allChunks=receivedChunks[peerId];
  if(!allChunks||allChunks.length===0){
    conn.send({type:'transfer_failed'});
    hostSystemMsg(`⚠ ${p.name}'s track arrived empty. Ask them to send their backup.`);
    return;
  }

  const meta=receivedMeta[peerId]||{};
  const mimeType=meta.mimeType||'audio/webm';
  const blob=new Blob(allChunks.map(c=>new Uint8Array(c)),{type:mimeType});

  // Update UI to 100%
  const b=$(`tbar-${peerId}`);if(b){b.style.width='100%';b.style.background='var(--green)';}
  const e=$(`tpct-${peerId}`);if(e)e.innerHTML='<span class="transfer-done">✓</span>';

  // Confirm to guest — NOW they see Done
  conn.send({type:'transfer_confirmed'});

  const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const safe=(p.name||'Guest').replace(/[^a-zA-Z0-9]/g,'_');
  const ext=mimeType.includes('mp3')||mimeType.includes('mpeg')?'mp3':'webm';
  const sizeMb=(blob.size/1048576).toFixed(1);

  addDownload(
    `${safe}_${ts}.${ext}`,
    `${p.name} · ${ext.toUpperCase()} · ${sizeMb} MB`,
    URL.createObjectURL(blob),
    `${safe}_${ts}.${ext}`
  );
  hostSystemMsg(`✓ ${p.name}'s track received (${sizeMb} MB).`);
  $('dlSection').style.display='block';
  checkAllDone();
}

async function buildHostDownload(){
  if(!rawChunks||rawChunks.length===0)return;
  const blob=new Blob(rawChunks,{type:'audio/webm'});
  try{
    if(!audioCtx||audioCtx.state==='closed')audioCtx=new AudioContext({sampleRate:48000});
    const decoded=await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const mp3Blob=await encodeMp3(decoded,256);
    const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safe=(myName||'Host').replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(
      `${safe}_HOST_${ts}.mp3`,
      `${myName} (Host) · MP3 256kbps · ${(mp3Blob.size/1048576).toFixed(1)} MB`,
      URL.createObjectURL(mp3Blob),
      `${safe}_HOST_${ts}.mp3`
    );
    $('dlSection').style.display='block';
  }catch(e){
    console.error('Host encode error:',e);
    const url=URL.createObjectURL(blob);
    const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const safe=(myName||'Host').replace(/[^a-zA-Z0-9]/g,'_');
    addDownload(`${safe}_HOST_${ts}.webm`,`${myName} (Host) · WebM`,url,`${safe}_HOST_${ts}.webm`);
    $('dlSection').style.display='block';
  }
}

function checkAllDone(){
  const guests=Object.values(peers).filter(p=>!p.pending&&!p.observer);
  const done=document.querySelectorAll('.transfer-done').length;
  if(done>=guests.length&&guests.length>0){
    $('transferNote').innerHTML='<strong style="color:var(--green)">✓ All tracks received.</strong>';
    $('hostDurStatus').textContent='Done';
  }
}

// ── Consent log ──
function generateConsentLog(){
  const ts=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const lines=[
    'VOX5000 RECORDING CONSENT LOG','==============================',
    `Room ID: ${roomId}`,
    `Room Name: ${(getRooms()[roomId]||{}).name||'Interview Room'}`,
    `Session date: ${new Date().toUTCString()}`,
    `Log generated: ${tsNow()}`,'',
    'This log documents participant consent for recording purposes.','',
    'PARTICIPANTS','------------',''
  ];
  consentLog.forEach((entry,i)=>{
    lines.push(`Participant ${i+1}: ${entry.name}`);
    lines.push(`  Role:      ${entry.role}`);
    lines.push(`  Consented: ${entry.consented?'YES':'NO (Observer only)'}`);
    lines.push(`  Timestamp: ${entry.timestamp}`);
    lines.push(`  IP:        ${entry.ip||'Unknown'}`);
    lines.push(`  Browser:   ${(entry.browser||'').substr(0,80)}`);
    lines.push('');
  });
  lines.push('Generated by Vox5000 (vox5000.com)');
  lines.push('Host is responsible for retaining this record.');
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=$('consentLogBtn');
  a.href=url;a.download=`Vox5000_Consent_${roomId}_${ts}.txt`;
  $('consentNotice').style.display='block';
  hostSystemMsg('📋 Consent log ready.');
}

// ── Downloads ──
function addDownload(name,meta,url,filename){
  $('dlSection').style.display='block';
  const item=document.createElement('div');item.className='dl-item';
  item.innerHTML=`
    <div class="dl-info">
      <div class="dl-name">${name}</div>
      <div class="dl-meta">${meta}</div>
    </div>
    <a class="dl-btn" href="${url}" download="${filename}">↓ Download</a>`;
  $('dlGrid').appendChild(item);
}

// ── Chat ──
function hostSendChat(){
  const text=$('hostChatInput').value.trim();if(!text)return;
  $('hostChatInput').value='';
  hostAddChat(myName,text,true);
  broadcastToGuests({type:'chat',sender:myName,text});
}
function hostAddChat(sender,text,isMe){
  const div=document.createElement('div');div.className='chat-msg';
  div.innerHTML=`<span class="chat-msg-sender${isMe?' is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
  $('hostChatMessages').appendChild(div);$('hostChatMessages').scrollTop=$('hostChatMessages').scrollHeight;
}
function hostSystemMsg(text){
  const div=document.createElement('div');div.className='chat-system';div.textContent=text;
  $('hostChatMessages').appendChild(div);$('hostChatMessages').scrollTop=$('hostChatMessages').scrollHeight;
}
function guestSendChat(){
  const text=$('guestChatInput').value.trim();if(!text)return;
  $('guestChatInput').value='';
  guestAddChat(myName,text,true);
  if(peers['host']&&peers['host'].conn){try{peers['host'].conn.send({type:'chat',sender:myName,text});}catch(e){}}
}
function guestAddChat(sender,text,isMe){
  const div=document.createElement('div');div.className='chat-msg';
  div.innerHTML=`<span class="chat-msg-sender${isMe?' is-me':''}">${sender}</span><span class="chat-msg-text">${text}</span>`;
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

// ── WAV encoder (for host format options later) ──
function encodeWav(audioBuffer,bits){
  const ch=audioBuffer.getChannelData(0),n=ch.length,sr=audioBuffer.sampleRate;
  const bps=bits/8,byteRate=sr*bps,dataSize=n*bps;
  const buf=new ArrayBuffer(44);const v=new DataView(buf);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+dataSize,true);str(8,'WAVE');str(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,sr,true);v.setUint32(28,byteRate,true);
  v.setUint16(32,bps,true);v.setUint16(34,bits,true);
  str(36,'data');v.setUint32(40,dataSize,true);
  const s16=new Int16Array(n);
  for(let i=0;i<n;i++){const s=Math.max(-1,Math.min(1,ch[i]));s16[i]=s<0?Math.round(s*0x8000):Math.round(s*0x7FFF);}
  const out=new Uint8Array(44+s16.byteLength);out.set(new Uint8Array(buf),0);out.set(new Uint8Array(s16.buffer),44);
  return new Blob([out],{type:'audio/wav'});
}

// ── Init ──
setupNav();

if(isHost&&roomId&&checkHostReturn()){
  $('headphoneScreen').style.display='none';
  showLoadingThenHostRoom();
}
