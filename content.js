(function () {
  // ── Phase 1: canvas overlay ──────────────────────────────────────────────

  if (document.getElementById("arachne-canvas")) return;

  const canvas = document.createElement("canvas");
  canvas.id = "arachne-canvas";

  Object.assign(canvas.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    pointerEvents: "none",
  });

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // ── Phase 3: spider web generation ──────────────────────────────────────

  // Seeded PRNG — same seed always produces the same sequence
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a hash: hostname string → stable integer seed
  function hashSeed(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Idle time → lifecycle phase (0–4)
  // 0–1: nascent  1–2: prime (peak ~1.5)  2–3: degraded  3–4: decayed
  function idleToPhase(idleMs) {
    const m = idleMs / 60000;
    if (m < 10)  return m / 10;
    if (m < 60)  return 1 + (m - 10) / 50;
    if (m < 480) return 2 + (m - 60) / 420;
    return Math.min(4, 3 + (m - 480) / 480);
  }

  // Gaussian approximation via Box-Muller
  function randn(rand) {
    const u = 1 - rand(), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function drawWeb(idleMs) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const phase = idleToPhase(idleMs);
    if (phase < 0.06) return;

    const W = canvas.width;
    const H = canvas.height;
    const TWO_PI = Math.PI * 2;
    const DEG = Math.PI / 180;

    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);

    // ── Behavioral parameters by lifecycle phase ──────────────────────────
    // phase 0–1: nascent  1–2: prime (peak 1.5)  2–3: degraded  3–4: decayed
    //
    // β is the spiral-radial crossing angle. Convergence requires β > 90°−α/2
    // where α = inter-radial gap. With ~20 radials α≈18°, β_crit≈81°.
    // β=85° → each step shrinks radius to ~97.8%, one full circuit to ~64%.
    // Lowering β toward β_crit slows convergence (fewer rings before stopping).
    let betaBaseDeg, angleNoiseDeg, skipRate, sagMult, opacity,
        frameWidth, radialWidth, spiralWidth;

    if (phase < 1) {
      const t = phase;
      betaBaseDeg   = 83.5;                           // slow convergence → sparse rings
      angleNoiseDeg = 5;
      skipRate      = 0.05;
      sagMult       = 1;
      opacity       = 0.06 + t * 0.08;
      frameWidth    = 1.2;
      radialWidth   = 1.0;
      spiralWidth   = 0.5;
    } else if (phase < 2) {
      const t = phase - 1;                            // 0→1, peak at 0.5
      const bell = Math.exp(-Math.pow((t - 0.5) / 0.35, 2));
      betaBaseDeg   = 85 + bell * 1.5;               // 85→86.5→85: tighter at peak
      angleNoiseDeg = 4 - bell * 2;                   // 4→2→4
      skipRate      = 0.05 - bell * 0.03;             // 5%→2%→5%
      sagMult       = 1;
      opacity       = 0.14 + bell * 0.12;
      frameWidth    = 1.6 + bell * 0.6;
      radialWidth   = 1.3 + bell * 0.5;
      spiralWidth   = 0.6 + bell * 0.4;
    } else if (phase < 3) {
      const t = phase - 2;
      betaBaseDeg   = 85 - t * 3;                    // 85→82: looser, fewer rings
      angleNoiseDeg = 4 + t * 11;                     // 4→15
      skipRate      = 0.05 + t * 0.15;                // 5%→20%
      sagMult       = 1 + t * 1.5;                    // 1→2.5
      opacity       = 0.14 - t * 0.05;
      frameWidth    = 1.6 - t * 0.4;
      radialWidth   = 1.3 - t * 0.3;
      spiralWidth   = 0.55;
    } else {
      const t = Math.min(1, phase - 3);
      betaBaseDeg   = 82 - t * 1.5;                  // 82→80.5: near β_crit, very few rings
      angleNoiseDeg = 15 + t * 20;                    // 15→35
      skipRate      = 0.20 + t * 0.30;                // 20%→50%
      sagMult       = 2.5 + t * 3.5;                  // 2.5→6
      opacity       = 0.09 - t * 0.04;
      frameWidth    = 1.2;
      radialWidth   = 1.0;
      spiralWidth   = 0.45;
    }

    const betaBase      = betaBaseDeg * DEG;
    const angleNoiseRad = angleNoiseDeg * DEG;

    // ── Hub: seeded position, upper-biased ───────────────────────────────
    const hubX = W * (0.22 + rand() * 0.56);
    const hubY = H * (0.13 + rand() * 0.30);

    // Project from hub in direction `angle` until near screen edge
    function edgeDist(angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      let t = 1e9;
      if (c >  1e-9) t = Math.min(t, (W * 0.96 - hubX) / c);
      if (c < -1e-9) t = Math.min(t, (W * 0.04 - hubX) / c);
      if (s >  1e-9) t = Math.min(t, (H * 0.96 - hubY) / s);
      if (s < -1e-9) t = Math.min(t, (H * 0.04 - hubY) / s);
      return t * (0.80 + rand() * 0.16);
    }

    // ── Frame: 4–7 irregular anchor vertices near screen edges ───────────
    const frameN = 4 + Math.floor(rand() * 4);
    const frameAngles = [];
    for (let i = 0; i < frameN; i++) {
      const base = (i / frameN) * TWO_PI;
      frameAngles.push(base + (rand() - 0.5) * (TWO_PI / frameN) * 0.4);
    }
    frameAngles.sort((a, b) => a - b);

    const frameVerts = frameAngles.map(a => {
      const d = edgeDist(a);
      return { x: hubX + Math.cos(a) * d, y: hubY + Math.sin(a) * d, angle: a, dist: d };
    });

    // ── Radials: frame directions + gap subdivisions ──────────────────────
    const allAngles = [...frameAngles];
    for (let i = 0; i < frameAngles.length; i++) {
      let a1 = frameAngles[i];
      let a2 = frameAngles[(i + 1) % frameAngles.length];
      if (a2 <= a1) a2 += TWO_PI;
      const span = a2 - a1;
      const extras = Math.floor(span / (Math.PI / 9));
      for (let k = 1; k <= extras; k++) {
        const frac = k / (extras + 1);
        const noise = (rand() - 0.5) * span * frac * (1 - frac) * 0.3;
        const a = a1 + span * frac + noise;
        allAngles.push(((a % TWO_PI) + TWO_PI) % TWO_PI);
      }
    }
    allAngles.sort((a, b) => a - b);
    const N = allAngles.length;

    // Build radials (consume deterministic rand() budget per radial)
    const radials = allAngles.map(angle => {
      const fullDist = edgeDist(angle);
      rand(); // reserved slot for sequence stability
      return { angle, dist: fullDist,
               ex: hubX + Math.cos(angle) * fullDist,
               ey: hubY + Math.sin(angle) * fullDist };
    });

    const maxDist = Math.max(...radials.map(r => r.dist));

    // ── Eberhard turnback rule ────────────────────────────────────────────
    // Spider at Q on radial[i] steps to radial[i+1] at the distance that
    // makes the silk cross the radial at angle β. Pure local geometry:
    //
    //   d_next = (Q·e1) + |Q·e2| / tan(β)
    //
    // where e1 = unit along next radial, e2 = unit perp to next radial.
    // For β > 90°−α/2 (α = inter-radial gap), d_next < |Q| → natural inward spiral.
    function turnbackDist(prevDist, prevAngle, nextAngle, beta) {
      const Qx  = Math.cos(prevAngle) * prevDist;
      const Qy  = Math.sin(prevAngle) * prevDist;
      const e1x = Math.cos(nextAngle), e1y = Math.sin(nextAngle);
      const Qe1 = Qx * e1x + Qy * e1y;
      const Qe2 = Math.abs(-Qx * e1y + Qy * e1x);   // |Q × e1|, perp component
      return Math.max(4, Qe1 + Qe2 / Math.tan(beta));
    }

    // ── Continuous spider walk (no outer ring loop) ───────────────────────
    // Spider starts near the shortest radial's tip and walks continuously.
    // Convergence is the natural result of β > β_crit; we stop when the
    // spider reaches the hub zone (curDist < maxDist * 0.05) or after a
    // safety-cap of N * 40 steps (prevents infinite loop if β ≈ β_crit).
    const minDist  = Math.min(...radials.map(r => r.dist));
    let curDist    = minDist * (0.82 + rand() * 0.12);
    let curIdx     = 0;
    const stopDist = maxDist * 0.05;
    const maxSteps = N * 40;

    const spiralSegments = [];

    for (let step = 0; step < maxSteps; step++) {
      const i     = curIdx % N;
      const iNext = (i + 1) % N;
      const radCur  = radials[i];
      const radNext = radials[iNext];

      const x1 = hubX + Math.cos(radCur.angle) * curDist;
      const y1 = hubY + Math.sin(radCur.angle) * curDist;

      // Consume 2 rand() slots regardless of skip, keeping sequence stable
      const skipRoll = rand();
      const noiseVal = randn(rand);

      // Apply noisy β; on a skip we still advance curDist via β_base
      const beta     = betaBase + noiseVal * angleNoiseRad;
      let nextDist   = turnbackDist(curDist, radCur.angle, radNext.angle,
                                    skipRoll < skipRate ? betaBase : beta);
      nextDist = Math.min(nextDist, radNext.dist * 0.96);
      nextDist = Math.max(4, nextDist);

      if (skipRoll >= skipRate) {
        const x2 = hubX + Math.cos(radNext.angle) * nextDist;
        const y2 = hubY + Math.sin(radNext.angle) * nextDist;

        const midAngle = (radCur.angle + radNext.angle) / 2;
        const span     = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const sagAmt   = span * 0.04 * sagMult * (0.7 + rand() * 0.6);
        const ox = Math.cos(midAngle) * sagAmt;
        const oy = Math.sin(midAngle) * sagAmt;
        spiralSegments.push({ x1, y1, x2, y2, ox, oy });
      } else {
        rand(); // keep sag slot consumed for skipped steps too
      }

      curDist = nextDist;
      curIdx  = iNext;
      if (curDist <= stopDist) break;
    }

    // ── Drawing ───────────────────────────────────────────────────────────
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    // Frame edges (irregular polygon, sag downward)
    ctx.strokeStyle = `rgba(143, 136, 122, ${Math.min(0.9, opacity * 1.3)})`;
    ctx.lineWidth   = frameWidth;
    for (let i = 0; i < frameVerts.length; i++) {
      // skip roll for degraded/decayed frames
      const skipRoll = rand();
      if (skipRoll < skipRate * 0.5) continue;
      const v1 = frameVerts[i];
      const v2 = frameVerts[(i + 1) % frameVerts.length];
      const span = Math.sqrt((v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2);
      const sagY = span * 0.04 * sagMult;
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      ctx.bezierCurveTo(
        v1.x + (v2.x - v1.x) / 3,     v1.y + (v2.y - v1.y) / 3 + sagY,
        v1.x + (v2.x - v1.x) * 2 / 3, v1.y + (v2.y - v1.y) * 2 / 3 + sagY,
        v2.x, v2.y,
      );
      ctx.stroke();
    }

    // Radials
    ctx.strokeStyle = `rgba(143, 136, 122, ${Math.min(0.9, opacity * 1.1)})`;
    ctx.lineWidth   = radialWidth;
    for (const rad of radials) {
      ctx.beginPath();
      ctx.moveTo(hubX, hubY);
      ctx.lineTo(rad.ex, rad.ey);
      ctx.stroke();
    }

    // Sticky spiral
    ctx.strokeStyle = `rgba(143, 136, 122, ${Math.min(0.9, opacity * 0.75)})`;
    ctx.lineWidth   = spiralWidth;
    ctx.beginPath();
    for (const seg of spiralSegments) {
      ctx.moveTo(seg.x1, seg.y1);
      ctx.bezierCurveTo(
        seg.x1 * 2/3 + seg.x2 * 1/3 + seg.ox, seg.y1 * 2/3 + seg.y2 * 1/3 + seg.oy,
        seg.x1 * 1/3 + seg.x2 * 2/3 + seg.ox, seg.y1 * 1/3 + seg.y2 * 2/3 + seg.oy,
        seg.x2, seg.y2,
      );
    }
    ctx.stroke();
  }

  // ── Phase 2: receive idle duration from background worker ────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ARACHNE_IDLE_DURATION") {
      console.log(`[Arachne] 這個分頁閒置了 ${msg.label}（${msg.idleMs} ms）`);
      drawWeb(msg.idleMs);
    }
  });

  // ── Debug helper ─────────────────────────────────────────────────────────
  // __arachneDebug() is defined in debug.js (world: MAIN) so DevTools can
  // call it directly. It fires a CustomEvent that we catch here.
  //
  // Usage from DevTools console:
  //   __arachneDebug(7200)  → simulate 2-hour idle (max density)
  //   __arachneDebug(300)   → simulate 5-min idle (sparse)
  //   __arachneDebug(0)     → clear

  window.addEventListener("arachne-debug", (e) => {
    const idleMs = e.detail.seconds * 1000;
    const phase = idleToPhase(idleMs);
    console.log(`[Arachne debug] ${e.detail.seconds}s → phase ${phase.toFixed(2)}`);
    drawWeb(idleMs);
  });
})();
