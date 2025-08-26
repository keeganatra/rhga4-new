const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const allowedRootDomain = 'robinsonandhenry.com';

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow non-browser requests

    try {
      const hostname = new URL(origin).hostname;

      const isAllowed =
        hostname === allowedRootDomain ||
        hostname.endsWith('.' + allowedRootDomain);

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS: ' + origin));
      }
    } catch (err) {
      callback(new Error('Invalid origin: ' + origin));
    }
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));


app.use(express.json());

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

/** ---------- Body parsers ---------- */
// JSON for normal fetch/XHR
app.use(express.json({ limit: '64kb', strict: true }));
// text/plain for many sendBeacon implementations
app.use(express.text({ type: 'text/plain', limit: '64kb' }));
// application/octet-stream (belt-and-suspenders for some beacons)
app.use(express.raw({ type: 'application/octet-stream', limit: '64kb' }));

/** ---------- Request logger (helps you see preflights, origins, and content-type) ---------- */
app.use(function(req, res, next) {
  console.log(`[req] ${req.method} ${req.originalUrl} origin=${req.headers.origin || ''} ct=${req.headers['content-type'] || ''}`);
  next();
});

// ---------- CORS (robust origin parser) ----------
const allowedRootDomain = process.env.ALLOWED_ROOT_DOMAIN || 'robinsonandhenry.com';
const extraAllowedOrigins = (process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Safe hostname extractor (no URL constructor needed)
function getHostnameFromOrigin(orig) {
  if (!orig) return '';                           // null/undefined -> allow later
  var s = String(orig).trim().toLowerCase();
  // Strip protocol
  s = s.replace(/^https?:\/\//, '');
  // Drop path/query/hash if any
  s = s.split('/')[0] || s;
  // Drop port if any
  s = s.split(':')[0] || s;
  return s;
}

app.use(cors({
  origin: function (origin, cb) {
    // allow same-origin, server-to-server, or no Origin (beacons sometimes)
    if (!origin) return cb(null, true);

    const hostname = getHostnameFromOrigin(origin);

    // Base rule: *.allowedRootDomain
    const baseAllowed =
      hostname === allowedRootDomain ||
      hostname.endsWith('.' + allowedRootDomain);

    // Extra allowlist from env (accept domain or full URL)
    const extraAllowed = extraAllowedOrigins.some(function (o) {
      var h = getHostnameFromOrigin(o);
      return hostname === h || hostname.endsWith('.' + h);
    });

    if (baseAllowed || extraAllowed) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  maxAge: 86400
}));

// Important: let cors() respond to preflights with ACAO headers
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

  if ('session_id' in p && p.session_id !== '' && typeof p.session_id !== 'number') return 'session_id must be number or empty';
  if ('event_params' in p && p.event_params && typeof p.event_params !== 'object') return 'event_params must be object';

  if (p.event_params && JSON.stringify(p.event_params).length > 8192) return 'event_params too large';

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

  // Reject truly empty bodies so you know why things are blank
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

/** ---------- Process signals (logs if the platform kills the app) ---------- */
process.on('unhandledRejection', r => console.error('UNHANDLED REJECTION:', r));
process.on('uncaughtException', e => console.error('UNCAUGHT EXCEPTION:', e));
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT');  process.exit(0); });

/** ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Allowed domain: ${allowedRootDomain}`);
  if (extraAllowedOrigins.length) console.log(`Extra allowed origins: ${extraAllowedOrigins.join(', ')}`);
});
