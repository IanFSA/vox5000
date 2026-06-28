'use strict';

const $ = id => document.getElementById(id);

const els = {
  status: $('statusText'),
  mic: $('micSelect'),
  meter: $('inputMeter'),
  meterL: $('meterBarL'),
  meterR: $('meterBarR'),
  file: $('fileInput'),
  project: $('projectInput'),
  newBtn: $('newBtn'),
  record: $('recordBtn'),
  stop: $('stopBtn'),
  play: $('playBtn'),
  rewind: $('rewindBtn'),
  end: $('endBtn'),
  insertSilenceBtn: $('insertSilenceBtn'),
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
  effectModal: $('effectModal'),
  effectKicker: $('effectKicker'),
  effectTitle: $('effectTitle'),
  effectCopy: $('effectCopy'),
  effectFields: $('effectFields'),
  effectPreview: $('effectPreviewBtn'),
  effectPreviewStop: $('effectPreviewStopBtn'),
  effectClose: $('effectCloseBtn'),
  effectCancel: $('effectCancelBtn'),
  effectApply: $('effectApplyBtn'),
  settingsModal: $('settingsModal'),
  settingsClose: $('settingsCloseBtn'),
  settingsSave: $('settingsSaveBtn'),
  settingsReset: $('settingsResetBtn'),
  settingPlaybackScroll: $('settingPlaybackScroll'),
  settingWheelZoom: $('settingWheelZoom'),
  settingWaveColor: $('settingWaveColor'),
  settingViewColor: $('settingViewColor'),
  settingBgColor: $('settingBgColor'),
  settingMarkerColor: $('settingMarkerColor'),
  settingGridColor: $('settingGridColor'),
  settingBitrate: $('settingBitrate'),
  settingSampleRate: $('settingSampleRate'),
  settingZoom: $('settingZoom'),
  settingInputChannels: $('settingInputChannels'),
  settingMonitor: $('settingMonitor'),
  recentModal: $('recentModal'),
  recentClose: $('recentCloseBtn'),
  recentList: $('recentList'),
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
let playEndAt = 0;
let playSelectionActive = false;
let previewNode;
let activeEffectPreview = null;
let rafId;
let scrubNode;
let scrubTimeout = 0;
let arrowScrubTimer = 0;
let arrowScrubDirection = 0;
let arrowScrubStartedAt = 0;
let buffer = null;
let fileName = 'Vox5000';
let selection = null;
let hoverTime = null;
let markers = [];
let selectedMarkerId = null;
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
const SETTINGS_STORAGE_KEY = 'vox5000_editor_settings_v2';
const RECENT_PROJECTS_KEY = 'vox5000_recent_projects_v1';
const MARKER_HIT_SECONDS = 0.08;
const defaultSettings = {
  playbackScroll: 'continuous',
  wheelZoom: true,
  waveColor: '#dfff00',
  viewColor: '#c76bff',
  bgColor: '#030303',
  markerColor: '#ff3b3b',
  gridColor: '#2a2a2a',
  bitrate: '128',
  sampleRate: '48000',
  zoom: 'fit',
  inputChannels: '1',
  monitor: false,
};
const defaultShortcuts = {
  playPause: 'Space',
  record: 'R',
  returnToStart: 'Enter',
  returnToEnd: 'Shift+Enter',
  insertSilence: 'I',
  deleteSelection: 'Delete',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  cutSplit: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  marker: 'M',
};
let shortcuts = loadShortcuts();
let settings = loadSettings();
let meterRafId = 0;
let effectPreviewRefreshTimer = 0;

function ensureAudioContext() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext({ sampleRate: Number(settings.sampleRate || 48000) });
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

function focusEditor() {
  requestAnimationFrame(() => {
    if (els.canvas) els.canvas.focus({ preventScroll: true });
  });
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

function fmtRuler(seconds, span = 60) {
  seconds = Math.max(0, seconds || 0);
  if (span <= 3) return `${seconds.toFixed(2)}s`;
  if (span <= 12) return `${seconds.toFixed(1)}s`;
  return fmtTimeline(seconds);
}

function loadShortcuts() {
  try {
    return { ...defaultShortcuts, ...JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) || '{}') };
  } catch {
    return { ...defaultShortcuts };
  }
}

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function applySettingsToUi() {
  if (els.settingPlaybackScroll) els.settingPlaybackScroll.value = settings.playbackScroll;
  if (els.settingWheelZoom) els.settingWheelZoom.checked = Boolean(settings.wheelZoom);
  if (els.settingWaveColor) els.settingWaveColor.value = settings.waveColor;
  if (els.settingViewColor) els.settingViewColor.value = settings.viewColor;
  if (els.settingBgColor) els.settingBgColor.value = settings.bgColor;
  if (els.settingMarkerColor) els.settingMarkerColor.value = settings.markerColor;
  if (els.settingGridColor) els.settingGridColor.value = settings.gridColor;
  if (els.settingBitrate) els.settingBitrate.value = settings.bitrate;
  if (els.settingSampleRate) els.settingSampleRate.value = settings.sampleRate;
  if (els.settingZoom) els.settingZoom.value = settings.zoom;
  if (els.settingInputChannels) els.settingInputChannels.value = settings.inputChannels;
  if (els.settingMonitor) els.settingMonitor.checked = Boolean(settings.monitor);
  desiredChannels = Number(settings.inputChannels || desiredChannels || 1);
  if (els.exportFormat && settings.bitrate) els.exportFormat.value = `mp3:${settings.bitrate}`;
}

function readSettingsFromUi() {
  settings = {
    playbackScroll: els.settingPlaybackScroll ? els.settingPlaybackScroll.value : defaultSettings.playbackScroll,
    wheelZoom: els.settingWheelZoom ? els.settingWheelZoom.checked : true,
    waveColor: els.settingWaveColor ? els.settingWaveColor.value : defaultSettings.waveColor,
    viewColor: els.settingViewColor ? els.settingViewColor.value : defaultSettings.viewColor,
    bgColor: els.settingBgColor ? els.settingBgColor.value : defaultSettings.bgColor,
    markerColor: els.settingMarkerColor ? els.settingMarkerColor.value : defaultSettings.markerColor,
    gridColor: els.settingGridColor ? els.settingGridColor.value : defaultSettings.gridColor,
    bitrate: els.settingBitrate ? els.settingBitrate.value : defaultSettings.bitrate,
    sampleRate: els.settingSampleRate ? els.settingSampleRate.value : defaultSettings.sampleRate,
    zoom: els.settingZoom ? els.settingZoom.value : defaultSettings.zoom,
    inputChannels: els.settingInputChannels ? els.settingInputChannels.value : defaultSettings.inputChannels,
    monitor: els.settingMonitor ? els.settingMonitor.checked : false,
  };
}

function showSettings() {
  applySettingsToUi();
  if (els.settingsModal) els.settingsModal.hidden = false;
}

function closeSettings() {
  if (els.settingsModal) els.settingsModal.hidden = true;
}

