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

Each dungeon code is a **private** Realtime channel `dungeon:<CODE>`. Only signed-in users can join: access is enforced by RLS policies on `realtime.messages`.

To set this up on your Supabase project:

1. Run `supabase/migrations/20261001000000_private_dungeon_channels.sql` (`supabase db push`, or paste it into the SQL editor).
2. In **Project Settings → Realtime**, turn off **Allow public access**.

- The earliest player in the room is the **host** (★ in the party list). The host generates the floor seed, simulates every enemy, and broadcasts enemy snapshots at 10 Hz.
- Every player broadcasts their own position at up to 10 Hz (1 Hz when idle). Sword hits are sent to the host, which applies damage and knockback.
- If the host leaves, the next earliest player takes over the enemies they last saw.
- Dungeons are generated from a seed, so only the seed is sent over the network.

Realtime has per-project message quotas. A full room of 10 active players sends a lot of messages, so check your plan's Realtime limits before a big session. The send rates are constants at the top of `src/game/game.ts`.

## Project layout

```
src/
  main.ts          screen flow: sign in → lobby → dungeon
  auth.ts          Supabase sign up / sign in form
  supabase.ts      Supabase client
  game/
    game.ts        game loop, combat, enemy AI (host), networking glue
    net.ts         Realtime room: presence, host election, 10-player cap
    dungeon.ts     seeded dungeon generation, collision, meshes
    models.ts      character models and animation
    rng.ts         seeded PRNG
```
