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
const MAP = {
  w: 640, h: 480,
  // [x, y, w, h, tall] — tall (1) = full-height room wall, otherwise a crate (both block shots and sight)
  walls: [
    // outer border
    [0, 0, 640, 16], [0, 464, 640, 16], [0, 0, 16, 480], [624, 0, 16, 480],
    // blue spawn room (left): wall at x 144-160, doorways at y 96-150 and 330-384
    [144, 16, 16, 80, 1], [144, 150, 16, 180, 1], [144, 384, 16, 80, 1],
    // red spawn room (right): wall at x 480-496, doorways at y 150-204 and 276-330 (offset from blue's)
    [480, 16, 16, 134, 1], [480, 204, 16, 72, 1], [480, 330, 16, 134, 1],
    // short walls in front of each doorway, so doorways never look straight at each other
    [200, 84, 16, 80, 1], [200, 316, 16, 80, 1], [424, 138, 16, 80, 1], [424, 262, 16, 80, 1],
    // middle: walls that split it into smaller rooms
    [272, 16, 16, 96, 1], [352, 368, 16, 96, 1], [256, 232, 128, 16, 1],
    // cover
    [304, 150, 32, 24], [304, 306, 32, 24], [236, 196, 24, 24], [380, 260, 24, 24],
    [62, 222, 34, 36], [544, 222, 34, 36],
  ],
  // spawns sit in the corners of each spawn room, facing its nearest doorway: [x, y, yaw].
  // No spawn can see into the other team's room.
  spawns: { A: [[60, 56, 0.64], [60, 424, -0.64]], B: [[580, 424, -2.26], [580, 56, 2.26]] },
};

const P = {
  // sizes in arena pixels (24 px = 1 world unit). Players are cylinders r wide and height tall.
  r: 12, height: 42, eye: 38, hp: 100, cooldown: 7, bulletR: 3, dmg: 20,
  // Headshots: a hit in the top headH pixels of a body takes 3 of 5 health (body hits take 1 of 5)
  headH: 7, headR: 6, headDmg: 60,   // the head is narrower than the body (headR vs r) and only the top headH px
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
};
// Body size per stance: eye height and how tall the hittable body is (head = top headH px)
// The eye sits at chin level, just under the head, so looking straight ahead lines up a body shot:
// you have to aim up a little (more the closer they are) to land a headshot.
const STANCES = { stand: { eye: 33, height: 42 }, crouch: { eye: 21, height: 29 }, slide: { eye: 14, height: 22 } };
const STANCE_CODE = { stand: 0, crouch: 1, slide: 2 };

