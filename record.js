'use strict';

const $ = id => document.getElementById(id);

const els = {
  status: $('statusText'),
  mic: $('micSelect'),
  meter: $('meterBar'),
  file: $('fileInput'),
  newBtn: $('newBtn'),
  record: $('recordBtn'),
  stop: $('stopBtn'),
  play: $('playBtn'),
  rewind: $('rewindBtn'),
  time: $('timeDisplay'),
  canvas: $('waveCanvas'),
  hint: $('timelineHint'),
  duration: $('durationText'),
  selection: $('selectionText'),
  format: $('formatText'),
  undo: $('undoBtn'),
  redo: $('redoBtn'),
  trim: $('trimBtn'),
  del: $('deleteBtn'),
  split: $('splitBtn'),
  fadeIn: $('fadeInBtn'),
  fadeOut: $('fadeOutBtn'),
  normalize: $('normalizeBtn'),
  compress: $('compressBtn'),
  limit: $('limitBtn'),
  noise: $('noiseBtn'),
  silence: $('silenceBtn'),
  lowEq: $('lowEq'),
  midEq: $('midEq'),
  highEq: $('highEq'),
  eq: $('eqBtn'),
  exportFormat: $('exportFormat'),
  export: $('exportBtn'),
  download: $('downloadSlot'),
};

let audioCtx;
let inputStream;
let inputAnalyser;
let inputGain;
let recorder;
let recordChunks = [];
let recordStartedAt = 0;
let timerId;
let sourceNode;
let playStartedAt = 0;
let playOffset = 0;
let rafId;
let buffer = null;
let fileName = 'Vox5000';
let selection = null;
let dragging = false;
let dragStart = 0;
let undoStack = [];
let redoStack = [];

const canvasCtx = els.canvas ? els.canvas.getContext('2d') : null;

function ensureAudioContext() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext({ sampleRate: 48000 });
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

function fmtTime(seconds) {
  seconds = Math.max(0, seconds || 0);
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function secondsToSamples(seconds) {
  return Math.max(0, Math.min(buffer ? buffer.length : 0, Math.round(seconds * (buffer ? buffer.sampleRate : 48000))));
}

function samplesToSeconds(samples) {
  return samples / (buffer ? buffer.sampleRate : 48000);
}

function cloneBuffer(src) {
  const ctx = ensureAudioContext();
  const copy = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let ch = 0; ch < src.numberOfChannels; ch++) copy.copyToChannel(src.getChannelData(ch), ch);
  return copy;
}

function pushUndo() {
  if (!buffer) return;
  undoStack.push(cloneBuffer(buffer));
  if (undoStack.length > 30) undoStack.shift();
  redoStack = [];
  updateControls();
}

function setBuffer(next, name) {
  buffer = next;
  fileName = name || fileName || 'Vox5000';
  selection = null;
  playOffset = 0;
  stopPlayback();
  updateControls();
  drawWaveform();
  setStatus(buffer ? 'Audio loaded' : 'No audio loaded');
}

function updateControls() {
  const hasAudio = Boolean(buffer);
  const hasSelection = Boolean(selection && selection.end > selection.start);
  [els.play, els.rewind, els.trim, els.del, els.split, els.fadeIn, els.fadeOut, els.normalize, els.compress, els.limit, els.noise, els.silence, els.eq, els.export].forEach(btn => {
    if (btn) btn.disabled = !hasAudio;
  });
  [els.trim, els.del, els.fadeIn, els.fadeOut].forEach(btn => {
    if (btn) btn.disabled = !hasSelection;
  });
  if (els.undo) els.undo.disabled = undoStack.length === 0;
  if (els.redo) els.redo.disabled = redoStack.length === 0;
  const duration = buffer ? buffer.duration : 0;
  if (els.duration) els.duration.textContent = `Duration: ${fmtTime(duration)}`;
  if (els.selection) {
    els.selection.textContent = hasSelection
      ? `Selection: ${fmtTime(selection.start)} - ${fmtTime(selection.end)}`
      : 'Selection: none';
  }
  if (els.format) {
    els.format.textContent = buffer
      ? `${Math.round(buffer.sampleRate / 1000)} kHz · ${buffer.numberOfChannels} channel${buffer.numberOfChannels === 1 ? '' : 's'}`
      : '48 kHz browser session';
  }
  if (els.hint) els.hint.style.display = hasAudio ? 'none' : 'block';
}

