import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { db, readVaultSecret } from '../_shared/db.ts';
import { consensusH2H, type OddsEvent, quotaHeaders } from '../_shared/odds.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const sql = db();
  try {
    const [apiKey, syncSecret] = await Promise.all([
      readVaultSecret(sql, 'odds_api_key'),
      readVaultSecret(sql, 'odds_sync_secret'),
    ]);

    if (req.headers.get('x-sync-secret') !== syncSecret) return json({ error: 'Unauthorized' }, 401);

    let input: { sportKeys?: string[]; horizonHours?: number; regions?: string } = {};
    try { input = await req.json(); } catch { /* empty body is valid */ }

    const regions = input.regions || 'eu';
    const horizonHours = Math.max(1, Math.min(input.horizonHours ?? 48, 168));
    const cutoff = Date.now() + horizonHours * 60 * 60 * 1000;
    const baseUrl = 'https://api.the-odds-api.com/v4';

    const competitions = input.sportKeys?.length
      ? await sql<{ id: string; name: string; odds_api_sport_key: string }[]>`
          select id, name, odds_api_sport_key
          from public.competitions
          where is_active = true
            and odds_api_sport_key = any(${sql.array(input.sportKeys)})
          order by name
        `
      : await sql<{ id: string; name: string; odds_api_sport_key: string }[]>`
          select id, name, odds_api_sport_key
          from public.competitions
          where is_active = true and odds_api_sport_key is not null
          order by name
        `;

    const summary: Array<Record<string, unknown>> = [];

    for (const competition of competitions) {
      const sportKey = competition.odds_api_sport_key;
      const [run] = await sql<{ id: string }[]>`
        insert into public.odds_sync_runs (sport_key)
        values (${sportKey})
        returning id
      `;

      try {
        // /events is quota-free, so use it to avoid spending credits on inactive leagues.
        const eventsUrl = `${baseUrl}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`;
        const eventsResponse = await fetch(eventsUrl);
        if (!eventsResponse.ok) throw new Error(`Events API ${eventsResponse.status}: ${await eventsResponse.text()}`);
        const listedEvents = (await eventsResponse.json()) as Omit<OddsEvent, 'bookmakers'>[];
        const relevant = listedEvents.filter((e) => {
          const t = Date.parse(e.commence_time);
          return Number.isFinite(t) && t <= cutoff && t >= Date.now() - 4 * 60 * 60 * 1000;
        });

        if (!relevant.length) {
          await sql`
            update public.odds_sync_runs
            set status='skipped', finished_at=now(), events_seen=${listedEvents.length}
            where id=${run.id}
          `;
          summary.push({ sportKey, status: 'skipped', reason: `No events within ${horizonHours}h` });
          continue;
        }

        const oddsUrl = `${baseUrl}/sports/${encodeURIComponent(sportKey)}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=${encodeURIComponent(regions)}&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
        const oddsResponse = await fetch(oddsUrl);
        const quota = quotaHeaders(oddsResponse);
        if (!oddsResponse.ok) throw new Error(`Odds API ${oddsResponse.status}: ${await oddsResponse.text()}`);
        const oddsEvents = (await oddsResponse.json()) as OddsEvent[];
        const capturedAt = new Date().toISOString();
        let written = 0;

        for (const event of oddsEvents) {
          const [dbEvent] = await sql<{ id: string }[]>`
            insert into public.events (
              competition_id, home_name, away_name, kickoff_at, status, external_id, provider_sport_key
            ) values (
              ${competition.id}, ${event.home_team}, ${event.away_team}, ${event.commence_time},
              ${Date.parse(event.commence_time) <= Date.now() ? 'live' : 'scheduled'},
              ${event.id}, ${sportKey}
            )
            on conflict (external_id) do update set
              competition_id=excluded.competition_id,
              home_name=excluded.home_name,
              away_name=excluded.away_name,
              kickoff_at=excluded.kickoff_at,
              status=excluded.status,
              provider_sport_key=excluded.provider_sport_key
            returning id
          `;

          for (const row of consensusH2H(event)) {
            const inserted = await sql<{ id: string }[]>`
              insert into public.markets (
                event_id, market_type, selection, reference_odds, captured_at, provider,
                bookmaker_count, source_last_update, consensus_method
              ) values (
                ${dbEvent.id}, 'match_winner', ${row.selection}, ${row.referenceOdds}, ${capturedAt},
                ${`the-odds-api:consensus:${regions}`}, ${row.bookmakerCount}, ${row.sourceLastUpdate}, 'median'
              )
              on conflict (event_id, market_type, selection, provider, source_last_update) do nothing
              returning id
            `;
            written += inserted.length;
          }
        }

        await sql`
          update public.odds_sync_runs
          set status='success', finished_at=now(), events_seen=${oddsEvents.length},
              market_rows_written=${written}, requests_remaining=${quota.remaining},
              requests_used=${quota.used}, request_cost=${quota.cost}
          where id=${run.id}
        `;

        summary.push({ sportKey, status: 'success', events: oddsEvents.length, markets: written, quota });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await sql`
          update public.odds_sync_runs
          set status='failed', finished_at=now(), error_message=${message.slice(0, 1000)}
          where id=${run.id}
        `;
        summary.push({ sportKey, status: 'failed', error: message });
      }
    }

    return json({ ok: true, regions, horizonHours, competitions: summary });
  } finally {
    await sql.end();
  }
});
