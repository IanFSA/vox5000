'use strict';

const $ = id => document.getElementById(id);

const els = {
  status: $('statusText'),
  mic: $('micSelect'),
  meter: $('inputMeter'),
  meterL: $('meterBarL'),
  meterR: $('meterBarR'),
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
  selectionStart: $('selectionStartText'),
  selectionEnd: $('selectionEndText'),
  selectionLength: $('selectionLengthText'),
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
  eqOpen: $('eqOpenBtn'),
  eqModal: $('eqModal'),
  eqClose: $('eqCloseBtn'),
  eqReset: $('eqResetBtn'),
  eqPreset: $('eqPreset'),
  lowEqVal: $('lowEqVal'),
  midEqVal: $('midEqVal'),
  highEqVal: $('highEqVal'),
  exportFormat: $('exportFormat'),
  export: $('exportBtn'),
  download: $('downloadSlot'),
  app: $('main-content'),
  overview: $('overviewCanvas'),
  channelScale: $('channelScale'),
  shortcutModal: $('shortcutModal'),
  shortcutList: $('shortcutList'),
  shortcutClose: $('shortcutClose'),
  shortcutReset: $('shortcutReset'),
  shortcutSave: $('shortcutSave'),
};

let audioCtx;
let inputStream;
let inputAnalyser;
let inputAnalysers = [];
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
let dragStartX = 0;
let dragPointerId = null;
let selectionDragMoved = false;
let overviewDragging = false;
let undoStack = [];
let redoStack = [];
let zoom = 1;
let visibleStart = 0;
let desiredChannels = 1;
let clipboardBuffer = null;
let recordingPeaks = [];
let recordingWaveRafId = 0;

const canvasCtx = els.canvas ? els.canvas.getContext('2d') : null;
const overviewCtx = els.overview ? els.overview.getContext('2d') : null;
const SHORTCUT_STORAGE_KEY = 'vox5000_editor_shortcuts_v1';
const WAVE_SIZE_STORAGE_KEY = 'vox5000_editor_wave_size_v1';
const defaultShortcuts = {
  playPause: 'Space',
  record: 'R',
  returnToStart: 'Enter',
  deleteSelection: 'Delete',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  cutSplit: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  marker: 'M',
};
let shortcuts = loadShortcuts();
let meterRafId = 0;

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

function fmtTimeline(seconds) {
  seconds = Math.max(0, seconds || 0);
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}'${String(s).padStart(2, '0')}`;
}

function loadShortcuts() {
  try {
    return { ...defaultShortcuts, ...JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) || '{}') };
  } catch {
    return { ...defaultShortcuts };
  }
}

function saveShortcuts() {
  localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcuts));
}

function renderShortcuts() {
  if (!els.shortcutList) return;
  els.shortcutList.querySelectorAll('[data-shortcut-input]').forEach(input => {
    input.value = shortcuts[input.dataset.shortcutInput] || '';
  });
}

function normalizeShortcutDefaults() {
  let changed = false;
  Object.entries(defaultShortcuts).forEach(([key, value]) => {
    if (!shortcuts[key]) {
      shortcuts[key] = value;
      changed = true;
    }
  });
  if (changed) saveShortcuts();
}

function eventToShortcut(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && !['Shift', 'ShiftLeft', 'ShiftRight'].includes(event.key)) parts.push('Shift');
  const keyMap = {
    ' ': 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Escape: 'Esc',
  };
  const key = keyMap[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(key);
  return parts.join('+');
}

function shortcutMatches(event, shortcut) {
  if (!shortcut) return false;
  return eventToShortcut(event).toLowerCase() === shortcut.toLowerCase();
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  return target.isContentEditable || ['input', 'textarea', 'select'].includes(tag);
}

function showShortcuts() {
  renderShortcuts();
  if (els.shortcutModal) els.shortcutModal.hidden = false;
  const first = els.shortcutList ? els.shortcutList.querySelector('input') : null;
  if (first) first.focus();
}

