# Predict. — MVP v0.2

**Predict. Prove it.**

A mobile-first social network where sports predictions build a permanent, verifiable reputation record. v0.2 replaces the v0.1 mock-only data layer with real Supabase authentication and database operations while keeping football/odds ingestion as the next milestone.

## What changed in v0.2

### Real accounts
- Supabase email/password sign-up and sign-in
- Persistent sessions on React Native via AsyncStorage
- Automatic `profiles` row when a new Auth user is created
- 18+ confirmation gate after first sign-in
- Sign-out

### Real database-backed social layer
- Live prediction feed from Postgres
- Upcoming match list from `events`
- Latest odds snapshots from `markets`
- Likes stored in `prediction_likes`
- Comments stored in `comments`
- Follow/unfollow stored in `follows`
- Following-only feed filter
- Prediction reporting stored in `reports`
- Blocking data model and API service included
- Profile counts for predictions / followers / following
- Public overall ratings and specialization records

### Prediction integrity upgrade
The client no longer inserts authoritative odds directly into `predictions`.

A prediction is created through the Postgres RPC:

```sql
create_prediction_from_market(...)
```

The server function:
1. Requires an authenticated user.
2. Loads a real `markets` row by ID.
3. Copies the event, market type, selection, odds and captured timestamp from that snapshot.
4. Rejects stale market snapshots.
5. Rejects predictions after the event cut-off.
6. Writes the immutable prediction.

The app therefore cannot simply submit a fake `@2.80` price when the database snapshot says `@2.15`.

### Still protected server-side
- Match, market, selection, reference odds, confidence, units and original timestamp are immutable after publish.
- Users cannot settle their own predictions.
- Closing odds and Win/Loss/Void require trusted backend/service-role code.
- Settled analysis is locked.

## Stack

- Expo / React Native
- TypeScript
- Supabase Auth
- Supabase Postgres
- Supabase Row Level Security
- AsyncStorage for persisted auth sessions

## Project structure

```text
predict-app/
├── App.tsx
├── app.json
├── package.json
├── .env.example
├── backend/
│   ├── schema.sql
│   └── seed.sql
└── src/
    ├── context/
    │   └── AuthContext.tsx
    ├── lib/
    │   └── supabase.ts
    ├── services/
    │   └── api.ts
    ├── theme.ts
    └── types.ts
```

## 1. Create Supabase project

Create a Supabase project and open **SQL Editor**.

Run:

```text
backend/schema.sql
```

For temporary demo football fixtures, then run:

```text
backend/seed.sql
```

`seed.sql` creates future Arsenal–Liverpool, Real Madrid–Inter and Milan–Juventus events plus fresh Match Winner odds snapshots. Re-run it whenever you need fresh demo odds because the prediction RPC deliberately rejects stale snapshots.

## 2. Environment variables

Copy:

```bash
cp .env.example .env
```

Fill in:

```env
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Never put a Supabase `service_role` key in the mobile app.

## 3. Install and run

```bash
npm install
npm run typecheck
npm start
```

Open with an emulator/device supported by the installed Expo SDK.

## 4. Test the v0.2 flow

1. Create an account.
2. Confirm email if email confirmation is enabled in Supabase.
3. Sign in.
4. Confirm 18+.
5. Run `backend/seed.sql` if no events exist.
6. Open `+` and publish a prediction.
7. Pull-to-refresh the Home feed.
8. Use a second account to test follow, likes, comments and community consensus.

## Authentication scope

v0.2 implements production-connected **email/password authentication**.

Google and Apple sign-in are intentionally not hard-coded yet because they require project-specific OAuth/provider configuration, redirect URLs, Apple identifiers and signing credentials. They should be added after the Supabase project and store identities are created; no fake credentials or placeholder production OAuth flow is included.

## Ratings in v0.2

A new account receives a provisional overall rating row:

- Rating: `50`
- Confidence: `very_low`
- Sample size: `0`

The app already reads and displays ratings from Postgres. The actual rating computation engine belongs to v0.4, after results and closing odds exist.

## v0.3 — football data + settlement

Next milestone:
- choose a football-data provider
- ingest competitions and fixtures
- ingest results
- refresh market snapshots
- run automated settlement using trusted backend code
- enforce event status/cut-off operationally

## v0.4 — odds + reputation engine

- closing odds
- CLV
- risk-adjusted ROI
- confidence engine
- Predictor Rating
- league specialization
- market specialization
- leaderboard eligibility thresholds

## v0.5 — launch readiness

- Google / Apple sign-in
- push notifications
- share cards and public web profiles
- admin moderation dashboard
- analytics / telemetry
- privacy policy / terms / account deletion UX
- TestFlight and Google Play closed testing

## Product rule

**Prediction ≠ bet.**

The core product measures public forecasting performance. Real-money wagering and bookmaker affiliate links remain outside this MVP.
