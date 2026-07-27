# jellyfish

**A jellyfish that actually swims.** A real-time 3D soft-body jellyfish coupled to a live
3D fluid simulation, running entirely in WebGPU compute shaders (three.js + TSL).

**Live: [jellyfish.rand.monster](https://jellyfish.rand.monster)** · by [Pajama Studio](https://pajama.studio)

There is no keyframed animation anywhere. The bell is a two-layer spring-mass shell whose
circumferential muscle contracts on a wave; the contraction pushes water; the water pushes
back; the jellyfish swims. Everything you see — the stroke, the drift, the tentacle sway,
the plankton swirling in the jet — is emergent from the physics.

## How it works

The model is Rudolf & Mould's *Interactive Jellyfish Animation using Simulation*
(GRAPP 2009) taken from their 2D-slice-plus-extrapolation formulation to a true 3D
simulation on the GPU:

| System | Method | Reference |
| --- | --- | --- |
| Sea water | Staggered-MAC-grid Euler fluid: red/black SOR projection + semi-Lagrangian advection, in compute | [Ten Minute Physics #17](https://matthias-research.github.io/pages/tenMinutePhysics/17-fluidSim.pdf) |
| Jellyfish body | Two-layer (ex/subumbrellar) spring-mass shell: structural + shear + cross-shell springs, Hookean forces, substepped semi-implicit integration | [Rudolf & Mould 2009](https://gigl.scs.carleton.ca/node/114) |
| Muscle | Subumbrellar ring + across-bell chord springs with rest lengths driven by a contraction wave (fast attack, slow release, apex→margin phase lag) | Rudolf & Mould §3.3 |
| Coupling | Momentum exchange: each node relaxes toward the local fluid velocity; the opposite impulse is splatted trilinearly onto the grid faces (fixed-point i32 atomics) | Peskin-style immersed boundary, simplified |
| Collisions | Spatial hash over bell nodes with atomic buckets (keeps plankton out of the bell) | [Ten Minute Physics #11](https://matthias-research.github.io/pages/tenMinutePhysics/11-hashing.pdf) |
| Station-keeping | A GPU-side "treadmill" counter-current proportional to the (GPU-reduced) centroid offset — the jelly swims forever, the water streams past, zero readbacks | — |
| Bell detail | Structural ridges, contraction ripples and noise displacement in the vertex stage (paper Eqs. 2–5) | Rudolf & Mould §3.4 |
| Tentacles / oral arms | Verlet chains with distance constraints, fluid-dragged, drawn as camera-facing ribbons | — |

The whole simulation lives in GPU storage buffers; the CPU uploads a handful of uniforms
per frame. Rendering reads node positions straight from the sim buffers (no copies), plus
bloom and a hue-preserving scalar-luminance ACES tonemap.

Predecessor: [chaiyuntian/jiggle](https://github.com/chaiyuntian/jiggle) — the 2D
Canvas prototype of the same idea.

## Controls

- **drag** to orbit, **scroll** to zoom
- **click the water** — the jellyfish takes an eager, stronger stroke
- **☼** (top right) — tuning panel: pulse rate, contraction, water grip, plankton glow
- `?q=low` — smaller fluid grid + fewer particles for weaker GPUs

## Develop

```bash
npm install
npm run dev      # vite dev server (needs a WebGPU browser)
npm run build    # tsc + vite build → dist/
npm run deploy   # build + wrangler deploy (Cloudflare Workers static assets)
```

## License

MIT — see [LICENSE](./LICENSE). The referenced papers belong to their authors.
