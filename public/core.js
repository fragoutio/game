// fragout.io game core: arena, matchmaking (with bot fill), bots and the authoritative simulation.
// Shared by the online server (server.js) and the offline test build (runs it inside the browser).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FragoutCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
const TICK = 1000 / 60;
const SEND_EVERY = 2; // broadcast state every 2 ticks (30 Hz)
let BOT_FILL_MS = 30_000; // wait this long before adding bots
let log = () => {};

// ---------- Arena ----------
const MAP = (() => {
  // Two 2-storey buildings, blue (west) and red (east), face each other across an open courtyard with the gem in
  // the middle. Ground floor: a home base strip at the back, then north / centre / south rooms with doorways
  // (some covered by green panels) and a door out to the courtyard from each. Upstairs (UP.floor px up) is one big
  // floor with big gaps in it: look and shoot down through them, drop through, or rappel down (X). Staircases sit
  // in the corners of the rooms, ladders in the gaps and up the courtyard walls to the upstairs windows.
  // Walls are [x, y, w, h, type, level]: type 1 = room wall, 2 = vent (a low grated gap at the bottom: grenades
  // low enough pass under), 3 = green wood panel (breakable), 0 = crate. level 1 = upstairs (stands on the upper floor).
  // The west building is written out; the east one is its mirror image.
  const W = 1920, H = 1120;
  const west = {
    walls: [
      // ground floor: wall between the home base and the rooms (doors at y 260-340, 520-600, 780-860)
      [256, 32, 32, 228, 1], [256, 340, 32, 180, 1], [256, 600, 32, 180, 1], [256, 860, 32, 228, 1],
      // courtyard wall (doors at y 160-240, 520-600, 880-960; the south one is a green panel)
      [768, 32, 32, 128, 1], [768, 240, 32, 280, 1], [768, 600, 32, 280, 1], [768, 960, 32, 128, 1], [776, 880, 16, 80, 3],
      // north room | centre hall wall: doors at x 400-480 and 600-660 (green panel), with a vent
      [288, 400, 112, 32, 1], [480, 400, 40, 32, 1], [520, 400, 32, 32, 2], [552, 400, 48, 32, 1], [600, 408, 60, 16, 3], [660, 400, 108, 32, 1],
      // centre hall | south room wall: doors at x 400-480 (green panel) and 600-660
      [288, 688, 112, 32, 1], [400, 696, 80, 16, 3], [480, 688, 120, 32, 1], [660, 688, 108, 32, 1],
      // ground-floor crates
      [120, 300, 48, 48, 0], [120, 780, 48, 48, 0], [480, 180, 56, 40, 0], [560, 880, 56, 40, 0], [520, 540, 40, 40, 0],
      // upstairs: courtyard wall with three big windows (y 160-320, 480-640, 800-960)
      [768, 32, 32, 128, 1, 1], [768, 320, 32, 160, 1, 1], [768, 640, 32, 160, 1, 1], [768, 960, 32, 128, 1, 1],
      // upstairs: wall over the home base (doors at y 212-292 and 828-908)
      [256, 32, 32, 180, 1, 1], [256, 292, 32, 536, 1, 1], [256, 908, 32, 180, 1, 1],
      // upstairs cover
      [480, 320, 48, 32, 0, 1], [600, 760, 48, 32, 0, 1], [140, 250, 40, 40, 0, 1], [140, 830, 40, 40, 0, 1], [700, 520, 32, 48, 0, 1],
    ],
    floor: [32, 32, 768, 1056],
    // gaps in the upper floor
    holes: [[400, 480, 256, 160], [420, 140, 160, 120], [460, 840, 160, 120], [112, 480, 96, 160]],
    // ramps [x, y, w, h, dir] rising toward dir to the upper floor (each has a stairwell gap above it)
    stairs: [[296, 40, 56, 160, 'N'], [632, 40, 56, 160, 'N'], [296, 920, 56, 160, 'S'], [632, 920, 56, 160, 'S']],
    // ladders [x, y, w, h, dir]: stand in it and walk toward dir to climb, away from it to climb down
    ladders: [[500, 480, 40, 18, 'N'], [480, 242, 40, 18, 'S'], [520, 840, 40, 18, 'N'], [140, 480, 40, 18, 'N'],
      [800, 240, 18, 40, 'W'], [800, 840, 18, 40, 'W']],
  };
  const flip = r => [W - r[0] - r[2], r[1], r[2], r[3], ...r.slice(4)];
  const flipDir = r => { const f = flip(r); f[4] = { W: 'E', E: 'W' }[f[4]] || f[4]; return f; };
  const courtyard = [   // open courtyard between the buildings (crates for cover; the gem in the middle)
    [880, 180, 48, 48, 0], [992, 180, 48, 48, 0], [930, 380, 60, 28, 0], [930, 712, 60, 28, 0],
    [860, 540, 32, 40, 0], [1028, 540, 32, 40, 0], [880, 890, 48, 48, 0], [992, 890, 48, 48, 0],
  ];
  const spawnsA = [[80, 120, 0.6], [80, 1000, -0.6], [200, 290, 0.3], [200, 830, -0.3]];
  const flipSpot = ([x, y, a]) => [W - x, y, Math.round((Math.PI - a) * 100) / 100];
  return {
    w: W, h: H,
    walls: [[0, 0, W, 32], [0, H - 32, W, 32], [0, 0, 32, H], [W - 32, 0, 32, H],
      ...west.walls, ...west.walls.map(flip), ...courtyard],
    // [x, y, yaw] spawns in each home base (team modes, and the attackers in Extraction)
    spawns: { A: spawnsA, B: spawnsA.map(flipSpot) },
    // Extraction: the gem sits here; defenders spawn around it; attackers deliver it to their own base
    gem: [960, 560],
    defend: [[900, 470, 0], [1020, 470, 3.14], [900, 650, 0], [1020, 650, 3.14]],
    bases: { A: [32, 32, 224, H - 64], B: [W - 256, 32, 224, H - 64] },
    upper: {
      floor: 80, rail: 22, rails: [],
      floors: [west.floor, flip(west.floor)],
      holes: [...west.holes, ...west.holes.map(flip)],
      stairs: [...west.stairs, ...west.stairs.map(flipDir)],
      ladders: [...west.ladders, ...west.ladders.map(flipDir)],
    },
    // Extraction: knocked-out defenders come back after 10 s in a far back corner of their own base
    respawn: { A: [[60, 64, 0.6], [60, H - 64, -0.6]], B: [[W - 60, H - 64, -2.5], [W - 60, 64, 2.5]] },
    // Extraction: reboot point in the middle of the back wall of each home base [x, y, yaw]
    reboot: { A: [72, H / 2, 0], B: [W - 72, H / 2, Math.PI] },
  };
})();
const UP = MAP.upper;
const inRect = (r, x, y) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
const inOpen = (r, x, y) => x > r[0] && x < r[0] + r[2] && y > r[1] && y < r[1] + r[3];
// is there upper floor at (x, y)? (inside a building, not over a gap or a stairwell)
const onSlab = (x, y) => UP.floors.some(f => inRect(f, x, y)) && !UP.holes.some(h => inOpen(h, x, y)) && !UP.stairs.some(s => inOpen(s, x, y));
// the upper floor as rectangles (for drawing it)
function slabRects() {
  const xs = new Set(), ys = new Set();
  for (const r of [...UP.floors, ...UP.holes, ...UP.stairs]) { xs.add(r[0]); xs.add(r[0] + r[2]); ys.add(r[1]); ys.add(r[1] + r[3]); }
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b), out = [];
  for (let j = 0; j < Y.length - 1; j++) {
    let run = null;
    for (let i = 0; i < X.length - 1; i++) {
      const on = onSlab((X[i] + X[i + 1]) / 2, (Y[j] + Y[j + 1]) / 2);
      if (on && run) run[2] = X[i + 1] - run[0];
      else if (on) run = [X[i], Y[j], X[i + 1] - X[i], Y[j + 1] - Y[j]];
      if ((!on || i === X.length - 2) && run) { out.push(run); run = null; }
    }
  }
  // merge rows with the same x span
  const merged = [];
  for (const r of out) { const m = merged.find(o => o[0] === r[0] && o[2] === r[2] && o[1] + o[3] === r[1]); if (m) m[3] += r[3]; else merged.push(r.slice()); }
  return merged;
}
const DIRS = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
// the ladder at (x, y) as its climbing direction, or null
function ladderAt(x, y) {
  for (const l of UP.ladders) if (inRect(l, x, y)) return DIRS[l[4]];
  return null;
}
// how tall each wall is: the outer border blocks everything, crates are 62 px, room walls/vents/panels 77 px;
// upstairs walls start at the upper floor
const wallBot = i => (MAP.walls[i][5] ? UP.floor : 0);
const wallTop = i => (i < 4 ? 9999 : wallBot(i) + (MAP.walls[i][4] ? 77 : 62));
// height of a stair ramp under (x, y), or -1 if not on stairs
function rampAt(x, y) {
  for (const [sx, sy, sw, sh, dir] of UP.stairs) {
    if (!inRect([sx, sy, sw, sh], x, y)) continue;
    const k = dir === 'S' ? (y - sy) / sh : dir === 'N' ? (sy + sh - y) / sh : dir === 'E' ? (x - sx) / sw : (sx + sw - x) / sw;
    return Math.max(0, Math.min(1, k / 0.8)) * UP.floor;   // full height for the last fifth, so you step straight onto the balcony
  }
  return -1;
}
// Staircases are solid blocks under their steps: a body at height z can't overlap a part of the stairs more than a
// step (14 px) above its feet (so you can't walk into the side of a staircase or under its high end)
function stairBlocks(x, y, z) {
  for (let a = -1; a < 8; a++) {
    const sx = a < 0 ? x : x + Math.cos(a * Math.PI / 4) * (P.r - 2), sy = a < 0 ? y : y + Math.sin(a * Math.PI / 4) * (P.r - 2);
    if (rampAt(sx, sy) > z + 14) return true;
  }
  return false;
}
// what you'd stand on at (x, y) coming from height z: the ground, a stair, or a balcony (only if you're up there)
function supportAt(x, y, z) {
  let h = 0;
  const r = rampAt(x, y);
  if (r >= 0 && r <= z + 14) h = Math.max(h, r);
  if (z >= UP.floor - 14 && onSlab(x, y)) h = Math.max(h, UP.floor);
  return h;
}

const P = {
  // sizes in arena pixels (24 px = 1 world unit). Players are cylinders r wide and height tall.
  r: 12, height: 42, eye: 38, hp: 100, cooldown: 7, bulletR: 3, dmg: 20,
  // Headshots: a hit in the top headH pixels of a body takes 3 of 5 health (body hits take 1 of 5)
  headH: 7, headR: 6, headDmg: 60,
  ventH: 14,   // vents are this tall (px): grenades below this height pass under   // the head is narrower than the body (headR vs r) and only the top headH px
  // Movement speeds (px per tick). Shift runs (forward only, can't shoot while running).
  // Ctrl/C: slide if you were running, otherwise crouch. Slides start fast and slow down to a crouch.
  walk: 2.4, run: 3.8, crouchSpeed: 1.25, slideSpeed: 6, slideTicks: 36, slideCooldown: 45,
  // Aim: arrow keys turn (yaw) and look up/down (pitch), per 60 Hz tick, speeding up while held
  turnMin: 0.008, turnMax: 0.05, turnAccel: 0.0022, pitchScale: 0.6, pitchMax: 0.75, botTurn: 0.035,
  // Recoil: each shot in a burst kicks the view up and sways it left/right in a fixed pattern.
  // Hold Down while firing to stay on target. The burst resets after recoilReset ticks without shooting.
  recoilPitch: 0.018, recoilGrow: 0.003, recoilPitchMax: 0.04, recoilYaw: 0.045, recoilReset: 18,
  lockR: 2, // forgiveness around a body that still counts as "on target"
  // Players: the crosshair must stay on an enemy this many ticks (0.05 s) before the gun starts firing,
  // so someone walking past an angle you're holding doesn't get knocked out instantly. Once firing, it keeps firing.
  fireDelay: 3,
  claimMax: 30,   // how far (px) a player's own position may differ from the server's and still be accepted
  // Aiming down the sight (ADS) only works while crouched (crouching already slows you, so no extra slowdown).
  // Leaning (only while aiming) moves your eye and gun leanPx to the side, so you can shoot around a corner
  // while staying mostly behind it.
  adsSpeed: 1, leanPx: 11,
  climb: 1.6, rapSpeed: 1.3,   // ladder climbing and rappelling speed (px per tick)
  // Green wood panels: hp each; guns fire at a panel under the crosshair within panelRange px; grenades
  // blasts damage them too (x panelBlast)
  panelHp: 160, panelRange: 220, panelBlast: 1.5,
};
// Extraction (4v4): attackers extract the gem (stand within extractR px for extractTicks), carry it back
// to their base. Round timer roundTicks (3 min). A dropped gem is picked up by an attacker (pickR) or sent
// home by a defender touching it.
// Reboot cards: a knocked-out attacker drops one; a teammate picks it up by walking over it (cardR) and brings
// the player back by carrying it to their reboot point (within rebootR). Defenders respawn after defRespawn ticks.
const EXTRACT = { extractR: 44, extractTicks: 180, pickR: 22, roundTicks: 180 * 60, cardR: 24, rebootR: 48, defRespawn: 300 };
// Body size per stance: eye height and how tall the hittable body is (head = top headH px)
// The eye sits at chin level, just under the head, so looking straight ahead lines up a body shot:
// you have to aim up a little (more the closer they are) to land a headshot.
const STANCES = { stand: { eye: 33, height: 42 }, crouch: { eye: 21, height: 29 }, slide: { eye: 14, height: 22 } };
const STANCE_CODE = { stand: 0, crouch: 1, slide: 2 };