function closeShortcuts() {
  if (els.shortcutModal) els.shortcutModal.hidden = true;
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

function createBlankBuffer(channels) {
  const ctx = ensureAudioContext();
  return ctx.createBuffer(channels, ctx.sampleRate, ctx.sampleRate);
}

function newChannelFile(channels) {
  if (buffer) pushUndo();
  desiredChannels = channels;
  undoStack = [];
  redoStack = [];
  if (els.download) els.download.innerHTML = '';
  setBuffer(createBlankBuffer(channels), channels === 1 ? 'Vox5000_mono' : 'Vox5000_stereo');
  setStatus(channels === 1 ? 'New mono file ready' : 'New stereo file ready');
}

function setDesiredChannels(channels) {
  desiredChannels = channels;
  updateChannelScale();
  updateMeterMode();
  setStatus(channels === 1 ? 'Recording set to mono' : 'Recording set to stereo where supported by your device');
}

function currentMeterChannels() {
  return buffer ? Math.max(1, Math.min(2, buffer.numberOfChannels)) : Math.max(1, Math.min(2, desiredChannels));
}

function updateMeterMode() {
  if (!els.meter) return;
  const stereo = currentMeterChannels() > 1;
  els.meter.classList.toggle('stereo', stereo);
  els.meter.classList.toggle('mono', !stereo);
}

function pushUndo() {
  if (!buffer) return;
  undoStack.push(cloneBuffer(buffer));
  if (undoStack.length > 30) undoStack.shift();
  redoStack = [];
  updateControls();
}

function visibleDuration() {
  return buffer ? Math.max(0.05, buffer.duration / zoom) : 0;
}

function clampVisibleStart() {
  if (!buffer) {
    visibleStart = 0;
    return;
  }
  const maxStart = Math.max(0, buffer.duration - visibleDuration());
  visibleStart = Math.max(0, Math.min(maxStart, visibleStart));
}

function setZoom(nextZoom, anchorSeconds) {
  if (!buffer) {
    zoom = Math.max(1, Math.min(64, nextZoom));
    drawWaveform();
    return;
  }
  const oldDuration = visibleDuration();
  const anchor = typeof anchorSeconds === 'number' ? anchorSeconds : currentPlayhead();
  const anchorRatio = oldDuration ? (anchor - visibleStart) / oldDuration : 0.5;
  zoom = Math.max(1, Math.min(64, nextZoom));
  const nextDuration = visibleDuration();
  visibleStart = anchor - anchorRatio * nextDuration;
  clampVisibleStart();
  drawWaveform();
  drawOverview();
  setStatus(zoom === 1 ? 'Zoom reset' : `Zoom ${zoom.toFixed(1)}x`);
}

function panViewport(deltaSeconds) {
  if (!buffer) return;
  visibleStart += deltaSeconds;
  clampVisibleStart();
  drawWaveform();
  drawOverview();
}

function setWaveSize(size) {
  if (!els.app) return;
  els.app.classList.remove('wave-compact', 'wave-normal', 'wave-large');
  els.app.classList.add(`wave-${size}`);
  localStorage.setItem(WAVE_SIZE_STORAGE_KEY, size);
  requestAnimationFrame(() => {
    drawWaveform();
    drawOverview();
  });
}

function restoreWaveSize() {
  const stored = localStorage.getItem(WAVE_SIZE_STORAGE_KEY);
  if (['compact', 'normal', 'large'].includes(stored)) setWaveSize(stored);
}

function updateChannelScale() {
  if (!els.channelScale) return;
  const stereo = buffer ? buffer.numberOfChannels > 1 : desiredChannels > 1;
  els.channelScale.classList.toggle('stereo', stereo);
  els.channelScale.classList.toggle('mono', !stereo);
  const lane = label => `
    <div class="channel-lane">
      <span class="scale-label">6</span>
      <span class="scale-label channel">${label}</span>
      <span class="scale-label">6</span>
    </div>`;
  els.channelScale.innerHTML = stereo
    ? `${lane('L')}<div class="channel-divider"></div>${lane('R')}`
    : lane('1');
  els.channelScale.innerHTML += `
    <span class="scale-label small">1x</span>
    <div class="zoom-buttons" aria-label="Zoom controls">
      <button data-editor-action="zoomIn" title="Zoom in">+</button>
      <button data-editor-action="zoomOut" title="Zoom out">−</button>
      <button data-editor-action="zoomReset" title="Reset zoom">1x</button>
    </div>`;
}

function setBuffer(next, name) {
  buffer = next;
  fileName = name || fileName || 'Vox5000';
  selection = null;
  playOffset = 0;
  visibleStart = 0;
  zoom = 1;
  if (buffer) desiredChannels = buffer.numberOfChannels > 1 ? 2 : 1;
  stopPlayback();
  updateControls();
  drawWaveform();
  drawOverview();
  setStatus(buffer ? 'Audio loaded' : 'No audio loaded');
}

function updateControls() {
  const hasAudio = Boolean(buffer);
  const hasSelection = Boolean(selection && selection.end > selection.start);
  [els.play, els.rewind, els.trim, els.del, els.split, els.fadeIn, els.fadeOut, els.normalize, els.compress, els.limit, els.noise, els.silence, els.eq, els.eqOpen, els.export].forEach(btn => {
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
  if (els.selectionStart) els.selectionStart.textContent = hasSelection ? fmtTime(selection.start) : '--:--.---';
  if (els.selectionEnd) els.selectionEnd.textContent = hasSelection ? fmtTime(selection.end) : '--:--.---';
  if (els.selectionLength) els.selectionLength.textContent = hasSelection ? fmtTime(selection.end - selection.start) : '--:--.---';
  if (els.format) {
    els.format.textContent = buffer
      ? `${Math.round(buffer.sampleRate / 1000)} kHz · ${buffer.numberOfChannels} channel${buffer.numberOfChannels === 1 ? '' : 's'}`
      : '48 kHz browser session';
  }
  if (els.hint) els.hint.style.display = hasAudio ? 'none' : 'block';
  updateChannelScale();
  updateMeterMode();
  drawOverview();
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
      channelCount: { ideal: desiredChannels },
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
  inputAnalysers = [inputAnalyser];
  if (currentMeterChannels() > 1) {
    const splitter = ctx.createChannelSplitter(2);
    const leftAnalyser = ctx.createAnalyser();
    const rightAnalyser = ctx.createAnalyser();
    leftAnalyser.fftSize = 1024;
    rightAnalyser.fftSize = 1024;
    inputGain.connect(splitter);
    splitter.connect(leftAnalyser, 0);
    splitter.connect(rightAnalyser, 1);
    inputAnalysers = [leftAnalyser, rightAnalyser];
  }
  updateMeterMode();
  drawInputMeter();
}

function drawInputMeter() {
  if (meterRafId) cancelAnimationFrame(meterRafId);
  const data = new Uint8Array(512);
  function tick() {
    const analysers = inputAnalysers.length ? inputAnalysers : (inputAnalyser ? [inputAnalyser] : []);
    const levels = analysers.map(analyser => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
      return `${Math.min(100, Math.round(peak * 200))}%`;
    });
    if (els.meterL) els.meterL.style.setProperty('--level', levels[0] || '0%');
    if (els.meterR) els.meterR.style.setProperty('--level', levels[1] || levels[0] || '0%');
    meterRafId = requestAnimationFrame(tick);
  }
  tick();
}

function drawRecordingPreview() {
  if (!els.canvas || !canvasCtx) return;
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  canvasCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = rect.width;
  const h = rect.height;
  canvasCtx.fillStyle = '#030303';
  canvasCtx.fillRect(0, 0, w, h);

  canvasCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  canvasCtx.lineWidth = 1;
  for (let i = 0; i <= 12; i++) {
    const x = (i / 12) * w;
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, 0);
    canvasCtx.lineTo(x, h);
    canvasCtx.stroke();
  }

  const mid = h / 2;
  canvasCtx.strokeStyle = 'rgba(223,255,0,0.18)';
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, mid);
  canvasCtx.lineTo(w, mid);
  canvasCtx.stroke();

  const visible = recordingPeaks.slice(-Math.max(1, Math.floor(w)));
  canvasCtx.fillStyle = '#dfff00';
  visible.forEach((peak, index) => {
    const x = index;
    const y1 = mid - peak.max * h * 0.42;
    const y2 = mid - peak.min * h * 0.42;
    canvasCtx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  });

  canvasCtx.fillStyle = '#777';
  canvasCtx.font = '11px JetBrains Mono, monospace';
  canvasCtx.fillText(`REC ${fmtTime((Date.now() - recordStartedAt) / 1000)}`, 8, 17);
}

