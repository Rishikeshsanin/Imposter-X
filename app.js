import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const SUPABASE_URL = 'https://eafzaolucefpyxvjfjwr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_VHs21VCKNj2zfK2L04cqDA_HgDNRUx6';
const SESSION_KEY = 'imposter_x_session_v1';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const LK = window.LivekitClient || {};
const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const gameStatus = document.querySelector('#gameStatus');
const callStatus = document.querySelector('#callStatus');
const callDock = document.querySelector('#callDock');
const callTitle = document.querySelector('#callTitle');
const mediaGrid = document.querySelector('#mediaGrid');
const callJoinPanel = document.querySelector('#callJoinPanel');
const callControls = document.querySelector('#callControls');
const micBtn = document.querySelector('#micBtn');
const camBtn = document.querySelector('#camBtn');
const chatBtn = document.querySelector('#chatBtn');
const reactBtn = document.querySelector('#reactBtn');
const leaveCallBtn = document.querySelector('#leaveCallBtn');
const collapseCall = document.querySelector('#collapseCall');
const reactionTray = document.querySelector('#reactionTray');
const chatPanel = document.querySelector('#chatPanel');
const chatMessages = document.querySelector('#chatMessages');
const chatForm = document.querySelector('#chatForm');
const chatInput = document.querySelector('#chatInput');
const reactionLayer = document.querySelector('#reactionLayer');
const audioSink = document.querySelector('#audioSink');

const THEMES = {
  popularPeople: ['Popular People', 'Celebrities, athletes, creators and famous personalities.'],
  mixed: ['Mixed', 'Objects, places, food, brands, games and random chaos.'],
  movies: ['Movies', 'Popular films from Hollywood, Bollywood and worldwide cinema.'],
  tollywoodMovies: ['Tollywood Movies', 'Popular Telugu-language films.'],
  tollywoodActors: ['Tollywood Actors', 'Popular Telugu actors and personalities.'],
  animals: ['Animals', 'Pets, wildlife, ocean creatures and more.'],
  moviesTv: ['Movies & TV Shows', 'Movies, series, sitcoms, animation and anime.'],
};

let session = loadSession();
let state = null;
let realtimeChannel = null;
let refreshBusy = false;
let pollTimer = null;
let countdownTimer = null;
let selectedCreateMode = 'remote';
let roleRevealRoundId = null;
let roleRevealed = false;

let liveRoom = null;
let callJoined = false;
let callConnecting = false;
let chatLog = [];
let callCollapsed = false;

function esc(value = '') {
  return String(value).replace(/[&<>'\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;' }[c]));
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function saveSession(next) {
  session = next;
  if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  else localStorage.removeItem(SESSION_KEY);
}

function toast(message, ms = 2700) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function rpcError(error) {
  const text = error?.message || error?.details || error?.hint || 'Something went wrong.';
  return text.replace(/^.*?error:\s*/i, '');
}

