/**
 * UBN USSSA Poller — Cloudflare Worker (Updated)
 * ================================================
 * Added: GET /divisions endpoint — returns live division data for all 63 events
 *        Caches results in KV (USSSA_DIVISIONS) for 1 hour
 * Fixed: pollUSSSA now iterates TARGET_EVENT_IDS directly (batch of 7 per cycle)
 *        instead of broken director-name filter that returned 0 events.
 * Runs every 10 minutes via Cron Trigger.
 */

const USSSA_API = 'https://dc.usssa.com/api/';
const ACCOUNT_ID = '15782127b37f9a925bbab8593969eac3';

// All 63 events in the tournament manager
const TARGET_EVENT_IDS = [
  410565,411024,410276,410277,410901,410570,410256,412331,409752,410564,
  410264,410524,411002,410572,410260,409753,410525,411003,410573,411027,
  410531,410985,410575,410265,410268,411007,410262,409754,412332,410534,
  410576,410577,409756,409755,409757,410257,410263,410535,410578,410579,
  411031,412333,409758,410581,410266,410258,413132,409759,411033,410536,
  410582,407745,410259,407746,408656,411008,408881,410542,411010,408659,
  411009,408658,408903
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const DIRECTOR_REGION_MAP = {
  'Cory Perreault': 'AZ1', 'Steve Hassett': 'FL1', 'Sebastian Hassett': 'FL1',
  'Darrell Hannaseck': 'FL1', 'Darrel Hannaseck': 'FL1', 'Roger Miller': 'FL1',
  'Scott Rutherford': 'FL1', 'Jeremy Huffman': 'CA1', 'Enrique Guillen': 'CA2',
  'Bob Egr': 'IA1', 'Kale Egr': 'IA1', 'Dillon Egr': 'IA1',
  'Ryan Highfill': 'KS1', 'Frank Griffin': 'LA1', 'TJ Russell': 'LA1',
  'Cody Whitehead': 'TX1', 'North Carolina State Office': 'NCTB',
  'Suncoast State Office': 'FL1', 'Suncoast Office': 'FL1',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // — GET /divisions ————————————————————————————————————————————————————————
    if (url.pathname === '/divisions') {
      try {
        const cached = env.USSSA_DIVISIONS ? await env.USSSA_DIVISIONS.get('all', { type: 'json' }) : null;
        const cacheAge = env.USSSA_DIVISIONS ? await env.USSSA_DIVISIONS.get('all_updated') : null;
        const ageMs = cacheAge ? Date.now() - parseInt(cacheAge) : Infinity;

        if (cached && ageMs < 3600000) {
          return new Response(JSON.stringify({
            status: 'ok', source: 'cache',
            updatedAt: new Date(parseInt(cacheAge)).toISOString(),
            divisions: cached
          }), { headers: CORS_HEADERS });
        }

        const fresh = await fetchAllDivisions(env);
        if (env.USSSA_DIVISIONS) {
          await env.USSSA_DIVISIONS.put('all', JSON.stringify(fresh));
          await env.USSSA_DIVISIONS.put('all_updated', String(Date.now()));
        }

        return new Response(JSON.stringify({
          status: 'ok', source: 'live',
          updatedAt: new Date().toISOString(),
          divisions: fresh
        }), { headers: CORS_HEADERS });

      } catch (e) {
        return new Response(JSON.stringify({ status: 'error', message: e.message }), {
          status: 500, headers: CORS_HEADERS
        });
      }
    }

    // — GET /divisions/refresh — force cache refresh ————————————————————————
    if (url.pathname === '/divisions/refresh') {
      try {
        const fresh = await fetchAllDivisions(env);
        if (env.USSSA_DIVISIONS) {
          await env.USSSA_DIVISIONS.put('all', JSON.stringify(fresh));
          await env.USSSA_DIVISIONS.put('all_updated', String(Date.now()));
        }
        const eventCount = Object.keys(fresh).length;
        const divCount = Object.values(fresh).reduce((s, d) => s + d.length, 0);
        return new Response(JSON.stringify({
          status: 'ok', message: `Refreshed ${eventCount} events, ${divCount} total divisions`,
          updatedAt: new Date().toISOString()
        }), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ status: 'error', message: e.message }), {
          status: 500, headers: CORS_HEADERS
        });
      }
    }

    // — GET /teams-search —————————————————————————————————————————————————————
    if (url.pathname === '/teams-search') {
      try {
        const age = url.searchParams.get('age') || '';
        const state = url.searchParams.get('state') || '';
        if (!age) return new Response(JSON.stringify({ status: 'error', message: 'age param required' }), { status: 400, headers: CORS_HEADERS });
        let qs = 'select=team_name,team_city,team_state,manager_name,manager_email,manager_phone,division,entry_status,payment_status&division=ilike.' + encodeURIComponent('%' + age + '%') + '&order=team_name.asc&limit=400';
        if (state && state !== 'all') qs += '&team_state=eq.' + encodeURIComponent(state);
        const resp = await fetch(env.SUPABASE_URL + '/rest/v1/usssa_registrations?' + qs, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' }
        });
        if (!resp.ok) throw new Error('Supabase ' + resp.status + ': ' + await resp.text());
        const rows = await resp.json();
        const seen = new Set();
        const teams = rows.filter(t => { if (seen.has(t.team_name)) return false; seen.add(t.team_name); return true; });
        return new Response(JSON.stringify({ status: 'ok', count: teams.length, teams }), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    // — Existing endpoints ————————————————————————————————————————————————————
    if (url.pathname === '/poll') {
      const result = await pollUSSSA(env);
      return new Response(JSON.stringify(result, null, 2), { headers: CORS_HEADERS });
    }
    if (url.pathname === '/status') {
      const result = await getStatus(env);
      return new Response(JSON.stringify(result, null, 2), { headers: CORS_HEADERS });
    }

    return new Response(
      'UBN USSSA Poller\n\nGET /divisions        — Live division data (1h cache)\nGET /divisions/refresh — Force cache refresh\nGET /teams-search     — Search teams by age/state\nGET /poll             — Trigger manual poll\nGET /status           — Check status',
      { headers: { 'Content-Type': 'text/plain' } }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollUSSSA(env));
  }
};

