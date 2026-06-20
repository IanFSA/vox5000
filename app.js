'use strict';

// ── Browser detection ──
(function(){
  const isSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext);
  if (!isSupported) {
    const el = document.getElementById('unsupportedBrowser');
    if (el) el.style.display = 'block';
  }
})();

const $ = id => document.getElementById(id);

const micSelect     = $('micSelect');
const meterBar      = $('meterBar');
const testBtn       = $('testBtn');
const recBtn        = $('recBtn');
const pauseBtn      = $('pauseBtn');
const onAir         = $('onAir');
const duration      = $('duration');
const durStatus     = $('durStatus');
const markerLog     = $('markerLog');
const sizeDisplay   = $('sizeDisplay');
const dlSection     = $('dlSection');
const dlGrid        = $('dlGrid');
const waveCanvas    = $('waveCanvas');
const permNotice    = $('permNotice');
const clipWarn      = $('clipWarn');
const formatSelect  = $('formatSelect');
const qualitySelect = $('qualitySelect');
const m1=$('m1'), m2=$('m2'), m3=$('m3'), m4=$('m4');

// Solo mode toggle — init mics when user opens recorder
let micsInitialised = false;
const soloRecorderEl = document.getElementById('soloRecorder');
if (soloRecorderEl) {
  const observer = new MutationObserver(() => {
    if (soloRecorderEl.style.display !== 'none' && !micsInitialised) {
      micsInitialised = true;
      initMics();
    }
  });
  observer.observe(soloRecorderEl, { attributes: true, attributeFilter: ['style'] });
}

let audioCtx, analyser, stream;
let gainNode, monitorGainNode, monitorDest;
let mediaRecorder, chunks = [];
let recording = false, paused = false, testing = false;
let startTime, elapsed = 0, timerInterval;
let markers = [];
let clipTimeout;

const wCtx = waveCanvas ? waveCanvas.getContext('2d') : null;
let waveBuffer = [];
const WAVE_HISTORY = 900;

// ── Quality presets ──
const WAV_QUALITIES = {
  'wav-48-24': { sr: 48000, bits: 24, label: '48 kHz / 24-bit (Broadcast master)' },
  'wav-48-16': { sr: 48000, bits: 16, label: '48 kHz / 16-bit (Broadcast standard)' },
  'wav-44-16': { sr: 44100, bits: 16, label: '44.1 kHz / 16-bit (CD quality)' },
  'wav-22-16': { sr: 22050, bits: 16, label: '22 kHz / 16-bit (Voice / web)' },
};
const MP3_QUALITIES = {
  'mp3-320': { kbps: 320, label: 'MP3 320 kbps (High quality)' },
  'mp3-256': { kbps: 256, label: 'MP3 256 kbps (Standard)' },
  'mp3-192': { kbps: 192, label: 'MP3 192 kbps (Compressed)' },
  'mp3-128': { kbps: 128, label: 'MP3 128 kbps (Small file)' },
};

function populateQualities() {
  if (!qualitySelect) return;
  qualitySelect.innerHTML = '';
  const map = formatSelect && formatSelect.value === 'wav' ? WAV_QUALITIES : MP3_QUALITIES;
  Object.entries(map).forEach(([key, val]) => {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = val.label;
    qualitySelect.appendChild(opt);
  });
}
if (formatSelect) formatSelect.addEventListener('change', populateQualities);
populateQualities();

function fmt(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
}

function dbToGain(db) { return db <= -59 ? 0 : Math.pow(10, db / 20); }

// ── Level sliders ──
const inputGainSlider  = $('inputGainSlider');
const inputGainVal     = $('inputGainVal');
const monitorSlider    = $('monitorSlider');
const monitorVal       = $('monitorVal');

function formatDb(db) {
  if (db <= -59) return 'Off';
  if (db === 0) return '0 dB';
  return (db > 0 ? '+' : '') + parseFloat(db).toFixed(1) + ' dB';
}

if (inputGainSlider) {
  inputGainSlider.addEventListener('input', () => {
    const db = parseFloat(inputGainSlider.value);
    if (inputGainVal) inputGainVal.textContent = formatDb(db);
    if (gainNode) gainNode.gain.value = dbToGain(db);
  });
  inputGainSlider.addEventListener('dblclick', () => {
    inputGainSlider.value = 0;
    if (inputGainVal) inputGainVal.textContent = '0 dB';
    if (gainNode) gainNode.gain.value = 1;
  });
}

if (monitorSlider) {
  monitorSlider.addEventListener('input', () => {
    const db = parseFloat(monitorSlider.value);
    if (monitorVal) monitorVal.textContent = formatDb(db);
    if (monitorGainNode) monitorGainNode.gain.value = dbToGain(db);
  });
  monitorSlider.addEventListener('dblclick', () => {
    monitorSlider.value = -60;
    if (monitorVal) monitorVal.textContent = 'Off';
    if (monitorGainNode) monitorGainNode.gain.value = 0;
  });
}