// Weapons. Key 1 = rifle (shown as the ALTERNATOR), key 2 = shotgun. Both auto-fire when the crosshair is on an enemy.
// Damage is in hp (5 health = 100 hp, so 20 hp = 1 health).
const WEAPONS = {
  // rifle: 1 health per body hit, 3 per headshot, steady fire, recoil pattern from recoilKick()
  rifle: { code: 0, cooldown: 7, body: 20, head: 60, spread: 2, range: Infinity },
  // shotgun: up close (within `close` px) 4 health to the body, 5 to the head (a one-shot knockout); damage
  // drops steeply to `minFactor` (about 1 health) by `far`, and it won't fire beyond `range`. Only worth it
  // up close. Wide spread (forgiving aim), pumps between shots, one big kick per shot.
  shotgun: { code: 1, cooldown: 27, body: 80, head: 100, spread: 7, close: 60, far: 160, minFactor: 0.25, range: 260,
    kick: 0.075, kickYaw: 0.02 },
};
const WEAPON_BY_CODE = ['rifle', 'shotgun'];
const SWITCH_TICKS = 24;   // 0.4 s to bring the other weapon up (no firing meanwhile)
// damage a weapon does at a distance (px)
function weaponDamage(w, along, head) {
  const g = WEAPONS[w];
  let k = 1;
  if (g.close != null && along > g.close) k = Math.max(g.minFactor, 1 - (along - g.close) / (g.far - g.close) * (1 - g.minFactor));
  return Math.round((head ? g.head : g.body) * k);
}
// recoil for a shot: the rifle's learnable pattern, or the shotgun's single big kick
function weaponKick(w, n) {
  if (w === 'shotgun') return { pitch: WEAPONS.shotgun.kick, yaw: (Math.random() * 2 - 1) * WEAPONS.shotgun.kickYaw };
  return recoilKick(n);
}
const ROUNDS_TO_WIN = 3;
// ---------- Operators ----------
// One per class. tac = tactical (Space) with a cooldown in seconds; ult = ultimate (Caps Lock), charges over
// `charge` seconds (dealing damage charges it faster).
const OPS = {
  riot:   { name: 'RIOT', cls: 'ASSAULT', color: '#ff6a2a',
    tac: { name: 'OVERDRIVE', cd: 24, desc: 'Fire 60% faster for 6 s' },
    ult: { name: 'BARRAGE', charge: 100, desc: 'Three blasts land along your aim after 1 s' } },
  volt:   { name: 'VOLT', cls: 'SKIRMISHER', color: '#ffd23f',
    tac: { name: 'BLINK', cd: 10, desc: 'Dash 5 m the way you are moving' },
    ult: { name: 'RUSH', charge: 90, desc: 'Move 35% faster for 8 s' } },
  echo:   { name: 'ECHO', cls: 'RECON', color: '#3fe0ff',
    tac: { name: 'PULSE', cd: 20, desc: 'Reveal enemies within 19 m for 4 s' },
    ult: { name: 'SWEEP', charge: 110, desc: 'Reveal every enemy for 6 s' } },
  haven:  { name: 'HAVEN', cls: 'SUPPORT', color: '#5dffb4',
    tac: { name: 'PATCH', cd: 22, desc: 'Heal you and nearby teammates 2 health' },
    ult: { name: 'DOME', charge: 120, desc: 'A dome for 10 s that stops bullets going in or out' } },
  warden: { name: 'WARDEN', cls: 'CONTROLLER', color: '#c58bff',
    tac: { name: 'SMOKE', cd: 18, desc: 'A smoke cloud ahead of you for 8 s (blocks sight)' },
    ult: { name: 'LOCKDOWN', charge: 110, desc: 'A 6 m zone for 9 s: enemies inside are slowed and revealed' } },
};
const OP_LIST = Object.keys(OPS);
const cleanOp = o => (OPS[o] ? o : OP_LIST[(Math.random() * OP_LIST.length) | 0]);
// Ability zones in the match being simulated (or shown): domes stop shots and sight crossing their edge, smoke
// blocks sight through it. Set per match like curBroken.
let curZones = null;
function setZones(z) { curZones = z; }
// Grenade tuning (px, ticks at 60 Hz). cd = cooldown after a throw.
const GREN = {
  gravity: 0.35,
  boom: { cd: 600, speed: 9, z: 26, out: 24, curve: 0.04, life: 170, radius: 40, dmg: 60 },
  // frag: 80 max damage, so it never knocks out a full-health player on its own
  frag: { cd: 720, speed: 9.5, lift: 0.22, fuse: 180, radius: 60, dmg: 80, bounce: 0.6, ground: 0.5, friction: 0.82 },
  therm: { cd: 900, speed: 8.5, lift: 0.2, bounce: 0, ground: 0, friction: 1, burn: 300, half: 60, width: 10, every: 10, dmg: 6 },
};
P.gren = GREN;

const rectHitsCircle = ([x, y, w, h], cx, cy, r) => {
  const nx = Math.max(x, Math.min(cx, x + w)), ny = Math.max(y, Math.min(cy, y + h));
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
};
// Panels that have been broken in the match being simulated (or shown) right now. stepMatch sets it for the
// match it's stepping; the client sets it to what it was last told (setBroken).
let curBroken = null;
const wallOn = i => !curBroken || !curBroken.has(i);
function setBroken(set) { curBroken = set; }
// something solid at (x, y) for a body standing at height z: walls you're below the top of, railings when
// you're up on a balcony. blocked() is the ground-level version.
function blockedAt(x, y, r, z) {
  for (let i = 0; i < MAP.walls.length; i++) if (wallOn(i) && z < wallTop(i) && z + 30 > wallBot(i) && rectHitsCircle(MAP.walls[i], x, y, r)) return true;
  if (z >= UP.floor - 4) for (const rl of UP.rails) if (rectHitsCircle(rl, x, y, r)) return true;
  return false;
}
const blocked = (x, y, r) => blockedAt(x, y, r, 0);
// for grenades: vents (type 2) only block what's above vent height
const gBlocked = (x, y, r, z) => {
  for (let i = 0; i < MAP.walls.length; i++) { const w = MAP.walls[i]; if (wallOn(i) && z < wallTop(i) && z >= wallBot(i) && !(w[4] === 2 && z < P.ventH) && rectHitsCircle(w, x, y, r)) return true; }
  if (z >= UP.floor && z < UP.floor + UP.rail) for (const rl of UP.rails) if (rectHitsCircle(rl, x, y, r)) return true;
  return false;
};
// Is the straight 3D segment (x1,y1,z1)->(x2,y2,z2) clear? Walls block below their tops, railings block
// between the balcony floor and the rail top, and balcony floors block anything passing up or down through them.
function clear3(x1, y1, z1, x2, y2, z2) {
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  const span = (rx, ry, rw, rh) => {   // [t0, t1] of the segment inside the rectangle (2D), or null
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-dx, x1 - rx], [dx, rx + rw - x1], [-dy, y1 - ry], [dy, ry + rh - y1]]) {
      if (p === 0) { if (q < 0) return null; }
      else { const r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }
    }
    return t0 <= t1 ? [t0, t1] : null;
  };
  for (let i = 0; i < MAP.walls.length; i++) {
    if (!wallOn(i)) continue;
    const w = MAP.walls[i], sp = span(w[0], w[1], w[2], w[3]);
    if (sp && Math.min(z1 + dz * sp[0], z1 + dz * sp[1]) < wallTop(i) && Math.max(z1 + dz * sp[0], z1 + dz * sp[1]) > wallBot(i)) return false;
  }
  for (const rl of UP.rails) {
    const sp = span(rl[0], rl[1], rl[2], rl[3]);
    if (!sp) continue;
    const za = z1 + dz * sp[0], zb = z1 + dz * sp[1];
    if (Math.min(za, zb) < UP.floor + UP.rail && Math.max(za, zb) > UP.floor) return false;
  }
  for (const st of UP.stairs) {   // under the steps of a staircase is solid
    const sp = span(st[0], st[1], st[2], st[3]);
    if (!sp) continue;
    for (let k = 0; k <= 6; k++) {
      const t = sp[0] + (sp[1] - sp[0]) * k / 6, px = x1 + dx * t, py = y1 + dy * t, pz = z1 + dz * t;
      if (pz < rampAt(px, py) - 1) return false;
    }
  }
  if (curZones) for (const zn of curZones) {
    if (zn.k !== 'dome' && zn.k !== 'smoke') continue;
    const cz = zn.k === 'smoke' ? 30 : 0;
    const in1 = Math.hypot(x1 - zn.x, y1 - zn.y, z1 - cz) < zn.r, in2 = Math.hypot(x2 - zn.x, y2 - zn.y, z2 - cz) < zn.r;
    if (zn.k === 'dome') { if (in1 !== in2) return false; continue; }
    // smoke: blocked if the segment passes through the cloud
    const L2 = dx * dx + dy * dy + dz * dz || 1;
    const t = clamp(((zn.x - x1) * dx + (zn.y - y1) * dy + (cz - z1) * dz) / L2, 0, 1);
    if (Math.hypot(x1 + dx * t - zn.x, y1 + dy * t - zn.y, z1 + dz * t - cz) < zn.r) return false;
  }
  if ((z1 - UP.floor) * (z2 - UP.floor) < 0) {   // passes through the balcony floor level
    const t = (UP.floor - z1) / dz, px = x1 + dx * t, py = y1 + dy * t;
    if (onSlab(px, py)) return false;
  }
  return true;
}

// can a point at height az see a point at height bz? (defaults: two standing players' eyes on the ground)
function lineOfSight(ax, ay, bx, by, az = 33, bz = 33) { return clear3(ax, ay, az, bx, by, bz); }

// Navigation grid for bots (16px cells, cells a player can't stand in are blocked)
const CELL = 16, GW = MAP.w / CELL, GH = MAP.h / CELL;
const navBlocked = Array.from({ length: GW * GH }, (_, i) => {
  const x = (i % GW) * CELL + CELL / 2, y = Math.floor(i / GW) * CELL + CELL / 2;
  return blocked(x, y, P.r + 2) || [...UP.stairs, ...UP.ladders].some(st => inRect([st[0] - 14, st[1] - 14, st[2] + 28, st[3] + 28], x, y));
});
const cellOf = (x, y) => Math.max(0, Math.min(GW - 1, Math.floor(x / CELL))) + Math.max(0, Math.min(GH - 1, Math.floor(y / CELL))) * GW;

function findPath(fx, fy, tx, ty) {
  const start = cellOf(fx, fy), goal = cellOf(tx, ty);
  const prev = new Int32Array(GW * GH).fill(-1);
  prev[start] = start;
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === goal) break;
    const cx = c % GW, cy = (c / GW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const n = nx + ny * GW;
      if (prev[n] !== -1 || (navBlocked[n] && n !== goal)) continue;
      if (dx && dy && (navBlocked[cx + dx + cy * GW] || navBlocked[cx + (cy + dy) * GW])) continue; // no corner cutting
      prev[n] = c; q.push(n);
    }
  }
  if (prev[goal] === -1) return [];
  const path = [];
  for (let c = goal; c !== start; c = prev[c]) path.push([(c % GW) * CELL + CELL / 2, ((c / GW) | 0) * CELL + CELL / 2]);
  return path.reverse();
}

// ---------- Matchmaking ----------
const MODES = { '1v1': 2, '2v2': 4, extraction: 8 };   // extraction = 4v4
const queues = { '1v1': [], '2v2': [], extraction: [] };
// Bots play under ordinary-looking gamer tags. Whether a player is a bot never leaves the server.
const BOT_NAMES = ['VEXX', 'NOVA_7', 'ROOKIE99', 'KITE', 'JOLTZ', 'PIKE', 'ECH0', 'FLINTY', 'MAKO', 'ZEDD', 'TURBO_T', 'SKYE',
  'BLITZ', 'COBRA_K', 'DUSTY', 'GHOSTY', 'LYNX', 'MOJO', 'PIXEL', 'RAZZ', 'SNIPZ', 'TANK_42', 'VIPER', 'WISP'];
let nextId = 1;
const send = (client, msg) => { if (client && client.send) client.send(msg); };

