import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { db, readVaultSecret } from '../_shared/db.ts';
import type { ScoreEvent } from '../_shared/odds.ts';

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

    let input: { sportKeys?: string[]; daysFrom?: 1 | 2 | 3 } = {};
    try { input = await req.json(); } catch { /* empty body */ }
    const daysFrom = input.daysFrom ?? 3;

    const competitions = input.sportKeys?.length
      ? await sql<{ id: string; odds_api_sport_key: string }[]>`
          select id, odds_api_sport_key from public.competitions
          where is_active=true and odds_api_sport_key = any(${sql.array(input.sportKeys)})
        `
      : await sql<{ id: string; odds_api_sport_key: string }[]>`
          select id, odds_api_sport_key from public.competitions
          where is_active=true and odds_api_sport_key is not null
        `;

    const summary: Array<Record<string, unknown>> = [];
    for (const competition of competitions) {
      const sportKey = competition.odds_api_sport_key;
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/scores?apiKey=${encodeURIComponent(apiKey)}&daysFrom=${daysFrom}&dateFormat=iso`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Scores API ${response.status}: ${await response.text()}`);
        const scores = (await response.json()) as ScoreEvent[];
        let updated = 0;

        for (const event of scores) {
          const homeScore = event.scores?.find((s) => s.name === event.home_team)?.score;
          const awayScore = event.scores?.find((s) => s.name === event.away_team)?.score;
          await sql`
            insert into public.events (
              competition_id, home_name, away_name, kickoff_at, status,
              home_score, away_score, external_id, provider_sport_key
            ) values (
              ${competition.id}, ${event.home_team}, ${event.away_team}, ${event.commence_time},
              ${event.completed ? 'completed' : (Date.parse(event.commence_time) <= Date.now() ? 'live' : 'scheduled')},
              ${homeScore == null ? null : Number.parseInt(homeScore, 10)},
              ${awayScore == null ? null : Number.parseInt(awayScore, 10)},
              ${event.id}, ${sportKey}
            )
            on conflict (external_id) do update set
              competition_id=excluded.competition_id,
              home_name=excluded.home_name,
              away_name=excluded.away_name,
              kickoff_at=excluded.kickoff_at,
              status=excluded.status,
              home_score=excluded.home_score,
              away_score=excluded.away_score,
              provider_sport_key=excluded.provider_sport_key
          `;
          updated += 1;
        }

        summary.push({ sportKey, status: 'success', events: updated });
      } catch (err) {
        summary.push({ sportKey, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return json({ ok: true, daysFrom, competitions: summary, settlement: 'not-enabled' });
  } finally {
    await sql.end();
  }
});
