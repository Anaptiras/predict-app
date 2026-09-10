-- Predict. v0.3 security hardening
-- Mirrors the production hardening applied to Supabase.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.competitions, public.events, public.markets, public.predictions, public.follows, public.prediction_likes, public.comments, public.ratings to anon, authenticated;
grant update on public.profiles to authenticated;
grant insert, delete on public.follows, public.prediction_likes, public.blocks to authenticated;
grant insert, update on public.comments to authenticated;
grant insert, select on public.reports to authenticated;

-- Auth trigger is private and not callable through the Data API.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_username text;
  candidate text;
begin
  base_username := lower(regexp_replace(
    coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(coalesce(new.email,'predictor'),'@',1), 'predictor'),
    '[^a-zA-Z0-9_]', '', 'g'
  ));
  if char_length(base_username) < 3 then base_username := 'predictor'; end if;
  base_username := left(base_username,24);
  candidate := base_username;
  if exists(select 1 from public.profiles where username=candidate) then
    candidate := left(base_username,24) || '_' || left(new.id::text,4);
  end if;
  insert into public.profiles(id,username) values(new.id,candidate) on conflict(id) do nothing;
  insert into public.ratings(user_id,scope_type,scope_key,rating,confidence,sample_size)
    values(new.id,'overall','all',50,'very_low',0)
    on conflict(user_id,scope_type,scope_key) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();
drop function if exists public.handle_new_user();

-- Explicit RLS policies.
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to anon, authenticated using (true);
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update to authenticated using ((select auth.uid())=id) with check ((select auth.uid())=id);
drop policy if exists "competitions readable" on public.competitions;
create policy "competitions readable" on public.competitions for select to anon, authenticated using (true);
drop policy if exists "events readable" on public.events;
create policy "events readable" on public.events for select to anon, authenticated using (true);
drop policy if exists "markets readable" on public.markets;
create policy "markets readable" on public.markets for select to anon, authenticated using (true);
drop policy if exists "predictions readable" on public.predictions;
create policy "predictions readable" on public.predictions for select to anon, authenticated using (true);
drop policy if exists "edit own pending analysis" on public.predictions;
create policy "edit own pending analysis" on public.predictions for update to authenticated using ((select auth.uid())=user_id and status='pending') with check ((select auth.uid())=user_id);
drop policy if exists "follows readable" on public.follows;
create policy "follows readable" on public.follows for select to anon, authenticated using (true);
drop policy if exists "create own follows" on public.follows;
create policy "create own follows" on public.follows for insert to authenticated with check ((select auth.uid())=follower_id);
drop policy if exists "delete own follows" on public.follows;
create policy "delete own follows" on public.follows for delete to authenticated using ((select auth.uid())=follower_id);
drop policy if exists "likes readable" on public.prediction_likes;
create policy "likes readable" on public.prediction_likes for select to anon, authenticated using (true);
drop policy if exists "create own likes" on public.prediction_likes;
create policy "create own likes" on public.prediction_likes for insert to authenticated with check ((select auth.uid())=user_id);
drop policy if exists "delete own likes" on public.prediction_likes;
create policy "delete own likes" on public.prediction_likes for delete to authenticated using ((select auth.uid())=user_id);
drop policy if exists "comments readable" on public.comments;
create policy "comments readable" on public.comments for select to anon, authenticated using (deleted_at is null);
drop policy if exists "create own comments" on public.comments;
create policy "create own comments" on public.comments for insert to authenticated with check ((select auth.uid())=user_id);
drop policy if exists "soft-delete own comments" on public.comments;
create policy "soft-delete own comments" on public.comments for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
drop policy if exists "ratings readable" on public.ratings;
create policy "ratings readable" on public.ratings for select to anon, authenticated using (true);
drop policy if exists "read own blocks" on public.blocks;
create policy "read own blocks" on public.blocks for select to authenticated using ((select auth.uid())=blocker_id);
drop policy if exists "create own blocks" on public.blocks;
create policy "create own blocks" on public.blocks for insert to authenticated with check ((select auth.uid())=blocker_id);
drop policy if exists "delete own blocks" on public.blocks;
create policy "delete own blocks" on public.blocks for delete to authenticated using ((select auth.uid())=blocker_id);
drop policy if exists "create own reports" on public.reports;
create policy "create own reports" on public.reports for insert to authenticated with check ((select auth.uid())=reporter_id);
drop policy if exists "read own reports" on public.reports;
create policy "read own reports" on public.reports for select to authenticated using ((select auth.uid())=reporter_id);

-- Prediction inserts are allowed only when every authoritative field matches a recent trusted market snapshot.
grant insert on public.predictions to authenticated;
drop policy if exists "create trusted prediction" on public.predictions;
create policy "create trusted prediction" on public.predictions for insert to authenticated with check (
  (select auth.uid()) = user_id
  and status='pending' and closing_odds is null and settled_at is null
  and created_at >= now()-interval '1 minute' and created_at <= now()+interval '5 seconds'
  and exists (
    select 1 from public.markets m join public.events e on e.id=m.event_id
    where m.event_id=predictions.event_id
      and m.market_type=predictions.market_type
      and m.selection=predictions.selection
      and m.reference_odds=predictions.reference_odds
      and m.captured_at=predictions.odds_captured_at
      and m.provider like 'the-odds-api:%'
      and m.captured_at >= now()-interval '15 minutes'
      and now() < e.kickoff_at-interval '5 minutes'
  )
);

create or replace function public.create_prediction_from_market(
  p_market_id uuid,
  p_confidence smallint,
  p_units smallint default 1,
  p_analysis text default null
)
returns uuid
language plpgsql
security invoker
set search_path=public
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
  select * into m from public.markets where id=p_market_id;
  if not found then raise exception 'Market snapshot not found'; end if;
  select * into e from public.events where id=m.event_id;
  if not found then raise exception 'Event not found'; end if;
  if now() >= e.kickoff_at-interval '5 minutes' then raise exception 'Predictions are closed for this event'; end if;
  if m.provider is null or m.provider not like 'the-odds-api:%' then raise exception 'Only provider-backed reference odds are accepted'; end if;
  if m.captured_at < now()-interval '15 minutes' then raise exception 'Reference odds snapshot is stale'; end if;
  insert into public.predictions(user_id,event_id,market_type,selection,reference_odds,odds_captured_at,confidence,units,analysis)
  values(auth.uid(),m.event_id,m.market_type,m.selection,m.reference_odds,m.captured_at,p_confidence,p_units,nullif(trim(p_analysis),''))
  returning id into prediction_id;
  return prediction_id;
end;
$$;
revoke all on function public.create_prediction_from_market(uuid,smallint,smallint,text) from public, anon;
grant execute on function public.create_prediction_from_market(uuid,smallint,smallint,text) to authenticated;

-- Internal sync telemetry lives outside the public Data API.
create table if not exists private.odds_sync_runs (like public.odds_sync_runs including all);
insert into private.odds_sync_runs select * from public.odds_sync_runs on conflict (id) do nothing;
drop table if exists public.odds_sync_runs;
revoke all on private.odds_sync_runs from public, anon, authenticated;

create extension if not exists pg_net with schema extensions;
