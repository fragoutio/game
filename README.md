# fragout.io

**Play now (bots, works on school networks):** https://outlandishdal.github.io/fragout-io/

Low-poly first-person arcade arena shooter, keyboard-only (or gamepad): 1v1 or 2v2 in a small neon room with cover.
Characters are built like the Shred Summit riders (puffy jacket, baggy pants, goggles and headgear)
with far fewer polygons so it runs on school computers.

## Run

```
npm install
npm start
```

Open http://localhost:8123. Friends on your network can join at `http://<your-ip>:8123`.
three.js is served from `node_modules`, so the online build needs no CDN access.

Env vars: `PORT` (default 8123), `BOT_FILL_MS` (default 30000).

## Offline builds (bots only)

Both run the game core inside the page (no server): you play the practice range while "searching", and
bots fill the lobby after 30 seconds.

- `npm run build:pages` → `site/` (index.html + its own copy of three.js, no CDN). Deployed to GitHub Pages
  automatically by `.github/workflows/pages.yml` on every push to `main`:
  https://outlandishdal.github.io/fragout-io/
- `npm run build:test` → `dist/fragout-test.html`, a single file for the claude.ai test artifact
  (loads three.js from jsDelivr): https://claude.ai/artifact/8fYtnRiNUw1pyG9wHHECnw

Real player-vs-player needs `server.js` running somewhere people can reach (see Run).

## Matchmaking, practice range and bots

- Pressing PLAY drops you straight into a **practice range**: a private match on your own computer
  (`createPractice` in `core.js`) against training dummies that walk, duck and respawn but never fight back.
  It's the same engine as real matches, so movement, shooting, headshots and grenades all behave identically. A banner shows the search timer and targets hit.
  Esc stops searching.
- When enough real players are queued, the match starts. If the lobby isn't full after 30 seconds,
  **bots fill the empty slots**.
- Bots are **not identified to players**: they get ordinary gamer tags, and the server never sends a
  "bot" flag (queue updates only carry wait time and players searching). If a player leaves mid-match,
  a bot quietly keeps playing under their name. Only the server log marks bots `(bot)`.
- Bots aim with the same view and recoil rules as players, with a short reaction time when a target
  first comes into view.

## Menus

Title → PLAY (1V1 DUEL / 2V2 SQUADS) · LOCKER (name, jacket, pants, headgear, gear colour, skin) · CONTROLS · SETTINGS
(graphics LOW/MEDIUM/HIGH, sound, FPS counter). Arrows/WASD select, Left/Right change, Enter confirm, Esc back.
Everything also works with a mouse or a gamepad (D-pad + A/B).

## Controls (first person)

| Key | Action |
|---|---|
| W / S | Walk forward / back |
| A / D | Strafe left / right |
| ← / → | Turn (tap for fine aim, hold to turn faster) |
| ↑ / ↓ | Look up / down |
| W, W | Double-tap W and keep holding to run (like Minecraft); let go of W to stop. You can't shoot while running |
| Shift or C | While running: slide (fast, low, slows into a crouch). Otherwise: crouch (hold) |
| Q / E (while crouched) | Aim down the sight (1.3x zoom, round holo sight): 25% less recoil, finer turning. Only while crouched: stand up and you zoom back out |
| Q / E while aiming | Lean left / right (tap again to straighten up): your eye and gun shift 11 px to the side, stopping short of walls |
| Space | Lower the sight (standing up also lowers it) |
| R (hold) | Boomerang grenade |
| G (hold) | Frag grenade |
| F (hold) | Thermite grenade |
| Esc | Pause menu in a match (resume / forfeit; the match keeps running), stop searching on the practice range |

Gamepad: left stick move, right stick look, L3/LB run, B/R3/RB crouch-slide, Y boomerang, X frag, triggers thermite, Start pause.

Ctrl is not used: browsers close the tab on Ctrl+W and pages can't block it. The page still asks
"Leave site?" during a match or the practice range in case the tab is closed by accident.

## Shooting

There is no fire button. The gun fires automatically once the centre crosshair has stayed on a visible enemy
for 0.05 s (`fireDelay`): the crosshair turns yellow while it waits, then red and the AUTO-FIRE lamp lights.
Holding an angle no longer instantly knocks out whoever walks through it.

