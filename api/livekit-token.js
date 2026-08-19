import { AccessToken } from 'livekit-server-sdk';

const SUPABASE_URL = 'https://eafzaolucefpyxvjfjwr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_VHs21VCKNj2zfK2L04cqDA_HgDNRUx6';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required.' });

  try {
    const { roomCode, playerToken } = req.body || {};
    if (!roomCode || !playerToken) return res.status(400).json({ error: 'Missing room session.' });

    const stateRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_game_state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ p_code: String(roomCode).toUpperCase(), p_player_token: playerToken }),
    });

    if (!stateRes.ok) return res.status(401).json({ error: 'Game session is no longer valid.' });
    const state = await stateRes.json();
    if (!state?.room || !state?.me) return res.status(401).json({ error: 'Invalid player session.' });
    if (state.room.play_mode !== 'remote') return res.status(400).json({ error: 'Calls are disabled for same-room games.' });

    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const serverUrl = process.env.LIVEKIT_URL;
    if (!apiSecret || !apiKey || !serverUrl) {
      return res.status(503).json({ error: 'Voice/video is not configured yet.' });
    }

    const roomName = `imposter-x-${state.room.id}`;
    const token = new AccessToken(apiKey, apiSecret, {
      identity: state.me.id,
      name: state.me.name,
      ttl: '2h',
      metadata: JSON.stringify({ roomCode: state.room.code, playerId: state.me.id }),
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return res.status(201).json({
      server_url: serverUrl,
      participant_token: await token.toJwt(),
    });
  } catch (error) {
    console.error('livekit-token', error);
    return res.status(500).json({ error: 'Could not create call session.' });
  }
}
