create or replace function public.make_room_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return result;
end;
$$;

create or replace function public.emit_room_event(p_room_id uuid, p_event text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.room_events(room_id,event_type) values (p_room_id,p_event);
$$;

create or replace function public.create_game_room(
  p_name text,
  p_theme_key text default 'mixed',
  p_timer_seconds integer default 150
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
    raise exception 'Demo room capacity reached. Try again after an older room expires.';
  end if;
  p_name := btrim(p_name);
  if char_length(p_name) < 1 or char_length(p_name) > 24 then raise exception 'Name must be 1 to 24 characters.'; end if;
  if not exists(select 1 from public.game_themes where key=p_theme_key) then raise exception 'Invalid theme.'; end if;
  p_timer_seconds := greatest(30, least(900, p_timer_seconds));

  loop
    v_try := v_try + 1;
    v_code := public.make_room_code();
    begin
      insert into public.rooms(code,theme_key,timer_seconds) values (v_code,p_theme_key,p_timer_seconds) returning * into v_room;
      exit;
    exception when unique_violation then
      if v_try >= 20 then raise exception 'Could not generate room code.'; end if;
    end;
  end loop;

  insert into public.players(room_id,name) values (v_room.id,p_name) returning * into v_player;
  update public.rooms set host_player_id=v_player.id where id=v_room.id;
  perform public.emit_room_event(v_room.id,'room_created');
  return jsonb_build_object(
    'room_id',v_room.id,'room_code',v_room.code,'host_token',v_room.host_token,
    'player_id',v_player.id,'player_token',v_player.player_token
  );
end;
$$;

create or replace function public.join_game_room(p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_player public.players;
  v_count int;
begin
  p_code := upper(btrim(p_code)); p_name := btrim(p_name);
  select * into v_room from public.rooms where code=p_code and expires_at >= now();
  if not found then raise exception 'Room not found or expired.'; end if;
  if v_room.status <> 'lobby' then raise exception 'This room has already started.'; end if;
  if char_length(p_name) < 1 or char_length(p_name) > 24 then raise exception 'Name must be 1 to 24 characters.'; end if;
  select count(*) into v_count from public.players where room_id=v_room.id and active;
  if v_count >= 12 then raise exception 'Room is full (12 players max).'; end if;
  if exists(select 1 from public.players where room_id=v_room.id and active and lower(name)=lower(p_name)) then raise exception 'That name is already in this room.'; end if;
  insert into public.players(room_id,name) values(v_room.id,p_name) returning * into v_player;
  perform public.emit_room_event(v_room.id,'player_joined');
  return jsonb_build_object('room_id',v_room.id,'room_code',v_room.code,'player_id',v_player.id,'player_token',v_player.player_token);
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

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'score',score,'is_host',id=v_room.host_player_id) order by joined_at),'[]'::jsonb)
  into v_players from public.players where room_id=v_room.id and active;

  if v_room.current_round_id is not null then
    select * into v_round from public.rounds where id=v_room.current_round_id;
    select word into v_word from public.game_cards where id=v_round.card_id;
    if v_round.status='discussion' then
      if v_me.id=v_round.imposter_player_id then v_role:='imposter'; else v_role:='player'; v_my_word:=v_word; end if;
      select voted_player_id into v_voted_for from public.votes where round_id=v_round.id and voter_player_id=v_me.id;
      select count(*) into v_vote_count from public.votes where round_id=v_round.id;
    else
      select coalesce(jsonb_agg(jsonb_build_object('player_id',x.player_id,'name',x.name,'votes',x.votes) order by x.votes desc,x.name),'[]'::jsonb)
      into v_votes
      from (
        select p.id player_id,p.name,count(v.voter_player_id)::int votes
        from public.players p left join public.votes v on v.voted_player_id=p.id and v.round_id=v_round.id
        where p.room_id=v_room.id and p.active group by p.id,p.name
      ) x;
    end if;
  end if;

  return jsonb_build_object(
    'room',jsonb_build_object('id',v_room.id,'code',v_room.code,'status',v_room.status,'theme_key',v_room.theme_key,'timer_seconds',v_room.timer_seconds,'round_number',v_room.round_number,'is_host',v_me.id=v_room.host_player_id),
    'me',jsonb_build_object('id',v_me.id,'name',v_me.name,'score',v_me.score),
    'players',v_players,
    'round',case when v_round.id is null then null else jsonb_build_object(
      'id',v_round.id,'number',v_round.round_number,'status',v_round.status,'started_at',v_round.started_at,'ends_at',v_round.ends_at,
      'role',v_role,'word',v_my_word,'voted_for',v_voted_for,'votes_cast',v_vote_count,
      'imposter_id',case when v_round.status='results' then v_round.imposter_player_id else null end,
      'imposter_name',case when v_round.status='results' then (select name from public.players where id=v_round.imposter_player_id) else null end,
      'secret_word',case when v_round.status='results' then v_word else null end,
      'vote_tally',case when v_round.status='results' then v_votes else null end
    ) end
  );
end;
$$;
