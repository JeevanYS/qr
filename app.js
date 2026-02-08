'use strict';

const config = {
  preferredFacingMode: 'environment',
  scanIntervalMs: 200,
  maxHistory: 20,
  duplicateCooldownMs: 1200,
  maxScanWidth: 640
};

const el = {
  video: document.getElementById('camera'),
  status: document.getElementById('status'),
  capabilityBadge: document.getElementById('capabilityBadge'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  torchBtn: document.getElementById('torchBtn'),
  hint: document.getElementById('hint'),
  resultText: document.getElementById('resultText'),
  resultBadge: document.getElementById('resultBadge'),
  copyBtn: document.getElementById('copyBtn'),
  clearBtn: document.getElementById('clearBtn'),
  historyList: document.getElementById('historyList'),
  historyBadge: document.getElementById('historyBadge')
};

const state = {
  scanning: false,
  torchEnabled: false,
  lastValue: null,
  lastValueTs: 0,
  history: []
};

class CameraManager {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.stream = null;
    this.track = null;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access is not supported in this browser.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: config.preferredFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    this.videoEl.srcObject = this.stream;
    this.track = this.stream.getVideoTracks()[0] || null;
    await this.videoEl.play().catch(() => undefined);
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    this.stream = null;
    this.track = null;
    this.videoEl.srcObject = null;
  }

  getTorchCapabilities() {
    if (!this.track || !this.track.getCapabilities) {
      return { supported: false };
    }
    const capabilities = this.track.getCapabilities();
    return { supported: Boolean(capabilities.torch) };
  }

  async setTorch(enabled) {
    if (!this.track || !this.track.applyConstraints) {
      return false;
    }
    try {
      await this.track.applyConstraints({
        advanced: [{ torch: enabled }]
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}

class QrScanner {
  constructor(videoEl, onResult) {
    this.videoEl = videoEl;
    this.onResult = onResult;
    this.detector = null;
    this.rafId = null;
    this.lastScanTs = 0;
    this.active = false;
    this.mode = 'none';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  isBarcodeSupported() {
    return typeof window.BarcodeDetector !== 'undefined';
  }

  isJsQrSupported() {
    return typeof window.jsQR === 'function';
  }

  isSupported() {
    return this.isBarcodeSupported() || this.isJsQrSupported();
  }

  async initDetector() {
    if (this.isBarcodeSupported()) {
      this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      this.mode = 'barcode';
      return true;
    }
    if (this.isJsQrSupported()) {
      this.mode = 'jsqr';
      return true;
    }
    this.mode = 'none';
    return false;
  }

  start() {
    this.active = true;
    this.lastScanTs = 0;
    this.loop(0);
  }

  stop() {
    this.active = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
  }

  async scanWithBarcodeDetector() {
    if (!this.detector) {
      return;
    }
    const codes = await this.detector.detect(this.videoEl);
    if (!codes || codes.length === 0) {
      return;
    }
    const value = codes[0].rawValue || '';
    if (!value) {
      return;
    }
    this.onResult(value);
  }

  scanWithJsQr() {
    if (!this.ctx || !this.videoEl.videoWidth || !this.videoEl.videoHeight) {
      return;
    }

    const width = this.videoEl.videoWidth;
    const height = this.videoEl.videoHeight;
    const targetWidth = Math.min(config.maxScanWidth, width);
    const targetHeight = Math.round((targetWidth / width) * height);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    this.ctx.drawImage(this.videoEl, 0, 0, targetWidth, targetHeight);

    const imageData = this.ctx.getImageData(0, 0, targetWidth, targetHeight);
    const result = window.jsQR(imageData.data, targetWidth, targetHeight);
    if (result && result.data) {
      this.onResult(result.data);
    }
  }

  async scanFrame() {
    if (this.mode === 'barcode') {
      await this.scanWithBarcodeDetector();
      return;
    }
    if (this.mode === 'jsqr') {
      this.scanWithJsQr();
    }
  }

  loop(timestamp) {
    if (!this.active) {
      return;
    }

    if (timestamp - this.lastScanTs >= config.scanIntervalMs) {
      this.lastScanTs = timestamp;
      this.scanFrame().catch(() => undefined);
    }

    this.rafId = requestAnimationFrame((ts) => this.loop(ts));
  }
}

const camera = new CameraManager(el.video);
const scanner = new QrScanner(el.video, handleScanResult);

function setStatus(message, tone) {
  el.status.textContent = message;
  el.status.style.color = tone === 'error' ? 'var(--danger)' : 'var(--muted)';
}

function setBadge(message, tone) {
  el.resultBadge.textContent = message;
  if (tone === 'success') {
    el.resultBadge.classList.remove('neutral');
  } else {
    el.resultBadge.classList.add('neutral');
  }
}

function updateHistory() {
  el.historyList.innerHTML = '';
  state.history.forEach((entry) => {
    const item = document.createElement('li');
    const time = document.createElement('div');
    const value = document.createElement('div');
    time.className = 'time';
    value.className = 'value';
    time.textContent = entry.time;
    value.textContent = entry.value;
    item.appendChild(time);
    item.appendChild(value);
    el.historyList.appendChild(item);
  });
  el.historyBadge.textContent = `${state.history.length} items`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function handleScanResult(value) {
  const now = Date.now();
  if (value === state.lastValue && now - state.lastValueTs < config.duplicateCooldownMs) {
    return;
  }
  state.lastValue = value;
  state.lastValueTs = now;

  el.resultText.textContent = value;
  setBadge('Scan captured', 'success');
  el.copyBtn.disabled = false;

  state.history.unshift({
    value,
    time: formatTime(new Date())
  });
  state.history = state.history.slice(0, config.maxHistory);
  updateHistory();
}

function ensureSecureContext() {
  if (window.isSecureContext) {
    return true;
  }
  setStatus('Secure context required', 'error');
  el.hint.textContent = 'Camera access needs https:// or http://localhost on Android.';
  el.startBtn.disabled = true;
  return false;
}

async function startScan() {
  if (state.scanning) {
    return;
  }

  if (!ensureSecureContext()) {
    return;
  }

  try {
    setStatus('Requesting camera access...');
    await camera.start();
    state.scanning = true;
    el.startBtn.disabled = true;
    el.stopBtn.disabled = false;

    const torchCap = camera.getTorchCapabilities();
    el.torchBtn.disabled = !torchCap.supported;

    setStatus('Scanning...');
    scanner.start();
  } catch (error) {
    setStatus(error.message || 'Unable to access camera.', 'error');
  }
}

function stopScan() {
  if (!state.scanning) {
    return;
  }
  scanner.stop();
  camera.stop();
  state.scanning = false;
  state.torchEnabled = false;
  el.startBtn.disabled = false;
  el.stopBtn.disabled = true;
  el.torchBtn.disabled = true;
  setStatus('Idle');
}

async function toggleTorch() {
  const nextValue = !state.torchEnabled;
  const applied = await camera.setTorch(nextValue);
  if (applied) {
    state.torchEnabled = nextValue;
    setStatus(nextValue ? 'Torch enabled' : 'Torch disabled');
  } else {
    setStatus('Torch not available', 'error');
  }
}

function clearResults() {
  state.lastValue = null;
  state.lastValueTs = 0;
  el.resultText.textContent = '-';
  setBadge('No scans yet');
  el.copyBtn.disabled = true;
  state.history = [];
  updateHistory();
}

async function copyResult() {
  const value = el.resultText.textContent;
  if (!value || value === '-') {
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
    setStatus('Copied to clipboard');
  } else {
    setStatus('Clipboard unavailable', 'error');
  }
}

function updateCapabilityBadge() {
  const hasBarcode = scanner.isBarcodeSupported();
  const hasJsQr = scanner.isJsQrSupported();

  if (!window.isSecureContext) {
    el.capabilityBadge.textContent = 'Requires HTTPS';
    el.capabilityBadge.classList.add('neutral');
    el.startBtn.disabled = true;
    el.hint.textContent = 'Camera access needs https:// or http://localhost on Android.';
    return;
  }

  if (hasBarcode) {
    el.capabilityBadge.textContent = 'BarcodeDetector ready';
    el.capabilityBadge.classList.remove('neutral');
    el.hint.textContent = 'Point the camera at a QR code. Scanning happens locally in your browser.';
    return;
  }

  if (hasJsQr) {
    el.capabilityBadge.textContent = 'Fallback ready (jsQR)';
    el.capabilityBadge.classList.remove('neutral');
    el.hint.textContent = 'Using a JavaScript fallback scanner. Keep the QR code centered and steady.';
    return;
  }

  el.capabilityBadge.textContent = 'Scanner not supported';
  el.capabilityBadge.classList.add('neutral');
  el.startBtn.disabled = true;
  el.hint.textContent = 'No supported QR scanner found. Try Chrome or Edge.';
}

function attachEvents() {
  el.startBtn.addEventListener('click', startScan);
  el.stopBtn.addEventListener('click', stopScan);
  el.torchBtn.addEventListener('click', toggleTorch);
  el.clearBtn.addEventListener('click', clearResults);
  el.copyBtn.addEventListener('click', copyResult);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopScan();
    }
  });
  window.addEventListener('pagehide', stopScan);
  window.addEventListener('beforeunload', () => {
    scanner.stop();
    camera.stop();
  });
}

function registerServiceWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => undefined);
  });
}

async function init() {
  updateCapabilityBadge();
  if (!window.isSecureContext) {
    setStatus('Secure context required', 'error');
    return;
  }
  const detectorReady = await scanner.initDetector();
  if (!detectorReady) {
    setStatus('Scanner unavailable', 'error');
    return;
  }
  setStatus('Ready');
}

attachEvents();
registerServiceWorker();
init().catch(() => undefined);
