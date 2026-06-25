# Arachne

Arachne is a Chrome extension that lets idle browser tabs fall into disrepair. The longer a tab goes unvisited, the more it gathers cobwebs across the ceiling and dust along the floor. Everything is drawn procedurally on a full-page canvas and driven by a small, self-contained physics simulation. There are no images and no third-party libraries.

The effect is interactive: you can poke the web, and you can sweep dust and tear cobwebs away with the cursor as if using a broom.

## Overview

- Every tab is decorated with a single canvas overlay that does not intercept page input.
- A background worker measures how long each tab has been inactive and reports that idle duration to the page.
- The idle duration maps to a continuous decay phase, which drives a mass-spring web and a layer of floor and ceiling dust.
- When nothing is moving, the simulation stops completely and the CPU returns to idle. It only runs while settling or while the user is interacting.

## How it works

### Idle tracking

`background.js` records a last-seen timestamp for each tab and, when a tab regains focus, sends an `ARACHNE_IDLE_DURATION` message with the elapsed time. `content.js` converts that duration into a continuous phase in the range 0 to 4 across four reference stages:

| Stage | Idle time | Appearance |
| --- | --- | --- |
| Nascent | up to ~10 min | A few faint threads beginning at the top corners |
| Flourishing | ~10 to 60 min | The web fills across the ceiling, mostly intact |
| Disrepair | ~1 to 8 hours | Threads sag and snap; dust accumulates |
| Decay | beyond ~8 hours | The web collapses and tatters; heavy dust |

### The web as a physical system

The web is not drawn with geometric formulas. It is a set of point masses (nodes) connected by distance constraints (springs), simulated with Verlet integration:

- Nodes fall under gravity; springs hold their rest length so the structure keeps its shape.
- Anchor nodes are pinned to real edges only: the top edge and the upper part of the side walls. Nothing is anchored in mid-air, and every strand hangs downward with gravity rather than against it.
- Festoons drape between adjacent wall anchors and sag into natural catenaries. Cross threads weave neighbouring festoons into a triangulated mesh, and a small fan at each top corner gives the web its corner identity.
- The centre of the viewport and the entire floor are kept clear so page content stays readable.

### One web, a full lifecycle

The structure is generated once per page at full maturity. Each thread is tagged with a birth phase (when it grows in) and, for a portion of the fine threads, a break phase (when it snaps and leaves a dangling stub). The phase then reveals and decays this single structure rather than regenerating it, so the web grows from the corners, spreads across the ceiling, and then tatters as a continuous progression.

### Dust

Dust is a particle layer that rests in the bottom corners, along the floor, and in the ceiling corners. Each particle is rendered as a soft, layered puff so the dust reads as haze rather than dots, and each one accumulates at its own phase so grime creeps in over time. Every particle settles to the floor when disturbed.

### Interaction

- Moving the cursor near the web nudges nearby nodes; the elastic structure springs back.
- Moving the cursor through dust sweeps it like a broom: motes are carried along the cursor's motion, lifted in a low puff, and fall back under gravity.
- A slow pass over the web only makes it sway. A fast, deliberate sweep snaps the threads it crosses; the freed pieces fall and land on the floor as debris.

### Performance

The extension is injected into every page, so idle cost matters. The simulation runs inside a single animation loop governed by an auto-sleep mechanism:

- Each frame measures the total kinetic energy of the web and whether any dust is still in motion.
- Once everything is below a small threshold for a number of consecutive frames, the loop cancels itself and stops redrawing. The resting image remains on screen and CPU use returns to near zero.
- Cursor interaction wakes the loop; it runs only until the motion settles, then sleeps again.

### Determinism

The structure is seeded from the page hostname, so a given site always produces the same web, while different sites differ. Resizing the window rebuilds the structure for the new dimensions.

## Installation

This is an unpacked Manifest V3 extension.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked" and select this project directory.
4. Open or revisit tabs and leave them idle, or use the popup to preview the stages.

After editing any source file, reload the extension on `chrome://extensions` and refresh the target tab.

## Usage and debugging

Click the toolbar icon to open the debug popup. It provides:

- Buttons that jump the active tab to each stage (5 minutes, 45 minutes, 4 hours, 24 hours).
- A continuous phase slider (0 to 4) to scrub through the full growth-and-decay lifecycle live.

To see the dust and sweeping behaviour, set a later stage first so dust and a mature web are present, then move the cursor over the floor, the corners, or the web.

## Project structure

| File | Responsibility |
| --- | --- |
| `manifest.json` | Manifest V3 declaration: content script, background worker, popup, storage permission |
| `background.js` | Per-tab idle tracking and idle-duration messaging |
| `content.js` | Canvas overlay, physics simulation, rendering, interaction, and the sleep loop |
| `popup.html` / `popup.js` | Debug controls: stage buttons and the phase slider |

## Implementation notes

- Pure canvas rendering with no image assets and no external or physics libraries; the integrator and constraint solver are implemented directly.
- Verlet integration with iterative distance constraints for stability on rope-like meshes.
- Soft dust puffs are pre-rendered once to offscreen sprites and blitted per particle to keep rendering cheap.
- The kinetic-energy-based sleep gate is the core of the performance design and is the reason the extension can run on every page without ongoing cost.