function dequeue(client) {
  for (const m in queues) queues[m] = queues[m].filter(c => c !== client);
  client.queued = null;
}

// picks players for one match from the queue, keeping each party together (a party bigger than the match is split)
function takeGroup(q, size) {
  const out = [];
  for (const c of q) {
    if (out.length >= size) break;
    if (out.includes(c)) continue;
    const grp = c.pt ? q.filter(o => o.pt === c.pt) : [c];
    if (out.length + grp.length <= size) out.push(...grp);
    else if (grp.length > size) out.push(...grp.slice(0, size - out.length));
  }
  return out;
}
function matchmake() {
  const now = Date.now();
  for (const mode in queues) {
    const size = MODES[mode];
    let q = queues[mode];
    while (q.length) {
      const pick = takeGroup(q, size);
      if (pick.length < size && now - q[0].queuedAt < BOT_FILL_MS) break;
      q = queues[mode] = q.filter(c => !pick.includes(c));
      startMatch(mode, pick);
    }
    for (const c of q) send(c, { t: 'queued', mode, waited: now - c.queuedAt, inQueue: q.length });
  }
}

// ---------- Parties ----------
// A party is up to 4 friends with a short code. They wait together in the menu, and when the leader picks a
// mode everyone is queued together and put on the same team (as far as the mode allows).
const parties = new Map();
const PARTY_MAX = 4;
function newPartyCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 5; i++) c += A[(Math.random() * A.length) | 0]; } while (parties.has(c));
  return c;
}
function partySync(pt) {
  const members = pt.members.map(c => ({ name: c.name, look: c.look, leader: c === pt.leader }));
  pt.members.forEach((c, i) => send(c, { t: 'party', code: pt.code, members, you: i, leader: c === pt.leader }));
}
function partyLeave(client) {
  const pt = client.pt;
  if (!pt) return;
  pt.members = pt.members.filter(c => c !== client);
  client.pt = null;
  send(client, { t: 'party', code: null, members: [] });
  if (!pt.members.length) { parties.delete(pt.code); return; }
  if (pt.leader === client) pt.leader = pt.members[0];
  partySync(pt);
}


// ---------- Match ----------
const matches = new Set();

// Character looks are indices into the client's option lists (jacket, pants, headgear, headgear colour, skin)
const LOOK_SIZES = { jacket: 8, pants: 6, head: 5, headColor: 6, skin: 5 };
function cleanLook(look) {
  const out = {};
  for (const k in LOOK_SIZES) {
    const v = look && Number.isInteger(look[k]) ? look[k] : -1;
    out[k] = v >= 0 && v < LOOK_SIZES[k] ? v : (Math.random() * LOOK_SIZES[k]) | 0;
  }
  return out;
}
const publicPlayers = m => m.players.map(o => ({ id: o.id, name: o.name, team: o.team, look: o.look, op: o.op }));

function makePlayer(team, name, client, look, op) {
  return { id: nextId++, team, name, client, bot: !client, look: cleanLook(look), op: cleanOp(op), tac: 0, ult: 0, fx: {}, spdMul: 1, x: 0, y: 0, hp: P.hp, alive: true,
    input: { f: 0, s: 0, yaw: team === 'A' ? 0 : Math.PI, pitch: 0, run: false, crouch: false }, yaw: 0, pitch: 0, cool: 0, kills: 0, burst: 0, sinceShot: 99,
    stance: 'stand', running: false, slideT: 0, slideCd: 0, slideX: 0, slideY: 0, cd: { boom: 0, frag: 0, therm: 0 }, throws: [], respawnT: 0,
    weapon: 'rifle', switchT: 0, z: 0, vz: 0,
    brain: { path: [], repath: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 0,
      skill: 0.75 + Math.random() * 0.5, wobble: [0, 0], wobbleT: 0, seen: 0, react: 14 + Math.random() * 16 } };
}

function startMatch(mode, clients) {
  const size = MODES[mode];
  const used = new Set(clients.map(c => c.name.toUpperCase()));
  const botName = () => { let n, tries = 0; do n = BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0]; while (used.has(n) && ++tries < 50); used.add(n); return n; };
  // Teams: friends with the same party code go on the same team; everyone else is spread so humans
  // face each other first. Bots fill whatever slots are left.
  const per = size / 2, slots = { A: [], B: [] };
  const groups = [];
  for (const c of clients) { const g = c.party && groups.find(x => x.code === c.party); if (g) g.list.push(c); else groups.push({ code: c.party, list: [c] }); }
  groups.sort((a, b) => b.list.length - a.list.length);
  for (const g of groups) for (const c of g.list) {
    let team = slots.A.length <= slots.B.length ? 'A' : 'B';
    const mate = g.list.find(o => o !== c && (slots.A.includes(o) || slots.B.includes(o)));
    if (mate) team = slots.A.includes(mate) ? 'A' : 'B';
    if (slots[team].length >= per) team = team === 'A' ? 'B' : 'A';
    slots[team].push(c);
  }
  const players = [];
  for (const team of ['A', 'B']) for (let i = 0; i < per; i++) {
    const c = slots[team][i];
    players.push(makePlayer(team, c ? c.name : botName(), c || null, c ? c.look : null, c ? c.op : null));
  }
  const match = { mode, players, events: [], projectiles: [], fires: [], nextProj: 1, broken: new Set(), panelHp: new Map(), score: { A: 0, B: 0 }, round: 0, phase: 'countdown', phaseT: 120, tick: 0, over: false };
  matches.add(match);
  for (const p of players) if (p.client) { p.client.queued = null; p.client.match = match; p.client.player = p; }
  resetRound(match);
  for (const p of players) if (p.client) send(p.client, { t: 'match', mode, you: p.id, map: MAP, cfg: P, roundsToWin: ROUNDS_TO_WIN,
    players: publicPlayers(match) });
  log(`[match] ${mode}: ${players.map(p => p.name + (p.bot ? ' (bot)' : '')).join(', ')}`);
}

function resetRound(m) {
  m.round++; m.projectiles = []; m.fires = []; m.phase = 'countdown'; m.phaseT = 180; // 3 s: "3, 2, 1, FIGHT"
  m.broken = new Set(); m.panelHp = new Map(); m.roundReason = null;   // panels are rebuilt every round
  m.zones = []; m.strikes = [];
  for (const p of m.players) { p.fx = {}; p.tac = 0; p.dashT = 0; }
  if (m.mode === 'extraction') {
    // like Siege: teams swap attack and defence every round
    m.attack = m.round % 2 === 1 ? 'A' : 'B';
    m.gem = { state: 'home', x: MAP.gem[0], y: MAP.gem[1], carrier: 0, prog: 0 };
    m.cards = [];
    m.timeLeft = EXTRACT.roundTicks;
  }
  const idx = { A: 0, B: 0 };
  for (const p of m.players) {
    const defending = m.mode === 'extraction' && p.team !== m.attack;
    const spots = defending ? MAP.defend : MAP.spawns[p.team];
    const [x, y, yaw] = spots[idx[p.team]++ % spots.length];   // attackers: home base facing a doorway; defenders: around the gem
    Object.assign(p, { x, y, hp: P.hp, alive: true, cool: 0, yaw, pitch: 0, burst: 0, sinceShot: 99,
      stance: 'stand', running: false, slideT: 0, slideCd: 0, cd: { boom: 0, frag: 0, therm: 0 }, throws: [], switchT: 0, cool: 0, z: 0, vz: 0, respawnT: 0, rap: null, onLadder: false });
    p.input = { f: 0, s: 0, yaw, pitch: 0, run: false, crouch: false };
    p.brain.path = []; p.brain.repath = 0; p.brain.guard = null; Object.assign(p.brain, { via: undefined, retreatT: 0, peekT: 0, pauseT: 0, roam: null, lastSeen: null, seen: 0, aimErr: null });
  }
}

function endMatch(m, winner, reason) {
  if (m.over) return;
  m.over = true; matches.delete(m);
  for (const p of m.players) if (p.client) {
    send(p.client, { t: 'end', winner, score: m.score, reason, youTeam: p.team });
    p.client.match = null; p.client.player = null;
  }
}

function playerLeft(client) {
  const m = client.match, p = client.player;
  if (!m || !p) return;
  p.client = null; p.bot = true;   // a bot quietly keeps playing under the same name
  p.brain.path = []; p.brain.repath = 0;
  client.match = null; client.player = null;
  if (!m.players.some(o => o.client)) endMatch(m, null, 'empty');
}

// One 60 Hz movement step. p: {x, y, stance, running, slideT, slideCd, slideX, slideY}.
// (mx, my) is the wanted direction in the arena; run/crouch are the held keys; runOk says whether
// running is allowed (players: only when moving forward). canMove is false during the countdown.
function stepMovement(p, mx, my, run, crouch, runOk, canMove, ads = false) {
  if (ads) run = false;
  if (p.slideCd > 0) p.slideCd--;
  const len = Math.hypot(mx, my);
  if (p.stance === 'slide') {
    p.slideT--;
    if (p.slideT <= 0) p.stance = crouch ? 'crouch' : 'stand';
  } else if (crouch) {
    // fast enough (running) -> slide in the direction you're going; otherwise just crouch
    if (p.running && len && canMove && p.slideCd <= 0) {
      p.stance = 'slide'; p.slideT = P.slideTicks; p.slideCd = P.slideTicks + P.slideCooldown;
      p.slideX = mx / len; p.slideY = my / len;
    } else p.stance = 'crouch';
  } else p.stance = 'stand';
  p.running = p.stance === 'stand' && run && runOk && len > 0;
  // Rappel (X): at the edge of a gap in the upper floor, clip on and lower yourself down slowly. You can aim
  // and shoot on the way down; X again lets go (you drop).
  if (p.wantRap) { p.wantRap = false; if (p.rap) p.rap = null; else if (canMove) startRappel(p); }
  if (p.rap) {
    p.running = false; if (p.stance === 'slide') p.stance = 'stand';
    const r = p.rap;
    if (!r.over) {   // step out over the edge first
      const d = Math.hypot(r.x - p.x, r.y - p.y);
      if (d <= 2) { p.x = r.x; p.y = r.y; r.over = true; } else { p.x += (r.x - p.x) / d * 2; p.y += (r.y - p.y) / d * 2; }
      return;
    }
    const z = p.z || 0, sup = supportAt(p.x, p.y, z);
    p.z = Math.max(sup, z - P.rapSpeed); p.vz = 0;
    if (p.z <= sup) p.rap = null;
    return;
  }
  if (!canMove) { settle(p); return; }
  // Blink (VOLT): a quick dash, stopped by walls
  if (p.dashT > 0) {
    p.dashT--;
    const z = p.z || 0;
    for (let k = 0; k < 3; k++) {
      const nx = p.x + p.dashX * 5, ny = p.y + p.dashY * 5;
      if (!blockedAt(nx, ny, P.r, z) && supportAt(nx, ny, z) <= z + 14 && !stairBlocks(nx, ny, z)) { p.x = nx; p.y = ny; } else { p.dashT = 0; break; }
    }
    settle(p);
    return;
  }
  // Ladders: walk toward the wall/floor edge to climb, away from it to climb down. Space lets go (you drop).
  if (p.dropT > 0) p.dropT--;
  if (p.wantDrop) {
    p.wantDrop = false;
    const l = ladderAt(p.x, p.y);
    if (l && (p.z || 0) > supportAt(p.x, p.y, p.z || 0) + 0.5) {
      p.dropT = 30; p.onLadder = false;
      for (const d of [14, 8, 4]) { const nx = p.x - l[0] * d, ny = p.y - l[1] * d; if (!blockedAt(nx, ny, P.r, p.z || 0) && !stairBlocks(nx, ny, p.z || 0)) { p.x = nx; p.y = ny; break; } }   // push off the ladder
    }
  }
  const lad = !p.bot && !(p.dropT > 0) && ladderAt(p.x, p.y);
  p.onLadder = false;
  if (lad) {
    const z = p.z || 0, sup = supportAt(p.x, p.y, z), dot = len ? (mx * lad[0] + my * lad[1]) / len : 0;
    if (z > sup + 0.5) {   // on the ladder
      p.stance = 'stand'; p.running = false; p.onLadder = true; p.vz = 0;
      if (dot > 0.3) p.z = Math.min(UP.floor, z + P.climb);
      else if (dot < -0.3) p.z = Math.max(sup, z - P.climb);
      if (!(p.z >= UP.floor && dot > 0.3)) return;   // at the top, keep going forward onto the floor
    } else if (dot > 0.3 && z < UP.floor - 1) { p.z = z + P.climb; p.vz = 0; p.stance = 'stand'; p.running = false; p.onLadder = true; return; }
  }
  let dx, dy, spd;
  if (p.stance === 'slide') {
    const k = p.slideT / P.slideTicks;               // slows down over the slide
    spd = P.crouchSpeed + (P.slideSpeed - P.crouchSpeed) * k;
    dx = p.slideX; dy = p.slideY;
  } else {
    if (!len) { settle(p); return; }   // standing still: still fall if there's nothing under you (e.g. let go of a ladder)
    spd = (p.running ? P.run : p.stance === 'crouch' ? P.crouchSpeed : P.walk) * (ads ? P.adsSpeed : 1) * (p.spdMul || 1);
    dx = mx / len; dy = my / len;
  }
  const ox = p.x, oy = p.y, z = p.z || 0;
  const ok = (x, y) => !blockedAt(x, y, P.r, z) && supportAt(x, y, z) <= z + 14 && !stairBlocks(x, y, z);   // no wall, no step too high, not into a staircase
  if (ok(p.x + dx * spd, p.y)) p.x += dx * spd;
  if (ok(p.x, p.y + dy * spd)) p.y += dy * spd;
  if (p.stance === 'slide' && p.x === ox && p.y === oy) p.slideT = Math.min(p.slideT, 1);   // slid into a wall
  settle(p);
}
// stand on whatever is under you; if that's lower (walked off a balcony edge), fall
function settle(p) {
  const z = p.z || 0, sup = supportAt(p.x, p.y, z);
  if (sup >= z - 2) { p.z = sup; p.vz = 0; return; }
  if (!p.bot && !(p.dropT > 0) && ladderAt(p.x, p.y)) { p.vz = 0; return; }   // holding on to a ladder (unless you just let go)
  p.vz = (p.vz || 0) - 0.6; p.z = z + p.vz;
  if (p.z <= sup) { p.z = sup; p.vz = 0; }
  unstick(p);
}
// Rappel from where you stand on the upper floor: look toward a gap within reach (no wall in between).
// Returns the spot just past the edge to hang from, or null.
function rappelSpot(p) {
  const z = p.z || 0;
  if (p.bot || z < UP.floor - 1 || p.rap) return null;
  const dx = Math.cos(p.yaw || 0), dy = Math.sin(p.yaw || 0);
  for (let d = 4; d <= 48; d += 4) {
    const x = p.x + dx * d, y = p.y + dy * d;
    if (blockedAt(x, y, 4, z)) return null;
    if (supportAt(x, y, z) < z - 2) {   // no floor here: hang just past the edge, clear of walls all the way down
      for (let t = d + 12; t <= d + 40; t += 4) {
        const tx = p.x + dx * t, ty = p.y + dy * t;
        if (supportAt(tx, ty, z) < z - 2 && !blockedAt(tx, ty, P.r, z) && !blockedAt(tx, ty, P.r, 40) && !blockedAt(tx, ty, P.r, 0)) return [tx, ty];
      }
      return null;
    }
  }
  return null;
}
function startRappel(p) { const s = rappelSpot(p); if (s) p.rap = { x: s[0], y: s[1], over: false }; }
// after a drop you can land overlapping the wall under the balcony edge: nudge to the nearest clear spot
function unstick(p) {
  if (!blockedAt(p.x, p.y, P.r, p.z)) return;
  for (let d = 2; d <= 32; d += 2) for (let a = 0; a < 16; a++) {
    const x = p.x + Math.cos(a / 8 * Math.PI) * d, y = p.y + Math.sin(a / 8 * Math.PI) * d;
    if (!blockedAt(x, y, P.r, p.z)) { p.x = x; p.y = y; return; }
  }
}