function startRecordingPreview() {
  if (recordingWaveRafId) cancelAnimationFrame(recordingWaveRafId);
  recordingPeaks = [];
  const data = new Float32Array(inputAnalyser ? inputAnalyser.fftSize : 1024);
  function tick() {
    if (!recorder || recorder.state !== 'recording' || !inputAnalyser) return;
    inputAnalyser.getFloatTimeDomainData(data);
    let min = 1;
    let max = -1;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    recordingPeaks.push({ min, max });
    drawRecordingPreview();
    drawOverview();
    recordingWaveRafId = requestAnimationFrame(tick);
  }
  tick();
}

function stopRecordingPreview() {
  if (recordingWaveRafId) cancelAnimationFrame(recordingWaveRafId);
  recordingWaveRafId = 0;
}

async function startRecording() {
  if (recorder && recorder.state === 'recording') {
    stopRecording();
    return;
  }
  try {
    await startInput(els.mic ? els.mic.value : '');
  } catch {
    setStatus('Allow microphone access to record');
  }
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
    stopRecordingPreview();
    inputGain.disconnect(dest);
    els.record.classList.remove('active');
    els.record.innerHTML = '<span class="record-dot"></span>';
    els.stop.disabled = true;
    const blob = new Blob(recordChunks, { type: 'audio/webm' });
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buffer) pushUndo();
    undoStack = buffer ? undoStack : [];
    redoStack = [];
    setBuffer(decoded, `Vox5000_${new Date().toISOString().slice(0, 16).replace('T', '_')}`);
    setStatus(desiredChannels > 1 && decoded.numberOfChannels === 1
      ? 'Recording loaded as mono. Your browser or input did not provide stereo.'
      : 'Recording loaded into editor');
  };
  recorder.start(500);
  recordStartedAt = Date.now();
  els.record.classList.add('active');
  els.record.innerHTML = '<span class="record-dot"></span>';
  els.stop.disabled = false;
  setStatus('Recording');
  startRecordingPreview();
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
  if (els.play) els.play.textContent = '▶';
}