// — Fetch all 63 events' division data ————————————————————————————————————————
async function fetchAllDivisions(env) {
  const cookieStr = await getCookieStr(env);
  const results = {};

  const BATCH_SIZE = 10;
  for (let i = 0; i < TARGET_EVENT_IDS.length; i += BATCH_SIZE) {
    const batch = TARGET_EVENT_IDS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(eventId => fetchDivisionsForEvent(cookieStr, eventId))
    );
    batch.forEach((eventId, idx) => {
      results[String(eventId)] = batchResults[idx];
    });
  }

  return results;
}

async function fetchDivisionsForEvent(cookieStr, eventId) {
  try {
    const resp = await fetch(`${USSSA_API}?action=divisionTable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
      },
      body: `json=${encodeURIComponent(JSON.stringify({
        page: 1, rows: 50, sort: {},
        filter: { eventID: eventId }
      }))}`
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.status || !data.data) return [];

    return data.data.map(d => ({
      divID: String(d.divisionID),
      ageCode: (d.className || '').trim(),
      numTeams: d.numberOfTeams || 0,
      maxTeams: d.MaxTeams || 0,
      status: d.status || '',
    })).filter(d => d.divID && d.ageCode);
  } catch (e) {
    console.error(`fetchDivisions error for event ${eventId}:`, e.message);
    return [];
  }
}

async function getCookieStr(env) {
  const configRes = await supabaseQuery(env, 'usssa_config', 'select=cookies&id=eq.1');
  const cookies = configRes?.[0]?.cookies;
  if (!cookies || Object.keys(cookies).length === 0) {
    throw new Error('No USSSA cookies configured in Supabase usssa_config');
  }
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// — Poll status ———————————————————————————————————————————————————————————————
async function getStatus(env) {
  const res = await supabaseQuery(env, 'usssa_poll_log', 'select=*&order=poll_time.desc&limit=5');
  return { recentPolls: res, workerActive: true };
}

// — pollUSSSA: iterates TARGET_EVENT_IDS directly, batch of 2 per cycle —
// Subrequest budget per invocation (limit = 50):
//   1  getCookieStr
//   per event (×2): 1 fetchDivisions + N fetchTeams (parallel) + 1 precheck + 1 insert = N+3
//   1  logPoll
// Total: 2 + 2*(N+3) = 2N+8  →  for N=20 divs: 48 — safely under 50
async function pollUSSSA(env) {
  const startTime = Date.now();
  let registrationsCount = 0;
  let errors = [];
  let debug = [];

  try {
    const cookieStr = await getCookieStr(env);

    // Pick a batch of 2 event IDs based on the current 10-minute cycle index.
    // Covers all 63 events across ~32 cycles (~5.3 hours total).
    const BATCH_SIZE = 2;
    const cycleIndex = Math.floor(Date.now() / 600000);
    const startIdx = (cycleIndex * BATCH_SIZE) % TARGET_EVENT_IDS.length;
    const eventIdBatch = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      eventIdBatch.push(TARGET_EVENT_IDS[(startIdx + i) % TARGET_EVENT_IDS.length]);
    }

    for (const eventId of eventIdBatch) {
      try {
        const divisions = await fetchDivisionsForEvent(cookieStr, eventId);
        if (divisions.length === 0) continue;

        const event = {
          event_id: String(eventId),
          event_name: `Event ${eventId}`,
          start_date: '',
          region: 'UNKNOWN',
          director: '',
        };

        // Fetch ALL division teams in parallel — one subrequest per division
        const teamArrays = await Promise.all(
          divisions.map(async (division) => {
            try {
              const teamsResp = await fetchUSSSATeams(cookieStr, parseInt(division.divID));
              const teams = parseTeamsResponse(teamsResp, event, {
                division_id: division.divID,
                division_name: division.ageCode,
              });
              debug.push(`Div ${division.divID}(${division.ageCode}): raw="${(teamsResp||'').slice(0,80)}" parsed=${teams.length}`);
              return teams;
            } catch (e) {
              errors.push(`Div ${division.divID}: ${e.message}`);
              return [];
            }
          })
        );

        // Combine all divisions into one array, then do ONE precheck + ONE insert per event
        const allTeams = teamArrays.flat();
        debug.push(`Event ${eventId}: ${divisions.length} divs, ${allTeams.length} total teams`);
        if (allTeams.length > 0) {
          const inserted = await insertNewRegistrations(env, allTeams, event);
          registrationsCount += inserted;
        }
      } catch (e) {
        errors.push(`Event ${eventId}: ${e.message}`);
      }
    }

    const status = errors.length === 0 ? 'success' : 'partial';
    const duration = Date.now() - startTime;
    await logPoll(env, status, registrationsCount, errors.join('; '), duration);
    return { status, registrationsCount, eventsBatch: eventIdBatch, errors, debug, durationMs: duration };

  } catch (e) {
    const duration = Date.now() - startTime;
    await logPoll(env, 'error', 0, e.message, duration);
    return { status: 'error', message: e.message, durationMs: duration };
  }
}

// — USSSA API helpers —————————————————————————————————————————————————————————

async function fetchUSSSATeams(cookieStr, divisionId) {
  const payload = `json=${encodeURIComponent(JSON.stringify({
    rows: 100, filter: { divisionID: divisionId, sportID: 11 }
  }))}`;
  const resp = await fetch(`${USSSA_API}?action=teamsTable`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: payload,
  });
  if (!resp.ok) throw new Error(`USSSA teams API: ${resp.status}`);
  return await resp.text();
}

function parseTeamsResponse(responseText, event, division) {
  try {
    const parsed = JSON.parse(responseText);
    return (parsed.data || []).map(t => ({
      event_id: event.event_id,
      event_name: event.event_name,
      event_date: event.start_date,
      division: division.division_name,
      team_name: (t.teamName || '').toString().trim(),
      manager_name: (t.managerName || '').toString().trim(),
      manager_email: (t.managerEmail || '').toString().trim(),
      manager_phone: (t.managerPhone || '').toString().trim(),
      team_city: (t.city || '').toString().trim(),
      team_state: (t.state || '').toString().trim(),
      entry_status: (t.entryStatus || '').toString().trim(),
      payment_status: (t.paymentStatus || '').toString().trim(),
      region: event.region,
      director: event.director,
    })).filter(t => t.team_name);
  } catch {
    return [];
  }
}

// — Supabase helpers —————————————————————————————————————————————————————————

async function supabaseQuery(env, table, query) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    }
  });
  if (!resp.ok) throw new Error(`Supabase ${table}: ${resp.status}`);
  return await resp.json();
}

async function insertNewRegistrations(env, teams, event, division) {
  if (teams.length === 0) return 0;
  const existing = await supabaseQuery(env, 'usssa_registrations',
    `select=id,team_name,event_id&event_id=eq.${event.event_id}&team_name=in.(${teams.map(t => `"${t.team_name.replace(/"/g, '\\"')}`).join(',')})`
  );
  const existingSet = new Set(existing.map(t => `${t.event_id}:${t.team_name}`));
  const newTeams = teams.filter(t => !existingSet.has(`${event.event_id}:${t.team_name}`));
  if (newTeams.length === 0) return 0;

  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/usssa_registrations`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(newTeams.map(t => ({
      event_id: t.event_id,
      tournament: t.event_name,
      start_date: t.event_date || null,
      division: t.division,
      team_name: t.team_name,
      manager_name: t.manager_name || null,
      manager_email: t.manager_email || null,
      manager_phone: t.manager_phone || null,
      team_city: t.team_city || null,
      team_state: t.team_state || null,
      entry_status: t.entry_status || null,
      payment_status: t.payment_status || null,
      status: t.entry_status || null,
      region: t.region || null,
      director: t.director || null,
      created_at: new Date().toISOString(),
    }))),
  });
  if (!resp.ok && resp.status !== 409) throw new Error(`Insert failed: ${resp.status}`);
  return newTeams.length;
}

async function logPoll(env, status, count, errorMsg, durationMs) {
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
        registrations_count: count,
        error_message: errorMsg || null,
        duration_ms: durationMs,
      }),
    });
  } catch {}
}