// Weapons. Key 1 = rifle, key 2 = shotgun. Both auto-fire when the crosshair is on an enemy.
// Damage is in hp (5 health = 100 hp, so 20 hp = 1 health).
const WEAPONS = {
  // rifle: 1 health per body hit, 3 per headshot, steady fire, recoil pattern from recoilKick()
  rifle: { code: 0, cooldown: 7, body: 20, head: 60, spread: 2, range: Infinity },
  // shotgun: up close (within `close` px) 3 health to the body, 4 to the head; damage falls off to
  // `minFactor` by `far`, and it won't fire beyond `range`. Wide spread (forgiving aim), pumps between
  // shots, one big kick per shot.
  shotgun: { code: 1, cooldown: 54, body: 60, head: 80, spread: 7, close: 60, far: 220, minFactor: 0.25, range: 260,
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
const blocked = (x, y, r) => MAP.walls.some(w => rectHitsCircle(w, x, y, r));

function lineOfSight(ax, ay, bx, by) {
  const d = Math.hypot(bx - ax, by - ay), steps = Math.ceil(d / 6);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (blocked(ax + (bx - ax) * t, ay + (by - ay) * t, P.bulletR)) return false;
  }
  return true;
}

// Navigation grid for bots (16px cells, cells a player can't stand in are blocked)
const CELL = 16, GW = MAP.w / CELL, GH = MAP.h / CELL;
const navBlocked = Array.from({ length: GW * GH }, (_, i) =>
  blocked((i % GW) * CELL + CELL / 2, Math.floor(i / GW) * CELL + CELL / 2, P.r + 2));
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
const MODES = { '1v1': 2, '2v2': 4 };
const queues = { '1v1': [], '2v2': [] };
// Bots play under ordinary-looking gamer tags. Whether a player is a bot never leaves the server.
const BOT_NAMES = ['VEXX', 'NOVA_7', 'ROOKIE99', 'KITE', 'JOLTZ', 'PIKE', 'ECH0', 'FLINTY', 'MAKO', 'ZEDD', 'TURBO_T', 'SKYE',
  'BLITZ', 'COBRA_K', 'DUSTY', 'GHOSTY', 'LYNX', 'MOJO', 'PIXEL', 'RAZZ', 'SNIPZ', 'TANK_42', 'VIPER', 'WISP'];
let nextId = 1;
const send = (client, msg) => { if (client && client.send) client.send(msg); };

function dequeue(client) {
  for (const m in queues) queues[m] = queues[m].filter(c => c !== client);
  client.queued = null;
}

function matchmake() {
  const now = Date.now();
  for (const mode in queues) {
    const q = queues[mode], size = MODES[mode];
    while (q.length >= size) startMatch(mode, q.splice(0, size));
    if (q.length && now - q[0].queuedAt >= BOT_FILL_MS) startMatch(mode, q.splice(0, size));
    for (const c of q) send(c, { t: 'queued', mode, waited: now - c.queuedAt, inQueue: q.length });
  }
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
const publicPlayers = m => m.players.map(o => ({ id: o.id, name: o.name, team: o.team, look: o.look }));

function makePlayer(team, name, client, look) {
  return { id: nextId++, team, name, client, bot: !client, look: cleanLook(look), x: 0, y: 0, hp: P.hp, alive: true,
    input: { f: 0, s: 0, yaw: team === 'A' ? 0 : Math.PI, pitch: 0, run: false, crouch: false }, yaw: 0, pitch: 0, cool: 0, kills: 0, burst: 0, sinceShot: 99,
    stance: 'stand', running: false, slideT: 0, slideCd: 0, slideX: 0, slideY: 0, cd: { boom: 0, frag: 0, therm: 0 }, throws: [], respawnT: 0,
    weapon: 'rifle', switchT: 0,
    brain: { path: [], repath: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 0,
      skill: 0.75 + Math.random() * 0.5, wobble: [0, 0], wobbleT: 0, seen: 0, react: 14 + Math.random() * 16 } };
}

function startMatch(mode, clients) {
  const size = MODES[mode];
  const used = new Set(clients.map(c => c.name.toUpperCase()));
  const botName = () => { let n, tries = 0; do n = BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0]; while (used.has(n) && ++tries < 50); used.add(n); return n; };
  const players = [];
  for (let i = 0; i < size; i++) {
    const team = i % 2 === 0 ? 'A' : 'B'; // humans alternate teams so they face each other first
    const c = clients[i];
    players.push(makePlayer(team, c ? c.name : botName(), c || null, c ? c.look : null));
  }
  const match = { mode, players, events: [], projectiles: [], fires: [], nextProj: 1, score: { A: 0, B: 0 }, round: 0, phase: 'countdown', phaseT: 120, tick: 0, over: false };
  matches.add(match);
  for (const p of players) if (p.client) { p.client.queued = null; p.client.match = match; p.client.player = p; }
  resetRound(match);
  for (const p of players) if (p.client) send(p.client, { t: 'match', mode, you: p.id, map: MAP, cfg: P, roundsToWin: ROUNDS_TO_WIN,
    players: publicPlayers(match) });
  log(`[match] ${mode}: ${players.map(p => p.name + (p.bot ? ' (bot)' : '')).join(', ')}`);
}

function resetRound(m) {
  m.round++; m.projectiles = []; m.fires = []; m.phase = 'countdown'; m.phaseT = 180; // 3 s: "3, 2, 1, FIGHT"
  const idx = { A: 0, B: 0 };
  for (const p of m.players) {
    const [x, y, yaw] = MAP.spawns[p.team][idx[p.team]++];   // facing the spawn room's doorway
    Object.assign(p, { x, y, hp: P.hp, alive: true, cool: 0, yaw, pitch: 0, burst: 0, sinceShot: 99,
      stance: 'stand', running: false, slideT: 0, slideCd: 0, cd: { boom: 0, frag: 0, therm: 0 }, throws: [], switchT: 0, cool: 0 });
    p.input = { f: 0, s: 0, yaw, pitch: 0, run: false, crouch: false };
    p.brain.path = []; p.brain.repath = 0;
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
  if (!canMove) return;
  let dx, dy, spd;
  if (p.stance === 'slide') {
    const k = p.slideT / P.slideTicks;               // slows down over the slide
    spd = P.crouchSpeed + (P.slideSpeed - P.crouchSpeed) * k;
    dx = p.slideX; dy = p.slideY;
  } else {
    if (!len) return;
    spd = (p.running ? P.run : p.stance === 'crouch' ? P.crouchSpeed : P.walk) * (ads ? P.adsSpeed : 1);
    dx = mx / len; dy = my / len;
  }
  const ox = p.x, oy = p.y;
  if (!blocked(p.x + dx * spd, p.y, P.r)) p.x += dx * spd;
  if (!blocked(p.x, p.y + dy * spd, P.r)) p.y += dy * spd;
  if (p.stance === 'slide' && p.x === ox && p.y === oy) p.slideT = Math.min(p.slideT, 1);   // slid into a wall
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
  for (const [wx, wy, w, h] of MAP.walls) {
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-dx, x1 - wx], [dx, wx + w - x1], [-dy, y1 - wy], [dy, wy + h - y1]]) {
      if (p === 0) { if (q < 0) { t0 = 2; break; } }
      else { const r = q / p; if (p < 0) { if (r > t1) { t0 = 2; break; } if (r > t0) t0 = r; } else { if (r < t0) { t0 = 2; break; } if (r < t1) t1 = r; } }
    }
    if (t0 <= t1) return false;
  }
  return true;
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
    const height = STANCES[c.stance || 'stand'].height, h = eye + along * tp;
    if (h < -spread || h > height + Math.max(0, spread - P.lockR)) continue;
    if (h > height - P.headH && perp > P.headR + Math.max(0, spread - P.lockR)) continue;   // beside the head: a miss (it's narrower than the shoulders)
    // the shot path is clear from the shooter to where the ray meets their body (not centre to centre, so a
    // player half behind a corner can still be hit on the part you can see)
    const front = along - Math.sqrt(Math.max(0, P.r * P.r - perp * perp));
    if (segmentClear(x, y, x + dx * front, y + dy * front)) best = { c, along, h: Math.min(h, height), head: h >= height - P.headH };
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
  const hit = castRay(ex, ey, STANCES[p.stance].eye, p.yaw, p.pitch, m.players.filter(o => o.alive && o.team !== p.team), w.spread);
  return hit && hit.along <= w.range ? hit : null;   // the shotgun doesn't fire at targets out of its range
}

