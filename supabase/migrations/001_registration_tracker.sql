-- ============================================================
-- UBN Registration Tracker - Supabase Tables
-- ============================================================
-- Run this in your Supabase SQL Editor to create the tables
-- ============================================================

-- Events pulled from USSSA Director Center
CREATE TABLE IF NOT EXISTS usssa_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_name TEXT,
  state TEXT,
  location TEXT,
  start_date TEXT,
  divisions_filled TEXT,
  stature TEXT,
  teams_placed TEXT,
  director TEXT,
  region TEXT,
  entry_due TEXT,
  gate_due TEXT,
  other_due TEXT,
  total_due TEXT,
  event_status TEXT,
  progress TEXT,
  sport_id INTEGER DEFAULT 11,
  season INTEGER DEFAULT 2026,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, season)
);

-- Latest tournament entries (daily registrations)
CREATE TABLE IF NOT EXISTS usssa_registrations (
  id BIGSERIAL PRIMARY KEY,
  entry_date TEXT,
  payment_date TEXT,
  start_date TEXT,
  team_num TEXT,
  tournament TEXT,
  division TEXT,
  team_name TEXT,
  status TEXT,
  event_id TEXT,
  director TEXT,
  region TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Poll log to track USSSA sync history
CREATE TABLE IF NOT EXISTS usssa_poll_log (
  id BIGSERIAL PRIMARY KEY,
  poll_time TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL,  -- 'success', 'partial', 'error'
  events_count INTEGER DEFAULT 0,
  entries_count INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER
);

-- USSSA session cookie storage (encrypted at rest by Supabase)
CREATE TABLE IF NOT EXISTS usssa_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  cookies JSONB,
  poll_interval_minutes INTEGER DEFAULT 10,
  last_cookie_update TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default config row
INSERT INTO usssa_config (id, poll_interval_minutes)
VALUES (1, 10)
ON CONFLICT (id) DO NOTHING;

-- Director-to-region mapping table
CREATE TABLE IF NOT EXISTS usssa_director_regions (
  id BIGSERIAL PRIMARY KEY,
  director_name TEXT NOT NULL UNIQUE,
  region_code TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT true,
  is_usssa_affiliated BOOLEAN DEFAULT true
);

-- Populate director mappings
INSERT INTO usssa_director_regions (director_name, region_code, is_primary, is_usssa_affiliated) VALUES
  ('Cory Perreault', 'AZ1', true, true),
  ('Jeremy Huffman', 'CA1', true, true),
  ('Enrique Guillen', 'CA2', true, true),
  ('Steve Hassett', 'FL1', true, true),
  ('Sebastian Hassett', 'FL1', false, true),
  ('Darrell Hannaseck', 'FL1', false, true),
  ('Darrel Hannaseck', 'FL1', false, true),
  ('Roger Miller', 'FL1', false, true),
  ('Scott Rutherford', 'FL1', false, true),
  ('Bob Egr', 'IA1', true, true),
  ('Kale Egr', 'IA1', false, true),
  ('Dillon Egr', 'IA1', false, true),
  ('Ryan Highfill', 'KS1', true, true),
  ('Frank Griffin', 'LA1', true, true),
  ('TJ Russell', 'LA1', false, true),
  ('Cody Whitehead', 'TX1', true, true),
  ('North Carolina State Office', 'NCTB', true, false)
ON CONFLICT (director_name) DO UPDATE SET
  region_code = EXCLUDED.region_code,
  is_primary = EXCLUDED.is_primary,
  is_usssa_affiliated = EXCLUDED.is_usssa_affiliated;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_usssa_events_region ON usssa_events(region);
CREATE INDEX IF NOT EXISTS idx_usssa_events_season ON usssa_events(season);
CREATE INDEX IF NOT EXISTS idx_usssa_events_event_id ON usssa_events(event_id);
CREATE INDEX IF NOT EXISTS idx_usssa_registrations_event_id ON usssa_registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_usssa_registrations_entry_date ON usssa_registrations(entry_date);
CREATE INDEX IF NOT EXISTS idx_usssa_registrations_region ON usssa_registrations(region);

-- Enable RLS (Row Level Security)
ALTER TABLE usssa_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usssa_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usssa_poll_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE usssa_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE usssa_director_regions ENABLE ROW LEVEL SECURITY;

-- Policies: authenticated users can read all, service role can write
CREATE POLICY "Authenticated users can read events" ON usssa_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read registrations" ON usssa_registrations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read poll log" ON usssa_poll_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read config" ON usssa_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can update config" ON usssa_config FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can read director regions" ON usssa_director_regions FOR SELECT TO authenticated USING (true);

-- Service role policies for the Worker to write data
CREATE POLICY "Service can insert events" ON usssa_events FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service can update events" ON usssa_events FOR UPDATE TO service_role USING (true);
CREATE POLICY "Service can insert registrations" ON usssa_registrations FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service can insert poll log" ON usssa_poll_log FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service can update config" ON usssa_config FOR UPDATE TO service_role USING (true);
