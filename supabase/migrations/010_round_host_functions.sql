create or replace function public.host_update_settings(p_code text,p_host_token uuid,p_theme_key text,p_timer_seconds integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_room public.rooms;
begin
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now();
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status <> 'lobby' then raise exception 'Settings can only be changed in the lobby.'; end if;
  if not exists(select 1 from public.game_themes where key=p_theme_key) then raise exception 'Invalid theme.'; end if;
  update public.rooms set theme_key=p_theme_key,timer_seconds=greatest(30,least(900,p_timer_seconds)) where id=v_room.id;
  perform public.emit_room_event(v_room.id,'settings_changed');
end;
$$;

create or replace function public.host_start_round(p_code text,p_host_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_count int;
  v_card_id bigint;
  v_imposter uuid;
  v_round public.rounds;
  v_prev uuid;
  v_min_count int;
begin
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now() for update;
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status='discussion' then raise exception 'A round is already active.'; end if;
  select count(*) into v_count from public.players where room_id=v_room.id and active;
  if v_count < 3 then raise exception 'At least 3 players are required.'; end if;
  if v_count > 12 then raise exception 'Maximum is 12 players.'; end if;

  select imposter_player_id into v_prev from public.rounds where room_id=v_room.id order by round_number desc limit 1;
  select min(imposter_count) into v_min_count from public.players where room_id=v_room.id and active;
  select id into v_imposter from public.players
   where room_id=v_room.id and active and imposter_count=v_min_count
   order by (id=v_prev), random() limit 1;

  select c.id into v_card_id from public.game_cards c
   where c.theme_key=v_room.theme_key and c.enabled
     and not exists(select 1 from public.room_card_history h where h.room_id=v_room.id and h.card_id=c.id)
   order by random() limit 1;
  if v_card_id is null then
    delete from public.room_card_history h using public.game_cards c where h.room_id=v_room.id and h.card_id=c.id and c.theme_key=v_room.theme_key;
    select id into v_card_id from public.game_cards where theme_key=v_room.theme_key and enabled order by random() limit 1;
  end if;

  insert into public.room_card_history(room_id,card_id) values(v_room.id,v_card_id) on conflict do nothing;
  update public.players set imposter_count=imposter_count+1 where id=v_imposter;
  insert into public.rounds(room_id,round_number,card_id,imposter_player_id,ends_at)
    values(v_room.id,v_room.round_number+1,v_card_id,v_imposter,now()+make_interval(secs=>v_room.timer_seconds)) returning * into v_round;
  update public.rooms set status='discussion',round_number=v_round.round_number,current_round_id=v_round.id where id=v_room.id;
  perform public.emit_room_event(v_room.id,'round_started');
  return jsonb_build_object('round_id',v_round.id,'ends_at',v_round.ends_at);
end;
$$;

create or replace function public.finalize_round_internal(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.rounds;
  v_room public.rooms;
  v_max int := 0;
  v_imposter_votes int := 0;
  v_top_count int := 0;
  v_caught boolean := false;
begin
  select * into v_round from public.rounds where id=p_round_id for update;
  if not found or v_round.status='results' then return; end if;
  select * into v_room from public.rooms where id=v_round.room_id;

  select coalesce(max(cnt),0) into v_max from (
    select count(*)::int cnt from public.votes where round_id=v_round.id group by voted_player_id
  ) q;
  select count(*)::int into v_imposter_votes from public.votes where round_id=v_round.id and voted_player_id=v_round.imposter_player_id;
  select count(*)::int into v_top_count from (
    select voted_player_id,count(*)::int cnt from public.votes where round_id=v_round.id group by voted_player_id
  ) q where q.cnt=v_max and v_max>0;
  v_caught := (v_max>0 and v_imposter_votes=v_max and v_top_count=1);

  update public.players p set score=score+1
   where p.room_id=v_room.id and p.id<>v_round.imposter_player_id
     and exists(select 1 from public.votes v where v.round_id=v_round.id and v.voter_player_id=p.id and v.voted_player_id=v_round.imposter_player_id);
  if not v_caught then update public.players set score=score+3 where id=v_round.imposter_player_id; end if;

  update public.rounds set status='results',revealed_at=now() where id=v_round.id;
  update public.rooms set status='results' where id=v_room.id;
  perform public.emit_room_event(v_room.id,'round_finished');
end;
$$;