// ---------- Aim (first person) ----------
// yaw = facing direction on the floor plane (radians, 0 = +x), pitch = look up (+) / down (-).
// Players aim on their own computer (arrow keys) and send yaw/pitch; bots aim here.
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Recoil for shot n of a burst: view kicks up, plus a fixed left/right sway (same every time, so it can be learned)
function recoilKick(n) {
  return {
    pitch: Math.min(P.recoilPitchMax, P.recoilPitch + n * P.recoilGrow),
    yaw: (Math.sin((n + 1) * 0.8) - Math.sin(n * 0.8)) * P.recoilYaw * Math.min(1, n / 3),
  };
}

// Exact test: does the straight segment (x1,y1)->(x2,y2) pass through any wall? (slab method per rectangle)
function segmentClear(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  for (let i = 0; i < MAP.walls.length; i++) {
    if (!wallOn(i)) continue;
    const [wx, wy, w, h] = MAP.walls[i];
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-dx, x1 - wx], [dx, wx + w - x1], [-dy, y1 - wy], [dy, wy + h - y1]]) {
      if (p === 0) { if (q < 0) { t0 = 2; break; } }
      else { const r = q / p; if (p < 0) { if (r > t1) { t0 = 2; break; } if (r > t0) t0 = r; } else { if (r < t0) { t0 = 2; break; } if (r < t1) t1 = r; } }
    }
    if (t0 <= t1) return false;
  }
  return true;
}

// First wall the ray (x,y)->(dir) hits within maxD: { i, t } or null (slab method)
function rayWall(x, y, dx, dy, maxD) {
  let best = null;
  for (let i = 0; i < MAP.walls.length; i++) {
    if (!wallOn(i)) continue;
    const [wx, wy, w, h] = MAP.walls[i];
    let t0 = 0, t1 = maxD, miss = false;
    for (const [p, q] of [[-dx, x - wx], [dx, wx + w - x], [-dy, y - wy], [dy, wy + h - y]]) {
      if (p === 0) { if (q < 0) { miss = true; break; } }
      else { const r = q / p; if (p < 0) { if (r > t1) { miss = true; break; } if (r > t0) t0 = r; } else { if (r < t0) { miss = true; break; } if (r < t1) t1 = r; } }
    }
    if (!miss && t0 <= t1 && (!best || t0 < best.t)) best = { i, t: t0 };
  }
  return best;
}
// A green panel under the crosshair within range (and at a height the panel covers): { i, t, h } or null
function panelUnder(x, y, eye, yaw, pitch, maxD = P.panelRange) {
  const hit = rayWall(x, y, Math.cos(yaw), Math.sin(yaw), maxD);
  if (!hit || MAP.walls[hit.i][4] !== 3) return null;
  const h = eye + hit.t * Math.tan(pitch);
  return h > 0 && h < 76 ? { i: hit.i, t: hit.t, h } : null;
}

// What's under the crosshair: the view ray from the shooter's eye along yaw/pitch passes through a body
// (a cylinder r wide and as tall as their stance) with nothing blocking the view. The top headH px is the head.
// cands: [{ x, y, stance }]. Returns { c, along, h, head } for the nearest, or null.
function castRay(x, y, eye, yaw, pitch, cands, spread = P.lockR) {
  const dx = Math.cos(yaw), dy = Math.sin(yaw), tp = Math.tan(pitch);
  let best = null;
  for (const c of cands) {
    const rx = c.x - x, ry = c.y - y, along = rx * dx + ry * dy;
    if (along <= 0 || (best && along >= best.along)) continue;
    const perp = Math.abs(rx * dy - ry * dx);
    if (perp > P.r + spread) continue;
    const height = STANCES[c.stance || 'stand'].height, cz = c.z || 0, h = eye + along * tp - cz;   // h: height up their body
    if (h < -spread || h > height + Math.max(0, spread - P.lockR)) continue;
    if (h > height - P.headH && perp > P.headR + Math.max(0, spread - P.lockR)) continue;   // beside the head: a miss (it's narrower than the shoulders)
    // the shot path is clear from the shooter to where the ray meets their body (not centre to centre, so a
    // player half behind a corner can still be hit on the part you can see)
    const front = along - Math.sqrt(Math.max(0, P.r * P.r - perp * perp));
    if (clear3(x, y, eye, x + dx * front, y + dy * front, eye + front * tp)) best = { c, along, h: cz + Math.min(h, height), head: h >= height - P.headH };
  }
  return best;
}
// Where your eye (and gun) is: your centre, or shifted to the side while leaning. The lean stops short of
// walls, so you can't lean through one. lean: -1 left, 0, +1 right.
function eyePos(x, y, yaw, lean) {
  if (!lean) return [x, y];
  const rx = -Math.sin(yaw), ry = Math.cos(yaw);   // to your right
  for (const k of [1, 0.66, 0.33]) {
    const ex = x + rx * lean * P.leanPx * k, ey = y + ry * lean * P.leanPx * k;
    if (!blocked(ex, ey, 4) && segmentClear(x, y, ex, ey)) return [ex, ey];
  }
  return [x, y];
}
function aimTarget(m, p) {
  const [ex, ey] = eyePos(p.x, p.y, p.yaw, p.lean || 0);
  const w = WEAPONS[p.weapon || 'rifle'];
  const hit = castRay(ex, ey, (p.z || 0) + STANCES[p.stance].eye, p.yaw, p.pitch, m.players.filter(o => o.alive && o.team !== p.team), w.spread);
  return hit && hit.along <= w.range ? hit : null;   // the shotgun doesn't fire at targets out of its range
}

// Bot: turns toward a target view at a limited speed, so it has to fight recoil like a player
function botAim(b, yaw, pitch) {
  const turn = P.botTurn * b.brain.skill;
  b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(yaw - b.yaw), -turn, turn));
  b.pitch = clamp(b.pitch + clamp(pitch - b.pitch, -turn * 0.7, turn * 0.7), -P.pitchMax, P.pitchMax);
}

// Extraction: where should this bot be going? { x, y, mode } — mode 'go' (walk there, even mid-fight),
// 'hold' (stand there; e.g. extracting the gem), or null to just hunt the nearest enemy.
function botGoal(m, b) {
  if (m.mode !== 'extraction' || !m.gem) return null;
  const g = m.gem, attacking = b.team === m.attack;
  const base = MAP.bases[b.team], home = [base[0] + base[2] / 2, base[1] + base[3] / 2];
  if (attacking) {
    if (g.state === 'carried' && g.carrier === b.id) return { x: home[0], y: home[1], mode: 'go' };
    const cards = m.cards || [];
    if (cards.some(c => c.carrier === b.id)) { const r = MAP.reboot[b.team]; return { x: r[0], y: r[1], mode: 'go' }; }   // bring a teammate back
    const loose = cards.filter(c => !c.carrier && c.z < 10 && Math.hypot(c.x - b.x, c.y - b.y) < 320);
    if (loose.length && g.state !== 'carried') { const c = loose[0]; return { x: c.x, y: c.y, mode: 'go' }; }
    if (g.state === 'carried') { const c = m.players.find(o => o.id === g.carrier); return c ? { x: c.x, y: c.y, mode: 'escort' } : null; }
    if (Math.hypot(g.x - b.x, g.y - b.y) < EXTRACT.extractR - 10) return { x: g.x, y: g.y, mode: 'hold' };
    return { x: g.x, y: g.y, mode: 'go' };
  }
  if (g.state === 'carried') { const c = m.players.find(o => o.id === g.carrier); return c ? { x: c.x, y: c.y, mode: 'go' } : null; }
  if (g.state === 'dropped') return { x: g.x, y: g.y, mode: 'go' };
  if (!b.brain.guard) {   // pick a spot to hold around the gem room
    for (let k = 0; k < 30; k++) {
      const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 120, x = g.x + Math.cos(a) * d, y = g.y + Math.sin(a) * d;
      if (!blocked(x, y, P.r + 4)) { b.brain.guard = [x, y]; break; }
    }
  }
  return b.brain.guard ? { x: b.brain.guard[0], y: b.brain.guard[1], mode: Math.hypot(b.brain.guard[0] - b.x, b.brain.guard[1] - b.y) < 20 ? 'hold' : 'go' } : null;
}
function followPath(b, inp, tx, ty) {
  const br = b.brain;
  if (--br.repath <= 0 || !br.path.length || br.pathTo !== Math.round(tx / 16) + ',' + Math.round(ty / 16)) {
    br.path = findPath(b.x, b.y, tx, ty); br.repath = 20; br.pathTo = Math.round(tx / 16) + ',' + Math.round(ty / 16);
  }
  while (br.path.length && Math.hypot(br.path[0][0] - b.x, br.path[0][1] - b.y) < 6) br.path.shift();
  if (br.path.length) {
    inp.mx = br.path[0][0] - b.x; inp.my = br.path[0][1] - b.y;
    const ahead = br.path[Math.min(br.path.length - 1, 4)];
    return Math.atan2(ahead[1] - b.y, ahead[0] - b.x);
  }
  return null;
}

// a random spot a bot can stand on (on the ground), near `near` (within r px) or anywhere; null if none found
function randomSpot(near, r, test) {
  for (let k = 0; k < 40; k++) {
    const x = near ? near[0] + (Math.random() * 2 - 1) * r : 48 + Math.random() * (MAP.w - 96);
    const y = near ? near[1] + (Math.random() * 2 - 1) * r : 48 + Math.random() * (MAP.h - 96);
    if (x < 40 || y < 40 || x > MAP.w - 40 || y > MAP.h - 40) continue;
    if (blocked(x, y, P.r + 6) || navBlocked[cellOf(x, y)]) continue;
    if (test && !test(x, y)) continue;
    return [x, y];
  }
  return null;
}

