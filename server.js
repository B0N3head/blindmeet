import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { decodeDates } from './codec.js';

const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function generateCode(len = 9) {
  const bytes = randomBytes(len);
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const ORIGIN = (process.env.ORIGIN || 'http://localhost:3003').replace(/\/$/, '');
const eventHtml = readFileSync(path.join(__dirname, 'public', 'event.html'), 'utf8');

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
  
// Number of reverse proxies in front of the app (or 'loopback', an IP list, etc).
// Must match the real deployment or clients can spoof their IP via X-Forwarded-For.
function parseTrustProxy(v) {
  if (v === undefined || v === '') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LIM = {
  eventName: 200,
  password: 1000,
  adminPasswordMin: 8,
  participantName: 100,
  maxDates: 60,
  dateRangeStr: 16,
  maxAvailEntries: 60,
  availEntryStr: 28,
};

const DATE_RANGE_RE = /^\d{4}-\d{2}-\d{2}\/\d+$/;
const DAY_NAMES = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
// Key is a YYYY-MM-DD date for 'specific' events, or a day name for 'days' events
const AVAIL_RE = /^(\d{4}-\d{2}-\d{2}|Sun|Mon|Tue|Wed|Thu|Fri|Sat):[A-Za-z0-9+/]+=*$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_IDLE_MS = 30 * DAY_MS;      // 'days' events: deleted after 30 days without activity
const ARCHIVE_MS = 7 * DAY_MS;         // 'specific' events: kept 7 days after the last date
const VIEW_EXTEND_MS = DAY_MS;         // ...and at least 24h after the most recent activity
const TOUCH_INTERVAL = 10 * 60 * 1000; // throttle last_activity writes per event
const lastTouch = new Map();

// Records activity on an event; returns the latest activity time known in memory (ms)
function touchEvent(eventId) {
  const now = Date.now();
  const prev = lastTouch.get(eventId) || 0;
  if (now - prev < TOUCH_INTERVAL) return prev;
  if (lastTouch.size > 10000) lastTouch.clear();
  lastTouch.set(eventId, now);
  supabase.from('events').update({ last_activity: new Date(now).toISOString() }).eq('id', eventId)
    .then(({ error }) => { if (error) console.error('Activity update failed:', eventId, error.message); });
  return now;
}

// Throws on malformed 'specific' dates
function lifecycle(ev, activeMs = 0) {
  const active = Math.max(Date.parse(ev.last_activity || ev.created_at) || 0, activeMs);
  if (ev.date_type === 'days') return { archived: false, deleteAt: active + DAYS_IDLE_MS };
  const lastDate = decodeDates(ev.dates || []).sort().pop();
  const endsAt = Date.parse(lastDate + 'T00:00:00Z') + DAY_MS;
  return {
    archived: Date.now() >= endsAt,
    deleteAt: Math.max(endsAt + ARCHIVE_MS, active + VIEW_EXTEND_MS),
  };
}

const FLUSH_DELAY = 3000;
const MAX_PENDING = 500;
const pendingSaves = new Map();

function strOk(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }

// Password guess limiting. `scope` is e.g. 'admin:<code>' or 'join:<code>'.
// Per IP: MAX_FAILS wrong guesses, then locked out for LOCKOUT_MS.
// Per event (all IPs combined): EVENT_MAX_FAILS wrong guesses per EVENT_WINDOW_MS,
// so rotating IPs doesn't give unlimited guesses.
const MAX_FAILS = 4;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const EVENT_MAX_FAILS = 20;
const EVENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rlMap = new Map();
const eventFailMap = new Map();

setInterval(() => {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  for (const [k, v] of rlMap) {
    if (v.lastSeen < cutoff) rlMap.delete(k);
  }
  for (const [k, v] of eventFailMap) {
    if (now - v.start >= EVENT_WINDOW_MS) eventFailMap.delete(k);
  }
}, 30 * 60 * 1000).unref();

function rlEntry(ip, scope) { return `${ip}:${scope}`; }

// Returns seconds until guessing is allowed again, or null if allowed now
function rlCheck(ip, scope) {
  const now = Date.now();
  const ev = eventFailMap.get(scope);
  if (ev && now - ev.start < EVENT_WINDOW_MS && ev.count >= EVENT_MAX_FAILS)
    return Math.ceil((ev.start + EVENT_WINDOW_MS - now) / 1000);

  const e = rlMap.get(rlEntry(ip, scope));
  if (!e) return null;
  if (e.lockedUntil && now < e.lockedUntil) return Math.ceil((e.lockedUntil - now) / 1000);
  if (e.lockedUntil && now >= e.lockedUntil) rlMap.delete(rlEntry(ip, scope)); // expired
  return null;
}

// Records a wrong guess; returns guesses left for this IP before lockout
function rlFail(ip, scope) {
  const now = Date.now();
  let ev = eventFailMap.get(scope);
  if (!ev || now - ev.start >= EVENT_WINDOW_MS) ev = { count: 0, start: now };
  ev.count++;
  eventFailMap.set(scope, ev);

  const key = rlEntry(ip, scope);
  const e = rlMap.get(key) || { fails: 0, lockedUntil: null, lastSeen: 0 };
  e.fails++;
  e.lastSeen = now;
  e.lockedUntil = e.fails >= MAX_FAILS ? now + LOCKOUT_MS : null;
  rlMap.set(key, e);
  if (ev.count >= EVENT_MAX_FAILS) return 0;
  return MAX_FAILS - e.fails;
}

function rlReset(ip, scope) { rlMap.delete(rlEntry(ip, scope)); }

function tooMany(res, secs) {
  const mins = Math.ceil(secs / 60);
  return res.status(429).json({
    error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
    retryAfter: secs,
  });
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/e/:code', async (req, res) => {
  const { data: event } = await supabase
    .from('events')
    .select('name')
    .eq('code', req.params.code)
    .maybeSingle();

  const pageUrl = `${ORIGIN}/e/${req.params.code}`;
  const title = event
    ? `${event.name} - BlindMeet`
    : 'BlindMeet - Group scheduling made simple';
  const desc = event
    ? `Add your availability for "${event.name}" on BlindMeet.`
    : 'Create a free availability poll and find the best time for everyone.';

  const e = escHtml;
  const meta = [
    `<meta name="description" content="${e(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${e(pageUrl)}">`,
    `<meta property="og:title" content="${e(title)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    `<meta property="og:image" content="${ORIGIN}/preview.png">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(title)}">`,
    `<meta name="twitter:description" content="${e(desc)}">`,
    `<meta name="twitter:image" content="${ORIGIN}/preview.png">`,
  ].join('\n  ');

  const html = eventHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${e(title)}</title>`)
    .replace('</head>', `  ${meta}\n</head>`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.post('/api/events', async (req, res) => {
  const { name, date_type, dates, start_hour, end_hour, admin_password } = req.body;

  if (!strOk(name, LIM.eventName)) return res.status(400).json({ error: 'Invalid event name' });
  if (!strOk(admin_password, LIM.password)) return res.status(400).json({ error: 'Invalid admin password' });
  if (admin_password.length < LIM.adminPasswordMin)
    return res.status(400).json({ error: `Admin password must be at least ${LIM.adminPasswordMin} characters` });
  if (!['specific', 'days'].includes(date_type)) return res.status(400).json({ error: 'Invalid date type' });
  if (!Array.isArray(dates) || dates.length === 0) return res.status(400).json({ error: 'No dates provided' });
  if (dates.length > LIM.maxDates) return res.status(400).json({ error: 'Too many date entries' });

  if (date_type === 'specific') {
    if (dates.some(d => typeof d !== 'string' || d.length > LIM.dateRangeStr || !DATE_RANGE_RE.test(d)))
      return res.status(400).json({ error: 'Invalid date entry' });
    let decoded;
    try { decoded = decodeDates(dates); } catch { return res.status(400).json({ error: 'Invalid date ranges' }); }
    if (decoded.length === 0 || decoded.length > LIM.maxDates)
      return res.status(400).json({ error: `Max ${LIM.maxDates} dates` });
  } else {
    if (dates.some(d => !DAY_NAMES.has(d))) return res.status(400).json({ error: 'Invalid day name' });
  }

  if (start_hour == null || end_hour == null) return res.status(400).json({ error: 'Missing time range' });
  if (start_hour >= end_hour) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  const admin_password_hash = await bcrypt.hash(admin_password, 10);

  let code = generateCode();
  const { data: clash } = await supabase.from('events').select('id').eq('code', code).maybeSingle();
  if (clash) code = generateCode();

  const { data, error } = await supabase
    .from('events')
    .insert({ name, date_type, dates, start_hour, end_hour, admin_password_hash, code })
    .select('code')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ code: data.code });
});

app.get('/api/events/:code', async (req, res) => {
  const { data, error } = await supabase
    .from('events')
    .select('id, name, date_type, dates, start_hour, end_hour, code, created_at, last_activity')
    .eq('code', req.params.code)
    .single();

  if (error) return res.status(404).json({ error: 'Event not found' });
  const { created_at, last_activity, ...event } = data;
  try {
    const { archived, deleteAt } = lifecycle(data, touchEvent(data.id));
    event.archived = archived;
    event.delete_at = new Date(deleteAt).toISOString();
  } catch { /* malformed dates: omit lifecycle info */ }
  res.json(event);
});

app.post('/api/events/:code/join', async (req, res) => {
  const { name, password } = req.body;

  if (!strOk(name, LIM.participantName)) return res.status(400).json({ error: 'Name is required (max 100 chars)' });
  if (password !== undefined && !strOk(password, LIM.password)) return res.status(400).json({ error: 'Invalid password' });

  const { data: event } = await supabase
    .from('events').select('id').eq('code', req.params.code).single();
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const eventId = event.id;
  touchEvent(eventId);

  const { data: existing } = await supabase
    .from('participants')
    .select('id, password_hash, availability')
    .eq('event_id', eventId)
    .eq('name', name)
    .maybeSingle();

  if (existing) {
    if (existing.password_hash) {
      if (!password) return res.status(401).json({ error: 'This name is password-protected' });
      const ip = req.ip || 'unknown';
      const scope = 'join:' + req.params.code;
      const secsLeft = rlCheck(ip, scope);
      if (secsLeft !== null) return tooMany(res, secsLeft);
      const ok = await bcrypt.compare(password, existing.password_hash);
      if (!ok) {
        const remaining = rlFail(ip, scope);
        if (remaining <= 0) return tooMany(res, rlCheck(ip, scope) ?? LOCKOUT_MS / 1000);
        return res.status(401).json({
          error: `Wrong password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`,
        });
      }
      rlReset(ip, scope);
    }
    return res.json({ participant_id: existing.id, availability: existing.availability || [] });
  }

  const hash = password ? await bcrypt.hash(password, 10) : null;
  const { data, error } = await supabase
    .from('participants')
    .insert({ event_id: eventId, name, password_hash: hash, availability: [] })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ participant_id: data.id, availability: [] });
});

app.put('/api/participants/:id/availability', (req, res) => {
  const { availability } = req.body;
  const participantId = req.params.id;

  if (!Array.isArray(availability))
    return res.status(400).json({ error: 'availability must be an array' });
  if (availability.length > LIM.maxAvailEntries)
    return res.status(400).json({ error: 'Too many availability entries' });
  if (availability.some(s => typeof s !== 'string' || s.length > LIM.availEntryStr || !AVAIL_RE.test(s)))
    return res.status(400).json({ error: 'Invalid availability format' });

  const existing = pendingSaves.get(participantId);
  if (!existing && pendingSaves.size >= MAX_PENDING)
    return res.status(429).json({ error: 'Too many pending saves, try again shortly' });
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    pendingSaves.delete(participantId);
    const { data, error } = await supabase
      .from('participants')
      .update({ availability })
      .eq('id', participantId)
      .select('event_id')
      .maybeSingle();
    if (error) console.error('Deferred availability save failed:', participantId, error.message);
    else if (data) touchEvent(data.event_id);
  }, FLUSH_DELAY);

  pendingSaves.set(participantId, { availability, timer });
  res.json({ ok: true });
});

app.post('/api/events/:code/admin', async (req, res) => {
  const { admin_password } = req.body;
  if (!strOk(admin_password, LIM.password)) return res.status(400).json({ error: 'Password required' });

  const ip = req.ip || 'unknown';
  const code = req.params.code;

  const scope = 'admin:' + code;
  const secsLeft = rlCheck(ip, scope);
  if (secsLeft !== null) return tooMany(res, secsLeft);

  const { data: event } = await supabase
    .from('events')
    .select('id, admin_password_hash')
    .eq('code', code)
    .single();

  if (!event) return res.status(404).json({ error: 'Event not found' });

  const ok = await bcrypt.compare(admin_password, event.admin_password_hash);
  if (!ok) {
    const remaining = rlFail(ip, scope);
    if (remaining <= 0) return tooMany(res, rlCheck(ip, scope) ?? LOCKOUT_MS / 1000);
    return res.status(401).json({
      error: `Wrong admin password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`,
    });
  }

  rlReset(ip, scope);
  touchEvent(event.id);

  const { data: participants } = await supabase
    .from('participants')
    .select('name, availability')
    .eq('event_id', event.id);

  res.json({ participants: participants || [] });
});

async function cleanupExpiredEvents() {
  const { data: events, error: fetchErr } = await supabase
    .from('events')
    .select('id, date_type, dates, created_at, last_activity');

  if (fetchErr) { console.error('Cleanup fetch error:', fetchErr.message); return; }
  if (!events || events.length === 0) return;

  const now = Date.now();
  const expiredIds = [];

  for (const ev of events) {
    try {
      if (lifecycle(ev, lastTouch.get(ev.id)).deleteAt <= now) expiredIds.push(ev.id);
    } catch { /* skip malformed rows */ }
  }

  if (expiredIds.length === 0) return;

  const { error: delErr } = await supabase
    .from('events')
    .delete()
    .in('id', expiredIds);

  if (delErr) console.error('Cleanup delete error:', delErr.message);
  else console.log(`Cleanup: removed ${expiredIds.length} expired event(s)`);
}

setTimeout(cleanupExpiredEvents, 30_000);
setInterval(cleanupExpiredEvents, 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`blindmeet up @ http://localhost:${PORT}`));