function saveSettingsFromModal() {
  readSettingsFromUi();
  saveSettings();
  applySettingsToUi();
  updateMeterMode();
  drawWaveform();
  drawOverview();
  closeSettings();
  setStatus('Recorder settings saved');
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

function cloneSelection(value) {
  return value ? { start: value.start, end: value.end } : null;
}

function cloneMarkers(value = markers) {
  return value.map(marker => ({ id: marker.id, time: marker.time }));
}

function captureProjectState() {
  return {
    buffer: buffer ? cloneBuffer(buffer) : null,
    fileName,
    selection: cloneSelection(selection),
    markers: cloneMarkers(),
    selectedMarkerId,
    playOffset,
    visibleStart,
    zoom,
    desiredChannels,
  };
}

function restoreProjectState(state) {
  stopPlayback();
  buffer = state.buffer ? cloneBuffer(state.buffer) : null;
  fileName = state.fileName || 'Vox5000';
  selection = cloneSelection(state.selection);
  markers = cloneMarkers(state.markers || []);
  selectedMarkerId = state.selectedMarkerId || null;
  playOffset = state.playOffset || 0;
  visibleStart = state.visibleStart || 0;
  zoom = state.zoom || 1;
  desiredChannels = state.desiredChannels || (buffer && buffer.numberOfChannels > 1 ? 2 : 1);
  hoverTime = null;
  updateControls();
  drawWaveform();
  drawOverview();
}

function createBlankBuffer(channels) {
  const ctx = ensureAudioContext();
  return ctx.createBuffer(channels, ctx.sampleRate, ctx.sampleRate);
}

function channelPeak(src, channel) {
  const data = src.getChannelData(channel);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

function normalizeRecordedBuffer(src) {
  if (!src || src.numberOfChannels < 2) return src;
  const leftPeak = channelPeak(src, 0);
  const rightPeak = channelPeak(src, 1);
  if (leftPeak > 0.002 && rightPeak < leftPeak * 0.08) {
    const ctx = ensureAudioContext();
    const out = ctx.createBuffer(1, src.length, src.sampleRate);
    out.copyToChannel(src.getChannelData(0), 0);
    return out;
  }
  if (rightPeak > 0.002 && leftPeak < rightPeak * 0.08) {
    const ctx = ensureAudioContext();
    const out = ctx.createBuffer(1, src.length, src.sampleRate);
    out.copyToChannel(src.getChannelData(1), 0);
    return out;
  }
  return src;
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
  undoStack.push(captureProjectState());
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
}

function setBuffer(next, name) {
  buffer = next;
  fileName = name || fileName || 'Vox5000';
  selection = null;
  hoverTime = null;
  markers = [];
  selectedMarkerId = null;
  playOffset = 0;
  playEndAt = 0;
  playSelectionActive = false;
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
  const isRecording = Boolean(recorder && recorder.state === 'recording');
  const isPlaying = Boolean(sourceNode);
  [els.play, els.rewind, els.end, els.insertSilenceBtn, els.trim, els.del, els.split, els.fadeIn, els.fadeOut, els.normalize, els.compress, els.noise, els.silence, els.eq, els.eqOpen, els.export].forEach(btn => {
    if (btn) btn.disabled = !hasAudio;
  });
  if (els.stop) els.stop.disabled = !(isRecording || isPlaying);
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
  if (els.selectionStart) els.selectionStart.textContent = hasSelection ? fmtTime(selection.start) : (hoverTime !== null ? fmtTime(hoverTime) : '--:--.---');
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
  canvasCtx.fillStyle = settings.bgColor || '#030303';
  canvasCtx.fillRect(0, 0, w, h);

  canvasCtx.strokeStyle = settings.gridColor || 'rgba(255,255,255,0.08)';
  canvasCtx.globalAlpha = 0.35;
  canvasCtx.lineWidth = 1;
  for (let i = 0; i <= 12; i++) {
    const x = (i / 12) * w;
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, 0);
    canvasCtx.lineTo(x, h);
    canvasCtx.stroke();
  }
  canvasCtx.globalAlpha = 1;

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
    updateControls();
    const blob = new Blob(recordChunks, { type: 'audio/webm' });
    const decoded = normalizeRecordedBuffer(await ctx.decodeAudioData(await blob.arrayBuffer()));
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
  updateControls();
  setStatus('Recording');
  startRecordingPreview();
  timerId = setInterval(() => {
    if (els.time) els.time.textContent = fmtTime((Date.now() - recordStartedAt) / 1000);
  }, 80);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function stopTransport() {
  if (recorder && recorder.state === 'recording') {
    stopRecording();
    return;
  }
  stopPlayback();
  updateControls();
  drawWaveform();
  drawOverview();
}

async function importFile(file) {
  if (!file) return;
  const ctx = ensureAudioContext();
  setStatus('Decoding import');
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buffer) pushUndo();
  setBuffer(decoded, file.name.replace(/\.[^.]+$/, '') || 'Vox5000_import');
  if (els.file) els.file.value = '';
  focusEditor();
  setStatus('Imported audio');
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlToArrayBuffer(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function buildProjectPayload() {
  if (!buffer) return null;
  const wavBlob = encodeWav(buffer);
  return {
    version: 1,
    app: 'VOX5000',
    savedAt: new Date().toISOString(),
    fileName,
    audio: await blobToDataUrl(wavBlob),
    markers: cloneMarkers(),
    selection: cloneSelection(selection),
    playOffset,
    visibleStart,
    zoom,
    desiredChannels,
    settings,
  };
}

async function saveProject() {
  if (!buffer) return;
  setStatus('Saving project');
  const payload = await buildProjectPayload();
  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/vnd.vox5000.project+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName || 'Vox5000'}.vox5000`;
  a.click();
  URL.revokeObjectURL(url);
  cacheRecentProject(payload, json);
  setStatus('Project saved');
}

function cacheRecentProject(payload, json) {
  if (json.length > 3500000) return;
  const recent = loadRecentProjects().filter(item => item.name !== payload.fileName);
  recent.unshift({ name: payload.fileName, savedAt: payload.savedAt, json });
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent.slice(0, 5)));
}

function loadRecentProjects() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) || '[]');
  } catch {
    return [];
  }
}

async function openProjectFile(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    await loadProjectPayload(payload);
    if (els.project) els.project.value = '';
    focusEditor();
    setStatus('Project opened');
  } catch (err) {
    setStatus('Could not open project file');
  }
}

async function loadProjectPayload(payload) {
  const ctx = ensureAudioContext();
  const decoded = await ctx.decodeAudioData(dataUrlToArrayBuffer(payload.audio));
  buffer = decoded;
  fileName = payload.fileName || 'Vox5000_project';
  selection = cloneSelection(payload.selection);
  markers = cloneMarkers(payload.markers || []);
  selectedMarkerId = null;
  playOffset = payload.playOffset || 0;
  visibleStart = payload.visibleStart || 0;
  zoom = payload.zoom || 1;
  desiredChannels = payload.desiredChannels || (decoded.numberOfChannels > 1 ? 2 : 1);
  if (payload.settings) {
    settings = { ...defaultSettings, ...payload.settings };
    saveSettings();
    applySettingsToUi();
  }
  undoStack = [];
  redoStack = [];
  updateControls();
  drawWaveform();
  drawOverview();
}

function showRecentProjects() {
  if (!els.recentModal || !els.recentList) return;
  const recent = loadRecentProjects();
  els.recentList.innerHTML = '';
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No recent projects cached in this browser yet.';
    els.recentList.appendChild(empty);
  }
  recent.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<span>${item.name}</span><small>${new Date(item.savedAt).toLocaleString()}</small>`;
    button.addEventListener('click', async () => {
      await loadProjectPayload(JSON.parse(item.json));
      closeRecentProjects();
      setStatus('Recent project opened');
    });
    els.recentList.appendChild(button);
  });
  els.recentModal.hidden = false;
}