// Bot: turns toward a target view at a limited speed, so it has to fight recoil like a player
function botAim(b, yaw, pitch) {
  const turn = P.botTurn * b.brain.skill;
  b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(yaw - b.yaw), -turn, turn));
  b.pitch = clamp(b.pitch + clamp(pitch - b.pitch, -turn * 0.7, turn * 0.7), -P.pitchMax, P.pitchMax);
}

function botThink(m, b) {
  const br = b.brain, inp = { mx: 0, my: 0, yaw: b.yaw, pitch: 0 };
  const foes = m.players.filter(o => o.alive && o.team !== b.team);
  if (!foes.length) return inp;
  const t = foes.reduce((a, o) => (Math.hypot(o.x - b.x, o.y - b.y) < Math.hypot(a.x - b.x, a.y - b.y) ? o : a));
  const dx = t.x - b.x, dy = t.y - b.y, dist = Math.hypot(dx, dy) || 1;

  // Aim wobble: bots aren't perfect
  if (--br.wobbleT <= 0) { br.wobble = [(Math.random() - 0.5) * 0.09 / br.skill, (Math.random() - 0.5) * 0.06 / br.skill]; br.wobbleT = 15 + Math.random() * 25; }

  if (lineOfSight(b.x, b.y, t.x, t.y)) {
    br.path = []; br.seen++;   // reaction time: counts up while the target is in view
    inp.yaw = Math.atan2(dy, dx) + br.wobble[0];
    inp.pitch = Math.atan2(STANCES[t.stance].height * 0.6 - STANCES[b.stance].eye, dist) + br.wobble[1];
    // Strafe sideways, keep a comfortable distance
    if (--br.strafeT <= 0) { br.strafe *= -1; br.strafeT = 25 + Math.random() * 45; }
    let mx = -dy / dist * br.strafe, my = dx / dist * br.strafe;
    if (dist < 120) { mx -= dx / dist; my -= dy / dist; } else if (dist > 300) { mx += dx / dist; my += dy / dist; }
    inp.mx = mx; inp.my = my;
    if (b.weapon !== 'shotgun' && dist < 100) inp.weapon = 'shotgun';
    else if (b.weapon === 'shotgun' && dist > 170) inp.weapon = 'rifle';
    // grenades: often an opener while they line up their first shot, sometimes mid-fight
    if (br.seen > 6) {
      const r = Math.random() / br.skill, opener = br.seen < br.react + 10;
      const k = opener ? 1 : 0.25;
      if (!b.cd.frag && dist > 110 && dist < 380 && r < 0.02 * k) inp.throw = 'frag';
      else if (!b.cd.boom && dist < 320 && r < 0.04 * k) inp.throw = 'boom';
      else if (!b.cd.therm && dist > 80 && dist < 230 && r < 0.02 * k) inp.throw = 'therm';
      if (inp.throw) br.throwDist = dist;
    }
  } else {
    br.seen = 0;
    if (--br.repath <= 0 || !br.path.length) { br.path = findPath(b.x, b.y, t.x, t.y); br.repath = 20; }
    while (br.path.length && Math.hypot(br.path[0][0] - b.x, br.path[0][1] - b.y) < 6) br.path.shift();
    if (br.path.length) {
      inp.mx = br.path[0][0] - b.x; inp.my = br.path[0][1] - b.y; inp.run = true;
      // look a little ahead along the route, ready for the next corner
      const ahead = br.path[Math.min(br.path.length - 1, 4)];
      inp.yaw = Math.atan2(ahead[1] - b.y, ahead[0] - b.x);
    }
  }
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
  if (blocked(x, y, 3)) { x = p.x; y = p.y; }
  const pr = { id: m.nextProj++, kind, owner: p.id, team: p.team, x, y, z: STANCES[p.stance].eye - 4, t: 0, yaw: p.yaw };
  if (kind === 'boom') {
    Object.assign(pr, { z: g.z, dir: p.yaw, back: false, vx: fx * g.speed, vy: fy * g.speed, vz: 0 });
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
    if (Math.hypot(o.x - pr.x, o.y - pr.y) < P.r + pad && pr.z <= STANCES[o.stance].height + 2) return o;
  }
  return null;
}

