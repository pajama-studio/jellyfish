// Every tunable in one place (Pajama Studio convention: config-driven systems).
// World units: the jellyfish bell is ~1.2 units across; the tank is a few metres of "sea".

const url = new URL(location.href);
const LOW = url.searchParams.get("q") === "low";

export const CONF = {
  low: LOW,

  // ---- fluid (staggered MAC grid, Ten Minute Physics #17 style) ----
  grid: LOW
    ? { nx: 48, ny: 64, nz: 48, h: 0.135 }
    : { nx: 64, ny: 88, nz: 64, h: 0.1 },
  fluid: {
    projectIters: LOW ? 10 : 14, // red-black SOR sweeps
    overRelax: 1.7,
    damping: 0.06,      // per-second velocity decay (open-water energy loss)
    vorticity: 0.3,     // vorticity confinement ε (GPU-Gems scale, F = ε·h·N̂×ω) — keep ≲0.5 or it explodes
    dt: 1 / 60,         // fixed fluid step, decoupled from render dt
    // station-keeping: the WORLD is shifted toward the origin with this time constant
    // (all positions, GPU-side) — the water never carries a fake counter-current.
    recenterTau: 3.0,
  },

  // ---- jellyfish soft body (Rudolf & Mould 2009, taken to true 3D) ----
  jelly: {
    rings: 16,          // meridian resolution (apex → margin)
    segs: 32,           // longitude resolution
    radius: 0.7,        // bell radius at margin (world units)
    height: 0.46,       // bell dome height — shallow, elegant saucer
    thetaMax: 1.72,     // how far the dome wraps (radians; >π/2 curls past equator)
    thickness: 0.09,    // mesoglea thickness at apex (paper: ~10% of diameter)
    nodeMass: 1.0,
    kStruct: 2400,      // Hookean spring stiffness (structural)
    kShear: 900,
    kThick: 2600,       // cross-shell springs (bending stiffness of the two-layer shell)
    kMuscleBase: 2200,  // circumferential muscle springs (subumbrellar shell)
    kDamp: 10,          // spring damping (along spring axis)
    // NOTE: keep tiny — this damps ABSOLUTE node velocity (an "ether drag") and any
    // real value anchors the body to the world frame, killing locomotion. Internal
    // oscillations are already handled by kDamp + the fluid coupling.
    globalDamp: 0.06,
    substeps: 8,        // spring substeps per frame
    sink: 0.04,         // gravity minus buoyancy (net slow sink when idle)
    drag: 26.0,         // fluid↔body momentum-exchange coefficient (bell)
    // Sub-grid jet model: the coarse fluid grid under-resolves the expelled jet's
    // momentum flux (the paper's IBM transfers it via pressure; drag coupling can't).
    // Reaction accel = jetK × d(activation)/dt during the power stroke.
    jetK: 0.12,
    dragTentacle: 3.0,
    muscle: {
      freq: 0.8,        // Hz — near the resonant gait of a real medusa (paper §3.3)
      contract: 0.48,   // max rest-length reduction of muscle springs (paper: down to 0.56×)
      wave: 0.22,       // phase lag apex→margin (contraction wave travel)
      attack: 0.2,      // fraction of the cycle spent contracting (fast in, slow out)
    },
  },

  // ---- trailing anatomy ----
  tentacles: { count: 14, segs: 24, length: 2.8, damp: 0.985, iters: 10 },
  arms: { count: 4, segs: 24, length: 2.9, damp: 0.99 },

  // ---- plankton tracer particles (they *are* the flow visualisation) ----
  particles: { count: LOW ? 16000 : 42000, size: 0.011, drift: 0.015 },

  // ---- spatial hash over bell nodes (Ten Minute Physics #11 style) ----
  hash: { size: 16384, bucket: 8, cell: 0.2, pushRadius: 0.1 },

  // ---- rendering ----
  render: {
    maxPixelRatio: LOW ? 1.5 : 2,
    bloom: { strength: 0.85, radius: 0.55, threshold: 0.24 },
    fogColor: 0x04101f,
  },
} as const;

// Fixed-point scale for i32 atomic accumulation (WebGPU has no float atomics).
export const FIXED = 1e5;