async function initMics() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser cannot record audio');
    return;
  }
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach(track => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(device => device.kind === 'audioinput');
    if (!els.mic) return;
    els.mic.innerHTML = '';
    inputs.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microphone ${index + 1}`;
      els.mic.appendChild(opt);
    });
    if (inputs.length) await startInput(inputs[0].deviceId);
  } catch (err) {
    setStatus('Allow microphone access to record');
  }
}

async function startInput(deviceId) {
  const ctx = ensureAudioContext();
  if (inputStream) inputStream.getTracks().forEach(track => track.stop());
  inputStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
  });
  const src = ctx.createMediaStreamSource(inputStream);
  inputGain = ctx.createGain();
  inputAnalyser = ctx.createAnalyser();
  inputAnalyser.fftSize = 1024;
  src.connect(inputGain);
  inputGain.connect(inputAnalyser);
  drawInputMeter();
}

function drawInputMeter() {
  const data = new Uint8Array(inputAnalyser ? inputAnalyser.frequencyBinCount : 512);
  function tick() {
    if (inputAnalyser) {
      inputAnalyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
      if (els.meter) els.meter.style.setProperty('--level', `${Math.min(100, Math.round(peak * 200))}%`);
    }
    requestAnimationFrame(tick);
  }
  tick();
}

async function startRecording() {
  if (recorder && recorder.state === 'recording') return;
  if (!inputStream) await initMics();
  if (!inputStream) return;
  const ctx = ensureAudioContext();
  const dest = ctx.createMediaStreamDestination();
  inputGain.connect(dest);
  recordChunks = [];
  recorder = new MediaRecorder(dest.stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 }
    : { audioBitsPerSecond: 256000 });
  recorder.ondataavailable = event => { if (event.data.size) recordChunks.push(event.data); };
  recorder.onstop = async () => {
    clearInterval(timerId);
    inputGain.disconnect(dest);
    els.record.classList.remove('active');
    els.record.innerHTML = '<span class="rec-dot" aria-hidden="true"></span> Record';
    els.stop.disabled = true;
    const blob = new Blob(recordChunks, { type: 'audio/webm' });
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buffer) pushUndo();
    undoStack = buffer ? undoStack : [];
    redoStack = [];
    setBuffer(decoded, `Vox5000_${new Date().toISOString().slice(0, 16).replace('T', '_')}`);
    setStatus('Recording loaded into editor');
  };
  recorder.start(500);
  recordStartedAt = Date.now();
  els.record.classList.add('active');
  els.record.innerHTML = '<span class="rec-dot" aria-hidden="true"></span> Recording';
  els.stop.disabled = false;
  setStatus('Recording');
  timerId = setInterval(() => {
    if (els.time) els.time.textContent = fmtTime((Date.now() - recordStartedAt) / 1000);
  }, 80);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function importFile(file) {
  if (!file) return;
  const ctx = ensureAudioContext();
  setStatus('Decoding import');
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buffer) pushUndo();
  setBuffer(decoded, file.name.replace(/\.[^.]+$/, '') || 'Vox5000_import');
  setStatus('Imported audio');
}

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode.disconnect();
    sourceNode = null;
  }
  cancelAnimationFrame(rafId);
  if (els.play) els.play.textContent = 'Play';
}

function playPause() {
  if (!buffer) return;
  if (sourceNode) {
    playOffset = Math.min(buffer.duration, playOffset + (ensureAudioContext().currentTime - playStartedAt));
    stopPlayback();
    drawWaveform();
    return;
  }
  const ctx = ensureAudioContext();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.connect(ctx.destination);
  if (playOffset >= buffer.duration) playOffset = 0;
  playStartedAt = ctx.currentTime;
  sourceNode.start(0, playOffset);
  sourceNode.onended = () => {
    playOffset = 0;
    stopPlayback();
    drawWaveform();
  };
  if (els.play) els.play.textContent = 'Pause';
  animatePlayhead();
}

function currentPlayhead() {
  if (!sourceNode) return playOffset;
  return Math.min(buffer ? buffer.duration : 0, playOffset + (ensureAudioContext().currentTime - playStartedAt));
}

function animatePlayhead() {
  drawWaveform();
  if (els.time) els.time.textContent = fmtTime(currentPlayhead());
  rafId = requestAnimationFrame(animatePlayhead);
}

function selectionSamples() {
  if (!buffer || !selection || selection.end <= selection.start) return null;
  return {
    start: secondsToSamples(selection.start),
    end: secondsToSamples(selection.end),
  };
}

function copyRange(src, start, end) {
  const ctx = ensureAudioContext();
  const len = Math.max(1, end - start);
  const out = ctx.createBuffer(src.numberOfChannels, len, src.sampleRate);
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    out.copyToChannel(src.getChannelData(ch).slice(start, end), ch);
  }
  return out;
}

function trimSelection() {
  const range = selectionSamples();
  if (!range) return;
  pushUndo();
  setBuffer(copyRange(buffer, range.start, range.end), fileName);
  setStatus('Trimmed to selection');
}

function deleteSelection() {
  const range = selectionSamples();
  if (!range) return;
  pushUndo();
  const ctx = ensureAudioContext();
  const len = Math.max(1, buffer.length - (range.end - range.start));
  const out = ctx.createBuffer(buffer.numberOfChannels, len, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.slice(0, range.start), 0);
    dst.set(src.slice(range.end), range.start);
  }
  setBuffer(out, fileName);
  setStatus('Deleted selection');
}

function splitAtPlayhead() {
  if (!buffer) return;
  const point = currentPlayhead() || (selection ? selection.start : buffer.duration / 2);
  selection = { start: point, end: buffer.duration };
  updateControls();
  drawWaveform();
  setStatus('Split point set. Right-hand region selected.');
}

function processSamples(label, fn) {
  if (!buffer) return;
  pushUndo();
  const out = cloneBuffer(buffer);
  const range = selectionSamples() || { start: 0, end: out.length };
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    fn(out.getChannelData(ch), range.start, range.end, out.sampleRate);
  }
  setBuffer(out, fileName);
  setStatus(label);
}

function fadeIn() {
  processSamples('Fade in applied', (data, start, end) => {
    const len = Math.max(1, end - start);
    for (let i = start; i < end; i++) data[i] *= (i - start) / len;
  });
}

function fadeOut() {
  processSamples('Fade out applied', (data, start, end) => {
    const len = Math.max(1, end - start);
    for (let i = start; i < end; i++) data[i] *= 1 - ((i - start) / len);
  });
}

function normalize() {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (!peak) return;
  processSamples('Normalized', data => {
    const gain = 0.94 / peak;
    for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i] * gain));
  });
}

function compressVoice() {
  processSamples('Voice compression applied', (data, start, end) => {
    const threshold = 0.22;
    const ratio = 3.5;
    for (let i = start; i < end; i++) {
      const sign = Math.sign(data[i]);
      const abs = Math.abs(data[i]);
      data[i] = sign * (abs > threshold ? threshold + (abs - threshold) / ratio : abs);
    }
  });
}

function limiter() {
  processSamples('Limiter applied', (data, start, end) => {
    for (let i = start; i < end; i++) data[i] = Math.max(-0.92, Math.min(0.92, data[i]));
  });
}

function noiseGate() {
  processSamples('Noise gate applied', (data, start, end) => {
    const threshold = 0.018;
    for (let i = start; i < end; i++) if (Math.abs(data[i]) < threshold) data[i] *= 0.12;
  });
}

function removeSilence() {
  if (!buffer) return;
  pushUndo();
  const frame = 1024;
  const keep = [];
  const mono = buffer.getChannelData(0);
  for (let i = 0; i < mono.length; i += frame) {
    let peak = 0;
    for (let j = i; j < Math.min(i + frame, mono.length); j++) peak = Math.max(peak, Math.abs(mono[j]));
    if (peak > 0.012) keep.push([i, Math.min(i + frame, mono.length)]);
  }
  if (!keep.length) return;
  const total = keep.reduce((sum, part) => sum + part[1] - part[0], 0);
  const ctx = ensureAudioContext();
  const out = ctx.createBuffer(buffer.numberOfChannels, total, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    let offset = 0;
    keep.forEach(([start, end]) => {
      dst.set(src.slice(start, end), offset);
      offset += end - start;
    });
  }
  setBuffer(out, fileName);
  setStatus('Silence removed');
}

async function applyEq() {
  if (!buffer) return;
  pushUndo();
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 180;
  low.gain.value = Number(els.lowEq.value || 0);
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1800;
  mid.Q.value = 1;
  mid.gain.value = Number(els.midEq.value || 0);
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 4200;
  high.gain.value = Number(els.highEq.value || 0);
  src.connect(low).connect(mid).connect(high).connect(ctx.destination);
  src.start();
  setBuffer(await ctx.startRendering(), fileName);
  setStatus('EQ applied');
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneBuffer(buffer));
  setBuffer(undoStack.pop(), fileName);
  setStatus('Undo');
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneBuffer(buffer));
  setBuffer(redoStack.pop(), fileName);
  setStatus('Redo');
}

function canvasPointToSeconds(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  return buffer ? (x / rect.width) * buffer.duration : 0;
}

function drawWaveform() {
  if (!els.canvas || !canvasCtx) return;
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  canvasCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = rect.width;
  const h = rect.height;
  canvasCtx.fillStyle = '#070707';
  canvasCtx.fillRect(0, 0, w, h);
  canvasCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, h / 2);
  canvasCtx.lineTo(w, h / 2);
  canvasCtx.stroke();
  if (!buffer) return;
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  canvasCtx.fillStyle = '#dfff00';
  for (let x = 0; x < w; x++) {
    const start = Math.floor(x * step);
    let min = 1;
    let max = -1;
    for (let i = 0; i < step && start + i < data.length; i++) {
      const v = data[start + i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - max) * h / 2;
    const y2 = (1 - min) * h / 2;
    canvasCtx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  if (selection && selection.end > selection.start) {
    const x1 = (selection.start / buffer.duration) * w;
    const x2 = (selection.end / buffer.duration) * w;
    canvasCtx.fillStyle = 'rgba(223,255,0,0.2)';
    canvasCtx.fillRect(x1, 0, x2 - x1, h);
    canvasCtx.strokeStyle = '#dfff00';
    canvasCtx.strokeRect(x1, 0, x2 - x1, h);
  }
  const playX = (currentPlayhead() / buffer.duration) * w;
  canvasCtx.strokeStyle = '#ff3b3b';
  canvasCtx.lineWidth = 2;
  canvasCtx.beginPath();
  canvasCtx.moveTo(playX, 0);
  canvasCtx.lineTo(playX, h);
  canvasCtx.stroke();
}

function mixToMono(src) {
  const out = new Float32Array(src.length);
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    const data = src.getChannelData(ch);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / src.numberOfChannels;
  }
  return out;
}

function encodeWav(src) {
  const samples = mixToMono(src);
  const byteRate = src.sampleRate * 2;
  const bufferOut = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bufferOut);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, src.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([bufferOut], { type: 'audio/wav' });
}

async function encodeMp3(src) {
  if (!window.lamejs) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  const samples = mixToMono(src);
  const encoder = new lamejs.Mp3Encoder(1, src.sampleRate, 256);
  const block = 1152;
  const int16 = new Int16Array(samples.length);
  const chunks = [];
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  for (let i = 0; i < int16.length; i += block) {
    const encoded = encoder.encodeBuffer(int16.subarray(i, i + block));
    if (encoded.length) chunks.push(new Int8Array(encoded));
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Int8Array(end));
  return new Blob(chunks, { type: 'audio/mp3' });
}

async function exportFile() {
  if (!buffer) return;
  els.export.disabled = true;
  setStatus('Exporting');
  const format = els.exportFormat.value;
  const blob = format === 'wav' ? encodeWav(buffer) : await encodeMp3(buffer);
  const ext = format === 'wav' ? 'wav' : 'mp3';
  const url = URL.createObjectURL(blob);
  els.download.innerHTML = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName || 'Vox5000'}.${ext}`;
  a.className = 'dl-btn';
  a.textContent = `Download ${ext.toUpperCase()} · ${(blob.size / 1048576).toFixed(1)} MB`;
  els.download.appendChild(a);
  els.export.disabled = false;
  setStatus('Export ready');
}