// one place that applies damage and reports hits / knockouts (owner may be null)
function damage(m, o, amount, owner, src, head, x, y, z) {
  if (!o.alive) return;
  o.hp -= amount;
  m.events.push(['h', o.id, Math.round(x), Math.round(y), Math.round(z), owner ? owner.id : 0, head ? 1 : 0, src]);
  if (o.hp <= 0) {
    o.alive = false; o.hp = 0;
    if (owner) owner.kills++;
    m.events.push(['k', owner ? owner.id : 0, o.id, head ? 1 : 0, src]);
    if (m.practice) o.respawnT = 84;
  }
}

function explode(m, pr, radius, dmg, src) {
  m.events.push(['x', Math.round(pr.x), Math.round(pr.y), Math.round(pr.z), src, radius]);
  const owner = m.players.find(o => o.id === pr.owner);
  for (const o of m.players) {
    if (!o.alive || o.team === pr.team) continue;
    const d = Math.max(0, Math.hypot(o.x - pr.x, o.y - pr.y) - P.r);
    if (d > radius || !lineOfSight(pr.x, pr.y, o.x, o.y)) continue;
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
  if (blocked(nx, ny, 3)) { pr.back = true; pr.dir += Math.PI; return; }   // bounce off walls and head home
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
  if (blocked(nx, pr.y, 3)) { pr.vx = -pr.vx * g.bounce; nx = pr.x; hitWall = true; }
  if (blocked(nx, ny, 3)) { pr.vy = -pr.vy * g.bounce; ny = pr.y; hitWall = true; }
  pr.x = nx; pr.y = ny; pr.z += pr.vz;
  let landed = false;
  if (pr.z <= 0) {
    landed = pr.vz < -0.6;
    pr.z = 0; pr.vz = -pr.vz * g.ground; if (pr.vz < 1) pr.vz = 0;
    pr.vx *= g.friction; pr.vy *= g.friction;
  }
  const enemy = touchingEnemy(m, pr, 4);
  if (pr.kind === 'frag') {
    if (enemy || pr.t >= g.fuse) { explode(m, pr, g.radius, g.dmg, DMG_SRC.frag); pr.dead = true; }
    else if ((hitWall || landed) && Math.hypot(pr.vx, pr.vy, pr.vz) > 1.2) m.events.push(['b', pr.id]);
  } else if (enemy || hitWall || pr.z <= 0) { ignite(m, pr); pr.dead = true; }
  if (pr.t > 600) pr.dead = true;
}

// thermite: a wall of fire across the direction it was thrown
function ignite(m, pr) {
  const g = GREN.therm, px = -Math.sin(pr.yaw), py = Math.cos(pr.yaw);
  m.fires.push({ id: m.nextProj++, x1: pr.x - px * g.half, y1: pr.y - py * g.half, x2: pr.x + px * g.half, y2: pr.y + py * g.half,
    t: g.burn, owner: pr.owner, team: pr.team });
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
      if (o.alive && o.team !== f.team && distToSegment(o.x, o.y, f) < g.width + P.r) damage(m, o, g.dmg, owner, DMG_SRC.therm, false, o.x, o.y, 8);
    }
  }
  m.fires = m.fires.filter(f => !f.dead);
}

