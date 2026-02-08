'use strict';

const config = {
  preferredFacingMode: 'environment',
  scanIntervalMs: 200,
  duplicateCooldownMs: 1200,
  maxScanWidth: 640,
  storageKey: 'qr_records_v1'
};

const el = {
  video: document.getElementById('camera'),
  status: document.getElementById('status'),
  recordsBody: document.getElementById('recordsBody'),
  recordsBadge: document.getElementById('recordsBadge')
};

const state = {
  scanning: false,
  lastValue: null,
  lastValueTs: 0,
  records: new Map(),
  order: [],
  awaitingGesture: false
};

class CameraManager {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.stream = null;
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
    await this.videoEl.play().catch(() => undefined);
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    this.stream = null;
    this.videoEl.srcObject = null;
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

  deliver(value) {
    Promise.resolve(this.onResult(value)).catch(() => undefined);
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
    this.deliver(value);
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
      this.deliver(result.data);
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

function normalizeGender(value) {
  const cleaned = (value || '').trim();
  if (!cleaned) {
    return '';
  }
  const lower = cleaned.toLowerCase();
  if (lower.startsWith('m')) {
    return 'Male';
  }
  if (lower.startsWith('f')) {
    return 'Female';
  }
  if (lower.startsWith('t')) {
    return 'Transgender';
  }
  return cleaned;
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function cleanPhone(value) {
  if (!value) {
    return '';
  }
  const digits = value.replace(/[^\d+]/g, '');
  return digits;
}

function cleanEmail(value) {
  return (value || '').trim().toLowerCase();
}

function recordKey(record) {
  if (record.email) {
    return `email:${record.email}`;
  }
  if (record.mobile) {
    return `mobile:${record.mobile}`;
  }
  if (record.username && record.dob) {
    return `user:${record.username.toLowerCase()}|${record.dob}`;
  }
  if (record.username) {
    return `user:${record.username.toLowerCase()}`;
  }
  return '';
}

function renderRecords() {
  el.recordsBody.innerHTML = '';

  if (!state.order.length) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No scans yet.';
    row.appendChild(cell);
    el.recordsBody.appendChild(row);
    el.recordsBadge.textContent = '0 records';
    return;
  }

  const fragment = document.createDocumentFragment();

  state.order.forEach((key) => {
    const record = state.records.get(key);
    if (!record) {
      return;
    }
    const row = document.createElement('tr');

    const userCell = document.createElement('td');
    userCell.textContent = record.username || '-';
    row.appendChild(userCell);

    const dobCell = document.createElement('td');
    dobCell.textContent = record.dob || '-';
    row.appendChild(dobCell);

    const ageCell = document.createElement('td');
    ageCell.textContent = record.age || '-';
    row.appendChild(ageCell);

    const genderCell = document.createElement('td');
    genderCell.textContent = record.gender || '-';
    row.appendChild(genderCell);

    const mobileCell = document.createElement('td');
    mobileCell.textContent = record.mobile || '-';
    row.appendChild(mobileCell);

    const emailCell = document.createElement('td');
    emailCell.textContent = record.email || '-';
    row.appendChild(emailCell);

    fragment.appendChild(row);
  });

  el.recordsBody.appendChild(fragment);
  el.recordsBadge.textContent = `${state.order.length} records`;
}

function saveRecords() {
  const payload = state.order.map((key) => {
    const record = state.records.get(key);
    return record ? { key, ...record } : null;
  }).filter(Boolean);

  try {
    localStorage.setItem(config.storageKey, JSON.stringify(payload));
  } catch (error) {
    setStatus('Storage full. Unable to save more records.', 'error');
  }
}

function upsertRecord(record) {
  const key = recordKey(record);
  if (!key) {
    setStatus('Missing unique fields for de-duplication.', 'error');
    return;
  }

  const existing = state.records.get(key) || {};
  const next = {
    username: record.username || existing.username || '',
    dob: record.dob || existing.dob || '',
    age: record.age || existing.age || '',
    gender: record.gender || existing.gender || '',
    mobile: record.mobile || existing.mobile || '',
    email: record.email || existing.email || ''
  };

  state.records.set(key, next);
  state.order = state.order.filter((item) => item !== key);
  state.order.unshift(key);

  renderRecords();
  saveRecords();
  setStatus(existing.username || existing.email || existing.mobile ? 'Record updated.' : 'Record stored.');
}

function parseJsonPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      username: cleanText(parsed.username || parsed.user || parsed.name),
      dob: cleanText(parsed.dob || parsed.dateOfBirth || parsed.birth || parsed.birthDate),
      age: cleanText(parsed.age),
      gender: normalizeGender(parsed.gender),
      mobile: cleanPhone(parsed.mobile || parsed.phone || parsed.phoneNumber),
      email: cleanEmail(parsed.email || parsed.mail)
    };
  } catch (error) {
    return null;
  }
}