function newSession() {
  stopPlayback();
  buffer = null;
  selection = null;
  playOffset = 0;
  undoStack = [];
  redoStack = [];
  if (els.download) els.download.innerHTML = '';
  if (els.time) els.time.textContent = '00:00.000';
  setStatus('No audio loaded');
  updateControls();
  drawWaveform();
}

function bindEvents() {
  if (els.mic) els.mic.addEventListener('change', () => startInput(els.mic.value));
  if (els.file) els.file.addEventListener('change', () => importFile(els.file.files[0]));
  if (els.newBtn) els.newBtn.addEventListener('click', newSession);
  if (els.record) els.record.addEventListener('click', startRecording);
  if (els.stop) els.stop.addEventListener('click', stopRecording);
  if (els.play) els.play.addEventListener('click', playPause);
  if (els.rewind) els.rewind.addEventListener('click', () => { playOffset = 0; stopPlayback(); drawWaveform(); });
  if (els.trim) els.trim.addEventListener('click', trimSelection);
  if (els.del) els.del.addEventListener('click', deleteSelection);
  if (els.split) els.split.addEventListener('click', splitAtPlayhead);
  if (els.fadeIn) els.fadeIn.addEventListener('click', fadeIn);
  if (els.fadeOut) els.fadeOut.addEventListener('click', fadeOut);
  if (els.normalize) els.normalize.addEventListener('click', normalize);
  if (els.compress) els.compress.addEventListener('click', compressVoice);
  if (els.limit) els.limit.addEventListener('click', limiter);
  if (els.noise) els.noise.addEventListener('click', noiseGate);
  if (els.silence) els.silence.addEventListener('click', removeSilence);
  if (els.eq) els.eq.addEventListener('click', applyEq);
  if (els.undo) els.undo.addEventListener('click', undo);
  if (els.redo) els.redo.addEventListener('click', redo);
  if (els.export) els.export.addEventListener('click', exportFile);

  if (els.canvas) {
    els.canvas.addEventListener('pointerdown', event => {
      if (!buffer) return;
      dragging = true;
      dragStart = canvasPointToSeconds(event);
      selection = { start: dragStart, end: dragStart };
      els.canvas.setPointerCapture(event.pointerId);
    });
    els.canvas.addEventListener('pointermove', event => {
      if (!buffer || !dragging) return;
      const now = canvasPointToSeconds(event);
      selection = { start: Math.min(dragStart, now), end: Math.max(dragStart, now) };
      updateControls();
      drawWaveform();
    });
    els.canvas.addEventListener('pointerup', event => {
      if (!buffer) return;
      dragging = false;
      const point = canvasPointToSeconds(event);
      if (!selection || Math.abs(selection.end - selection.start) < 0.05) {
        selection = null;
        playOffset = point;
      }
      updateControls();
      drawWaveform();
    });
  }

  window.addEventListener('resize', drawWaveform);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }
    if (event.code === 'Space' && buffer) {
      event.preventDefault();
      playPause();
    }
  });
}

bindEvents();
initMics();
updateControls();
drawWaveform();
