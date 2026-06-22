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
  const PROFILES = [
    { gravity: 0.018, stiffness: 1.00, iterations: 6, slack: 1.00, opacity: 0.45 }, // 0 初生
    { gravity: 0.020, stiffness: 1.00, iterations: 6, slack: 1.00, opacity: 0.60 }, // 1 繁榮
    { gravity: 0.075, stiffness: 0.70, iterations: 3, slack: 1.15, opacity: 0.55 }, // 2 失修
    { gravity: 0.150, stiffness: 0.45, iterations: 2, slack: 1.40, opacity: 0.48 }, // 3 腐朽
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
    };
  }

  // ── Physics world ────────────────────────────────────────────────────────
  // nodes:   { x, y, px, py, pinned }
  // springs: { a, b, rest, broken, width }
  const world = {
    nodes: [],
    springs: [],
    params: paramsForPhase(0),
    phase: 0,
  };

  const DAMPING = 0.98;          // velocity retention per frame
  const SLEEP_ENERGY = 0.02;     // total kinetic energy below which we may sleep
  const SLEEP_FRAMES = 30;       // consecutive calm frames required before sleeping
  const MOUSE_RADIUS = 90;       // px: how close the cursor must be to disturb a node
  const MOUSE_FORCE = 0.35;      // how hard the cursor shoves nearby nodes

  function addNode(x, y, pinned) {
    const n = { x, y, px: x, py: y, pinned: !!pinned };
    world.nodes.push(n);
    return n;
  }

  function addSpring(a, b, width) {
    const dx = a.x - b.x, dy = a.y - b.y;
    world.springs.push({
      a, b,
      rest: Math.sqrt(dx * dx + dy * dy),
      broken: false,
      width: width || 0.8,
    });
  }

  // ── Build the corner-web skeleton (geometry → nodes + springs) ───────────
  function buildWorld() {
    world.nodes.length = 0;
    world.springs.length = 0;

    const W = canvas.width, H = canvas.height;
    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);
    const phase = world.phase;

    // Center stays clear: cap reach so webs hug the corners.
    const maxReach = Math.min(W * 0.46, H * 0.46, Math.min(W, H) * (0.22 + phase * 0.07));

    // How many corners have grown in, by maturity.
    const numActive = Math.min(4, Math.floor(phase) + 1);

    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    const P2 = Math.PI / 2;
    const cornerDefs = [
      { x: 0, y: 0, a0: 0,        a1: P2 },          // top-left
      { x: W, y: 0, a0: P2,       a1: Math.PI },     // top-right
      { x: W, y: H, a0: Math.PI,  a1: 3 * P2 },      // bottom-right
      { x: 0, y: H, a0: 3 * P2,   a1: 2 * Math.PI }, // bottom-left
    ];

    for (let ci = 0; ci < numActive; ci++) {
      const def = cornerDefs[order[ci]];
      const cp  = Math.min(1, phase - ci); // this corner's maturity 0→1
      if (cp <= 0) continue;
      buildCorner(def, cp, maxReach, rand);
    }
  }

  // One corner: an anchor at the vertex, several radials pinned to the walls,
  // nodes sampled along each radial, and rings tying neighbouring radials.
  function buildCorner(def, cp, maxReach, rand) {
    const spread     = maxReach * (0.45 + cp * 0.55);
    const numRadials = Math.max(3, Math.round(3 + cp * 3 + rand() * 1.5));
    const fanSpan    = def.a1 - def.a0;
    const nodesPer   = 4; // sample points along each radial (excludes the corner)

    // The shared corner vertex is a fixed anchor.
    const corner = addNode(def.x, def.y, true);

    // Uneven radial angles (hug the fan edges, jitter the interior ones).
    const angles = [];
    angles.push(def.a0 + rand() * fanSpan * 0.08);
    angles.push(def.a1 - rand() * fanSpan * 0.08);
    for (let k = 0; k < numRadials - 2; k++) {
      const base  = def.a0 + ((k + 1) / (numRadials - 1)) * fanSpan;
      const noise = (rand() - 0.5) * (fanSpan / (numRadials - 1)) * 0.80;
      angles.push(base + noise);
    }
    angles.sort((a, b) => a - b);

    // Per-radial reach: many short, some long, organic skew.
    const reaches = angles.map(() =>
      spread * (0.35 + Math.pow(rand(), 0.6) * 0.65));

    // Build each radial as a chain of nodes; outer tip pinned to the wall.
    const radials = [];
    for (let k = 0; k < angles.length; k++) {
      const angle = angles[k];
      const reach = reaches[k];
      const chain = [corner];
      let prev = corner;
      for (let s = 1; s <= nodesPer; s++) {
        const frac = s / nodesPer;
        const x = def.x + Math.cos(angle) * reach * frac;
        const y = def.y + Math.sin(angle) * reach * frac;
        const isTip = s === nodesPer;
        const node = addNode(x, y, isTip); // outer tip anchored to the wall
        addSpring(prev, node, 1.3 + cp * 0.7);
        prev = node;
        chain.push(node);
      }
      radials.push(chain);
    }

    // Rings: connect node s of one radial to node s of the next, with gaps.
    const numRings = Math.min(nodesPer, Math.max(2, Math.round(2 + cp * 2)));
    const baseSkip = 0.15 + (1 - cp) * 0.18;
    for (let k = 0; k < radials.length - 1; k++) {
      for (let r = 1; r <= numRings; r++) {
        const outerBias = (r / nodesPer) * 0.25;
        if (rand() < baseSkip + outerBias) continue;
        const a = radials[k][r];
        const b = radials[k + 1][r];
        if (a && b) addSpring(a, b, 0.7);
      }
    }
  }

  // ── Verlet integration + distance constraints ────────────────────────────
  function step() {
    const { gravity, stiffness, iterations, slack } = world.params;

    // Integrate free nodes.
    for (const n of world.nodes) {
      if (n.pinned) continue;
      const vx = (n.x - n.px) * DAMPING;
      const vy = (n.y - n.py) * DAMPING;
      n.px = n.x;
      n.py = n.y;
      n.x += vx;
      n.y += vy + gravity;
    }

    // Satisfy distance constraints (several passes for stiffness).
    for (let it = 0; it < iterations; it++) {
      for (const s of world.springs) {
        if (s.broken) continue;
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
      if (n.pinned) continue;
      const vx = n.x - n.px, vy = n.y - n.py;
      e += vx * vx + vy * vy;
    }
    return e;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const baseAlpha = world.params.opacity;
    for (const s of world.springs) {
      if (s.broken) continue;
      ctx.strokeStyle = `rgba(200, 195, 180, ${baseAlpha})`;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.a.x, s.a.y);
      ctx.lineTo(s.b.x, s.b.y);
      ctx.stroke();
    }
  }

  // ── Animation loop with auto-sleep ───────────────────────────────────────
  let rafId = null;
  let sleeping = true;
  let calmFrames = 0;

  function frame() {
    step();
    render();

    if (kineticEnergy() < SLEEP_ENERGY) {
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

  // (Re)build the web for a given idle duration and settle it to equilibrium.
  function rebuild(idleMs) {
    world.phase = idleToPhase(idleMs);
    world.params = paramsForPhase(world.phase);
    buildWorld();

    if (world.phase < 0.05 || world.nodes.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sleep();
      return;
    }

    // Settle to equilibrium up front so the first paint is already relaxed,
    // then immediately sleep. No idle CPU until the user interacts.
    for (let i = 0; i < 240; i++) {
      step();
      if (kineticEnergy() < SLEEP_ENERGY) break;
    }
    render();
    sleep();
  }

  // ── Mouse interaction: shove nearby nodes, then let physics settle ───────
  window.addEventListener("mousemove", (e) => {
    if (world.nodes.length === 0) return;
    const mx = e.clientX, my = e.clientY;
    let touched = false;
    for (const n of world.nodes) {
      if (n.pinned) continue;
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
    if (touched) wake();
  }, { passive: true });

  window.addEventListener("resize", () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
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
