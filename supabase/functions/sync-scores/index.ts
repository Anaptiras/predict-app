import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { ScoreEvent } from '../_shared/odds.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const syncSecret = Deno.env.get('ODDS_SYNC_SECRET');
  if (!syncSecret) return json({ error: 'ODDS_SYNC_SECRET is not configured' }, 500);
  if (req.headers.get('x-sync-secret') !== syncSecret) return json({ error: 'Unauthorized' }, 401);

  const apiKey = Deno.env.get('ODDS_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!apiKey || !supabaseUrl || !serviceRoleKey) return json({ error: 'Missing server environment variables' }, 500);

  let input: { sportKeys?: string[]; daysFrom?: 1 | 2 | 3 } = {};
  try { input = await req.json(); } catch { /* empty body */ }
  const daysFrom = input.daysFrom ?? 3;
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let query = db.from('competitions').select('id,odds_api_sport_key').eq('is_active', true).not('odds_api_sport_key', 'is', null);
  if (input.sportKeys?.length) query = query.in('odds_api_sport_key', input.sportKeys);
  const { data: competitions, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const summary: Array<Record<string, unknown>> = [];
  for (const competition of competitions ?? []) {
    const sportKey = competition.odds_api_sport_key as string;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/scores?apiKey=${encodeURIComponent(apiKey)}&daysFrom=${daysFrom}&dateFormat=iso`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Scores API ${response.status}: ${await response.text()}`);
      const scores = (await response.json()) as ScoreEvent[];
      let updated = 0;

      for (const event of scores) {
        const homeScore = event.scores?.find((s) => s.name === event.home_team)?.score;
        const awayScore = event.scores?.find((s) => s.name === event.away_team)?.score;
        const patch: Record<string, unknown> = {
          competition_id: competition.id,
          home_name: event.home_team,
          away_name: event.away_team,
          kickoff_at: event.commence_time,
          external_id: event.id,
          provider_sport_key: sportKey,
          status: event.completed ? 'completed' : (Date.parse(event.commence_time) <= Date.now() ? 'live' : 'scheduled'),
        };
        if (homeScore != null && awayScore != null) {
          patch.home_score = Number.parseInt(homeScore, 10);
          patch.away_score = Number.parseInt(awayScore, 10);
        }
        const { error: upsertError } = await db.from('events').upsert(patch, { onConflict: 'external_id' });
        if (upsertError) throw upsertError;
        updated += 1;
      }
      summary.push({ sportKey, status: 'success', events: updated });
    } catch (err) {
      summary.push({ sportKey, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Deliberately does NOT settle predictions yet. Soccer market settlement rules
  // (90 minutes vs extra time, postponed/abandoned fixtures, etc.) need an explicit rules engine.
  return json({ ok: true, daysFrom, competitions: summary, settlement: 'not-enabled' });
});
