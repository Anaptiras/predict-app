import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { consensusH2H, type OddsEvent, quotaHeaders } from '../_shared/odds.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const syncSecret = Deno.env.get('ODDS_SYNC_SECRET');
  if (!syncSecret) return json({ error: 'ODDS_SYNC_SECRET is not configured' }, 500);
  if (req.headers.get('x-sync-secret') !== syncSecret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const apiKey = Deno.env.get('ODDS_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!apiKey || !supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Missing ODDS_API_KEY or Supabase server environment variables' }, 500);
  }

  let input: { sportKeys?: string[]; horizonHours?: number; regions?: string } = {};
  try { input = await req.json(); } catch { /* empty body is valid */ }

  const regions = input.regions || Deno.env.get('ODDS_API_REGIONS') || 'eu';
  const horizonHours = Math.max(1, Math.min(input.horizonHours ?? 48, 168));
  const cutoff = Date.now() + horizonHours * 60 * 60 * 1000;
  const baseUrl = 'https://api.the-odds-api.com/v4';
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let competitionQuery = db
    .from('competitions')
    .select('id,name,odds_api_sport_key')
    .eq('is_active', true)
    .not('odds_api_sport_key', 'is', null);

  if (input.sportKeys?.length) competitionQuery = competitionQuery.in('odds_api_sport_key', input.sportKeys);
  const { data: competitions, error: competitionError } = await competitionQuery;
  if (competitionError) return json({ error: competitionError.message }, 500);

  const summary: Array<Record<string, unknown>> = [];

  for (const competition of competitions ?? []) {
    const sportKey = competition.odds_api_sport_key as string;
    const { data: run, error: runError } = await db.from('odds_sync_runs').insert({ sport_key: sportKey }).select('id').single();
    if (runError) return json({ error: runError.message }, 500);

    try {
      // Events are quota-free. Use them first so we avoid spending odds credits on leagues
      // with no game inside the configured horizon.
      const eventsUrl = `${baseUrl}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`;
      const eventsResponse = await fetch(eventsUrl);
      if (!eventsResponse.ok) throw new Error(`Events API ${eventsResponse.status}: ${await eventsResponse.text()}`);
      const listedEvents = (await eventsResponse.json()) as Omit<OddsEvent, 'bookmakers'>[];
      const relevant = listedEvents.filter((e) => {
        const t = Date.parse(e.commence_time);
        return Number.isFinite(t) && t <= cutoff && t >= Date.now() - 4 * 60 * 60 * 1000;
      });

      if (!relevant.length) {
        await db.from('odds_sync_runs').update({
          status: 'skipped', finished_at: new Date().toISOString(), events_seen: listedEvents.length,
        }).eq('id', run.id);
        summary.push({ sportKey, status: 'skipped', reason: `No events within ${horizonHours}h` });
        continue;
      }

      const oddsUrl = `${baseUrl}/sports/${encodeURIComponent(sportKey)}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=${encodeURIComponent(regions)}&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const oddsResponse = await fetch(oddsUrl);
      const quota = quotaHeaders(oddsResponse);
      if (!oddsResponse.ok) throw new Error(`Odds API ${oddsResponse.status}: ${await oddsResponse.text()}`);
      const oddsEvents = (await oddsResponse.json()) as OddsEvent[];
      const now = new Date().toISOString();

      const eventRows = oddsEvents.map((event) => ({
        competition_id: competition.id,
        home_name: event.home_team,
        away_name: event.away_team,
        kickoff_at: event.commence_time,
        status: Date.parse(event.commence_time) <= Date.now() ? 'live' : 'scheduled',
        external_id: event.id,
        provider_sport_key: sportKey,
      }));

      const { data: upsertedEvents, error: eventError } = await db
        .from('events')
        .upsert(eventRows, { onConflict: 'external_id' })
        .select('id,external_id');
      if (eventError) throw eventError;

      const eventIdByExternal = new Map((upsertedEvents ?? []).map((e) => [e.external_id as string, e.id as string]));
      const marketRows: Array<Record<string, unknown>> = [];

      for (const event of oddsEvents) {
        const eventId = eventIdByExternal.get(event.id);
        if (!eventId) continue;
        for (const row of consensusH2H(event)) {
          marketRows.push({
            event_id: eventId,
            market_type: 'match_winner',
            selection: row.selection,
            reference_odds: row.referenceOdds,
            captured_at: now,
            provider: `the-odds-api:consensus:${regions}`,
            bookmaker_count: row.bookmakerCount,
            source_last_update: row.sourceLastUpdate,
            consensus_method: 'median',
          });
        }
      }

      let written = 0;
      if (marketRows.length) {
        const { data: inserted, error: marketError } = await db
          .from('markets')
          .upsert(marketRows, {
            onConflict: 'event_id,market_type,selection,provider,source_last_update',
            ignoreDuplicates: true,
          })
          .select('id');
        if (marketError) throw marketError;
        written = inserted?.length ?? 0;
      }

      await db.from('odds_sync_runs').update({
        status: 'success',
        finished_at: new Date().toISOString(),
        events_seen: oddsEvents.length,
        market_rows_written: written,
        requests_remaining: quota.remaining,
        requests_used: quota.used,
        request_cost: quota.cost,
      }).eq('id', run.id);

      summary.push({ sportKey, status: 'success', events: oddsEvents.length, markets: written, quota });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.from('odds_sync_runs').update({
        status: 'failed', finished_at: new Date().toISOString(), error_message: message.slice(0, 1000),
      }).eq('id', run.id);
      summary.push({ sportKey, status: 'failed', error: message });
    }
  }

  return json({ ok: true, regions, horizonHours, competitions: summary });
});
