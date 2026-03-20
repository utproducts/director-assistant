/**
 * UBN USSSA Poller — Cloudflare Worker
 * =====================================
 * Runs every 10 minutes via Cron Trigger.
 * Pulls event data from USSSA Director Center and writes to Supabase.
 *
 * SETUP:
 * 1. Create this Worker in Cloudflare dashboard
 * 2. Add environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * 3. Add Cron Trigger: */10 * * * * (every 10 minutes)
 * 4. Save USSSA cookies via the Director Assistant UI (/setup page)
 */

const USSSA_API = 'https://dc.usssa.com/api/';
const USSSA_ENGINE = 'https://engine.usssa.com/sports/';

const DIRECTOR_REGION_MAP = {
  'Cory Perreault': 'AZ1',
  'Steve Hassett': 'FL1',
  'Sebastian Hassett': 'FL1',
  'Darrell Hannaseck': 'FL1',
  'Darrel Hannaseck': 'FL1',
  'Roger Miller': 'FL1',
  'Scott Rutherford': 'FL1',
  'Jeremy Huffman': 'CA1',
  'Enrique Guillen': 'CA2',
  'Bob Egr': 'IA1',
  'Kale Egr': 'IA1',
  'Dillon Egr': 'IA1',
  'Ryan Highfill': 'KS1',
  'Frank Griffin': 'LA1',
  'TJ Russell': 'LA1',
  'Cody Whitehead': 'TX1',
  'North Carolina State Office': 'NCTB',
};

export default {
  // HTTP handler (for manual triggers)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/poll') {
      const result = await pollUSSSA(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    if (url.pathname === '/status') {
      const result = await getStatus(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    return new Response('UBN USSSA Poller\n\nGET /status - Check status\nGET /poll - Trigger manual poll\n\nCron: every 10 minutes', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // Cron handler (runs every 10 minutes)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollUSSSA(env));
  }
};

async function getStatus(env) {
  const res = await supabaseQuery(env, 'usssa_poll_log', 'select=*&order=poll_time.desc&limit=5');
  return { recentPolls: res, workerActive: true };
}

async function pollUSSSA(env) {
  const startTime = Date.now();
  let eventsCount = 0;
  let entriesCount = 0;
  let errors = [];

  try {
    // 1. Get cookies from Supabase config
    const configRes = await supabaseQuery(env, 'usssa_config', 'select=cookies&id=eq.1');
    const cookies = configRes?.[0]?.cookies;

    if (!cookies || Object.keys(cookies).length === 0) {
      await logPoll(env, 'error', 0, 0, 'No USSSA cookies configured', Date.now() - startTime);
      return { status: 'error', message: 'No cookies configured. Use Director Assistant setup page.' };
    }

    // Build cookie string
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    // 2. Fetch events from USSSA
    try {
      const eventsHtml = await fetchUSSSAEvents(cookieStr);
      const events = parseEventsFromHTML(eventsHtml);
      if (events.length > 0) {
        await upsertEvents(env, events);
        eventsCount = events.length;
      } else {
        errors.push('No events parsed (session may have expired)');
      }
    } catch (e) {
      errors.push(`Events: ${e.message}`);
    }

    // 3. Fetch latest entries
    try {
      const entriesHtml = await fetchLatestEntries(cookieStr);
      const entries = parseEntriesFromHTML(entriesHtml);
      if (entries.length > 0) {
        await insertEntries(env, entries);
        entriesCount = entries.length;
      }
    } catch (e) {
      errors.push(`Entries: ${e.message}`);
    }

    const status = errors.length === 0 ? 'success' : 'partial';
    const duration = Date.now() - startTime;
    await logPoll(env, status, eventsCount, entriesCount, errors.join('; '), duration);

    return { status, eventsCount, entriesCount, errors, durationMs: duration };

  } catch (e) {
    const duration = Date.now() - startTime;
    await logPoll(env, 'error', 0, 0, e.message, duration);
    return { status: 'error', message: e.message, durationMs: duration };
  }
}

// ===== USSSA API Calls =====

async function fetchUSSSAEvents(cookieStr, season = 2026, sportId = 11) {
  const payload = `json=${encodeURIComponent(JSON.stringify({
    rows: 500,
    filter: {
      sportID: sportId,
      season: season,
      showMine: true,
      month: '',
      stateID: '',
      eventID: '',
      directorName: ''
    }
  }))}`;

  const resp = await fetch(`${USSSA_API}?action=eventsTable`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: payload,
  });

  if (!resp.ok) throw new Error(`USSSA events API returned ${resp.status}`);
  return await resp.text();
}

async function fetchLatestEntries(cookieStr) {
  const resp = await fetch(`${USSSA_ENGINE}OnlineEntries.asp`, {
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  });

  if (!resp.ok) throw new Error(`USSSA entries API returned ${resp.status}`);
  return await resp.text();
}

// ===== HTML Parsers =====

function parseEventsFromHTML(html) {
  const events = [];

  // Try JSON first (API might return JSON array)
  try {
    const parsed = JSON.parse(html);
    if (Array.isArray(parsed)) {
      return parsed.map(e => ({
        event_id: String(e.eventID || e.event_id || ''),
        event_name: e.eventName || e.event_name || '',
        state: e.state || '',
        location: e.location || '',
        start_date: e.startDate || e.start_date || '',
        divisions_filled: e.divisionsFilled || e.divisions_filled || '',
        stature: e.stature || '',
        teams_placed: e.teamsPlaced || e.teams_placed || '',
        director: e.director || '',
        region: DIRECTOR_REGION_MAP[e.director] || 'UNKNOWN',
        entry_due: e.entryDue || e.entry_due || '',
        gate_due: e.gateDue || e.gate_due || '',
        other_due: e.otherDue || e.other_due || '',
        total_due: e.totalDue || e.total_due || '',
        event_status: e.eventStatus || e.event_status || '',
        progress: e.progress || '',
        season: 2026,
      }));
    }
  } catch (e) { /* Not JSON, try HTML */ }

  // Parse HTML table rows
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripTags = s => s.replace(/<[^>]+>/g, '').trim();

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    const cellStr = rowMatch[1];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = cellRe.exec(cellStr)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }

    if (cells.length < 10) continue;
    const eventId = cells[0];
    if (!/^\d{5,6}$/.test(eventId)) continue;

    const director = cells[10] || '';
    events.push({
      event_id: eventId,
      state: cells[1] || '',
      location: cells[2] || '',
      start_date: cells[3] || '',
      event_name: cells[4] || '',
      divisions_filled: cells[5] || '',
      stature: cells[6] || '',
      teams_placed: cells[7] || '',
      director: director,
      region: DIRECTOR_REGION_MAP[director] || 'UNKNOWN',
      entry_due: cells[11] || '',
      gate_due: cells[12] || '',
      other_due: cells[13] || '',
      total_due: cells[14] || '',
      event_status: cells[15] || '',
      progress: '',
      season: 2026,
    });
  }

  return events;
}

