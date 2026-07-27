// The jellyfish soft body — Rudolf & Mould's 2D spring-mass medusa (GRAPP 2009) taken to
// true 3D on the GPU. The bell is a two-layer shell of point masses (exumbrellar +
// subumbrellar surfaces) joined by structural, shear and cross-shell springs; the
// circumferential muscle is the subumbrellar ring springs, whose rest lengths are
// shortened by a contraction wave travelling apex→margin (fast attack, slow release —
// the asymmetry is what nets forward thrust, per the paper §3.3).
// Coupling with the fluid is a momentum exchange: each node relaxes toward the local
// fluid velocity, and the opposite impulse is splatted back onto the grid.
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
const {
  Fn, instancedArray, instanceIndex, uniform, float, int, vec3, If, Loop,
  fract, smoothstep, select, normalize, cross, length, max, exp, abs, sign,
} = TSL as unknown as Record<string, any>;
import { CONF } from "../config";
import type { Fluid } from "./fluid";

const J = CONF.jelly;
const R = J.rings, S = J.segs;
export const NB1 = 1 + R * S;        // nodes per layer (apex + rings)
export const NBELL = NB1 * 2;        // outer + inner layer
const MAX_ADJ = 20;

const TCH = CONF.tentacles.count + CONF.arms.count;   // chain count
const TSEGS = Math.max(CONF.tentacles.segs, CONF.arms.segs);
export const NTENT = TCH * TSEGS;

// node index helpers (layer: 0 outer, 1 inner)
const nIdx = (layer: number, r: number, s: number) =>
  layer * NB1 + (r < 0 ? 0 : 1 + r * S + ((s % S) + S) % S);
const apexIdx = (layer: number) => layer * NB1;

export class Jellyfish {
  // dynamic state
  readonly pos: any; readonly vel: any; readonly frc: any; readonly nrm: any;
  readonly tPos: any; readonly tPrev: any;
  // static data
  readonly adjIdx: any; readonly adjMeta: any; readonly info: any;

  // muscle + coupling uniforms
  readonly uPhase = uniform(0);
  readonly uContract = uniform(J.muscle.contract);
  readonly uWave = uniform(J.muscle.wave);
  readonly uAlphaBell = uniform(0.1);   // per-frame fluid-grip fraction (bell)
  readonly uAlphaTent = uniform(0.05);
  readonly uMomBell = uniform(0.65);    // node↔cell water-mass ratio for splat-back
  readonly uMomTent = uniform(0.08);
  readonly uDtSub = uniform(1 / 480);
  readonly uDtFrame = uniform(1 / 60);
  readonly uJet = uniform(0); // sub-grid jet reaction accel (see config jetK)
  readonly uK = uniform(new THREE.Vector4(J.kStruct, J.kShear, J.kThick, J.kMuscleBase));

  /** current margin activation 0..1 (CPU mirror, for render ripples) */
  actVis = 0;
  drag: number = J.drag;
  freq: number = J.muscle.freq;
  jetK: number = J.jetK;
  pulse = 0; // click boost, decays

  private kForce: any; private kIntegrate: any; private kCouple: any; private kNormals: any; private kTent: any; private kCentroid: any;

