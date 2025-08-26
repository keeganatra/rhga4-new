'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

/** ========= Config (via Railway vars where possible) ========= */
const allowedRootDomain = process.env.ALLOWED_ROOT_DOMAIN || 'robinsonandhenry.com';
const extraAllowedOrigins = (process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

/** ========= Body parsers =========
 * Keep JSON for fetch/xhr, also accept text/plain and octet-stream (sendBeacon variants)
 */
app.use(express.json({ limit: '64kb', strict: true }));
app.use(express.text({ type: 'text/plain', limit: '64kb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '64kb' }));

/** ========= Simple request logger (helps debug CORS/body) ========= */
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl} origin=${req.headers.origin || ''} ct=${req.headers['content-type'] || ''}`);
  next();
});

/** ========= CORS (same logic as your working version, but safer) ========= */
function hostFromOrigin(orig) {
  if (!orig) return '';
  let s = String(orig).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, ''); // strip scheme
  s = s.split('/')[0] || s;          // strip path
  s = s.split('?')[0] || s;          // strip query
  s = s.split('#')[0] || s;          // strip hash
  s = s.split(':')[0] || s;          // strip port
  return s;
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow same-origin/non-browser

    const hostname = hostFromOrigin(origin);

    const isAllowedBase =
      hostname === allowedRootDomain ||
      hostname.endsWith('.' + allowedRootDomain);

    const isAllowedExtra = extraAllowedOrigins.some(o => {
      const h = hostFromOrigin(o);
      return hostname === h || hostname.endsWith('.' + h);
    });

    if (isAllowedBase || isAllowedExtra) return callback(null, true);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,      // you’re not using cookies/auth
  maxAge: 86400
}));

// Let cors() answer preflights with ACAO headers (don’t short-circuit)
app.options('*', cors());

/** ========= Health ========= */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/** ========= Home ========= */
app.get('/', (_req, res) => {
  res.status(200).send('Zapier-only proxy is running 🚀');
});

/** ========= Coerce non-JSON bodies to JSON (for beacon) ========= */
function coerceBodyToJson(req) {
  if (typeof req.body === 'string' && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  } else if (Buffer.isBuffer(req.body)) {
    try { req.body = JSON.parse(req.body.toString('utf8')); } catch { req.body = {}; }
  }
}

/** ========= Forward helper (Zapier) ========= */
async function forwardToZapier(payload) {
  if (!ZAPIER_WEBHOOK_URL) throw new Error('ZAPIER_WEBHOOK_URL not configured');
  // Simple post; retry once on 5xx
  try {
    const r = await axios.post(ZAPIER_WEBHOOK_URL, payload, { timeout: 5000 });
    if (r.status >= 500) throw new Error('Zapier 5xx');
    return r.status;
  } catch (e) {
    const r2 = await axios.post(ZAPIER_WEBHOOK_URL, payload, { timeout: 5000 });
    if (r2.status >= 500) throw new Error('Zapier 5xx (retry)');
    return r2.status;
  }
}

/** ========= POST endpoints =========
 * Keep your “/” route for backward compatibility,
 * and add “/collect” for clarity. Both behave the same.
 */
async function handleCollect(req, res) {
  coerceBodyToJson(req);
  const payload = req.body || {};
  console.log('Received payload (keys):', Object.keys(payload));

  try {
    const status = await forwardToZapier(payload);
    if (status >= 200 && status < 300) {
      // 204 is perfect for sendBeacon (no body back)
      return res.sendStatus(204);
    }
    return res.status(502).json({ error: 'Bad gateway to Zapier', status });
  } catch (err) {
    console.error('❌ Error sending to Zapier:', err.message);
    return res.status(500).json({ error: 'Zapier forwarding failed', details: err.message });
  }
}

app.post('/', handleCollect);
app.post('/collect', handleCollect);

/** ========= Start ========= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Allowed domain: ${allowedRootDomain}`);
  if (extraAllowedOrigins.length) console.log(`Extra allowed origins: ${extraAllowedOrigins.join(', ')}`);
});
