# League of Ten

A 3D co-op hack-and-slash dungeon crawler for up to 10 players, playable in the browser.

**Play now: https://chenjsfrost.github.io/league-of-ten/**

- **3D** with [Three.js](https://threejs.org): procedurally generated dungeon floors, low-poly heroes, skeletons and brutes.
- **Accounts** with Supabase Auth (email + password, hero name stored in user metadata).
- **Multiplayer** with Supabase Realtime: presence tracks who is in a room (capped at 10), and broadcast syncs player and enemy state. No game server to run.

## Run it

```bash
npm install
cp .env.example .env   # Supabase URL + publishable key
npm run dev
```

Open http://localhost:5173, create an account, enter a dungeon code and share it with friends.

The database needs the migrations in `supabase/migrations/`. Run them with `supabase db push`, or paste them into the Supabase SQL editor.

## Controls

| Action | Input |
| --- | --- |
| Move | WASD / arrow keys |
| Aim | Mouse |
| Slash | Left click (hold to keep swinging) |
| Dash (brief invulnerability) | Space or right click |
| Leave dungeon | Esc |

Clear every enemy on a floor to descend. Each floor is bigger trouble: more enemies, more brutes, more HP. Fallen heroes respawn after 5 seconds.

## How multiplayer works

Each dungeon code is a Realtime channel `dungeon:<CODE>`.

- Joining takes a **seat** from the database (`join_room`). The server assigns the seat id and join time, gives each account one seat per room, and caps the room at 10. Seats stay live through a heartbeat every 5 seconds. A player counts as in the room if they have a live seat and are in the channel's presence.
- Every message is signed with a key that is generated for the session and registered on its seat. Receivers drop messages that don't verify, replays, messages more than 10 seconds old, and floods. So the only way to act as a player, or as the host, is to hold their seat.
- The earliest seated player in the room is the **host** (★ in the party list). The host generates the floor seed, simulates every enemy, and broadcasts enemy snapshots at 10 Hz.
- Every player broadcasts their own position at up to 10 Hz (1 Hz when idle). Sword hits are sent to the host, which applies damage and knockback.
- If the host leaves, the next earliest player takes over the enemies they last saw.
- Dungeons are generated from a seed, so only the seed is sent over the network.
- The host is still trusted with game state, so a host who modifies their client can cheat. Other players can't pretend to be the host, and the host checks every hit it receives against the damage and attack-rate limits.
- Joining from a second tab moves that account's seat to the new tab. To test with two tabs, use two accounts.

Realtime has per-project message quotas. A full room of 10 active players sends a lot of messages, so check your plan's Realtime limits before a big session. The send rates are constants at the top of `src/game/game.ts`.

## Project layout

```
src/
  main.ts          screen flow: sign in → lobby → dungeon
  auth.ts          Supabase sign up / sign in form
  supabase.ts      Supabase client
  game/
    game.ts        game loop, combat, enemy AI (host), networking glue
    net.ts         Realtime room: seats, signed messages, host election
    dungeon.ts     seeded dungeon generation, collision, meshes
    models.ts      character models and animation
    rng.ts         seeded PRNG
    ticker.ts      timer that keeps running in background tabs
supabase/
  migrations/      room_seats table and join/heartbeat/leave functions
```
