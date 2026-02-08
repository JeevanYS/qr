'use strict';

const config = {
  preferredFacingMode: 'environment',
  scanIntervalMs: 200,
  duplicateCooldownMs: 1200,
  maxScanWidth: 640
};

const el = {
  video: document.getElementById('camera'),
  status: document.getElementById('status'),
  capabilityBadge: document.getElementById('capabilityBadge'),
  recordsBody: document.getElementById('recordsBody'),
  recordsBadge: document.getElementById('recordsBadge')
};

const state = {
  scanning: false,
  lastValue: null,
  lastValueTs: 0,
  records: new Map(),
  order: []
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
const textDecoder = new TextDecoder('iso-8859-1');
let awaitingGesture = false;

function setStatus(message, tone) {
  el.status.textContent = message;
  el.status.style.color = tone === 'error' ? 'var(--danger)' : 'var(--muted)';
}

function formatLastSeen(date) {
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatUid(value) {
  if (!value) {
    return '';
  }
  const digits = value.replace(/\s+/g, '');
  if (!/^\d{12}$/.test(digits)) {
    return value;
  }
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
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

function joinAddress(parts) {
  return parts
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join(', ');
}

function recordKey(record) {
  return record.uid || record.referenceId || '';
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

  state.order.forEach((key) => {
    const record = state.records.get(key);
    if (!record) {
      return;
    }
    const row = document.createElement('tr');

    const idCell = document.createElement('td');
    idCell.className = 'mono';
    idCell.textContent = record.uid ? formatUid(record.uid) : `Ref ${record.referenceId || '-'}`;
    row.appendChild(idCell);

    const nameCell = document.createElement('td');
    nameCell.textContent = record.name || '-';
    row.appendChild(nameCell);

    const genderCell = document.createElement('td');
    genderCell.textContent = normalizeGender(record.gender) || '-';
    row.appendChild(genderCell);

    const dobCell = document.createElement('td');
    dobCell.textContent = record.dob || record.yob || '-';
    row.appendChild(dobCell);

    const addressCell = document.createElement('td');
    addressCell.textContent = record.address || '-';
    row.appendChild(addressCell);

    const seenCell = document.createElement('td');
    seenCell.textContent = record.lastSeen || '-';
    row.appendChild(seenCell);

    el.recordsBody.appendChild(row);
  });

  el.recordsBadge.textContent = `${state.order.length} records`;
}

function upsertRecord(record) {
  const key = recordKey(record);
  if (!key) {
    setStatus('UID not found in QR data.', 'error');
    return;
  }

  const existing = state.records.get(key);
  const now = new Date();
  const next = {
    ...existing,
    ...record,
    lastSeen: formatLastSeen(now)
  };

  state.records.set(key, next);
  state.order = state.order.filter((item) => item !== key);
  state.order.unshift(key);

  renderRecords();
  setStatus(existing ? 'Record updated.' : 'Record captured.');
}

function extractXml(raw) {
  const start = raw.indexOf('<');
  if (start === -1) {
    return null;
  }
  return raw.slice(start).trim();
}

function parsePrintLetter(node) {
  const attr = (name) => node.getAttribute(name) || '';
  const uid = attr('uid');
  const name = attr('name');
  const gender = attr('gender');
  const dob = attr('dob');
  const yob = attr('yob');
  const pin = attr('pc');
  const address = joinAddress([
    attr('co'),
    attr('house'),
    attr('street'),
    attr('lm'),
    attr('loc'),
    attr('vtc'),
    attr('po'),
    attr('dist'),
    attr('subdist'),
    attr('state'),
    pin
  ]);

  return {
    uid,
    name,
    gender,
    dob,
    yob,
    address,
    pin,
    source: 'PrintLetterBarcodeData'
  };
}

function parseOfflinePaperless(root) {
  const referenceId = root.getAttribute('referenceId') || root.getAttribute('referenceid') || '';
  const poi = root.getElementsByTagName('Poi')[0];
  const poa = root.getElementsByTagName('Poa')[0];

  const name = poi ? poi.getAttribute('name') || '' : '';
  const dob = poi ? poi.getAttribute('dob') || '' : '';
  const yob = poi ? poi.getAttribute('yob') || '' : '';
  const gender = poi ? poi.getAttribute('gender') || '' : '';
  const pin = poa ? poa.getAttribute('pc') || '' : '';

  const address = poa
    ? joinAddress([
        poa.getAttribute('house'),
        poa.getAttribute('street'),
        poa.getAttribute('lm'),
        poa.getAttribute('loc'),
        poa.getAttribute('vtc'),
        poa.getAttribute('subdist'),
        poa.getAttribute('dist'),
        poa.getAttribute('state'),
        pin,
        poa.getAttribute('po')
      ])
    : '';

  return {
    referenceId,
    name,
    gender,
    dob,
    yob,
    address,
    pin,
    source: 'OfflinePaperlessKyc'
  };
}

function parseOkY(oky) {
  const name = oky.getAttribute('n') || '';
  const referenceId = oky.getAttribute('r') || '';
  const dob = oky.getAttribute('d') || '';
  const gender = oky.getAttribute('g') || '';
  const address = oky.getAttribute('a') || '';

  return {
    referenceId,
    name,
    gender,
    dob,
    address,
    source: 'OKY'
  };
}

function parseXmlPayload(raw) {
  const xmlText = extractXml(raw);
  if (!xmlText) {
    return null;
  }

  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    return null;
  }

  const printNodes = doc.getElementsByTagName('PrintLetterBarcodeData');
  if (printNodes.length) {
    return parsePrintLetter(printNodes[0]);
  }

  const offlineNodes = doc.getElementsByTagName('OfflinePaperlessKyc');
  if (offlineNodes.length) {
    return parseOfflinePaperless(offlineNodes[0]);
  }

  const okyNodes = doc.getElementsByTagName('OKY');
  if (okyNodes.length) {
    return parseOkY(okyNodes[0]);
  }

  return null;
}

function bigIntToBytes(value) {
  if (value === 0n) {
    return new Uint8Array([0]);
  }
  const bytes = [];
  let temp = value;
  while (temp > 0n) {
    bytes.unshift(Number(temp & 0xffn));
    temp >>= 8n;
  }
  return new Uint8Array(bytes);
}

async function inflateBytes(bytes) {
  if (!('DecompressionStream' in window)) {
    return null;
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    return null;
  }
}

function parseSecureQrBytes(bytes) {
  const fields = [];
  let start = 0;

  for (let i = 0; i < bytes.length && fields.length < 16; i += 1) {
    if (bytes[i] === 255) {
      fields.push(bytes.slice(start, i));
      start = i + 1;
    }
  }

  if (fields.length < 16) {
    return null;
  }

  const decoded = fields.map((chunk) => cleanText(textDecoder.decode(chunk)));
  const [
    indicator,
    referenceId,
    name,
    dob,
    gender,
    careOf,
    district,
    landmark,
    house,
    location,
    pin,
    postOffice,
    state,
    street,
    subDistrict,
    vtc
  ] = decoded;

  if (!indicator || !referenceId) {
    return null;
  }

  const address = joinAddress([
    careOf,
    house,
    street,
    landmark,
    location,
    vtc,
    subDistrict,
    district,
    state,
    pin,
    postOffice
  ]);

  return {
    referenceId,
    name,
    gender,
    dob,
    address,
    pin,
    source: 'Secure QR'
  };
}

async function parseSecureQr(raw) {
  const digits = raw.replace(/\s+/g, '');
  if (!/^\d{50,}$/.test(digits)) {
    return null;
  }
  let big;
  try {
    big = BigInt(digits);
  } catch (error) {
    return null;
  }

  const bytes = bigIntToBytes(big);
  const inflated = await inflateBytes(bytes);
  if (!inflated) {
    return null;
  }
  return parseSecureQrBytes(inflated);
}

async function parseAadhaarPayload(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return null;
  }

  const xmlRecord = parseXmlPayload(trimmed);
  if (xmlRecord) {
    return xmlRecord;
  }

  const secureRecord = await parseSecureQr(trimmed);
  if (secureRecord) {
    return secureRecord;
  }

  return null;
}

async function handleScanResult(value) {
  const now = Date.now();
  if (value === state.lastValue && now - state.lastValueTs < config.duplicateCooldownMs) {
    return;
  }
  state.lastValue = value;
  state.lastValueTs = now;

  const compact = (value || '').replace(/\s+/g, '');
  const looksNumeric = /^\d{50,}$/.test(compact);
  if (looksNumeric && !('DecompressionStream' in window)) {
    setStatus('Secure QR needs a compatible browser to decode.', 'error');
    return;
  }

  const record = await parseAadhaarPayload(value);
  if (!record) {
    setStatus(looksNumeric ? 'Secure QR could not be decoded.' : 'Not an Aadhaar QR format.', 'error');
    return;
  }

  upsertRecord(record);
}

function updateCapabilityBadge() {
  if (!window.isSecureContext) {
    el.capabilityBadge.textContent = 'Requires HTTPS';
    el.capabilityBadge.classList.add('neutral');
    return false;
  }

  if (scanner.isBarcodeSupported()) {
    el.capabilityBadge.textContent = 'BarcodeDetector ready';
    el.capabilityBadge.classList.remove('neutral');
    return true;
  }

  if (scanner.isJsQrSupported()) {
    el.capabilityBadge.textContent = 'Fallback ready (jsQR)';
    el.capabilityBadge.classList.remove('neutral');
    return true;
  }

  el.capabilityBadge.textContent = 'Scanner not supported';
  el.capabilityBadge.classList.add('neutral');
  return false;
}

function queueGestureStart() {
  if (awaitingGesture) {
    return;
  }
  awaitingGesture = true;
  document.addEventListener(
    'click',
    async () => {
      awaitingGesture = false;
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
  const badgeOk = updateCapabilityBadge();
  if (!badgeOk) {
    setStatus('Scanner unavailable.', 'error');
    return;
  }
  const detectorReady = await scanner.initDetector();
  if (!detectorReady) {
    setStatus('Scanner unavailable.', 'error');
    return;
  }
  setStatus('Ready.');
  startScan().catch(() => undefined);
}

attachEvents();
registerServiceWorker();
init().catch(() => undefined);
