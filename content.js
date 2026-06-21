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

  function drawWeb(idleMs) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const phase = idleToPhase(idleMs);
    if (phase < 0.06) return;

    const W = canvas.width;
    const H = canvas.height;
    const TWO_PI = Math.PI * 2;

    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);

    // ── Lifecycle parameters ──────────────────────────────────────────────
    const PEAK  = 1.5;
    const bell  = Math.exp(-Math.pow((phase - PEAK) / 2.0, 2) * 2.5); // 0→1→0
    const decay = Math.max(0, (phase - PEAK) / 2.5);                  // 0 at peak → 1
    const dp2   = decay * decay;

    const ringCount    = Math.max(2, Math.round(2 + 12 * bell));
    const tearRate     = dp2 * 0.55;
    const spacingNoise = dp2 * 0.90;   // inter-ring spacing chaos
    const sagBase      = 5 + decay * 22;
    const radialSurv   = 1 - decay * 0.65;   // fraction of full-length radials
    const frameSurv    = 1 - Math.max(0, decay - 0.5) * 0.72;
    const opacity      = 0.04 + bell * 0.22;
    const waver        = decay * 16;          // px of radial waviness

    // ── Hub: seeded position, upper-biased ───────────────────────────────
    const hubX = W * (0.22 + rand() * 0.56);
    const hubY = H * (0.13 + rand() * 0.30);

    // ── Frame: 4–6 irregular anchor vertices near screen edges ───────────
    const frameN = 4 + Math.floor(rand() * 3);
    const frameAngles = [];
    for (let i = 0; i < frameN; i++) {
      const base = (i / frameN) * TWO_PI;
      frameAngles.push(base + (rand() - 0.5) * (TWO_PI / frameN) * 0.38);
    }
    frameAngles.sort((a, b) => a - b);

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

    const frameVerts = frameAngles.map(a => {
      const d = edgeDist(a);
      return { x: hubX + Math.cos(a) * d, y: hubY + Math.sin(a) * d };
    });

    // ── Radials: frame angles + gap subdivisions ──────────────────────────
    const allAngles = [...frameAngles];
    for (let i = 0; i < frameAngles.length; i++) {
      let a1 = frameAngles[i];
      let a2 = frameAngles[(i + 1) % frameAngles.length];
      if (a2 <= a1) a2 += TWO_PI;
      const span = a2 - a1;
      const extras = Math.floor(span / (Math.PI / 8));
      for (let k = 1; k <= extras; k++) {
        const a = a1 + span * (k / (extras + 1)) + (rand() - 0.5) * span / (extras + 1) * 0.22;
        allAngles.push(((a % TWO_PI) + TWO_PI) % TWO_PI);
      }
    }
    allAngles.sort((a, b) => a - b);

    // Build radial objects (always consume same rand() count per angle)
    const radials = allAngles.map(angle => {
      const fullDist   = edgeDist(angle);
      const survRoll   = rand();
      const cutFactor  = 0.2 + rand() * 0.45;
      const dist       = survRoll < radialSurv ? fullDist : fullDist * cutFactor;
      const midX       = hubX + Math.cos(angle) * fullDist * 0.5;
      const midY       = hubY + Math.sin(angle) * fullDist * 0.5;
      const waveMx     = midX + (rand() - 0.5) * waver;
      const waveMy     = midY + (rand() - 0.5) * waver;
      return { angle, dist, fullDist, waveMx, waveMy,
               endX: hubX + Math.cos(angle) * dist,
               endY: hubY + Math.sin(angle) * dist };
    });

    const maxDist = Math.max(...radials.map(r => r.fullDist));

    // ── Spiral ring distances from hub (outside→in, tighter near center) ─
    const ringDists = [];
    for (let i = 0; i < ringCount; i++) {
      const t      = (i + 0.5) / ringCount;
      const baseR  = maxDist * (0.11 + (1 - Math.pow(t, 0.62)) * 0.79);
      const jitter = (rand() - 0.5) * (maxDist / ringCount) * spacingNoise * 2.5;
      ringDists.push(Math.max(20, baseR + jitter));
    }
    ringDists.sort((a, b) => b - a); // draw outermost first

    // ── Drawing ───────────────────────────────────────────────────────────
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    // Frame edges (irregular polygon)
    ctx.strokeStyle = `rgba(143, 136, 122, ${opacity * 1.2})`;
    ctx.lineWidth   = 1.3 + bell * 0.9;
    for (let i = 0; i < frameVerts.length; i++) {
      const skipRoll = rand();
      if (skipRoll > frameSurv) continue;
      const v1 = frameVerts[i];
      const v2 = frameVerts[(i + 1) % frameVerts.length];
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      // Gravity sag proportional to horizontal span
      const sagY = Math.abs(v2.x - v1.x) * 0.05 * (1 + decay * 3);
      ctx.quadraticCurveTo(
        (v1.x + v2.x) / 2,
        (v1.y + v2.y) / 2 + sagY,
        v2.x, v2.y,
      );
      ctx.stroke();
    }

    // Radials (frame silk — thicker, more opaque)
    ctx.strokeStyle = `rgba(143, 136, 122, ${opacity})`;
    ctx.lineWidth   = 1.1 + bell * 0.75;
    for (const rad of radials) {
      ctx.beginPath();
      ctx.moveTo(hubX, hubY);
      ctx.quadraticCurveTo(rad.waveMx, rad.waveMy, rad.endX, rad.endY);
      ctx.stroke();
    }

    // Capture spiral (finer, lighter)
    ctx.strokeStyle = `rgba(143, 136, 122, ${opacity * 0.65})`;
    ctx.lineWidth   = 0.45 + bell * 0.55;

    for (const ringR of ringDists) {
      const ringSkip = rand();
      if (ringSkip < dp2 * 0.22) continue; // decay causes whole rings to vanish

      ctx.beginPath();
      let penDown = false, prevX = 0, prevY = 0, prevAngle = 0;

      for (let i = 0; i < radials.length; i++) {
        const rad = radials[i];
        // Always consume 3 rand() per (ring, radial) for sequence stability
        const jR   = ringR * (1 + (rand() - 0.5) * spacingNoise * 0.35);
        const tear = rand();
        const sagR = rand();

        if (jR > rad.dist * 0.97) { penDown = false; continue; }

        const px = hubX + Math.cos(rad.angle) * jR;
        const py = hubY + Math.sin(rad.angle) * jR;

        if (!penDown) {
          ctx.moveTo(px, py);
          penDown = true; prevX = px; prevY = py; prevAngle = rad.angle;
          continue;
        }

        if (tear < tearRate) {
          ctx.moveTo(px, py);
          prevX = px; prevY = py; prevAngle = rad.angle;
          continue;
        }

        // Catenary sag: cubic bezier bowed outward from hub
        const mid = (prevAngle + rad.angle) / 2;
        const sag = (jR / maxDist) * sagBase * (0.65 + sagR * 0.7);
        const ox  = Math.cos(mid) * sag;
        const oy  = Math.sin(mid) * sag;

        ctx.bezierCurveTo(
          prevX * 2/3 + px * 1/3 + ox, prevY * 2/3 + py * 1/3 + oy,
          prevX * 1/3 + px * 2/3 + ox, prevY * 1/3 + py * 2/3 + oy,
          px, py,
        );
        prevX = px; prevY = py; prevAngle = rad.angle;
      }
      ctx.stroke();
    }
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
