'use strict';

// ── Browser detection ──
(function(){
  const ok = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext && window.MediaRecorder);
  if (!ok) {
    const el = document.getElementById('unsupportedBrowser');
    if (el) { el.style.display = 'block'; el.textContent = 'Your browser does not support audio recording. Please use Google Chrome on a desktop or laptop.'; }
  }
})();

// ── Safe text helper — never use innerHTML with user content ──
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const $ = id => document.getElementById(id);

const micSelect     = $('micSelect');
const meterBar      = $('meterBar');
const testBtn       = $('testBtn');
const recBtn        = $('recBtn');
const pauseBtn      = $('pauseBtn');
const onAir         = $('onAir');
const duration      = $('duration');
const durStatus     = $('durStatus');
const sizeDisplay   = $('sizeDisplay');
const dlSection     = $('dlSection');
const dlGrid        = $('dlGrid');
const waveCanvas    = $('waveCanvas');
const permNotice    = $('permNotice');
const clipWarn      = $('clipWarn');
const formatSelect  = $('formatSelect');
const qualitySelect = $('qualitySelect');

// Solo mode toggle — init mics only when user opens the recorder panel
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

let audioCtx, analyser, stream, processedDest;
let gainNode, monitorGainNode;
let mediaRecorder, chunks = [];
let recording = false, paused = false, testing = false;
let startTime, elapsed = 0, timerInterval;
let clipTimeout;

const wCtx = waveCanvas ? waveCanvas.getContext('2d') : null;
let waveBuffer = [];
const WAVE_HISTORY = 900;

// ── Quality presets ──
// NOTE: WAV here is a converted WAV export from WebM Opus decode.
// It is NOT a true lossless PCM capture. Labels reflect this honestly.
const WAV_QUALITIES = {
  'wav-48-24': { sr: 48000, bits: 24, label: '48 kHz / 24-bit WAV export' },
  'wav-48-16': { sr: 48000, bits: 16, label: '48 kHz / 16-bit WAV export' },
  'wav-44-16': { sr: 44100, bits: 16, label: '44.1 kHz / 16-bit WAV export' },
  'wav-22-16': { sr: 22050, bits: 16, label: '22 kHz / 16-bit WAV export (voice)' },
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

// ── Time formatting ──
function fmt(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  const ms = Math.floor((s % 1) * 10);
  return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':') + '.' + ms;
}
function fmtNoMs(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
}

function dbToGain(db) { return db <= -59 ? 0 : Math.pow(10, db / 20); }
function formatDb(db) {
  if (db <= -59) return 'Off';
  if (db === 0) return '0 dB';
  return (db > 0 ? '+' : '') + parseFloat(db).toFixed(1) + ' dB';
}

// ── Level sliders ──
const inputGainSlider = $('inputGainSlider');
const inputGainVal    = $('inputGainVal');
const monitorSlider   = $('monitorSlider');
const monitorVal      = $('monitorVal');

if (inputGainSlider) {
  inputGainSlider.addEventListener('input', () => {
    const db = parseFloat(inputGainSlider.value);
    if (inputGainVal) inputGainVal.textContent = formatDb(db);
    // Gain change applies live to the audio graph — works during recording
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

// ── Mic selector — disabled during recording ──
if (micSelect) {
  micSelect.addEventListener('change', () => {
    if (recording) {
      // Revert the change and warn
      alert('Stop recording before changing your microphone.');
      return;
    }
    startStream(micSelect.value);
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
      const err = $('micNotFoundError');
      if (err) { err.style.display = 'block'; err.querySelector('.error-text').textContent = 'No microphone found. Plug in a USB or XLR interface mic and refresh the page.'; }
      return;
    }
    if (micSelect) {
      micSelect.innerHTML = '';
      mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        // Use textContent — device labels come from the browser and are safe but be consistent
        opt.textContent = d.label || `Microphone ${i + 1}`;
        micSelect.appendChild(opt);
      });
    }
    await startStream(micSelect ? micSelect.value : undefined);
  } catch(e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      const err = $('micDeniedError');
      if (err) err.style.display = 'block';
      if (permNotice) permNotice.style.display = 'none';
    } else {
      const err = $('micNotFoundError');
      if (err) err.style.display = 'block';
    }
    if (durStatus) durStatus.textContent = 'Microphone not available — check permissions';
  }
}

