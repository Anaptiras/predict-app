# Predict. — MVP v0.3

**Predict. Prove it.**

v0.3 is now connected to the production Supabase project and **The Odds API v4**.

## Production status

The backend is live and verified end-to-end:

- Supabase project: `predict-app` in `eu-central-1`
- real football fixtures are being ingested
- real European 1X2 odds are being ingested
- odds are stored as median consensus across available bookmakers
- scores sync is deployed and working
- API quota usage is recorded in a private schema
- Odds API credentials are encrypted in Supabase Vault
- mobile clients never receive the Odds API key
- Supabase Security Advisor currently reports 0 security lints

The first production test successfully imported Premier League, UEFA Champions League and Super League Greece fixtures and market snapshots.

## Architecture

```text
The Odds API
     │
     ▼
Supabase Edge Functions
  sync-odds / sync-scores
     │
     ├── API key + internal sync secret → Supabase Vault
     ├── fixtures/results → public.events
     ├── median consensus odds → public.markets
     └── quota telemetry → private.odds_sync_runs
                         │
                         ▼
               Supabase Postgres
                         │
                         ▼
                React Native app
```

## Security model

### Odds API credential

The Odds API key is stored under the Vault secret name:

```text
odds_api_key
```

The internal Edge Function caller secret is stored as:

```text
odds_sync_secret
```

No real secret value is committed to GitHub.

The Edge Functions read Vault through the server-only `SUPABASE_DB_URL` connection that Supabase provides to hosted functions.

### Prediction integrity

The app calls:

```sql
create_prediction_from_market(...)
```

The function is `SECURITY INVOKER`, not `SECURITY DEFINER`.

An RLS INSERT policy independently requires every authoritative prediction field to match a recent trusted The Odds API market snapshot. Direct REST insertion therefore cannot be used to invent odds or bypass the prediction cut-off.

Checks include:

1. signed-in user owns the prediction;
2. status begins as `pending`;
3. no closing odds/settlement can be supplied by the client;
4. market/selection/reference odds/timestamp must exactly match a stored provider snapshot;
5. snapshot must be no more than 15 minutes old;
6. prediction must be created at least 5 minutes before kickoff.

Core fields remain immutable after publication.

## Real data currently supported

- Premier League
- UEFA Champions League
- La Liga
- Serie A
- Bundesliga
- Super League Greece
- UEFA Europa League
- UEFA Conference League

Current MVP market:

```text
h2h → Match Winner / 1X2
```

## Reference odds

For every outcome, available European bookmaker prices are collected and the **median decimal price** is stored.

Example:

```text
2.10, 2.12, 2.15, 2.18, 2.25
→ reference odds 2.15
```

The database also stores bookmaker count, provider update time and captured timestamp for future CLV calculations.

## Edge Functions

Deployed functions:

```text
sync-odds
sync-scores
```

Both use custom backend authentication through the Vault-backed `x-sync-secret` value. They are not user-facing APIs.

`sync-odds` first checks the quota-free `/events` endpoint and only calls the paid odds endpoint when the league has a match inside the configured horizon.

## Mobile configuration

`.env.example` already contains the production Supabase project URL and **publishable** key. The publishable key is safe for mobile/frontend use because authorization is enforced by RLS.

Create the local file:

```bash
cp .env.example .env
```

Then:

```bash
npm install
npm run typecheck
npm start
```

## Scores and settlement

`sync-scores` currently updates:

- `scheduled`
- `live`
- `completed`
- home score
- away score

Automatic prediction settlement is deliberately not enabled yet. The next milestone is a football settlement rules engine that explicitly handles regulation time, draws, postponements/abandonments and later additional market types.

## Database migrations

Current sequence:

```text
backend/schema.sql
backend/migrations/003_odds_api.sql
backend/migrations/004_security_hardening.sql
```

Production already has these changes applied.

## Next milestone — v0.4

- automatic rules-correct settlement for 1X2
- select a closing odds snapshot
- calculate CLV
- calculate unit-based ROI
- rating confidence by sample size
- Predictor Rating v1
- competition specialization ratings
- leaderboard eligibility rules