function closeRecentProjects() {
  if (els.recentModal) els.recentModal.hidden = true;
}

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode.disconnect();
    sourceNode = null;
  }
  playEndAt = 0;
  playSelectionActive = false;
  cancelAnimationFrame(rafId);
  if (els.play) els.play.textContent = '▶';
  updateControls();
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

function returnToEnd() {
  if (!buffer) return;
  playOffset = buffer.duration;
  visibleStart = Math.max(0, buffer.duration - visibleDuration());
  stopPlayback();
  if (els.time) els.time.textContent = fmtTime(playOffset);
  drawWaveform();
  drawOverview();
  setStatus('Moved to end');
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
    playOffset = Math.min(playEndAt || buffer.duration, playOffset + (ensureAudioContext().currentTime - playStartedAt));
    stopPlayback();
    drawWaveform();
    return;
  }
  const ctx = ensureAudioContext();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.connect(ctx.destination);
  const selected = selection && selection.end > selection.start;
  const startAt = selected ? selection.start : (playOffset >= buffer.duration ? 0 : playOffset);
  const endAt = selected ? selection.end : buffer.duration;
  playOffset = startAt;
  playEndAt = endAt;
  playSelectionActive = Boolean(selected);
  playStartedAt = ctx.currentTime;
  sourceNode.start(0, startAt, Math.max(0.01, endAt - startAt));
  sourceNode.onended = () => {
    playOffset = startAt;
    stopPlayback();
    if (els.time) els.time.textContent = fmtTime(playOffset);
    drawWaveform();
  };
  if (els.play) els.play.textContent = 'Ⅱ';
  updateControls();
  animatePlayhead();
}

function currentPlayhead() {
  if (!sourceNode) return playOffset;
  return Math.min(playEndAt || (buffer ? buffer.duration : 0), playOffset + (ensureAudioContext().currentTime - playStartedAt));
}

function stopScrubPreview() {
  clearTimeout(scrubTimeout);
  if (!scrubNode) return;
  try { scrubNode.stop(); } catch {}
  try { scrubNode.disconnect(); } catch {}
  scrubNode = null;
}

function playScrubPreview() {
  if (!buffer) return;
  stopScrubPreview();
  const ctx = ensureAudioContext();
  scrubNode = ctx.createBufferSource();
  scrubNode.buffer = buffer;
  scrubNode.connect(ctx.destination);
  const start = Math.max(0, Math.min(buffer.duration - 0.02, playOffset));
  const duration = Math.min(0.12, Math.max(0.02, buffer.duration - start));
  scrubNode.start(0, start, duration);
  scrubNode.onended = () => { scrubNode = null; };
  scrubTimeout = setTimeout(stopScrubPreview, 160);
}

function nudgePlayhead(direction, event) {
  if (!buffer) return;
  const step = event.shiftKey ? 1 : event.altKey ? 0.01 : 0.1;
  if (sourceNode) stopPlayback();
  playOffset = Math.max(0, Math.min(buffer.duration, playOffset + direction * step));
  if (els.time) els.time.textContent = fmtTime(playOffset);
  if (settings.playbackScroll === 'continuous') {
    if (playOffset < visibleStart || playOffset > visibleStart + visibleDuration()) {
      visibleStart = Math.max(0, playOffset - visibleDuration() / 2);
      clampVisibleStart();
    }
  }
  drawWaveform();
  drawOverview();
  playScrubPreview();
}

function startArrowScrub(direction, event) {
  if (!buffer) return;
  if (arrowScrubTimer && arrowScrubDirection === direction) return;
  stopArrowScrub();
  arrowScrubDirection = direction;
  arrowScrubStartedAt = Date.now();
  nudgePlayhead(direction, event);
  arrowScrubTimer = window.setInterval(() => {
    const held = Math.min(3, (Date.now() - arrowScrubStartedAt) / 900);
    const base = event.shiftKey ? 0.08 : event.altKey ? 0.006 : 0.025;
    if (sourceNode) stopPlayback();
    playOffset = Math.max(0, Math.min(buffer.duration, playOffset + direction * base * (1 + held)));
    if (els.time) els.time.textContent = fmtTime(playOffset);
    if (settings.playbackScroll === 'continuous' && (playOffset < visibleStart || playOffset > visibleStart + visibleDuration())) {
      visibleStart = Math.max(0, playOffset - visibleDuration() / 2);
      clampVisibleStart();
    }
    drawWaveform();
    drawOverview();
    playScrubPreview();
  }, 33);
}

function stopArrowScrub() {
  if (arrowScrubTimer) clearInterval(arrowScrubTimer);
  arrowScrubTimer = 0;
  arrowScrubDirection = 0;
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
  const keptMarkers = markers
    .filter(marker => marker.time >= selection.start && marker.time <= selection.end)
    .map(marker => ({ ...marker, time: marker.time - selection.start }));
  setBuffer(copyRange(buffer, range.start, range.end), fileName);
  markers = keptMarkers;
  setStatus('Trimmed to selection');
  drawWaveform();
  drawOverview();
}

function deleteSelection() {
  const range = selectionSamples();
  if (!range) return;
  pushUndo();
  const deletedDuration = selection.end - selection.start;
  const keptMarkers = markers
    .filter(marker => marker.time < selection.start || marker.time > selection.end)
    .map(marker => marker.time > selection.end ? { ...marker, time: marker.time - deletedDuration } : marker);
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
  markers = keptMarkers;
  selectedMarkerId = null;
  setStatus('Deleted selection');
  drawWaveform();
  drawOverview();
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
  const insertSeconds = playOffset;
  const clipDuration = clipboardBuffer.duration;
  const keptMarkers = markers.map(marker => marker.time >= insertSeconds ? { ...marker, time: marker.time + clipDuration } : marker);
  insertBufferAtPlayhead(clipboardBuffer, keptMarkers, 'Pasted audio');
}

function insertBufferAtPlayhead(incomingBuffer, markerState, label = 'Pasted audio') {
  if (!buffer || !incomingBuffer) return;
  const ctx = ensureAudioContext();
  const insertAt = secondsToSamples(playOffset);
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length + incomingBuffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const clip = incomingBuffer.getChannelData(Math.min(ch, incomingBuffer.numberOfChannels - 1));
    const dst = out.getChannelData(ch);
    dst.set(src.slice(0, insertAt), 0);
    dst.set(clip, insertAt);
    dst.set(src.slice(insertAt), insertAt + incomingBuffer.length);
  }
  setBuffer(out, fileName);
  if (markerState) markers = markerState;
  playOffset = samplesToSeconds(insertAt + incomingBuffer.length);
  setStatus(label);
  drawWaveform();
  drawOverview();
}