function parseKeyValuePayload(raw) {
  if (!/[=:]/.test(raw)) {
    return null;
  }
  const record = {};
  const regex = /([^:=;\n|,]+)\s*[:=]\s*([^;\n|,]+)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!key) {
      continue;
    }
    record[key] = value;
  }
  if (!Object.keys(record).length) {
    return null;
  }
  return {
    username: cleanText(record.username || record.user || record.name),
    dob: cleanText(record.dob || record.dateofbirth || record.birth || record.birthdate),
    age: cleanText(record.age),
    gender: normalizeGender(record.gender),
    mobile: cleanPhone(record.mobile || record.phone || record.phonenumber),
    email: cleanEmail(record.email || record.mail)
  };
}

function parseDelimitedPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let delimiter = null;
  if (trimmed.includes('|')) {
    delimiter = '|';
  } else if (trimmed.includes(',')) {
    delimiter = ',';
  } else if (trimmed.includes(';')) {
    delimiter = ';';
  } else {
    return null;
  }

  const parts = trimmed.split(delimiter).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 6) {
    return null;
  }

  const [username, dob, age, gender, mobile, email] = parts;
  return {
    username: cleanText(username),
    dob: cleanText(dob),
    age: cleanText(age),
    gender: normalizeGender(gender),
    mobile: cleanPhone(mobile),
    email: cleanEmail(email)
  };
}

function parseQrPayload(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return null;
  }

  const jsonRecord = parseJsonPayload(trimmed);
  if (jsonRecord) {
    return jsonRecord;
  }

  const kvRecord = parseKeyValuePayload(trimmed);
  if (kvRecord) {
    return kvRecord;
  }

  const delimitedRecord = parseDelimitedPayload(trimmed);
  if (delimitedRecord) {
    return delimitedRecord;
  }

  return null;
}

function isRecordUsable(record) {
  if (!record) {
    return false;
  }
  return Boolean(record.username || record.email || record.mobile);
}

async function handleScanResult(value) {
  const now = Date.now();
  if (value === state.lastValue && now - state.lastValueTs < config.duplicateCooldownMs) {
    return;
  }
  state.lastValue = value;
  state.lastValueTs = now;

  const record = parseQrPayload(value);
  if (!isRecordUsable(record)) {
    setStatus('QR format not recognized.', 'error');
    return;
  }

  upsertRecord(record);
}

function loadRecords() {
  try {
    const raw = localStorage.getItem(config.storageKey);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    parsed.forEach((entry) => {
      if (!entry || !entry.key) {
        return;
      }
      const record = {
        username: cleanText(entry.username),
        dob: cleanText(entry.dob),
        age: cleanText(entry.age),
        gender: normalizeGender(entry.gender),
        mobile: cleanPhone(entry.mobile),
        email: cleanEmail(entry.email)
      };
      state.records.set(entry.key, record);
      state.order.push(entry.key);
    });
  } catch (error) {
    setStatus('Stored data could not be loaded.', 'error');
  }
}

function queueGestureStart() {
  if (state.awaitingGesture) {
    return;
  }
  state.awaitingGesture = true;
  document.addEventListener(
    'click',
    async () => {
      state.awaitingGesture = false;
      await startScan();
    },
    { once: true }
  );
}

async function startScan() {
  if (state.scanning) {
    return;
  }
  if (!window.isSecureContext) {
    setStatus('Secure context required.', 'error');
    return;
  }
  try {
    setStatus('Requesting camera access...');
    await camera.start();
    state.scanning = true;
    setStatus('Scanning...');
    scanner.start();
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      setStatus('Camera permission required. Tap to allow.', 'error');
      queueGestureStart();
      return;
    }
    if (error && error.name === 'NotFoundError') {
      setStatus('No camera found.', 'error');
      return;
    }
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
}

function attachEvents() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopScan();
      return;
    }
    startScan().catch(() => undefined);
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
  if (!window.isSecureContext) {
    setStatus('Secure context required.', 'error');
    return;
  }
  const detectorReady = await scanner.initDetector();
  if (!detectorReady) {
    setStatus('Scanner unavailable.', 'error');
    return;
  }
  loadRecords();
  renderRecords();
  setStatus('Ready.');
  startScan().catch(() => undefined);
}

attachEvents();
registerServiceWorker();
init().catch(() => undefined);