function parseEntriesFromHTML(html) {
  const entries = [];
  const rowRegex = /<tr[^>]*bgcolor[^>]*>([\s\S]*?)<\/tr>/gi;
  const stripTags = s => s.replace(/<[^>]+>/g, '').trim();
  const linkText = s => { const m = s.match(/<a[^>]*>([\s\S]*?)<\/a>/); return m ? stripTags(m[1]) : stripTags(s); };

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(match[1])) !== null) cells.push(cm[1]);

    if (cells.length < 6) continue;
    const entryDate = stripTags(cells[0]);
    if (!/\d+\/\d+\/\d+/.test(entryDate)) continue;

    const tournament = linkText(cells[3] || '');
    const team = linkText(cells[4] || '');
    const divMatch = tournament.match(/\(([^)]+)\)/);

    entries.push({
      entry_date: entryDate,
      payment_date: stripTags(cells[1] || ''),
      start_date: stripTags(cells[2] || ''),
      team_num: stripTags(cells[3] || '').split(')')[0]?.split('(').pop() || '',
      tournament: tournament,
      division: divMatch ? divMatch[1] : '',
      team_name: team,
      status: stripTags(cells[5] || ''),
    });
  }

  return entries;
}

// ===== Supabase Helpers =====

async function supabaseQuery(env, table, query) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    }
  });
  if (!resp.ok) throw new Error(`Supabase ${table} query failed: ${resp.status}`);
  return await resp.json();
}

async function upsertEvents(env, events) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/usssa_events`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(events.map(e => ({ ...e, updated_at: new Date().toISOString() }))),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upsert events failed: ${resp.status} - ${text}`);
  }
}

async function insertEntries(env, entries) {
  // Only insert entries we haven't seen before (dedupe by entry_date + team_name + tournament)
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/usssa_registrations`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(entries),
  });
  // Ignore duplicate errors (409) since entries accumulate
  if (!resp.ok && resp.status !== 409) {
    const text = await resp.text();
    throw new Error(`Insert entries failed: ${resp.status} - ${text}`);
  }
}

async function logPoll(env, status, eventsCount, entriesCount, errorMessage, durationMs) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/usssa_poll_log`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status,
        events_count: eventsCount,
        entries_count: entriesCount,
        error_message: errorMessage || null,
        duration_ms: durationMs,
      }),
    });
  } catch (e) {
    console.error('Failed to log poll:', e);
  }
}
