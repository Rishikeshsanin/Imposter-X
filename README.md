# 🎭 Imposter X

**Imposter X** is a realtime social-deduction party game with built-in low-latency voice and optional video. Play together in the same physical room, or create a remote room and keep the entire game — call, secret roles, voting, reactions, chat and scoring — in one place.

> Target production URL: `https://imposter-x.vercel.app`

## ✨ What makes X different

- **Remote Room** with integrated LiveKit voice/video
- **Same Room** mode with calls disabled to avoid speaker echo
- 3–12 players per room
- 20 active demo rooms
- 7 curated themes × 100 cards = **700 cards**
- Ready checks for remote rooms
- Host settings, kick controls and invite links
- Private role reveal
- Secret word is never returned to the Imposter client
- Vote at any point during discussion and change your vote until the round closes
- Automatic result reveal when everyone votes or the timer expires
- Persistent multi-round scoring and fairer Imposter rotation
- In-call text chat and emoji reactions
- Active-speaker highlighting and connection-quality UI
- Adaptive-stream + dynacast LiveKit client setup for efficient media delivery
- Responsive dark UI designed for phones first

## 🏗 Architecture

### Frontend

Vanilla HTML/CSS/JavaScript keeps the game client small and fast. Supabase JS handles game-state RPCs and Realtime room events. LiveKit Client handles WebRTC media.

### Game backend — Supabase

The database lives in Mumbai (`ap-south-1`) and uses server-authoritative PostgreSQL RPC functions for room creation/joining, host controls, ready state, role/word assignment, voting, timers, round finalization, scoring and card-cycle history.

Raw game tables are protected with RLS. The browser only receives data through purpose-built RPCs.

### Media — LiveKit Cloud

Remote rooms request a short-lived participant token from `/api/livekit-token`. The token endpoint validates the player's active Imposter X game session against Supabase before signing a LiveKit token.

The LiveKit API secret is **never** exposed to the browser or committed to GitHub.

### Hosting — Vercel

The static client and server-side token endpoint deploy together on Vercel.

## 🔐 Required environment variables

Create these in your Vercel project:

```env
LIVEKIT_URL=wss://imposter-x-pu5xkyfx.livekit.cloud
LIVEKIT_API_KEY=APIrNkvWTJQBSej
LIVEKIT_API_SECRET=YOUR_PRIVATE_LIVEKIT_SECRET
```

`LIVEKIT_API_SECRET` must remain server-side.

## 🃏 Themes

- Popular People
- Mixed
- Movies
- Tollywood Movies
- Tollywood Actors
- Animals
- Movies & TV Shows

Each theme currently contains exactly 100 cards.

## 🎮 How to play

1. Create a **Remote Room** or **Same Room**.
2. Share the six-character code or invite URL.
3. In remote mode, join the built-in call and mark yourself ready.
4. The host chooses a theme and discussion timer, then starts the round.
5. Privately reveal your role.
6. Discuss, bluff and vote whenever you want.
7. When everyone votes or time expires, the Imposter and secret word are revealed.
8. Scores update and the host starts the next round.

## 🚀 Local development

```bash
git clone https://github.com/Rishikeshsanin/Imposter-X.git
cd Imposter-X
npm install
```

For the static client:

```bash
python -m http.server 5500
```

Game state works against the hosted Supabase project. The LiveKit token endpoint requires server-side environment variables, so voice/video is best tested through `vercel dev` or a Vercel deployment.

## 🗄 Database migrations

Ordered SQL migrations are in:

```text
supabase/migrations/
```

Apply them in numerical order to recreate the game database and card library.

## 🧭 Planned upgrades

- Double Imposter mode
- private Imposter meeting
- spectator mode
- custom decks
- player profiles and achievements
- richer connection diagnostics
- Ghost Lounge for elimination modes
- installable PWA polish

---

Built for suspicion, chaos and game nights. **Trust nobody.**