  constructor(private renderer: THREE.WebGPURenderer, private fluid: Fluid) {
    // ================= CPU construction =================
    const posA = new Float32Array(NBELL * 3);
    const infoA = new Float32Array(NBELL * 4);      // mass, ringFrac, sigma, layer
    const adjIdxA = new Int32Array(NBELL * MAX_ADJ).fill(-1);
    const adjMetaA = new Float32Array(NBELL * MAX_ADJ * 4);

    const a = J.radius, b = J.height, tm = J.thetaMax;
    const setP = (idx: number, p: THREE.Vector3) => { posA.set([p.x, p.y, p.z], idx * 3); };

    // outer profile: ρ = a·sin^0.92θ, y = b·cosθ; inner offset along the 2D profile normal
    for (let layer = 0; layer < 2; layer++) {
      for (let r = -1; r < R; r++) {
        const th = r < 0 ? 0 : (tm * (r + 1)) / R;
        const rf = r < 0 ? 0 : (r + 1) / R;
        const rho = a * Math.pow(Math.sin(th), 0.92);
        const y = b * Math.cos(th);
        const n2 = new THREE.Vector2(b * Math.sin(th), a * Math.cos(th)).normalize();
        const t = (J.thickness * (1.25 - 0.9 * rf) + 0.015) * (layer === 0 ? 0 : 1);
        const count = r < 0 ? 1 : S;
        for (let s = 0; s < count; s++) {
          const phi = (s / S) * Math.PI * 2;
          const rr = rho - n2.x * t;
          const yy = y - n2.y * t;
          const idx = r < 0 ? apexIdx(layer) : nIdx(layer, r, s);
          setP(idx, new THREE.Vector3(rr * Math.cos(phi), yy, rr * Math.sin(phi)));
          const mass = r < 0 ? 6 : 1; // heavy apex (it also has fewer springs)
          infoA.set([mass, rf, phi, layer], idx * 4);
        }
      }
    }

    // springs — symmetric adjacency lists. type: 0 struct, 1 shear, 2 thick, 3 muscle
    const deg = new Int32Array(NBELL);
    const addSpring = (i: number, j: number, type: number, muscleW = 0, rf = 0) => {
      const pi = new THREE.Vector3(posA[i * 3], posA[i * 3 + 1], posA[i * 3 + 2]);
      const pj = new THREE.Vector3(posA[j * 3], posA[j * 3 + 1], posA[j * 3 + 2]);
      const len = pi.distanceTo(pj);
      for (const [x, y] of [[i, j], [j, i]] as const) {
        if (deg[x] >= MAX_ADJ) { console.warn("adjacency overflow", x); continue; }
        const slot = x * MAX_ADJ + deg[x]++;
        adjIdxA[slot] = y;
        adjMetaA.set([len, type, muscleW, rf], slot * 4);
      }
    };

    for (let layer = 0; layer < 2; layer++) {
      for (let r = 0; r < R; r++) {
        const rf = (r + 1) / R;
        const muscleW = Math.pow(rf, 1.6);
        for (let s = 0; s < S; s++) {
          const me = nIdx(layer, r, s);
          // ring springs — on the inner (subumbrellar) layer these ARE the muscle;
          // the outer hull also compresses, at roughly half strength (paper fig.3)
          if (layer === 1) addSpring(me, nIdx(1, r, s + 1), 3, muscleW, rf);
          else addSpring(me, nIdx(0, r, s + 1), 3, muscleW * 0.5, rf);
          // chord muscle springs across the bell (the paper's 2D muscle runs
          // "longitudinally across the umbrella" — chords, not just neighbours)
          if (layer === 1 && rf > 0.55 && s < S / 2) {
            addSpring(me, nIdx(1, r, s + S / 2), 3, muscleW, rf);
          }
          // meridian springs
          if (r < R - 1) addSpring(me, nIdx(layer, r + 1, s), 0);
          if (r === 0 && s % 2 === 0) addSpring(me, apexIdx(layer), 0);
          // shear diagonals (outer layer only)
          if (layer === 0 && r < R - 1) {
            addSpring(me, nIdx(0, r + 1, s + 1), 1);
            addSpring(nIdx(0, r, s + 1), nIdx(0, r + 1, s), 1);
          }
          // cross-shell springs (bending stiffness of the two-layer mesoglea)
          if (layer === 0) {
            addSpring(me, nIdx(1, r, s), 2);
            if (r < R - 1) { addSpring(me, nIdx(1, r + 1, s), 2); addSpring(nIdx(0, r + 1, s), nIdx(1, r, s), 2); }
            addSpring(me, nIdx(1, r, s + 1), 2);
          }
        }
      }
    }
    addSpring(apexIdx(0), apexIdx(1), 2);

    this.pos = instancedArray(posA, "vec3");
    this.vel = instancedArray(NBELL, "vec3");
    this.frc = instancedArray(NBELL, "vec3");
    this.nrm = instancedArray(NBELL, "vec3");
    this.info = instancedArray(infoA, "vec4");
    this.adjIdx = instancedArray(adjIdxA as unknown as Float32Array, "int");
    this.adjMeta = instancedArray(adjMetaA, "vec4");

    // ---- tentacles + oral arms: verlet chains hanging off the bell ----
    const tPosA = new Float32Array(NTENT * 3);
    const chainRootA = new Int32Array(TCH);
    const chainSegA = new Float32Array(TCH * 2); // segLen, damp
    for (let c = 0; c < TCH; c++) {
      const isArm = c >= CONF.tentacles.count;
      const cfg = isArm ? CONF.arms : CONF.tentacles;
      const root = isArm
        ? nIdx(1, 2, Math.round(((c - CONF.tentacles.count) / CONF.arms.count) * S + 4))
        : nIdx(1, R - 1, Math.round((c / CONF.tentacles.count) * S));
      chainRootA[c] = root;
      const segLen = cfg.length / cfg.segs;
      chainSegA[c * 2] = segLen;
      chainSegA[c * 2 + 1] = cfg.damp;
      const rp = new THREE.Vector3(posA[root * 3], posA[root * 3 + 1], posA[root * 3 + 2]);
      for (let i = 0; i < TSEGS; i++) {
        tPosA.set([rp.x, rp.y - segLen * i, rp.z], (c * TSEGS + i) * 3);
      }
    }
    this.tPos = instancedArray(tPosA, "vec3");
    this.tPrev = instancedArray(tPosA.slice(), "vec3");
    const chainRoot = instancedArray(chainRootA as unknown as Float32Array, "int");
    const chainSeg = instancedArray(chainSegA, "vec2");

    // ================= GPU kernels =================
    const half = fluid.ext.clone().multiplyScalar(0.5);

    // contraction wave (paper fig.4): phase lags toward the margin; fast attack,
    // slower release, then a rest at full expansion (the asymmetry nets thrust)
    const activation = Fn(([rf]: any) => {
      const ph = fract(this.uPhase.sub(this.uWave.mul(rf)));
      const atk = float(J.muscle.attack);
      const up = smoothstep(0, atk, ph);
      const down = smoothstep(atk, atk.add(0.42), ph).oneMinus();
      return select(ph.lessThan(atk), up, down);
    });

    this.kForce = Fn(() => {
      const i = instanceIndex;
      const p = this.pos.element(i).toVar();
      const v = this.vel.element(i).toVar();
      const F = vec3(0, this.uJet.sub(J.sink), 0).toVar();
      Loop({ start: int(0), end: int(MAX_ADJ), type: "int", name: "s" }, ({ s }: any) => {
        const slot = int(i).mul(int(MAX_ADJ)).add(s);
        const j = this.adjIdx.element(slot).toVar();
        If(j.greaterThanEqual(int(0)), () => {
          const meta = this.adjMeta.element(slot).toVar();
          const pj = this.pos.element(j);
          const d = pj.sub(p).toVar();
          const len = max(length(d), 1e-6).toVar();
          const dir = d.div(len).toVar();
          const t = meta.y;
          const k = select(t.lessThan(0.5), this.uK.x,
            select(t.lessThan(1.5), this.uK.y,
              select(t.lessThan(2.5), this.uK.z, this.uK.w))).toVar();
          const act = activation(meta.w).mul(meta.z).mul(this.uContract);
          const rest = meta.x.mul(act.oneMinus()).toVar();
          F.addAssign(dir.mul(len.sub(rest)).mul(k));
          // damping along the spring axis
          const relV = this.vel.element(j).sub(v);
          F.addAssign(dir.mul(dir.dot(relV)).mul(J.kDamp));
        });
      });
      // soft tank containment
      const lim = vec3(half.x - 0.5, half.y - 0.6, half.z - 0.5);
      const over = abs(p).sub(lim).max(0).toVar();
      F.subAssign(sign(p).mul(over).mul(300));
      this.frc.element(i).assign(F);
    })().compute(NBELL);

    this.kIntegrate = Fn(() => {
      const i = instanceIndex;
      const m = this.info.element(i).x;
      const v = this.vel.element(i).toVar();
      v.addAssign(this.frc.element(i).div(m).mul(this.uDtSub));
      v.mulAssign(exp(float(J.globalDamp).negate().mul(this.uDtSub)));
      this.vel.element(i).assign(v);
      this.pos.element(i).addAssign(v.mul(this.uDtSub));
    })().compute(NBELL);

    // fluid ↔ body momentum exchange (once per frame)
    this.kCouple = Fn(() => {
      const i = instanceIndex;
      const p = this.pos.element(i).toVar();
      const v = this.vel.element(i).toVar();
      const vF = this.fluid.velAt(p).toVar();
      const dv = vF.sub(v).mul(this.uAlphaBell).toVar();
      this.vel.element(i).assign(v.add(dv));
      this.fluid.splatImpulse(p, dv.negate().mul(this.uMomBell));
    })().compute(NBELL);

    this.kNormals = Fn(() => {
      const i = int(instanceIndex);
      const layer = i.div(int(NB1));
      const li = i.sub(layer.mul(int(NB1)));
      If(li.equal(int(0)), () => {
        // apex: from apex toward mean of ring-0 — approximately +y
        const p0 = this.pos.element(i);
        const q = this.pos.element(i.add(int(1))).add(this.pos.element(i.add(int(1 + S / 2))));
        this.nrm.element(i).assign(normalize(p0.mul(2).sub(q)));
      }).Else(() => {
        const r = li.sub(int(1)).div(int(S));
        const s = li.sub(int(1)).sub(r.mul(int(S)));
        const base = layer.mul(int(NB1)).add(int(1));
        const at = (rr: any, ss: any) => this.pos.element(base.add(rr.mul(int(S))).add(ss.add(int(S)).mod(int(S))));
        const rPrev = max(r.sub(1), int(0));
        const rNext = min2(r.add(1), int(R - 1));
        const dRing = at(r, s.add(int(1))).sub(at(r, s.sub(int(1)))).toVar();
        const prev = select(r.equal(int(0)), this.pos.element(layer.mul(int(NB1))), at(rPrev, s)).toVar();
        const dMer = at(rNext, s).sub(prev).toVar();
        this.nrm.element(i).assign(normalize(cross(dRing, dMer)));
      });
    })().compute(NBELL);

    // one thread per chain: verlet + fluid drag + distance constraints (root pinned).
    // NOTE: no splat-back to the fluid here — chainSeg/chainRoot/tPos/tPrev/pos + u/v/w
    // is already 8 storage buffers, the WebGPU per-stage limit. Adding the 3 impulse
    // buffers made the pipeline silently fail validation (tentacles froze).
    this.kTent = Fn(() => {
      const c = int(instanceIndex);
      const segLen = chainSeg.element(c).x;
      const dampT = chainSeg.element(c).y;
      const base = c.mul(int(TSEGS));
      const root = chainRoot.element(c);
      this.tPos.element(base).assign(this.pos.element(root));
      const dt = this.uDtFrame;
      Loop({ start: int(1), end: int(TSEGS), type: "int", name: "i" }, ({ i }: any) => {
        const id = base.add(i);
        const p = this.tPos.element(id).toVar();
        const v = p.sub(this.tPrev.element(id)).div(dt).toVar();
        const vF = this.fluid.velAt(p);
        const dv = vF.sub(v).mul(this.uAlphaTent).toVar();
        v.addAssign(dv);
        v.y.subAssign(float(0.12).mul(dt)); // tentacles sink gently
        v.mulAssign(dampT);
        this.tPrev.element(id).assign(p);
        this.tPos.element(id).assign(p.add(v.mul(dt)));
      });
      Loop({ start: int(0), end: int(CONF.tentacles.iters), type: "int", name: "it" }, () => {
        Loop({ start: int(0), end: int(TSEGS - 1), type: "int", name: "i" }, ({ i }: any) => {
          const id1 = base.add(i); const id2 = id1.add(int(1));
          const p1 = this.tPos.element(id1).toVar();
          const p2 = this.tPos.element(id2).toVar();
          const d = p2.sub(p1).toVar();
          const len = max(length(d), 1e-6);
          const corr = d.mul(len.sub(segLen).div(len)).toVar();
          If(i.equal(int(0)), () => {
            this.tPos.element(id2).assign(p2.sub(corr));
          }).Else(() => {
            this.tPos.element(id1).assign(p1.add(corr.mul(0.5)));
            this.tPos.element(id2).assign(p2.sub(corr.mul(0.5)));
          });
        });
      });
    })().compute(TCH);

    // tiny reduction: jelly centroid → fluid.centBuf (drives the GPU-side treadmill current)
    this.kCentroid = Fn(() => {
      If(int(instanceIndex).equal(int(0)), () => {
        const acc = vec3(0).toVar();
        Loop({ start: int(0), end: int(64), type: "int", name: "i" }, ({ i }: any) => {
          acc.addAssign(this.pos.element(i.mul(int(Math.floor(NB1 / 64)))));
        });
        fluid.centBuf.element(int(0)).assign(acc.div(64).toVec4());
      });
    })().compute(1);
  }