// Where would a grenade go? Runs the real grenade code in a sandbox with no enemies (so it shows the full
// path) and returns { points: [[x, y, z], ...], end: [x, y, z], fire: [x1, y1, x2, y2] | null, back: bool }.
function predictThrow(kind, x, y, stance, yaw, pitch) {
  const me = { id: -1, team: 'P', x, y, stance, yaw, pitch, alive: true, bot: false, cd: { boom: 0, frag: 0, therm: 0 } };
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
    x = 170 + Math.random() * 440; y = 30 + Math.random() * 420;
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
function createPractice(sendFn, name, look) {
  const client = { send: sendFn, name: String(name || 'PLAYER').slice(0, 12), look, match: null, player: null };
  const me = makePlayer('A', client.name, client, look);
  const players = [me];
  for (let i = 0; i < 6; i++) { const d = makePlayer('B', 'TARGET', null, DUMMY_LOOK); d.brain.dummy = true; players.push(d); }
  const m = { mode: 'practice', practice: true, players, events: [], projectiles: [], fires: [], nextProj: 1,
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
    }
    else if (KIND_CODE[msg.g] != null && p.throws.length < 3) { p.input.yaw = yaw; p.input.pitch = pitch; p.throws.push(msg.g); }   // queued, so two quick throws both happen
  }
}

function switchWeapon(p, w) {
  if (!WEAPONS[w] || w === p.weapon) return;
  p.weapon = w; p.switchT = SWITCH_TICKS; p.burst = 0; p.onT = 0;
}