// Bots: they wander between random spots (stopping now and then to check an angle), walk instead of run when
// enemies may be close, react a moment late when they first spot you (and their first shots are off), and
// back off to cover when they get hurt, then come back for another look. In Extraction they still play the
// objective, but each takes its own route.
function botThink(m, b) {
  const br = b.brain, inp = { mx: 0, my: 0, yaw: b.yaw, pitch: 0 };
  const goal = botGoal(m, b);
  const foes = m.players.filter(o => o.alive && o.team !== b.team);
  // remember getting hit (to back off)
  if (br.lastHp != null && b.hp < br.lastHp) br.hurtT = 120;
  br.lastHp = b.hp;
  if (br.hurtT > 0) br.hurtT--;
  const eye = (b.z || 0) + STANCES[b.stance].eye;
  const canSee = o => lineOfSight(b.x, b.y, o.x, o.y, eye, (o.z || 0) + STANCES[o.stance].height * 0.6);
  const near = o => Math.hypot(o.x - b.x, o.y - b.y);
  const walkTo = (x, y, run) => { const yy = followPath(b, inp, x, y); if (yy != null) inp.yaw = yy; inp.run = run; return yy != null; };
  if (!foes.length) {
    if (goal && goal.mode !== 'hold') walkTo(goal.x, goal.y, true);
    return inp;
  }
  // target: the closest enemy it can see, otherwise the closest one
  const visible = foes.filter(canSee);
  const t = (visible.length ? visible : foes).reduce((a, o) => (near(o) < near(a) ? o : a));
  const dx = t.x - b.x, dy = t.y - b.y, dist = Math.hypot(dx, dy) || 1, sees = visible.includes(t);
  const closest = Math.min(...foes.map(near));

  // Aim wobble: bots aren't perfect
  if (--br.wobbleT <= 0) { br.wobble = [(Math.random() - 0.5) * 0.09 / br.skill, (Math.random() - 0.5) * 0.06 / br.skill]; br.wobbleT = 15 + Math.random() * 25; }
  const aimAt = () => {
    const err = br.aimErr || [0, 0];
    inp.yaw = Math.atan2(dy, dx) + br.wobble[0] + err[0];
    inp.pitch = Math.atan2((t.z || 0) + STANCES[t.stance].height * 0.6 - eye, dist) + br.wobble[1] + err[1];
    if (br.seen > br.react) br.aimErr = [err[0] * 0.93, err[1] * 0.93];   // settles onto you after it reacts
  };

  // backing off to cover
  if (br.retreatT > 0) {
    br.retreatT--;
    if (sees) { br.seen++; aimAt(); } else br.seen = 0;
    const moving = walkTo(br.retreatTo[0], br.retreatTo[1], !sees);
    if (sees) inp.yaw = Math.atan2(dy, dx) + br.wobble[0];   // backs off facing you, still shooting
    if (!moving || Math.hypot(br.retreatTo[0] - b.x, br.retreatTo[1] - b.y) < 12) { inp.mx = inp.my = 0; inp.crouch = br.hurtT > 0; }
    if (br.retreatT <= 0) { br.peekT = 60 + Math.random() * 90; br.lastSeen = [t.x, t.y]; }
    return inp;
  }

  if (sees) {
    if (!br.seen) {   // just spotted someone: a moment to react, and the first shots are off target
      br.react = (24 + Math.random() * 30) / br.skill + (b.running ? 20 : 0) + (br.pauseT > 0 ? -8 : 0);
      br.aimErr = [(Math.random() - 0.5) * 0.45, (Math.random() - 0.5) * 0.2];
      br.style = Math.random();   // how it fights this time: strafe / stand / crouch
    }
    br.path = []; br.seen++; br.lastSeen = [t.x, t.y]; br.lostT = 0; br.pauseT = 0;
    aimAt();
    // movement while fighting: strafe, stand still, or crouch (changes now and then)
    if (--br.strafeT <= 0) { br.strafe *= -1; br.strafeT = 25 + Math.random() * 45; if (Math.random() < 0.3) br.style = Math.random(); }
    if (br.style < 0.55) {
      let mx = -dy / dist * br.strafe, my = dx / dist * br.strafe;
      if (dist < 120) { mx -= dx / dist; my -= dy / dist; } else if (dist > 320) { mx += dx / dist * 0.5; my += dy / dist * 0.5; }
      inp.mx = mx; inp.my = my;
    } else if (br.style < 0.8) inp.crouch = true;
    // objective first: a carrier keeps heading home and an extractor stays on the gem while shooting
    const carrying = goal && goal.mode === 'go' && m.gem && m.gem.carrier === b.id;
    if (carrying) { inp.mx = 0; inp.my = 0; inp.crouch = false; followPath(b, inp, goal.x, goal.y); aimAt(); }
    if (goal && goal.mode === 'hold') { inp.mx = 0; inp.my = 0; }
    if (br.seen > br.react && OPS[b.op]) {
      const want = b.op === 'haven' ? b.hp <= 60 : true;
      if (b.tac <= 0 && want && Math.random() < 0.012) br.useTac = true;
      if (b.ult >= OPS[b.op].ult.charge * 60 && Math.random() < 0.008) br.useUlt = true;
    }
    if (b.weapon !== 'shotgun' && dist < 100) inp.weapon = 'shotgun';
    else if (b.weapon === 'shotgun' && dist > 170) inp.weapon = 'rifle';
    // back off when hurt (or now and then after a long fight), unless it's holding the objective
    const busy = carrying || (goal && goal.mode === 'hold');
    if (!busy && ((br.hurtT > 100 && b.hp <= 60 && Math.random() < 0.35) || (br.seen > 90 && Math.random() < 0.006))) {
      const away = randomSpot([b.x - dx / dist * 140, b.y - dy / dist * 140], 110, (x, y) => !lineOfSight(x, y, t.x, t.y, 33, 33) && Math.hypot(x - t.x, y - t.y) > dist);
      if (away) { br.retreatTo = away; br.retreatT = 70 + Math.random() * 80; br.path = []; }
    }
    // grenades: often an opener while they line up their first shot, sometimes mid-fight
    if (br.seen > 6) {
      const r = Math.random() / br.skill, opener = br.seen < br.react + 10;
      const k = opener ? 1 : 0.25;
      if (!b.cd.frag && dist > 110 && dist < 380 && r < 0.02 * k) inp.throw = 'frag';
      else if (!b.cd.boom && dist < 320 && r < 0.04 * k) inp.throw = 'boom';
      else if (!b.cd.therm && dist > 80 && dist < 230 && r < 0.02 * k) inp.throw = 'therm';
      if (inp.throw) br.throwDist = dist;
    }
    return inp;
  }

  br.seen = 0; br.lostT = (br.lostT || 0) + 1;
  if (goal && goal.mode === 'hold') return inp;   // hold the spot (extracting, guarding)
  const cautious = closest < 520;   // walk (quieter, can shoot) when enemies may be close; run when far
  // after a retreat: hold the angle where it last saw you for a moment, then push it
  if (br.peekT > 0) {
    br.peekT--;
    if (br.lastSeen) inp.yaw = Math.atan2(br.lastSeen[1] - b.y, br.lastSeen[0] - b.x);
    if (br.peekT < 30 && br.lastSeen) walkTo(br.lastSeen[0], br.lastSeen[1], false);
    return inp;
  }
  // stopped to check an angle: look around a bit
  if (br.pauseT > 0) {
    br.pauseT--;
    br.lookT = (br.lookT || 0) + 1;
    inp.yaw = (br.lookYaw ?? b.yaw) + Math.sin(br.lookT / 25) * 0.7;
    inp.crouch = br.pauseCrouch;
    return inp;
  }
  if (goal) {   // objective, each bot by its own route (a detour point near it first)
    if (goal.mode === 'go' && !(m.gem && m.gem.carrier === b.id) && br.via === undefined) br.via = Math.random() < 0.7 ? randomSpot([goal.x, goal.y], 280) : null;
    if (br.via && Math.hypot(br.via[0] - b.x, br.via[1] - b.y) < 40) br.via = null;
    const [gx, gy] = br.via || (goal.mode === 'escort' ? [goal.x + 30, goal.y + 30] : [goal.x, goal.y]);
    walkTo(gx, gy, !cautious || (m.gem && m.gem.carrier === b.id));
    if (cautious && !(m.gem && m.gem.carrier === b.id) && Math.random() < 0.004) { br.pauseT = 30 + Math.random() * 70; br.lookYaw = b.yaw; br.pauseCrouch = Math.random() < 0.4; }
    return inp;
  }
  // no objective: check where it last saw someone, otherwise roam (often toward where enemies are)
  if (br.lastSeen && br.lostT < 150) {
    if (!walkTo(br.lastSeen[0], br.lastSeen[1], false) || Math.hypot(br.lastSeen[0] - b.x, br.lastSeen[1] - b.y) < 20) br.lastSeen = null;
    return inp;
  }
  if (!br.roam || --br.roamT <= 0 || Math.hypot(br.roam[0] - b.x, br.roam[1] - b.y) < 24) {
    if (br.roam && Math.random() < 0.6) { br.pauseT = 40 + Math.random() * 110; br.lookYaw = b.yaw; br.lookT = 0; br.pauseCrouch = Math.random() < 0.35; }
    const toward = foes[(Math.random() * foes.length) | 0];
    br.roam = (Math.random() < 0.55 ? randomSpot([toward.x, toward.y], 300) : null) || randomSpot(null) || [t.x, t.y];
    br.roamT = 300 + Math.random() * 300;
    br.path = [];
    if (br.pauseT > 0) return inp;
  }
  if (!walkTo(br.roam[0], br.roam[1], !cautious)) br.roamT = 0;
  if (cautious && Math.random() < 0.003) { br.pauseT = 30 + Math.random() * 80; br.lookYaw = b.yaw; br.lookT = 0; br.pauseCrouch = Math.random() < 0.4; }
  return inp;
}

// ---------- Grenades ----------
// Q boomerang: curves out and flies back to you; explodes when it touches an enemy. 10 s cooldown,
//   reset instantly if it hits someone. Flies at chest height, so a sliding player ducks under it.
// E frag: arcs, bounces off walls and the floor; explodes after 3 s, or at once if it touches an enemy.
// F thermite: ignites on whatever it touches first and leaves a wall of fire across the throw direction
//   that burns enemies standing in it.
const KINDS = ['boom', 'frag', 'therm'];
const KIND_CODE = { boom: 0, frag: 1, therm: 2 };
// src codes for damage/knockout events: 0 gun, 1 boomerang, 2 frag, 3 fire
const DMG_SRC = { gun: 0, boom: 1, frag: 2, therm: 3, shotgun: 4 };

// pitch that lands a frag/thermite about `dist` px away on open floor (bots use this to aim lobs)
function lobPitch(kind, dist, eye) {
  const g = GREN[kind]; let best = 0, err = Infinity;
  for (let pitch = -0.6; pitch <= 0.9; pitch += 0.03) {
    const pit = pitch + g.lift; let z = eye - 4, vz = Math.sin(pit) * g.speed, d = 0;
    while (z > 0 && d < 1000) { vz -= GREN.gravity; z += vz; d += Math.cos(pit) * g.speed; }
    if (Math.abs(d - dist) < err) { err = Math.abs(d - dist); best = pitch; }
  }
  return best;
}

function throwGrenade(m, p, kind) {
  const g = GREN[kind];
  if (!g || p.cd[kind] > 0) return;
  if (p.bot && kind !== 'boom' && p.brain.throwDist) p.pitch = lobPitch(kind, p.brain.throwDist, STANCES[p.stance].eye);
  p.cd[kind] = g.cd;
  const fx = Math.cos(p.yaw), fy = Math.sin(p.yaw);
  let x = p.x + fx * (P.r + 4), y = p.y + fy * (P.r + 4);
  if (blockedAt(x, y, 3, (p.z || 0) + 20)) { x = p.x; y = p.y; }
  const pz = p.z || 0;
  const pr = { id: m.nextProj++, kind, owner: p.id, team: p.team, x, y, z: pz + STANCES[p.stance].eye - 4, t: 0, yaw: p.yaw };
  if (kind === 'boom') {
    Object.assign(pr, { z: pz + g.z, dir: p.yaw, back: false, vx: fx * g.speed, vy: fy * g.speed, vz: 0 });
  } else {
    const pit = clamp(p.pitch + g.lift, -0.6, 1.1), c = Math.cos(pit);
    Object.assign(pr, { vx: fx * c * g.speed, vy: fy * c * g.speed, vz: Math.sin(pit) * g.speed });
  }
  m.projectiles.push(pr);
  m.events.push(['g', p.id, KIND_CODE[kind]]);
}

function touchingEnemy(m, pr, pad) {
  for (const o of m.players) {
    if (!o.alive || o.team === pr.team) continue;
    const oz = o.z || 0;
    if (Math.hypot(o.x - pr.x, o.y - pr.y) < P.r + pad && pr.z <= oz + STANCES[o.stance].height + 2 && pr.z >= oz - 4) return o;
  }
  return null;
}