// ── Audio graph ──
// Signal chain: mic → gainNode → analyser → processedDest (for recording)
//                                         ↘ monitorGainNode → speakers (for monitoring)
// Recording uses processedDest.stream so input gain affects what is recorded.
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

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;

    // processedDest is what MediaRecorder records — gain-adjusted signal
    processedDest = audioCtx.createMediaStreamDestination();

    monitorGainNode = audioCtx.createGain();
    const monDb = monitorSlider ? parseFloat(monitorSlider.value) : -60;
    monitorGainNode.gain.value = dbToGain(monDb);

    src.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(processedDest);       // gain-adjusted → recording
    analyser.connect(monitorGainNode);
    monitorGainNode.connect(audioCtx.destination); // monitoring only

    drawMeter();
    drawWave();

    if (durStatus && durStatus.textContent === 'Microphone not available — check permissions') {
      durStatus.textContent = 'Ready to record';
    }
  } catch(e) {
    console.error('Stream error:', e);
    if (durStatus) durStatus.textContent = 'Could not access microphone';
  }
}

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
    if (meterBar) meterBar.style.setProperty('--level', pct + '%');
    if (pct > 95 && recording) {
      if (clipWarn) clipWarn.style.display = 'flex';
      clearTimeout(clipTimeout);
      clipTimeout = setTimeout(() => { if (clipWarn) clipWarn.style.display = 'none'; }, 2000);
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Waveform ──
function drawWave() {
  const buf = new Uint8Array(analyser ? analyser.frequencyBinCount : 512);
  function tick() {
    if (!waveCanvas || !wCtx) { requestAnimationFrame(tick); return; }
    const W = waveCanvas.width = waveCanvas.offsetWidth || 640;
    const H = waveCanvas.height;
    const mid = H / 2;
    const active = recording || testing;
    if (analyser) analyser.getByteTimeDomainData(buf);
    if (active) {
      let peak = 0, isClipping = false;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128) / 128;
        if (v > peak) peak = v;
        if (buf[i] > 242 || buf[i] < 13) isClipping = true;
      }
      waveBuffer.push({ peak, clipping: isClipping });
      if (waveBuffer.length > WAVE_HISTORY) waveBuffer.shift();
    }
    wCtx.fillStyle = '#0e0e0e';
    wCtx.fillRect(0, 0, W, H);
    const clipH = H * 0.07;
    wCtx.fillStyle = 'rgba(255,68,68,0.1)';
    wCtx.fillRect(0, 0, W, clipH);
    wCtx.fillRect(0, H - clipH, W, clipH);
    wCtx.strokeStyle = 'rgba(255,255,255,0.05)';
    wCtx.lineWidth = 1;
    wCtx.beginPath(); wCtx.moveTo(0, mid); wCtx.lineTo(W, mid); wCtx.stroke();
    if (waveBuffer.length === 0) {
      wCtx.strokeStyle = 'rgba(232,255,71,0.15)';
      wCtx.lineWidth = 1.5;
      wCtx.beginPath(); wCtx.moveTo(0, mid); wCtx.lineTo(W, mid); wCtx.stroke();
    } else {
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
          wCtx.fillStyle = `rgb(${r},255,${Math.round(136 - intensity * 136)})`;
        }
        wCtx.fillRect(x, mid - h, Math.max(1, barW - 0.5), h * 2);
      }
      const headX = waveBuffer.length * (W / WAVE_HISTORY);
      wCtx.strokeStyle = 'rgba(255,255,255,0.15)';
      wCtx.lineWidth = 1;
      wCtx.beginPath(); wCtx.moveTo(headX, 0); wCtx.lineTo(headX, H); wCtx.stroke();
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// ── 5s mic test ──
let testChunks = [], testRecorder;
if (testBtn) {
  testBtn.addEventListener('click', async () => {
    if (!stream) return;
    testBtn.disabled = true;
    testChunks = [];
    testing = true;
    waveBuffer = [];
    // Use processedDest so test also reflects gain settings
    const src = processedDest ? processedDest.stream : stream;
    testRecorder = new MediaRecorder(src);
    testRecorder.ondataavailable = e => testChunks.push(e.data);
    testRecorder.onstop = () => {
      testing = false;
      const blob = new Blob(testChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
      testBtn.textContent = '5s mic test';
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
}

// ── Record / Stop ──
if (recBtn) {
  recBtn.addEventListener('click', async () => {
    if (recBtn.disabled) return;
    if (!stream) { await initMics(); return; }
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
}

function startRecording() {
  if (!processedDest) { if (durStatus) durStatus.textContent = 'Mic not ready — try again'; return; }
  chunks = [];
  if (sizeDisplay) sizeDisplay.textContent = '';
  if (dlSection) dlSection.classList.remove('visible');
  if (dlGrid) dlGrid.innerHTML = '';
  waveBuffer = [];

  // Record the gain-adjusted processed stream
  const opts = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 320000 }
    : { audioBitsPerSecond: 256000 };

  mediaRecorder = new MediaRecorder(processedDest.stream, opts);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = finalise;
  mediaRecorder.start(1000);

  recording = true; paused = false; elapsed = 0;
  startTime = Date.now();
  timerInterval = setInterval(tick, 100);

  if (recBtn) { recBtn.classList.add('recording'); recBtn.innerHTML = '<span class="rec-dot"></span> Stop'; recBtn.disabled = false; }
  if (pauseBtn) pauseBtn.disabled = false;
  if (onAir) onAir.classList.add('visible');
  if (durStatus) durStatus.textContent = 'Recording';

  // Disable mic/settings changes during recording
  if (micSelect) micSelect.disabled = true;
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  paused = false;
  clearInterval(timerInterval);

  // Re-enable mic selector
  if (micSelect) micSelect.disabled = false;

  // Reset UI immediately — do not wait for onstop
  if (onAir) onAir.classList.remove('visible');
  if (recBtn) { recBtn.classList.remove('recording'); recBtn.innerHTML = '<span class="rec-dot"></span> Record'; recBtn.disabled = false; }
  if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.innerHTML = '⏸ Pause'; }
  if (durStatus) durStatus.textContent = 'Processing…';
  if (sizeDisplay) sizeDisplay.textContent = '';

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // triggers onstop → finalise
  } else {
    finalise();
  }
}

function tick() {
  if (!paused) {
    elapsed = (Date.now() - startTime) / 1000;
    if (duration) duration.textContent = fmt(elapsed);
    const mb = (chunks.reduce((a,c) => a + c.size, 0) / 1048576).toFixed(1);
    if (sizeDisplay && parseFloat(mb) > 0) sizeDisplay.textContent = mb + ' MB captured';
  }
}

if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    if (!recording) return;
    if (!paused) {
      mediaRecorder.pause(); paused = true;
      pauseBtn.innerHTML = '▶ Resume';
      if (durStatus) durStatus.textContent = 'Paused';
      if (onAir) onAir.classList.remove('visible');
    } else {
      mediaRecorder.resume(); paused = false;
      startTime = Date.now() - elapsed * 1000;
      pauseBtn.innerHTML = '⏸ Pause';
      if (durStatus) durStatus.textContent = 'Recording';
      if (onAir) onAir.classList.add('visible');
    }
  });
}