function initials(name = '?') {
  return name.trim().split(/\s+/).slice(0, 2).map((x) => x[0]?.toUpperCase() || '').join('') || '?';
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function themeOptions(selected) {
  return Object.entries(THEMES).map(([key, [name]]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${esc(name)}</option>`).join('');
}

function timerOptions(selected = 150) {
  const values = [60, 90, 120, 150, 180, 240, 300, 420, 600, 900];
  if (!values.includes(Number(selected))) values.push(Number(selected));
  return [...new Set(values)].sort((a, b) => a - b).map((v) => `<option value="${v}" ${Number(selected) === v ? 'selected' : ''}>${v < 60 ? `${v}s` : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}</option>`).join('');
}

async function createRoom({ name, theme, timer, mode, video }) {
  const { data, error } = await supabase.rpc('create_x_room', {
    p_name: name,
    p_theme_key: theme,
    p_timer_seconds: Number(timer),
    p_play_mode: mode,
    p_video_enabled: Boolean(video),
  });
  if (error) throw error;
  saveSession({ roomCode: data.room_code, playerToken: data.player_token, playerId: data.player_id, hostToken: data.host_token });
  history.replaceState({}, '', `?room=${data.room_code}`);
  await refreshState(true);
}

async function joinRoom({ name, code }) {
  const { data, error } = await supabase.rpc('join_game_room', { p_code: code, p_name: name });
  if (error) throw error;
  saveSession({ roomCode: data.room_code, playerToken: data.player_token, playerId: data.player_id });
  history.replaceState({}, '', `?room=${data.room_code}`);
  await refreshState(true);
}

async function refreshState(forceRender = false) {
  if (!session || refreshBusy) return;
  refreshBusy = true;
  try {
    const { data, error } = await supabase.rpc('get_game_state', { p_code: session.roomCode, p_player_token: session.playerToken });
    if (error) throw error;
    const prev = state;
    state = data;
    gameStatus.textContent = `● ${String(state.room.status).toUpperCase()}`;

    if (state.round?.id !== roleRevealRoundId) {
      roleRevealRoundId = state.round?.id || null;
      roleRevealed = false;
    }

    if (!prev || prev.room?.id !== state.room.id) subscribeRoomEvents();
    syncCallDock();
    if (forceRender || !prev || meaningfulStateChanged(prev, state)) render();
    startTimers();
  } catch (error) {
    const msg = rpcError(error);
    if (/session|room not found|expired|invalid/i.test(msg)) {
      await leaveCall({ silent: true });
      saveSession(null);
      state = null;
      unsubscribeRoomEvents();
      history.replaceState({}, '', location.pathname);
      toast(msg);
      renderHome();
    } else {
      toast(msg);
    }
  } finally {
    refreshBusy = false;
  }
}

function meaningfulStateChanged(a, b) {
  return JSON.stringify({ room: a.room, me: a.me, players: a.players, round: a.round }) !== JSON.stringify({ room: b.room, me: b.me, players: b.players, round: b.round });
}

function subscribeRoomEvents() {
  unsubscribeRoomEvents();
  if (!state?.room?.id) return;
  realtimeChannel = supabase
    .channel(`imposter-x-${state.room.id}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_events', filter: `room_id=eq.${state.room.id}` }, () => refreshState(true))
    .subscribe();
}

function unsubscribeRoomEvents() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

function startTimers() {
  clearInterval(pollTimer);
  clearInterval(countdownTimer);
  pollTimer = setInterval(() => session && refreshState(false), state?.room?.status === 'discussion' ? 2500 : 5000);
  if (state?.room?.status === 'discussion' && state.round?.ends_at) {
    countdownTimer = setInterval(async () => {
      const timerEl = document.querySelector('#roundTimer');
      const remaining = (new Date(state.round.ends_at).getTime() - Date.now()) / 1000;
      if (timerEl) timerEl.textContent = formatTime(remaining);
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        await supabase.rpc('finalize_if_expired', { p_code: session.roomCode, p_player_token: session.playerToken });
        await refreshState(true);
      }
    }, 250);
  }
}

function render() {
  if (!session || !state) return renderHome();
  if (state.room.status === 'lobby') renderLobby();
  else if (state.room.status === 'discussion') renderDiscussion();
  else renderResults();
}

function renderHome() {
  gameStatus.textContent = '● GAME LIVE';
  callDock.hidden = true;
  app.innerHTML = `
    <div class="hero">
      <span class="hero-mark">⚡ Realtime social deduction</span>
      <h1>TRUST NO ONE.<br><span>READ EVERYONE.</span></h1>
      <p class="muted">Play together in the same room, or go fully remote with built-in low-latency voice and video.</p>
    </div>
    <div class="mode-grid">
      <button class="mode-card remote" data-create-mode="remote">
        <span class="mode-badge">VOICE + VIDEO</span><div class="mode-icon">🌐</div>
        <h3>Remote Room</h3><p>Friends can join from anywhere. Integrated call, chat, reactions and active-speaker video.</p>
      </button>
      <button class="mode-card" data-create-mode="same_room">
        <div class="mode-icon">🏠</div><h3>Same Room</h3><p>Everyone is physically together. Phones handle roles, timing, voting and scores — no call echo.</p>
      </button>
    </div>
    <div class="join-strip">
      <input id="quickCode" class="input" maxlength="6" autocomplete="off" placeholder="ENTER ROOM CODE" value="${esc(new URLSearchParams(location.search).get('room') || '')}" />
      <button id="openJoin" class="btn primary">Join room</button>
    </div>
    <div id="homeForm"></div>`;

  document.querySelectorAll('[data-create-mode]').forEach((btn) => btn.addEventListener('click', () => {
    selectedCreateMode = btn.dataset.createMode;
    renderCreateForm();
  }));
  document.querySelector('#openJoin').addEventListener('click', () => renderJoinForm(document.querySelector('#quickCode').value));
  document.querySelector('#quickCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderJoinForm(e.currentTarget.value); });

  if (new URLSearchParams(location.search).get('room')) renderJoinForm(new URLSearchParams(location.search).get('room'));
}

function renderCreateForm() {
  const host = document.querySelector('#homeForm');
  const remote = selectedCreateMode === 'remote';
  host.innerHTML = `
    <form id="createForm" class="form-card stack">
      <div class="form-title"><div><div class="eyebrow">Create ${remote ? 'remote' : 'same-room'} game</div><h2>${remote ? 'Open the call room' : 'Start the table'}</h2></div><button type="button" id="closeHomeForm" class="icon-btn">×</button></div>
      <div class="grid">
        <div class="field"><label>Your name</label><input name="name" class="input" maxlength="24" required placeholder="Rishi" autocomplete="nickname" /></div>
        <div class="field"><label>Theme</label><select name="theme" class="select">${themeOptions('mixed')}</select></div>
      </div>
      <div class="grid">
        <div class="field"><label>Discussion timer</label><select name="timer" class="select">${timerOptions(150)}</select></div>
        ${remote ? `<div class="toggle-row"><div><strong>Video available</strong><div class="small muted">Everyone chooses camera on/off.</div></div><input name="video" class="switch" type="checkbox" checked /></div>` : `<div class="toggle-row"><div><strong>No call mode</strong><div class="small muted">Best when everyone is together.</div></div><span>🏠</span></div>`}
      </div>
      <button class="btn primary">Create ${remote ? 'Remote Room' : 'Same Room'}</button>
    </form>`;
  document.querySelector('#closeHomeForm').onclick = () => { host.innerHTML = ''; };
  document.querySelector('#createForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const button = e.currentTarget.querySelector('button[type="submit"], .btn.primary');
    button.disabled = true;
    try {
      await createRoom({ name: fd.get('name'), theme: fd.get('theme'), timer: fd.get('timer'), mode: selectedCreateMode, video: remote ? fd.get('video') === 'on' : false });
    } catch (error) { toast(rpcError(error)); button.disabled = false; }
  };
}

function renderJoinForm(code = '') {
  const host = document.querySelector('#homeForm');
  host.innerHTML = `
    <form id="joinForm" class="form-card stack">
      <div class="form-title"><div><div class="eyebrow">Join a game</div><h2>Enter the room</h2></div><button type="button" id="closeHomeForm" class="icon-btn">×</button></div>
      <div class="grid">
        <div class="field"><label>Your name</label><input name="name" class="input" maxlength="24" required placeholder="Your nickname" autocomplete="nickname" /></div>
        <div class="field"><label>Room code</label><input name="code" class="input" maxlength="6" required value="${esc(String(code).toUpperCase())}" placeholder="ABC123" style="text-transform:uppercase" /></div>
      </div>
      <button class="btn primary">Join Room</button>
    </form>`;
  document.querySelector('#closeHomeForm').onclick = () => { host.innerHTML = ''; };
  document.querySelector('#joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const button = e.currentTarget.querySelector('.btn.primary');
    button.disabled = true;
    try { await joinRoom({ name: fd.get('name'), code: String(fd.get('code')).toUpperCase() }); }
    catch (error) { toast(rpcError(error)); button.disabled = false; }
  };
}

function renderLobby() {
  const room = state.room;
  const remote = room.play_mode === 'remote';
  const everyoneReady = state.players.every((p) => p.ready);
  const enough = state.players.length >= 3;
  const canStart = enough && (!room.ready_required || everyoneReady);
  const isHost = room.is_host;
  app.innerHTML = `
    <div class="room-head">
      <div class="eyebrow">${remote ? '🌐 Remote Room' : '🏠 Same Room'} · ${esc(THEMES[room.theme_key]?.[0] || room.theme_key)}</div>
      <div class="roomcode">${esc(room.code)}</div>
      <button id="copyInvite" class="copy-link">Copy invite link ↗</button>
      <div class="small muted">${state.players.length}/12 players · ${Math.round(room.timer_seconds / 30) * 30}s timer${remote ? ` · ${room.video_enabled ? 'video available' : 'voice only'}` : ''}</div>
    </div>

    <div class="players">
      ${state.players.map((p) => `
        <div class="player">
          <div class="avatar">${esc(initials(p.name))}</div>
          <div class="player-main"><div class="player-name">${esc(p.name)} ${p.is_host ? '<span class="badge">HOST</span>' : ''}</div><div class="player-meta">${p.id === state.me.id ? 'You' : remote ? 'Connected to game' : 'In the room'} · ${p.score} pts</div></div>
          ${room.ready_required ? `<span class="ready-pill ${p.ready ? 'on' : ''}">${p.ready ? 'READY' : 'NOT READY'}</span>` : `<span class="score">${p.score}</span>`}
          ${isHost && !p.is_host ? `<button class="kick-btn" data-kick="${p.id}" title="Remove player">×</button>` : ''}
        </div>`).join('')}
    </div>

    ${room.ready_required ? `<div class="ready-action"><div><strong>${state.me.ready ? 'You are ready' : 'Ready to lie?'}</strong><div class="small muted">Every player must be ready before the host can start.</div></div><button id="readyBtn" class="btn ${state.me.ready ? 'ghost' : 'success'}">${state.me.ready ? 'Not ready' : 'I’m ready'}</button></div>` : ''}

    ${isHost ? `
      <div class="divider"></div>
      <div class="settings-panel stack">
        <div><div class="eyebrow">Host controls</div><h3 class="section-title">Room setup</h3></div>
        <div class="grid">
          <div class="field"><label>Theme</label><select id="settingTheme" class="select">${themeOptions(room.theme_key)}</select></div>
          <div class="field"><label>Timer</label><select id="settingTimer" class="select">${timerOptions(room.timer_seconds)}</select></div>
        </div>
        <div class="grid">
          <div class="field"><label>Play mode</label><select id="settingMode" class="select"><option value="remote" ${remote ? 'selected' : ''}>Remote — voice/video</option><option value="same_room" ${!remote ? 'selected' : ''}>Same room — no call</option></select></div>
          <div id="remoteSettings" class="stack">
            <div class="toggle-row"><div><strong>Video available</strong><div class="small muted">Players can still choose voice only.</div></div><input id="settingVideo" class="switch" type="checkbox" ${room.video_enabled ? 'checked' : ''} /></div>
            <div class="toggle-row"><div><strong>Ready check</strong><div class="small muted">Prevents accidental starts.</div></div><input id="settingReady" class="switch" type="checkbox" ${room.ready_required ? 'checked' : ''} /></div>
          </div>
        </div>
        <button id="saveSettings" class="btn ghost">Save room settings</button>
      </div>
      <div class="actions"><button id="startRound" class="btn primary" ${canStart ? '' : 'disabled'}>${!enough ? `Need ${3 - state.players.length} more player${3 - state.players.length === 1 ? '' : 's'}` : room.ready_required && !everyoneReady ? 'Waiting for everyone' : 'Start Round ⚡'}</button></div>` : `<div class="actions"><button class="btn ghost" disabled>Waiting for host to start</button></div>`}
    <div class="actions"><button id="leaveRoom" class="btn danger">Leave Room</button></div>`;

  document.querySelector('#copyInvite').onclick = copyInvite;
  document.querySelector('#readyBtn')?.addEventListener('click', async () => {
    const { error } = await supabase.rpc('set_player_ready', { p_code: room.code, p_player_token: session.playerToken, p_ready: !state.me.ready });
    if (error) toast(rpcError(error)); else refreshState(true);
  });
  document.querySelectorAll('[data-kick]').forEach((btn) => btn.onclick = async () => {
    const player = state.players.find((p) => p.id === btn.dataset.kick);
    if (!confirm(`Remove ${player?.name || 'this player'} from the room?`)) return;
    const { error } = await supabase.rpc('host_kick_player', { p_code: room.code, p_host_token: session.hostToken, p_player_id: btn.dataset.kick });
    if (error) toast(rpcError(error)); else refreshState(true);
  });
  document.querySelector('#settingMode')?.addEventListener('change', updateSettingsVisibility);
  updateSettingsVisibility();
  document.querySelector('#saveSettings')?.addEventListener('click', saveHostSettings);
  document.querySelector('#startRound')?.addEventListener('click', startRound);
  document.querySelector('#leaveRoom').onclick = leaveGame;
}

function updateSettingsVisibility() {
  const mode = document.querySelector('#settingMode')?.value;
  const remoteSettings = document.querySelector('#remoteSettings');
  if (remoteSettings) remoteSettings.style.opacity = mode === 'remote' ? '1' : '.35';
}

async function saveHostSettings() {
  const mode = document.querySelector('#settingMode').value;
  const { error } = await supabase.rpc('host_update_x_settings', {
    p_code: state.room.code,
    p_host_token: session.hostToken,
    p_theme_key: document.querySelector('#settingTheme').value,
    p_timer_seconds: Number(document.querySelector('#settingTimer').value),
    p_play_mode: mode,
    p_video_enabled: mode === 'remote' && document.querySelector('#settingVideo').checked,
    p_ready_required: mode === 'remote' && document.querySelector('#settingReady').checked,
  });
  if (error) toast(rpcError(error)); else { toast('Room settings saved.'); refreshState(true); }
}

async function startRound() {
  const btn = document.querySelector('#startRound');
  if (btn) btn.disabled = true;
  const { error } = await supabase.rpc('host_start_round', { p_code: state.room.code, p_host_token: session.hostToken });
  if (error) { toast(rpcError(error)); if (btn) btn.disabled = false; }
  else refreshState(true);
}

function renderDiscussion() {
  const r = state.round;
  const isImposter = r.role === 'imposter';
  const otherPlayers = state.players.filter((p) => p.id !== state.me.id);
  app.innerHTML = `
    <div class="room-head"><div class="eyebrow">Round ${r.number} · ${esc(THEMES[state.room.theme_key]?.[0] || '')}</div><h2 class="section-title">Find the Imposter</h2></div>
    ${!roleRevealed ? `
      <button id="revealRole" class="role-card" style="width:100%;color:white;cursor:pointer"><div class="role-label">Private role</div><div class="word">TAP TO REVEAL</div><div class="muted">Keep your screen away from everyone else.</div></button>` : `
      <div class="role-card ${isImposter ? 'imposter' : ''}">
        <div class="role-label">${isImposter ? 'You are' : 'Your secret word'}</div>
        <div class="word">${isImposter ? 'IMPOSTER 😈' : esc(r.word)}</div>
        <div class="muted">${isImposter ? 'You got no word. Listen, bluff and survive.' : 'Give clues without making the word obvious.'}</div>
        <button id="hideRole" class="btn ghost" style="margin-top:16px">Hide role</button>
      </div>`}
    <div class="timer-wrap"><div class="eyebrow">Discussion ends in</div><div id="roundTimer" class="timer">${formatTime((new Date(r.ends_at).getTime() - Date.now()) / 1000)}</div><div class="small muted">Vote whenever you want · ${r.votes_cast}/${state.players.length} voted</div></div>
    <div class="divider"></div>
    <div><div class="eyebrow">Your vote is private</div><h3 class="section-title">Who is faking it?</h3></div>
    <div class="vote-grid">${otherPlayers.map((p) => `<button class="vote-btn ${r.voted_for === p.id ? 'selected' : ''}" data-vote="${p.id}">${esc(p.name)}${r.voted_for === p.id ? ' ✓' : ''}</button>`).join('')}</div>
    <div class="small muted" style="margin-top:10px">You can change your vote until everyone has voted or the timer expires.</div>`;

  document.querySelector('#revealRole')?.addEventListener('click', () => { roleRevealed = true; renderDiscussion(); });
  document.querySelector('#hideRole')?.addEventListener('click', () => { roleRevealed = false; renderDiscussion(); });
  document.querySelectorAll('[data-vote]').forEach((btn) => btn.onclick = async () => {
    document.querySelectorAll('[data-vote]').forEach((x) => { x.disabled = true; });
    const { error } = await supabase.rpc('cast_vote', { p_code: state.room.code, p_player_token: session.playerToken, p_voted_player_id: btn.dataset.vote });
    if (error) toast(rpcError(error));
    await refreshState(true);
  });
}

function renderResults() {
  const r = state.round;
  const caught = (() => {
    const top = Math.max(...(r.vote_tally || []).map((x) => x.votes), 0);
    const leaders = (r.vote_tally || []).filter((x) => x.votes === top && top > 0);
    return leaders.length === 1 && leaders[0].player_id === r.imposter_id;
  })();
  app.innerHTML = `
    <div class="result-hero">
      <div class="eyebrow">${caught ? 'CAUGHT' : 'ESCAPED'}</div>
      <div class="name">${esc(r.imposter_name || 'The Imposter')}</div>
      <div class="muted">was the Imposter</div>
      <div class="secret">Secret: ${esc(r.secret_word || '—')}</div>
    </div>
    <div class="divider"></div>
    <div class="grid">
      <div><div class="eyebrow">Vote tally</div><div class="tally">${(r.vote_tally || []).map((x) => `<div class="tally-row"><span>${esc(x.name)}</span><strong>${x.votes} vote${x.votes === 1 ? '' : 's'}</strong></div>`).join('')}</div></div>
      <div><div class="eyebrow">Scoreboard</div><div class="tally">${[...state.players].sort((a,b) => b.score-a.score).map((p,i) => `<div class="tally-row"><span>${i+1}. ${esc(p.name)}${p.id === state.me.id ? ' · YOU' : ''}</span><strong>${p.score}</strong></div>`).join('')}</div></div>
    </div>
    <div class="actions">${state.room.is_host ? '<button id="nextRound" class="btn primary">Next Round →</button>' : '<button class="btn ghost" disabled>Waiting for host</button>'}</div>
    <div class="actions"><button id="leaveRoom" class="btn danger">Leave Room</button></div>`;
  document.querySelector('#nextRound')?.addEventListener('click', async () => {
    const { error } = await supabase.rpc('host_return_to_lobby', { p_code: state.room.code, p_host_token: session.hostToken });
    if (error) toast(rpcError(error)); else refreshState(true);
  });
  document.querySelector('#leaveRoom').onclick = leaveGame;
}

async function leaveGame() {
  if (!session || !state) return;
  const { error } = await supabase.rpc('leave_game_room', { p_code: state.room.code, p_player_token: session.playerToken });
  if (error) return toast(rpcError(error));
  await leaveCall({ silent: true });
  saveSession(null); state = null; unsubscribeRoomEvents();
  history.replaceState({}, '', location.pathname);
  renderHome();
}

async function copyInvite() {
  const url = `${location.origin}${location.pathname}?room=${state.room.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied.'); }
  catch { toast(url, 5000); }
}

function syncCallDock() {
  const shouldShow = Boolean(state && state.room.play_mode === 'remote');
  callDock.hidden = !shouldShow;
  if (!shouldShow) {
    if (callJoined || callConnecting) leaveCall({ silent: true });
    return;
  }
  callDock.classList.toggle('collapsed', callCollapsed);
  collapseCall.textContent = callCollapsed ? '⌄' : '⌃';
  callTitle.textContent = `${state.room.code} · ${state.room.video_enabled ? 'Voice & video' : 'Voice room'}`;
  if (callJoined && !state.room.video_enabled && liveRoom) {
    liveRoom.localParticipant?.setCameraEnabled?.(false).then(() => renderMediaGrid()).catch(() => {});
  }
  if (!callJoined && !callConnecting) renderCallJoin();
}

function renderCallJoin(message = '') {
  callJoinPanel.hidden = false;
  callControls.hidden = true;
  mediaGrid.innerHTML = '';
  callJoinPanel.innerHTML = `<h3>🎙 Join the live conversation</h3><p class="muted">${message ? esc(message) : `Low-latency room audio${state?.room?.video_enabled ? ' + optional camera' : ''}. Your mic starts on; camera starts off.`}</p><button id="joinCallBtn" class="btn primary">Join Call</button>`;
  document.querySelector('#joinCallBtn')?.addEventListener('click', joinCall);
  setCallStatus('CALL OFF', '');
}

function setCallStatus(text, cls = '') {
  callStatus.textContent = text;
  callStatus.className = `call-status ${cls}`.trim();
}

async function joinCall() {
  if (callConnecting || callJoined || !state || state.room.play_mode !== 'remote') return;
  if (!LK.Room) return toast('LiveKit client failed to load. Refresh and try again.');
  callConnecting = true;
  callJoinPanel.innerHTML = '<h3>Connecting…</h3><p class="muted">Securing your room and finding the nearest media edge.</p>';
  setCallStatus('CONNECTING', 'reconnecting');
  try {
    const response = await fetch('/api/livekit-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: state.room.code, playerToken: session.playerToken }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not enter the call.');

    liveRoom = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: LK.VideoPresets?.h720 ? { resolution: LK.VideoPresets.h720.resolution } : undefined,
    });
    wireLiveKitEvents(liveRoom);
    if (typeof liveRoom.prepareConnection === 'function') liveRoom.prepareConnection(payload.server_url, payload.participant_token).catch(() => {});
    await liveRoom.connect(payload.server_url, payload.participant_token, { autoSubscribe: true });
    callJoined = true;
    callConnecting = false;
    callJoinPanel.hidden = true;
    callControls.hidden = false;
    setCallStatus('● CALL LIVE', 'connected');
    try { await liveRoom.localParticipant.setMicrophoneEnabled(true); } catch { toast('Microphone permission was blocked. You can enable it from the call controls.'); }
    renderMediaGrid();
    updateCallButtons();
  } catch (error) {
    callConnecting = false; callJoined = false;
    if (liveRoom) { try { liveRoom.disconnect(); } catch {} liveRoom = null; }
    renderCallJoin(error.message || 'Could not join the call.');
    toast(error.message || 'Could not join the call.');
  }
}

function wireLiveKitEvents(room) {
  const E = LK.RoomEvent || {};
  const redraw = () => renderMediaGrid();
  [E.ParticipantConnected, E.ParticipantDisconnected, E.TrackSubscribed, E.TrackUnsubscribed, E.TrackPublished, E.TrackUnpublished, E.TrackMuted, E.TrackUnmuted, E.LocalTrackPublished, E.LocalTrackUnpublished].filter(Boolean).forEach((event) => room.on(event, redraw));
  if (E.ActiveSpeakersChanged) room.on(E.ActiveSpeakersChanged, updateSpeakingStyles);
  if (E.ConnectionQualityChanged) room.on(E.ConnectionQualityChanged, redraw);
  if (E.Reconnecting) room.on(E.Reconnecting, () => setCallStatus('RECONNECTING', 'reconnecting'));
  if (E.Reconnected) room.on(E.Reconnected, () => { setCallStatus('● CALL LIVE', 'connected'); renderMediaGrid(); });
  if (E.Disconnected) room.on(E.Disconnected, () => {
    callJoined = false; callConnecting = false; liveRoom = null; setCallStatus('CALL OFF');
    if (state?.room?.play_mode === 'remote') renderCallJoin('Call disconnected. Your game seat is still safe.');
  });
  if (E.DataReceived) room.on(E.DataReceived, (payload, participant, _kind, topic) => handleCallData(payload, participant, topic));
}

function participantList() {
  if (!liveRoom) return [];
  const remotes = Array.from(liveRoom.remoteParticipants?.values?.() || []);
  return [liveRoom.localParticipant, ...remotes].filter(Boolean);
}

function getPublication(participant, source) {
  try {
    if (typeof participant.getTrackPublication === 'function') return participant.getTrackPublication(source);
    for (const pub of participant.trackPublications?.values?.() || []) if (pub.source === source) return pub;
  } catch {}
  return null;
}

function qualityClass(q) {
  const s = String(q || '').toLowerCase();
  if (s.includes('excellent')) return ['excellent', '●'];
  if (s.includes('good')) return ['good', '●'];
  if (s.includes('poor')) return ['poor', '●'];
  if (s.includes('lost')) return ['lost', '●'];
  return ['', ''];
}

function detachRenderedMedia() {
  document.querySelectorAll('#mediaGrid video, #audioSink audio').forEach((el) => {
    try { el._livekitTrack?.detach?.(el); } catch {}
  });
  mediaGrid.innerHTML = '';
  audioSink.innerHTML = '';
}

function updateSpeakingStyles() {
  if (!liveRoom || !callJoined) return;
  const active = new Set((liveRoom.activeSpeakers || []).map((p) => p.identity));
  mediaGrid.querySelectorAll('.media-tile').forEach((tile) => tile.classList.toggle('speaking', active.has(tile.dataset.identity)));
}

function renderMediaGrid() {
  if (!liveRoom || !callJoined) return;
  const participants = participantList();
  const active = new Set((liveRoom.activeSpeakers || []).map((p) => p.identity));
  detachRenderedMedia();

  participants.forEach((p) => {
    const local = p === liveRoom.localParticipant;
    const tile = document.createElement('div');
    tile.className = `media-tile ${local ? 'local' : 'remote'} ${active.has(p.identity) || p.isSpeaking ? 'speaking' : ''}`;
    tile.dataset.identity = p.identity;
    const avatar = document.createElement('div'); avatar.className = 'media-avatar'; avatar.textContent = initials(p.name || state?.players?.find((x) => x.id === p.identity)?.name || 'X');
    tile.appendChild(avatar);

    const videoPub = getPublication(p, LK.Track?.Source?.Camera || 'camera');
    const videoTrack = videoPub?.track;
    if (videoTrack && !videoPub.isMuted) {
      const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = local;
      try { videoTrack.attach(video); video._livekitTrack = videoTrack; tile.classList.add('has-video'); } catch {}
      tile.appendChild(video);
    }

    if (!local) {
      const audioPub = getPublication(p, LK.Track?.Source?.Microphone || 'microphone');
      if (audioPub?.track && !audioPub.isMuted) {
        try {
          const audio = audioPub.track.attach();
          audio._livekitTrack = audioPub.track;
          audio.autoplay = true; audio.playsInline = true;
          audioSink.appendChild(audio);
        } catch {}
      }
    }

    const overlay = document.createElement('div'); overlay.className = 'media-overlay';
    const name = document.createElement('span'); name.className = 'media-name'; name.textContent = `${p.name || 'Player'}${local ? ' · You' : ''}`;
    const icons = document.createElement('span'); icons.className = 'media-icons';
    const micPub = getPublication(p, LK.Track?.Source?.Microphone || 'microphone');
    const micIcon = document.createElement('span'); micIcon.className = 'media-icon'; micIcon.textContent = micPub && !micPub.isMuted ? '🎙' : '🔇'; icons.appendChild(micIcon);
    const [qClass, qDot] = qualityClass(p.connectionQuality);
    if (qDot) { const q = document.createElement('span'); q.className = `media-icon quality ${qClass}`; q.textContent = qDot; icons.appendChild(q); }
    overlay.append(name, icons); tile.appendChild(overlay); mediaGrid.appendChild(tile);
  });
  updateCallButtons();
}

function updateCallButtons() {
  if (!liveRoom || !callJoined) return;
  const micPub = getPublication(liveRoom.localParticipant, LK.Track?.Source?.Microphone || 'microphone');
  const camPub = getPublication(liveRoom.localParticipant, LK.Track?.Source?.Camera || 'camera');
  const micOn = Boolean(micPub && !micPub.isMuted);
  const camOn = Boolean(camPub && !camPub.isMuted);
  micBtn.classList.toggle('off', !micOn); micBtn.innerHTML = `${micOn ? '🎙' : '🔇'} <span>${micOn ? 'Mute' : 'Unmute'}</span>`;
  camBtn.classList.toggle('off', !camOn); camBtn.disabled = !state?.room?.video_enabled;
  camBtn.innerHTML = `${camOn ? '📹' : '🚫'} <span>${camOn ? 'Camera' : state?.room?.video_enabled ? 'Camera' : 'Voice only'}</span>`;
}

async function leaveCall({ silent = false } = {}) {
  if (liveRoom) {
    try { await liveRoom.localParticipant?.setCameraEnabled?.(false); } catch {}
    try { await liveRoom.localParticipant?.setMicrophoneEnabled?.(false); } catch {}
    try { liveRoom.disconnect(); } catch {}
  }
  liveRoom = null; callJoined = false; callConnecting = false; chatLog = [];
  detachRenderedMedia(); chatPanel.hidden = true; reactionTray.hidden = true;
  setCallStatus('CALL OFF');
  if (state?.room?.play_mode === 'remote') renderCallJoin();
  if (!silent) toast('Left the call. You are still in the game.');
}

function handleCallData(payload, participant, topic) {
  try {
    const text = new TextDecoder().decode(payload);
    const data = JSON.parse(text);
    if (topic === 'chat' || data.type === 'chat') {
      appendChat({ name: participant?.name || 'Player', text: String(data.text || '').slice(0, 180) });
    } else if (topic === 'reaction' || data.type === 'reaction') {
      showReaction(String(data.emoji || '✨'));
    }
  } catch {}
}

function appendChat(msg) {
  chatLog.push(msg); if (chatLog.length > 80) chatLog.shift();
  chatMessages.innerHTML = chatLog.map((m) => `<div class="chat-msg"><strong>${esc(m.name)}:</strong> ${esc(m.text)}</div>`).join('');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function publishData(data, options) {
  if (!liveRoom || !callJoined) return;
  try { await liveRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(data)), options); } catch (error) { toast('Could not send that right now.'); }
}

function showReaction(emoji) {
  const el = document.createElement('div'); el.className = 'float-reaction'; el.textContent = emoji;
  el.style.left = `${12 + Math.random() * 76}%`; reactionLayer.appendChild(el); setTimeout(() => el.remove(), 1900);
}

micBtn.addEventListener('click', async () => {
  if (!liveRoom || !callJoined) return;
  const pub = getPublication(liveRoom.localParticipant, LK.Track?.Source?.Microphone || 'microphone');
  try { await liveRoom.localParticipant.setMicrophoneEnabled(!(pub && !pub.isMuted)); } catch { toast('Microphone permission is blocked in the browser.'); }
  renderMediaGrid();
});
camBtn.addEventListener('click', async () => {
  if (!liveRoom || !callJoined || !state?.room?.video_enabled) return;
  const pub = getPublication(liveRoom.localParticipant, LK.Track?.Source?.Camera || 'camera');
  try { await liveRoom.localParticipant.setCameraEnabled(!(pub && !pub.isMuted)); } catch { toast('Camera permission is blocked in the browser.'); }
  renderMediaGrid();
});
leaveCallBtn.addEventListener('click', () => leaveCall());
chatBtn.addEventListener('click', () => { chatPanel.hidden = !chatPanel.hidden; reactionTray.hidden = true; if (!chatPanel.hidden) chatInput.focus(); });
reactBtn.addEventListener('click', () => { reactionTray.hidden = !reactionTray.hidden; chatPanel.hidden = true; });
reactionTray.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
  showReaction(btn.textContent); await publishData({ type: 'reaction', emoji: btn.textContent }, { reliable: false, topic: 'reaction' });
}));
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault(); const text = chatInput.value.trim(); if (!text) return;
  appendChat({ name: state?.me?.name || 'You', text }); chatInput.value = '';
  await publishData({ type: 'chat', text }, { reliable: true, topic: 'chat' });
});
collapseCall.addEventListener('click', () => { callCollapsed = !callCollapsed; syncCallDock(); });

window.addEventListener('beforeunload', () => { try { liveRoom?.disconnect?.(); } catch {} });
window.addEventListener('online', () => { if (session) refreshState(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) refreshState(true); });

async function boot() {
  if (session) await refreshState(true);
  else renderHome();
}
boot();
