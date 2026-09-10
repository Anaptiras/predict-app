# Predict. — MVP v0.3

**Predict. Prove it.**

v0.3 connects the product to **The Odds API v4** through Supabase Edge Functions. The API credential is intentionally kept server-side and is never included in the React Native bundle or committed to GitHub.

## What v0.3 adds

- Real football fixtures from The Odds API
- Real European bookmaker odds
- 1X2 / Match Winner market ingestion (`h2h`)
- Median consensus reference price across available bookmakers
- Snapshot history for future CLV calculations
- API quota telemetry (`x-requests-remaining`, `x-requests-used`, `x-requests-last`)
- Quota-aware sync: first checks the quota-free `/events` endpoint and only spends odds credits when a selected league has a match inside the configured horizon
- Supported league mapping for Premier League, UEFA Champions League, La Liga, Serie A, Bundesliga, Super League Greece, UEFA Europa League and UEFA Conference League
- Scores sync Edge Function for event status/results
- Prediction publishing accepts only fresh provider-backed odds snapshots

## Architecture

```text
The Odds API
     │
     │ HTTPS (API key only on server)
     ▼
Supabase Edge Function: sync-odds
     │
     ├── events → public.events
     ├── median bookmaker consensus → public.markets
     └── quota metadata → public.odds_sync_runs
                         │
                         ▼
               Supabase Postgres
                         │
                         ▼
                 React Native app
                         │
                         └── create_prediction_from_market(...)
                             copies trusted market snapshot server-side
```

The mobile app never knows the Odds API key.

## Important security rule

Do **not** place the Odds API key in `.env` as an `EXPO_PUBLIC_*` variable. Expo public variables are embedded in the client application and can be extracted.

The key belongs in a Supabase Edge Function secret named `ODDS_API_KEY`.

Because API keys should be treated like passwords, rotate any key that has been pasted into chat, source code, tickets or other shared text before production use.

## Database setup

### Fresh project

Run, in order:

```text
backend/schema.sql
backend/migrations/003_odds_api.sql
```

Do not run `backend/seed.sql` once the real odds integration is enabled unless you explicitly want demo fixtures too.

### Existing v0.2 project

Run:

```text
backend/migrations/003_odds_api.sql
```

This adds The Odds API league mapping, snapshot metadata, sync telemetry and the stricter provider-backed prediction RPC.

## Supabase secrets

Set server-side secrets with the Supabase CLI or dashboard:

```bash
supabase secrets set ODDS_API_KEY='<YOUR_KEY>'
supabase secrets set ODDS_API_REGIONS='eu'
supabase secrets set ODDS_SYNC_SECRET='<LONG_RANDOM_SECRET>'
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are read only inside the Edge Function environment. Never expose the service-role key to the app.

## Deploy Edge Functions

```bash
supabase functions deploy sync-odds
supabase functions deploy sync-scores
```

Both functions additionally require the private `x-sync-secret` header, so a valid JWT alone is not enough to run a sync.

## Trigger an odds sync

Example request body:

```json
{
  "horizonHours": 48,
  "regions": "eu"
}
```

Optionally sync only selected competitions:

```json
{
  "sportKeys": [
    "soccer_epl",
    "soccer_uefa_champs_league",
    "soccer_greece_super_league"
  ],
  "horizonHours": 48
}
```

The function first calls `/events`, which The Odds API documents as not consuming quota. It calls `/odds` only when the league has a game inside the requested horizon.

## Reference odds methodology

For each Match Winner selection, v0.3 collects the available bookmaker prices returned for the configured region and stores the **median decimal price**.

Example:

```text
Arsenal prices: 2.10, 2.12, 2.15, 2.18, 2.25
Reference price: 2.15
```

Stored metadata includes `reference_odds`, `bookmaker_count`, `captured_at`, `source_last_update`, `provider` and `consensus_method = median`.

This avoids tying Predictor Rating to one bookmaker and preserves snapshots for later closing-line calculations.

## Prediction integrity

The mobile client submits only a `marketId`, confidence, units and optional analysis.

`create_prediction_from_market(...)` then verifies server-side that:

1. the user is authenticated;
2. the event is still at least 5 minutes from kickoff;
3. the snapshot came from The Odds API integration;
4. the reference snapshot is not older than 15 minutes;
5. odds/selection/timestamp are copied from Postgres rather than supplied by the mobile client.

After publication, core prediction fields remain immutable.

## Scores

`sync-scores` updates scheduled/live/completed status, home score and away score.

It deliberately **does not automatically settle predictions yet**. Soccer settlement rules need a defined rules engine for regulation time, extra time, postponed/abandoned matches and future non-1X2 markets. That belongs in the next settlement milestone rather than guessing from a final score.

## API quota strategy

The Odds API charges the odds endpoint based on markets × regions. v0.3 therefore defaults to one region (`eu`) and one market (`h2h`).

Recommended early-stage strategy:

- invoke `sync-odds` every 30–60 minutes normally;
- increase cadence near kickoff only for leagues that actually have upcoming matches;
- keep one region (`eu`) during MVP;
- keep only `h2h` until the prediction/reputation loop is validated.

The `odds_sync_runs` table records quota headers after each successful odds request so usage can be monitored before expanding coverage.

## Mobile environment

The mobile app still uses only Supabase public credentials:

```env
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

## Run the app

```bash
npm install
npm run typecheck
npm start
```

## Current v0.3 boundary

Working product layer:

- authentication
- profiles
- follows
- likes/comments/reports
- real upcoming football events
- real 1X2 reference odds
- immutable predictions
- rankings/reputation data model
- community consensus

Next milestone:

- automated, rules-correct settlement
- closing odds selection from stored snapshots
- CLV calculation
- ROI and confidence engine
- Predictor Rating v1
