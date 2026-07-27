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
    dt: 1 / 60,         // fixed fluid step, decoupled from render dt
    // recentring counter-current: OFF inside the dead zone (so real swimming is visible),
    // then ramps up — the jelly can genuinely rise ~a body length before the "current"
    // starts carrying the world past it.
    treadmillGain: 1.0,
    treadmillDeadZone: 1.4,
    treadmillMax: 0.6,
  },

  // ---- jellyfish soft body (Rudolf & Mould 2009, taken to true 3D) ----
  jelly: {
    rings: 16,          // meridian resolution (apex → margin)
    segs: 32,           // longitude resolution
    radius: 0.62,       // bell radius at margin (world units)
    height: 0.5,        // bell dome height
    thetaMax: 1.85,     // how far the dome wraps (radians; >π/2 curls past equator)
    thickness: 0.09,    // mesoglea thickness at apex (paper: ~10% of diameter)
    nodeMass: 1.0,
    kStruct: 2400,      // Hookean spring stiffness (structural)
    kShear: 900,
    kThick: 2600,       // cross-shell springs (bending stiffness of the two-layer shell)
    kMuscleBase: 2200,  // circumferential muscle springs (subumbrellar shell)
    kDamp: 10,          // spring damping (along spring axis)
    globalDamp: 0.45,   // per-second viscous damping on node velocity
    substeps: 8,        // spring substeps per frame
    sink: 0.055,        // gravity minus buoyancy (net slow sink when idle)
    drag: 26.0,         // fluid↔body momentum-exchange coefficient (bell)
    dragTentacle: 3.0,
    muscle: {
      freq: 0.8,        // Hz — near the resonant gait of a real medusa (paper §3.3)
      contract: 0.48,   // max rest-length reduction of muscle springs (paper: down to 0.56×)
      wave: 0.22,       // phase lag apex→margin (contraction wave travel)
      attack: 0.2,      // fraction of the cycle spent contracting (fast in, slow out)
    },
  },

  // ---- trailing anatomy ----
  tentacles: { count: 22, segs: 16, length: 2.0, damp: 0.985, iters: 8 },
  arms: { count: 4, segs: 16, length: 1.45, damp: 0.99 },

  // ---- plankton tracer particles (they *are* the flow visualisation) ----
  particles: { count: LOW ? 16000 : 42000, size: 0.016, drift: 0.015 },

  // ---- spatial hash over bell nodes (Ten Minute Physics #11 style) ----
  hash: { size: 16384, bucket: 8, cell: 0.2, pushRadius: 0.1 },

  // ---- rendering ----
  render: {
    maxPixelRatio: LOW ? 1.5 : 2,
    bloom: { strength: 0.75, radius: 0.45, threshold: 0.12 },
    fogColor: 0x04101f,
  },
} as const;

// Fixed-point scale for i32 atomic accumulation (WebGPU has no float atomics).
export const FIXED = 1e5;