A shot is allowed when the straight path from your eye to the point where it meets their body is clear of
walls (`segmentClear`, exact per wall), so you can hit the visible part of a player half behind a corner, and
standing next to a wall never blocks you. Your own computer's position is trusted when it's within
`claimMax` (30 px) of the server's and not inside a wall, so peeking a corner counts the moment you see around it. Shots are instant. Every shot kicks your view
**up**, a bit more with each shot in a burst, with a fixed left/right sway. Hold **↓** while firing to stay
on target; let go and the crosshair climbs off them and the gun stops. The burst resets after ~0.3 s.

Tuning lives in the `P` object near the top of `public/core.js` (`recoilPitch`, `recoilGrow`, `recoilYaw`,
`turnMax`, `botTurn`, …).

## Performance (school computers)

- Flat-shaded low-poly meshes, shared geometry, no real-time shadows (blob shadows instead)
- Tracers and particles are instanced (one draw call each); the first-person gun is a tiny second pass
- Render resolution scales with the GRAPHICS setting; if a match runs under 35 FPS for 3 seconds the game
  drops one quality level by itself

## Grenades

**Hold** R / G / F to aim: a dashed line shows the exact path (the preview runs the same grenade code as the
game, `predictThrow` in `core.js`), with the frag's blast radius, the boomerang's turn-around blast or the
thermite fire wall drawn where it will land. Aim with the arrow keys, **release** to throw.

| Key | Grenade | Behaviour | Cooldown |
|---|---|---|---|
| R | Boomerang | Curves out and flies back to you at chest height (slide under it). Explodes when it touches an enemy (60 dmg, small blast) | 10 s, reset instantly if it hits an enemy |
| G | Frag | Arcs with your aim, bounces off walls and the floor. Explodes after 3 s, or at once on touching an enemy (up to 80 dmg, never a knockout from full health on its own; falls off with distance, blocked by walls) | 12 s |
| F | Thermite | Ignites on the first thing it touches and leaves a wall of fire across your throw direction for 5 s; enemies in it take 6 damage every 1/6 s | 15 s |

No friendly fire and no self-damage. Bots use grenades too, usually as an opener. Grenade tuning is the `GREN`
table in `public/core.js`. The kill feed marks the cause: ▸ gun, ◎ headshot, ↺ boomerang, ✹ frag, ♨ fire.

## Map

A cramped layout: each team spawns in a walled room with two doorways; short walls in front of every doorway
mean neither spawn room can see into the other (checked: zero sightlines), so nobody can shoot from spawn.
The middle is split into smaller rooms by tall walls, with crates for cover. Walls with a 5th value `1` in
`MAP.walls` are full-height room walls. Spawns face their room's doorway.

## Movement and headshots

- Stances change your size: standing (eye 33 px, body 42 px), crouched (21 / 29), sliding (14 / 22),
  so crouching and sliding make you harder to hit. Movement uses `stepMovement` in `core.js`, which runs
  on the server and, for your own player, on your computer too (so movement feels instant).
- The head is the top 7 px of a body and narrower than the shoulders (6 px radius vs 12). A headshot does
  60 damage (3 of 5 health; body hits do 20, 1 of 5), so 2 headshots or a headshot + 2 body hits knock a player out. Your eye sits at chin level, so looking straight ahead hits
  the body; you have to aim up slightly (more when close) for the head.
  Practice-range dummies duck now and then, for headshot practice.

## Timing

The simulation runs at a true 60 ticks per second on any OS (`runClock` catches up on coarse timers;
Windows Node timers only fire every ~31 ms, which previously slowed the whole game down).

## Rules

5 body hits, 2 headshots, or 1 headshot + 2 body hits knock a player out. Last team standing wins the round; first team to 3 rounds wins.
Knocked-out players watch the rest of the round from an overhead camera.

## Layout

- `public/core.js` – shared game core: arena, matchmaking with bot fill, bot AI, 60 Hz simulation (runs in Node and the browser)
- `public/characters.js` – low-poly character builder + walk/aim/recoil/knockout animation
- `public/game3d.js` – first-person view and gun, practice range, arena, effects, menus, HUD, minimap, sound, input, networking
- `public/index.html`, `public/style.css` – menu screens and HUD
- `server.js` – online build: static files + WebSocket transport around the core
- `build.js` – builds the offline versions (`pages` for GitHub Pages, `test` for the claude.ai artifact)
- `.github/workflows/pages.yml` – builds and deploys the GitHub Pages site on push to `main`
