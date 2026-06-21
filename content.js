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

  // Logarithmic curve: idle time → [0, 1] density
  // ~0 at 0 min, ~0.35 at 5 min, ~0.75 at 30 min, 1.0 at 2 hours
  function idleToDensity(idleMs) {
    const minutes = idleMs / 60000;
    const d = Math.log(1 + minutes / 5) / Math.log(1 + 120 / 5);
    return Math.min(1, Math.max(0, d));
  }

  function drawWeb(idleMs) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const density = idleToDensity(idleMs);
    if (density < 0.05) return;

    const W = canvas.width;
    const H = canvas.height;

    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);

    // ── Corner & anchor ───────────────────────────────────────────────────
    const cornerIndex = Math.floor(rand() * 4);
    const HALF_PI = Math.PI / 2;
    const corners = [
      { x: 0, y: 0, a0: 0,           a1: HALF_PI },
      { x: W, y: 0, a0: HALF_PI,     a1: Math.PI },
      { x: W, y: H, a0: Math.PI,     a1: 3 * HALF_PI },
      { x: 0, y: H, a0: 3 * HALF_PI, a1: 2 * Math.PI },
    ];
    const { x: cx, y: cy, a0, a1 } = corners[cornerIndex];

    // Offset anchor slightly inward so the hub isn't pixel-perfect at the corner
    const offsetDist = 10 + rand() * 20;
    const offsetAngle = (a0 + a1) / 2;
    const ax = cx + Math.cos(offsetAngle) * offsetDist;
    const ay = cy + Math.sin(offsetAngle) * offsetDist;

    // ── Structure counts ──────────────────────────────────────────────────
    const N = Math.max(3, Math.round(3 + density * 13));   // 3 – 16 radials
    const M = Math.max(1, Math.round(1 + density * 11));   // 1 – 12 rings

    const maxRadius = Math.min(W, H) * (0.30 + density * 0.30);

    // ── Radial angles: uneven spacing, larger jitter ──────────────────────
    const span = a1 - a0;
    const angles = [];
    for (let i = 0; i < N; i++) {
      const base = a0 + (i / (N - 1)) * span;
      const jitter = (rand() - 0.5) * (span / (N - 1)) * 0.45;
      angles.push(base + jitter);
    }
    angles.sort((a, b) => a - b);

    // Per-radial length variation: some spokes stop short
    const radialLengths = angles.map(() => {
      const cutShort = rand() < 0.15 + (1 - density) * 0.25;
      return cutShort ? (0.5 + rand() * 0.4) * maxRadius : maxRadius;
    });

    // ── Ring radii: non-linear spacing, vary gap sizes ────────────────────
    const radii = [];
    let r = 0;
    for (let j = 0; j < M; j++) {
      // Gaps are wider near center, tighter mid-web — like real orb weavers
      const progress = (j + 1) / M;
      const gapBase = maxRadius * (0.6 * Math.pow(progress, 0.7) + 0.4 * progress) / M * M;
      const jitter = (rand() - 0.5) * (maxRadius / M) * 0.35;
      r = Math.max(r + 12, gapBase + jitter);
      if (r > maxRadius) break;
      radii.push(r);
    }

    // ── Opacity & base styles ─────────────────────────────────────────────
    const baseOpacity = 0.06 + density * 0.24;
    ctx.lineCap = "round";

    // ── Draw radials (frame silk — thicker, more opaque) ──────────────────
    ctx.strokeStyle = `rgba(155, 150, 140, ${baseOpacity})`;
    ctx.lineWidth = 1.2 + density * 0.9;

    for (let i = 0; i < angles.length; i++) {
      const len = radialLengths[i];
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + Math.cos(angles[i]) * len, ay + Math.sin(angles[i]) * len);
      ctx.stroke();
    }

    // ── Draw spiral rings (capture silk — finer, slightly transparent) ────
    ctx.strokeStyle = `rgba(155, 150, 140, ${baseOpacity * 0.65})`;
    ctx.lineWidth = 0.5 + density * 0.55;

    // Probability a segment is missing (tear/gap): higher at low density
    const tearChance = 0.28 * (1 - density) + 0.04;

    for (const ringR of radii) {
      // Occasionally skip an entire ring at low density
      if (rand() < (1 - density) * 0.18) continue;

      ctx.beginPath();
      let penDown = false;

      for (let i = 0; i < angles.length; i++) {
        // Only draw to this radial if the spoke reaches this ring
        if (ringR > radialLengths[i]) {
          penDown = false;
          continue;
        }

        const px = ax + Math.cos(angles[i]) * ringR;
        const py = ay + Math.sin(angles[i]) * ringR;

        if (!penDown) {
          ctx.moveTo(px, py);
          penDown = true;
          continue;
        }

        // Random tear: lift pen and skip this segment
        if (rand() < tearChance) {
          ctx.moveTo(px, py);
          continue;
        }

        // Catenary-like sag: cubic bezier with outward-bowed control points
        const prev = angles[i - 1];
        const cur  = angles[i];
        const p0x = ax + Math.cos(prev) * ringR;
        const p0y = ay + Math.sin(prev) * ringR;

        // Control points at 1/3 and 2/3 along chord, displaced outward
        const sagAmount = (ringR / maxRadius) * (8 + rand() * 10);
        const midAngle  = (prev + cur) / 2;
        const outX = Math.cos(midAngle);
        const outY = Math.sin(midAngle);

        const cp1x = p0x * 2/3 + px * 1/3 + outX * sagAmount;
        const cp1y = p0y * 2/3 + py * 1/3 + outY * sagAmount;
        const cp2x = p0x * 1/3 + px * 2/3 + outX * sagAmount;
        const cp2y = p0y * 1/3 + py * 2/3 + outY * sagAmount;

        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, px, py);
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
    const density = idleToDensity(idleMs);
    console.log(`[Arachne debug] ${e.detail.seconds}s → density ${density.toFixed(3)}`);
    drawWeb(idleMs);
  });
})();