// ── Mic init ──
async function initMics() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    if (permNotice) permNotice.style.display = 'none';
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    if (mics.length === 0) {
      const err = $('micNotFoundError'); if (err) err.style.display = 'block'; return;
    }
    if (micSelect) {
      micSelect.innerHTML = '';
      mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        micSelect.appendChild(opt);
      });
    }
    await startStream(micSelect ? micSelect.value : undefined);
  } catch(e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      const err = $('micDeniedError'); if (err) err.style.display = 'block';
      if (permNotice) permNotice.style.display = 'none';
    } else {
      const err = $('micNotFoundError'); if (err) err.style.display = 'block';
    }
    if (durStatus) durStatus.textContent = 'Microphone not available';
  }
}

async function startStream(deviceId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: { ideal: 48000 },
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext({ sampleRate: 48000 });
    } else if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    const src = audioCtx.createMediaStreamSource(stream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = dbToGain(inputGainSlider ? parseFloat(inputGainSlider.value) : 0);
    monitorGainNode = audioCtx.createGain();
    const monDb = monitorSlider ? parseFloat(monitorSlider.value) : -60;
    monitorGainNode.gain.value = dbToGain(monDb);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    monitorDest = audioCtx.createMediaStreamDestination();
    src.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(monitorDest);
    analyser.connect(monitorGainNode);
    monitorGainNode.connect(audioCtx.destination);
    drawMeter();
    drawWave();
  } catch(e) { console.error('Stream error:', e); }
}

micSelect.addEventListener('change', () => startStream(micSelect.value));

// ── Meter ──
function drawMeter() {
  const buf = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > max) max = v;
    }
    const pct = Math.min(100, Math.round(max * 200));
    meterBar.style.setProperty('--level', pct + '%');
    if (pct > 95 && recording) {
      clipWarn.style.display = 'flex';
      clearTimeout(clipTimeout);
      clipTimeout = setTimeout(() => { clipWarn.style.display = 'none'; }, 2000);
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Waveform — scrolls ONLY when recording or testing ──
function drawWave() {
  const buf = new Uint8Array(analyser ? analyser.frequencyBinCount : 512);

  function tick() {
    const W = waveCanvas.width = waveCanvas.offsetWidth || 640;
    const H = waveCanvas.height;
    const mid = H / 2;
    const active = recording || testing;

    if (analyser) analyser.getByteTimeDomainData(buf);

    if (active) {
      // Get peak for this frame
      let peak = 0, isClipping = false;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128) / 128;
        if (v > peak) peak = v;
        if (buf[i] > 242 || buf[i] < 13) isClipping = true;
      }
      waveBuffer.push({ peak, clipping: isClipping });
      if (waveBuffer.length > WAVE_HISTORY) waveBuffer.shift();
    }

    // Draw background
    wCtx.fillStyle = '#0e0e0e';
    wCtx.fillRect(0, 0, W, H);

    // Clip zones
    const clipH = H * 0.07;
    wCtx.fillStyle = 'rgba(255,68,68,0.1)';
    wCtx.fillRect(0, 0, W, clipH);
    wCtx.fillRect(0, H - clipH, W, clipH);

    // Centre line
    wCtx.strokeStyle = 'rgba(255,255,255,0.05)';
    wCtx.lineWidth = 1;
    wCtx.beginPath();
    wCtx.moveTo(0, mid); wCtx.lineTo(W, mid);
    wCtx.stroke();

    if (waveBuffer.length === 0) {
      // Idle — flat line
      wCtx.strokeStyle = 'rgba(232,255,71,0.15)';
      wCtx.lineWidth = 1.5;
      wCtx.beginPath();
      wCtx.moveTo(0, mid); wCtx.lineTo(W, mid);
      wCtx.stroke();
    } else {
      // Draw scrolling bars
      const barW = W / WAVE_HISTORY;
      for (let i = 0; i < waveBuffer.length; i++) {
        const x = i * barW;
        const { peak: p, clipping: clip } = waveBuffer[i];
        const h = Math.max(1, p * (mid - clipH) * 0.95);
        if (clip) {
          wCtx.fillStyle = '#FF4444';
        } else {
          const intensity = Math.min(1, p * 2);
          const r = Math.round(68 + intensity * (232 - 68));
          const g = 255;
          const b = Math.round(136 - intensity * 136);
          wCtx.fillStyle = `rgb(${r},${g},${b})`;
        }
        wCtx.fillRect(x, mid - h, Math.max(1, barW - 0.5), h * 2);
      }

      // Playhead
      const headX = waveBuffer.length * (W / WAVE_HISTORY);
      wCtx.strokeStyle = 'rgba(255,255,255,0.15)';
      wCtx.lineWidth = 1;
      wCtx.beginPath();
      wCtx.moveTo(headX, 0); wCtx.lineTo(headX, H);
      wCtx.stroke();
    }

    requestAnimationFrame(tick);
  }
  tick();
}