// one place that applies damage and reports hits / knockouts (owner may be null)
function damage(m, o, amount, owner, src, head, x, y, z) {
  if (!o.alive) return;
  o.hp -= amount;
  if (owner && owner !== o && OPS[owner.op]) owner.ult = Math.min(OPS[owner.op].ult.charge * 60, owner.ult + amount * 6);   // 1 health of damage = 2 s of charge
  m.events.push(['h', o.id, Math.round(x), Math.round(y), Math.round(z), owner ? owner.id : 0, head ? 1 : 0, src]);
  if (o.hp <= 0) {
    o.alive = false; o.hp = 0;
    if (owner) owner.kills++;
    m.events.push(['k', owner ? owner.id : 0, o.id, head ? 1 : 0, src]);
    if (m.practice) o.respawnT = 84;
    if (m.mode === 'extraction' && o.team !== m.attack) o.respawnT = EXTRACT.defRespawn;   // defenders are back in 5 s
    if (m.mode === 'extraction' && o.team === m.attack && m.cards) {
      // an attacker drops their reboot card (and any they were carrying) where they fell
      for (const c of m.cards) if (c.carrier === o.id) Object.assign(c, { carrier: 0, x: o.x + (Math.random() - 0.5) * 16, y: o.y + (Math.random() - 0.5) * 16, z: o.z || 0 });
      m.cards.push({ id: o.id, x: o.x, y: o.y, z: o.z || 0, carrier: 0 });
    }
  }
}

function damagePanel(m, i, amount) {
  if (!m.panelHp || m.broken.has(i)) return;
  const hp = (m.panelHp.has(i) ? m.panelHp.get(i) : P.panelHp) - amount;
  m.panelHp.set(i, hp);
  if (hp <= 0) { m.broken.add(i); m.events.push(['pb', i]); }   // smashed through
}
function explode(m, pr, radius, dmg, src) {
  m.events.push(['x', Math.round(pr.x), Math.round(pr.y), Math.round(pr.z), src, radius]);
  if (m.panelHp) MAP.walls.forEach((w, i) => {   // blasts splinter nearby green panels
    if (w[4] !== 3 || m.broken.has(i)) return;
    const nx = clamp(pr.x, w[0], w[0] + w[2]), ny = clamp(pr.y, w[1], w[1] + w[3]), d = Math.hypot(pr.x - nx, pr.y - ny);
    if (d < radius) damagePanel(m, i, Math.round(dmg * P.panelBlast * (1 - d / radius)));
  });
  const owner = m.players.find(o => o.id === pr.owner);
  for (const o of m.players) {
    if (!o.alive || o.team === pr.team) continue;
    const oz = (o.z || 0) + 20, d = Math.max(0, Math.hypot(o.x - pr.x, o.y - pr.y, oz - pr.z) - P.r);
    if (d > radius || !clear3(pr.x, pr.y, pr.z + 2, o.x, o.y, oz)) continue;
    damage(m, o, Math.round(dmg * Math.max(0.3, 1 - d / radius)), owner, src, false, o.x, o.y, 20);
  }
}

function stepBoomerang(m, pr, owner) {
  const g = GREN.boom;
  if (!owner || !owner.alive || pr.t > g.life) { pr.dead = true; return; }
  if (!pr.back && pr.t > g.out) pr.back = true;
  if (!pr.back) pr.dir += g.curve;                         // curves out to the right
  else pr.dir += clamp(wrapAngle(Math.atan2(owner.y - pr.y, owner.x - pr.x) - pr.dir), -0.22, 0.22);   // homes back
  pr.vx = Math.cos(pr.dir) * g.speed; pr.vy = Math.sin(pr.dir) * g.speed;
  const nx = pr.x + pr.vx, ny = pr.y + pr.vy;
  if (gBlocked(nx, ny, 3, pr.z)) { pr.back = true; pr.dir += Math.PI; return; }   // bounce off walls and head home
  pr.x = nx; pr.y = ny;
  if (touchingEnemy(m, pr, 6)) {
    explode(m, pr, g.radius, g.dmg, DMG_SRC.boom);
    owner.cd.boom = 0;                                      // a hit gives the boomerang straight back
    m.events.push(['r', owner.id]);
    pr.dead = true; return;
  }
  if (pr.back && Math.hypot(owner.x - pr.x, owner.y - pr.y) < P.r + 8) pr.dead = true;   // caught
}

function stepThrown(m, pr) {
  const g = GREN[pr.kind];
  pr.vz -= GREN.gravity;
  let hitWall = false, nx = pr.x + pr.vx, ny = pr.y + pr.vy;
  if (gBlocked(nx, pr.y, 3, pr.z)) { pr.vx = -pr.vx * g.bounce; nx = pr.x; hitWall = true; }
  if (gBlocked(nx, ny, 3, pr.z)) { pr.vy = -pr.vy * g.bounce; ny = pr.y; hitWall = true; }
  const z0 = pr.z;
  pr.x = nx; pr.y = ny; pr.z += pr.vz;
  // the underside of a balcony: bounce back down
  if (z0 < UP.floor && pr.z >= UP.floor - 1 && onSlab(pr.x, pr.y)) { pr.z = UP.floor - 2; pr.vz = -Math.abs(pr.vz) * 0.5; }
  const ground = supportAt(pr.x, pr.y, z0);   // floor, stair or balcony under it
  let landed = false;
  if (pr.z <= ground) {
    landed = pr.vz < -0.6;
    pr.z = ground; pr.vz = -pr.vz * g.ground; if (pr.vz < 1) pr.vz = 0;
    pr.vx *= g.friction; pr.vy *= g.friction;
  }
  const enemy = touchingEnemy(m, pr, 4);
  if (pr.kind === 'frag') {
    if (enemy || pr.t >= g.fuse) { explode(m, pr, g.radius, g.dmg, DMG_SRC.frag); pr.dead = true; }
    else if ((hitWall || landed) && Math.hypot(pr.vx, pr.vy, pr.vz) > 1.2) m.events.push(['b', pr.id]);
  } else if (enemy || hitWall || landed || pr.z <= ground) { ignite(m, pr); pr.dead = true; }
  if (pr.t > 600) pr.dead = true;
}