// ── WAV export encoder ──
// NOTE: This encodes decoded Opus audio into PCM WAV.
// It is a format conversion, not a true lossless capture.
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
  if (durStatus) durStatus.textContent = 'Encoding MP3…';
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
  if (!chunks.length) {
    if (durStatus) durStatus.textContent = 'Nothing recorded — try again';
    return;
  }
  const webmBlob = new Blob(chunks, { type: 'audio/webm' });
  const fmtVal = formatSelect ? formatSelect.value : 'mp3';
  const quality = qualitySelect ? qualitySelect.value : 'mp3-256';
  const ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const dur = fmtNoMs(Math.floor(elapsed));
  if (dlGrid) dlGrid.innerHTML = '';

  let audioBuffer;
  try {
    if (durStatus) durStatus.textContent = 'Decoding audio…';
    audioBuffer = await audioCtx.decodeAudioData(await webmBlob.arrayBuffer());
  } catch(e) {
    if (durStatus) durStatus.textContent = 'Could not process recording — download raw file below';
    // Offer raw WebM as fallback
    addDownload(`Vox5000_${ts}.webm`, `WebM Opus · ${dur} · ${(webmBlob.size/1048576).toFixed(1)} MB`, URL.createObjectURL(webmBlob), `Vox5000_${ts}.webm`);
    if (dlSection) dlSection.classList.add('visible');
    return;
  }

  if (fmtVal === 'mp3') {
    try {
      const kbps = MP3_QUALITIES[quality] ? MP3_QUALITIES[quality].kbps : 256;
      const mp3Blob = await encodeMp3(audioBuffer, kbps);
      addDownload(`Vox5000_${ts}.mp3`, `MP3 · ${kbps} kbps · ${dur} · ${(mp3Blob.size/1048576).toFixed(1)} MB`, URL.createObjectURL(mp3Blob), `Vox5000_${ts}.mp3`);
    } catch(e) {
      if (durStatus) durStatus.textContent = 'MP3 encoding failed — downloading WebM instead';
      addDownload(`Vox5000_${ts}.webm`, `WebM Opus (fallback) · ${dur}`, URL.createObjectURL(webmBlob), `Vox5000_${ts}.webm`);
    }
  } else {
    const bits = WAV_QUALITIES[quality] ? WAV_QUALITIES[quality].bits : 16;
    const wavBlob = encodeWav(audioBuffer, bits);
    // Label is honest: this is a converted WAV, not original PCM
    addDownload(`Vox5000_${ts}.wav`, `WAV export · ${bits}-bit · ${Math.round(audioBuffer.sampleRate/1000)} kHz · ${dur} · ${(wavBlob.size/1048576).toFixed(1)} MB`, URL.createObjectURL(wavBlob), `Vox5000_${ts}.wav`);
  }

  if (duration) duration.textContent = '00:00:00.0';
  if (durStatus) durStatus.textContent = 'Done — download your file below';
  if (dlSection) dlSection.classList.add('visible');
  if (dlSection) dlSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Safe download item — uses DOM not innerHTML ──
function addDownload(name, meta, url, filename) {
  if (!dlGrid) return;
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
  dlGrid.appendChild(item);
}

// Mic initialisation is triggered by MutationObserver when the solo recorder panel opens