async function pasteExternalAudio(event) {
  if (!buffer || isTypingTarget(event.target)) return;
  const items = event.clipboardData ? Array.from(event.clipboardData.items || []) : [];
  const fileItem = items.find(item => item.kind === 'file' && item.type.startsWith('audio/'));
  if (!fileItem) return;
  event.preventDefault();
  const file = fileItem.getAsFile();
  if (!file) return;
  const ctx = ensureAudioContext();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  pushUndo();
  const insertSeconds = playOffset;
  const keptMarkers = markers.map(marker => marker.time >= insertSeconds ? { ...marker, time: marker.time + decoded.duration } : marker);
  insertBufferAtPlayhead(decoded, keptMarkers, 'Pasted external audio');
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

function addMarker() {
  if (!buffer) return;
  pushUndo();
  const time = Math.max(0, Math.min(buffer.duration, currentPlayhead()));
  const id = Date.now();
  markers.push({ id, time });
  selectedMarkerId = id;
  markers.sort((a, b) => a.time - b.time);
  drawWaveform();
  drawOverview();
  setStatus(`Marker added at ${fmtTime(time)}`);
}

function processSamples(label, fn) {
  if (!buffer) return;
  pushUndo();
  const out = cloneBuffer(buffer);
  const keptMarkers = markers.slice();
  const range = selectionSamples() || { start: 0, end: out.length };
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    fn(out.getChannelData(ch), range.start, range.end, out.sampleRate);
  }
  setBuffer(out, fileName);
  markers = keptMarkers.filter(marker => marker.time <= (buffer ? buffer.duration : 0));
  drawWaveform();
  drawOverview();
  setStatus(label);
}

function dbToGain(db) {
  return Math.pow(10, Number(db || 0) / 20);
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

function openEffectDialog(config) {
  if (!els.effectModal || !els.effectFields || !els.effectApply) return;
  stopEffectPreview();
  activeEffectPreview = { previewing: false, values: null, config };
  const refreshPreview = () => {
    if (!activeEffectPreview || !activeEffectPreview.previewing || !config.preview) return;
    clearTimeout(effectPreviewRefreshTimer);
    effectPreviewRefreshTimer = setTimeout(() => config.preview(values), 90);
  };
  if (els.effectKicker) els.effectKicker.textContent = config.kicker || 'Audio';
  if (els.effectTitle) els.effectTitle.textContent = config.title || 'Audio effect';
  if (els.effectCopy) els.effectCopy.textContent = config.copy || '';
  els.effectFields.innerHTML = '';
  const values = {};
  (config.fields || []).forEach(field => {
    values[field.name] = field.value;
    const row = document.createElement('label');
    row.className = 'effect-row';
    const name = document.createElement('span');
    name.textContent = field.label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = field.min;
    slider.max = field.max;
    slider.step = field.step || 1;
    slider.value = field.value;
    const number = document.createElement('input');
    number.type = 'number';
    number.min = field.min;
    number.max = field.max;
    number.step = field.step || 1;
    number.value = field.value;
    const sync = value => {
      values[field.name] = Number(value);
      slider.value = value;
      number.value = value;
      refreshPreview();
    };
    slider.addEventListener('input', () => sync(slider.value));
    number.addEventListener('input', () => sync(number.value));
    slider.addEventListener('dblclick', event => {
      event.preventDefault();
      sync(field.value);
    });
    number.addEventListener('dblclick', event => {
      event.preventDefault();
      sync(field.value);
    });
    row.append(name, slider, number);
    els.effectFields.appendChild(row);
  });
  els.effectApply.onclick = () => {
    stopEffectPreview();
    config.apply(values);
    closeEffectDialog();
  };
  if (els.effectPreview) {
    els.effectPreview.onclick = () => {
      activeEffectPreview.previewing = true;
      activeEffectPreview.values = values;
      if (config.preview) config.preview(values);
      else setStatus('Preview is not available for this effect');
    };
  }
  if (els.effectPreviewStop) els.effectPreviewStop.onclick = () => {
    stopEffectPreview();
  };
  activeEffectPreview.values = values;
  els.effectModal.hidden = false;
}

function closeEffectDialog() {
  stopEffectPreview();
  activeEffectPreview = null;
  if (els.effectModal) els.effectModal.hidden = true;
  if (els.effectApply) els.effectApply.onclick = null;
  if (els.effectPreview) els.effectPreview.onclick = null;
  if (els.effectPreviewStop) els.effectPreviewStop.onclick = null;
}

function stopEffectPreview() {
  clearTimeout(effectPreviewRefreshTimer);
  if (activeEffectPreview) activeEffectPreview.previewing = false;
  if (previewNode) {
    try { previewNode.onended = null; } catch {}
    try { previewNode.stop(0); } catch {}
    try { previewNode.disconnect(); } catch {}
  }
  previewNode = null;
}

function previewProcessedBuffer(makeBuffer) {
  if (!buffer) return;
  stopEffectPreview();
  const ctx = ensureAudioContext();
  const previewBuffer = makeBuffer();
  previewNode = ctx.createBufferSource();
  previewNode.buffer = previewBuffer;
  previewNode.connect(ctx.destination);
  const range = selection && selection.end > selection.start ? selection : { start: 0, end: previewBuffer.duration };
  previewNode.loop = true;
  previewNode.loopStart = range.start;
  previewNode.loopEnd = Math.max(range.start + 0.01, range.end);
  previewNode.start(0, range.start);
  previewNode.onended = () => { previewNode = null; };
  setStatus('Previewing effect');
}

function processedClone(fn) {
  const out = cloneBuffer(buffer);
  const range = selectionSamples() || { start: 0, end: out.length };
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    fn(out.getChannelData(ch), range.start, range.end, out.sampleRate, ch);
  }
  return out;
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

function reverseAudio() {
  if (!buffer) return;
  processSamples(selection && selection.end > selection.start ? 'Selection reversed' : 'Audio reversed', (data, start, end) => {
    let left = start;
    let right = end - 1;
    while (left < right) {
      const tmp = data[left];
      data[left] = data[right];
      data[right] = tmp;
      left += 1;
      right -= 1;
    }
  });
}

function invertSignalPolarity() {
  if (!buffer) return;
  processSamples('Signal polarity inverted', (data, start, end) => {
    for (let i = start; i < end; i++) data[i] = -data[i];
  });
}

function swapChannels() {
  if (!buffer || buffer.numberOfChannels < 2) {
    setStatus('Swap channels needs stereo audio');
    return;
  }
  pushUndo();
  const left = new Float32Array(buffer.getChannelData(0));
  buffer.copyToChannel(buffer.getChannelData(1), 0);
  buffer.copyToChannel(left, 1);
  drawWaveform();
  drawOverview();
  setStatus('Left and right channels swapped');
}

function dcOffset() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'DC Offset',
    copy: 'Move the waveform centre slightly up or down. Most voice edits should leave this at 0.',
    fields: [{ name: 'offset', label: 'Offset', min: -0.5, max: 0.5, step: 0.01, value: 0 }],
    apply: values => processSamples('DC offset applied', (data, start, end) => {
      for (let i = start; i < end; i++) data[i] = clampSample(data[i] + values.offset);
    }),
    preview: values => previewProcessedBuffer(() => processedClone((data, start, end) => {
      for (let i = start; i < end; i++) data[i] = clampSample(data[i] + values.offset);
    })),
  });
}