  /** advance one frame: muscle phase, springs (substepped), tentacles, coupling, normals */
  update(dt: number) {
    const d = Math.min(dt, 1 / 30);
    this.pulse = Math.max(0, this.pulse - d / 1.8);
    const boost = 1 + this.pulse * 0.75;
    this.uPhase.value += d * this.freq * (1 + this.pulse * 0.5);
    this.uContract.value = Math.min(0.6, CONF.jelly.muscle.contract * boost * (this.userContract / CONF.jelly.muscle.contract));
    // CPU mirror of margin activation, for render-side ripples + the jet model
    const prevAct = this.actVis;
    const ph = (this.uPhase.value - this.uWave.value) % 1;
    const atk = J.muscle.attack;
    this.actVis = ph < atk ? ph / atk : 1 - Math.min(1, (ph - atk) / (1 - atk));
    // sub-grid jet reaction: fires only while the muscle is actively contracting
    const actRate = Math.max(0, (this.actVis - prevAct) / Math.max(d, 1e-4));
    this.uJet.value = this.jetK * actRate * (1 + this.pulse * 0.8);

    this.uDtFrame.value = d;
    this.uDtSub.value = d / J.substeps;
    this.uAlphaBell.value = 1 - Math.exp(-this.drag * d);
    this.uAlphaTent.value = 1 - Math.exp(-CONF.jelly.dragTentacle * d);

    const r = this.renderer;
    for (let s = 0; s < J.substeps; s++) {
      r.compute(this.kForce as never);
      r.compute(this.kIntegrate as never);
    }
    r.compute(this.kCouple as never);
    r.compute(this.kTent as never);
    r.compute(this.kNormals as never);
    r.compute(this.kCentroid as never);
  }

  userContract: number = CONF.jelly.muscle.contract;

  /** click → an eager, stronger stroke */
  poke() { this.pulse = 1; }
}

// small helper: TSL int min (min() import is used for floats elsewhere in this file)
function min2(a: any, b: any) { return select(a.lessThan(b), a, b); }
