create or replace function public.cast_vote(p_code text,p_player_token uuid,p_voted_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_me public.players;
  v_round public.rounds;
  v_player_count int;
  v_vote_count int;
begin
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and expires_at>=now();
  if not found or v_room.status<>'discussion' then raise exception 'No active round.'; end if;
  select * into v_me from public.players where room_id=v_room.id and player_token=p_player_token and active;
  if not found then raise exception 'Player session invalid.'; end if;
  if v_me.id=p_voted_player_id then raise exception 'You cannot vote for yourself.'; end if;
  if not exists(select 1 from public.players where id=p_voted_player_id and room_id=v_room.id and active) then raise exception 'Invalid vote target.'; end if;
  select * into v_round from public.rounds where id=v_room.current_round_id;
  if v_round.status<>'discussion' then raise exception 'Voting is closed.'; end if;
  if now() >= v_round.ends_at then perform public.finalize_round_internal(v_round.id); return jsonb_build_object('finished',true); end if;

  insert into public.votes(round_id,voter_player_id,voted_player_id) values(v_round.id,v_me.id,p_voted_player_id)
  on conflict(round_id,voter_player_id) do update set voted_player_id=excluded.voted_player_id,created_at=now();
  perform public.emit_room_event(v_room.id,'vote_changed');
  select count(*) into v_player_count from public.players where room_id=v_room.id and active;
  select count(*) into v_vote_count from public.votes where round_id=v_round.id;
  if v_vote_count>=v_player_count then perform public.finalize_round_internal(v_round.id); return jsonb_build_object('finished',true); end if;
  return jsonb_build_object('finished',false,'votes_cast',v_vote_count,'players',v_player_count);
end;
$$;

create or replace function public.finalize_if_expired(p_code text,p_player_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_room public.rooms; v_me public.players; v_round public.rounds;
begin
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and expires_at>=now();
  if not found then return false; end if;
  select * into v_me from public.players where room_id=v_room.id and player_token=p_player_token and active;
  if not found then return false; end if;
  if v_room.status<>'discussion' or v_room.current_round_id is null then return false; end if;
  select * into v_round from public.rounds where id=v_room.current_round_id;
  if v_round.status='discussion' and now()>=v_round.ends_at then perform public.finalize_round_internal(v_round.id); return true; end if;
  return false;
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
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and host_token=p_host_token and expires_at>=now();
  if not found then raise exception 'Host session invalid.'; end if;
  if v_room.status='discussion' then raise exception 'Finish the current round first.'; end if;
  update public.rooms set status='lobby',current_round_id=null where id=v_room.id;
  perform public.emit_room_event(v_room.id,'back_to_lobby');
end;
$$;

create or replace function public.leave_game_room(p_code text,p_player_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_room public.rooms; v_me public.players;
begin
  select * into v_room from public.rooms where code=upper(btrim(p_code)) and expires_at>=now();
  if not found then raise exception 'Room not found or expired.'; end if;
  select * into v_me from public.players where room_id=v_room.id and player_token=p_player_token and active;
  if not found then raise exception 'Player session invalid.'; end if;
  if v_room.status='discussion' then raise exception 'You cannot leave during an active round.'; end if;
  if v_me.id=v_room.host_player_id then
    delete from public.rooms where id=v_room.id;
  else
    update public.players set active=false where id=v_me.id;
    perform public.emit_room_event(v_room.id,'player_left');
  end if;
end;
$$;

revoke all on function public.make_room_code() from public;
revoke all on function public.emit_room_event(uuid,text) from public;
revoke all on function public.finalize_round_internal(uuid) from public;
revoke execute on function public.make_room_code() from anon, authenticated;
revoke execute on function public.emit_room_event(uuid,text) from anon, authenticated;
revoke execute on function public.finalize_round_internal(uuid) from anon, authenticated;

revoke all on function public.create_game_room(text,text,integer) from public;
revoke all on function public.join_game_room(text,text) from public;
revoke all on function public.get_game_state(text,uuid) from public;
revoke all on function public.host_update_settings(text,uuid,text,integer) from public;
revoke all on function public.host_start_round(text,uuid) from public;
revoke all on function public.cast_vote(text,uuid,uuid) from public;
revoke all on function public.finalize_if_expired(text,uuid) from public;
revoke all on function public.host_return_to_lobby(text,uuid) from public;
revoke all on function public.leave_game_room(text,uuid) from public;

grant execute on function public.create_game_room(text,text,integer) to anon, authenticated;
grant execute on function public.join_game_room(text,text) to anon, authenticated;
grant execute on function public.get_game_state(text,uuid) to anon, authenticated;
grant execute on function public.host_update_settings(text,uuid,text,integer) to anon, authenticated;
grant execute on function public.host_start_round(text,uuid) to anon, authenticated;
grant execute on function public.cast_vote(text,uuid,uuid) to anon, authenticated;
grant execute on function public.finalize_if_expired(text,uuid) to anon, authenticated;
grant execute on function public.host_return_to_lobby(text,uuid) to anon, authenticated;
grant execute on function public.leave_game_room(text,uuid) to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.room_events;
  exception when duplicate_object then null;
  end;
end $$;