function delayEcho() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Delay / Echo',
    copy: 'Add a short repeat behind the selected audio or the whole file.',
    fields: [
      { name: 'delayMs', label: 'Delay ms', min: 40, max: 900, step: 10, value: 180 },
      { name: 'feedback', label: 'Feedback %', min: 0, max: 80, step: 1, value: 25 },
      { name: 'mix', label: 'Wet mix %', min: 0, max: 80, step: 1, value: 20 },
    ],
    apply: values => processSamples('Delay / echo applied', (data, start, end, sampleRate) => delayData(data, start, end, sampleRate, values)),
    preview: values => previewProcessedBuffer(() => processedClone((data, start, end, sampleRate) => delayData(data, start, end, sampleRate, values))),
  });
}

function delayData(data, start, end, sampleRate, values) {
  const delay = Math.max(1, Math.round(sampleRate * values.delayMs / 1000));
  const feedback = values.feedback / 100;
  const mix = values.mix / 100;
  for (let i = start + delay; i < end; i++) {
    const echo = data[i - delay] * feedback;
    data[i] = clampSample(data[i] * (1 - mix) + echo * mix);
  }
}

function reverb() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Reverb',
    copy: 'Add a simple room tail. Keep it subtle for spoken voice.',
    fields: [
      { name: 'room', label: 'Room size %', min: 5, max: 95, step: 1, value: 28 },
      { name: 'mix', label: 'Wet mix %', min: 0, max: 70, step: 1, value: 12 },
    ],
    apply: values => processSamples('Reverb applied', (data, start, end, sampleRate) => reverbData(data, start, end, sampleRate, values)),
    preview: values => previewProcessedBuffer(() => processedClone((data, start, end, sampleRate) => reverbData(data, start, end, sampleRate, values))),
  });
}

function reverbData(data, start, end, sampleRate, values) {
  const mix = values.mix / 100;
  const room = values.room / 100;
  const taps = [0.029, 0.037, 0.041, 0.053].map(t => Math.round(t * sampleRate * (0.5 + room)));
  for (let i = start; i < end; i++) {
    let wet = 0;
    taps.forEach((tap, index) => {
      if (i - tap >= start) wet += data[i - tap] * (0.32 / (index + 1));
    });
    data[i] = clampSample(data[i] * (1 - mix) + wet * mix);
  }
}

function pitchTempo() {
  setStatus('Pitch / tempo dialog is planned for the next audio-engine pass');
}

function highPass() {
  filterDialog('High Pass Filter', 'Reduce low rumble below the cutoff frequency.', true);
}

function lowPass() {
  filterDialog('Low Pass Filter', 'Reduce harsh high frequencies above the cutoff frequency.', false);
}

function filterDialog(title, copy, high) {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title,
    copy,
    fields: [{ name: 'frequency', label: 'Cutoff Hz', min: 40, max: 12000, step: 10, value: high ? 90 : 9000 }],
    apply: values => processSamples(`${title} applied`, (data, start, end, sampleRate) => onePoleFilter(data, start, end, sampleRate, values.frequency, high)),
    preview: values => previewProcessedBuffer(() => processedClone((data, start, end, sampleRate) => onePoleFilter(data, start, end, sampleRate, values.frequency, high))),
  });
}

function onePoleFilter(data, start, end, sampleRate, frequency, high) {
  const rc = 1 / (2 * Math.PI * Math.max(20, frequency));
  const dt = 1 / sampleRate;
  const alpha = high ? rc / (rc + dt) : dt / (rc + dt);
  let y = data[start] || 0;
  let lastX = y;
  for (let i = start; i < end; i++) {
    const x = data[i];
    if (high) {
      y = alpha * (y + x - lastX);
      lastX = x;
    } else {
      y = y + alpha * (x - y);
    }
    data[i] = y;
  }
}

function mixDownToMono() {
  if (!buffer) return;
  if (buffer.numberOfChannels === 1) {
    setStatus('Already mono');
    return;
  }
  pushUndo();
  const ctx = ensureAudioContext();
  const out = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
  const dst = out.getChannelData(0);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) dst[i] += src[i] / buffer.numberOfChannels;
  }
  const keptMarkers = cloneMarkers();
  const keptSelection = cloneSelection(selection);
  setBuffer(out, fileName);
  markers = keptMarkers;
  selection = keptSelection;
  drawWaveform();
  drawOverview();
  setStatus('Mixed down to mono');
}

function mixDownToStereo() {
  if (!buffer) return;
  if (buffer.numberOfChannels === 2) {
    setStatus('Already stereo');
    return;
  }
  pushUndo();
  const ctx = ensureAudioContext();
  const out = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  const mono = buffer.getChannelData(0);
  out.copyToChannel(mono, 0);
  out.copyToChannel(mono, 1);
  const keptMarkers = cloneMarkers();
  const keptSelection = cloneSelection(selection);
  setBuffer(out, fileName);
  markers = keptMarkers;
  selection = keptSelection;
  drawWaveform();
  drawOverview();
  setStatus('Mixed down to stereo');
}

function normalize() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Normalize',
    copy: 'Set the loudest point of the selection, or the whole file, to a target peak level.',
    fields: [{ name: 'targetDb', label: 'Target peak dB', min: -24, max: 0, step: 0.5, value: -1 }],
    apply: values => applyNormalize(values.targetDb),
    preview: values => previewProcessedBuffer(() => {
      const range = selectionSamples() || { start: 0, end: buffer.length };
      let peak = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = range.start; i < range.end; i++) peak = Math.max(peak, Math.abs(data[i]));
      }
      const gain = peak ? dbToGain(values.targetDb) / peak : 1;
      return processedClone((data, start, end) => {
        for (let i = start; i < end; i++) data[i] = clampSample(data[i] * gain);
      });
    }),
  });
}

function applyNormalize(targetDb) {
  if (!buffer) return;
  const range = selectionSamples() || { start: 0, end: buffer.length };
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = range.start; i < range.end; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (!peak) {
    setStatus('Nothing to normalize');
    return;
  }
  const gain = dbToGain(targetDb) / peak;
  processSamples(`Normalized to ${targetDb} dB`, (data, start, end) => {
    for (let i = start; i < end; i++) data[i] = clampSample(data[i] * gain);
  });
}

function amplifyVolume() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Amplify volume',
    copy: 'Move below 0 dB to make the audio softer, or above 0 dB to make it louder.',
    fields: [{ name: 'gainDb', label: 'Gain dB', min: -24, max: 24, step: 0.5, value: 0 }],
    apply: values => {
      const gain = dbToGain(values.gainDb);
      processSamples(`Amplified ${values.gainDb > 0 ? '+' : ''}${values.gainDb} dB`, (data, start, end) => {
        for (let i = start; i < end; i++) data[i] = clampSample(data[i] * gain);
      });
    },
    preview: values => previewProcessedBuffer(() => {
      const gain = dbToGain(values.gainDb);
      return processedClone((data, start, end) => {
        for (let i = start; i < end; i++) data[i] = clampSample(data[i] * gain);
      });
    }),
  });
}

