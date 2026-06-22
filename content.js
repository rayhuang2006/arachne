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
  //   grime        corner shadow + dust-haze intensity (0–1)
  //   dust         dust-mote density multiplier
  //   strands      dangling loose-strand count per corner
  //   breaks       fraction of ring/brace threads snapped (tattered web)
  const PROFILES = [
    { gravity: 0.018, stiffness: 1.00, iterations: 6, slack: 1.00, opacity: 0.42, grime: 0.00, dust: 0.0, strands: 0, breaks: 0.00 }, // 0 初生
    { gravity: 0.022, stiffness: 1.00, iterations: 6, slack: 1.00, opacity: 0.52, grime: 0.25, dust: 0.4, strands: 0, breaks: 0.00 }, // 1 繁榮
    { gravity: 0.075, stiffness: 0.70, iterations: 3, slack: 1.15, opacity: 0.50, grime: 0.60, dust: 1.0, strands: 2, breaks: 0.18 }, // 2 失修
    { gravity: 0.150, stiffness: 0.45, iterations: 2, slack: 1.40, opacity: 0.46, grime: 1.00, dust: 1.8, strands: 4, breaks: 0.42 }, // 3 腐朽
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
      dust:       lerp(A.dust, B.dust, t),
      strands:    Math.round(lerp(A.strands, B.strands, t)),
      breaks:     lerp(A.breaks, B.breaks, t),
    };
  }

  // ── Physics world ────────────────────────────────────────────────────────
  // nodes:   { x, y, px, py, pinned }
  // springs: { a, b, rest, broken, width }
  const world = {
    nodes: [],
    springs: [],
    grimeCorners: [], // [{x, y, reach}] active corners, for the grime/vignette layer
    dust: [],         // [{x, y, r, a}] static dust motes
    params: paramsForPhase(0),
    phase: 0,
    maxReach: 300,
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

  // kind: "frame" (thick radial scaffold) | "ring" | "brace" (fine threads)
  function addSpring(a, b, width, kind) {
    const dx = a.x - b.x, dy = a.y - b.y;
    world.springs.push({
      a, b,
      rest: Math.sqrt(dx * dx + dy * dy),
      broken: false,
      width: width || 0.8,
      kind: kind || "ring",
    });
  }

  // ── Build the corner-web skeleton (geometry → nodes + springs) ───────────
  function buildWorld() {
    world.nodes.length = 0;
    world.springs.length = 0;
    world.grimeCorners.length = 0;
    world.dust.length = 0;

    const W = canvas.width, H = canvas.height;
    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);
    const phase = world.phase;

    // Center stays clear: cap reach so webs hug the corners.
    const maxReach = Math.min(W * 0.46, H * 0.46, Math.min(W, H) * (0.22 + phase * 0.07));
    world.maxReach = maxReach;

    // Room model: webs only grow in the two TOP corners (ceiling), hanging
    // down with gravity. The bottom (floor) only gathers dust — no upward web.
    // dirX/dirY point from the wall vertex into the room.
    const topCorners = [
      { x: 0, y: 0, dirX:  1, dirY: 1 }, // top-left
      { x: W, y: 0, dirX: -1, dirY: 1 }, // top-right
    ];

    // Seeded order so a single-corner phase is deterministic per site.
    const webOrder = rand() < 0.5 ? [0, 1] : [1, 0];
    const numWeb = phase < 1 ? 1 : 2;
    for (let ci = 0; ci < numWeb; ci++) {
      const def = topCorners[webOrder[ci]];
      const cp  = Math.min(1, phase - ci); // this corner's maturity 0→1
      if (cp <= 0) continue;
      buildTopCornerWeb(def, cp, maxReach, rand);
    }

    // Grime/vignette + dust live in all four corners; the bottom (floor) is
    // weighted heavier so the room reads as ground below, ceiling above.
    world.grimeCorners = [
      { x: 0, y: 0, reach: maxReach, floor: false },
      { x: W, y: 0, reach: maxReach, floor: false },
      { x: W, y: H, reach: maxReach, floor: true },
      { x: 0, y: H, reach: maxReach, floor: true },
    ];

    seedDust(rand);
  }

  // Scatter static dust motes near each active corner. Density follows the
  // phase `dust` factor; placement is biased to the corner (pow) and skips
  // outward so the centre stays clean. Deterministic via the shared `rand`.
  function seedDust(rand) {
    const density = world.params.dust;
    if (density <= 0) return;
    for (const c of world.grimeCorners) {
      // Floor corners gather noticeably more dust than ceiling corners.
      const count = Math.round(40 * density * (c.floor ? 1.7 : 0.6));
      const dirX = c.x === 0 ? 1 : -1;
      const dirY = c.y === 0 ? 1 : -1;
      for (let i = 0; i < count; i++) {
        // Sample a point inside the corner's quadrant, biased toward the vertex.
        const t   = Math.pow(rand(), 1.7);          // 0 corner → 1 outward
        const rad = t * c.reach;
        // Floor dust hugs the bottom edge (shallow angle); ceiling dust spreads.
        const spreadAng = c.floor
          ? rand() * (Math.PI / 2) * 0.55          // bias toward horizontal floor
          : rand() * (Math.PI / 2);
        const x = c.x + dirX * Math.cos(spreadAng) * rad;
        const y = c.y + dirY * Math.sin(spreadAng) * rad;
        // Skip more often toward the centre → corner stays denser.
        if (rand() < t * 0.7) continue;
        world.dust.push({
          x, y,
          r: 0.5 + rand() * 1.0,
          a: 0.10 + rand() * 0.18,
        });
      }
    }
  }

  // A top-corner cobweb. Every anchor sits on a real wall (the corner vertex,
  // plus a "bridge" thread whose two ends are pinned to the top edge and the
  // side edge). Radials fan from the vertex out to the sagging bridge; rings
  // and braces weave between them. Nothing is pinned in mid-air, and because
  // the bridge and radials all hang below their anchors, every droop runs with
  // gravity — never against it.
  function buildTopCornerWeb(def, cp, maxReach, rand) {
    const startSpring = world.springs.length; // for per-corner break selection
    const spread     = maxReach * (0.55 + cp * 0.45);
    const numRadials = Math.max(4, Math.round(4 + cp * 3 + rand() * 1.5));
    const nodesPer   = 5; // segments from the vertex out to the bridge
    const maxSeg     = maxReach * 0.32;

    // Corner vertex: fixed anchor where the two walls meet.
    const V = addNode(def.x, def.y, true);

    // ── Bridge: top-edge anchor ── … ── side-edge anchor (both on walls) ──
    const dT = spread * (0.75 + rand() * 0.25); // reach along the top edge
    const dS = spread * (0.75 + rand() * 0.25); // reach down the side edge
    const topAnchor  = addNode(def.x + def.dirX * dT, 0, true);
    const sideAnchor = addNode(def.x, def.dirY * dS, true);

    const bridge = [topAnchor];
    const interiorCount = numRadials - 2;
    for (let i = 1; i <= interiorCount; i++) {
      const f = i / (interiorCount + 1);
      const x = topAnchor.x + (sideAnchor.x - topAnchor.x) * f;
      const y = topAnchor.y + (sideAnchor.y - topAnchor.y) * f;
      bridge.push(addNode(x, y, false)); // interior bridge nodes are free → sag
    }
    bridge.push(sideAnchor);
    for (let i = 0; i < bridge.length - 1; i++) {
      addSpring(bridge[i], bridge[i + 1], 1.0 + cp * 0.6, "frame");
    }

    // ── Radials: from the vertex out to every bridge node ──
    // Spacing biased toward the vertex (exponent > 1) so the mesh is dense near
    // the corner and opens up toward the bridge.
    const radials = [];
    for (const bn of bridge) {
      const chain = [V];
      let prev = V;
      for (let s = 1; s <= nodesPer; s++) {
        if (s === nodesPer) {
          addSpring(prev, bn, 1.0 + cp * 0.5, "frame"); // reuse bridge node as the tip
          chain.push(bn);
        } else {
          const f = Math.pow(s / nodesPer, 1.3);
          const node = addNode(V.x + (bn.x - V.x) * f, V.y + (bn.y - V.y) * f, false);
          addSpring(prev, node, s === 1 ? 1.0 + cp * 0.5 : 0.8, "frame");
          prev = node;
          chain.push(node);
        }
      }
      radials.push(chain);
    }

    // Helper: a thread only exists if both ends are within maxSeg of each other.
    const tryThread = (a, b, width, kind, skip) => {
      if (!a || !b) return;
      if (rand() < skip) return;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy > maxSeg * maxSeg) return;
      addSpring(a, b, width, kind);
    };

    // Weave rings + diagonal braces between neighbouring radials (triangles).
    // Density falls off outward so the centre-facing edge stays open.
    for (let k = 0; k < radials.length - 1; k++) {
      const A = radials[k], B = radials[k + 1];
      for (let r = 1; r < nodesPer; r++) { // bridge level already tied by the bridge
        const outward = r / nodesPer;
        const ringSkip  = 0.10 + (1 - cp) * 0.15 + outward * 0.40;
        const braceSkip = 0.35 + (1 - cp) * 0.15 + outward * 0.40;
        tryThread(A[r], B[r], 0.7, "ring", ringSkip);
        tryThread(A[r], B[r - 1], 0.5, "brace", braceSkip);
      }
    }

    // Decay: snap some of THIS corner's ring/brace threads. Frame is spared so
    // the web never fully vanishes. Deterministic via the shared `rand`.
    const breaks = world.params.breaks;
    if (breaks > 0) {
      for (let i = startSpring; i < world.springs.length; i++) {
        const s = world.springs[i];
        if (s.kind === "frame") continue;
        if (rand() < breaks) s.broken = true;
      }
    }

    // Dangling loose strands: hang straight down from interior web nodes (with
    // gravity). Strongest "abandoned cobweb" cue; only ever droop downward.
    const numStrands = world.params.strands;
    const interior = radials.flatMap((c) => c.slice(1, nodesPer)); // skip vertex & bridge tip
    for (let i = 0; i < numStrands && interior.length; i++) {
      const from = interior[Math.floor(rand() * interior.length)];
      const segs = 3 + Math.floor(rand() * 3);
      const len  = maxReach * (0.10 + rand() * 0.20);
      addStrand(from, len, segs, rand);
    }
  }

  // A loose strand hangs straight down from `from`; gravity settles it into a
  // natural droop during the settle pass. Only the attach point is fixed.
  function addStrand(from, length, segs, rand) {
    let prev = from;
    const segLen = length / segs;
    for (let s = 1; s <= segs; s++) {
      const jitter = (rand() - 0.5) * segLen * 0.3;
      const node = addNode(from.x + jitter, from.y + segLen * s, false);
      addSpring(prev, node, 0.5, "brace");
      prev = node;
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

  // ── Render (layered back-to-front: grime → dust → web) ──────────────────
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrime();
    drawDust();
    drawWeb();
  }

  // Layer 1: cool corner shadow + dusty haze. Two radial gradients per active
  // corner, both fading to transparent before the centre so it stays clean.
  function drawGrime() {
    const g = world.params.grime;
    if (g <= 0) return;
    for (const c of world.grimeCorners) {
      // Floor corners read a touch grimier than ceiling corners.
      const w = c.floor ? 1.3 : 1.0;
      // Dust haze — light cool grey, larger and softer.
      const hazeR = c.reach * 0.95;
      const haze = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, hazeR);
      haze.addColorStop(0, `rgba(135, 135, 142, ${0.07 * g * w})`);
      haze.addColorStop(1, "rgba(135, 135, 142, 0)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Vignette — subtle cool darkening tucked right into the corner.
      const vigR = c.reach * 0.6;
      const vig = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, vigR);
      vig.addColorStop(0, `rgba(55, 55, 62, ${0.11 * g * w})`);
      vig.addColorStop(1, "rgba(55, 55, 62, 0)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Layer 2: static dust motes — low-alpha cool-grey specks, no glow.
  function drawDust() {
    for (const d of world.dust) {
      ctx.fillStyle = `rgba(150, 150, 156, ${d.a})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Layer 3: the web. Cool-grey threads; short/near read clearly, long/far
  // fade out; frame scaffold keeps more weight than fine ring/brace threads.
  function drawWeb() {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const baseAlpha = world.params.opacity;
    const lenRef = (world.maxReach || 300) * 0.5;
    for (const s of world.springs) {
      if (s.broken) continue;
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const shortness = 1 - Math.min(1, len / lenRef);
      const kindMul = s.kind === "frame" ? 1.0 : s.kind === "ring" ? 0.8 : 0.6;
      const alpha = baseAlpha * (0.30 + 0.70 * shortness) * kindMul;
      ctx.strokeStyle = `rgba(160, 158, 162, ${alpha})`;
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

    // Animated settle: the web is built taut, then we wake the loop so the
    // user watches it sag and the dust appear over ~1s before it auto-sleeps
    // (per the kinetic-energy threshold). Gives a sense of decay creeping in.
    wake();
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
