'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

/** ---------- Config (Railway envs) ---------- */
const ALLOWED_ROOT_DOMAIN = process.env.ALLOWED_ROOT_DOMAIN || 'robinsonandhenry.com';
const EXTRA_ALLOWED_ORIGINS = (process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

/** ---------- Body parsers ---------- */
// JSON for fetch/XHR
app.use(express.json({ limit: '64kb', strict: true }));
// text/plain for many sendBeacon implementations
app.use(express.text({ type: 'text/plain', limit: '64kb' }));
// octet-stream for any odd beacons
app.use(express.raw({ type: 'application/octet-stream', limit: '64kb' }));

/** ---------- Request logger ---------- */
app.use(function(req, res, next) {
  console.log(`[req] ${req.method} ${req.originalUrl} origin=${req.headers.origin || ''} ct=${req.headers['content-type'] || ''}`);
  next();
});

// ---- CORS (robust + debug) ----
const ALLOWED_ROOT_DOMAIN = process.env.ALLOWED_ROOT_DOMAIN || 'robinsonandhenry.com';
const EXTRA_ALLOWED_ORIGINS = (process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function hostFromOrigin(orig) {
  if (!orig) return '';
  var s = String(orig).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, ''); // strip scheme
  s = s.split('/')[0];               // strip path
  s = s.split('?')[0];               // strip query
  s = s.split('#')[0];               // strip hash
  s = s.split(':')[0];               // strip port
  return s || '';
}

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); // same-origin or server-to-server

    const host = hostFromOrigin(origin);
    const baseOK = (host === ALLOWED_ROOT_DOMAIN) || host.endsWith('.' + ALLOWED_ROOT_DOMAIN);
    const extraOK = EXTRA_ALLOWED_ORIGINS.some(o => {
      const h = hostFromOrigin(o);
      return host === h || host.endsWith('.' + h);
    });

    const allowed = baseOK || extraOK;
    console.log(`[cors] origin=${origin} host=${host} allowed=${allowed} baseOK=${baseOK} extraOK=${extraOK}`);
    return allowed ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  maxAge: 86400
}));

// IMPORTANT: let cors() handle preflights (returns 204 **with** ACAO headers)
app.options('*', cors());


/** ---------- Health ---------- */
app.get('/healthz', (req, res) => {
  console.log('[healthz] ok');
  res.status(200).send('ok');
});

app.get('/', (req, res) => {
  res.status(200).send('Zapier-only proxy is running 🚀');
});

/** ---------- Minimal schema validator ---------- */
function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'invalid body';

  const allowedTop = new Set([
    'client_id','session_id','atraid','atrauid',
    'timestamp','page_url','page_path','page_title',
    'referrer_url','referrer_host','language','screen_resolution',
    'utm_source_first','utm_source_last','utm_medium_first','utm_medium_last',
    'utm_campaign_first','utm_campaign_last','utm_term_first','utm_term_last',
    'utm_content_first','utm_content_last',
    'gclid','gbraid','wbraid','fbclid','msclkid','ttclid','li_fat_id','twclid',
    'ciid','clickid','adset_name',
    'channel_first_touch','channel_last_touch',
    'event_type','event_params'
  ]);

  if ('session_id' in p && p.session_id !== '' && typeof p.session_id !== 'number')
    return 'session_id must be number or empty';
  if ('event_params' in p && p.event_params && typeof p.event_params !== 'object')
    return 'event_params must be object';
  if (p.event_params && JSON.stringify(p.event_params).length > 8192)
    return 'event_params too large';

  Object.keys(p).forEach(k => { if (!allowedTop.has(k)) delete p[k]; });
  return null;
}

/** ---------- Zapier client ---------- */
const zapier = axios.create({
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: s => s >= 200 && s < 500
});

async function forwardToZapier(payload) {
  if (!ZAPIER_WEBHOOK_URL) throw new Error('ZAPIER_WEBHOOK_URL not configured');
  try {
    const res = await zapier.post(ZAPIER_WEBHOOK_URL, payload);
    if (res.status >= 500) throw new Error('Zapier 5xx');
    return res.status;
  } catch (e) {
    const res2 = await zapier.post(ZAPIER_WEBHOOK_URL, payload);
    if (res2.status >= 500) throw new Error('Zapier 5xx (retry)');
    return res2.status;
  }
}

/** ---------- Collect endpoint ---------- */
app.post(['/collect', '/'], async (req, res) => {
  const rid = crypto.randomBytes(8).toString('hex');

  // Coerce non-JSON bodies (text/plain or octet-stream) into JSON
  if (typeof req.body === 'string' && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  } else if (Buffer.isBuffer(req.body)) {
    try { req.body = JSON.parse(req.body.toString('utf8')); } catch { req.body = {}; }
  }

  const payload = req.body || {};
  console.log(`[${rid}] recv event_type=${payload.event_type} cid=${payload.client_id} sid=${payload.session_id}`);

  if (!payload || Object.keys(payload).length === 0) {
    console.warn(`[${rid}] empty body`);
    return res.status(400).json({ error: 'empty body' });
  }

  const errMsg = validatePayload(payload);
  if (errMsg) {
    console.warn(`[${rid}] validation failed: ${errMsg}`);
    return res.status(400).json({ error: errMsg });
  }

  try {
    const status = await forwardToZapier(payload);
    if (status >= 200 && status < 300) return res.sendStatus(204);
    console.warn(`[${rid}] Zapier non-2xx: ${status}`);
    return res.status(502).json({ error: 'Bad gateway to Zapier', status });
  } catch (err) {
    console.error(`[${rid}] Zapier forwarding failed: ${err.message}`);
    return res.status(502).json({ error: 'Zapier forwarding failed' });
  }
});

/** ---------- Signals ---------- */
process.on('unhandledRejection', r => console.error('UNHANDLED REJECTION:', r));
process.on('uncaughtException', e => console.error('UNCAUGHT EXCEPTION:', e));
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT');  process.exit(0); });

/** ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Allowed domain: ${ALLOWED_ROOT_DOMAIN}`);
  if (EXTRA_ALLOWED_ORIGINS.length) console.log(`Extra allowed origins: ${EXTRA_ALLOWED_ORIGINS.join(', ')}`);
});
