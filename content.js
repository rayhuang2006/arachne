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

  // ── Main draw ────────────────────────────────────────────────────────────
  function drawWeb(idleMs) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const phase = idleToPhase(idleMs);
    if (phase < 0.05) return;

    const W = canvas.width, H = canvas.height;

    const seed = hashSeed(location.hostname || "newtab");
    const rand = mulberry32(seed);

    // Corner appearance order: shuffle once per site
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    // Global opacity ramps up then slightly fades in decay
    const opacity =
      phase < 1 ? 0.10 + phase * 0.10
      : phase < 2 ? 0.20 + (phase - 1) * 0.06
      : phase < 3 ? 0.26 - (phase - 2) * 0.02
      : 0.24;

    // Max reach from any corner: hard-capped so center stays clear
    const maxReach = Math.min(W * 0.48, H * 0.48, Math.min(W, H) * (0.20 + phase * 0.072));

    // How many corners are active
    const numActive = Math.min(4, Math.floor(phase) + 1);

    // [cornerX, cornerY, fanStart°, fanEnd°] — angles in radians
    const P2 = Math.PI / 2;
    const cornerDefs = [
      { x: 0, y: 0, a0: 0,      a1: P2 },         // top-left
      { x: W, y: 0, a0: P2,     a1: Math.PI },     // top-right
      { x: W, y: H, a0: Math.PI,a1: 3 * P2 },      // bottom-right
      { x: 0, y: H, a0: 3 * P2, a1: 2 * Math.PI }, // bottom-left
    ];

    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    // ── Layer 1: corner webs ─────────────────────────────────────────────
    for (let ci = 0; ci < numActive; ci++) {
      const def = cornerDefs[order[ci]];
      const cp  = Math.min(1, phase - ci); // this corner's maturity 0→1
      if (cp <= 0) continue;

      const spread      = maxReach * (0.40 + cp * 0.60);
      const numRadials  = Math.max(3, Math.round(3 + cp * 3 + rand() * 1.5));
      const numRings    = Math.max(2, Math.round(2 + cp * 3));
      const fanSpan     = def.a1 - def.a0;

      // Build radial angles: always anchor both fan edges, fill in between
      const angles = [
        def.a0 + rand() * fanSpan * 0.12,
        def.a1 - rand() * fanSpan * 0.12,
      ];
      for (let k = 0; k < numRadials - 2; k++) {
        const base  = def.a0 + ((k + 1) / (numRadials - 1)) * fanSpan;
        const noise = (rand() - 0.5) * (fanSpan / numRadials) * 0.9;
        angles.push(base + noise);
      }
      angles.sort((a, b) => a - b);

      // Radial endpoints (varying lengths for ragged look)
      const eps = angles.map(angle => ({
        angle,
        x: def.x + Math.cos(angle) * spread * (0.50 + rand() * 0.50),
        y: def.y + Math.sin(angle) * spread * (0.50 + rand() * 0.50),
      }));

      // Draw radials
      ctx.strokeStyle = `rgba(218, 212, 200, ${Math.min(0.9, opacity * 1.35)})`;
      ctx.lineWidth   = 0.9 + cp * 0.55;
      for (const ep of eps) {
        ctx.beginPath();
        ctx.moveTo(def.x, def.y);
        ctx.lineTo(ep.x, ep.y);
        ctx.stroke();
      }

      // Draw connecting rings between adjacent radials
      ctx.strokeStyle = `rgba(218, 212, 200, ${Math.min(0.9, opacity * 0.90)})`;
      ctx.lineWidth   = 0.55;
      for (let r = 0; r < numRings; r++) {
        const t = (r + 1) / (numRings + 1);
        for (let k = 0; k < angles.length - 1; k++) {
          // Younger corners are more ragged (higher skip rate)
          if (rand() < 0.10 + (1 - cp) * 0.22) continue;

          const r1 = spread * t * (0.88 + rand() * 0.24);
          const r2 = spread * t * (0.88 + rand() * 0.24);
          const x1 = def.x + Math.cos(angles[k])     * r1;
          const y1 = def.y + Math.sin(angles[k])     * r1;
          const x2 = def.x + Math.cos(angles[k + 1]) * r2;
          const y2 = def.y + Math.sin(angles[k + 1]) * r2;

          const span = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
          const sag  = span * 0.055 * (1 + phase * 0.25);

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.quadraticCurveTo(
            (x1 + x2) / 2 + (rand() - 0.5) * 8,
            (y1 + y2) / 2 + sag + (rand() - 0.5) * 4,
            x2, y2,
          );
          ctx.stroke();
        }
      }
    }

    // ── Layer 2: drooping threads ─────────────────────────────────────────
    if (phase > 0.8) {
      const numDrops = Math.floor((phase - 0.8) * 7);

      // Anchor points: corners + points distributed along each edge
      const anc = [
        [0,       0      ], [W,       0      ], [W,       H      ], [0,       H      ],
        [W * 0.2, 0      ], [W * 0.5, 0      ], [W * 0.8, 0      ],
        [0,       H * 0.2], [0,       H * 0.5], [0,       H * 0.8],
        [W,       H * 0.2], [W,       H * 0.5], [W,       H * 0.8],
        [W * 0.2, H      ], [W * 0.5, H      ], [W * 0.8, H      ],
      ];

      ctx.strokeStyle = `rgba(218, 212, 200, ${Math.min(0.9, opacity * 0.60)})`;
      ctx.lineWidth   = 0.65;

      for (let i = 0; i < numDrops; i++) {
        let ai = Math.floor(rand() * anc.length);
        let aj = Math.floor(rand() * anc.length);
        // Avoid same point; bias toward corner-to-corner or corner-to-edge
        if (ai === aj) aj = (aj + 1) % anc.length;

        const x1 = anc[ai][0] + (rand() - 0.5) * W * 0.07;
        const y1 = anc[ai][1] + (rand() - 0.5) * H * 0.07;
        const x2 = anc[aj][0] + (rand() - 0.5) * W * 0.07;
        const y2 = anc[aj][1] + (rand() - 0.5) * H * 0.07;

        const span = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const sag  = span * (0.07 + rand() * 0.16) * (0.5 + phase * 0.28);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(
          x1 + (x2 - x1) / 3,       y1 + (y2 - y1) / 3       + sag,
          x1 + (x2 - x1) * (2 / 3), y1 + (y2 - y1) * (2 / 3) + sag,
          x2, y2,
        );
        ctx.stroke();
      }
    }

    // ── Layer 3: stray threads ────────────────────────────────────────────
    if (phase > 0.5) {
      const numStrays  = Math.floor((phase - 0.5) * 18);
      const strayZone  = Math.min(W, H) * Math.min(0.38, 0.10 + phase * 0.065);
      const corners4   = [[0, 0], [W, 0], [W, H], [0, H]];

      ctx.strokeStyle = `rgba(218, 212, 200, ${Math.min(0.9, opacity * 0.38)})`;
      ctx.lineWidth   = 0.40;

      for (let i = 0; i < numStrays; i++) {
        const c  = corners4[Math.floor(rand() * 4)];
        const ox = c[0] + (rand() - 0.5) * strayZone;
        const oy = c[1] + (rand() - 0.5) * strayZone;
        const len = 12 + rand() * 65;
        const ang = rand() * Math.PI * 2;
        const ex  = ox + Math.cos(ang) * len;
        const ey  = oy + Math.sin(ang) * len;

        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.quadraticCurveTo(
          (ox + ex) / 2 + (rand() - 0.5) * 14,
          (oy + ey) / 2 + (rand() - 0.5) * 14,
          ex, ey,
        );
        ctx.stroke();
      }
    }
  }

  // ── Message listener (from background worker) ────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ARACHNE_IDLE_DURATION") {
      console.log(`[Arachne] 這個分頁閒置了 ${msg.label}（${msg.idleMs} ms）`);
      drawWeb(msg.idleMs);
    }
  });

  // ── Debug listener (from popup or DevTools) ──────────────────────────────
  window.addEventListener("arachne-debug", (e) => {
    const idleMs = e.detail.seconds * 1000;
    const phase  = idleToPhase(idleMs);
    console.log(`[Arachne debug] ${e.detail.seconds}s → phase ${phase.toFixed(2)}`);
    drawWeb(idleMs);
  });
})();
