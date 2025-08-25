'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto'); // for request ids

const app = express();

/** ---------- Config ---------- */
const allowedRootDomain = process.env.ALLOWED_ROOT_DOMAIN || 'robinsonandhenry.com';
// add more comma-separated domains if needed (e.g., staging)
const extraAllowedOrigins = (process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// Keep payloads small and sane for beacons
app.use(express.json({ limit: '64kb', strict: true }));

/** ---------- CORS ---------- */
app.use(cors({
  origin: function (origin, callback) {
    // allow non-browser / same-origin / null origins (sendBeacon can present null in some contexts)
    if (!origin) return callback(null, true);

    try {
      const hostname = new URL(origin).hostname;

      const baseAllowed =
        hostname === allowedRootDomain ||
        hostname.endsWith('.' + allowedRootDomain);

      const extraAllowed = extraAllowedOrigins.some(o => {
        try {
          const h = new URL(o).hostname || o;
          return hostname === h || hostname.endsWith('.' + h);
        } catch { return hostname === o || hostname.endsWith('.' + o); }
      });

      if (baseAllowed || extraAllowed) return callback(null, true);
      return callback(new Error('Not allowed by CORS: ' + origin));
    } catch (err) {
      return callback(new Error('Invalid origin: ' + origin));
    }
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  maxAge: 86400 // cache preflight for a day
}));

// Explicit OPTIONS handler to short-circuit preflights quickly
app.options('*', (req, res) => res.sendStatus(204));

/** ---------- Health ---------- */
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.status(200).send('Zapier-only proxy is running 🚀'));

/** ---------- Minimal schema validator ---------- */
/* Keep this permissive; just prevent junk/oversized payloads */
function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'invalid body';
  // allow list common top-level keys; ignore extras but gate absurd payloads
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

  // basic type checks
  if ('session_id' in p && p.session_id !== '' && typeof p.session_id !== 'number') return 'session_id must be number or empty';
  if ('event_params' in p && p.event_params && typeof p.event_params !== 'object') return 'event_params must be object';

  // rough size gate on event_params to prevent abuse
  if (p.event_params && JSON.stringify(p.event_params).length > 8192) return 'event_params too large';

  // prune unknown top-level keys (optional)
  Object.keys(p).forEach(k => { if (!allowedTop.has(k)) delete p[k]; });

  return null;
}

/** ---------- Zapier client w/ timeouts & retry ---------- */
const zapier = axios.create({
  timeout: 5000, // 5s
  headers: { 'Content-Type': 'application/json' },
  validateStatus: s => s >= 200 && s < 500 // treat 5xx as errors
});

async function forwardToZapier(payload) {
  if (!ZAPIER_WEBHOOK_URL) throw new Error('ZAPIER_WEBHOOK_URL not configured');
  // one quick retry on transient 5xx
  try {
    const res = await zapier.post(ZAPIER_WEBHOOK_URL, payload);
    if (res.status >= 500) throw new Error('Zapier 5xx');
    return res.status;
  } catch (e) {
    // retry once
    const res2 = await zapier.post(ZAPIER_WEBHOOK_URL, payload);
    if (res2.status >= 500) throw new Error('Zapier 5xx (retry)');
    return res2.status;
  }
}

/** ---------- Collect endpoint ---------- */
// Prefer a dedicated path, but keep '/' for backward compatibility
app.post(['/', '/collect'], async (req, res) => {
  const rid = crypto.randomBytes(8).toString('hex');
  const payload = req.body;

  // Minimal logging (avoid PII)
  console.log(`[${rid}] recv event_type=${payload && payload.event_type} cid=${payload && payload.client_id} sid=${payload && payload.session_id}`);

  const errMsg = validatePayload(payload);
  if (errMsg) {
    console.warn(`[${rid}] validation failed: ${errMsg}`);
    return res.status(400).json({ error: errMsg });
  }

  try {
    const status = await forwardToZapier(payload);
    if (status >= 200 && status < 300) {
      // For sendBeacon callers, 204 No Content is ideal (no body)
      return res.sendStatus(204);
    }
    console.warn(`[${rid}] Zapier non-2xx: ${status}`);
    return res.status(502).json({ error: 'Bad gateway to Zapier', status });
  } catch (err) {
    console.error(`[${rid}] Zapier forwarding failed: ${err.message}`);
    return res.status(502).json({ error: 'Zapier forwarding failed' });
  }
});

/** ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Allowed domain: ${allowedRootDomain}`);
  if (extraAllowedOrigins.length) console.log(`Extra allowed origins: ${extraAllowedOrigins.join(', ')}`);
});