function compressVoice() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Compressor',
    copy: 'Control loud peaks without crushing the track. Start gently, then adjust threshold and ratio.',
    fields: [
      { name: 'thresholdDb', label: 'Threshold dB', min: -60, max: 0, step: 1, value: -18 },
      { name: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, value: 4 },
      { name: 'attackMs', label: 'Attack ms', min: 0, max: 100, step: 1, value: 8 },
      { name: 'releaseMs', label: 'Release ms', min: 20, max: 1000, step: 10, value: 220 },
      { name: 'makeupDb', label: 'Post gain dB', min: -12, max: 24, step: 0.5, value: 0 },
    ],
    apply: values => applyCompressor(values),
    preview: values => previewProcessedBuffer(() => processedClone((data, start, end) => compressData(data, start, end, values))),
  });
}

function compressData(data, start, end, values) {
  const threshold = dbToGain(values.thresholdDb);
  const ratio = Math.max(1, Number(values.ratio || 1));
  const makeup = dbToGain(values.makeupDb);
  let envelope = 0;
  const attack = Math.exp(-1 / Math.max(1, values.attackMs * 48));
  const release = Math.exp(-1 / Math.max(1, values.releaseMs * 48));
  for (let i = start; i < end; i++) {
    const abs = Math.abs(data[i]);
    envelope = abs > envelope
      ? attack * envelope + (1 - attack) * abs
      : release * envelope + (1 - release) * abs;
    let gain = 1;
    if (envelope > threshold) {
      const compressed = threshold + (envelope - threshold) / ratio;
      gain = compressed / Math.max(envelope, 0.000001);
    }
    data[i] = clampSample(data[i] * gain * makeup);
  }
}

function applyCompressor(values) {
  processSamples('Compressor applied', (data, start, end) => compressData(data, start, end, values));
}

function noiseGate() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Noise gate',
    copy: 'Reduce low-level room noise between words. Use a lower threshold if it cuts off speech.',
    fields: [
      { name: 'thresholdDb', label: 'Threshold dB', min: -80, max: -5, step: 1, value: -35 },
      { name: 'reductionDb', label: 'Reduction dB', min: -80, max: 0, step: 1, value: -80 },
      { name: 'attackMs', label: 'Attack ms', min: 0, max: 100, step: 1, value: 5 },
      { name: 'releaseMs', label: 'Release ms', min: 20, max: 1000, step: 10, value: 160 },
    ],
    apply: values => processSamples('Noise gate applied', (data, start, end) => gateData(data, start, end, values)),
    preview: values => previewProcessedBuffer(() => processedClone((data, start, end) => gateData(data, start, end, values))),
  });
}

function gateData(data, start, end, values) {
  const threshold = dbToGain(values.thresholdDb);
  const reduction = dbToGain(values.reductionDb);
  const attack = Math.exp(-1 / Math.max(1, values.attackMs * 48));
  const release = Math.exp(-1 / Math.max(1, values.releaseMs * 48));
  let gain = 1;
  for (let i = start; i < end; i++) {
    const target = Math.abs(data[i]) >= threshold ? 1 : reduction;
    gain = target > gain
      ? attack * gain + (1 - attack) * target
      : release * gain + (1 - release) * target;
    data[i] *= gain;
  }
}

function removeSilence() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Filter',
    title: 'Remove silence',
    copy: 'Remove quiet sections below the threshold, with a little padding kept around speech.',
    fields: [
      { name: 'thresholdDb', label: 'Threshold dB', min: -80, max: -5, step: 1, value: -45 },
      { name: 'minSilenceMs', label: 'Minimum silence ms', min: 50, max: 2000, step: 10, value: 250 },
      { name: 'paddingMs', label: 'Padding ms', min: 0, max: 500, step: 10, value: 80 },
    ],
    apply: values => applyRemoveSilence(values),
  });
}

function applyRemoveSilence(values) {
  if (!buffer) return;
  const keptMarkers = markers.slice();
  const threshold = dbToGain(values.thresholdDb);
  const frame = 512;
  const minSilentFrames = Math.max(1, Math.round((values.minSilenceMs / 1000) * buffer.sampleRate / frame));
  const padding = Math.round((values.paddingMs / 1000) * buffer.sampleRate);
  const voiced = [];
  for (let i = 0; i < buffer.length; i += frame) {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let j = i; j < Math.min(i + frame, buffer.length); j++) peak = Math.max(peak, Math.abs(data[j]));
    }
    voiced.push(peak >= threshold);
  }
  const keep = [];
  let silentRun = 0;
  for (let idx = 0; idx < voiced.length; idx++) {
    if (!voiced[idx]) {
      silentRun += 1;
      if (silentRun >= minSilentFrames) continue;
    } else {
      silentRun = 0;
    }
    const start = Math.max(0, idx * frame - padding);
    const end = Math.min(buffer.length, (idx + 1) * frame + padding);
    if (keep.length && start <= keep[keep.length - 1][1]) keep[keep.length - 1][1] = Math.max(keep[keep.length - 1][1], end);
    else keep.push([start, end]);
  }
  if (!keep.length) {
    setStatus('No audio found above silence threshold');
    return;
  }
  pushUndo();
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
  markers = keptMarkers.filter(marker => marker.time <= out.duration);
  drawWaveform();
  drawOverview();
  setStatus('Silence removed');
}

function insertSilence() {
  if (!buffer) return;
  openEffectDialog({
    kicker: 'Insert',
    title: 'Insert silence',
    copy: 'Insert silence at the playhead. Click the waveform first to choose the position.',
    fields: [{ name: 'duration', label: 'Duration seconds', min: 0.1, max: 30, step: 0.1, value: 1 }],
    apply: values => applyInsertSilence(values.duration),
  });
}

function applyInsertSilence(duration) {
  if (!buffer) return;
  pushUndo();
  const ctx = ensureAudioContext();
  const keptMarkers = markers.slice();
  const insertAt = secondsToSamples(playOffset);
  const silenceLength = Math.max(1, Math.round(buffer.sampleRate * Number(duration || 1)));
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length + silenceLength, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.slice(0, insertAt), 0);
    dst.set(src.slice(insertAt), insertAt + silenceLength);
  }
  setBuffer(out, fileName);
  markers = keptMarkers.map(marker => marker.time >= samplesToSeconds(insertAt)
    ? { ...marker, time: marker.time + samplesToSeconds(silenceLength) }
    : marker);
  playOffset = samplesToSeconds(insertAt + silenceLength);
  drawWaveform();
  drawOverview();
  setStatus(`Inserted ${Number(duration || 1).toFixed(1)} seconds of silence`);
}

async function applyEq() {
  if (!buffer) return;
  pushUndo();
  const keptMarkers = cloneMarkers();
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
  markers = keptMarkers;
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
  redoStack.push(captureProjectState());
  restoreProjectState(undoStack.pop());
  setStatus('Undo');
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(captureProjectState());
  restoreProjectState(redoStack.pop());
  setStatus('Redo');
}

function canvasPointToSeconds(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  return buffer ? Math.min(buffer.duration, visibleStart + (x / rect.width) * visibleDuration()) : 0;
}