function clearSelection() {
  selection = null;
  updateControls();
  drawWaveform();
  drawOverview();
}

function returnToStart() {
  playOffset = 0;
  visibleStart = 0;
  stopPlayback();
  if (els.time) els.time.textContent = fmtTime(0);
  drawWaveform();
  drawOverview();
  setStatus('Returned to start');
}

function selectAllAudio() {
  if (!buffer) return;
  selection = { start: 0, end: buffer.duration };
  playOffset = 0;
  visibleStart = 0;
  updateControls();
  drawWaveform();
  drawOverview();
  setStatus('Selected all audio');
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
  if (els.play) els.play.textContent = 'Ⅱ';
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

function copySelection() {
  const range = selectionSamples();
  if (!range) {
    setStatus('Select audio before copying');
    return;
  }
  clipboardBuffer = copyRange(buffer, range.start, range.end);
  setStatus('Selection copied');
}

function pasteClipboard() {
  if (!buffer || !clipboardBuffer) {
    setStatus('Nothing copied yet');
    return;
  }
  pushUndo();
  const ctx = ensureAudioContext();
  const insertAt = secondsToSamples(playOffset);
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length + clipboardBuffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const clip = clipboardBuffer.getChannelData(Math.min(ch, clipboardBuffer.numberOfChannels - 1));
    const dst = out.getChannelData(ch);
    dst.set(src.slice(0, insertAt), 0);
    dst.set(clip, insertAt);
    dst.set(src.slice(insertAt), insertAt + clipboardBuffer.length);
  }
  setBuffer(out, fileName);
  playOffset = samplesToSeconds(insertAt + clipboardBuffer.length);
  setStatus('Pasted audio');
}

function cutOrSplit() {
  if (selection && selection.end > selection.start) {
    copySelection();
    deleteSelection();
    setStatus('Cut selection');
  } else {
    splitAtPlayhead();
  }
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

function insertSilence() {
  if (!buffer) return;
  pushUndo();
  const ctx = ensureAudioContext();
  const insertAt = secondsToSamples(playOffset);
  const silenceLength = Math.max(1, Math.round(buffer.sampleRate));
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length + silenceLength, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.slice(0, insertAt), 0);
    dst.set(src.slice(insertAt), insertAt + silenceLength);
  }
  setBuffer(out, fileName);
  playOffset = samplesToSeconds(insertAt + silenceLength);
  setStatus('Inserted 1 second of silence');
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
  closeEq();
}

function showEq() {
  updateEqValues();
  if (els.eqModal) els.eqModal.hidden = false;
}

function closeEq() {
  if (els.eqModal) els.eqModal.hidden = true;
}

function updateEqValues() {
  const format = value => `${Number(value || 0) > 0 ? '+' : ''}${Number(value || 0)} dB`;
  if (els.lowEqVal && els.lowEq) els.lowEqVal.textContent = format(els.lowEq.value);
  if (els.midEqVal && els.midEq) els.midEqVal.textContent = format(els.midEq.value);
  if (els.highEqVal && els.highEq) els.highEqVal.textContent = format(els.highEq.value);
}

function setEqValues(low, mid, high) {
  if (els.lowEq) els.lowEq.value = low;
  if (els.midEq) els.midEq.value = mid;
  if (els.highEq) els.highEq.value = high;
  updateEqValues();
}

function applyEqPreset() {
  const presets = {
    flat: [0, 0, 0],
    voice: [-2, 3, 2],
    warm: [3, 1, -1],
    bright: [-1, 2, 4],
    thin: [-5, 1, 2],
  };
  setEqValues(...(presets[els.eqPreset.value] || presets.flat));
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
  return buffer ? Math.min(buffer.duration, visibleStart + (x / rect.width) * visibleDuration()) : 0;
}

