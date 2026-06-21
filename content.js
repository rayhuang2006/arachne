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

    // Anchor corner: determined by seed, stable per hostname
    const cornerIndex = Math.floor(rand() * 4);
    const HALF_PI = Math.PI / 2;
    const corners = [
      { x: 0, y: 0, a0: 0,            a1: HALF_PI },      // top-left
      { x: W, y: 0, a0: HALF_PI,      a1: Math.PI },       // top-right
      { x: W, y: H, a0: Math.PI,      a1: 3 * HALF_PI },   // bottom-right
      { x: 0, y: H, a0: 3 * HALF_PI, a1: 2 * Math.PI },   // bottom-left
    ];
    const { x: ax, y: ay, a0, a1 } = corners[cornerIndex];

    // Number of radials (spokes) and rings scales with density
    const N = Math.max(3, Math.round(3 + density * 13));  // 3 – 16
    const M = Math.max(1, Math.round(1 + density * 11));  // 1 – 12

    const maxRadius = Math.min(W, H) * (0.30 + density * 0.30);

    // Radial angles: evenly spaced across the 90° arc with small jitter
    const span = a1 - a0;
    const angles = [];
    for (let i = 0; i < N; i++) {
      const base = a0 + (i / (N - 1)) * span;
      const jitter = (rand() - 0.5) * (span / (N - 1)) * 0.25;
      angles.push(base + jitter);
    }
    angles.sort((a, b) => a - b);

    // Ring radii with slight noise so they're not perfectly concentric
    const radii = [];
    for (let j = 0; j < M; j++) {
      const base = maxRadius * ((j + 1) / M);
      const jitter = (rand() - 0.5) * (maxRadius / M) * 0.15;
      radii.push(Math.max(8, base + jitter));
    }

    // Opacity scales with density: very faint at low density
    const opacity = 0.06 + density * 0.24;  // 0.06 – 0.30
    ctx.strokeStyle = `rgba(160, 160, 160, ${opacity})`;
    ctx.lineWidth = 0.7 + density * 0.6;    // 0.7 – 1.3 px
    ctx.lineCap = "round";

    // Draw radials
    for (const angle of angles) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(
        ax + Math.cos(angle) * maxRadius,
        ay + Math.sin(angle) * maxRadius,
      );
      ctx.stroke();
    }

    // Draw spiral rings: connect adjacent radial-ring intersection points
    for (const r of radii) {
      ctx.beginPath();
      for (let i = 0; i < angles.length; i++) {
        const px = ax + Math.cos(angles[i]) * r;
        const py = ay + Math.sin(angles[i]) * r;
        if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          // Slight inward quadratic curve for a more organic look
          const prev = angles[i - 1];
          const midAngle = (prev + angles[i]) / 2;
          const cpR = r * 0.92;
          ctx.quadraticCurveTo(
            ax + Math.cos(midAngle) * cpR,
            ay + Math.sin(midAngle) * cpR,
            px,
            py,
          );
        }
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
  // Usage from DevTools console:
  //   __arachneDebug(7200)  → simulate 2-hour idle (max density)
  //   __arachneDebug(300)   → simulate 5-min idle (sparse)
  //   __arachneDebug(0)     → clear

  window.__arachneDebug = function (seconds) {
    const idleMs = seconds * 1000;
    const density = idleToDensity(idleMs);
    console.log(`[Arachne debug] ${seconds}s → density ${density.toFixed(3)}`);
    drawWeb(idleMs);
  };
})();
