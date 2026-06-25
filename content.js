(function () {
  if (document.getElementById("arachne-canvas")) return;

  const canvas = document.createElement("canvas");
  canvas.id = "arachne-canvas";
  Object.assign(canvas.style, {
    position: "fixed", top: "0", left: "0",
    width: "100vw", height: "100vh",
    zIndex: "2147483647", pointerEvents: "none",
  });
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // Pre-rendered dust "puff" sprites. Each is a small irregular cloud — several
  // overlapping soft blobs of varying size/offset — so the dust reads as wispy
  // smoke-like clumps rather than uniform round dots. A few variants give
  // variety; each mote draws one (scaled, low alpha) and the overlaps build haze.
  function makeDustSprite(prng) {
    const S = 64;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const dc = cv.getContext("2d");
    const blobs = 5 + Math.floor(prng() * 4);
    for (let i = 0; i < blobs; i++) {
      const cx = S / 2 + (prng() - 0.5) * S * 0.45;
      const cy = S / 2 + (prng() - 0.5) * S * 0.45;
      const rad = S * (0.12 + prng() * 0.20);
      const a = 0.10 + prng() * 0.16;
      const g = dc.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(150, 150, 156, ${a})`);
      g.addColorStop(1, "rgba(150, 150, 156, 0)");
      dc.fillStyle = g;
      dc.beginPath();
      dc.arc(cx, cy, rad, 0, Math.PI * 2);
      dc.fill();
    }
    return cv;
  }
  const DUST_SPRITES = (() => {
    const p = mulberry32(0x5eed5);
    return [makeDustSprite(p), makeDustSprite(p), makeDustSprite(p), makeDustSprite(p)];
  })();

  // ── Seeded PRNG ──────────────────────────────────────────────────────────
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a: hostname → stable integer seed
  function hashSeed(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Idle ms → continuous phase 0–4
  function idleToPhase(idleMs) {
    const m = idleMs / 60000;
    if (m < 10)  return m / 10;
    if (m < 60)  return 1 + (m - 10) / 50;
    if (m < 480) return 2 + (m - 60) / 420;
    return Math.min(4, 3 + (m - 480) / 480);
  }

  // ── Phase → physics parameters ───────────────────────────────────────────
  // Four reference profiles (初生 / 繁榮 / 失修 / 腐朽); we lerp between them so
  // a continuous phase still degrades smoothly.
  //   gravity      downward accel per frame²
  //   stiffness    constraint relaxation factor (1 = rigid, lower = springy)
  //   iterations   constraint solver passes per frame (higher = tighter)
  //   slack        rest-length multiplier (>1 = threads grow loose and droop)
  //   opacity      global stroke alpha
  //   grime        corner shadow + dust-haze intensity (0–1)
  // (Dust density, strand count and breakage are no longer params — they are
  // baked into the structure's birth/breakAt lifecycle, see buildWorld.)
  const PROFILES = [
    { gravity: 0.018, stiffness: 1.00, iterations: 6, slack: 1.00, opacity: 0.42, grime: 0.00 }, // 0 初生
    { gravity: 0.022, stiffness: 1.00, iterations: 6, slack: 1.00, opacity: 0.52, grime: 0.25 }, // 1 繁榮
    { gravity: 0.075, stiffness: 0.70, iterations: 3, slack: 1.15, opacity: 0.50, grime: 0.60 }, // 2 失修
    { gravity: 0.150, stiffness: 0.45, iterations: 2, slack: 1.40, opacity: 0.46, grime: 1.00 }, // 3 腐朽
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }

  function paramsForPhase(phase) {
    const p = Math.max(0, Math.min(3, phase));
    const i = Math.min(2, Math.floor(p));
    const t = p - i;
    const A = PROFILES[i], B = PROFILES[i + 1];
    return {
      gravity:    lerp(A.gravity, B.gravity, t),
      stiffness:  lerp(A.stiffness, B.stiffness, t),
      iterations: Math.round(lerp(A.iterations, B.iterations, t)),
      slack:      lerp(A.slack, B.slack, t),
      opacity:    lerp(A.opacity, B.opacity, t),
      grime:      lerp(A.grime, B.grime, t),
    };
  }

  // ── Physics world ────────────────────────────────────────────────────────
  // The web is built ONCE at full maturity (a single canonical structure per
  // site). Phase then drives a lifecycle over that fixed structure rather than
  // re-generating it: every thread has a `birth` phase (when it grows in) and a
  // `breakAt` phase (when it snaps). Scrubbing the phase shows one web grow,
  // fill in, then decay — not four unrelated snapshots.
  //   nodes:   { x, y, px, py, pinned, active }
  //   springs: { a, b, rest, width, kind, birth, breakAt, sag, alive }
  const world = {
    nodes: [],
    springs: [],
    grimeCorners: [], // [{x, y, reach, floor}] for the grime/vignette layer
    dust: [],         // floor dust particles: {x,y,vx,vy,groundY,r,a,birth,settled}
    fluff: [],        // [{node, r, a, birth}] dust clumps caught on intersections
    params: paramsForPhase(0),
    phase: 0,
    maxReach: 300,
    built: false,
    builtW: 0,
    builtH: 0,
  };

  const DAMPING = 0.98;          // velocity retention per frame
  const SLEEP_ENERGY = 0.02;     // total kinetic energy below which we may sleep
  const SLEEP_FRAMES = 30;       // consecutive calm frames required before sleeping
  const MOUSE_RADIUS = 45;       // px: how close the cursor must be to disturb a node
  const MOUSE_FORCE = 0.35;      // how hard the cursor shoves nearby nodes
  // Dust is a physical particle layer on the floor: a broom (the cursor) sweeps
  // motes along its motion and kicks them into the air; they fall back under
  // gravity and resettle on the floor.
  const DUST_RADIUS = 48;        // px: broom reach
  const SWEEP_SPEED_CAP = 16;    // ignore cursor speed beyond this (flicks)
  const SWEEP_TRANSFER = 0.16;   // fraction of cursor velocity imparted to motes
  const SWEEP_KICK = 0.12;       // gentle upward kick, scaled by sweep speed
  const DUST_MAX_RISE = 55;      // px: how high a swept mote can lift off the floor
  const DUST_GRAV = 0.30;        // gravity pulling airborne dust back down
  const DUST_AIR = 0.85;         // air drag while airborne (lower = stops sooner)
  const DUST_FRICTION = 0.70;    // ground friction once a mote lands
  const WEB_BREAK_SPEED = 11;    // cursor speed above which a sweep snaps threads
  const WEB_CUT_RADIUS = 38;     // px: how close a thread must be to be snapped
  const WEB_CUT_CHANCE = 0.5;    // per-event chance a nearby thread snaps

  function addNode(x, y, pinned) {
    const n = { x, y, px: x, py: y, pinned: !!pinned, active: false };
    world.nodes.push(n);
    return n;
  }

  // kind: "frame" (thick scaffold, never breaks) | "ring" | "brace" (fine).
  // birth: phase at which the thread appears. breakAt: phase at which it snaps
  // (Infinity = survives). sag is filled in later (deterministic per spring).
  function addSpring(a, b, width, kind, birth, breakAt) {
    const dx = a.x - b.x, dy = a.y - b.y;
    const s = {
      a, b,
      rest: Math.sqrt(dx * dx + dy * dy),
      width: width || 0.8,
      kind: kind || "ring",
      birth: birth || 0,
      breakAt: breakAt == null ? Infinity : breakAt,
      sag: 0,
      alive: false,
      cut: false,   // permanently swept away by the broom (survives phase changes)
    };
    world.springs.push(s);
    return s;
  }

  // ── Build the full mature web ONCE (deterministic per site) ──────────────
  // Phase does NOT enter here; everything is built at full maturity and tagged
  // with birth/breakAt so applyPhase() can reveal/decay it later.
  function buildWorld() {
    world.nodes.length = 0;
    world.springs.length = 0;
    world.dust.length = 0;
    world.fluff.length = 0;

    const W = canvas.width, H = canvas.height;
    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);

    // Edge bands: the web hugs the ceiling and the two side walls (an ∩ band),
    // leaving the centre rectangle and the whole floor clear.
    const maxReach = Math.min(W * 0.34, H * 0.34); // for grime/dust/fade reference
    world.maxReach = maxReach;

    buildCeilingWeb(W, H, rand);

    // Grime/vignette + dust in all four corners; floor weighted heavier.
    world.grimeCorners = [
      { x: 0, y: 0, reach: maxReach, floor: false },
      { x: W, y: 0, reach: maxReach, floor: false },
      { x: W, y: H, reach: maxReach, floor: true },
      { x: 0, y: H, reach: maxReach, floor: true },
    ];

    seedDust(rand);

    // Deterministic per-spring sag factor (independent PRNG so it never
    // perturbs the structural rand sequence).
    const sr = mulberry32(seed ^ 0x9e3779b9);
    for (const s of world.springs) s.sag = sr();
  }

  // Reveal/decay the fixed structure for a phase. Marks each spring alive and
  // each node active; nothing is rebuilt, so scrubbing phase is smooth.
  function applyPhase(phase) {
    world.phase = phase;
    world.params = paramsForPhase(phase);
    for (const s of world.springs) {
      s.alive = !s.cut && s.birth <= phase && s.breakAt > phase;
    }
    recomputeActive();
  }

  // A node is "active" (integrated, counted toward sleep) only if it still has
  // at least one alive spring. Recomputed after phase changes and web cuts so
  // nodes freed by a cut stop free-falling and the loop can settle to sleep.
  function recomputeActive() {
    for (const n of world.nodes) n.active = false;
    for (const s of world.springs) {
      if (s.alive) { s.a.active = true; s.b.active = true; }
    }
  }

  // Dust as physical particles forming the GRIME in the bottom corners (dense
  // quarter-disc piles that climb the walls and run along the floor) plus a
  // light spread across the floor. Crucially every mote's resting surface is the
  // floor (groundY = floorY): the corner dirt clings in place until disturbed,
  // and once you sweep it, gravity pulls it down and out of the corner — so the
  // corner actually clears instead of just smearing.
  function seedDust(rand) {
    const W = canvas.width, H = canvas.height;
    const floorY = H - 2;
    const reach = Math.min(W, H) * 0.30;

    const push = (x, y) => {
      const grain = rand() < 0.7;
      world.dust.push({
        x, y, vx: 0, vy: 0,
        groundY: floorY,                             // swept dust falls to the floor
        r: grain ? 16 + rand() * 14 : 30 + rand() * 22,
        a: grain ? 0.05 + rand() * 0.05 : 0.06 + rand() * 0.06,
        s: Math.floor(rand() * DUST_SPRITES.length),
        birth: 1.0 + rand() * 3.0,
        settled: true,
      });
    };

    // Bottom-corner grime piles: dense at the vertex, fading up the wall and
    // along the floor (a quarter disc).
    for (const cx of [0, W]) {
      const dirX = cx === 0 ? 1 : -1;
      for (let i = 0; i < 130; i++) {
        const t   = Math.pow(rand(), 1.8);           // dense near the corner
        const rad = t * reach;
        const ang = rand() * (Math.PI / 2);          // 0 = along floor, π/2 = up wall
        if (rand() < t * 0.4) continue;              // thin the outer edge
        push(cx + dirX * Math.cos(ang) * rad, floorY - Math.sin(ang) * rad);
      }
    }

    // Ceiling grime: clings to the top corners and along the top edge until
    // swept — then (groundY = floor) it tumbles all the way down to the floor.
    for (const cx of [0, W]) {
      const dirX = cx === 0 ? 1 : -1;
      for (let i = 0; i < 70; i++) {
        const t   = Math.pow(rand(), 1.8);
        const rad = t * reach * 0.8;
        const ang = rand() * (Math.PI / 2);          // 0 = along ceiling, π/2 = down wall
        if (rand() < t * 0.5) continue;
        push(cx + dirX * Math.cos(ang) * rad, Math.sin(ang) * rad);
      }
    }
    for (let i = 0; i < 55; i++) {                    // light haze along the ceiling
      push(rand() * W, Math.pow(rand(), 0.7) * Math.min(H * 0.05, 36));
    }

    // Light dust scattered along the rest of the floor.
    for (let i = 0; i < 90; i++) {
      push(rand() * W, floorY - Math.pow(rand(), 0.7) * Math.min(H * 0.06, 45));
    }
  }

  // Per-frame dust update: airborne/sliding motes fall under gravity, land on
  // their resting surface and slide to a stop. Settled motes are skipped (so
  // resting dust costs nothing and lets the loop sleep).
  function updateDust() {
    const phase = world.phase;
    const W = canvas.width;
    for (const d of world.dust) {
      if (d.birth > phase || d.settled) continue;
      d.vy += DUST_GRAV;
      d.vx *= DUST_AIR;
      d.x += d.vx;
      d.y += d.vy;
      if (d.x < 0)      { d.x = 0; d.vx *= -0.3; }
      else if (d.x > W) { d.x = W; d.vx *= -0.3; }
      // Cap how high dust can rise — it puffs up near the floor, never flies off.
      const ceil = d.groundY - DUST_MAX_RISE;
      if (d.y < ceil) { d.y = ceil; if (d.vy < 0) d.vy = 0; }
      if (d.y >= d.groundY) {            // landed on its surface
        d.y = d.groundY;
        d.vy = 0;
        d.vx *= DUST_FRICTION;
        if (Math.abs(d.vx) < 0.05) { d.vx = 0; d.settled = true; }
      }
    }
  }

  // A swept-off bit of web becomes a little clump of falling dust/debris that
  // drops to the floor (always visible — birth 0). Reuses the dust system so
  // everything the broom dislodges ends up as floor dust.
  function spawnDebris(x, y) {
    world.dust.push({
      x, y,
      vx: (Math.random() - 0.5) * 1.5,
      vy: 0.5 + Math.random(),
      groundY: canvas.height - 2,
      r: 12 + Math.random() * 14,
      a: 0.06 + Math.random() * 0.06,
      s: Math.floor(Math.random() * DUST_SPRITES.length),
      birth: 0,
      settled: false,
    });
  }

  // Any dust still in motion? Keeps the loop awake until everything resettles.
  function dustActive() {
    const phase = world.phase;
    for (const d of world.dust) {
      if (d.birth > phase || d.settled) continue;
      return true;
    }
    return false;
  }

  // The ceiling web. Anchors run along the ∩-shaped perimeter (top edge + the
  // upper part of both side walls — never the floor). Festoons/swags drape
  // inward and downward from those wall anchors; cross threads weave them into a
  // mesh; the two top corners keep a small fan for identity. birth grows with
  // (distance from the nearest top corner) + (depth into the room), so the web
  // starts as two small corner clumps and spreads across the ceiling and down
  // the walls, deepening inward — every droop runs with gravity, none upward.
  function buildCeilingWeb(W, H, rand) {
    const topDepth   = Math.min(H * 0.32, world.maxReach);
    const sideDepth  = Math.min(W * 0.32, world.maxReach);
    const wallBottom = Math.min(H * 0.58, H - 2); // side anchors stop above floor
    const dMax       = Math.max(W / 2, wallBottom);
    const maxSeg     = Math.max(topDepth, sideDepth) * 0.9;

    // birth from spread-distance + depth into the room.
    const birthFor = (dCorner, depth) =>
      Math.max(0, Math.min(4,
        4 * (0.55 * (dCorner / dMax) + 0.45 * depth) + (rand() - 0.5) * 0.4));

    // Inward normal at a point on the perimeter (points into the room).
    const inwardAt = (x, y) => {
      let ix = 0, iy = 0;
      if (x < 1) ix = 1; else if (x > W - 1) ix = -1;
      if (y < 1) iy = 1;
      const m = Math.hypot(ix, iy) || 1;
      return { x: ix / m, y: iy / m };
    };

    // ── Rail anchors, ordered left-wall(bottom→top) → top → right-wall(top→bottom).
    // dCorner = distance along the edge from the nearest top corner.
    const rail = [];
    const nLeft = Math.max(2, Math.round(wallBottom / 150));
    for (let i = nLeft; i >= 1; i--) {
      const y = wallBottom * (i / nLeft);
      rail.push({ node: addNode(0, y, true), dCorner: y });
    }
    rail.push({ node: addNode(0, 0, true), dCorner: 0 });          // top-left corner
    const nTop = Math.max(3, Math.round(W / 200));
    for (let i = 1; i < nTop; i++) {
      const x = W * (i / nTop);
      rail.push({ node: addNode(x, 0, true), dCorner: Math.min(x, W - x) });
    }
    rail.push({ node: addNode(W, 0, true), dCorner: 0 });          // top-right corner
    const nRight = Math.max(2, Math.round(wallBottom / 150));
    for (let i = 1; i <= nRight; i++) {
      const y = wallBottom * (i / nRight);
      rail.push({ node: addNode(W, y, true), dCorner: y });
    }

    // ── Main festoons: a downward/inward-bowing chain between adjacent anchors.
    const segsPer = 4;
    const swags = []; // { nodes, dCorner }
    for (let k = 0; k < rail.length - 1; k++) {
      const A = rail[k], B = rail[k + 1];
      const dC = (A.dCorner + B.dCorner) / 2;
      const ax = A.node.x, ay = A.node.y, bx = B.node.x, by = B.node.y;
      const span = Math.hypot(bx - ax, by - ay);
      const nA = inwardAt(ax, ay), nB = inwardAt(bx, by);
      const inx = (nA.x + nB.x) / 2, iny = (nA.y + nB.y) / 2;
      const bow = Math.min(span * 0.35, topDepth * 0.55);
      const birth = birthFor(dC, 0.15);

      const nodes = [A.node];
      let prev = A.node;
      for (let s = 1; s < segsPer; s++) {
        const f = s / segsPer;
        const k2 = Math.sin(f * Math.PI) * bow; // max bow at the middle
        const node = addNode(ax + (bx - ax) * f + inx * k2,
                             ay + (by - ay) * f + iny * k2 + k2 * 0.3, false);
        addSpring(prev, node, 1.2, "frame", birth);
        prev = node; nodes.push(node);
      }
      addSpring(prev, B.node, 1.2, "frame", birth);
      nodes.push(B.node);
      swags.push({ nodes, dCorner: dC, inx, iny });
    }

    // Helper: skip distant pairs; tag birth + maybe breakAt (→ dangling stub).
    const tryThread = (a, b, width, kind, skipChance, birth) => {
      if (!a || !b || a === b) return;
      if (rand() < skipChance) return;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy > maxSeg * maxSeg) return;
      let breakAt = Infinity;
      if (rand() < 0.55) {
        breakAt = Math.max(birth + 0.4, 2.6 + rand() * 1.4);
        addStrand(rand() < 0.5 ? a : b, Math.max(topDepth, sideDepth) * (0.06 + rand() * 0.12),
                  2 + Math.floor(rand() * 2), rand, breakAt);
      }
      addSpring(a, b, width, kind, birth, breakAt);
    };

    // ── Cross threads: weave neighbouring festoons at matching depth (triangles).
    for (let k = 0; k < swags.length - 1; k++) {
      const A = swags[k], B = swags[k + 1];
      const n = Math.min(A.nodes.length, B.nodes.length);
      for (let r = 1; r < n - 1; r++) {
        const birth = birthFor((A.dCorner + B.dCorner) / 2, 0.35 + r * 0.05);
        tryThread(A.nodes[r], B.nodes[r],     0.7, "ring",  0.18, birth);
        tryThread(A.nodes[r], B.nodes[r - 1], 0.5, "brace", 0.40, birth);
      }
    }

    // ── Second-tier drapes: deeper festoons hanging off the main swag midpoints.
    for (const sw of swags) {
      if (sw.nodes.length < 3) continue;
      if (rand() < 0.45) continue;
      const mid = sw.nodes[Math.floor(sw.nodes.length / 2)];
      const drop = Math.min(topDepth, sideDepth) * (0.35 + rand() * 0.4);
      const birth = birthFor(sw.dCorner, 0.7);
      addStrand(mid, drop, 3 + Math.floor(rand() * 2), rand, birth);
    }

    // ── Corner fans: a few radials from each top corner into the nearest swags,
    // born earliest so the web reads as starting at the corners.
    for (const corner of [{ x: 0, y: 0 }, { x: W, y: 0 }]) {
      const V = rail.find((r) => r.node.x === corner.x && r.node.y === corner.y).node;
      const near = [];
      for (const sw of swags) {
        for (const nd of sw.nodes) {
          if (nd.pinned) continue;
          const d = Math.hypot(nd.x - corner.x, nd.y - corner.y);
          if (d < topDepth * 0.9) near.push(nd);
        }
      }
      for (let i = 0; i < 4 && near.length; i++) {
        const nd = near[Math.floor(rand() * near.length)];
        tryThread(V, nd, 0.7, "ring", 0.2, 0.1 + rand() * 0.3);
      }
    }

    // ── Free dangling strands + dust fluff on interior nodes (appear later).
    const interior = [];
    for (const sw of swags) for (const nd of sw.nodes) if (!nd.pinned) interior.push(nd);
    for (let i = 0; i < 8 && interior.length; i++) {
      const from = interior[Math.floor(rand() * interior.length)];
      const dC = Math.min(from.x, W - from.x, from.y); // rough spread distance
      addStrand(from, Math.max(topDepth, sideDepth) * (0.12 + rand() * 0.22),
                3 + Math.floor(rand() * 3), rand, birthFor(dC, 0.8));
    }
    for (let i = 0; i < 10 && interior.length; i++) {
      const node = interior[Math.floor(rand() * interior.length)];
      const dC = Math.min(node.x, W - node.x, node.y);
      world.fluff.push({
        node,
        r: 1.5 + rand() * 2.5,
        a: 0.10 + rand() * 0.12,
        birth: Math.min(4, birthFor(dC, 0.85) + 0.4),
      });
    }
  }

  // A loose strand hangs straight down from `from`; gravity settles it into a
  // natural droop. Only the attach point is fixed. All segments share `birth`.
  function addStrand(from, length, segs, rand, birth) {
    let prev = from;
    const segLen = length / segs;
    for (let s = 1; s <= segs; s++) {
      const jitter = (rand() - 0.5) * segLen * 0.3;
      const node = addNode(from.x + jitter, from.y + segLen * s, false);
      addSpring(prev, node, 0.5, "brace", birth || 0);
      prev = node;
    }
  }

  // ── Verlet integration + distance constraints ────────────────────────────
  function step() {
    const { gravity, stiffness, iterations, slack } = world.params;

    // Integrate free nodes that are part of the currently-alive web.
    const floorY = canvas.height - 2;
    for (const n of world.nodes) {
      if (n.pinned || !n.active) continue;
      const vx = (n.x - n.px) * DAMPING;
      const vy = (n.y - n.py) * DAMPING;
      n.px = n.x;
      n.py = n.y;
      n.x += vx;
      n.y += vy + gravity;
      // Floor: a web bit cut loose from its anchors falls and lands on the
      // ground (instead of free-falling forever and never letting the loop
      // sleep). Anchored web never reaches the floor, so this is harmless to it.
      if (n.y > floorY) {
        n.y = floorY;
        n.py = n.y;                          // landed → no vertical velocity
        n.px = n.x - (n.x - n.px) * 0.6;     // horizontal friction
      }
    }

    // Satisfy distance constraints (several passes for stiffness).
    for (let it = 0; it < iterations; it++) {
      for (const s of world.springs) {
        if (!s.alive) continue;
        const a = s.a, b = s.b;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const target = s.rest * slack;
        const diff = ((target - dist) / dist) * stiffness * 0.5;
        const ox = dx * diff, oy = dy * diff;
        if (!a.pinned) { a.x -= ox; a.y -= oy; }
        if (!b.pinned) { b.x += ox; b.y += oy; }
      }
    }
  }

  // Total kinetic energy — drives the sleep decision.
  function kineticEnergy() {
    let e = 0;
    for (const n of world.nodes) {
      if (n.pinned || !n.active) continue;
      const vx = n.x - n.px, vy = n.y - n.py;
      e += vx * vx + vy * vy;
    }
    return e;
  }

  // ── Render (layered back-to-front: grime → dust → web) ──────────────────
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrime();
    drawDust();
    drawWeb();
    drawFluff();
  }

  // Layer 1: cool corner shadow + dusty haze. Two radial gradients per active
  // corner, both fading to transparent before the centre so it stays clean.
  function drawGrime() {
    const g = world.params.grime;
    if (g <= 0) return;
    for (const c of world.grimeCorners) {
      // Floor corners get only a faint vignette — their dirt is now made of
      // sweepable dust particles, so we don't bake a static haze you can't move.
      // Ceiling corners keep a light ambient haze around the webs.
      if (!c.floor) {
        const hazeR = c.reach * 0.95;
        const haze = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, hazeR);
        haze.addColorStop(0, `rgba(135, 135, 142, ${0.06 * g})`);
        haze.addColorStop(1, "rgba(135, 135, 142, 0)");
        ctx.fillStyle = haze;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Vignette — subtle cool darkening tucked right into the corner (shadow,
      // not dirt — stays put).
      const vigR = c.reach * 0.6;
      const vig = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, vigR);
      vig.addColorStop(0, `rgba(55, 55, 62, ${0.07 * g})`);
      vig.addColorStop(1, "rgba(55, 55, 62, 0)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Layer 2: static dust motes — low-alpha cool-grey specks, no glow. Only
  // motes whose birth phase has passed are drawn, so dust accumulates.
  function drawDust() {
    const phase = world.phase;
    for (const d of world.dust) {
      if (d.birth > phase) continue;
      ctx.globalAlpha = d.a;
      ctx.drawImage(DUST_SPRITES[d.s], d.x - d.r / 2, d.y - d.r / 2, d.r, d.r);
    }
    ctx.globalAlpha = 1;
  }

  // Layer 3: the web. Cool-grey threads; short/near read clearly, long/far
  // fade out; frame scaffold keeps more weight than fine ring/brace threads.
  // Fine threads are drawn as a gentle downward-bowing curve (per-segment sag)
  // so they read as hanging silk rather than rigid struts.
  function drawWeb() {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const baseAlpha = world.params.opacity;
    const lenRef = (world.maxReach || 300) * 0.5;
    const slackBow = 1 + (world.params.slack - 1) * 3; // looser web → deeper bow
    for (const s of world.springs) {
      if (!s.alive) continue;
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const shortness = 1 - Math.min(1, len / lenRef);
      const kindMul = s.kind === "frame" ? 1.0 : s.kind === "ring" ? 0.8 : 0.6;
      const alpha = baseAlpha * (0.30 + 0.70 * shortness) * kindMul;
      ctx.strokeStyle = `rgba(160, 158, 162, ${alpha})`;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.a.x, s.a.y);
      if (s.kind === "frame") {
        ctx.lineTo(s.b.x, s.b.y);
      } else {
        // Downward sag at the midpoint, scaled by length, slack and per-thread sag.
        const bow = len * (0.04 + s.sag * 0.10) * slackBow;
        ctx.quadraticCurveTo((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2 + bow, s.b.x, s.b.y);
      }
      ctx.stroke();
    }
  }

  // Dust clumps caught on web intersections. Drawn at the node's live position
  // (so they follow the sagging web) once their birth phase has passed.
  function drawFluff() {
    const phase = world.phase;
    for (const f of world.fluff) {
      if (f.birth > phase || !f.node.active) continue;
      ctx.fillStyle = `rgba(140, 140, 146, ${f.a})`;
      ctx.beginPath();
      ctx.arc(f.node.x, f.node.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Animation loop with auto-sleep ───────────────────────────────────────
  let rafId = null;
  let sleeping = true;
  let calmFrames = 0;

  function frame() {
    step();
    updateDust();
    render();

    // Stay awake while the web is moving OR dust is still scattering/re-fogging.
    if (kineticEnergy() < SLEEP_ENERGY && !dustActive()) {
      calmFrames++;
      if (calmFrames >= SLEEP_FRAMES) {
        sleep();
        return;
      }
    } else {
      calmFrames = 0;
    }
    rafId = requestAnimationFrame(frame);
  }

  function wake() {
    if (!sleeping) return;
    sleeping = false;
    calmFrames = 0;
    rafId = requestAnimationFrame(frame);
  }

  function sleep() {
    sleeping = true;
    calmFrames = 0;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    // One last paint so the resting web stays on screen; then CPU goes idle.
  }

  // Set the web to a given idle duration. The structure is built once (lazily,
  // and on resize); phase changes only reveal/decay it, so scrubbing is smooth.
  function rebuild(idleMs) {
    const phase = idleToPhase(idleMs);
    if (!world.built || world.builtW !== canvas.width || world.builtH !== canvas.height) {
      buildWorld();
      world.built = true;
      world.builtW = canvas.width;
      world.builtH = canvas.height;
    }
    applyPhase(phase);

    if (phase < 0.05) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sleep();
      return;
    }

    // Animated settle: built taut, then the loop wakes so the user watches it
    // sag and dust/threads appear before it auto-sleeps (kinetic-energy gate).
    wake();
  }

  // ── Mouse interaction: poke the web (elastic, springs back) and sweep the
  // floor dust like a broom — motes are pushed along the cursor's motion and
  // kicked up, then fall back under gravity.
  let lastMx = null, lastMy = null;
  window.addEventListener("mousemove", (e) => {
    if (world.nodes.length === 0) return;
    const mx = e.clientX, my = e.clientY;
    const phase = world.phase;
    let touched = false;

    for (const n of world.nodes) {
      if (n.pinned || !n.active) continue;
      const dx = n.x - mx, dy = n.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < MOUSE_RADIUS * MOUSE_RADIUS) {
        const d = Math.sqrt(d2) || 1e-6;
        const f = (1 - d / MOUSE_RADIUS) * MOUSE_FORCE;
        // Nudge position only (not px) → injects velocity → web springs back.
        n.x += (dx / d) * f * MOUSE_RADIUS;
        n.y += (dy / d) * f * MOUSE_RADIUS;
        touched = true;
      }
    }

    // Broom: cursor velocity = sweep direction & strength.
    const cvx = lastMx == null ? 0 : mx - lastMx;
    const cvy = lastMy == null ? 0 : my - lastMy;
    const rawSpeed = Math.hypot(cvx, cvy);
    lastMx = mx; lastMy = my;
    if (rawSpeed > 0.5) {
      // Cap the effective sweep so a fast flick doesn't launch dust skyward.
      const scale = Math.min(rawSpeed, SWEEP_SPEED_CAP) / rawSpeed;
      const sx = cvx * scale, sy = cvy * scale;
      const speed = Math.min(rawSpeed, SWEEP_SPEED_CAP);
      const dr2 = DUST_RADIUS * DUST_RADIUS;
      for (const dst of world.dust) {
        if (dst.birth > phase) continue;
        const dx = dst.x - mx, dy = dst.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < dr2) {
          const f = 1 - Math.sqrt(d2) / DUST_RADIUS;
          // Carry the mote along the sweep, plus a gentle upward kick.
          dst.vx += sx * SWEEP_TRANSFER * f;
          dst.vy += sy * SWEEP_TRANSFER * f - speed * SWEEP_KICK * f;
          dst.settled = false;
          touched = true;
        }
      }

      // Two-stage web: a slow sweep only jiggles (handled above); a hard, fast
      // sweep snaps the threads it crosses, which drop as falling debris.
      if (rawSpeed > WEB_BREAK_SPEED) {
        const cr2 = WEB_CUT_RADIUS * WEB_CUT_RADIUS;
        let cutAny = false;
        for (const s of world.springs) {
          if (!s.alive) continue;
          const cxm = (s.a.x + s.b.x) / 2, cym = (s.a.y + s.b.y) / 2;
          const dx = cxm - mx, dy = cym - my;
          if (dx * dx + dy * dy < cr2 && Math.random() < WEB_CUT_CHANCE) {
            s.cut = true;
            s.alive = false;
            spawnDebris(cxm, cym);
            cutAny = true;
            touched = true;
          }
        }
        // Freed nodes must stop being integrated, or they free-fall forever and
        // the loop never sleeps.
        if (cutAny) recomputeActive();
      }
    }

    if (touched) wake();
  }, { passive: true });

  window.addEventListener("resize", () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    world.built = false; // viewport changed → rebuild the structure
    rebuild(world.lastIdleMs || 0);
  });

  // ── Message listener (from background worker) ────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ARACHNE_IDLE_DURATION") {
      world.lastIdleMs = msg.idleMs;
      console.log(`[Arachne] 這個分頁閒置了 ${msg.label}（${msg.idleMs} ms）`);
      rebuild(msg.idleMs);
    }
  });

  // ── Debug listener (from popup or DevTools) ──────────────────────────────
  window.addEventListener("arachne-debug", (e) => {
    const idleMs = e.detail.seconds * 1000;
    world.lastIdleMs = idleMs;
    console.log(`[Arachne debug] ${e.detail.seconds}s → phase ${idleToPhase(idleMs).toFixed(2)}`);
    rebuild(idleMs);
  });
})();
