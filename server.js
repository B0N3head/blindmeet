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

app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LIM = {
  eventName: 200,
  password: 1000,
  participantName: 100,
  maxDates: 60,
  dateRangeStr: 16,
  maxAvailEntries: 60,
  availEntryStr: 28,
};

const DATE_RANGE_RE = /^\d{4}-\d{2}-\d{2}\/\d+$/;
const DAY_NAMES = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const AVAIL_RE = /^\d{4}-\d{2}-\d{2}:[A-Za-z0-9+/]+=*$/;

const FLUSH_DELAY = 3000;
const MAX_PENDING = 500;
const pendingSaves = new Map();

function strOk(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }

const ADMIN_MAX_FAILS = 4;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const rlMap = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of rlMap) {
    if (v.lastSeen < cutoff) rlMap.delete(k);
  }
}, 30 * 60 * 1000).unref();

function rlEntry(ip, code) { return `${ip}:${code}`; }

function adminRLCheck(ip, code) {
  const e = rlMap.get(rlEntry(ip, code));
  if (!e) return null;
  const now = Date.now();
  if (e.lockedUntil && now < e.lockedUntil) return Math.ceil((e.lockedUntil - now) / 1000);
  if (e.lockedUntil && now >= e.lockedUntil) rlMap.delete(rlEntry(ip, code)); // expired
  return null;
}

function adminRLFail(ip, code) {
  const key = rlEntry(ip, code);
  const e = rlMap.get(key) || { fails: 0, lockedUntil: null, lastSeen: 0 };
  e.fails++;
  e.lastSeen = Date.now();
  e.lockedUntil = e.fails >= ADMIN_MAX_FAILS ? Date.now() + LOCKOUT_MS : null;
  rlMap.set(key, e);
  return e.fails;
}

function adminRLReset(ip, code) { rlMap.delete(rlEntry(ip, code)); }

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
    .select('id, name, date_type, dates, start_hour, end_hour, code')
    .eq('code', req.params.code)
    .single();

  if (error) return res.status(404).json({ error: 'Event not found' });
  res.json(data);
});

app.post('/api/events/:code/join', async (req, res) => {
  const { name, password } = req.body;

  if (!strOk(name, LIM.participantName)) return res.status(400).json({ error: 'Name is required (max 100 chars)' });
  if (password !== undefined && !strOk(password, LIM.password)) return res.status(400).json({ error: 'Invalid password' });

  const { data: event } = await supabase
    .from('events').select('id').eq('code', req.params.code).single();
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const eventId = event.id;

  const { data: existing } = await supabase
    .from('participants')
    .select('id, password_hash, availability')
    .eq('event_id', eventId)
    .eq('name', name)
    .maybeSingle();

  if (existing) {
    if (existing.password_hash) {
      if (!password) return res.status(401).json({ error: 'This name is password-protected' });
      const ok = await bcrypt.compare(password, existing.password_hash);
      if (!ok) return res.status(401).json({ error: 'Wrong password' });
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
    const { error } = await supabase
      .from('participants')
      .update({ availability })
      .eq('id', participantId);
    if (error) console.error('Deferred availability save failed:', participantId, error.message);
  }, FLUSH_DELAY);

  pendingSaves.set(participantId, { availability, timer });
  res.json({ ok: true });
});

app.post('/api/events/:code/admin', async (req, res) => {
  const { admin_password } = req.body;
  if (!strOk(admin_password, LIM.password)) return res.status(400).json({ error: 'Password required' });

  const ip = req.ip || 'unknown';
  const code = req.params.code;

  const secsLeft = adminRLCheck(ip, code);
  if (secsLeft !== null) {
    const mins = Math.ceil(secsLeft / 60);
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
      retryAfter: secsLeft,
    });
  }

  const { data: event } = await supabase
    .from('events')
    .select('id, admin_password_hash')
    .eq('code', code)
    .single();

  if (!event) return res.status(404).json({ error: 'Event not found' });

  const ok = await bcrypt.compare(admin_password, event.admin_password_hash);
  if (!ok) {
    const fails = adminRLFail(ip, code);
    const remaining = ADMIN_MAX_FAILS - fails;
    if (remaining <= 0) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${LOCKOUT_MS / 60000} minutes.`,
        retryAfter: LOCKOUT_MS / 1000,
      });
    }
    return res.status(401).json({
      error: `Wrong admin password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`,
    });
  }

  adminRLReset(ip, code);

  const { data: participants } = await supabase
    .from('participants')
    .select('name, availability')
    .eq('event_id', event.id);

  res.json({ participants: participants || [] });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`blindmeet up @ http://localhost:${PORT}`));