// ── 5s mic test ──
let testChunks = [], testRecorder;
testBtn.addEventListener('click', async () => {
  if (!stream) return;
  testBtn.disabled = true;
  testChunks = [];
  testing = true;
  waveBuffer = [];
  const src = monitorDest ? monitorDest.stream : stream;
  testRecorder = new MediaRecorder(src);
  testRecorder.ondataavailable = e => testChunks.push(e.data);
  testRecorder.onstop = () => {
    testing = false;
    const blob = new Blob(testChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
    testBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,2 11,7 3,12" fill="currentColor"/></svg> 5s mic test';
    testBtn.disabled = false;
  };
  testRecorder.start();
  let count = 5;
  testBtn.textContent = `Recording… ${count}s`;
  const iv = setInterval(() => {
    count--;
    testBtn.textContent = count > 0 ? `Recording… ${count}s` : 'Playing back…';
    if (count <= 0) { clearInterval(iv); testRecorder.stop(); }
  }, 1000);
});

// ── Record / Stop ──
recBtn.addEventListener('click', async () => {
  if (!stream) { await initMics(); return; }
  recording ? stopRecording() : startRecording();
});

function startRecording() {
  chunks = []; markers = [];
  markerLog.textContent = ''; sizeDisplay.textContent = '';
  dlSection.classList.remove('visible');
  dlGrid.innerHTML = '';
  waveBuffer = [];

  const src = monitorDest ? monitorDest.stream : stream;
  const opts = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 320000 }
    : { audioBitsPerSecond: 256000 };

  mediaRecorder = new MediaRecorder(src, opts);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = finalise;
  mediaRecorder.start(1000);

  recording = true; paused = false; elapsed = 0;
  startTime = Date.now();
  timerInterval = setInterval(tick, 500);
  recBtn.classList.add('recording');
  recBtn.innerHTML = '<span class="rec-dot"></span> Stop';
  pauseBtn.disabled = false;
  [m1,m2,m3,m4].forEach(b => b.disabled = false);
  onAir.classList.add('visible');
  durStatus.textContent = 'Recording';
}

function stopRecording() {
  mediaRecorder.stop();
  recording = false; paused = false;
  clearInterval(timerInterval);
  onAir.classList.remove('visible');
  recBtn.classList.remove('recording');
  recBtn.innerHTML = '<span class="rec-dot"></span> Record';
  pauseBtn.disabled = true;
  pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="3.5" height="10" rx="1" fill="currentColor"/><rect x="8.5" y="2" width="3.5" height="10" rx="1" fill="currentColor"/></svg> Pause';
  [m1,m2,m3,m4].forEach(b => b.disabled = true);
  durStatus.textContent = 'Processing…';
  sizeDisplay.textContent = '';
}

function tick() {
  if (!paused) {
    elapsed = (Date.now() - startTime) / 1000;
    duration.textContent = fmt(elapsed);
    const mb = (chunks.reduce((a,c)=>a+c.size,0)/1048576).toFixed(1);
    sizeDisplay.textContent = mb + ' MB captured';
  }
}

pauseBtn.addEventListener('click', () => {
  if (!recording) return;
  if (!paused) {
    mediaRecorder.pause(); paused = true;
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,2 11,7 3,12" fill="currentColor"/></svg> Resume';
    durStatus.textContent = 'Paused';
    onAir.classList.remove('visible');
  } else {
    mediaRecorder.resume(); paused = false;
    startTime = Date.now() - elapsed * 1000;
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="3.5" height="10" rx="1" fill="currentColor"/><rect x="8.5" y="2" width="3.5" height="10" rx="1" fill="currentColor"/></svg> Pause';
    durStatus.textContent = 'Recording';
    onAir.classList.add('visible');
  }
});

const markerLabels = { m1:'Intro', m2:'Break', m3:'Outro', m4:'Clip' };
[m1,m2,m3,m4].forEach(btn => {
  btn.addEventListener('click', () => {
    if (!recording || paused) return;
    const t = fmt(Math.floor(elapsed));
    markers.push({ label: markerLabels[btn.id], time: t });
    markerLog.innerHTML = markers.map(mk =>
      `<span style="color:#888">${mk.label}</span> @ <span style="color:#E8FF47">${mk.time}</span>`
    ).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  });
});