function stepMatch(m) {
  m.tick++;
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
      if (m.phase !== 'countdown' && Math.hypot(cx - p.x, cy - p.y) < P.claimMax && !blocked(cx, cy, P.r)) { p.x = cx; p.y = cy; }
    }
    if (m.phase === 'fight') for (const w of wants) throwGrenade(m, p, w);

    if (p.cool > 0) p.cool--;
    if (++p.sinceShot > P.recoilReset) p.burst = 0;
    // Auto-fire: only while the crosshair is on a visible enemy. Shots are instant (hitscan),
    // so the challenge is keeping the crosshair on them while recoil kicks it up.
    const ready = (!p.bot || (!p.brain.dummy && p.brain.seen > p.brain.react)) && !p.running;   // bots react after a moment; dummies never shoot; nobody fires while running
    const tgt = m.phase === 'fight' && ready ? aimTarget(m, p) : null;
    p.onT = tgt ? (p.onT || 0) + 1 : 0;                       // how long the crosshair has been on someone
    if (p.switchT > 0) p.switchT--;
    const hit = tgt && p.cool <= 0 && p.switchT <= 0 && (p.bot || p.onT > P.fireDelay) ? tgt : null;
    if (hit) {
      const wn = p.weapon || 'rifle', W = WEAPONS[wn];
      p.cool = W.cooldown; p.sinceShot = 0;
      const o = hit.c, d = hit.along;
      const [ox, oy] = eyePos(p.x, p.y, p.yaw, p.lean || 0);
      const ex = Math.round(ox + Math.cos(p.yaw) * d), ey = Math.round(oy + Math.sin(p.yaw) * d);
      const ez = Math.round(clamp(hit.h, 2, STANCES[o.stance].height));
      m.events.push(['s', p.id, p.burst, ex, ey, ez, W.code]);
      damage(m, o, weaponDamage(wn, d, hit.head), p, wn === 'shotgun' ? DMG_SRC.shotgun : DMG_SRC.gun, hit.head, ex, ey, ez);
      // Players apply this same kick on their own computer when they get the 's' event
      if (p.bot) { const k = weaponKick(wn, p.burst); p.pitch = Math.min(P.pitchMax, p.pitch + k.pitch); p.yaw = wrapAngle(p.yaw + k.yaw); }
      p.burst++;
    }
  }
  stepGrenades(m);

  if (m.phase === 'fight' && !m.practice) {
    const aliveA = m.players.some(p => p.team === 'A' && p.alive), aliveB = m.players.some(p => p.team === 'B' && p.alive);
    if (!aliveA || !aliveB) {
      if (aliveA) m.score.A++; else if (aliveB) m.score.B++;
      m.phase = 'roundEnd'; m.phaseT = 150; m.roundWinner = aliveA ? 'A' : aliveB ? 'B' : null;
    }
  }

  if (m.tick % SEND_EVERY === 0) {
    const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
    const state = { t: 'state', tick: m.tick, phase: m.phase, phaseT: m.phaseT, round: m.round, score: m.score, roundWinner: m.roundWinner,
      players: m.players.map(p => [p.id, r1(p.x), r1(p.y), p.hp, p.alive ? 1 : 0, r3(p.yaw), r3(p.pitch), p.kills,
        STANCE_CODE[p.stance] + (p.running ? 4 : 0) + (p.ads ? 8 : 0) + (p.lean < 0 ? 16 : p.lean > 0 ? 32 : 0), Math.ceil(p.cd.boom / 6), Math.ceil(p.cd.frag / 6), Math.ceil(p.cd.therm / 6), WEAPONS[p.weapon || 'rifle'].code + (p.switchT > 0 ? 2 : 0)]),
      proj: m.projectiles.map(pr => [pr.id, KIND_CODE[pr.kind], r1(pr.x), r1(pr.y), r1(pr.z), pr.team]),
      fires: m.fires.map(f => [f.id, Math.round(f.x1), Math.round(f.y1), Math.round(f.x2), Math.round(f.y2), f.t, f.team]),
      ev: m.events };
    m.events = [];
    for (const p of m.players) if (p.client) send(p.client, state);
  }
}

// ---------- Public API ----------
// connect(sendFn) registers a client. sendFn receives plain message objects.
// The returned handle takes the client's messages via receive(msg) and close().
function connect(sendFn) {
  const client = { send: sendFn, name: 'Player', queued: null, match: null, player: null };
  return {
    receive(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'queue' && MODES[msg.mode] && !client.match) {
        dequeue(client);
        client.name = String(msg.name || 'Player').replace(/[^\w \-]/g, '').slice(0, 12) || 'Player';
        client.queued = msg.mode; client.queuedAt = Date.now(); client.look = msg.look;
        queues[msg.mode].push(client);
        matchmake();
      } else if (msg.t === 'cancel') dequeue(client);
      else if (msg.t === 'input' || msg.t === 'throw') handlePlay(client, msg);
      else if (msg.t === 'leave') playerLeft(client);
    },
    close() { dequeue(client); playerLeft(client); },
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

return { connect, start, tick, matchmake, createPractice, MAP, P, LOOK_SIZES, STANCES, KINDS, recoilKick, blocked, lineOfSight, stepMovement, castRay, predictThrow, segmentClear, eyePos, WEAPONS, WEAPON_BY_CODE, weaponDamage, weaponKick, get botFillMs() { return BOT_FILL_MS; } };
});
