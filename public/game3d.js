// fragout.io — first-person 3D arcade client. Keyboard (or gamepad) only.
// Menus: arrows/WASD select, Enter confirm, Esc back.
// In a match: W/S walk, A/D strafe, ←/→ turn, ↑/↓ look. The gun fires by itself while the centre
// crosshair is on a visible enemy; every shot kicks the view up, so hold ↓ while firing.
(() => {
  const THREE = window.THREE, Core = window.FragoutCore, Chars = window.FragoutChars;
  const LOCAL = !!window.FRAGOUT_LOCAL;
  const $ = id => document.getElementById(id);
  const S = 1 / 24;                    // arena pixels -> world units
  const CP = Core.P;                   // shared game constants
  const EYE_Y = CP.eye * S;
  const TEAM = {
    A: { hex: 0x3fa9ff, tracer: 0xa8e1ff, css: 'var(--team-a)', name: 'BLUE' },
    B: { hex: 0xff4566, tracer: 0xffb0bf, css: 'var(--team-b)', name: 'RED' },
  };

  // ---------- Saved profile & settings (per browser) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fragout-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('fragout-' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const profile = Object.assign({ name: '', optic: 'hog', op: 'riot', look: { jacket: 0, pants: 0, head: 4, headColor: 0, skin: 0 } }, store.get('profile', {}));
  const settings = Object.assign({ quality: 'medium', sound: true, fps: false }, store.get('settings', {}));

  // ---------- Renderer ----------
  const canvas = $('view');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'default' }); }
  catch (e) { $('loading').textContent = 'THIS COMPUTER COULD NOT START 3D GRAPHICS (WEBGL)'; return; }
  renderer.autoClear = false;
  const scene = new THREE.Scene();
  // grey concrete arena under an overcast night sky
  scene.background = new THREE.Color(0x17191e);
  scene.fog = new THREE.Fog(0x17191e, 40, 120);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  camera.rotation.order = 'YXZ';
  scene.add(new THREE.HemisphereLight(0xe8eaee, 0x3a3c42, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75);
  sun.position.set(-8, 20, 12); scene.add(sun);

  // First-person gun ("viewmodel") lives in its own little scene, drawn on top so it never clips into walls
  const vmScene = new THREE.Scene();
  const vmCam = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
  vmScene.add(new THREE.HemisphereLight(0xdde8ff, 0x302850, 1.0));
  const vmSun = new THREE.DirectionalLight(0xffffff, 0.6); vmSun.position.set(1, 2, 1); vmScene.add(vmSun);

  const QUALITY = { low: 0.55, medium: 0.85, high: Math.min(window.devicePixelRatio || 1, 1.5) };
  function resize() {
    renderer.setPixelRatio(QUALITY[settings.quality] || 0.85);
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = vmCam.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix(); vmCam.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  // ---------- Arena ----------
  const MAP = Core.MAP, AW = MAP.w * S, AH = MAP.h * S;
  const CENTER = new THREE.Vector3(AW / 2, 0, AH / 2);
  const lam = hex => new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
  const basic = (hex, extra) => new THREE.MeshBasicMaterial(Object.assign({ color: hex }, extra));
  const BORDER_H = 3.2, CRATE_H = 2.6;   // taller than a player, so cover really hides you

  function makeSignTexture() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    const draw = () => {
      g.clearRect(0, 0, 512, 128);
      g.font = '96px "Bebas Neue", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = '#ff3d7f'; g.shadowBlur = 18; g.fillStyle = '#ff3d7f'; g.fillText('FRAGOUT.IO', 262, 70);
      g.shadowColor = '#3fe0ff'; g.fillStyle = '#eaf2ff'; g.fillText('FRAGOUT.IO', 256, 64);
      tex.needsUpdate = true;
    };
    draw();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
    return tex;
  }

  const panelMeshes = new Map();   // wall index -> green panel mesh
  function buildArena() {
    const g = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), lam(0x202227));
    ground.rotation.x = -Math.PI / 2; ground.position.set(CENTER.x, -0.02, CENTER.z); g.add(ground);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(AW, AH), lam(0x3b3e45));
    floor.rotation.x = -Math.PI / 2; floor.position.set(CENTER.x, 0, CENTER.z); g.add(floor);

    // neon floor grid (one draw call)
    const pts = [], step = 32 * S;
    for (let x = step; x < AW; x += step) pts.push(x, 0.01, 0, x, 0.01, AH);
    for (let z = step; z < AH; z += step) pts.push(0, 0.01, z, AW, 0.01, z);
    const gridGeo = new THREE.BufferGeometry(); gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x52565e, transparent: true, opacity: 0.5 })));

    for (const t of ['A', 'B']) for (const [x, y] of MAP.spawns[t]) {
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 6), basic(TEAM[t].hex, { transparent: true, opacity: 0.35, depthWrite: false }));
      pad.rotation.x = -Math.PI / 2; pad.position.set(x * S, 0.012, y * S); g.add(pad);
    }

    // grey concrete: room walls with a pale trim along the top, crates with a darker edge, low vents with grates
    const edgeA = new THREE.LineBasicMaterial({ color: 0x9aa0a8 }), edgeB = new THREE.LineBasicMaterial({ color: 0x5d6168 });
    const wallMat = lam(0x62666e), crateMat = lam(0x777b83), capMat = lam(0x8d9199);
    const bandA = basic(0xa7adb5), bandB = basic(0x8c9199);
    const VH = CP.ventH * S, ventDark = lam(0x0e0f12), ventBars = [];
    const FZ0 = MAP.upper.floor * S;
    MAP.walls.forEach(([x, y, w, h, tall, lvl], i) => {
      const Y0 = lvl ? FZ0 : 0;
      if (tall === 3) {   // green wood panel (breakable): planks + darker frame lines
        const mat = lam(0x4f8f45);
        const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, BORDER_H, h * S), mat);
        m.position.set((x + w / 2) * S, BORDER_H / 2, (y + h / 2) * S); g.add(m);
        const lines = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x2c5a26 }));
        m.add(lines);
        const along = w > h, n = 4;
        for (let k = 1; k < n; k++) {   // plank seams
          const seam = new THREE.Mesh(new THREE.BoxGeometry(along ? 0.03 : w * S + 0.02, BORDER_H, along ? h * S + 0.02 : 0.03), lam(0x2f5c29));
          seam.position.set(along ? (-w / 2 + w * k / n) * S : 0, 0, along ? 0 : (-h / 2 + h * k / n) * S); m.add(seam);
        }
        panelMeshes.set(i, { mesh: m, mat, base: new THREE.Color(0x4f8f45) });
        return;
      }
      if (tall === 2) {   // vent: wall above a low grated gap
        const up = new THREE.Mesh(new THREE.BoxGeometry(w * S, BORDER_H - VH, h * S), wallMat);
        up.position.set((x + w / 2) * S, VH + (BORDER_H - VH) / 2, (y + h / 2) * S); g.add(up);
        const top = new THREE.Mesh(new THREE.BoxGeometry(w * S + 0.02, 0.08, h * S + 0.02), bandA);
        top.position.set(up.position.x, BORDER_H - 0.1, up.position.z); g.add(top);
        const hole = new THREE.Mesh(new THREE.BoxGeometry(w * S * 0.98, VH, h * S * 0.98), ventDark);
        hole.position.set(up.position.x, VH / 2, up.position.z); g.add(hole);
        const along = w > h, len = (along ? w : h) * S, n = 6;
        for (let k = 1; k < n; k++) ventBars.push([(along ? x * S + len * k / n : (x + w / 2) * S), (along ? (y + h / 2) * S : y * S + len * k / n), along]);
        const frame = new THREE.Mesh(new THREE.BoxGeometry(w * S + 0.03, 0.05, h * S + 0.03), bandB);
        frame.position.set(up.position.x, VH, up.position.z); g.add(frame);
        return;
      }
      const border = i < 4 || tall === 1, H = i < 4 ? 7 : border ? BORDER_H : CRATE_H;
      const geo = new THREE.BoxGeometry(w * S, H, h * S);
      const m = new THREE.Mesh(geo, border ? wallMat : crateMat);
      m.position.set((x + w / 2) * S, Y0 + H / 2, (y + h / 2) * S); g.add(m);
      if (border) {
        for (const yy of [Y0 + H - 0.1]) {
          const band = new THREE.Mesh(new THREE.BoxGeometry(w * S + 0.02, 0.08, h * S + 0.02), i % 2 ? bandA : bandB);
          band.position.set(m.position.x, yy, m.position.z); g.add(band);
        }
      } else {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(w * S - 0.12, 0.06, h * S - 0.12), capMat);
        cap.position.set(m.position.x, Y0 + H + 0.03, m.position.z); g.add(cap);
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * S + 0.02, 0.07, h * S + 0.02), i % 2 ? bandA : bandB);
        stripe.position.set(m.position.x, Y0 + 1.1, m.position.z); g.add(stripe);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), i % 2 ? edgeA : edgeB);
        edges.position.copy(m.position); g.add(edges);
      }
    });

    // upstairs: balcony floors (with a trim along the edge you can drop off), low railings, stepped stairs
    const UPS = MAP.upper, FZ = UPS.floor * S;
    const slabMat = lam(0x6d7179), slabEdge = basic(0x5dffb4), railMat = lam(0x9aa0a8), stepMat = lam(0x80848c);
    for (const [sx, sy, sw, sh] of Core.slabRects()) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(sw * S, 0.18, sh * S), slabMat);
      slab.position.set((sx + sw / 2) * S, FZ - 0.09, (sy + sh / 2) * S); g.add(slab);
      const under = new THREE.Mesh(new THREE.BoxGeometry(sw * S, 0.02, sh * S), lam(0x2a2c31));
      under.position.set(slab.position.x, FZ - 0.19, slab.position.z); g.add(under);
    }
    for (const [rx, ry, rw, rh] of UPS.rails) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(rw * S, UPS.rail * S, rh * S), railMat);
      rail.position.set((rx + rw / 2) * S, FZ + UPS.rail * S / 2, (ry + rh / 2) * S); g.add(rail);
    }
    // gaps in the floor get a glowing rim so you can see where to drop or rappel down
    for (const [hx, hy, hw, hh] of UPS.holes) {
      for (const [ex, ez, ew, ed] of [[hx, hy, hw, 3], [hx, hy + hh - 3, hw, 3], [hx, hy, 3, hh], [hx + hw - 3, hy, 3, hh]]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(ew * S, 0.05, ed * S), slabEdge);
        strip.position.set((ex + ew / 2) * S, FZ + 0.02, (ez + ed / 2) * S); g.add(strip);
      }
    }
    // ladders: two rails and rungs, against the edge you climb toward
    const ladMat = lam(0xd9a441);
    for (const [lx, ly, lw, lh, d] of UPS.ladders) {
      const along = d === 'N' || d === 'S';   // rungs run along x for N/S ladders
      const ex = d === 'W' ? lx : d === 'E' ? lx + lw : lx + lw / 2, ez = d === 'N' ? ly : d === 'S' ? ly + lh : ly + lh / 2;
      const span = (along ? lw : lh) * S, top = FZ + 0.9;
      const lad = new THREE.Group(); lad.position.set(ex * S, 0, ez * S);
      for (const k of [-0.5, 0.5]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, top, 0.08), ladMat);
        rail.position.set(along ? k * span : 0, top / 2, along ? 0 : k * span); lad.add(rail);
      }
      for (let r = 0.35; r < top; r += 0.4) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(along ? span : 0.06, 0.06, along ? 0.06 : span), ladMat);
        rung.position.set(0, r, 0); lad.add(rung);
      }
      g.add(lad);
    }
    for (const [sx, sy, sw, sh, dir] of UPS.stairs) {
      const n = 10, vertical = dir === 'N' || dir === 'S';
      for (let k = 0; k < n; k++) {
        const top = Math.min(1, (k + 1) / n / 0.8) * FZ;
        const along = vertical ? sh : sw, step = along / n;
        const pos = dir === 'S' || dir === 'E' ? k * step : along - (k + 1) * step;
        const box = new THREE.Mesh(new THREE.BoxGeometry(vertical ? sw * S : step * S, top, vertical ? step * S : sh * S), k % 2 ? stepMat : slabMat);
        box.position.set((vertical ? sx + sw / 2 : sx + pos + step / 2) * S, top / 2, (vertical ? sy + pos + step / 2 : sy + sh / 2) * S);
        g.add(box);
      }
    }

    // vent grate bars: one instanced mesh for every vent (cheap on school computers)
    if (ventBars.length) {
      const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, VH, 1), lam(0x9aa0a8), ventBars.length);
      const d = new THREE.Object3D();
      ventBars.forEach(([bx, bz, along], k) => { d.position.set(bx, VH / 2, bz); d.rotation.set(0, along ? 0 : Math.PI / 2, 0); d.scale.set(1, 1, 32 * S + 0.04); d.updateMatrix(); bars.setMatrixAt(k, d.matrix); });
      g.add(bars);
    }

    for (const [x, z] of [[-1.5, -1.5], [AW + 1.5, -1.5], [-1.5, AH + 1.5], [AW + 1.5, AH + 1.5]]) {
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 9, 6), lam(0x3a3d44));
      tower.position.set(x, 4.5, z); g.add(tower);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.3, 6), basic(z < 0 ? 0xff3d7f : 0x3fe0ff));
      top.position.set(x, 9.1, z); g.add(top);
    }
    // big signs above the walls on both long sides, readable from inside the room
    const tex = makeSignTexture();
    for (const [x, z, ry] of [[CENTER.x, -1.6, 0], [CENTER.x, AH + 1.6, Math.PI]]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(26, 6.5), basic(0xffffff, { map: tex, transparent: true, depthWrite: false }));
      sign.position.set(x, 7.2, z); sign.rotation.y = ry; g.add(sign);
    }
    scene.add(g);
  }
  buildArena();

  // Showcase pedestal (menus) sits just in front of the arena
  const SHOW = new THREE.Vector3(CENTER.x, 0, AH + 3.4);
  const pedestal = new THREE.Group();
  {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.35, 0.3, 10), lam(0x4a4d55)); base.position.y = 0.15;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.04, 4, 20), basic(0x3fe0ff)); rim.rotation.x = Math.PI / 2; rim.position.y = 0.3;
    pedestal.add(base, rim); pedestal.position.copy(SHOW); scene.add(pedestal);
  }
  let showChar = null;
  function rebuildShowcase() {
    if (showChar) { pedestal.remove(showChar.root); showChar.dispose(); }
    showChar = Chars.buildCharacter(profile.look, 0xffd23f, { noRing: true });
    showChar.root.position.y = 0.3; pedestal.add(showChar.root);
  }
  rebuildShowcase();

  // ---------- First-person gun ----------
  const vm = { group: new THREE.Group(), kick: 0, bob: 0, run: 0, flashT: 0, flash: new THREE.Object3D() };
  function buildViewmodel(look, teamHex) {
    vmScene.remove(vm.group);
    vm.group = new THREE.Group();
    const L = k => Chars.LOOKS[k][look[k] | 0];
    const jacket = lam(L('jacket').hex), glove = lam(0x2b2b30), gunMat = lam(0x3a4050), dark = lam(0x15151a);
    const glow = basic(teamHex);
    const add = (geo, mat, x, y, z, parent) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
    const gun = new THREE.Group(); vm.group.add(gun);
    const rifle = new THREE.Group(), shotgun = new THREE.Group(); gun.add(rifle, shotgun);
    add(new THREE.BoxGeometry(0.09, 0.11, 0.42), gunMat, 0, 0, -0.08, rifle);
    add(new THREE.BoxGeometry(0.095, 0.025, 0.3), glow, 0, 0.045, -0.06, rifle);
    add(new THREE.BoxGeometry(0.06, 0.13, 0.07), gunMat, 0, -0.1, 0.06, rifle);                    // grip
    const hogSight = add(new THREE.BoxGeometry(0.05, 0.04, 0.12), dark, 0, 0.08, -0.02, rifle);    // 1.3x HOG
    const hcogSight = new THREE.Group(); rifle.add(hcogSight);                                       // 2.5x HCOG: boxy housing with a lens
    add(new THREE.BoxGeometry(0.075, 0.07, 0.15), dark, 0, 0.095, -0.03, hcogSight);
    add(new THREE.BoxGeometry(0.085, 0.012, 0.17), gunMat, 0, 0.133, -0.03, hcogSight);
    add(new THREE.BoxGeometry(0.06, 0.05, 0.005), basic(0xff6a2a, { transparent: true, opacity: 0.35 }), 0, 0.097, -0.106, hcogSight);
    vm.optics = { hog: hogSight, hcog: hcogSight };
    hogSight.visible = profile.optic !== 'hcog'; hcogSight.visible = profile.optic === 'hcog';
    const barrel = add(new THREE.CylinderGeometry(0.028, 0.028, 0.2, 6), dark, 0, 0.005, -0.36, rifle); barrel.rotation.x = Math.PI / 2;
    // shotgun: long lever-action style — stock, boxy receiver, long barrel with a flared choke, tube magazine
    // underneath, a fore-grip that racks back and a side lever that flips after each shot
    const tube = (r, len, mat, x, y, zc) => { const m = add(new THREE.CylinderGeometry(r, r, len, 8), mat, x, y, zc, shotgun); m.rotation.x = Math.PI / 2; return m; };
    add(new THREE.BoxGeometry(0.08, 0.1, 0.22), gunMat, 0, -0.035, 0.2, shotgun);                  // stock
    add(new THREE.BoxGeometry(0.11, 0.13, 0.26), gunMat, 0, 0, -0.04, shotgun);                   // receiver
    add(new THREE.BoxGeometry(0.06, 0.13, 0.07), gunMat, 0, -0.1, 0.06, shotgun);                  // grip
    add(new THREE.BoxGeometry(0.115, 0.022, 0.2), glow, 0, 0.065, -0.04, shotgun);                 // team stripe
    tube(0.034, 0.62, dark, 0, 0.03, -0.47);                                                      // long barrel
    tube(0.048, 0.07, gunMat, 0, 0.03, -0.8);                                                     // flared choke
    tube(0.024, 0.5, gunMat, 0, -0.025, -0.4);                                                    // tube magazine
    add(new THREE.BoxGeometry(0.02, 0.03, 0.03), glow, 0, 0.065, -0.76, shotgun);                 // front sight
    vm.pump = tube(0.047, 0.16, gunMat, 0, -0.02, -0.36);                                          // fore-grip
    vm.lever = new THREE.Group(); vm.lever.position.set(0.058, -0.03, 0.02); shotgun.add(vm.lever);
    add(new THREE.BoxGeometry(0.012, 0.025, 0.14), glow, 0, 0, -0.04, vm.lever);                   // side lever
    vm.guns = { rifle, shotgun };
    // right hand + sleeve on the grip, left hand under the barrel
    add(new THREE.IcosahedronGeometry(0.05, 0), glove, 0.01, -0.12, 0.07, gun);
    const sleeveR = add(new THREE.CapsuleGeometry(0.06, 0.32, 1, 6), jacket, 0.06, -0.2, 0.28, gun); sleeveR.rotation.x = 1.15;
    add(new THREE.IcosahedronGeometry(0.048, 0), glove, -0.03, -0.06, -0.24, gun);
    const sleeveL = add(new THREE.CapsuleGeometry(0.055, 0.34, 1, 6), jacket, -0.17, -0.16, -0.02, gun); sleeveL.rotation.set(1.25, 0, -0.9);
    vm.flash = add(new THREE.OctahedronGeometry(0.07, 0), basic(0xfff1a8), 0, 0.005, -0.5, gun);
    vm.flash.visible = false;
    vm.group.scale.setScalar(0.7);
    vm.group.position.set(0.17, -0.17, -0.5);
    vmScene.add(vm.group);
  }

  // ---------- Effects: tracers, particles ----------
  const MAX_TRACERS = 24, MAX_PARTS = 240;
  const tracerGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 4); tracerGeo.rotateX(Math.PI / 2); tracerGeo.translate(0, 0, 0.5);
  const tracers = new THREE.InstancedMesh(tracerGeo, basic(0xffffff, { transparent: true, opacity: 0.85 }), MAX_TRACERS);
  tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage); tracers.frustumCulled = false; scene.add(tracers);
  const T = Array.from({ length: MAX_TRACERS }, () => ({ life: 0, a: new THREE.Vector3(), b: new THREE.Vector3() }));
  let tracerCursor = 0;
  const parts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), basic(0xffffff), MAX_PARTS);
  parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage); parts.frustumCulled = false; scene.add(parts);
  const PT = Array.from({ length: MAX_PARTS }, () => ({ life: 0, max: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }));
  const dummy = new THREE.Object3D(), tmpColor = new THREE.Color(), tmpV = new THREE.Vector3();
  let partCursor = 0;
  dummy.scale.setScalar(0); dummy.updateMatrix();
  for (let i = 0; i < MAX_PARTS; i++) { parts.setMatrixAt(i, dummy.matrix); parts.setColorAt(i, tmpColor.set(0xffffff)); }
  for (let i = 0; i < MAX_TRACERS; i++) { tracers.setMatrixAt(i, dummy.matrix); tracers.setColorAt(i, tmpColor.set(0xffffff)); }

  function addTracer(from, to, hex) {
    const t = T[tracerCursor], i = tracerCursor; tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
    t.a.copy(from); t.b.copy(to); t.life = 0.09;
    tracers.setColorAt(i, tmpColor.set(hex)); tracers.instanceColor.needsUpdate = true;
  }
  function updateTracers(dt) {
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = T[i];
      dummy.rotation.set(0, 0, 0); dummy.position.set(0, 0, 0);
      if (t.life > 0) {
        t.life -= dt;
        const w = Math.max(0, t.life / 0.09) * 0.8 + 0.3;
        dummy.position.copy(t.a); dummy.lookAt(t.b);
        dummy.scale.set(w, w, t.a.distanceTo(t.b));
      } else dummy.scale.setScalar(0);
      dummy.updateMatrix(); tracers.setMatrixAt(i, dummy.matrix);
    }
    tracers.instanceMatrix.needsUpdate = true;
  }
  function burst(x, y, z, hex, n, speed) {
    tmpColor.set(hex);
    for (let k = 0; k < n; k++) {
      const p = PT[partCursor], i = partCursor; partCursor = (partCursor + 1) % MAX_PARTS;
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
      Object.assign(p, { x, y, z, vx: Math.cos(a) * s, vy: 1 + Math.random() * speed, vz: Math.sin(a) * s, max: 0.3 + Math.random() * 0.4 });
      p.life = p.max;
      parts.setColorAt(i, tmpColor);
    }
    parts.instanceColor.needsUpdate = true;
  }
  function updateParticles(dt) {
    for (let i = 0; i < MAX_PARTS; i++) {
      const p = PT[i];
      if (p.life <= 0) { if (p.max) { dummy.scale.setScalar(0); dummy.updateMatrix(); parts.setMatrixAt(i, dummy.matrix); p.max = 0; } continue; }
      p.life -= dt; p.vy -= 12 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.4; p.vx *= 0.7; p.vz *= 0.7; }
      dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(p.life * 9, p.life * 7, 0);
      dummy.scale.setScalar(Math.max(0, p.life / p.max)); dummy.updateMatrix(); parts.setMatrixAt(i, dummy.matrix);
    }
    parts.instanceMatrix.needsUpdate = true;
  }

  // ---------- Sound (tiny synth, no files) ----------
  let actx = null, noiseBuf = null;
  function ac() {
    if (!settings.sound) return null;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { return null; }
    return actx;
  }
  function tone(freq, dur, type = 'square', vol = 0.05, slide = 0, delay = 0) {
    const a = ac(); if (!a) return;
    const t0 = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, vol, freq) {
    const a = ac(); if (!a) return;
    if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    src.connect(f).connect(g).connect(a.destination); src.start(); src.stop(a.currentTime + dur);
  }
  const sfx = {
    move: () => tone(620, 0.035, 'square', 0.025),
    select: () => tone(760, 0.08, 'square', 0.035, 500),
    back: () => tone(380, 0.08, 'square', 0.03, -150),
    shotgun: mine => { if (mine) { noise(0.22, 0.16, 1800); tone(140, 0.2, 'sawtooth', 0.06, -70); } else { noise(0.18, 0.05, 1400); } },
    swap: () => { tone(500, 0.04, 'square', 0.02); tone(700, 0.05, 'square', 0.02, 0, 0.12); },
    shoot: mine => { if (mine) { tone(820, 0.05, 'square', 0.035, -450); noise(0.05, 0.04, 3000); } else tone(520, 0.05, 'square', 0.012, -300); },
    hitmark: () => tone(1400, 0.04, 'square', 0.03),
    throw: () => { noise(0.14, 0.05, 2600); tone(320, 0.12, 'triangle', 0.02, 260); },
    boom: () => { noise(0.75, 0.2, 650); tone(85, 0.55, 'sawtooth', 0.07, -45); },
    ignite: () => { noise(0.9, 0.09, 1400); tone(160, 0.3, 'sawtooth', 0.03, -60); },
    bounce: () => tone(950, 0.03, 'square', 0.015),
    ready: () => { tone(1100, 0.07, 'triangle', 0.04); tone(1500, 0.1, 'triangle', 0.04, 0, 0.06); },
    denied: () => tone(180, 0.08, 'square', 0.025),
    headshot: () => { tone(1900, 0.06, 'square', 0.04); tone(2500, 0.14, 'triangle', 0.05, 0, 0.05); },
    hurt: () => noise(0.12, 0.1, 700),
    ko: () => { tone(240, 0.35, 'sawtooth', 0.05, -170); noise(0.3, 0.07, 900); },
    count: () => tone(440, 0.12, 'triangle', 0.08),
    fight: () => { tone(660, 0.12, 'square', 0.05); tone(990, 0.3, 'square', 0.05, 0, 0.1); },
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.2, 'triangle', 0.07, 0, i * 0.11)),
    lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.25, 'triangle', 0.06, 0, i * 0.15)),
  };

  // ---------- UI helpers ----------
  let toastTimer = 0;
  function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }
  let announceTimer = 0;
  function announce(text, sub = '', color = '', ms = 900) {
    const a = $('announce');
    a.innerHTML = '';
    if (!text) return;
    const span = document.createElement('span'); span.className = 'pop'; span.textContent = text;
    if (color) span.style.color = color;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; span.appendChild(s); }
    a.appendChild(span);
    clearTimeout(announceTimer); if (ms) announceTimer = setTimeout(() => { a.innerHTML = ''; }, ms);
  }
  function flashClass(el, cls, ms) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove(cls), ms); }

  // ---------- Screens & keyboard menu navigation ----------
  const MENU_SCREENS = ['title', 'mode', 'party', 'locker', 'controls', 'settings', 'pause', 'end'];
  let ui = 'loading', sel = 0, lastMode = '1v1';
  const nameInput = $('name-input');

  function show(name) {
    if (name === 'title' && typeof ws !== 'undefined' && ws && ws.readyState === 1 && !serverOld && onlineCount && netMode !== 'online') { netMode = 'online'; netBadge(); }   // server came up while you played offline
    if (name !== 'game' && name !== 'practice' && typeof cancelAim === 'function' && match) cancelAim();
    for (const s of MENU_SCREENS) $('screen-' + s).hidden = s !== name;
    ui = name; sel = 0;
    const inMatch = name === 'game' || name === 'pause' || name === 'practice';
    $('hud').hidden = !inMatch;
    $('hud').classList.toggle('practice', name === 'practice');
    $('keys-bar').hidden = name === 'game' || name === 'practice';
    $('build-tag').hidden = !(name === 'title' || name === 'pause' || name === 'settings');
    pedestal.visible = !inMatch && name !== 'end';
    if (name === 'locker') refreshLocker();
    if (name === 'party' || name === 'title' || name === 'mode') refreshParty();
    if (name === 'settings') refreshSettings();
    if (name === 'title' || name === 'mode') clearMatchIfOver();
    highlight();
  }
  const items = () => (MENU_SCREENS.includes(ui) ? [...$('screen-' + ui).querySelectorAll('.mi')].filter(e => !e.closest('[hidden]')) : []);
  function highlight() {
    const it = items();
    it.forEach((e, i) => e.classList.toggle('sel', i === sel));
    const cur = it[sel];
    const box = cur && cur.querySelector('input');
    if (box) box.focus();
    else if (document.activeElement && document.activeElement.tagName === 'INPUT') { document.activeElement.blur(); canvas.focus(); }
  }
  function menuAction(action) {
    const it = items(); if (!it.length) return;
    const cur = it[sel];
    if (action === 'up' || action === 'down') { sel = (sel + (action === 'up' ? -1 : 1) + it.length) % it.length; sfx.move(); highlight(); }
    else if (action === 'left' || action === 'right') {
      const d = action === 'left' ? -1 : 1;
      if (cur.dataset.opt || cur.dataset.set || cur.hasAttribute('data-op')) { cycle(cur, d); sfx.move(); }
      else { sel = (sel + d + it.length) % it.length; sfx.move(); highlight(); }
    } else if (action === 'ok') activate(cur);
    else if (action === 'back') back();
  }
  function activate(el) {
    if (!el) return;
    if (el.dataset.go) { sfx.select(); show(el.dataset.go); }
    else if (el.dataset.mode) { sfx.select(); queueFor(el.dataset.mode); }
    else if (el.dataset.opt || el.dataset.set || el.hasAttribute('data-op')) { cycle(el, 1); sfx.move(); }
    else if (el.hasAttribute('data-name')) nameInput.focus();
    else if (el.hasAttribute('data-cancel')) cancelQueue();
    else if (el.hasAttribute('data-pcreate')) partyCreate();
    else if (el.hasAttribute('data-pjoin')) $('party-input').focus();
    else if (el.hasAttribute('data-pleave')) { sfx.back(); send({ t: 'party_leave' }); }
    else if (el.hasAttribute('data-pplay')) { sfx.select(); show('mode'); }
    else if (el.hasAttribute('data-resume')) { sfx.back(); show('game'); }
    else if (el.hasAttribute('data-forfeit')) forfeit();
    else if (el.hasAttribute('data-again')) { sfx.select(); if (party && party.code && !party.leader) show('party'); else queueFor(lastMode); }
  }
  function back() {
    if (ui === 'practice') cancelQueue();
    else if (ui === 'pause') { sfx.back(); show('game'); }
    else if (ui === 'game') { sfx.back(); show('pause'); }
    else if (ui !== 'title') { sfx.back(); show('title'); }
  }
  document.addEventListener('click', e => {
    const el = e.target.closest('.mi'); if (!el) return;
    const i = items().indexOf(el); if (i < 0) return;
    sel = i; highlight();
    if (!el.querySelector('input')) activate(el);
  });
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('.mi'); if (!el) return;
    const i = items().indexOf(el); if (i >= 0 && i !== sel && document.activeElement !== nameInput) { sel = i; highlight(); }
  });

  // Locker & settings
  function cycle(el, d) {
    if (el.hasAttribute('data-op')) {
      const L = Core.OP_LIST, i = Math.max(0, L.indexOf(profile.op));
      profile.op = L[(i + d + L.length) % L.length]; store.set('profile', profile); refreshLocker(); profileChanged();
      return;
    }
    if (el.dataset.opt) {
      const k = el.dataset.opt, n = Chars.LOOKS[k].length;
      profile.look[k] = ((profile.look[k] | 0) + d + n) % n;
      store.set('profile', profile); rebuildShowcase(); refreshLocker(); profileChanged();
    } else if (el.dataset.set) {
      const k = el.dataset.set;
      if (k === 'quality') { const q = ['low', 'medium', 'high']; settings.quality = q[(q.indexOf(settings.quality) + d + 3) % 3]; resize(); }
      else settings[k] = !settings[k];
      store.set('settings', settings); refreshSettings();
    }
  }
  function refreshLocker() {
    nameInput.value = profile.name;
    {   // operator
      const op = Core.OPS[profile.op] || Core.OPS.riot, val = document.querySelector('#screen-locker [data-op] .val');
      val.innerHTML = '';
      const l = document.createElement('span'); l.className = 'arrow'; l.textContent = '◀';
      const r = document.createElement('span'); r.className = 'arrow'; r.textContent = '▶';
      const n = document.createElement('span'); n.textContent = op.name; n.style.color = op.color;
      val.append(l, n, r);
      const d = $('op-desc'); d.innerHTML = '';
      const c = document.createElement('b'); c.textContent = op.cls; c.style.color = op.color;
      const t = document.createElement('div'); t.innerHTML = '<kbd>SPACE</kbd> '; t.append(op.tac.name + ' · ' + op.tac.desc + ` (${op.tac.cd} s)`);
      const u = document.createElement('div'); u.innerHTML = '<kbd>CAPS</kbd> '; u.append(op.ult.name + ' · ' + op.ult.desc);
      d.append(c, t, u);
    }
    for (const row of document.querySelectorAll('#screen-locker [data-opt]')) {
      const k = row.dataset.opt, opt = Chars.LOOKS[k][profile.look[k] | 0];
      const val = row.querySelector('.val');
      val.innerHTML = '';
      const l = document.createElement('span'); l.className = 'arrow'; l.textContent = '◀';
      const r = document.createElement('span'); r.className = 'arrow'; r.textContent = '▶';
      const name = document.createElement('span'); name.textContent = opt.name;
      val.append(l);
      if (opt.hex != null) { const sw = document.createElement('i'); sw.className = 'swatch'; sw.style.background = '#' + opt.hex.toString(16).padStart(6, '0'); val.append(sw); }
      val.append(name, r);
    }
  }
  const partyInput = $('party-input');
  partyInput.addEventListener('input', () => { partyInput.value = partyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
  nameInput.addEventListener('input', () => {
    profile.name = nameInput.value.replace(/[^\w \-]/g, '').slice(0, 12).toUpperCase();
    nameInput.value = profile.name; store.set('profile', profile);
    profileChanged();
  });

  // ---------- Party ----------
  // party = { code, members: [{name, look, leader}], you, leader } from the server, or null
  let party = null;
  const partyOnline = () => netMode === 'online' && ws && ws.readyState === 1;
  function partyCreate() {
    if (!partyOnline()) { sfx.denied(); toast('Parties need the online server (it may still be waking up)'); return; }
    sfx.select(); send({ t: 'party_create', name: profile.name || 'PLAYER', look: profile.look });
  }
  function partyJoin() {
    const code = partyInput.value.trim();
    if (!code) { sfx.denied(); toast('Type your friend\'s party code first'); return; }
    if (!partyOnline()) { sfx.denied(); toast('Parties need the online server (it may still be waking up)'); return; }
    sfx.select(); send({ t: 'party_join', code, name: profile.name || 'PLAYER', look: profile.look });
  }
  let profileTimer = 0;
  function profileChanged() {
    if (!party) return;
    clearTimeout(profileTimer);
    profileTimer = setTimeout(() => send({ t: 'hello', name: profile.name || 'PLAYER', look: profile.look, op: profile.op }), 300);
  }
  function refreshParty() {
    const inP = !!(party && party.code);
    $('party-code').hidden = !inP;
    if (inP) $('party-code').querySelector('b').textContent = party.code;
    const list = $('party-list'); list.innerHTML = '';
    if (inP) party.members.forEach((m, i) => {
      const row = document.createElement('div'); row.className = 'pm';
      if (m.leader) { const c = document.createElement('span'); c.className = 'crown'; c.textContent = '★'; row.appendChild(c); }
      const n = document.createElement('span'); n.textContent = m.name; row.appendChild(n);
      if (i === party.you) { const y = document.createElement('span'); y.className = 'you'; y.textContent = '(YOU)'; row.appendChild(y); }
      list.appendChild(row);
    });
    $('party-sub').textContent = inP
      ? (party.leader ? 'Tell your friends this code. When everyone is in, pick PLAY: the whole party joins the match on your team.'
        : 'You\'re in! Wait here: when the leader (★) starts a match, you join it automatically.')
      : 'Create a party and tell your friends the code, or type a friend\'s code to join. Up to 4 players.';
    document.querySelector('[data-pcreate]').hidden = inP;
    document.querySelector('[data-pleave]').hidden = !inP;
    document.querySelector('[data-pplay]').hidden = !(inP && party.leader);
    document.querySelector('[data-mode="2v2"]').hidden = !inP;   // 2v2 is only for parties
    $('party-hint').textContent = inP ? `${party.members.length} IN PARTY · ${party.code}` : 'play with friends';
    $('mode-sub').textContent = inP && party.members.length > 1
      ? `Your party of ${party.members.length} joins this match together, on the same team.`
      : 'Warm up on the practice range while we find your match.';
    if (ui === 'party' || ui === 'title' || ui === 'mode') { sel = Math.max(0, Math.min(sel, items().length - 1)); highlight(); }
    rebuildPartyShow();
  }

  // friends stand on their own pedestals next to yours in the menus, with name tags
  const partyShow = [];   // { root (pedestal group), ch, label }
  const PARTY_SPOTS = [[1.7, -1.1], [-1.7, -1.1], [3.2, -2.3]];
  const myTag = (() => { const el = document.createElement('div'); el.className = 'nl menu-tag'; el.innerHTML = '<span class="n"></span>'; el.style.display = 'none'; $('labels').appendChild(el); return el; })();
  function setTag(el, m) { el.querySelector('.n').innerHTML = ''; if (m.leader) { const c = document.createElement('span'); c.className = 'crown'; c.textContent = '★'; el.querySelector('.n').appendChild(c); } el.querySelector('.n').append(m.name); }
  function rebuildPartyShow() {
    for (const p of partyShow) { scene.remove(p.root); p.ch.dispose(); p.label.remove(); }
    partyShow.length = 0;
    if (!party || !party.code) return;
    const others = party.members.filter((m, i) => i !== party.you);
    others.forEach((m, i) => {
      const spot = PARTY_SPOTS[i]; if (!spot) return;
      const root = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 0.3, 10), lam(0x4a4d55)); base.position.y = 0.15;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.77, 0.035, 4, 18), basic(0x3fe0ff)); rim.rotation.x = Math.PI / 2; rim.position.y = 0.3;
      const ch = Chars.buildCharacter(m.look, 0x3fe0ff, { noRing: true }); ch.root.position.y = 0.3; ch.root.rotation.y = -spot[0] * 0.12;
      root.add(base, rim, ch.root);
      root.position.set(SHOW.x + spot[0], 0, SHOW.z + spot[1]); scene.add(root);
      const label = document.createElement('div'); label.className = 'nl menu-tag'; label.innerHTML = '<span class="n"></span>'; label.style.color = '#3fe0ff';
      setTag(label, m); $('labels').appendChild(label);
      partyShow.push({ root, ch, label });
    });
  }
  const tagV = new THREE.Vector3();
  function placeTag(el, x, y, z, vis) {
    if (!vis) { el.style.display = 'none'; return; }
    tagV.set(x, y, z).project(camera);
    if (tagV.z > 1) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.left = `${(tagV.x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-tagV.y * 0.5 + 0.5) * innerHeight}px`;
  }
  function updatePartyShow(dt, inMenus) {
    const showAll = inMenus && ui !== 'locker';
    for (const p of partyShow) {
      p.root.visible = showAll;
      if (showAll) Chars.animateCharacter(p.ch, dt, 0, true);
      placeTag(p.label, p.root.position.x, 2.2, p.root.position.z, showAll);
    }
    const me0 = party && party.code ? party.members[party.you] : null;
    if (inMenus && (ui === 'title' || ui === 'party' || ui === 'mode')) {
      setTag(myTag, me0 || { name: profile.name || 'PLAYER', leader: false });
      myTag.style.color = '#ffd23f';
      placeTag(myTag, SHOW.x, 2.25, SHOW.z, true);
    } else placeTag(myTag, 0, 0, 0, false);
  }
  function refreshSettings() {
    const label = { quality: settings.quality.toUpperCase(), sound: settings.sound ? 'ON' : 'OFF', fps: settings.fps ? 'ON' : 'OFF' };
    for (const row of document.querySelectorAll('#screen-settings [data-set]')) row.querySelector('.val').textContent = `◀ ${label[row.dataset.set]} ▶`;
    $('fps').hidden = !settings.fps;
  }

  // ---------- Input ----------
  const keys = new Set(), tapped = new Set();
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    Enter: 'ok', NumpadEnter: 'ok', Space: 'ok', Escape: 'back', Backspace: 'back' };
  const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'Backspace', 'CapsLock']);
  addEventListener('keydown', e => {
    ac();
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && document.activeElement.id === 'party-input') { e.preventDefault(); partyJoin(); return; }
      if (['ArrowUp', 'ArrowDown', 'Enter', 'NumpadEnter', 'Escape', 'Tab'].includes(e.code)) {
        e.preventDefault();
        menuAction(e.code === 'ArrowUp' ? 'up' : 'down');
      }
      return; // other keys type into the name box
    }
    if (BLOCK.has(e.code)) e.preventDefault();
    // double-tap W to run (like Minecraft): a second W press within 300 ms starts running until W is let go
    if (e.code === 'KeyW' && !e.repeat) { const t = performance.now(); if (t - lastWTap < 300) sprintLatch = true; lastWTap = t; }
    keys.add(e.code); tapped.add(e.code);
    if ((ui === 'game' || ui === 'practice') && (e.ctrlKey || e.code === 'ShiftLeft' || e.code === 'ShiftRight')) e.preventDefault();
    if (ui === 'game' || ui === 'practice') {
      if (e.code === 'Escape') back();
      else if (e.code === 'KeyT' && !e.repeat) switchOptic();
      else if (e.code === 'ShiftRight' && !e.repeat) { if (me.ads) { lowerSight(); sfx.move(); } else sightKey(0); }   // right Shift: zoom in / out
      else if (e.code === 'KeyX' && !e.repeat) { me.rapN = (me.rapN || 0) + 1; me.wantRap = true; }
      else if (GREN_KEYS[e.code] && !e.repeat) startAim(GREN_KEYS[e.code]);
      else if ((e.code === 'KeyQ' || e.code === 'KeyE') && !e.repeat) sightKey(e.code === 'KeyQ' ? -1 : 1);
      else if (e.code === 'Space' && !e.repeat) useTactical();
      else if (e.code === 'CapsLock' && !e.repeat) useUltimate();
      else if (e.code === 'Tab' && !e.repeat) { if (me.onLadder) { me.dropN = (me.dropN || 0) + 1; me.wantDrop = true; } }   // Tab: let go of a ladder
      else if (e.code === 'Digit1' || e.code === 'Numpad1') pickWeapon('rifle');
      else if (e.code === 'Digit2' || e.code === 'Numpad2') pickWeapon('shotgun');
      return;
    }
    const act = KEYMAP[e.code];
    if (act) menuAction(act);
  });
  addEventListener('keyup', e => { keys.delete(e.code); if (e.code === 'KeyW') sprintLatch = false; if (GREN_KEYS[e.code]) releaseAim(GREN_KEYS[e.code]); });
  addEventListener('blur', () => { keys.clear(); sprintLatch = false; cancelAim(); });
  let lastWTap = -1e9, sprintLatch = false;
  canvas.addEventListener('pointerdown', () => canvas.focus());
  $('focus-hint').addEventListener('click', () => { canvas.focus(); $('focus-hint').hidden = true; });

  let padPrev = {}, lastPad = null;
  function readPad() {
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    if (!gp) return null;
    const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed), dz = v => (Math.abs(v) > 0.25 ? v : 0);
    const p = {
      mx: dz(gp.axes[0] || 0), my: dz(gp.axes[1] || 0), ax: dz(gp.axes[2] || 0), ay: dz(gp.axes[3] || 0),
      up: b(12), down: b(13), left: b(14), right: b(15), ok: b(0), back: b(1) || b(9),
      run: b(10) || b(4), crouch: b(1) || b(11) || b(5), start: b(9), gBoom: b(3), gFrag: b(2), gTherm: b(6) || b(7),
    };
    if (ui !== 'game' && ui !== 'practice') {
      for (const k of ['up', 'down', 'left', 'right', 'ok', 'back']) if (p[k] && !padPrev[k]) menuAction(k);
    } else {
      if (p.start && !padPrev.start) back();
      for (const [btn, kind] of [['gBoom', 'boom'], ['gFrag', 'frag'], ['gTherm', 'therm']]) {
        if (p[btn] && !padPrev[btn]) startAim(kind);
        if (!p[btn] && padPrev[btn]) releaseAim(kind);
      }
    }
    padPrev = p;
    return p;
  }

  addEventListener('beforeunload', e => {
    if (ui === 'game' || ui === 'pause' || ui === 'practice') { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Network ----------
  // Online: a WebSocket to the game server (the page's own host, or FRAGOUT_SERVER for the GitHub Pages build,
  // or ?server=wss://... in the address). If no server answers, play offline: the game core runs in this page
  // and bots fill the lobby. Matches started online stay online; the badge on the title screen shows which.
  const params = new URLSearchParams(location.search);
  const SERVER = params.get('server') || window.FRAGOUT_SERVER || (LOCAL ? '' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  let serverOld = false, ws = null, connected = false, netMode = SERVER ? 'connecting' : 'offline', onlineCount = 0, localConn = null, inOnlineMatch = false;
  function goOffline() {
    if (!localConn) {
      Core.start({ botFillMs: window.FRAGOUT_BOT_FILL_MS || 30000 });
      localConn = Core.connect(msg => setTimeout(() => onMessage(msg), 0));
    }
    connected = true;
  }
  function netBadge() {
    const b = $('net-badge');
    b.className = netMode;
    b.textContent = netMode === 'online' ? `ONLINE · ${onlineCount} PLAYER${onlineCount === 1 ? '' : 'S'}` : netMode === 'connecting' ? 'CONNECTING TO SERVER…' : serverOld ? 'SERVER UPDATING · BOTS ONLY' : 'OFFLINE · BOTS ONLY';
  }
  const send = msg => {
    if (netMode === 'online' && ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else if (localConn) localConn.receive(JSON.parse(JSON.stringify(msg)));
  };
  if (LOCAL) { $('test-badge').hidden = !!window.FRAGOUT_HIDE_BADGE || !!SERVER; goOffline(); }
  if (SERVER) {
    let tries = 0;
    const connect = () => {
      try { ws = new WebSocket(SERVER); } catch { netMode = LOCAL ? 'offline' : 'connecting'; netBadge(); return; }
      ws.onopen = () => { connected = true; tries = 0; };   // online once the server says it has the same map (below)
      ws.onclose = () => {
        const wasOnline = netMode === 'online';
        if (party) { party = null; refreshParty(); }
        if (wasOnline) netMode = LOCAL ? 'offline' : 'connecting';
        if (!LOCAL) connected = false;
        if (wasOnline && inOnlineMatch && (ui === 'practice' || ui === 'game' || ui === 'pause' || ui === 'end')) { stopPractice(); clearMatch(); show('title'); toast('Lost connection to the server'); }
        // free servers sleep when nobody plays: the first connection can take up to a minute to wake it
        netBadge(); setTimeout(connect, Math.min(10000, 1500 + 1000 * tries++));
      };
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'online') {
          onlineCount = m.n; serverOld = m.v !== Core.MAP_ID;
          if (serverOld) { if (netMode !== 'offline' && !inOnlineMatch) netMode = 'offline'; }   // server not updated yet: bots only
          else if (netMode !== 'online' && !(match && !inOnlineMatch && ui !== 'title')) netMode = 'online';
          netBadge(); return;
        } onMessage(m); };
    };
    connect();
  }

  // ---------- Matchmaking ----------
  let queueInfo = null, queueStart = 0;
  function queueFor(mode) {
    if (!connected) { toast('Connecting to the server…'); return; }
    if (party && party.code && !party.leader) { sfx.denied(); toast('Waiting for the party leader to start a match'); show('party'); return; }
    if (mode === '2v2' && !(party && party.code)) { sfx.denied(); toast('2v2 is for parties: make one with PARTY on the main menu'); show('mode'); return; }
    send({ t: 'queue', mode, name: profile.name || 'PLAYER', look: profile.look, op: profile.op });
    enterQueue(mode);
  }
  function enterQueue(mode) {
    clearMatch();
    lastMode = mode; queueInfo = null; queueStart = performance.now();
    inOnlineMatch = netMode === 'online';
    $('pb-mode').textContent = { '1v1': '1V1 DUEL', '2v2': '2V2 SQUADS', extraction: '4V4 EXTRACTION' }[mode];
    startPractice();
  }
  function cancelQueue() { send({ t: 'cancel' }); stopPractice(); clearMatch(); sfx.back(); show(party && party.code ? 'party' : 'mode'); }
  // ---------- Match state ----------
  let match = null, prevState = null, curState = null, curAt = 0, interval = 33, matchOver = false;
  const actors = new Map();
  let lastPhase = '', lastCount = 0, lastRound = 0, shake = 0, endTimer = 0;
  // your own view and position run on this computer so turning and walking feel instant
  const me = { yaw: 0, pitch: 0, x: 0, y: 0, alive: true, holdYaw: 0, holdPitch: 0, burstT: 0, bursts: 0,
    stance: 'stand', running: false, slideT: 0, slideCd: 0, slideX: 0, slideY: 0, acc: 0, z: 0, vz: 0, eyeY: EYE_Y, fov: 75, roll: 0 };

  function clearMatch() {
    clearTimeout(endTimer);
    for (const a of actors.values()) { scene.remove(a.ch.root); a.ch.dispose(); a.label.remove(); if (a.rope) scene.remove(a.rope); }
    me.rap = null; me.onLadder = false; me.wantRap = false;
    actors.clear(); match = null; prevState = curState = null; matchOver = false;
    vmScene.remove(vm.group); $('feed').innerHTML = '';
    clearGrenadeFx();
    resetPanels(); clearCards(); updateZones([]); gemMesh.visible = false; $('gem-marker').hidden = true; $('ex-hud').hidden = true; $('carry-banner').hidden = true;
  }
  function clearMatchIfOver() { if (matchOver) clearMatch(); }

  function makeLabel() {
    const el = document.createElement('div'); el.className = 'nl';
    el.innerHTML = '<span class="n"></span><div class="bar"><div></div></div>';
    $('labels').appendChild(el);
    return el;
  }
  function applyInfo(a, info) {
    a.info = info;
    a.label.querySelector('.n').textContent = info.name;
    a.label.style.color = TEAM[info.team].css;
  }
  function setupMatch(msg) {
    if (!msg.practice) stopPractice();   // a real match replaces the practice range
    clearMatch();
    match = msg; matchOver = false; lastPhase = ''; lastRound = 0;
    const mine = msg.players.find(p => p.id === msg.you);
    me.op = mine.op || profile.op; me.tacLeft = 0; me.ultPct = 0; me.spdMul = 1; me.dashT = 0;
    match.myTeam = mine.team;
    for (const p of msg.players) {
      const ch = Chars.buildCharacter(p.look, TEAM[p.team].hex);
      ch.root.visible = p.id !== msg.you;      // you don't see your own body in first person
      scene.add(ch.root);
      const a = { ch, label: makeLabel(), x: 0, z: 0, speed: 0, yaw: 0, placed: false, sx: 0, sy: 0, alive: true };
      applyInfo(a, p);
      actors.set(p.id, a);
    }
    buildViewmodel(mine.look, TEAM[mine.team].hex);
    $('me-name').textContent = mine.name;
    $('me-name').style.color = TEAM[mine.team].css;
    $('h-mode').textContent = msg.mode.toUpperCase();
    for (const t of ['a', 'b']) { const el = $('pips-' + t); el.innerHTML = ''; for (let i = 0; i < msg.roundsToWin; i++) el.appendChild(document.createElement('i')).className = 'pip'; }
    const hp = $('me-hp'); hp.innerHTML = ''; for (let i = 0; i < Math.round(msg.cfg.hp / msg.cfg.dmg); i++) hp.appendChild(document.createElement('i'));
    myCd = { boom: 0, frag: 0, therm: 0 };
    me.weapon = 'rifle'; me.switchUntil = 0; updateWeaponHud();   // every match starts on the rifle
    show(msg.practice ? 'practice' : 'game');
  }

  function addFeed(killer, victim, head, src = 0) {
    const feed = $('feed'), row = document.createElement('div');
    const k = document.createElement('span'); k.className = killer.team === 'A' ? 'a' : 'b'; k.textContent = killer.name;
    const v = document.createElement('span'); v.className = victim.team === 'A' ? 'a' : 'b'; v.textContent = victim.name;
    row.append(k, head ? ' ◎ ' : [' ▸ ', ' ↺ ', ' ✹ ', ' ♨ ', ' ⁂ '][src] || ' ▸ ', v); feed.prepend(row);
    while (feed.childElementCount > 5) feed.lastChild.remove();
    setTimeout(() => row.remove(), 5000);
  }

  function onMessage(msg) {
    if (msg.t === 'party') {
      const was = party && party.code ? party.members.length : 0;
      party = msg.code ? msg : null;
      if (party && party.members.length > was && was) sfx.ready();
      refreshParty(); return;
    }
    if (msg.t === 'party_err') { sfx.denied(); toast(msg.text); return; }
    if (msg.t === 'party_queue') {   // the leader started: join the queue (practice range while waiting)
      if (ui === 'game' || ui === 'pause') return;
      sfx.select(); toast('Your party leader started a match'); enterQueue(msg.mode); return;
    }
    if (msg.t === 'party_cancel') { if (ui === 'practice') { stopPractice(); clearMatch(); show('party'); toast('The party left the queue'); } return; }
    if (msg.t === 'queued') queueInfo = msg;
    else if (msg.t === 'match') { setupMatch(msg); if (!msg.practice) sfx.select(); }
    else if (msg.t === 'notice' && match) {
      toast(msg.text);
      for (const p of msg.players) { const a = actors.get(p.id); if (a) applyInfo(a, p); }
    } else if (msg.t === 'state' && match) onState(msg);
    else if (msg.t === 'end' && match) {
      matchOver = true;
      const won = msg.winner && msg.winner === msg.youTeam;
      if (msg.winner) (won ? sfx.win : sfx.lose)();
      announce(msg.winner ? (won ? 'VICTORY' : 'DEFEAT') : 'MATCH OVER', '', won ? 'var(--good)' : 'var(--team-b)', 1400);
      endTimer = setTimeout(() => showEnd(msg), 1500);
    }
  }

  // where a player's gun is, for drawing tracers
  function muzzleOf(id, out) {
    if (id === -1 || (match && id === match.you)) {
      // just below and right of the centre of your view
      camera.getWorldDirection(tmpV);
      out.copy(camera.position).addScaledVector(tmpV, 0.6);
      out.y -= 0.18;
      return out.add(tmpV.set(Math.cos(me.yaw + Math.PI / 2), 0, Math.sin(me.yaw + Math.PI / 2)).multiplyScalar(0.16));
    }
    const a = actors.get(id);
    if (!a) return out.set(0, 0, 0);
    return a.ch.flash.parent.getWorldPosition(out);
  }

  const vFrom = new THREE.Vector3(), vTo = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpV3 = new THREE.Vector3();
  function onState(msg) {
    const now = performance.now();
    if (curAt) interval = interval * 0.9 + Math.min(100, now - curAt) * 0.1;
    prevState = curState; curState = msg; curAt = now;
    const row = msg.players.find(p => p[0] === match.you);
    updateAbilityHud(row);
    updateZones(msg.zones);
    // new round: snap your view and position back to your spawn
    if (row && msg.round !== lastRound) {
      lastRound = msg.round;
      me.yaw = row[5]; me.pitch = 0; me.x = row[1]; me.y = row[2]; me.bursts = 0;
      Object.assign(me, { stance: 'stand', running: false, slideT: 0, slideCd: 0, acc: 0, ads: false, lean: 0, z: row[13] || 0, vz: 0 });
      if (!me.weapon) me.weapon = 'rifle';
      updateWeaponHud();
    }
    if (row && row[4] && !me.alive) { me.x = row[1]; me.y = row[2]; me.z = row[13] || 0; me.vz = 0; me.yaw = row[5]; me.pitch = 0; }   // respawned
    if (row) me.alive = !!row[4];
    if (row && !row[4] && row[14] > 0 && msg.phase === 'fight') announce(`RESPAWNING IN ${row[14]}`, 'back in the far corner of your base', 'var(--cyan)', 0);
    else if (row && !row[4] && msg.phase === 'fight' && msg.ex && msg.ex.attack === match.myTeam && !match.practice) {
      const card = (msg.ex.cards || []).find(c => c[0] === match.you), by = card && card[4] && actors.get(card[4]);
      announce('KNOCKED OUT', by ? `${by.info.name} has your reboot card · they can bring you back` : 'a teammate can grab your reboot card and take it to your base', 'var(--team-b)', 0);
      me.wasWaiting = true;
    }
    else if (row && row[4] && me.wasWaiting) announce('');
    if (!(row && !row[4] && msg.phase === 'fight' && msg.ex && msg.ex.attack === match.myTeam)) me.wasWaiting = !!(row && !row[4] && row[14] > 0);

    for (const ev of msg.ev || []) {
      if (ev[0] === 'g') {
        sfx.throw();
        const a = actors.get(ev[1]); if (a && ev[1] !== match.you) a.ch.recoil = 0.7;
        continue;
      }
      if (ev[0] === 'x') { explosionFx(ev[1], ev[2], ev[3], ev[4], ev[5]); continue; }
      if (ev[0] === 'b') { sfx.bounce(); continue; }
      if (ev[0] === 'ph') { burst(ev[2] * S, ev[4] * S, ev[3] * S, 0x6fae5f, 5, 2); panelShake(ev[1]); continue; }
      if (ev[0] === 'pb') { const p = panelMeshes.get(ev[1]); if (p) { burst(p.mesh.position.x, 1.2, p.mesh.position.z, 0x6fae5f, 30, 4); burst(p.mesh.position.x, 1, p.mesh.position.z, 0x8a5a2b, 16, 3); } sfx.boom(); continue; }
      if (ev[0] === 'gx' || ev[0] === 'gp') { const a = actors.get(ev[1]); toast((a ? a.info.name : 'Someone') + (ev[0] === 'gx' ? ' extracted the gem!' : ' grabbed the gem')); sfx.ready(); continue; }
      if (ev[0] === 'gd') { toast('The gem was dropped!'); sfx.denied(); continue; }
      if (ev[0] === 'gr') { toast('The gem was returned to the middle'); continue; }
      if (ev[0] === 'gw') { continue; }
      if (ev[0] === 'ab') {
        const a = actors.get(ev[1]), op = Core.OPS[ev[3]]; if (!op) continue;
        const nm = ev[2] ? op.ult.name : op.tac.name;
        if (ev[1] === match.you) { if (ev[2]) announce(nm, op.ult.desc, op.color, 1200); sfx.ready(); }
        else if (ev[2] && a) toast(`${a.info.name} used ${nm}`);
        if (ev[3] === 'volt' && ev[2] === 0 && a) burst(a.x, 1, a.z, 0xffd23f, 12, 3);
        continue;
      }
      if (ev[0] === 'hl') { if (ev[1] === match.you) { toast('Patched up +2 health'); sfx.ready(); } continue; }
      if (ev[0] === 'cp') { const a = actors.get(ev[1]), d = actors.get(ev[2]); if (ev[1] === match.you) { announce('REBOOT CARD', `${d ? d.info.name : 'A teammate'} · take it to the back of your base`, '#5dffb4', 1800); sfx.ready(); } else if (ev[2] === match.you) toast(`${a ? a.info.name : 'A teammate'} has your reboot card`); continue; }
      if (ev[0] === 'rb') { const a = actors.get(ev[1]), d = actors.get(ev[2]); toast(`${a ? a.info.name : 'Someone'} rebooted ${d ? d.info.name : 'a teammate'}!`); sfx.ready(); if (ev[2] === match.you) announce('REBOOTED', 'back in the fight', 'var(--good)', 1200); continue; }
      if (ev[0] === 'r') { if (ev[1] === match.you) { sfx.ready(); flashClass(document.querySelector('#gren [data-g="boom"]'), 'ready', 600); } continue; }
      if (ev[0] === 's') {
        const mine = ev[1] === match.you;
        vTo.set(ev[3] * S, ev[5] * S, ev[4] * S);
        const a = actors.get(ev[1]);
        if (mine) {
          // recoil: the same kick the server uses for bots, applied to your view
          const k = Core.weaponKick(WEAPON_NAMES[ev[6] || 0], ev[2]);
          if (ev[6] === 1) vm.pumpT = 0.4;   // rack the pump
          const steady = me.ads ? 0.75 : 1;   // aiming down the sight is steadier
          me.pitch = Math.min(CP.pitchMax, me.pitch + k.pitch * steady); me.yaw += k.yaw * steady;
          vm.kick = 1; vm.flashT = 0.05; me.burstT = now; me.bursts = ev[2] + 1;
        } else if (a) { a.ch.recoil = 1; a.ch.flashT = 0.05; }
        const col = a ? TEAM[a.info.team].tracer : 0xffffff;
        muzzleOf(ev[1], vFrom);
        if (ev[6] === 1) {   // shotgun: a fan of pellet tracers around the aim point
          const d = vFrom.distanceTo(vTo);
          for (let i = 0; i < 6; i++) addTracer(vFrom, tmpV2.copy(vTo).add(tmpV3.set((Math.random() - 0.5), (Math.random() - 0.5) * 0.7, (Math.random() - 0.5)).multiplyScalar(0.06 * d)), col);
          sfx.shotgun(mine);
        } else { addTracer(vFrom, vTo, col); sfx.shoot(mine); }
      } else if (ev[0] === 'h') {
        const a = actors.get(ev[1]); if (!a) continue;
        a.ch.hitT = 1;
        burst(ev[2] * S, ev[4] * S, ev[3] * S, TEAM[a.info.team].hex, 6, 2.2);
        if (ev[6]) burst(ev[2] * S, ev[4] * S, ev[3] * S, 0xffd23f, 10, 2.5);
        if (ev[5] === match.you && ev[7] !== 3) { flashClass($('hitmark'), ev[6] ? 'head' : 'on', ev[6] ? 300 : 120); ev[6] ? sfx.headshot() : sfx.hitmark(); }
        if (ev[5] === match.you && ev[7] === 3) flashClass($('hitmark'), 'on', 80);   // burning: quiet marker
        if (ev[1] === match.you) { shake = Math.max(shake, 0.12); flashClass($('vignette'), 'on', 260); if (ev[7] !== 3) sfx.hurt(); }
      } else if (ev[0] === 'k') {
        const k = actors.get(ev[1]), v = actors.get(ev[2]); if (!k || !v) continue;
        addFeed(k.info, v.info, ev[3], ev[4]); sfx.ko();
        if (match.practice && ev[1] === match.you) {
          practiceKOs++; if (ev[3]) practiceHeads++;
          $('pb-score').textContent = practiceHeads ? `${practiceKOs} (${practiceHeads} HEADSHOT${practiceHeads > 1 ? 'S' : ''})` : practiceKOs;
        }
        burst(v.x, 1, v.z, TEAM[v.info.team].hex, 24, 3.5);
        burst(v.x, 1, v.z, 0xffffff, 8, 3);
        if (ev[1] === match.you) { announce(ev[3] ? 'HEADSHOT!' : ['KNOCKOUT!', 'BOOMERANG KO!', 'FRAGGED!', 'TORCHED!', 'SHOTGUNNED!'][ev[4] || 0], v.info.name, 'var(--yellow)', 800); flashClass($('hitmark'), 'kill', 300); }
        if (ev[2] === match.you) announce('KNOCKED OUT', 'spectating until the next round', 'var(--team-b)', 1600);
      }
    }
    // announcements from phase changes
    if (msg.phase === 'countdown') {
      const n = Math.ceil(msg.phaseT / 60);
      if (lastPhase !== 'countdown' || n !== lastCount) { announce(String(n), msg.ex ? (msg.ex.attack === match.myTeam ? 'ATTACK · EXTRACT THE GEM' : 'DEFEND THE GEM') : (msg.round === 1 ? 'MATCH FOUND' : `ROUND ${msg.round}`), '', 0); sfx.count(); lastCount = n; }
    } else if (msg.phase === 'fight' && lastPhase === 'countdown') { announce('FIGHT!', '', 'var(--yellow)', 700); sfx.fight(); }
    else if (msg.phase === 'roundEnd' && lastPhase !== 'roundEnd') {
      const w = msg.roundWinner;
      const why = { delivered: 'GEM DELIVERED', time: 'TIME RAN OUT', wiped: 'TEAM WIPED' }[msg.roundReason];
      announce(w ? `${TEAM[w].name} TAKES IT` : 'DRAW', msg.ex && why ? why : `ROUND ${msg.round}`, w ? TEAM[w].css : '', 2400);
    }
    lastPhase = msg.phase;
    syncPanels(msg);
    // HUD
    $('s-a').textContent = msg.score.A; $('s-b').textContent = msg.score.B;
    [...$('pips-a').children].forEach((p, i) => p.classList.toggle('on', i < msg.score.A));
    [...$('pips-b').children].forEach((p, i) => p.classList.toggle('on', i < msg.score.B));
    $('h-round').textContent = `ROUND ${msg.round}`;
    $('aim-hint').hidden = msg.round > 1;
    if (row) updateGrenadeHud(row);
    if (row) {
      const segs = [...$('me-hp').children], per = match.cfg.dmg;
      segs.forEach((s, i) => s.classList.toggle('off', row[3] <= i * per));
      $('me-hp').classList.toggle('low', row[3] <= per * 2);
    }
  }

  function showEnd(msg) {
    const won = msg.winner && msg.winner === msg.youTeam;
    const title = $('end-title');
    title.textContent = msg.winner ? (won ? 'VICTORY' : 'DEFEAT') : 'MATCH OVER';
    title.className = 'end-title ' + (won ? 'win' : 'lose');
    $('end-score').innerHTML = `<span style="color:var(--team-a)">BLUE ${msg.score.A}</span> &nbsp;—&nbsp; <span style="color:var(--team-b)">${msg.score.B} RED</span>`;
    const body = $('end-board'); body.innerHTML = '';
    const rows = curState ? curState.players : [];
    const kills = id => { const r = rows.find(p => p[0] === id); return r ? r[7] : 0; };
    for (const [id, a] of [...actors.entries()].sort((x, y) => kills(y[0]) - kills(x[0]))) {
      const tr = document.createElement('tr');
      const n = document.createElement('td'); n.textContent = a.info.name + (id === match.you ? '  ◀ YOU' : '');
      const t = document.createElement('td'); t.textContent = TEAM[a.info.team].name; t.style.color = TEAM[a.info.team].css;
      const k = document.createElement('td'); k.className = 'k'; k.textContent = kills(id);
      tr.append(n, t, k); body.appendChild(tr);
    }
    show('end');
  }

  function forfeit() { send({ t: 'leave' }); clearMatch(); sfx.back(); show('title'); }

  // ---------- Your controls (first person) ----------
  function controls(pad, dt) {
    const k = c => keys.has(c) || tapped.has(c);   // a very quick tap still counts for one frame
    tapped.clear();
    const playing = ui === 'game' || ui === 'practice';
    const turn = playing ? (k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0) + (pad ? pad.ax : 0) : 0;
    const look = playing ? (k('ArrowUp') ? 1 : 0) - (k('ArrowDown') ? 1 : 0) - (pad ? pad.ay : 0) : 0;
    const f = playing ? (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0) - (pad ? pad.my : 0) : 0;
    const s = playing ? (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0) + (pad ? pad.mx : 0) : 0;
    const ticks = dt * 60;
    // turning speeds up the longer you hold: tap for fine aim, hold to spin
    me.holdYaw = turn ? me.holdYaw + ticks : 0;
    me.holdPitch = look ? me.holdPitch + ticks : 0;
    const spd = h => Math.min(CP.turnMax, CP.turnMin + h * CP.turnAccel);
    const fine = me.ads ? (hcog() ? 0.4 : 0.65) : 1;   // slower, finer turning while aiming down the sight (more with more zoom)
    me.yaw += Math.sign(turn) * Math.min(1, Math.abs(turn)) * spd(me.holdYaw) * fine * ticks;
    me.pitch = Math.max(-CP.pitchMax, Math.min(CP.pitchMax, me.pitch + Math.sign(look) * Math.min(1, Math.abs(look)) * spd(me.holdPitch) * CP.pitchScale * fine * ticks));
    me.yaw = Math.atan2(Math.sin(me.yaw), Math.cos(me.yaw));
    const run = playing && ((sprintLatch && k('KeyW')) || !!(pad && pad.run));
    // Shift or C: crouch, or slide if you're running. (Not Ctrl: Ctrl+W closes the browser tab.)
    const crouch = playing && (k('ShiftLeft') || k('KeyC') || !!(pad && pad.crouch));   // right Shift is the zoom key
    return { f: Math.max(-1, Math.min(1, f)), s: Math.max(-1, Math.min(1, s)), run, crouch };
  }
  // predict your own movement with the exact same 60 Hz steps and stance rules the server uses
  function predictMove(mv, dt, free = false) {
    const canMove = free || !!(curState && curState.phase !== 'countdown' && me.alive);
    const c = Math.cos(me.yaw), sn = Math.sin(me.yaw);
    const mx = c * mv.f - sn * mv.s, my = sn * mv.f + c * mv.s;
    me.acc = Math.min(me.acc + dt * 60, 4);
    while (me.acc >= 1) { me.acc -= 1; Core.stepMovement(me, mx, my, mv.run, mv.crouch, mv.f > 0.3, canMove, me.ads); }
    if (me.stance !== 'crouch' || !me.alive) lowerSight();   // stand up (or slide, run, get knocked out) and you zoom back out
    return canMove && (Math.hypot(mx, my) > 0 || me.stance === 'slide');
  }
  let lastInput = 0, lastMove = { f: 0, s: 0, run: false, crouch: false };
  function sendInput(now) {
    if (now - lastInput < 33) return;
    lastInput = now;
    sendPlay({ t: 'input', weapon: me.weapon || 'rifle', f: lastMove.f, s: lastMove.s, run: lastMove.run, crouch: lastMove.crouch, ads: !!me.ads, lean: me.lean || 0, rap: me.rapN || 0, drop: me.dropN || 0, tac: me.tacN || 0, ult: me.ultN || 0, x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, yaw: Math.round(me.yaw * 1000) / 1000, pitch: Math.round(me.pitch * 1000) / 1000 });
  }

  // what's under the centre crosshair? Same test as the server (core.castRay): body height depends on
  // stance, the top of the body is the head. Nobody can shoot while running. Returns { c, along, h, head } or null.
  function rayHit(cands) {
    if (me.running) return null;
    const [eyeX, eyeY] = Core.eyePos(me.x, me.y, me.yaw, me.lean || 0);
    const W = Core.WEAPONS[me.weapon || 'rifle'];
    if (performance.now() < (me.switchUntil || 0)) return null;
    const hit = Core.castRay(eyeX, eyeY, (me.z || 0) + Core.STANCES[me.stance].eye, me.yaw, me.pitch,
      cands.map(c => ({ x: c.sx, y: c.sy, z: c.sz || 0, stance: c.stance || 'stand', ref: c })), W.spread);
    return hit && hit.along <= W.range ? { c: hit.c.ref, along: hit.along, h: hit.h, head: hit.head } : null;
  }
  function onTargetNow() {
    if (!curState || !me.alive) return false;
    return !!rayHit([...actors.values()].filter(a => a.alive && a.info.team !== match.myTeam));
  }

  // ---------- Practice range (while matchmaking) ----------
  // A private match against training dummies, run by the game core on this computer
  // (Core.createPractice): same movement, shooting, headshots and grenades as a real match.
  let practiceRun = null, practiceStart = 0, practiceKOs = 0, practiceHeads = 0;
  function startPractice() {
    stopPractice();
    practiceStart = performance.now(); practiceKOs = practiceHeads = 0;
    $('pb-score').textContent = '0';
    const run = Core.createPractice(msg => setTimeout(() => { if (practiceRun === run) onMessage(msg); }, 0), profile.name || 'PLAYER', profile.look, profile.op);
    practiceRun = run;
  }
  function stopPractice() { if (practiceRun) { practiceRun.stop(); practiceRun = null; } }
  // in-match messages go to the practice range or the real server
  function sendPlay(msg) {
    if (match && match.practice) { if (practiceRun) practiceRun.receive(JSON.parse(JSON.stringify(msg))); }
    else send(msg);
  }

  // ---------- Grenades (Q boomerang, E frag, F thermite) ----------
  const GREN_KEYS = { KeyR: 'boom', KeyG: 'frag', KeyF: 'therm' };
  let myCd = { boom: 0, frag: 0, therm: 0 };
  function requestThrow(kind) {
    if (!match || !curState || !me.alive || curState.phase !== 'fight' || myCd[kind] > 0) { if (myCd[kind] > 0) sfx.denied(); return; }
    myCd[kind] = 1;   // until the server confirms
    sendPlay({ t: 'throw', g: kind, yaw: Math.round(me.yaw * 1000) / 1000, pitch: Math.round(me.pitch * 1000) / 1000 });
    vm.throwT = 0.35;
  }
  // Hold a grenade key to see where it will go (aim with the arrow keys), let go to throw.
  let aiming = null;
  const AIM_COLOR = { boom: 0xffd23f, frag: 0xff9a3c, therm: 0xff5a1a };
  const KEY_OF = { boom: 'R', frag: 'G', therm: 'F' };
  function startAim(kind) {
    if (!match || !curState || !me.alive || curState.phase !== 'fight') return;
    if (myCd[kind] > 0) { sfx.denied(); return; }
    aiming = kind;
    $('aim-tip').textContent = `RELEASE ${KEY_OF[kind]} TO THROW · ARROWS TO AIM`;
    $('aim-tip').hidden = false;
  }
  function releaseAim(kind) {
    if (aiming !== kind) return;
    cancelAim();
    requestThrow(kind);
  }
  function cancelAim() { aiming = null; preview.visible = false; $('aim-tip').hidden = true; }

  const PREVIEW_MAX = 402;
  const preview = new THREE.Group(); preview.visible = false; scene.add(preview);
  const pvGeo = new THREE.BufferGeometry(); pvGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREVIEW_MAX * 3), 3));
  const pvMat = new THREE.LineDashedMaterial({ color: 0xffd23f, dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.9 });
  const pvLine = new THREE.Line(pvGeo, pvMat); pvLine.frustumCulled = false; preview.add(pvLine);
  const pvRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), basic(0xff9a3c, { transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  pvRing.rotation.x = -Math.PI / 2; preview.add(pvRing);
  const pvDot = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), basic(0xffffff)); preview.add(pvDot);
  const pvFire = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 0.45), basic(0xff5a1a, { transparent: true, opacity: 0.55, depthWrite: false })); preview.add(pvFire);
  function updateAimPreview(now) {
    if (!aiming || !me.alive || !curState || curState.phase !== 'fight') { if (aiming) cancelAim(); return; }
    const r = Core.predictThrow(aiming, me.x, me.y, me.stance, me.yaw, me.pitch, me.z || 0);
    if (!r) { preview.visible = false; return; }
    preview.visible = true;
    const arr = pvGeo.attributes.position.array, n = Math.min(PREVIEW_MAX, r.points.length);
    for (let i = 0; i < n; i++) { const [x, y, z] = r.points[i]; arr[i * 3] = x * S; arr[i * 3 + 1] = z * S + 0.04; arr[i * 3 + 2] = y * S; }
    pvGeo.attributes.position.needsUpdate = true; pvGeo.setDrawRange(0, n);
    pvLine.computeLineDistances();
    pvMat.color.set(AIM_COLOR[aiming]);
    const [ex, ey, ez] = r.end;
    pvDot.position.set(ex * S, ez * S + 0.1, ey * S); pvDot.rotation.y = now * 0.004;
    // frag: blast radius on the floor; boomerang: its blast radius where it turns back; thermite: the fire wall
    pvRing.visible = aiming !== 'therm';
    if (pvRing.visible) {
      const g = CP.gren[aiming], rad = g.radius * S;
      let rx = ex, ry = ey;
      if (aiming === 'boom') { const far = r.points.reduce((a, p) => (Math.hypot(p[0] - me.x, p[1] - me.y) > Math.hypot(a[0] - me.x, a[1] - me.y) ? p : a)); rx = far[0]; ry = far[1]; }
      pvRing.position.set(rx * S, 0.04, ry * S); pvRing.scale.setScalar(rad);
      pvRing.material.color.set(AIM_COLOR[aiming]);
    }
    pvFire.visible = !!r.fire;
    if (r.fire) {
      const [x1, y1, x2, y2] = r.fire;
      pvFire.position.set((x1 + x2) / 2 * S, 0.05, (y1 + y2) / 2 * S);
      pvFire.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
      pvFire.scale.x = Math.hypot(x2 - x1, y2 - y1) * S;
    }
  }

  function updateGrenadeHud(row) {
    myCd = { boom: row[9] || 0, frag: row[10] || 0, therm: row[11] || 0 };
    for (const el of document.querySelectorAll('#gren .g')) {
      const v = myCd[el.dataset.g];
      el.classList.toggle('cooling', v > 0);
      const t = v > 0 ? String(Math.ceil(v / 10)) : '';
      const cd = el.querySelector('.cd');
      if (cd.textContent !== t) cd.textContent = t;
    }
  }

  const projMeshes = new Map(), fires = new Map(), blasts = [];
  const gMat = { boom: lam(0xffd23f), frag: lam(0x48613f), band: basic(0xffd23f), therm: lam(0xff7a1a), cap: basic(0xffe08a) };
  const gGeo = {
    blade: new THREE.BoxGeometry(0.3, 0.05, 0.09), tip: new THREE.BoxGeometry(0.08, 0.06, 0.1),
    frag: new THREE.IcosahedronGeometry(0.11, 0), band: new THREE.CylinderGeometry(0.115, 0.115, 0.03, 8),
    therm: new THREE.CylinderGeometry(0.07, 0.07, 0.24, 6), cap: new THREE.CylinderGeometry(0.074, 0.074, 0.04, 6),
  };
  function makeProjMesh(kind, team) {
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; g.add(m); };
    if (kind === 0) {          // boomerang: a V of two blades, team-coloured tips
      add(gGeo.blade, gMat.boom, 0.11, 0, 0.06, 0.55); add(gGeo.blade, gMat.boom, -0.11, 0, 0.06, -0.55);
      const tipMat = basic(TEAM[team].hex);
      add(gGeo.tip, tipMat, 0.24, 0, -0.02); add(gGeo.tip, tipMat, -0.24, 0, -0.02);
    } else if (kind === 1) {   // frag
      add(gGeo.frag, gMat.frag, 0, 0, 0); add(gGeo.band, gMat.band, 0, 0, 0);
    } else {                   // thermite canister
      add(gGeo.therm, gMat.therm, 0, 0, 0); add(gGeo.cap, gMat.cap, 0, 0.13, 0);
    }
    scene.add(g);
    return g;
  }
  const flameGeo = new THREE.ConeGeometry(0.2, 0.9, 5); flameGeo.translate(0, 0.45, 0);
  const flameMats = [0xff4a12, 0xffa01a, 0xffe27a].map(c => basic(c, { transparent: true, opacity: 0.85, depthWrite: false }));
  const fireGlowMat = basic(0xff6a00, { transparent: true, opacity: 0.4, depthWrite: false });
  function makeFire(f) {
    const [, x1, y1, x2, y2] = f, g = new THREE.Group(), flames = [];
    g.position.y = (f[7] || 0) * S;
    const len = Math.hypot(x2 - x1, y2 - y1) * S, n = 11;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1), m = new THREE.Mesh(flameGeo, flameMats[i % 3]);
      m.position.set((x1 + (x2 - x1) * k) * S + (Math.random() - 0.5) * 0.15, 0, (y1 + (y2 - y1) * k) * S + (Math.random() - 0.5) * 0.15);
      g.add(m); flames.push({ m, ph: Math.random() * 6, h: 0.8 + Math.random() * 0.7 });
    }
    const glow = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 0.55), fireGlowMat);
    glow.position.set((x1 + x2) / 2 * S, 0.02, (y1 + y2) / 2 * S); glow.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
    g.add(glow);
    scene.add(g);
    return { g, flames, glow };
  }
  const blastGeo = new THREE.SphereGeometry(1, 10, 6);
  function explosionFx(x, y, z, src, radius) {
    const wx = x * S, wy = Math.max(0.25, z * S), wz = y * S;
    const mesh = new THREE.Mesh(blastGeo, basic(src === 3 ? 0xff7a1a : 0xffb347, { transparent: true, opacity: 0.7, depthWrite: false }));
    mesh.position.set(wx, wy, wz); scene.add(mesh);
    blasts.push({ mesh, t: 0, r: radius * S });
    burst(wx, wy, wz, 0xffb347, src === 3 ? 10 : 22, 5);
    burst(wx, wy, wz, 0xff4a12, src === 3 ? 8 : 14, 4);
    if (src !== 3) burst(wx, wy, wz, 0xffffff, 6, 3);
    src === 3 ? sfx.ignite() : sfx.boom();
    const d = Math.hypot(x - me.x, y - me.y);
    shake = Math.max(shake, (src === 3 ? 0.12 : 0.4) * Math.max(0, 1 - d / 320));
  }
  function updateGrenadeFx(dt, now, a) {
    // projectiles, interpolated between server updates
    const prevP = prevState && prevState.proj ? new Map(prevState.proj.map(p => [p[0], p])) : new Map();
    const seen = new Set();
    for (const p of curState.proj || []) {
      seen.add(p[0]);
      let o = projMeshes.get(p[0]);
      if (!o) { o = { mesh: makeProjMesh(p[1], p[5]), kind: p[1] }; projMeshes.set(p[0], o); }
      const q = prevP.get(p[0]) || p;
      o.mesh.position.set((q[2] + (p[2] - q[2]) * a) * S, (q[4] + (p[4] - q[4]) * a) * S + 0.08, (q[3] + (p[3] - q[3]) * a) * S);
      if (o.kind === 0) o.mesh.rotation.y += dt * 24; else { o.mesh.rotation.x += dt * 9; o.mesh.rotation.z += dt * 6; }
    }
    for (const [id, o] of projMeshes) if (!seen.has(id)) { scene.remove(o.mesh); projMeshes.delete(id); }
    // fire walls
    const live = new Set();
    for (const f of curState.fires || []) {
      live.add(f[0]);
      let o = fires.get(f[0]);
      if (!o) { o = makeFire(f); fires.set(f[0], o); }
      const fade = Math.min(1, f[5] / 40);
      for (const fl of o.flames) fl.m.scale.set(1, fl.h * (0.7 + 0.35 * Math.sin(now * 0.014 + fl.ph)) * fade, 1);
    }
    for (const [id, o] of fires) if (!live.has(id)) { scene.remove(o.g); o.glow.geometry.dispose(); fires.delete(id); }
  }
  function updateBlasts(dt) {
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i]; b.t += dt;
      const k = b.t / 0.35;
      if (k >= 1) { scene.remove(b.mesh); b.mesh.material.dispose(); blasts.splice(i, 1); continue; }
      b.mesh.scale.setScalar(b.r * (0.25 + 0.85 * k));
      b.mesh.material.opacity = 0.7 * (1 - k);
    }
  }
  function clearGrenadeFx() {
    cancelAim();
    for (const o of projMeshes.values()) scene.remove(o.mesh);
    for (const o of fires.values()) { scene.remove(o.g); o.glow.geometry.dispose(); }
    for (const b of blasts) { scene.remove(b.mesh); b.mesh.material.dispose(); }
    projMeshes.clear(); fires.clear(); blasts.length = 0;
  }

  // ---------- Weapons: 1 rifle, 2 shotgun ----------
  const WEAPON_NAMES = Core.WEAPON_BY_CODE;
  function pickWeapon(w) {
    if (!me.alive || me.weapon === w) return;
    me.weapon = w; me.switchUntil = performance.now() + 400; me.bursts = 0; me.armSince = 0;
    vm.switchT = 0.4; sfx.swap();
    updateWeaponHud();
  }
  function updateWeaponHud() {
    for (const el of document.querySelectorAll('#weapons .w')) el.classList.toggle('active', el.dataset.w === me.weapon);
    $('optic-tag').textContent = profile.optic === 'hcog' ? '2.5X' : '1.3X';
    if (vm.optics) { vm.optics.hog.visible = profile.optic !== 'hcog'; vm.optics.hcog.visible = profile.optic === 'hcog'; }
  }

  // ---------- Operator abilities: Space tactical, Caps Lock ultimate ----------
  function useTactical() {
    const op = Core.OPS[me.op]; if (!op || !me.alive) return;
    if (me.tacLeft > 0) { sfx.denied(); toast(`${op.tac.name} ready in ${me.tacLeft} s`); return; }
    me.tacN = (me.tacN || 0) + 1;
    if (me.op === 'volt') {   // blink right away on this computer too (the server does the same)
      const c = Math.cos(me.yaw), sn = Math.sin(me.yaw);
      Core.startDash(me, c * lastMove.f - sn * lastMove.s, sn * lastMove.f + c * lastMove.s);
    }
    me.tacLeft = op.tac.cd;   // until the server says otherwise
  }
  function useUltimate() {
    const op = Core.OPS[me.op]; if (!op || !me.alive) return;
    if ((me.ultPct || 0) < 100) { sfx.denied(); toast(`${op.ult.name} charging: ${me.ultPct || 0}%`); return; }
    me.ultN = (me.ultN || 0) + 1;
  }
  function updateAbilityHud(row) {
    const op = Core.OPS[me.op]; if (!op || !row) return;
    me.tacLeft = row[15] || 0; me.ultPct = row[16] || 0;
    const fx = row[17] || 0;
    me.spdMul = (fx & 2 ? 1.35 : 1) * (fx & 8 ? 0.6 : 1);
    const t = document.querySelector('#abil [data-a="tac"]'), u = document.querySelector('#abil [data-a="ult"]');
    t.querySelector('span').textContent = op.tac.name; u.querySelector('span').textContent = op.ult.name;
    t.querySelector('b').textContent = me.tacLeft > 0 ? me.tacLeft + 's' : 'READY';
    u.querySelector('b').textContent = me.ultPct >= 100 ? 'READY' : me.ultPct + '%';
    t.classList.toggle('ready', !me.tacLeft); u.classList.toggle('ready', me.ultPct >= 100);
    u.style.setProperty('--fill', me.ultPct + '%');
    $('abil-op').textContent = op.name; $('abil-op').style.color = op.color;
    $('me-fx').textContent = [fx & 1 ? 'OVERDRIVE' : '', fx & 2 ? 'RUSH' : '', fx & 8 ? 'SLOWED' : '', fx & 4 ? 'REVEALED' : ''].filter(Boolean).join(' · ');
  }
  // ability zones in the world: dome, smoke cloud, lockdown ring
  const zoneMeshes = new Map();
  function zoneMesh(k, r, team) {
    const g = new THREE.Group(), col = k === 'smoke' ? 0x9aa0a8 : k === 'lock' ? 0xc58bff : TEAM[team].hex;
    if (k === 'dome') {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(r * S, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), basic(col, { transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })));
      g.add(new THREE.Mesh(new THREE.SphereGeometry(r * S, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), basic(col, { wireframe: true, transparent: true, opacity: 0.45 })));
    } else if (k === 'smoke') {
      for (let i = 0; i < 7; i++) {
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r * S * (0.55 + Math.random() * 0.25), 1), lam(col, { transparent: true, opacity: 0.88 }));
        const a = i / 7 * Math.PI * 2, d = i ? r * S * 0.45 : 0;
        puff.position.set(Math.cos(a) * d, 30 * S + (Math.random() - 0.5) * 0.6, Math.sin(a) * d); g.add(puff);
      }
    } else {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * S - 0.15, r * S, 40), basic(col, { transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(r * S, r * S, 1.2, 40, 1, true), basic(col, { transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
      wall.position.y = 0.6; g.add(ring, wall);
    }
    scene.add(g); return g;
  }
  function updateZones(zones) {
    const live = new Set();
    Core.setZones((zones || []).map(([k, x, y, r]) => ({ k, x, y, r })));
    (zones || []).forEach(([k, x, y, r, t, team], i) => {
      const key = k + ':' + Math.round(x) + ':' + Math.round(y); live.add(key);
      if (!zoneMeshes.has(key)) zoneMeshes.set(key, zoneMesh(k, r, team));
      zoneMeshes.get(key).position.set(x * S, 0, y * S);
    });
    for (const [key, m] of zoneMeshes) if (!live.has(key)) { scene.remove(m); zoneMeshes.delete(key); }
  }

  // ---------- Aiming down the sight + leaning ----------
  // While crouched, tap Q or E: raise the sight (1.3x zoom, HOG-style ring sight). While aiming, Q leans left
  // and E leans right (tap the same key again to straighten up). Space lowers the sight; standing up does too.
  const ADS_FOV = 2 * Math.atan(Math.tan(75 / 2 * Math.PI / 180) / 1.3) * 180 / Math.PI;   // 1.3x zoom over the 75 deg view
  const ADS_FOV_SG = 2 * Math.atan(Math.tan(75 / 2 * Math.PI / 180) / 1.15) * 180 / Math.PI; // shotgun: lighter 1.15x
  const ADS_FOV_HCOG = 2 * Math.atan(Math.tan(75 / 2 * Math.PI / 180) / 2.5) * 180 / Math.PI; // Alternator with the 2.5x HCOG
  const hcog = () => me.weapon !== 'shotgun' && profile.optic === 'hcog';
  // T: switch the Alternator's optic between the 1.3x HOG ring and the 2.5x HCOG
  function switchOptic() {
    profile.optic = profile.optic === 'hcog' ? 'hog' : 'hcog'; store.set('profile', profile);
    sfx.swap(); updateWeaponHud();
    const tip = $('aim-tip'); tip.textContent = profile.optic === 'hcog' ? 'ALTERNATOR · 2.5X HCOG' : 'ALTERNATOR · 1.3X HOG';
    tip.hidden = false; clearTimeout(tip._t); tip._t = setTimeout(() => { if (!aiming) tip.hidden = true; }, 1100);
  }
  function sightKey(side) {
    if (!me.alive) return;
    if (me.stance !== 'crouch') {   // you can only aim down the sight while crouched
      sfx.denied();
      const tip = $('aim-tip'); tip.textContent = 'CROUCH (SHIFT / C) TO AIM'; tip.hidden = false;
      clearTimeout(tip._t); tip._t = setTimeout(() => { if (!aiming) tip.hidden = true; }, 900);
      return;
    }
    if (!me.ads) { me.ads = true; me.lean = 0; sfx.move(); return; }
    me.lean = me.lean === side ? 0 : side;
  }
  function lowerSight() { me.ads = false; me.lean = 0; }

  // ---------- Shared first-person helpers ----------
  // camera height follows your stance; faster bob and wider view when running, low tilted view when sliding
  function fpCamera(dt, moving) {
    me.eyeY += (Core.STANCES[me.stance].eye * S - me.eyeY) * Math.min(1, dt * 14);
    vm.bob += dt * (moving ? (me.running ? 14 : me.stance === 'crouch' ? 6 : 9) : 2);
    const bob = moving && me.stance !== 'slide' ? Math.abs(Math.sin(vm.bob)) * (me.running ? 0.06 : 0.035) : 0;
    // leaning slides the camera sideways (stopping short of walls) and tilts it
    me.leanAmt = (me.leanAmt || 0) + ((me.lean || 0) - (me.leanAmt || 0)) * Math.min(1, dt * 12);
    const side = me.leanAmt < 0 ? -1 : 1, [lx, ly] = Core.eyePos(me.x, me.y, me.yaw, Math.abs(me.leanAmt) > 0.01 ? side : 0);
    const lk = Math.abs(me.leanAmt);
    wantPos.set((me.x + (lx - me.x) * lk) * S, (me.z || 0) * S + me.eyeY + bob, (me.y + (ly - me.y) * lk) * S);
    const fov = me.stance === 'slide' ? 86 : me.running ? 82 : me.ads ? (me.weapon === 'shotgun' ? ADS_FOV_SG : hcog() ? ADS_FOV_HCOG : ADS_FOV) : 75;
    me.fov += (fov - me.fov) * Math.min(1, dt * 8);
    setFov(Math.round(me.fov * 10) / 10);
    me.roll += ((me.stance === 'slide' ? 0.07 : 0) - me.leanAmt * 0.14 - me.roll) * Math.min(1, dt * 10);
  }
  function updateReticle(onTarget, now) {
    const ret = $('reticle');
    ret.hidden = false;
    // yellow while the trigger delay counts down, red once the gun is firing
    if (onTarget) { if (!me.armSince) me.armSince = now; } else me.armSince = 0;
    const armed = onTarget && now - me.armSince >= CP.fireDelay * 1000 / 60;
    ret.classList.toggle('arming', onTarget && !armed);
    onTarget = armed;
    ret.classList.toggle('on', onTarget);
    ret.classList.toggle('off', me.running);           // can't shoot while running
    // aiming down the sight: the ring sight replaces the crosshair (same yellow/red states), tilted with a lean
    const scope = $('scope');
    scope.classList.toggle('on', !!me.ads);
    scope.classList.toggle('sg', me.weapon === 'shotgun');   // shotgun: spread-bracket sight instead of the ring
    scope.classList.toggle('hc', hcog());                     // Alternator 2.5x: boxy HCOG with a chevron reticle
    scope.classList.toggle('arming', ret.classList.contains('arming'));
    scope.classList.toggle('hot', onTarget);
    scope.style.transform = `rotate(${(-me.roll).toFixed(3)}rad)`;
    ret.style.visibility = me.ads ? 'hidden' : '';
    if (now - me.burstT > 380) me.bursts = 0;
    const base = me.weapon === 'shotgun' ? 16 : 7;
    ret.style.setProperty('--spread', `${(me.running ? 14 : base) + Math.min(10, me.bursts * 1.6)}px`);
    // shotgun pump: the slot's bar refills between shots
    const pumpLeft = Math.max(0, (vm.pumpT || 0) / 0.4);
    const bar = document.querySelector('#weapons [data-w="shotgun"] .pump > i');
    if (bar) bar.style.width = `${(1 - pumpLeft) * 100}%`;
    $('me-fire').classList.toggle('on', onTarget);
    $('me-recoil').style.width = `${Math.min(1, me.bursts / 7) * 100}%`;
    const lean = me.lean < 0 ? ' · LEANING LEFT' : me.lean > 0 ? ' · LEANING RIGHT' : '';
    const st = me.stance === 'slide' ? 'SLIDING' : me.running ? 'RUNNING · can’t shoot' : (me.ads ? 'AIMING' + lean : me.stance === 'crouch' ? 'CROUCHED · Q/E to aim' : '');
    if ($('me-stance').textContent !== st) $('me-stance').textContent = st;
  }
  // gun: kick on each shot, lowered and turned while running
  function animateViewmodel(dt, moving) {
    vm.group.visible = true;
    vm.kick = Math.max(0, vm.kick - dt * 10);
    vm.flashT -= dt; vm.flash.visible = vm.flashT > 0;
    vm.run += ((me.running ? 1 : 0) - vm.run) * Math.min(1, dt * 10);
    const sway = moving ? Math.sin(vm.bob) * (me.running ? 0.02 : 0.012) : 0;
    vm.ads = (vm.ads || 0) + ((me.ads ? 1 : 0) - (vm.ads || 0)) * Math.min(1, dt * 14);
    const a = vm.ads, sw = sway * (1 - a * 0.7);
    vm.group.position.set((0.17 + sw + vm.run * 0.04) * (1 - a), (-0.17 - Math.abs(sw) * 0.6 - vm.run * 0.08) * (1 - a) - 0.105 * a, -0.5 + vm.kick * 0.05 * (1 - a * 0.5) + 0.06 * a);
    if (vm.guns) { vm.guns.rifle.visible = me.weapon !== 'shotgun'; vm.guns.shotgun.visible = me.weapon === 'shotgun'; }
    if (vm.optics) vm.optics.hcog.visible = profile.optic === 'hcog' && a < 0.5;   // looking through the HCOG: its housing is the frame on screen
    vm.switchT = Math.max(0, (vm.switchT || 0) - dt);
    vm.group.position.y -= Math.sin(Math.min(1, vm.switchT / 0.4) * Math.PI) * 0.18;
    vm.pumpT = Math.max(0, (vm.pumpT || 0) - dt);
    const rack = Math.sin(Math.min(1, vm.pumpT / 0.4) * Math.PI);
    if (vm.pump) vm.pump.position.z = -0.36 + rack * 0.1;
    if (vm.lever) vm.lever.rotation.x = rack * 0.9;
    vm.flash.position.z = me.weapon === 'shotgun' ? -0.86 : -0.5;   // muzzle flash at the end of the long barrel
    vm.throwT = Math.max(0, (vm.throwT || 0) - dt);
    const th = Math.sin(Math.min(1, (0.35 - vm.throwT) / 0.35) * Math.PI) * (vm.throwT > 0 ? 1 : 0);
    vm.group.position.y -= th * 0.12;
    vm.group.rotation.set(vm.kick * 0.12 - vm.run * 0.35 - th * 0.5, vm.run * 0.6, vm.run * 0.25 + th * 0.3);
  }

  // ---------- Per-frame update ----------
  const camPos = new THREE.Vector3(SHOW.x - 1.8, 2.2, SHOW.z + 6), camLook = new THREE.Vector3(SHOW.x - 1.8, 1.1, SHOW.z);
  const wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3(), proj = new THREE.Vector3();
  const lerpAngle = (a, b, t) => { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
  let firstPerson = false;

  function setFov(f) { if (camera.fov !== f) { camera.fov = f; camera.updateProjectionMatrix(); } }

  // ---------- Green panels + Extraction (gem, HUD) ----------
  const brokenNow = new Set();
  function resetPanels() {
    brokenNow.clear(); Core.setBroken(brokenNow);
    for (const p of panelMeshes.values()) { p.mesh.visible = true; p.mat.color.copy(p.base); p.mesh.position.x = p.mesh.position.x; p.shake = 0; }
  }
  function syncPanels(msg) {
    const list = msg.broken || [];
    if (list.length !== brokenNow.size || list.some(i => !brokenNow.has(i))) {
      if (list.length < brokenNow.size) resetPanels();   // new round: panels rebuilt
      for (const i of list) { brokenNow.add(i); const p = panelMeshes.get(i); if (p) p.mesh.visible = false; }
    }
    for (const [i, hp] of msg.panels || []) {   // darker as it gets shot up
      const p = panelMeshes.get(i); if (p) p.mat.color.copy(p.base).multiplyScalar(0.45 + 0.55 * Math.max(0, hp) / CP.panelHp);
    }
  }
  function panelShake(i) { const p = panelMeshes.get(i); if (p) p.shake = 0.15; }
  const gemMesh = new THREE.Group();
  {
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), basic(0x5dffb4));
    const shell = new THREE.Mesh(new THREE.OctahedronGeometry(0.46, 0), basic(0x5dffb4, { transparent: true, opacity: 0.25, depthWrite: false }));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 8, 6), basic(0x5dffb4, { transparent: true, opacity: 0.35, depthWrite: false }));
    beam.position.y = 4; gemMesh.add(core, shell, beam); gemMesh.visible = false; scene.add(gemMesh);
    gemMesh.userData.beam = beam;
  }
  const pedestalGem = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.4, 8), lam(0x55595f));
  pedestalGem.position.set(MAP.gem[0] * S, 0.2, MAP.gem[1] * S); scene.add(pedestalGem);
  // reboot cards (flat glowing cards that float where an attacker fell) and each base's reboot point
  const cardMeshes = new Map();
  const rebootMarks = {};
  for (const t of ['A', 'B']) {
    const [rx, ry] = MAP.reboot[t], g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.75, 24), basic(TEAM[t].hex, { transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), basic(TEAM[t].hex, { transparent: true, opacity: 0.5, depthWrite: false }));
    post.position.y = 1.3; g.add(ring, post); g.position.set(rx * S, 0, ry * S); g.visible = false; scene.add(g);
    rebootMarks[t] = g;
  }
  function cardMesh() {
    const g = new THREE.Group();
    const card = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.56, 0.04), basic(0x5dffb4));
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.7, 0.02), basic(0x5dffb4, { transparent: true, opacity: 0.3, depthWrite: false }));
    g.add(card, glow); scene.add(g); return g;
  }
  function updateCards(ex, now) {
    const seen = new Set();
    for (const [id, x, y, z, carrier] of ex.cards || []) {
      seen.add(id);
      let m = cardMeshes.get(id); if (!m) { m = cardMesh(); cardMeshes.set(id, m); }
      if (carrier) { const a = actors.get(carrier); m.visible = carrier !== match.you && !!a; if (a) m.position.set(a.x, a.ch.root.position.y + 2.5, a.z); }
      else { m.visible = true; m.position.set(x * S, z * S + 0.7 + Math.sin(now * 0.004 + id) * 0.1, y * S); }
      m.rotation.y = now * 0.003 + id;
    }
    for (const [id, m] of cardMeshes) if (!seen.has(id)) { scene.remove(m); cardMeshes.delete(id); }
    const myCards = (ex.cards || []).filter(c => c[4] === match.you), mine = myCards.length;
    // whose cards you're carrying, shown above your name and health
    const mc = $('me-cards'), names = myCards.map(c => (actors.get(c[0]) ? actors.get(c[0]).info.name : '?')).join(' · ');
    mc.hidden = !mine;
    if (mine && mc.textContent !== '♻ REBOOT: ' + names) mc.textContent = '♻ REBOOT: ' + names;
    const atk = ex.attack === match.myTeam;
    for (const t of ['A', 'B']) rebootMarks[t].visible = atk && t === match.myTeam;
    const cb = $('card-banner');
    cb.hidden = !(mine && atk);
    if (mine) cb.textContent = `${mine} REBOOT CARD${mine > 1 ? 'S' : ''} · TAKE ${mine > 1 ? 'THEM' : 'IT'} TO THE BACK OF YOUR BASE`;
  }
  function clearCards() { for (const m of cardMeshes.values()) scene.remove(m); cardMeshes.clear(); for (const t of ['A', 'B']) rebootMarks[t].visible = false; $('card-banner').hidden = true; $('me-cards').hidden = true; }
  function updateExtraction(dt, now) {
    for (const p of panelMeshes.values()) if (p.shake > 0) { p.shake = Math.max(0, p.shake - dt); p.mesh.rotation.y = (Math.random() - 0.5) * p.shake * 0.2; }
    const ex = curState && curState.ex;
    const hud = $('ex-hud');
    if (!ex || match.practice) { hud.hidden = true; gemMesh.visible = false; $('gem-marker').hidden = true; $('carry-banner').hidden = true; clearCards(); return; }
    hud.hidden = false;
    updateCards(ex, now);
    const [state, gx, gy, carrier, prog] = ex.gem;
    const attacking = ex.attack === match.myTeam;
    $('ex-role').textContent = attacking ? 'ATTACK' : 'DEFEND';
    $('ex-role').className = attacking ? 'atk' : 'def';
    $('ex-time').textContent = `${Math.floor(ex.time / 60)}:${String(ex.time % 60).padStart(2, '0')}`;
    $('ex-time').classList.toggle('low', ex.time <= 30);
    const carrierName = carrier && actors.get(carrier) ? actors.get(carrier).info.name : '';
    $('ex-gem').textContent = state === 0 ? (prog > 0 ? `EXTRACTING ${prog}%` : (attacking ? 'Stand at the gem for 3 s to extract it' : 'Keep them off the gem'))
      : state === 1 ? (carrier === match.you ? 'YOU HAVE THE GEM' : `${carrierName} HAS THE GEM`) : (attacking ? 'GEM DROPPED · pick it up' : 'GEM DROPPED · touch it to send it back');
    $('ex-bar').style.width = `${state === 0 ? prog : 0}%`;
    $('carry-banner').hidden = !(state === 1 && carrier === match.you);
    // gem in the world: on its pedestal, above its carrier's head, or on the floor
    let wx = gx * S, wz = gy * S, wy = state === 0 ? 1.1 : 0.5;
    if (state === 1) { const a = actors.get(carrier); if (a) { wx = a.x; wz = a.z; } wy = 2.4; }
    gemMesh.visible = !(state === 1 && carrier === match.you);
    gemMesh.position.set(wx, wy + Math.sin(now * 0.003) * 0.08, wz);
    gemMesh.rotation.y = now * 0.002;
    // on-screen marker so everyone can always find the gem
    const mk = $('gem-marker');
    proj.set(wx, wy + 0.6, wz).project(camera);
    const show = proj.z < 1 && !(state === 1 && carrier === match.you);
    mk.hidden = !show;
    if (show) {
      mk.style.left = `${Math.max(20, Math.min(innerWidth - 20, (proj.x * 0.5 + 0.5) * innerWidth))}px`;
      mk.style.top = `${Math.max(60, Math.min(innerHeight - 20, (-proj.y * 0.5 + 0.5) * innerHeight))}px`;
      const d = Math.round(Math.hypot(gx - me.x, gy - me.y) / 24);
      mk.textContent = `◆ ${d} m`;
    }
  }

  function updateMatch(dt, now) {
    if (!curState) return;
    Core.setBroken(brokenNow);   // your own movement/aim checks use the panels you can see broken
    updateExtraction(dt, now);
    const mv = controls(lastPad, dt);
    lastMove = mv;
    const moving = predictMove(mv, dt);
    if (ui === 'game' || ui === 'pause' || ui === 'practice') sendInput(now);
    updateGrenadeFx(dt, now, prevState ? Math.min(1, (now - curAt) / interval) : 1);
    updateAimPreview(now);
    if (match.practice) {
      const secs = Math.floor((now - practiceStart) / 1000);
      $('pb-clock').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }

    const a = prevState ? Math.min(1, (now - curAt) / interval) : 1;
    const prev = prevState ? new Map(prevState.players.map(p => [p[0], p])) : new Map();
    for (const p of curState.players) {
      const act = actors.get(p[0]); if (!act) continue;
      const q = prev.get(p[0]) || p;
      act.sx = q[1] + (p[1] - q[1]) * a; act.sy = q[2] + (p[2] - q[2]) * a; act.alive = !!p[4];
      act.stance = ['stand', 'crouch', 'slide'][p[8] & 3] || 'stand';
      act.sz = (q[13] || 0) + ((p[13] || 0) - (q[13] || 0)) * a;
      act.lean = p[8] & 16 ? -1 : p[8] & 32 ? 1 : 0;
      const w = (p[12] || 0) & 1 ? 'shotgun' : 'rifle';
      if (act.weapon !== w) { act.weapon = w; act.ch.setWeapon(w); }
      if (p[0] === match.you) {
        // keep the prediction honest: ease toward the server when idle, snap if far off
        const err = Math.hypot(act.sx - me.x, act.sy - me.y);
        if (err > 36 || !me.alive) { me.x = act.sx; me.y = act.sy; me.z = act.sz; me.vz = 0; }
        else if (!moving) { me.x += (act.sx - me.x) * 0.15; me.y += (act.sy - me.y) * 0.15; }
        act.label.style.display = 'none';
        continue;
      }
      const x = act.sx * S, z = act.sy * S;
      if (!act.placed) { act.x = x; act.z = z; act.placed = true; }
      const sp = Math.hypot(x - act.x, z - act.z) / Math.max(dt, 1e-3);
      act.speed = act.speed * 0.8 + Math.min(sp, 8) * 0.2;
      act.x = x; act.z = z;
      act.ch.root.position.set(x, act.sz * S, z);
      act.yaw = lerpAngle(act.yaw, Math.PI / 2 - p[5], Math.min(1, dt * 18));
      act.ch.root.rotation.y = act.yaw;
      Chars.animateCharacter(act.ch, dt, act.speed, !!p[4], p[6], act.stance, act.lean);
      const roped = p[4] && (p[8] & 64) && act.sz < MAP.upper.floor - 1;
      if (roped) {
        if (!act.rope) { act.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 4), basic(0xe8e2c8)); scene.add(act.rope); }
        const top = MAP.upper.floor * S + 0.9, bot = act.sz * S + 1.3;
        act.rope.visible = true; act.rope.scale.y = Math.max(0.05, top - bot); act.rope.position.set(x, (top + bot) / 2, z);
      } else if (act.rope) act.rope.visible = false;
      // names: teammates always, enemies only when you can actually see them
      proj.set(x, 2.05 + act.sz * S, z).project(camera);
      const seen = act.info.team === match.myTeam || !me.alive || ((p[17] || 0) & 4) || Core.lineOfSight(me.x, me.y, act.sx, act.sy, (me.z || 0) + 33, act.sz + 33);
      const vis = p[4] && proj.z < 1 && seen;
      act.label.style.display = vis ? '' : 'none';
      if (vis) {
        act.label.style.left = `${(proj.x * 0.5 + 0.5) * innerWidth}px`;
        act.label.style.top = `${(-proj.y * 0.5 + 0.5) * innerHeight}px`;
        act.label.querySelector('.bar > div').style.width = `${p[3]}%`;
      }
    }

    // hints: rappel when you face a gap upstairs, climb when you're at a ladder
    const tip = $('move-tip');
    if (me.alive && (ui === 'game' || ui === 'practice')) {
      const lad = Core.ladderAt(me.x, me.y);
      tip.textContent = me.rap ? 'RAPPELLING · X LET GO' : Core.rappelSpot(me) ? 'X  RAPPEL DOWN' : lad ? (me.onLadder ? 'W / S  CLIMB · TAB  LET GO' : 'W  CLIMB LADDER') : '';
      tip.hidden = !tip.textContent;
    } else tip.hidden = true;

    firstPerson = me.alive && !matchOver;
    if (firstPerson) {
      fpCamera(dt, moving);
    } else {
      // knocked out: float up to an overview of the room
      const halfFov = Math.tan((50 / 2) * Math.PI / 180);
      const dist = Math.max(19, (AW / 2 + 2) / (halfFov * camera.aspect));
      wantLook.set(CENTER.x, 0, CENTER.z - 2.6);
      wantPos.set(CENTER.x, 0.83 * dist, CENTER.z - 2.6 + 0.56 * dist);
      setFov(50);
    }

    // crosshair + HUD
    const target = !!onTargetNow() && curState.phase === 'fight';
    updateReticle(target, now);
    $('reticle').hidden = !firstPerson;
    if (!firstPerson) $('scope').classList.remove('on');
    drawMinimap(now);

    // first-person gun animation
    animateViewmodel(dt, moving);
    vm.group.visible = firstPerson;
  }

  // minimap: walls, you and your teammates (enemies stay hidden)
  const mm = $('minimap'), mctx = mm.getContext('2d');
  let mmAt = 0;
  const slabsMM = Core.slabRects();
  function drawMinimap(now) {
    if (now - mmAt < 90) return; mmAt = now;
    const k = mm.width / MAP.w;
    mctx.clearRect(0, 0, mm.width, mm.height);
    mctx.fillStyle = 'rgba(20,22,27,0.85)'; mctx.fillRect(0, 0, mm.width, mm.height);
    mctx.fillStyle = 'rgba(93,255,180,0.12)';   // balconies (upstairs)
    for (const [x, y, w, h] of slabsMM) mctx.fillRect(x * k, y * k, w * k, h * k);
    for (const [x, y, w, h, t] of MAP.walls) {   // vents in amber so you can spot grenade routes
      mctx.fillStyle = t === 2 ? '#d9a441' : '#8a8f98';
      mctx.fillRect(x * k, y * k, Math.max(1, w * k), Math.max(1, h * k));
    }
    if (curState && curState.ex) {   // bases and the gem
      for (const t of ['A', 'B']) { const [bx, by, bw, bh] = MAP.bases[t]; mctx.strokeStyle = t === 'A' ? '#3fa9ff' : '#ff4566'; mctx.strokeRect(bx * k, by * k, bw * k, bh * k); }
      mctx.fillStyle = '#5dffb4'; mctx.beginPath(); mctx.arc(curState.ex.gem[1] * k, curState.ex.gem[2] * k, 4, 0, Math.PI * 2); mctx.fill();
      if (curState.ex.attack === match.myTeam) { const [rx, ry] = MAP.reboot[match.myTeam]; mctx.strokeStyle = '#5dffb4'; mctx.beginPath(); mctx.arc(rx * k, ry * k, 4, 0, Math.PI * 2); mctx.stroke(); }
      for (const c of curState.ex.cards || []) if (!c[4]) { mctx.fillStyle = '#5dffb4'; mctx.fillRect(c[1] * k - 2, c[2] * k - 2, 4, 4); }
    }
    if (match && curState) for (const p of curState.players) {   // revealed enemies show up in red
      if (!((p[17] || 0) & 4) || !p[4] || !actors.get(p[0]) || actors.get(p[0]).info.team === match.myTeam) continue;
      mctx.fillStyle = '#ff2244'; mctx.beginPath(); mctx.arc(p[1] * k, p[2] * k, 4, 0, Math.PI * 2); mctx.fill();
    }
    if (match) for (const [id, a] of actors) {
      if (id === match.you || a.info.team !== match.myTeam || !a.alive) continue;
      mctx.fillStyle = a.info.team === 'A' ? '#3fa9ff' : '#ff4566';
      mctx.beginPath(); mctx.arc(a.sx * k, a.sy * k, 3, 0, Math.PI * 2); mctx.fill();
    }
    if (me.alive) {
      mctx.save(); mctx.translate(me.x * k, me.y * k); mctx.rotate(me.yaw);
      mctx.fillStyle = '#ffd23f'; mctx.beginPath(); mctx.moveTo(6, 0); mctx.lineTo(-4, -4); mctx.lineTo(-4, 4); mctx.closePath(); mctx.fill();
      mctx.restore();
    }
  }

  let last = performance.now(), fpsAcc = 0, fpsFrames = 0, slowSecs = 0, autoLowered = false, firstFrame = true;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    lastPad = readPad();
    $('focus-hint').hidden = document.hasFocus();

    const inMatchView = match && curState && (ui === 'game' || ui === 'pause' || ui === 'end' || ui === 'practice');
    if (inMatchView) updateMatch(dt, now);
    else {
      firstPerson = false;
      // menus: showcase your character on the pedestal
      const narrow = camera.aspect < 1.1, close = ui === 'locker';
      const side = narrow ? 0 : (close ? -0.9 : -1.8);
      wantLook.set(SHOW.x + side, close ? 1.25 : 1.1, SHOW.z);
      wantPos.set(SHOW.x + side, close ? 1.7 : 2.1, SHOW.z + (close ? 3.6 : 6.2) * (narrow ? 1.5 : 1));
      setFov(50);
      if (partyShow.length && !close) { const k = partyShow.length; wantPos.z += 1.2 + 0.5 * k; wantLook.x += 0.6; wantPos.x += 0.6; }
      if (showChar) { showChar.root.rotation.y += dt * (close ? 0.5 : 0.35); Chars.animateCharacter(showChar, dt, 0, true); }
    }
    updatePartyShow(dt, !inMatchView && ui !== 'end' && ui !== 'loading');
    updateParticles(dt);
    updateTracers(dt);
    updateBlasts(dt);

    if (firstPerson) {
      // first person follows your view exactly (no smoothing, so aiming feels direct)
      camPos.copy(wantPos);
      camera.position.copy(camPos);
      camera.rotation.set(me.pitch, -me.yaw - Math.PI / 2, me.roll);
      if (shake > 0) { shake = Math.max(0, shake - dt); camera.rotation.z += (Math.random() - 0.5) * shake * 0.3; }
      camLook.copy(camPos).add(camera.getWorldDirection(tmpV));
    } else {
      const k = firstFrame ? 1 : Math.min(1, dt * 3.5);
      camPos.lerp(wantPos, k); camLook.lerp(wantLook, k);
      camera.position.copy(camPos);
      camera.rotation.z = 0;
      camera.lookAt(camLook);
    }
    renderer.clear();
    renderer.render(scene, camera);
    if (firstPerson) { renderer.clearDepth(); renderer.render(vmScene, vmCam); }

    if (firstFrame) { firstFrame = false; $('loading').hidden = true; show('title'); }

    // FPS + automatic downgrade on slow machines
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 1) {
      const fps = fpsFrames / fpsAcc;
      if (settings.fps) $('fps').textContent = `${Math.round(fps)} FPS · ${settings.quality.toUpperCase()}`;
      if (ui === 'game' && !autoLowered && settings.quality !== 'low') {
        slowSecs = fps < 35 ? slowSecs + 1 : 0;
        if (slowSecs >= 3) {
          settings.quality = settings.quality === 'high' ? 'medium' : 'low'; autoLowered = true; slowSecs = 0;
          store.set('settings', settings); resize(); toast(`Graphics set to ${settings.quality.toUpperCase()} for smoother play`);
        }
      }
      fpsAcc = 0; fpsFrames = 0;
    }
    requestAnimationFrame(frame);
  }
  // which version is this? (shown small on the title and pause screens)
  $('build-tag').textContent = 'build ' + (window.FRAGOUT_BUILD || 'dev');
  netBadge();
  refreshSettings();
  requestAnimationFrame(frame);
})();