// thermite: a wall of fire across the direction it was thrown
function ignite(m, pr) {
  const g = GREN.therm, px = -Math.sin(pr.yaw), py = Math.cos(pr.yaw);
  m.fires.push({ id: m.nextProj++, x1: pr.x - px * g.half, y1: pr.y - py * g.half, x2: pr.x + px * g.half, y2: pr.y + py * g.half,
    z: supportAt(pr.x, pr.y, pr.z + 2), t: g.burn, owner: pr.owner, team: pr.team });
  m.events.push(['x', Math.round(pr.x), Math.round(pr.y), 0, DMG_SRC.therm, 26]);
}
function distToSegment(x, y, f) {
  const dx = f.x2 - f.x1, dy = f.y2 - f.y1, t = clamp(((x - f.x1) * dx + (y - f.y1) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(x - (f.x1 + dx * t), y - (f.y1 + dy * t));
}

function stepGrenades(m) {
  for (const p of m.players) for (const k of KINDS) if (p.cd[k] > 0) p.cd[k]--;
  for (const pr of m.projectiles) {
    pr.t++;
    if (pr.kind === 'boom') stepBoomerang(m, pr, m.players.find(o => o.id === pr.owner));
    else stepThrown(m, pr);
  }
  m.projectiles = m.projectiles.filter(pr => !pr.dead);
  const g = GREN.therm;
  for (const f of m.fires) {
    if (--f.t <= 0) { f.dead = true; continue; }
    if (f.t % g.every) continue;
    const owner = m.players.find(o => o.id === f.owner);
    for (const o of m.players) {
      if (o.alive && o.team !== f.team && Math.abs((o.z || 0) - (f.z || 0)) < 30 && distToSegment(o.x, o.y, f) < g.width + P.r) damage(m, o, g.dmg, owner, DMG_SRC.therm, false, o.x, o.y, 8);
    }
  }
  m.fires = m.fires.filter(f => !f.dead);
}

// Where would a grenade go? Runs the real grenade code in a sandbox with no enemies (so it shows the full
// path) and returns { points: [[x, y, z], ...], end: [x, y, z], fire: [x1, y1, x2, y2] | null, back: bool }.
function predictThrow(kind, x, y, stance, yaw, pitch, z = 0) {
  const me = { id: -1, team: 'P', x, y, z, stance, yaw, pitch, alive: true, bot: false, cd: { boom: 0, frag: 0, therm: 0 } };
  const m = { players: [me], projectiles: [], fires: [], events: [], nextProj: 1 };
  throwGrenade(m, me, kind);
  const pr = m.projectiles[0];
  if (!pr) return null;
  const points = [[pr.x, pr.y, pr.z]];
  for (let i = 0; i < 400 && !pr.dead; i++) {
    pr.t++;
    if (pr.kind === 'boom') stepBoomerang(m, pr, me); else stepThrown(m, pr);
    points.push([pr.x, pr.y, pr.z]);
  }
  const f = m.fires[0];
  return { points, end: points[points.length - 1], fire: f ? [f.x1, f.y1, f.x2, f.y2] : null };
}

// ---------- Practice range ----------
// A private match on the player's own computer while matchmaking: you vs. training dummies that walk,
// duck and respawn but never fight back. Uses exactly the same simulation as real matches.
const DUMMY_LOOK = { jacket: 5, pants: 4, head: 0, headColor: 2, skin: 0 };
function placeDummy(m, d) {
  const me = m.players[0];
  let x = 400, y = 240;
  for (let i = 0; i < 80; i++) {
    x = 340 + Math.random() * (MAP.w - 380); y = 40 + Math.random() * (MAP.h - 80);   // anywhere outside blue's spawn room
    if (!blocked(x, y, P.r + 8) && Math.hypot(x - me.x, y - me.y) > 150 && m.players.every(o => o === d || o === me || Math.hypot(o.x - x, o.y - y) > 60)) break;
  }
  Object.assign(d, { x, y, hp: P.hp, alive: true, stance: 'stand', running: false, slideT: 0 });
  const walk = Math.random() < 0.5, a = Math.random() < 0.5 ? 0 : Math.PI / 2;
  d.brain.walk = walk ? [Math.cos(a), Math.sin(a)] : null;
  d.brain.duckT = Math.random() < 0.4 ? 60 + Math.random() * 120 : 0; d.brain.duck = false;
}
function dummyThink(m, d) {
  const br = d.brain, me = m.players[0];
  const inp = { mx: 0, my: 0, yaw: Math.atan2(me.y - d.y, me.x - d.x), pitch: 0, crouch: false };
  if (br.walk) {
    if (blocked(d.x + br.walk[0] * 8, d.y + br.walk[1] * 8, P.r)) br.walk = [-br.walk[0], -br.walk[1]];
    inp.mx = br.walk[0]; inp.my = br.walk[1];
  }
  if (br.duckT && --br.duckT <= 0) { br.duck = !br.duck; br.duckT = br.duck ? 70 : 90 + Math.random() * 120; }
  inp.crouch = br.duck;
  d.yaw = inp.yaw;
  return inp;
}
function createPractice(sendFn, name, look, op) {
  const client = { send: sendFn, name: String(name || 'PLAYER').slice(0, 12), look, match: null, player: null };
  const me = makePlayer('A', client.name, client, look, op);
  const players = [me];
  for (let i = 0; i < 6; i++) { const d = makePlayer('B', 'TARGET', null, DUMMY_LOOK); d.brain.dummy = true; players.push(d); }
  const m = { mode: 'practice', practice: true, players, events: [], projectiles: [], fires: [], nextProj: 1, broken: new Set(), panelHp: new Map(),
    score: { A: 0, B: 0 }, round: 1, phase: 'fight', phaseT: 0, tick: 0, over: false };
  const [sx, sy, syaw] = MAP.spawns.A[0];
  Object.assign(me, { x: sx, y: sy, yaw: syaw }); me.input.yaw = syaw;
  for (const d of players.slice(1)) placeDummy(m, d);
  client.match = m; client.player = me;
  send(client, { t: 'match', mode: 'practice', practice: true, you: me.id, map: MAP, cfg: P, roundsToWin: 0, players: publicPlayers(m) });
  const timer = runClock(() => stepMatch(m));
  return { receive: msg => handlePlay(client, msg), stop() { clearInterval(timer); client.match = null; } };
}

// in-match messages from a player: movement/aim input and grenade throws
function handlePlay(client, msg) {
  const p = client.player;
  if (!p || !msg || typeof msg !== 'object') return;
  if (msg.t === 'input' || msg.t === 'throw') {
    const c = v => Math.max(-1, Math.min(1, +v || 0));
    const yaw = Number.isFinite(+msg.yaw) ? wrapAngle(+msg.yaw) : p.input.yaw;
    const pitch = Number.isFinite(+msg.pitch) ? clamp(+msg.pitch, -P.pitchMax, P.pitchMax) : p.input.pitch;
    if (msg.t === 'input') {
      const ads = !!msg.ads, lean = ads ? Math.max(-1, Math.min(1, Math.round(+msg.lean || 0))) : 0;
      p.input = { f: c(msg.f), s: c(msg.s), yaw, pitch, run: !!msg.run, crouch: !!msg.crouch, ads, lean,
        weapon: WEAPONS[msg.weapon] ? msg.weapon : p.input.weapon || p.weapon };
      // where the player's own computer has them (it moves instantly); used if it's close to ours
      if (Number.isFinite(+msg.x) && Number.isFinite(+msg.y)) p.claim = [+msg.x, +msg.y];
      const rap = +msg.rap || 0;
      if (rap > (p.rapSeen || 0)) { p.rapSeen = rap; p.wantRap = true; }
      const tac = +msg.tac || 0, ult = +msg.ult || 0;
      if (tac > (p.tacSeen || 0)) { p.tacSeen = tac; p.wantTac = true; }
      if (ult > (p.ultSeen || 0)) { p.ultSeen = ult; p.wantUlt = true; }
      const drop = +msg.drop || 0;
      if (drop > (p.dropSeen || 0)) { p.dropSeen = drop; p.wantDrop = true; }
    }
    else if (KIND_CODE[msg.g] != null && p.throws.length < 3) { p.input.yaw = yaw; p.input.pitch = pitch; p.throws.push(msg.g); }   // queued, so two quick throws both happen
  }
}

// a far back corner of the defenders' own base (the one furthest from any attacker)
function respawnDefender(m, p) {
  const atk = m.players.filter(o => o.alive && o.team === m.attack);
  const spots = MAP.respawn[p.team];
  const far = spots.reduce((a, s) => (Math.min(...atk.map(o => Math.hypot(o.x - s[0], o.y - s[1])), 1e9) > Math.min(...atk.map(o => Math.hypot(o.x - a[0], o.y - a[1])), 1e9) ? s : a));
  Object.assign(p, { rap: null, onLadder: false, x: far[0], y: far[1], yaw: far[2], pitch: 0, z: 0, vz: 0, hp: P.hp, alive: true, cool: 0, burst: 0, stance: 'stand',
    running: false, slideT: 0, switchT: 0, respawnT: 0 });
  p.input = Object.assign({}, p.input, { yaw: far[2], pitch: 0 });
  p.brain.path = []; p.brain.repath = 0; p.brain.guard = null; Object.assign(p.brain, { via: undefined, retreatT: 0, peekT: 0, pauseT: 0, roam: null, lastSeen: null, seen: 0, aimErr: null });
  m.events.push(['rs', p.id]);
}

// an attacker brought back by a reboot card: at their reboot point (nudged off anyone standing there)
function rebootPlayer(m, p, at) {
  let [x, y, yaw] = at;
  for (let k = 0; k < 24; k++) {
    const a = k * 2.4, d = k ? 18 + k * 3 : 0, tx = at[0] + Math.cos(a) * d, ty = at[1] + Math.sin(a) * d;
    if (!blocked(tx, ty, P.r) && m.players.every(o => o === p || !o.alive || Math.hypot(o.x - tx, o.y - ty) > 26)) { x = tx; y = ty; break; }
  }
  Object.assign(p, { rap: null, onLadder: false, x, y, yaw, pitch: 0, z: 0, vz: 0, hp: P.hp, alive: true, cool: 0, burst: 0, stance: 'stand',
    running: false, slideT: 0, switchT: 0, respawnT: 0 });
  p.input = Object.assign({}, p.input, { yaw, pitch: 0 });
  p.brain.path = []; p.brain.repath = 0; p.brain.guard = null; Object.assign(p.brain, { via: undefined, retreatT: 0, peekT: 0, pauseT: 0, roam: null, lastSeen: null, seen: 0, aimErr: null });
}
// reboot cards: pick up by walking over one (attackers only), deliver to your reboot point
function stepCards(m) {
  const A = m.attack, X = EXTRACT, at = MAP.reboot[A];
  for (const c of m.cards) {
    if (c.carrier) { const p = m.players.find(o => o.id === c.carrier); if (p) { c.x = p.x; c.y = p.y; c.z = p.z || 0; } continue; }
    const p = m.players.find(o => o.alive && o.team === A && Math.hypot(o.x - c.x, o.y - c.y) < X.cardR && Math.abs((o.z || 0) - c.z) < 30);
    if (p) { c.carrier = p.id; m.events.push(['cp', p.id, c.id]); }
  }
  for (const p of m.players) {
    if (!p.alive || p.team !== A || Math.hypot(p.x - at[0], p.y - at[1]) > X.rebootR || (p.z || 0) > 10) continue;
    for (const c of m.cards.filter(c => c.carrier === p.id)) {
      const who = m.players.find(o => o.id === c.id);
      m.cards.splice(m.cards.indexOf(c), 1);
      if (who && !who.alive) { rebootPlayer(m, who, at); m.events.push(['rb', p.id, who.id]); }
    }
  }
}

function endRound(m, winner, reason) {
  if (m.phase !== 'fight') return;
  if (winner) m.score[winner]++;
  m.phase = 'roundEnd'; m.phaseT = 180; m.roundWinner = winner; m.roundReason = reason;
}

// Extraction objective, once per tick during the fight
function stepExtraction(m) {
  const g = m.gem, A = m.attack, X = EXTRACT;
  if (--m.timeLeft <= 0) return endRound(m, A === 'A' ? 'B' : 'A', 'time');   // defenders hold out
  if (m.cards) stepCards(m);
  const alive = m.players.filter(p => p.alive);
  if (g.state === 'home') {
    // attackers standing at the gem extract it; a defender in range blocks (contests) it
    const atk = alive.filter(p => p.team === A && Math.hypot(p.x - g.x, p.y - g.y) < X.extractR);
    const def = alive.some(p => p.team !== A && Math.hypot(p.x - g.x, p.y - g.y) < X.extractR);
    if (atk.length && !def) g.prog++;
    else if (!atk.length) g.prog = Math.max(0, g.prog - 2);
    if (g.prog >= X.extractTicks) {
      const c = atk.reduce((a, p) => (Math.hypot(p.x - g.x, p.y - g.y) < Math.hypot(a.x - g.x, a.y - g.y) ? p : a));
      g.state = 'carried'; g.carrier = c.id; g.prog = 0;
      m.events.push(['gx', c.id]);
    }
  } else if (g.state === 'carried') {
    const c = m.players.find(p => p.id === g.carrier);
    if (!c || !c.alive) { g.state = 'dropped'; g.carrier = 0; m.events.push(['gd', Math.round(g.x), Math.round(g.y)]); }
    else {
      g.x = c.x; g.y = c.y;
      const [bx, by, bw, bh] = MAP.bases[A];
      if (c.x > bx && c.x < bx + bw && c.y > by && c.y < by + bh) { m.events.push(['gw', c.id]); return endRound(m, A, 'delivered'); }
    }
  } else if (g.state === 'dropped') {
    const p = alive.find(o => Math.hypot(o.x - g.x, o.y - g.y) < X.pickR);
    if (p && p.team === A) { g.state = 'carried'; g.carrier = p.id; m.events.push(['gp', p.id]); }
    else if (p) { Object.assign(g, { state: 'home', x: MAP.gem[0], y: MAP.gem[1], prog: 0 }); m.events.push(['gr', p.id]); }
  }
}

// direction to blink: the way you're moving, or where you're facing
function startDash(p, mx, my) {
  const len = Math.hypot(mx, my);
  const dx = len ? mx / len : Math.cos(p.yaw || 0), dy = len ? my / len : Math.sin(p.yaw || 0);
  p.dashT = 8; p.dashX = dx; p.dashY = dy;
}
function useTac(m, p, mx, my) {
  const op = OPS[p.op];
  if (!op || p.tac > 0 || !p.alive) return;
  p.tac = op.tac.cd * 60;
  const enemies = m.players.filter(o => o.alive && o.team !== p.team);
  if (p.op === 'riot') p.fx.over = 360;
  else if (p.op === 'volt') { startDash(p, mx, my); p.rap = null; }
  else if (p.op === 'echo') for (const o of enemies) { if (Math.hypot(o.x - p.x, o.y - p.y) < 450) o.fx.reveal = Math.max(o.fx.reveal || 0, 240); }
  else if (p.op === 'haven') {
    for (const o of m.players) if (o.alive && o.team === p.team && Math.hypot(o.x - p.x, o.y - p.y) < 120) { o.hp = Math.min(P.hp, o.hp + 40); m.events.push(['hl', o.id]); }
  } else if (p.op === 'warden') {
    const hit = rayWall(p.x, p.y, Math.cos(p.yaw), Math.sin(p.yaw), 140), d = hit ? Math.max(0, hit.t - 24) : 130;
    m.zones.push({ k: 'smoke', x: p.x + Math.cos(p.yaw) * d, y: p.y + Math.sin(p.yaw) * d, r: 64, t: 480, team: p.team, owner: p.id });
  }
  m.events.push(['ab', p.id, 0, p.op]);
}
function useUlt(m, p) {
  const op = OPS[p.op];
  if (!op || p.ult < op.ult.charge * 60 || !p.alive) return;
  p.ult = 0;
  if (p.op === 'riot') {   // three blasts along the aim, stopping short of the first wall
    const hit = rayWall(p.x, p.y, Math.cos(p.yaw), Math.sin(p.yaw), 400), max = hit ? hit.t - 20 : 400;
    [140, 220, 300].forEach((d, k) => { const dd = Math.min(d, max - (2 - k) * 40); if (dd > 30) m.strikes.push({ x: p.x + Math.cos(p.yaw) * dd, y: p.y + Math.sin(p.yaw) * dd, t: 60 + k * 12, owner: p.id, team: p.team }); });
  } else if (p.op === 'volt') p.fx.rush = 480;
  else if (p.op === 'echo') { for (const o of m.players) if (o.alive && o.team !== p.team) o.fx.reveal = Math.max(o.fx.reveal || 0, 360); }
  else if (p.op === 'haven') m.zones.push({ k: 'dome', x: p.x, y: p.y, r: 70, t: 600, team: p.team, owner: p.id });
  else if (p.op === 'warden') m.zones.push({ k: 'lock', x: p.x, y: p.y, r: 140, t: 540, team: p.team, owner: p.id });
  m.events.push(['ab', p.id, 1, p.op]);
}
// every tick: cooldowns, charge, effects, zones, barrage blasts
function stepAbilities(m) {
  const fight = m.phase === 'fight';
  for (const p of m.players) {
    const op = OPS[p.op]; if (!op) continue;
    if (fight && p.tac > 0) p.tac--;
    if (fight && p.alive && p.ult < op.ult.charge * 60) p.ult++;
    for (const k in p.fx) if (p.fx[k] > 0) p.fx[k]--;
  }
  m.zones = m.zones.filter(z => --z.t > 0);
  for (const z of m.zones) if (z.k === 'lock') for (const o of m.players) {
    if (o.alive && o.team !== z.team && Math.hypot(o.x - z.x, o.y - z.y) < z.r) { o.fx.slow = 6; o.fx.reveal = Math.max(o.fx.reveal || 0, 6); }
  }
  for (const p of m.players) p.spdMul = (p.fx.rush > 0 ? 1.35 : 1) * (p.fx.slow > 0 ? 0.6 : 1);
  for (const s of m.strikes) if (--s.t <= 0) {
    explode(m, { x: s.x, y: s.y, z: supportAt(s.x, s.y, 200) + 4, owner: s.owner, team: s.team }, 62, 75, DMG_SRC.frag);
    s.done = true;
  }
  m.strikes = m.strikes.filter(s => !s.done);
}

function switchWeapon(p, w) {
  if (!WEAPONS[w] || w === p.weapon) return;
  p.weapon = w; p.switchT = SWITCH_TICKS; p.burst = 0; p.onT = 0;
}

function stepMatch(m) {
  m.tick++;
  curBroken = m.broken || null;   // collision for this match
  if (!m.zones) m.zones = []; if (!m.strikes) m.strikes = [];
  curZones = m.zones;
  stepAbilities(m);
  if (m.phase === 'countdown') { if (--m.phaseT <= 0) m.phase = 'fight'; }
  else if (m.phase === 'roundEnd') {
    if (--m.phaseT <= 0) {
      if (m.score.A >= ROUNDS_TO_WIN || m.score.B >= ROUNDS_TO_WIN) return endMatch(m, m.score.A > m.score.B ? 'A' : 'B', 'score');
      resetRound(m);
    }
  }

  for (const p of m.players) {
    if (!p.alive) {
      if (m.practice && p.brain.dummy && --p.respawnT <= 0) placeDummy(m, p);
      else if (m.mode === 'extraction' && p.team !== m.attack && m.phase === 'fight' && p.respawnT > 0 && --p.respawnT <= 0) respawnDefender(m, p);
      continue;
    }
    let mx, my, run, crouch, runOk, wants = [];
    if (p.bot) {
      const inp = p.brain.dummy ? dummyThink(m, p) : botThink(m, p);
      mx = inp.mx; my = inp.my; run = !!inp.run; crouch = !!inp.crouch; runOk = true; if (inp.throw) wants = [inp.throw];
      if (inp.weapon) switchWeapon(p, inp.weapon);
      if (!p.brain.dummy) botAim(p, inp.yaw, inp.pitch);
    } else {
      // forward/strafe relative to where the player is looking
      const i = p.input, c = Math.cos(i.yaw), s = Math.sin(i.yaw);
      p.yaw = i.yaw; p.pitch = i.pitch;
      mx = c * i.f - s * i.s; my = s * i.f + c * i.s;
      run = i.run; crouch = i.crouch; runOk = i.f > 0.3;
      p.ads = !!i.ads && p.stance === 'crouch'; p.lean = p.ads ? i.lean || 0 : 0;   // aim only while crouched
      if (i.weapon) switchWeapon(p, i.weapon);
      wants = p.throws.splice(0);
    }
    stepMovement(p, mx, my, run, crouch, runOk, m.phase !== 'countdown', !!p.ads);
    // Trust the player's own position when it's within a few steps of ours and not inside a wall, so
    // peeking a corner counts the moment they see around it (instead of a moment later on the server).
    if (p.claim) {
      const [cx, cy] = p.claim; p.claim = null;
      if (m.phase !== 'countdown' && !p.rap && !p.onLadder && Math.hypot(cx - p.x, cy - p.y) < P.claimMax && !blockedAt(cx, cy, P.r, p.z || 0) && supportAt(cx, cy, p.z || 0) >= (p.z || 0) - 2) { p.x = cx; p.y = cy; }
    }
    if (m.phase === 'fight') for (const w of wants) throwGrenade(m, p, w);
    if (p.bot) { if (p.brain.useTac) useTac(m, p, mx, my); if (p.brain.useUlt) useUlt(m, p); p.brain.useTac = p.brain.useUlt = false; }
    if (p.wantTac) { p.wantTac = false; if (m.phase === 'fight') useTac(m, p, mx, my); }
    if (p.wantUlt) { p.wantUlt = false; if (m.phase === 'fight') useUlt(m, p); }

    if (p.cool > 0) p.cool--;
    if (++p.sinceShot > P.recoilReset) p.burst = 0;
    // Auto-fire: only while the crosshair is on a visible enemy. Shots are instant (hitscan),
    // so the challenge is keeping the crosshair on them while recoil kicks it up.
    const ready = (!p.bot || (!p.brain.dummy && p.brain.seen > p.brain.react)) && !p.running;   // bots react after a moment; dummies never shoot; nobody fires while running
    const tgt = m.phase === 'fight' && ready ? aimTarget(m, p) : null;
    // no enemy under the crosshair? a green panel close enough counts as a target too (shoot it down)
    let pan = null;
    if (!tgt && m.phase === 'fight' && ready && !p.bot && m.panelHp && (p.z || 0) < 10) {
      const [ex2, ey2] = eyePos(p.x, p.y, p.yaw, p.lean || 0);
      pan = panelUnder(ex2, ey2, STANCES[p.stance].eye, p.yaw, p.pitch);
    }
    p.onT = tgt || pan ? (p.onT || 0) + 1 : 0;                // how long the crosshair has been on someone
    if (p.switchT > 0) p.switchT--;
    if (pan && p.cool <= 0 && p.switchT <= 0 && p.onT > P.fireDelay) {
      const wn = p.weapon || 'rifle', W = WEAPONS[wn];
      p.cool = W.cooldown * (p.fx.over > 0 ? 0.62 : 1); p.sinceShot = 0;
      const [ox, oy] = eyePos(p.x, p.y, p.yaw, p.lean || 0);
      const ex = Math.round(ox + Math.cos(p.yaw) * pan.t), ey = Math.round(oy + Math.sin(p.yaw) * pan.t);
      m.events.push(['s', p.id, p.burst, ex, ey, Math.round(pan.h), W.code]);
      m.events.push(['ph', pan.i, ex, ey, Math.round(pan.h)]);
      damagePanel(m, pan.i, weaponDamage(wn, pan.t, false));
      p.burst++;
    }
    const hit = tgt && p.cool <= 0 && p.switchT <= 0 && (p.bot || p.onT > P.fireDelay) ? tgt : null;
    if (hit) {
      const wn = p.weapon || 'rifle', W = WEAPONS[wn];
      p.cool = W.cooldown * (p.fx.over > 0 ? 0.62 : 1); p.sinceShot = 0;
      const o = hit.c, d = hit.along;
      const [ox, oy] = eyePos(p.x, p.y, p.yaw, p.lean || 0);
      const ex = Math.round(ox + Math.cos(p.yaw) * d), ey = Math.round(oy + Math.sin(p.yaw) * d);
      const ez = Math.round(clamp(hit.h, (o.z || 0) + 2, (o.z || 0) + STANCES[o.stance].height));
      m.events.push(['s', p.id, p.burst, ex, ey, ez, W.code]);
      damage(m, o, weaponDamage(wn, d, hit.head), p, wn === 'shotgun' ? DMG_SRC.shotgun : DMG_SRC.gun, hit.head, ex, ey, ez);
      // Players apply this same kick on their own computer when they get the 's' event
      if (p.bot) { const k = weaponKick(wn, p.burst); p.pitch = Math.min(P.pitchMax, p.pitch + k.pitch); p.yaw = wrapAngle(p.yaw + k.yaw); }
      p.burst++;
    }
  }
  stepGrenades(m);

  if (m.phase === 'fight' && m.mode === 'extraction') stepExtraction(m);
  if (m.phase === 'fight' && m.mode === 'extraction') {
    if (!m.players.some(p => p.team === m.attack && p.alive)) endRound(m, m.attack === 'A' ? 'B' : 'A', 'wiped');
  } else if (m.phase === 'fight' && !m.practice) {
    const aliveA = m.players.some(p => p.team === 'A' && p.alive), aliveB = m.players.some(p => p.team === 'B' && p.alive);
    if (!aliveA || !aliveB) endRound(m, aliveA ? 'A' : aliveB ? 'B' : null, 'wiped');
  }

  if (m.tick % SEND_EVERY === 0) {
    const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
    const g = m.gem;
    const state = { t: 'state', tick: m.tick, phase: m.phase, phaseT: m.phaseT, round: m.round, score: m.score, roundWinner: m.roundWinner,
      roundReason: m.roundReason || null,
      broken: m.broken ? [...m.broken] : [], panels: m.panelHp ? [...m.panelHp].filter(([i]) => !m.broken.has(i)) : [],
      ex: g ? { attack: m.attack, gem: [{ home: 0, carried: 1, dropped: 2 }[g.state], Math.round(g.x), Math.round(g.y), g.carrier, Math.round(g.prog / EXTRACT.extractTicks * 100)],
        time: Math.max(0, Math.ceil(m.timeLeft / 60)), cards: (m.cards || []).map(c => [c.id, r1(c.x), r1(c.y), r1(c.z), c.carrier]) } : null,
      players: m.players.map(p => [p.id, r1(p.x), r1(p.y), p.hp, p.alive ? 1 : 0, r3(p.yaw), r3(p.pitch), p.kills,
        STANCE_CODE[p.stance] + (p.running ? 4 : 0) + (p.ads ? 8 : 0) + (p.lean < 0 ? 16 : p.lean > 0 ? 32 : 0) + (p.rap ? 64 : 0) + (p.onLadder ? 128 : 0), Math.ceil(p.cd.boom / 6), Math.ceil(p.cd.frag / 6), Math.ceil(p.cd.therm / 6), WEAPONS[p.weapon || 'rifle'].code + (p.switchT > 0 ? 2 : 0), r1(p.z || 0), p.alive ? 0 : Math.ceil((p.respawnT || 0) / 60), Math.ceil((p.tac || 0) / 60),
        OPS[p.op] ? Math.floor(p.ult / (OPS[p.op].ult.charge * 60) * 100) : 0,
        (p.fx.over > 0 ? 1 : 0) + (p.fx.rush > 0 ? 2 : 0) + (p.fx.reveal > 0 ? 4 : 0) + (p.fx.slow > 0 ? 8 : 0)]),
      zones: (m.zones || []).map(z => [z.k, r1(z.x), r1(z.y), z.r, Math.ceil(z.t / 60), z.team]),
      proj: m.projectiles.map(pr => [pr.id, KIND_CODE[pr.kind], r1(pr.x), r1(pr.y), r1(pr.z), pr.team]),
      fires: m.fires.map(f => [f.id, Math.round(f.x1), Math.round(f.y1), Math.round(f.x2), Math.round(f.y2), f.t, f.team, Math.round(f.z || 0)]),
      ev: m.events };
    m.events = [];
    for (const p of m.players) if (p.client) send(p.client, state);
  }
}

// ---------- Public API ----------
// connect(sendFn) registers a client. sendFn receives plain message objects.
// The returned handle takes the client's messages via receive(msg) and close().
function connect(sendFn) {
  const client = { send: sendFn, name: 'Player', queued: null, match: null, player: null, pt: null, look: cleanLook(null) };
  const setProfile = msg => {
    if (msg.name != null) client.name = String(msg.name || 'Player').replace(/[^\w \-]/g, '').slice(0, 12) || 'Player';
    if (msg.look) client.look = cleanLook(msg.look);
    if (msg.op && OPS[msg.op]) client.op = msg.op;
  };
  return {
    receive(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.name != null || msg.look) setProfile(msg);
      if (msg.t === 'queue' && MODES[msg.mode] && !client.match) {
        const pt = client.pt;
        if (pt && pt.leader !== client) { send(client, { t: 'party_err', text: 'Only the party leader can start a match' }); return; }
        const group = pt ? pt.members.filter(c => !c.match) : [client];
        const at = Date.now();
        for (const c of group) {
          dequeue(c);
          c.queued = msg.mode; c.queuedAt = at;
          c.party = pt ? pt.code : String(msg.party || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);   // same code = same team
          queues[msg.mode].push(c);
          if (c !== client) send(c, { t: 'party_queue', mode: msg.mode });
        }
        matchmake();
      } else if (msg.t === 'cancel') {
        if (client.pt) for (const c of client.pt.members) { if (c.queued) { dequeue(c); if (c !== client) send(c, { t: 'party_cancel' }); } }
        else dequeue(client);
      }
      else if (msg.t === 'input' || msg.t === 'throw') handlePlay(client, msg);
      else if (msg.t === 'leave') playerLeft(client);
      else if (msg.t === 'party_create') {
        partyLeave(client);
        const pt = { code: newPartyCode(), leader: client, members: [client] };
        parties.set(pt.code, pt); client.pt = pt; partySync(pt);
      } else if (msg.t === 'party_join') {
        const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        const pt = parties.get(code);
        if (!pt) send(client, { t: 'party_err', text: 'No party with code ' + (code || '?') });
        else if (pt === client.pt) partySync(pt);
        else if (pt.members.length >= PARTY_MAX) send(client, { t: 'party_err', text: 'That party is full (4 players)' });
        else { partyLeave(client); pt.members.push(client); client.pt = pt; partySync(pt); }
      } else if (msg.t === 'party_leave') { if (client.queued) dequeue(client); partyLeave(client); }
      else if (msg.t === 'hello' && client.pt) partySync(client.pt);
    },
    close() { dequeue(client); playerLeft(client); partyLeave(client); },
  };
}

function tick() { for (const m of matches) stepMatch(m); }

// Runs fn at a true 60 ticks per second. Timers are coarse on some systems (about 31 ms on Windows),
// so this checks often and catches up on however many ticks are due.
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function runClock(fn) {
  let last = now(), acc = 0;
  return setInterval(() => {
    const t = now(); acc += t - last; last = t;
    if (acc > TICK * 10) acc = TICK * 10;   // after a long stall, don't fast-forward the whole gap
    while (acc >= TICK) { fn(); acc -= TICK; }
  }, 4);
}

// start() drives matchmaking + simulation with timers (used by both builds)
function start(opts = {}) {
  if (opts.botFillMs != null) BOT_FILL_MS = opts.botFillMs;
  if (opts.log) log = opts.log;
  setInterval(matchmake, 250);
  runClock(tick);
}

// identifies the map, so a client only plays on a server with the same one
const MAP_ID = MAP.w + 'x' + MAP.h + '-' + MAP.walls.length + '-' + UP.ladders.length;
return { OPS, OP_LIST, setZones, startDash, MAP_ID, slabRects, onSlab, ladderAt, rappelSpot, connect, start, tick, matchmake, createPractice, MAP, P, LOOK_SIZES, STANCES, KINDS, recoilKick, blocked, lineOfSight, stepMovement, castRay, predictThrow, segmentClear, eyePos, setBroken, panelUnder, EXTRACT, MODES, clear3, supportAt, blockedAt, _matches: matches, WEAPONS, WEAPON_BY_CODE, weaponDamage, weaponKick, get botFillMs() { return BOT_FILL_MS; } };
});