function rawCanvasPointToSeconds(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  return buffer ? Math.min(buffer.duration, visibleStart + (x / rect.width) * visibleDuration()) : 0;
}

function markerAtEvent(event) {
  if (!buffer || !markers.length) return null;
  const seconds = rawCanvasPointToSeconds(event);
  const snap = Math.max(MARKER_HIT_SECONDS, visibleDuration() * 0.008);
  return markers.find(marker => Math.abs(marker.time - seconds) <= snap) || null;
}

function deleteSelectedMarker() {
  if (!selectedMarkerId) return false;
  pushUndo();
  markers = markers.filter(marker => marker.id !== selectedMarkerId);
  selectedMarkerId = null;
  drawWaveform();
  drawOverview();
  updateControls();
  setStatus('Marker deleted');
  return true;
}

function selectBetweenMarkers(point) {
  if (!buffer || markers.length < 1) return false;
  const sorted = markers.slice().sort((a, b) => a.time - b.time);
  let left = { time: 0 };
  let right = { time: buffer.duration };
  sorted.forEach(marker => {
    if (marker.time < point) left = marker;
    if (!right && marker.time > point) right = marker;
    if (marker.time > point && right.time === buffer.duration) right = marker;
  });
  if (!right) right = { time: buffer.duration };
  if (right.time <= left.time) return false;
  selection = { start: left.time, end: right.time };
  selectedMarkerId = null;
  playOffset = selection.start;
  updateControls();
  drawWaveform();
  drawOverview();
  setStatus('Selected audio between markers');
  return true;
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

    canvasCtx.fillStyle = settings.waveColor || '#dfff00';
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
    canvasCtx.strokeStyle = settings.waveColor || '#dfff00';
    canvasCtx.strokeRect(left, 0, Math.max(0, right - left), h);
  }

  markers.forEach((marker, index) => {
    if (marker.time < visibleStart || marker.time > visibleStart + viewDuration) return;
    const x = ((marker.time - visibleStart) / viewDuration) * w;
    const selected = marker.id === selectedMarkerId;
    canvasCtx.strokeStyle = selected ? (settings.waveColor || '#dfff00') : (settings.markerColor || '#ff3b3b');
    canvasCtx.lineWidth = selected ? 3 : 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, 0);
    canvasCtx.lineTo(x, h);
    canvasCtx.stroke();
    canvasCtx.fillStyle = selected ? (settings.waveColor || '#dfff00') : (settings.markerColor || '#ff3b3b');
    canvasCtx.beginPath();
    canvasCtx.moveTo(x - 5, 0);
    canvasCtx.lineTo(x + 5, 0);
    canvasCtx.lineTo(x, 8);
    canvasCtx.closePath();
    canvasCtx.fill();
    canvasCtx.font = '10px JetBrains Mono, monospace';
    canvasCtx.fillText(String(index + 1), x + 4, 18);
  });

  const playX = ((currentPlayhead() - visibleStart) / viewDuration) * w;
  if (playX >= 0 && playX <= w) {
    canvasCtx.strokeStyle = settings.markerColor || '#ff3b3b';
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
    canvasCtx.fillText(fmtRuler(seconds, viewDuration), (i / 10) * w + 3, 15);
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
  overviewCtx.fillStyle = settings.waveColor || '#dfff00';
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
    overviewCtx.fillText(fmtRuler(seconds, buffer.duration), x + 4, h - 5);
  }

  const viewDuration = visibleDuration();
  const x1 = (visibleStart / buffer.duration) * w;
  const x2 = ((visibleStart + viewDuration) / buffer.duration) * w;
  overviewCtx.fillStyle = `${settings.viewColor || '#c76bff'}33`;
  overviewCtx.fillRect(x1, top, Math.max(3, x2 - x1), waveHeight);
  overviewCtx.strokeStyle = settings.viewColor || '#c76bff';
  overviewCtx.lineWidth = 2;
  overviewCtx.strokeRect(x1, top + 1, Math.max(3, x2 - x1), Math.max(3, waveHeight - 2));

  markers.forEach(marker => {
    const x = (marker.time / buffer.duration) * w;
    overviewCtx.strokeStyle = marker.id === selectedMarkerId ? (settings.waveColor || '#dfff00') : (settings.markerColor || '#ff3b3b');
    overviewCtx.lineWidth = 1;
    overviewCtx.beginPath();
    overviewCtx.moveTo(x, top);
    overviewCtx.lineTo(x, rulerTop);
    overviewCtx.stroke();
  });

  const playX = (currentPlayhead() / buffer.duration) * w;
  overviewCtx.strokeStyle = settings.waveColor || '#dfff00';
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

