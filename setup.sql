-- To be run in supabase on prefrebly a new database to avoid any issues

CREATE TABLE IF NOT EXISTS events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT        NOT NULL UNIQUE,
  name                TEXT        NOT NULL,
  date_type           TEXT        NOT NULL CHECK (date_type IN ('specific', 'days')),
  dates               TEXT[]      NOT NULL,
  start_hour          INTEGER     NOT NULL CHECK (start_hour >= 0 AND start_hour <= 23),
  end_hour            INTEGER     NOT NULL CHECK (end_hour >= 1 AND end_hour <= 24),
  admin_password_hash TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration for databases created before last_activity existed
ALTER TABLE events ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS participants (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  password_hash TEXT,
  availability  TEXT[]      NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS participants_event_name
  ON participants (event_id, name);

CREATE INDEX IF NOT EXISTS participants_event_id
  ON participants (event_id);

CREATE INDEX IF NOT EXISTS events_code
  ON events (code);

-- RLS on with no policies: the anon/authenticated keys get no access at all.
-- The server uses the service_role key, which bypasses RLS, so the app is unaffected.
ALTER TABLE events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
