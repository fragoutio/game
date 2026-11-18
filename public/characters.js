// fragout.io characters — low-poly riders in the Shred Summit style (puffy jacket, baggy pants,
// goggles + headgear), built from a few shared, low-segment shapes so school computers keep up.
(function (root) {
  const THREE = root.THREE;

  // Option lists. Sizes must match LOOK_SIZES in core.js.
  const LOOKS = {
    jacket: [
      { name: 'SIGNAL RED', hex: 0xd32f2f }, { name: 'COBALT', hex: 0x1565c0 }, { name: 'FOREST', hex: 0x2e7d32 },
      { name: 'BLAZE', hex: 0xf57f17 }, { name: 'GRAPE', hex: 0x6a1b9a }, { name: 'SHADOW', hex: 0x2a2a2e },
      { name: 'SNOW', hex: 0xeeeeee }, { name: 'TEAL', hex: 0x00897b },
    ],
    pants: [
      { name: 'CHARCOAL', hex: 0x263238 }, { name: 'NAVY', hex: 0x1a237e }, { name: 'BARK', hex: 0x4e342e },
      { name: 'CRIMSON', hex: 0xb71c1c }, { name: 'ASH', hex: 0xbdbdbd }, { name: 'PINE', hex: 0x004d40 },
    ],
    head: [
      { name: 'HELMET' }, { name: 'BEANIE' }, { name: 'CAP' }, { name: 'HOOD' }, { name: 'BALACLAVA' },
    ],
    headColor: [
      { name: 'COBALT', hex: 0x1565c0 }, { name: 'RED', hex: 0xd32f2f }, { name: 'BLACK', hex: 0x222226 },
      { name: 'CYAN', hex: 0x00bcd4 }, { name: 'ORANGE', hex: 0xff6f00 }, { name: 'LIME', hex: 0x7cb342 },
    ],
    skin: [
      { name: 'LIGHT', hex: 0xf5c6a0 }, { name: 'WARM', hex: 0xe0a87c }, { name: 'TAN', hex: 0xc68642 },
      { name: 'BROWN', hex: 0x8d5524 }, { name: 'DEEP', hex: 0x5c3a21 },
    ],
  };

  // ---------- shared geometry (built once, reused by every character) ----------
  const geo = {};
  const G = (key, make) => geo[key] || (geo[key] = make());
  const cap = (r, len) => G(`cap${r}_${len}`, () => new THREE.CapsuleGeometry(r, len, 2, 6));
  const box = (w, h, d) => G(`box${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d));
  const ball = (r) => G(`ball${r}`, () => new THREE.IcosahedronGeometry(r, 1));
  const dome = (r, frac) => G(`dome${r}_${frac}`, () => new THREE.SphereGeometry(r, 8, 4, 0, Math.PI * 2, 0, Math.PI * frac));
  const cyl = (rt, rb, h, seg = 8) => G(`cyl${rt}_${rb}_${h}_${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));

  const lambert = hex => new THREE.MeshLambertMaterial({ color: hex, flatShading: true });

  function buildCharacter(look, teamHex, opts = {}) {
    const L = k => LOOKS[k][Math.max(0, Math.min(LOOKS[k].length - 1, look[k] | 0))];
    const mats = {
      jacket: lambert(L('jacket').hex),
      jacketDark: lambert(new THREE.Color(L('jacket').hex).multiplyScalar(0.7).getHex()),
      pants: lambert(L('pants').hex),
      skin: lambert(L('skin').hex),
      gear: lambert(L('headColor').hex),
      glove: lambert(0x2b2b30),
      boot: lambert(0x1a1a1e),
      gun: lambert(0x3a4050),
      frame: lambert(0x15151a),
      lens: new THREE.MeshBasicMaterial({ color: 0xffb347 }),
      team: new THREE.MeshBasicMaterial({ color: teamHex }),
      eye: new THREE.MeshBasicMaterial({ color: 0x111111 }),
    };
    const flashMats = [mats.jacket, mats.jacketDark, mats.pants, mats.skin, mats.gear];

    const rootG = new THREE.Group();          // at the feet; rotated to face the aim direction
    const body = new THREE.Group();           // bobbing / death fall
    rootG.add(body);
    const add = (g, m, x, y, z, parent = body) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); parent.add(o); return o; };
    const pivot = (x, y, z, parent = body) => { const p = new THREE.Group(); p.position.set(x, y, z); parent.add(p); return p; };

    // Ground ring in team colour + blob shadow (cheap stand-ins for real shadows)
    if (!opts.noRing) {
      const shadow = new THREE.Mesh(G('shadow', () => new THREE.CircleGeometry(0.46, 14)),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.015; rootG.add(shadow);
      const ring = new THREE.Mesh(G('ring', () => new THREE.RingGeometry(0.46, 0.56, 20)),
        new THREE.MeshBasicMaterial({ color: teamHex, transparent: true, opacity: 0.85, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; rootG.add(ring);
    }

    // ---- legs (baggy pants, chunky boots) ----
    const legs = {};
    for (const side of [-1, 1]) {
      const hip = pivot(0.1 * side, 0.86, 0);
      add(cap(0.11, 0.24), mats.pants, 0, -0.2, 0, hip);
      const knee = pivot(0, -0.42, 0, hip);
      add(cap(0.1, 0.22), mats.pants, 0, -0.19, 0, knee);
      add(box(0.15, 0.1, 0.26), mats.boot, 0, -0.39, 0.04, knee);
      legs[side] = { hip, knee };
    }
    // ---- torso: hips, puffy jacket, collar ----
    add(cap(0.14, 0.06), mats.pants, 0, 0.9, 0).scale.set(1.05, 0.8, 0.75);
    add(cap(0.19, 0.1), mats.jacket, 0, 1.02, 0).scale.set(1, 1, 0.74);
    add(cap(0.22, 0.16), mats.jacket, 0, 1.2, 0).scale.set(1.08, 1, 0.76);
    add(cyl(0.2, 0.2, 0.04, 10), mats.jacketDark, 0, 0.93, 0).scale.set(1, 1, 0.76);   // waistband
    add(box(0.02, 0.34, 0.02), mats.jacketDark, 0, 1.15, 0.17);                         // zipper
    add(cyl(0.09, 0.13, 0.08, 8), mats.jacket, 0, 1.4, 0);                               // collar

    // ---- arms (held forward on the blaster) ----
    const arms = {};
    for (const side of [-1, 1]) {
      const sh = pivot(0.25 * side, 1.33, 0);
      sh.rotation.order = 'YXZ';
      add(ball(0.075), mats.jacket, 0, 0, 0, sh);
      add(cap(0.075, 0.18), mats.jacket, 0, -0.15, 0, sh);
      add(cyl(0.08, 0.08, 0.05, 8), mats.team, 0, -0.1, 0, sh);                         // team armband
      const el = pivot(0, -0.3, 0, sh);
      add(cap(0.065, 0.16), mats.jacket, 0, -0.12, 0, el);
      add(ball(0.055), mats.glove, 0, -0.27, 0, el);
      arms[side] = { sh, el };
    }
    // side -1 is the character's right (x < 0 when facing +z): trigger hand. Side +1 supports the barrel.
    arms[-1].sh.rotation.set(-1.25, 0.25, 0); arms[-1].el.rotation.x = -0.45;
    arms[1].sh.rotation.set(-1.15, -0.55, 0); arms[1].el.rotation.x = -0.35;

    // ---- blaster ----
    const gun = pivot(-0.06, 1.2, 0.36);
    const rifle = pivot(0, 0, 0, gun), shotgun = pivot(0, 0, 0, gun);
    add(box(0.11, 0.13, 0.4), mats.gun, 0, 0, 0, rifle);
    add(box(0.07, 0.14, 0.08), mats.gun, 0, -0.12, -0.08, rifle);                        // grip
    add(box(0.115, 0.03, 0.28), mats.team, 0, 0.045, 0.02, rifle);                        // glow strip
    const barrel = add(cyl(0.035, 0.035, 0.2, 6), mats.frame, 0, 0.01, 0.28, rifle);
    barrel.rotation.x = Math.PI / 2;
    // shotgun: chunky receiver, long fat barrel, pump grip, team-coloured stripe
    // long lever-action style: stock, receiver, long barrel + choke, tube magazine, fore-grip
    add(box(0.09, 0.11, 0.24), mats.gun, 0, -0.03, -0.26, shotgun);                       // stock
    add(box(0.12, 0.14, 0.28), mats.gun, 0, 0, -0.04, shotgun);                           // receiver
    add(box(0.07, 0.14, 0.08), mats.gun, 0, -0.12, -0.1, shotgun);                        // grip
    const sgBarrel = add(cyl(0.04, 0.04, 0.66, 7), mats.frame, 0, 0.03, 0.42, shotgun); sgBarrel.rotation.x = Math.PI / 2;
    const choke = add(cyl(0.055, 0.055, 0.08, 7), mats.gun, 0, 0.03, 0.76, shotgun); choke.rotation.x = Math.PI / 2;
    const tubeMag = add(cyl(0.028, 0.028, 0.52, 6), mats.gun, 0, -0.03, 0.36, shotgun); tubeMag.rotation.x = Math.PI / 2;
    const pump = add(cyl(0.055, 0.055, 0.16, 7), mats.gun, 0, -0.025, 0.36, shotgun); pump.rotation.x = Math.PI / 2;
    add(box(0.125, 0.03, 0.2), mats.team, 0, 0.075, -0.04, shotgun);
    shotgun.visible = false;
    const muzzle = pivot(0, 0.01, 0.4, gun);
    const flash = new THREE.Mesh(G('flash', () => new THREE.OctahedronGeometry(0.13, 0)),
      new THREE.MeshBasicMaterial({ color: 0xfff1a8 }));
    flash.visible = false; muzzle.add(flash);

    // ---- neck + head + headgear ----
    add(cyl(0.06, 0.07, 0.08, 6), mats.skin, 0, 1.45, 0);
    const head = pivot(0, 1.6, 0.01);
    const kind = look.head | 0;
    const goggles = () => {
      add(box(0.27, 0.085, 0.06), mats.frame, 0, 0.01, 0.11, head);
      add(box(0.235, 0.065, 0.02), mats.lens, 0, 0.01, 0.142, head);
      add(cyl(0.142, 0.142, 0.04, 10), mats.frame, 0, 0.01, 0, head);                     // strap
    };
    const eyes = () => { add(box(0.035, 0.035, 0.02), mats.eye, -0.05, 0.02, 0.125, head); add(box(0.035, 0.035, 0.02), mats.eye, 0.05, 0.02, 0.125, head); };
    if (kind === 0) {            // helmet + goggles
      add(ball(0.13), mats.skin, 0, 0, 0, head);
      add(dome(0.155, 0.55), mats.gear, 0, 0.0, -0.005, head);
      add(box(0.24, 0.02, 0.07), mats.gear, 0, 0.13, 0.02, head);
      goggles();
    } else if (kind === 1) {     // beanie with pom
      add(ball(0.13), mats.skin, 0, 0, 0, head); eyes();
      add(dome(0.142, 0.55), mats.gear, 0, 0.02, 0, head);
      add(cyl(0.145, 0.145, 0.05, 10), mats.gear, 0, 0.03, 0, head);
      add(ball(0.045), mats.gear, 0, 0.17, 0, head);
    } else if (kind === 2) {     // cap with brim
      add(ball(0.13), mats.skin, 0, 0, 0, head); eyes();
      add(dome(0.138, 0.5), mats.gear, 0, 0.02, 0, head);
      add(box(0.2, 0.02, 0.14), mats.gear, 0, 0.03, 0.15, head);
    } else if (kind === 3) {     // hood + goggles
      add(ball(0.13), mats.skin, 0, 0, 0, head);
      add(ball(0.165), mats.gear, 0, 0.01, -0.035, head).scale.set(1, 1.05, 1);
      goggles();
    } else {                     // balaclava + goggles (Shred Summit classic)
      add(ball(0.13), mats.gear, 0, 0, 0, head);
      add(box(0.17, 0.05, 0.02), mats.skin, 0, 0.012, 0.122, head);
      goggles();
    }

    return {
      root: rootG, body, legs, arms, gun, head, flash, mats, flashMats,
      setWeapon(w) { rifle.visible = w !== 'shotgun'; shotgun.visible = w === 'shotgun'; },
      phase: Math.random() * 6, recoil: 0, flashT: 0, hitT: 0, deadT: 0,
      dispose() { for (const k in mats) mats[k].dispose(); rootG.traverse(o => { if (o.material && !Object.values(mats).includes(o.material)) o.material.dispose(); }); },
    };
  }

  // speed: world units / second; alive: bool; dt seconds; pitch: where they look (radians, up +);
  // stance: 'stand' | 'crouch' | 'slide'
  // lean: -1 left, 0, +1 right (aiming around a corner)
  function animateCharacter(c, dt, speed, alive, pitch = 0, stance = 'stand', lean = 0) {
    c.cr = (c.cr || 0) + ((stance === 'crouch' ? 1 : 0) - (c.cr || 0)) * Math.min(1, dt * 12);
    c.sl = (c.sl || 0) + ((stance === 'slide' ? 1 : 0) - (c.sl || 0)) * Math.min(1, dt * 14);
    if (c.sl > 0.3) speed = 0;   // legs stay still in a slide
    animateBase(c, dt, speed, alive, pitch);
    // crouch: squat down; slide: drop low, lean back, front leg out
    const cr = c.cr * (1 - c.deadT), sl = c.sl * (1 - c.deadT);
    c.body.position.y -= cr * 0.4 + sl * 0.6;
    for (const side of [-1, 1]) {
      c.legs[side].hip.rotation.x = c.legs[side].hip.rotation.x * (1 - cr * 0.6 - sl) - cr * 1.05 - sl * (side === 1 ? 1.4 : 0.6);
      c.legs[side].knee.rotation.x += cr * 1.75 + sl * (side === 1 ? 0.15 : 1.6);
    }
    c.body.rotation.x += -sl * 0.45;
    c.ln = (c.ln || 0) + (lean - (c.ln || 0)) * Math.min(1, dt * 12);
    c.body.rotation.z = c.ln * 0.3 * (1 - c.deadT);   // tilt the whole upper body to the side
  }

  function animateBase(c, dt, speed, alive, pitch) {
    const moving = Math.min(1, speed / 4.5);
    c.phase += dt * (4 + speed * 2.2) * (moving > 0.05 ? 1 : 0.25);
    const s = Math.sin(c.phase);
    const swing = s * 0.75 * moving;
    c.legs[-1].hip.rotation.x = swing;
    c.legs[1].hip.rotation.x = -swing;
    c.legs[-1].knee.rotation.x = Math.max(0, -Math.cos(c.phase)) * 0.9 * moving + 0.05;
    c.legs[1].knee.rotation.x = Math.max(0, Math.cos(c.phase)) * 0.9 * moving + 0.05;
    c.body.position.y = Math.abs(Math.cos(c.phase)) * 0.06 * moving + (1 - moving) * Math.sin(c.phase * 0.5) * 0.008;
    c.head.rotation.z = s * 0.04 * moving;

    // gun recoil kick
    c.recoil = Math.max(0, c.recoil - dt * 9);
    c.gun.position.z = 0.36 - c.recoil * 0.1;
    c.gun.rotation.x = -c.recoil * 0.25 - pitch;
    c.gun.position.y = 1.2 + pitch * 0.25;
    c.arms[-1].sh.rotation.x = -1.25 - c.recoil * 0.15 - pitch;
    c.arms[1].sh.rotation.x = -1.15 - c.recoil * 0.15 - pitch;
    c.head.rotation.x = -pitch * 0.6;
    c.flashT -= dt; c.flash.visible = c.flashT > 0;
    if (c.flash.visible) c.flash.rotation.z += 1.3;

    // hit flash (emissive red)
    c.hitT = Math.max(0, c.hitT - dt * 6);
    for (const m of c.flashMats) m.emissive.setRGB(c.hitT * 0.9, c.hitT * 0.15, c.hitT * 0.15);

    // knocked out: tip over backwards and sink a little
    if (!alive) c.deadT = Math.min(1, c.deadT + dt * 2.5); else c.deadT = 0;
    const d = c.deadT * c.deadT * (3 - 2 * c.deadT);
    c.body.rotation.x = -d * 1.45;
    c.body.position.z = -d * 0.35;
    c.body.position.y -= d * 0.1;
  }

  root.FragoutChars = { LOOKS, buildCharacter, animateCharacter };
})(typeof self !== 'undefined' ? self : this);
