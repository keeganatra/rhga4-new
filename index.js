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

app.get('/', (req, res) => {
  res.send('Zapier-only proxy is running 🚀');
});

app.post('/', async (req, res) => {
  const payload = req.body;

  console.log('Received payload:', payload);

  try {
    if (ZAPIER_WEBHOOK_URL) {
      await axios.post(ZAPIER_WEBHOOK_URL, payload);
      console.log('✅ Forwarded to Zapier');
      res.status(200).send('✅ Sent to Zapier');
    } else {
      console.warn('⚠️ No ZAPIER_WEBHOOK_URL set');
      res.status(500).send('ZAPIER_WEBHOOK_URL not configured');
    }
  } catch (err) {
    console.error('❌ Error sending to Zapier:', err.message);
    res.status(500).json({ error: 'Zapier forwarding failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
