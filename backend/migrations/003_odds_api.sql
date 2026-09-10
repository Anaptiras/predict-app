-- Predict. v0.3 — The Odds API integration
-- Run AFTER backend/schema.sql on an existing v0.2 database.

alter table public.competitions
  add column if not exists odds_api_sport_key text,
  add column if not exists is_active boolean not null default true;

create unique index if not exists competitions_odds_api_sport_key_uq
  on public.competitions(odds_api_sport_key)
  where odds_api_sport_key is not null;

alter table public.events
  add column if not exists provider_sport_key text;

alter table public.markets
  add column if not exists bookmaker_count integer,
  add column if not exists source_last_update timestamptz,
  add column if not exists consensus_method text;

create unique index if not exists markets_provider_snapshot_uq
  on public.markets(event_id, market_type, selection, provider, source_last_update);

create table if not exists public.odds_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sport_key text,
  status text not null default 'running' check (status in ('running','success','partial','failed','skipped')),
  events_seen integer not null default 0,
  market_rows_written integer not null default 0,
  requests_remaining integer,
  requests_used integer,
  request_cost integer,
  error_message text
);

alter table public.odds_sync_runs enable row level security;
-- No client policy: only service-role Edge Functions should read/write this table.

-- Seed supported football competitions. Upsert by API sport key so this is rerunnable.
insert into public.competitions (sport, name, country, external_id, odds_api_sport_key, is_active)
values
  ('football','Premier League','England','soccer_epl','soccer_epl',true),
  ('football','UEFA Champions League','Europe','soccer_uefa_champs_league','soccer_uefa_champs_league',true),
  ('football','La Liga','Spain','soccer_spain_la_liga','soccer_spain_la_liga',true),
  ('football','Serie A','Italy','soccer_italy_serie_a','soccer_italy_serie_a',true),
  ('football','Bundesliga','Germany','soccer_germany_bundesliga','soccer_germany_bundesliga',true),
  ('football','Super League Greece','Greece','soccer_greece_super_league','soccer_greece_super_league',true),
  ('football','UEFA Europa League','Europe','soccer_uefa_europa_league','soccer_uefa_europa_league',true),
  ('football','UEFA Conference League','Europe','soccer_uefa_europa_conference_league','soccer_uefa_europa_conference_league',true)
on conflict (external_id) do update set
  name = excluded.name,
  country = excluded.country,
  odds_api_sport_key = excluded.odds_api_sport_key,
  is_active = excluded.is_active;

-- The app's server-side prediction RPC remains the authority for odds selection.
-- This replaces it so v0.3 can additionally verify a provider-backed snapshot.
create or replace function public.create_prediction_from_market(
  p_market_id uuid,
  p_confidence smallint,
  p_units smallint default 1,
  p_analysis text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  m public.markets%rowtype;
  e public.events%rowtype;
  prediction_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_confidence not between 1 and 10 then raise exception 'Confidence must be 1-10'; end if;
  if p_units not between 1 and 5 then raise exception 'Units must be 1-5'; end if;
  if char_length(coalesce(p_analysis,'')) > 800 then raise exception 'Analysis is too long'; end if;

  select * into m from public.markets where id = p_market_id;
  if not found then raise exception 'Market snapshot not found'; end if;

  select * into e from public.events where id = m.event_id;
  if not found then raise exception 'Event not found'; end if;

  if now() >= e.kickoff_at - interval '5 minutes' then
    raise exception 'Predictions are closed for this event';
  end if;

  -- The mobile client may only use recent server-ingested odds.
  if m.provider is null or m.provider not like 'the-odds-api:%' then
    raise exception 'Only provider-backed reference odds are accepted';
  end if;

  if m.captured_at < now() - interval '15 minutes' then
    raise exception 'Reference odds snapshot is stale';
  end if;

  insert into public.predictions (
    user_id, event_id, market_type, selection, reference_odds,
    odds_captured_at, confidence, units, analysis
  ) values (
    auth.uid(), m.event_id, m.market_type, m.selection, m.reference_odds,
    m.captured_at, p_confidence, p_units, nullif(trim(p_analysis),'')
  ) returning id into prediction_id;

  return prediction_id;
end;
$$;

revoke all on function public.create_prediction_from_market(uuid,smallint,smallint,text) from public;
grant execute on function public.create_prediction_from_market(uuid,smallint,smallint,text) to authenticated;