// ── WAV encoder ──
function writeWavHeader(numSamples, sr, numCh, bitDepth) {
  const bps = bitDepth/8, blockAlign = numCh*bps, byteRate = sr*blockAlign, dataSize = numSamples*bps*numCh;
  const buf = new ArrayBuffer(44); const v = new DataView(buf);
  const str = (o,s) => { for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
  str(0,'RIFF'); v.setUint32(4,36+dataSize,true); str(8,'WAVE'); str(12,'fmt '); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,numCh,true); v.setUint32(24,sr,true); v.setUint32(28,byteRate,true);
  v.setUint16(32,blockAlign,true); v.setUint16(34,bitDepth,true); str(36,'data'); v.setUint32(40,dataSize,true);
  return buf;
}

function encodeWav(audioBuffer, bits) {
  const ch = audioBuffer.getChannelData(0), numSamples = ch.length, sr = audioBuffer.sampleRate;
  const header = writeWavHeader(numSamples, sr, 1, bits);
  if (bits === 24) {
    const out = new Uint8Array(44 + numSamples * 3);
    out.set(new Uint8Array(header), 0);
    for (let i = 0; i < numSamples; i++) {
      let val = Math.round(Math.max(-1, Math.min(1, ch[i])) * 8388607);
      if (val < 0) val += 16777216;
      out[44+i*3]=val&0xFF; out[44+i*3+1]=(val>>8)&0xFF; out[44+i*3+2]=(val>>16)&0xFF;
    }
    return new Blob([out], { type: 'audio/wav' });
  }
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const wavBuf = new Uint8Array(44 + samples.byteLength);
  wavBuf.set(new Uint8Array(header), 0);
  wavBuf.set(new Uint8Array(samples.buffer), 44);
  return new Blob([wavBuf], { type: 'audio/wav' });
}

async function encodeMp3(audioBuffer, kbps) {
  durStatus.textContent = 'Encoding MP3…';
  return new Promise((resolve, reject) => {
    function doEncode() {
      try {
        const samples = audioBuffer.getChannelData(0), sr = audioBuffer.sampleRate;
        const mp3enc = new lamejs.Mp3Encoder(1, sr, kbps);
        const blockSize = 1152, mp3Data = [];
        const int16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        for (let i = 0; i < int16.length; i += blockSize) {
          const enc = mp3enc.encodeBuffer(int16.subarray(i, i+blockSize));
          if (enc.length > 0) mp3Data.push(new Int8Array(enc));
        }
        const flushed = mp3enc.flush();
        if (flushed.length > 0) mp3Data.push(new Int8Array(flushed));
        resolve(new Blob(mp3Data, { type: 'audio/mp3' }));
      } catch(e) { reject(e); }
    }
    if (window.lamejs) { doEncode(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
    script.onload = doEncode; script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function finalise() {
  const webmBlob = new Blob(chunks, { type: 'audio/webm' });
  const fmtVal = formatSelect.value, quality = qualitySelect.value;
  const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const dur = fmt(Math.floor(elapsed));
  dlGrid.innerHTML = '';
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(await webmBlob.arrayBuffer());
  } catch(e) { durStatus.textContent = 'Encoding failed — try again'; return; }

  if (fmtVal === 'mp3') {
    try {
      const kbps = MP3_QUALITIES[quality].kbps;
      const mp3Blob = await encodeMp3(audioBuffer, kbps);
      const url = URL.createObjectURL(mp3Blob);
      addDownload(`Vox5000_${ts}.mp3`, `MP3 · ${kbps} kbps · ${dur} · ${(mp3Blob.size/1048576).toFixed(1)} MB`, url, `Vox5000_${ts}.mp3`);
    } catch(e) { durStatus.textContent = 'MP3 encoding failed'; return; }
  } else {
    const bits = WAV_QUALITIES[quality].bits;
    const wavBlob = encodeWav(audioBuffer, bits);
    const url = URL.createObjectURL(wavBlob);
    addDownload(`Vox5000_${ts}.wav`, `WAV · ${bits}-bit · ${Math.round(audioBuffer.sampleRate/1000)} kHz · ${dur} · ${(wavBlob.size/1048576).toFixed(1)} MB`, url, `Vox5000_${ts}.wav`);
  }

  if (markers.length > 0) {
    const txt = `Vox5000 Marker Log\nSession: ${ts}\nDuration: ${dur}\n\n` + markers.map(mk=>`${mk.label}\t${mk.time}`).join('\n');
    const mUrl = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    addDownload(`Vox5000_${ts}_markers.txt`, `${markers.length} marker${markers.length>1?'s':''} · ${dur}`, mUrl, `Vox5000_${ts}_markers.txt`);
  }

  elapsed = 0;
  duration.textContent = '00:00:00';
  durStatus.textContent = 'Done — download your files below';
  dlSection.classList.add('visible');
  dlSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function addDownload(name, meta, url, filename) {
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

initMics();