function drawWaveform() {
  if (!els.canvas || !canvasCtx) return;
  clampVisibleStart();
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  canvasCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = rect.width;
  const h = rect.height;
  canvasCtx.fillStyle = '#030303';
  canvasCtx.fillRect(0, 0, w, h);

  canvasCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  canvasCtx.lineWidth = 1;
  for (let i = 0; i <= 12; i++) {
    const x = (i / 12) * w;
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, 0);
    canvasCtx.lineTo(x, h);
    canvasCtx.stroke();
  }
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, h / 2);
  canvasCtx.lineTo(w, h / 2);
  canvasCtx.stroke();

  if (!buffer) return;

  const viewDuration = visibleDuration();
  const visibleSamples = Math.max(1, Math.floor(viewDuration * buffer.sampleRate));
  const sampleStart = Math.max(0, Math.floor(visibleStart * buffer.sampleRate));
  const lanes = buffer.numberOfChannels > 1 ? 2 : 1;
  const laneHeight = h / lanes;

  function drawChannel(channelIndex, top) {
    const data = buffer.getChannelData(Math.min(channelIndex, buffer.numberOfChannels - 1));
    const step = Math.max(1, Math.floor(visibleSamples / Math.max(1, w)));
    const mid = top + laneHeight / 2;
    canvasCtx.strokeStyle = 'rgba(255,255,255,0.08)';
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, mid);
    canvasCtx.lineTo(w, mid);
    canvasCtx.stroke();

    canvasCtx.fillStyle = '#dfff00';
    for (let x = 0; x < w; x++) {
      const start = sampleStart + Math.floor(x * step);
      let min = 1;
      let max = -1;
      for (let i = 0; i < step && start + i < data.length; i++) {
        const v = data[start + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = mid - max * (laneHeight * 0.42);
      const y2 = mid - min * (laneHeight * 0.42);
      canvasCtx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  drawChannel(0, 0);
  if (lanes > 1) drawChannel(1, laneHeight);

  if (selection && selection.end > selection.start) {
    const x1 = ((selection.start - visibleStart) / viewDuration) * w;
    const x2 = ((selection.end - visibleStart) / viewDuration) * w;
    const left = Math.max(0, Math.min(w, x1));
    const right = Math.max(0, Math.min(w, x2));
    canvasCtx.fillStyle = 'rgba(111,75,150,0.52)';
    canvasCtx.fillRect(left, 0, Math.max(0, right - left), h);
    canvasCtx.strokeStyle = '#dfff00';
    canvasCtx.strokeRect(left, 0, Math.max(0, right - left), h);
  }

  const playX = ((currentPlayhead() - visibleStart) / viewDuration) * w;
  if (playX >= 0 && playX <= w) {
    canvasCtx.strokeStyle = '#ff3b3b';
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(playX, 0);
    canvasCtx.lineTo(playX, h);
    canvasCtx.stroke();
  }

  canvasCtx.fillStyle = '#777';
  canvasCtx.font = '11px JetBrains Mono, monospace';
  for (let i = 0; i <= 10; i++) {
    const seconds = visibleStart + (i / 10) * viewDuration;
    canvasCtx.fillText(fmtTimeline(seconds), (i / 10) * w + 3, 15);
  }
}

function drawOverview() {
  if (!els.overview || !overviewCtx) return;
  const rect = els.overview.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.overview.width = Math.max(1, Math.floor(rect.width * ratio));
  els.overview.height = Math.max(1, Math.floor(rect.height * ratio));
  overviewCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = rect.width;
  const h = rect.height;
  const rulerHeight = Math.min(18, Math.max(14, h * 0.34));
  const rulerTop = h - rulerHeight;
  overviewCtx.fillStyle = '#111';
  overviewCtx.fillRect(0, 0, w, h);

  overviewCtx.fillStyle = '#0a0a0a';
  overviewCtx.fillRect(0, rulerTop, w, rulerHeight);
  overviewCtx.strokeStyle = '#2b2b2b';
  overviewCtx.lineWidth = 1;
  overviewCtx.beginPath();
  overviewCtx.moveTo(0, rulerTop);
  overviewCtx.lineTo(w, rulerTop);
  overviewCtx.stroke();

  if (!buffer) {
    overviewCtx.fillStyle = '#777';
    overviewCtx.font = '12px JetBrains Mono, monospace';
    overviewCtx.fillText('No audio loaded', 12, 28);
    return;
  }

  const data = mixToMono(buffer);
  const top = 3;
  const waveHeight = Math.max(8, h - rulerHeight - 7);
  const mid = top + waveHeight / 2;
  const step = Math.max(1, Math.floor(data.length / Math.max(1, w)));
  overviewCtx.fillStyle = '#dfff00';
  for (let x = 0; x < w; x++) {
    const start = Math.floor(x * step);
    let min = 1;
    let max = -1;
    for (let i = 0; i < step && start + i < data.length; i++) {
      const v = data[start + i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    overviewCtx.fillRect(x, mid - max * waveHeight * 0.44, 1, Math.max(1, (max - min) * waveHeight * 0.44));
  }

  const rulerStep = buffer.duration <= 30 ? 5 : buffer.duration <= 120 ? 15 : 60;
  overviewCtx.fillStyle = '#777';
  overviewCtx.font = '12px JetBrains Mono, monospace';
  for (let seconds = 0; seconds <= buffer.duration; seconds += rulerStep) {
    const x = (seconds / buffer.duration) * w;
    overviewCtx.strokeStyle = '#9b9b9b';
    overviewCtx.beginPath();
    overviewCtx.moveTo(x, rulerTop);
    overviewCtx.lineTo(x, h);
    overviewCtx.stroke();
    overviewCtx.fillText(fmtTimeline(seconds), x + 4, h - 5);
  }

  const viewDuration = visibleDuration();
  const x1 = (visibleStart / buffer.duration) * w;
  const x2 = ((visibleStart + viewDuration) / buffer.duration) * w;
  overviewCtx.fillStyle = 'rgba(214, 105, 255, 0.18)';
  overviewCtx.fillRect(x1, top, Math.max(3, x2 - x1), waveHeight);
  overviewCtx.strokeStyle = '#c76bff';
  overviewCtx.lineWidth = 2;
  overviewCtx.strokeRect(x1, top + 1, Math.max(3, x2 - x1), Math.max(3, waveHeight - 2));

  const playX = (currentPlayhead() / buffer.duration) * w;
  overviewCtx.strokeStyle = '#dfff00';
  overviewCtx.lineWidth = 2;
  overviewCtx.beginPath();
  overviewCtx.moveTo(playX, 0);
  overviewCtx.lineTo(playX, h);
  overviewCtx.stroke();
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
  const channels = src.numberOfChannels;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = src.sampleRate * blockAlign;
  const dataSize = src.length * blockAlign;
  const bufferOut = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bufferOut);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, src.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < src.length; i++) {
    for (let ch = 0; ch < channels; ch++, offset += 2) {
      const s = Math.max(-1, Math.min(1, src.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
  }
  return new Blob([bufferOut], { type: 'audio/wav' });
}

async function encodeMp3(src, bitrate = 256) {
  if (!window.lamejs) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  const channels = src.numberOfChannels > 1 ? 2 : 1;
  const left = src.getChannelData(0);
  const right = channels > 1 ? src.getChannelData(1) : left;
  const encoder = new lamejs.Mp3Encoder(channels, src.sampleRate, bitrate);
  const block = 1152;
  const chunks = [];
  const toInt16 = data => {
    const int16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  };
  const left16 = toInt16(left);
  const right16 = channels > 1 ? toInt16(right) : null;
  for (let i = 0; i < left16.length; i += block) {
    const encoded = channels > 1
      ? encoder.encodeBuffer(left16.subarray(i, i + block), right16.subarray(i, i + block))
      : encoder.encodeBuffer(left16.subarray(i, i + block));
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
  const isWav = format === 'wav';
  const bitrate = isWav ? 0 : Number((format.split(':')[1] || 256));
  const blob = isWav ? encodeWav(buffer) : await encodeMp3(buffer, bitrate);
  const ext = isWav ? 'wav' : 'mp3';
  const url = URL.createObjectURL(blob);
  els.download.innerHTML = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName || 'Vox5000'}.${ext}`;
  a.className = 'dl-btn';
  a.textContent = `Download ${isWav ? 'WAV' : `MP3 ${bitrate} kbps`} · ${(blob.size / 1048576).toFixed(1)} MB`;
  els.download.appendChild(a);
  els.export.disabled = false;
  setStatus('Export ready');
}

function newSession() {
  stopPlayback();
  buffer = null;
  selection = null;
  playOffset = 0;
  visibleStart = 0;
  zoom = 1;
  undoStack = [];
  redoStack = [];
  if (els.download) els.download.innerHTML = '';
  if (els.time) els.time.textContent = '00:00.000';
  setStatus('No audio loaded');
  updateControls();
  drawWaveform();
  drawOverview();
}

function closeMenus() {
  document.querySelectorAll('.menu.open').forEach(menu => {
    menu.classList.remove('open');
    const button = menu.querySelector('.menu-btn');
    if (button) button.setAttribute('aria-expanded', 'false');
  });
}

function toggleMenu(menu) {
  const wasOpen = menu.classList.contains('open');
  closeMenus();
  if (!wasOpen) {
    openMenu(menu);
  }
}

function openMenu(menu) {
  if (!menu) return;
  closeMenus();
  menu.classList.add('open');
  const button = menu.querySelector('.menu-btn');
  if (button) button.setAttribute('aria-expanded', 'true');
}

function finishWaveDrag(event) {
  if (!dragging) return;
  if (event && dragPointerId !== null) {
    try { els.canvas.releasePointerCapture(dragPointerId); } catch {}
  }
  dragging = false;
  dragPointerId = null;
  selectionDragMoved = false;
  if (els.canvas) els.canvas.classList.remove('is-selecting');
}

function handleWavePointerUp(event) {
  if (!buffer || !dragging) return;
  const point = canvasPointToSeconds(event);
  if (!selectionDragMoved) {
    selection = null;
    playOffset = point;
  } else if (!selection || Math.abs(selection.end - selection.start) < 0.05) {
    selection = null;
    playOffset = point;
  }
  finishWaveDrag(event);
  updateControls();
  drawWaveform();
  drawOverview();
}

function overviewPointToSeconds(event) {
  if (!buffer || !els.overview) return 0;
  const rect = els.overview.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  return (x / rect.width) * buffer.duration;
}

function moveViewportFromOverview(event) {
  if (!buffer) return;
  const center = overviewPointToSeconds(event);
  visibleStart = center - visibleDuration() / 2;
  clampVisibleStart();
  drawWaveform();
  drawOverview();
}

function handleEditorShortcut(event) {
  if (event.key === 'Escape') {
    closeMenus();
    closeShortcuts();
    closeEq();
    finishWaveDrag(event);
    return;
  }
  if (isTypingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;

  if (mod && key === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (mod && key === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (mod && key === 'a') {
    event.preventDefault();
    selectAllAudio();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selection && selection.end > selection.start) {
    event.preventDefault();
    deleteSelection();
    return;
  }
  if (event.key === 'Enter' && buffer) {
    event.preventDefault();
    returnToStart();
    return;
  }
  if (event.code === 'Space' && buffer) {
    event.preventDefault();
    playPause();
    return;
  }
  const actionByShortcut = [
    ['playPause', playPause],
    ['record', startRecording],
    ['returnToStart', returnToStart],
    ['deleteSelection', deleteSelection],
    ['selectAll', selectAllAudio],
    ['undo', undo],
    ['redo', redo],
    ['cutSplit', cutOrSplit],
    ['copy', copySelection],
    ['paste', pasteClipboard],
    ['marker', () => setStatus(`Marker noted at ${fmtTime(currentPlayhead())}`)],
  ];
  for (const [name, action] of actionByShortcut) {
    if (shortcutMatches(event, shortcuts[name])) {
      event.preventDefault();
      action();
      return;
    }
  }
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
  if (els.eqOpen) els.eqOpen.addEventListener('click', showEq);
  if (els.eqClose) els.eqClose.addEventListener('click', closeEq);
  if (els.eqReset) els.eqReset.addEventListener('click', () => setEqValues(0, 0, 0));
  if (els.eqPreset) els.eqPreset.addEventListener('change', applyEqPreset);
  [els.lowEq, els.midEq, els.highEq].forEach(slider => {
    if (slider) slider.addEventListener('input', updateEqValues);
  });
  if (els.undo) els.undo.addEventListener('click', undo);
  if (els.redo) els.redo.addEventListener('click', redo);
  if (els.export) els.export.addEventListener('click', exportFile);
  if (els.shortcutClose) els.shortcutClose.addEventListener('click', closeShortcuts);
  if (els.shortcutReset) els.shortcutReset.addEventListener('click', () => {
    shortcuts = { ...defaultShortcuts };
    saveShortcuts();
    renderShortcuts();
    setStatus('Shortcut defaults restored');
  });
  if (els.shortcutSave) els.shortcutSave.addEventListener('click', () => {
    if (els.shortcutList) {
      els.shortcutList.querySelectorAll('[data-shortcut-input]').forEach(input => {
        shortcuts[input.dataset.shortcutInput] = input.value.trim();
      });
    }
    saveShortcuts();
    closeShortcuts();
    setStatus('Shortcuts saved');
  });
  if (els.shortcutList) {
    els.shortcutList.addEventListener('keydown', event => {
      const input = event.target.closest('[data-shortcut-input]');
      if (!input) return;
      event.preventDefault();
      input.value = eventToShortcut(event);
    });
  }

  document.querySelectorAll('.menu').forEach(menu => {
    const button = menu.querySelector('.menu-btn');
    if (!button) return;
    button.addEventListener('click', event => {
      event.stopPropagation();
      toggleMenu(menu);
    });
    menu.addEventListener('mouseenter', () => {
      const hasOpenMenu = Boolean(document.querySelector('.menu.open'));
      if (hasOpenMenu && !menu.classList.contains('open')) openMenu(menu);
    });
  });

  if (els.canvas) {
    els.canvas.addEventListener('pointerdown', event => {
      if (!buffer) return;
      event.preventDefault();
      dragging = true;
      dragStart = canvasPointToSeconds(event);
      dragStartX = event.clientX;
      dragPointerId = event.pointerId;
      selectionDragMoved = false;
      els.canvas.setPointerCapture(event.pointerId);
    });
    els.canvas.addEventListener('pointermove', event => {
      if (!buffer || !dragging) return;
      if (!selectionDragMoved && Math.abs(event.clientX - dragStartX) < 4) return;
      selectionDragMoved = true;
      els.canvas.classList.add('is-selecting');
      const now = canvasPointToSeconds(event);
      selection = { start: Math.min(dragStart, now), end: Math.max(dragStart, now) };
      updateControls();
      drawWaveform();
      drawOverview();
    });
    els.canvas.addEventListener('pointerup', handleWavePointerUp);
    els.canvas.addEventListener('pointercancel', event => {
      finishWaveDrag(event);
      drawWaveform();
    });
    els.canvas.addEventListener('lostpointercapture', finishWaveDrag);
    els.canvas.addEventListener('wheel', event => {
      if (!buffer) return;
      event.preventDefault();
      const rect = els.canvas.getBoundingClientRect();
      const anchor = visibleStart + ((event.clientX - rect.left) / rect.width) * visibleDuration();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        panViewport((event.deltaX || event.deltaY) * visibleDuration() / Math.max(1, rect.width));
      } else {
        setZoom(event.deltaY < 0 ? zoom * 1.18 : zoom / 1.18, anchor);
      }
    }, { passive: false });
  }

  if (els.overview) {
    els.overview.addEventListener('pointerdown', event => {
      if (!buffer) return;
      event.preventDefault();
      overviewDragging = true;
      els.overview.setPointerCapture(event.pointerId);
      moveViewportFromOverview(event);
    });
    els.overview.addEventListener('pointermove', event => {
      if (!overviewDragging) return;
      moveViewportFromOverview(event);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
      els.overview.addEventListener(type, () => { overviewDragging = false; });
    });
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('.menu')) closeMenus();
    const action = event.target && event.target.dataset ? event.target.dataset.editorAction : '';
    if (!action) return;
    closeMenus();
    const actions = {
      export: exportFile,
      new: newSession,
      newMono: () => newChannelFile(1),
      newStereo: () => newChannelFile(2),
      recordMono: () => { setDesiredChannels(1); startRecording(); },
      recordStereo: () => { setDesiredChannels(2); startRecording(); },
      undo,
      redo,
      copy: copySelection,
      paste: pasteClipboard,
      trim: trimSelection,
      delete: deleteSelection,
      split: splitAtPlayhead,
      normalize,
      fadeIn,
      fadeOut,
      compress: compressVoice,
      limit: limiter,
      noise: noiseGate,
      silence: removeSilence,
      removeSilence,
      insertSilence,
      eq: applyEq,
      showEq,
      marker: () => setStatus(`Marker noted at ${fmtTime(currentPlayhead())}`),
      start: returnToStart,
      clearSelection,
      zoomIn: () => setZoom(zoom * 1.4),
      zoomOut: () => setZoom(zoom / 1.4),
      zoomReset: () => setZoom(1),
      waveCompact: () => setWaveSize('compact'),
      waveNormal: () => setWaveSize('normal'),
      waveLarge: () => setWaveSize('large'),
      showShortcuts,
    };
    if (actions[action]) actions[action]();
  });

  const stage = els.canvas ? els.canvas.parentElement : null;
  if (stage) {
    stage.addEventListener('dragover', event => {
      event.preventDefault();
    });
    stage.addEventListener('drop', event => {
      event.preventDefault();
      const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
      importFile(file);
    });
  }

  window.addEventListener('resize', () => {
    drawWaveform();
    drawOverview();
  });
  document.addEventListener('keydown', handleEditorShortcut);
}

bindEvents();
initMics();
normalizeShortcutDefaults();
restoreWaveSize();
renderShortcuts();
updateEqValues();
updateControls();
drawWaveform();
drawOverview();
