alter table public.rooms
  add column play_mode text not null default 'remote' check (play_mode in ('same_room','remote')),
  add column video_enabled boolean not null default true,
  add column ready_required boolean not null default true;

alter table public.players
  add column ready boolean not null default false,
  add column last_seen timestamptz not null default now();

create or replace function public.create_x_room(
  p_name text,
  p_theme_key text default 'mixed',
  p_timer_seconds integer default 150,
  p_play_mode text default 'remote',
  p_video_enabled boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_player public.players;
  v_code text;
  v_try int := 0;
  v_active_rooms int;
begin
  delete from public.rooms where expires_at < now();
  select count(*) into v_active_rooms from public.rooms where expires_at >= now();
  if v_active_rooms >= 20 then
    raise exception 'Room capacity reached. Try again after an older room expires.';
  end if;

  p_name := btrim(p_name);
  if char_length(p_name) < 1 or char_length(p_name) > 24 then
    raise exception 'Name must be 1 to 24 characters.';
  end if;
  if not exists(select 1 from public.game_themes where key=p_theme_key) then
    raise exception 'Invalid theme.';
  end if;
  if p_play_mode not in ('same_room','remote') then
    raise exception 'Invalid play mode.';
  end if;
  p_timer_seconds := greatest(30, least(900, p_timer_seconds));

  loop
    v_try := v_try + 1;
    v_code := public.make_room_code();
    begin
      insert into public.rooms(code,theme_key,timer_seconds,play_mode,video_enabled,ready_required)
      values (v_code,p_theme_key,p_timer_seconds,p_play_mode,p_video_enabled,(p_play_mode='remote'))
      returning * into v_room;
      exit;
    exception when unique_violation then
      if v_try >= 20 then raise exception 'Could not generate room code.'; end if;
    end;
  end loop;

  insert into public.players(room_id,name,ready)
  values (v_room.id,p_name,false)
  returning * into v_player;

  update public.rooms set host_player_id=v_player.id where id=v_room.id;
  perform public.emit_room_event(v_room.id,'room_created');

  return jsonb_build_object(
    'room_id',v_room.id,
    'room_code',v_room.code,
    'host_token',v_room.host_token,
    'player_id',v_player.id,
    'player_token',v_player.player_token
  );
end;
$$;

create or replace function public.set_player_ready(
  p_code text,
  p_player_token uuid,
  p_ready boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_me public.players;
begin
  select * into v_room
  from public.rooms
  where code=upper(btrim(p_code)) and expires_at>=now();
  if not found then raise exception 'Room not found or expired.'; end if;
  if v_room.status <> 'lobby' then raise exception 'Ready status can only change in the lobby.'; end if;

  select * into v_me
  from public.players
  where room_id=v_room.id and player_token=p_player_token and active;
  if not found then raise exception 'Player session invalid.'; end if;

  update public.players
  set ready=coalesce(p_ready,false), last_seen=now()
  where id=v_me.id;
  perform public.emit_room_event(v_room.id,'ready_changed');
end;
$$;

create or replace function public.host_update_x_settings(
  p_code text,
  p_host_token uuid,
  p_theme_key text,
  p_timer_seconds integer,
  p_play_mode text,
  p_video_enabled boolean,
  p_ready_required boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  select * into v_room
  from public.rooms
  where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now();
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status <> 'lobby' then raise exception 'Settings can only be changed in the lobby.'; end if;
  if not exists(select 1 from public.game_themes where key=p_theme_key) then raise exception 'Invalid theme.'; end if;
  if p_play_mode not in ('same_room','remote') then raise exception 'Invalid play mode.'; end if;

  update public.rooms
  set theme_key=p_theme_key,
      timer_seconds=greatest(30,least(900,p_timer_seconds)),
      play_mode=p_play_mode,
      video_enabled=coalesce(p_video_enabled,true),
      ready_required=case when p_play_mode='same_room' then false else coalesce(p_ready_required,true) end
  where id=v_room.id;

  perform public.emit_room_event(v_room.id,'settings_changed');
end;
$$;

create or replace function public.host_kick_player(
  p_code text,
  p_host_token uuid,
  p_player_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  select * into v_room
  from public.rooms
  where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now();
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status <> 'lobby' then raise exception 'Players can only be removed in the lobby.'; end if;
  if p_player_id=v_room.host_player_id then raise exception 'The host cannot remove themselves.'; end if;
  if not exists(select 1 from public.players where id=p_player_id and room_id=v_room.id and active) then
    raise exception 'Player not found.';
  end if;

  update public.players set active=false, ready=false where id=p_player_id;
  perform public.emit_room_event(v_room.id,'player_kicked');
end;
$$;

create or replace function public.get_game_state(p_code text, p_player_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_me public.players;
  v_round public.rounds;
  v_word text;
  v_players jsonb;
  v_votes jsonb := '[]'::jsonb;
  v_role text := null;
  v_my_word text := null;
  v_voted_for uuid := null;
  v_vote_count int := 0;
begin
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and expires_at >= now();
  if not found then raise exception 'Room not found or expired.'; end if;
  select * into v_me from public.players where room_id=v_room.id and player_token=p_player_token and active;
  if not found then raise exception 'Player session is invalid.'; end if;

  update public.players set last_seen=now() where id=v_me.id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',id,
      'name',name,
      'score',score,
      'ready',ready,
      'is_host',id=v_room.host_player_id
    ) order by joined_at
  ),'[]'::jsonb)
  into v_players
  from public.players where room_id=v_room.id and active;

  if v_room.current_round_id is not null then
    select * into v_round from public.rounds where id=v_room.current_round_id;
    select word into v_word from public.game_cards where id=v_round.card_id;
    if v_round.status='discussion' then
      if v_me.id=v_round.imposter_player_id then
        v_role:='imposter';
      else
        v_role:='player';
        v_my_word:=v_word;
      end if;
      select voted_player_id into v_voted_for from public.votes where round_id=v_round.id and voter_player_id=v_me.id;
      select count(*) into v_vote_count from public.votes where round_id=v_round.id;
    else
      select coalesce(jsonb_agg(jsonb_build_object('player_id',x.player_id,'name',x.name,'votes',x.votes) order by x.votes desc,x.name),'[]'::jsonb)
      into v_votes
      from (
        select p.id player_id,p.name,count(v.voter_player_id)::int votes
        from public.players p
        left join public.votes v on v.voted_player_id=p.id and v.round_id=v_round.id
        where p.room_id=v_room.id and p.active
        group by p.id,p.name
      ) x;
    end if;
  end if;

  return jsonb_build_object(
    'room',jsonb_build_object(
      'id',v_room.id,
      'code',v_room.code,
      'status',v_room.status,
      'theme_key',v_room.theme_key,
      'timer_seconds',v_room.timer_seconds,
      'round_number',v_room.round_number,
      'is_host',v_me.id=v_room.host_player_id,
      'play_mode',v_room.play_mode,
      'video_enabled',v_room.video_enabled,
      'ready_required',v_room.ready_required
    ),
    'me',jsonb_build_object('id',v_me.id,'name',v_me.name,'score',v_me.score,'ready',v_me.ready),
    'players',v_players,
    'round',case when v_round.id is null then null else jsonb_build_object(
      'id',v_round.id,
      'number',v_round.round_number,
      'status',v_round.status,
      'started_at',v_round.started_at,
      'ends_at',v_round.ends_at,
      'role',v_role,
      'word',v_my_word,
      'voted_for',v_voted_for,
      'votes_cast',v_vote_count,
      'imposter_id',case when v_round.status='results' then v_round.imposter_player_id else null end,
      'imposter_name',case when v_round.status='results' then (select name from public.players where id=v_round.imposter_player_id) else null end,
      'secret_word',case when v_round.status='results' then v_word else null end,
      'vote_tally',case when v_round.status='results' then v_votes else null end
    ) end
  );
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
  v_unready int;
  v_card_id bigint;
  v_imposter uuid;
  v_round public.rounds;
  v_prev uuid;
  v_min_count int;
begin
  select * into v_room from public.rooms
  where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now()
  for update;
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status='discussion' then raise exception 'A round is already active.'; end if;

  select count(*) into v_count from public.players where room_id=v_room.id and active;
  if v_count < 3 then raise exception 'At least 3 players are required.'; end if;
  if v_count > 12 then raise exception 'Maximum is 12 players.'; end if;

  if v_room.ready_required then
    select count(*) into v_unready from public.players where room_id=v_room.id and active and not ready;
    if v_unready > 0 then raise exception 'Everyone must be ready before the round starts.'; end if;
  end if;

  select imposter_player_id into v_prev from public.rounds where room_id=v_room.id order by round_number desc limit 1;
  select min(imposter_count) into v_min_count from public.players where room_id=v_room.id and active;
  select id into v_imposter
  from public.players
  where room_id=v_room.id and active and imposter_count=v_min_count
  order by (id=v_prev), random() limit 1;

  select c.id into v_card_id
  from public.game_cards c
  where c.theme_key=v_room.theme_key and c.enabled
    and not exists(select 1 from public.room_card_history h where h.room_id=v_room.id and h.card_id=c.id)
  order by random() limit 1;

  if v_card_id is null then
    delete from public.room_card_history h
    using public.game_cards c
    where h.room_id=v_room.id and h.card_id=c.id and c.theme_key=v_room.theme_key;
    select id into v_card_id from public.game_cards where theme_key=v_room.theme_key and enabled order by random() limit 1;
  end if;

  insert into public.room_card_history(room_id,card_id) values(v_room.id,v_card_id) on conflict do nothing;
  update public.players set imposter_count=imposter_count+1 where id=v_imposter;

  insert into public.rounds(room_id,round_number,card_id,imposter_player_id,ends_at)
  values(v_room.id,v_room.round_number+1,v_card_id,v_imposter,now()+make_interval(secs=>v_room.timer_seconds))
  returning * into v_round;

  update public.rooms
  set status='discussion', round_number=v_round.round_number, current_round_id=v_round.id
  where id=v_room.id;

  perform public.emit_room_event(v_room.id,'round_started');
  return jsonb_build_object('round_id',v_round.id,'ends_at',v_round.ends_at);
end;
$$;

create or replace function public.host_return_to_lobby(p_code text,p_host_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_room public.rooms;
begin
  select * into v_room from public.rooms
  where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now();
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status='discussion' then raise exception 'Finish the current round first.'; end if;

  update public.rooms set status='lobby',current_round_id=null where id=v_room.id;
  update public.players set ready=false where room_id=v_room.id and active;
  perform public.emit_room_event(v_room.id,'back_to_lobby');
end;
$$;

revoke all on function public.create_x_room(text,text,integer,text,boolean) from public;
revoke all on function public.set_player_ready(text,uuid,boolean) from public;
revoke all on function public.host_update_x_settings(text,uuid,text,integer,text,boolean,boolean) from public;
revoke all on function public.host_kick_player(text,uuid,uuid) from public;

grant execute on function public.create_x_room(text,text,integer,text,boolean) to anon, authenticated;
grant execute on function public.set_player_ready(text,uuid,boolean) to anon, authenticated;
grant execute on function public.host_update_x_settings(text,uuid,text,integer,text,boolean,boolean) to anon, authenticated;
grant execute on function public.host_kick_player(text,uuid,uuid) to anon, authenticated;