function encodeWav(src, bitDepth = 16) {
  const channels = src.numberOfChannels;
  const bytesPerSample = bitDepth === 24 ? 3 : 2;
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
  view.setUint16(34, bitDepth, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < src.length; i++) {
    for (let ch = 0; ch < channels; ch++, offset += bytesPerSample) {
      const s = Math.max(-1, Math.min(1, src.getChannelData(ch)[i]));
      if (bitDepth === 24) {
        const sample = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
        view.setUint8(offset, sample & 0xFF);
        view.setUint8(offset + 1, (sample >> 8) & 0xFF);
        view.setUint8(offset + 2, (sample >> 16) & 0xFF);
      } else {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
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
  const isWav = format === 'wav' || format === 'wav24';
  const bitrate = isWav ? 0 : Number((format.split(':')[1] || 256));
  const bitDepth = format === 'wav24' ? 24 : 16;
  const blob = isWav ? encodeWav(buffer, bitDepth) : await encodeMp3(buffer, bitrate);
  const ext = isWav ? 'wav' : 'mp3';
  const suffix = isWav ? `${bitDepth}bit` : `${bitrate}kbps`;
  const url = URL.createObjectURL(blob);
  els.download.innerHTML = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName || 'Vox5000'}_${suffix}.${ext}`;
  a.className = 'dl-btn';
  a.textContent = `Download ${isWav ? `WAV ${bitDepth}-bit` : `MP3 ${bitrate} kbps`} · ${(blob.size / 1048576).toFixed(1)} MB`;
  els.download.appendChild(a);
  els.export.disabled = false;
  setStatus('Export ready');
}

function newSession() {
  stopPlayback();
  buffer = null;
  selection = null;
  hoverTime = null;
  markers = [];
  playOffset = 0;
  playEndAt = 0;
  playSelectionActive = false;
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
    closeEffectDialog();
    closeSettings();
    closeRecentProjects();
    finishWaveDrag(event);
    return;
  }
  if (isTypingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;

  if (event.code === 'Space') {
    event.preventDefault();
    if (recorder && recorder.state === 'recording') stopRecording();
    else if (buffer) playPause();
    return;
  }
  if (event.key === 'ArrowLeft' && buffer) {
    event.preventDefault();
    startArrowScrub(-1, event);
    return;
  }
  if (event.key === 'ArrowRight' && buffer) {
    event.preventDefault();
    startArrowScrub(1, event);
    return;
  }

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
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedMarkerId) {
    event.preventDefault();
    deleteSelectedMarker();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selection && selection.end > selection.start) {
    event.preventDefault();
    deleteSelection();
    return;
  }
  if (event.key === 'Enter' && buffer) {
    event.preventDefault();
    event.shiftKey ? returnToEnd() : returnToStart();
    return;
  }
  const actionByShortcut = [
    ['playPause', playPause],
    ['record', startRecording],
    ['returnToStart', returnToStart],
    ['returnToEnd', returnToEnd],
    ['insertSilence', insertSilence],
    ['deleteSelection', deleteSelection],
    ['selectAll', selectAllAudio],
    ['undo', undo],
    ['redo', redo],
    ['cutSplit', cutOrSplit],
    ['copy', copySelection],
    ['paste', pasteClipboard],
    ['marker', addMarker],
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
  if (els.project) els.project.addEventListener('change', () => openProjectFile(els.project.files[0]));
  if (els.newBtn) els.newBtn.addEventListener('click', newSession);
  if (els.record) els.record.addEventListener('click', startRecording);
  if (els.stop) els.stop.addEventListener('click', stopTransport);
  if (els.play) els.play.addEventListener('click', playPause);
  if (els.rewind) els.rewind.addEventListener('click', () => { playOffset = 0; stopPlayback(); drawWaveform(); });
  if (els.end) els.end.addEventListener('click', returnToEnd);
  if (els.insertSilenceBtn) els.insertSilenceBtn.addEventListener('click', insertSilence);
  if (els.trim) els.trim.addEventListener('click', trimSelection);
  if (els.del) els.del.addEventListener('click', deleteSelection);
  if (els.split) els.split.addEventListener('click', splitAtPlayhead);
  if (els.fadeIn) els.fadeIn.addEventListener('click', fadeIn);
  if (els.fadeOut) els.fadeOut.addEventListener('click', fadeOut);
  if (els.normalize) els.normalize.addEventListener('click', normalize);
  if (els.compress) els.compress.addEventListener('click', compressVoice);
  if (els.noise) els.noise.addEventListener('click', noiseGate);
  if (els.silence) els.silence.addEventListener('click', removeSilence);
  if (els.eq) els.eq.addEventListener('click', applyEq);
  if (els.eqOpen) els.eqOpen.addEventListener('click', showEq);
  if (els.eqClose) els.eqClose.addEventListener('click', closeEq);
  if (els.effectClose) els.effectClose.addEventListener('click', closeEffectDialog);
  if (els.effectCancel) els.effectCancel.addEventListener('click', closeEffectDialog);
  if (els.effectModal) els.effectModal.addEventListener('click', event => {
    if (event.target === els.effectModal) closeEffectDialog();
  });
  if (els.eqModal) els.eqModal.addEventListener('click', event => {
    if (event.target === els.eqModal) closeEq();
  });
  if (els.settingsClose) els.settingsClose.addEventListener('click', closeSettings);
  if (els.settingsModal) els.settingsModal.addEventListener('click', event => {
    if (event.target === els.settingsModal) closeSettings();
  });
  if (els.settingsSave) els.settingsSave.addEventListener('click', saveSettingsFromModal);
  if (els.settingsReset) els.settingsReset.addEventListener('click', () => {
    settings = { ...defaultSettings };
    saveSettings();
    applySettingsToUi();
    drawWaveform();
    drawOverview();
    setStatus('Recorder settings reset');
  });
  if (els.recentClose) els.recentClose.addEventListener('click', closeRecentProjects);
  if (els.recentModal) els.recentModal.addEventListener('click', event => {
    if (event.target === els.recentModal) closeRecentProjects();
  });
  if (els.eqReset) els.eqReset.addEventListener('click', () => setEqValues(0, 0, 0));
  if (els.eqPreset) els.eqPreset.addEventListener('change', applyEqPreset);
  [els.lowEq, els.midEq, els.highEq].forEach(slider => {
    if (slider) slider.addEventListener('input', updateEqValues);
    if (slider) slider.addEventListener('dblclick', event => {
      event.preventDefault();
      slider.value = 0;
      updateEqValues();
    });
  });
  if (els.undo) els.undo.addEventListener('click', undo);
  if (els.redo) els.redo.addEventListener('click', redo);
  if (els.export) els.export.addEventListener('click', exportFile);
  if (els.shortcutClose) els.shortcutClose.addEventListener('click', closeShortcuts);
  if (els.shortcutModal) els.shortcutModal.addEventListener('click', event => {
    if (event.target === els.shortcutModal) closeShortcuts();
  });
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
      const hitMarker = markerAtEvent(event);
      if (hitMarker) {
        selectedMarkerId = hitMarker.id;
        selection = null;
        playOffset = hitMarker.time;
        updateControls();
        drawWaveform();
        drawOverview();
        return;
      }
      selectedMarkerId = null;
      dragging = true;
      dragStart = canvasPointToSeconds(event);
      dragStartX = event.clientX;
      dragPointerId = event.pointerId;
      selectionDragMoved = false;
      els.canvas.setPointerCapture(event.pointerId);
    });
    els.canvas.addEventListener('pointermove', event => {
      if (!buffer) return;
      hoverTime = canvasPointToSeconds(event);
      if (!dragging) {
        updateControls();
        return;
      }
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
    els.canvas.addEventListener('dblclick', event => {
      if (!buffer) return;
      event.preventDefault();
      selectBetweenMarkers(rawCanvasPointToSeconds(event));
    });
    els.canvas.addEventListener('pointerleave', () => {
      hoverTime = null;
      updateControls();
    });
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
      saveProject,
      openRecent: showRecentProjects,
      new: newSession,
      newMono: () => newChannelFile(1),
      newStereo: () => newChannelFile(2),
      mixMono: mixDownToMono,
      mixStereo: mixDownToStereo,
      undo,
      redo,
      copy: copySelection,
      paste: pasteClipboard,
      trim: trimSelection,
      delete: deleteSelection,
      split: splitAtPlayhead,
      amplify: amplifyVolume,
      normalize,
      fadeIn,
      fadeOut,
      reverse: reverseAudio,
      compress: compressVoice,
      noise: noiseGate,
      dcOffset,
      invert: invertSignalPolarity,
      swapChannels,
      delayEcho,
      reverb,
      pitchTempo,
      highPass,
      lowPass,
      silence: removeSilence,
      removeSilence,
      insertSilence,
      eq: applyEq,
      showEq,
      marker: addMarker,
      start: returnToStart,
      end: returnToEnd,
      clearSelection,
      zoomIn: () => setZoom(zoom * 1.4),
      zoomOut: () => setZoom(zoom / 1.4),
      zoomReset: () => setZoom(1),
      showShortcuts,
      showSettings,
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
      if (file && file.name.toLowerCase().endsWith('.vox5000')) openProjectFile(file);
      else importFile(file);
    });
  }

  window.addEventListener('resize', () => {
    drawWaveform();
    drawOverview();
  });
  document.addEventListener('keydown', handleEditorShortcut);
  document.addEventListener('keyup', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') stopArrowScrub();
  });
  document.addEventListener('paste', pasteExternalAudio);
}

bindEvents();
applySettingsToUi();
initMics();
normalizeShortcutDefaults();
renderShortcuts();
updateEqValues();
updateControls();
drawWaveform();
drawOverview();
