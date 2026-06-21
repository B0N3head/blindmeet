import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import path from 'path';

const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function generateCode(len = 9) {
  const bytes = randomBytes(len);
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Trust the first hop's X-Forwarded-For so req.ip works behind nginx/Cloudflare
app.set('trust proxy', 1);

// Hard cap on body size — prevents sending a 10 MB password to bcrypt
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Input limits ──────────────────────────────────────────────────────────────
const LIM = {
  eventName:    200,
  password:     1000,
  participantName: 100,
  maxDates:     60,
  dateStr:      20,
  maxSlots:     3000,  // 60 dates × 48 half-hours = 2 880 theoretical max
  slotKey:      40,
};

function strOk(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }

// ── Admin rate limiter (in-memory; swap for Redis in multi-instance deploys) ──
// Keyed by "ip:eventCode". After ADMIN_MAX_FAILS bad guesses the IP is locked
// out for LOCKOUT_MS. A correct password clears the counter immediately.

const ADMIN_MAX_FAILS  = 5;
const LOCKOUT_MS       = 15 * 60 * 1000; // 15 minutes

const rlMap = new Map(); // key → { fails, lockedUntil, lastSeen }

// Clean up idle entries every 30 minutes so the Map doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour idle = evict
  for (const [k, v] of rlMap) {
    if (v.lastSeen < cutoff) rlMap.delete(k);
  }
}, 30 * 60 * 1000).unref(); // .unref() lets the process exit cleanly

function rlEntry(ip, code) { return `${ip}:${code}`; }

/** Returns seconds remaining in lockout, or null if the request is allowed. */
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
  const e   = rlMap.get(key) || { fails: 0, lockedUntil: null, lastSeen: 0 };
  e.fails++;
  e.lastSeen   = Date.now();
  e.lockedUntil = e.fails >= ADMIN_MAX_FAILS ? Date.now() + LOCKOUT_MS : null;
  rlMap.set(key, e);
  return e.fails;
}

function adminRLReset(ip, code) { rlMap.delete(rlEntry(ip, code)); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Serve event page for /e/:code routes
app.get('/e/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'event.html'));
});

// ── Events ────────────────────────────────────────────────────────────────────

app.post('/api/events', async (req, res) => {
  const { name, date_type, dates, start_hour, end_hour, admin_password } = req.body;

  if (!strOk(name, LIM.eventName))          return res.status(400).json({ error: 'Invalid event name' });
  if (!strOk(admin_password, LIM.password)) return res.status(400).json({ error: 'Invalid admin password' });
  if (!['specific','days'].includes(date_type))       return res.status(400).json({ error: 'Invalid date type' });
  if (!Array.isArray(dates) || dates.length === 0)    return res.status(400).json({ error: 'No dates provided' });
  if (dates.length > LIM.maxDates)                    return res.status(400).json({ error: `Max ${LIM.maxDates} dates` });
  if (dates.some(d => !strOk(d, LIM.dateStr)))        return res.status(400).json({ error: 'Invalid date entry' });
  if (start_hour == null || end_hour == null)          return res.status(400).json({ error: 'Missing time range' });
  if (start_hour >= end_hour) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  const admin_password_hash = await bcrypt.hash(admin_password, 10);

  // Generate a unique short code (collision astronomically unlikely, but retry once just in case)
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

// ── Participants ──────────────────────────────────────────────────────────────

app.post('/api/events/:code/join', async (req, res) => {
  const { name, password } = req.body;

  if (!strOk(name, LIM.participantName)) return res.status(400).json({ error: 'Name is required (max 100 chars)' });
  if (password !== undefined && !strOk(password, LIM.password)) return res.status(400).json({ error: 'Invalid password' });

  // Resolve code → UUID
  const { data: event } = await supabase
    .from('events').select('id').eq('code', req.params.code).single();
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const eventId = event.id;

  // Check if name already exists in this event
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

  // New participant
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const { data, error } = await supabase
    .from('participants')
    .insert({ event_id: eventId, name, password_hash: hash, availability: [] })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ participant_id: data.id, availability: [] });
});

app.put('/api/participants/:id/availability', async (req, res) => {
  const { availability } = req.body;

  if (!Array.isArray(availability))                return res.status(400).json({ error: 'availability must be an array' });
  if (availability.length > LIM.maxSlots)          return res.status(400).json({ error: 'Too many slots' });
  if (availability.some(s => !strOk(s, LIM.slotKey))) return res.status(400).json({ error: 'Invalid slot key' });

  // Verify the participant exists before writing — prevents arbitrary UUID writes
  const { data: participant } = await supabase
    .from('participants')
    .select('id')
    .eq('id', req.params.id)
    .single();

  if (!participant) return res.status(404).json({ error: 'Participant not found' });

  const { error } = await supabase
    .from('participants')
    .update({ availability })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.post('/api/events/:code/admin', async (req, res) => {
  const { admin_password } = req.body;
  if (!strOk(admin_password, LIM.password)) return res.status(400).json({ error: 'Password required' });

  const ip  = req.ip || 'unknown';
  const code = req.params.code;

  // Rate limit check — before the DB hit so we don't burn bcrypt on locked IPs
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

  adminRLReset(ip, code); // correct password — clear the counter

  const { data: participants } = await supabase
    .from('participants')
    .select('name, availability')
    .eq('event_id', event.id);

  res.json({ participants: participants || [] });
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BlindMeet → http://localhost:${PORT}`));
