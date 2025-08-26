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
