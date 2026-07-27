// 3D incompressible fluid on a staggered MAC grid — the WebGPU-parallel version of
// Matthias Müller's "Ten Minute Physics" #17 Euler fluid:
//   integrate forces → project (make divergence-free) → advect (semi-Lagrangian).
// The projection is the same direct velocity update as the tutorial, parallelised with a
// red/black checkerboard so no two cells sharing a face are ever solved in the same pass.
// Face velocities u/v/w live in flat storage buffers; body coupling arrives as fixed-point
// i32 atomic impulses (WebGPU has no float atomics) splatted trilinearly onto faces.
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { CONF, FIXED } from "../config";

// TSL's strict generics fight expression-style compute code; treat node math as untyped.
const {
  Fn, instancedArray, instanceIndex, uniform, float, int, vec3, If,
  clamp, floor, atomicAdd, atomicLoad, atomicStore, select, min,
} = TSL as unknown as Record<string, any>;

const { nx, ny, nz, h } = CONF.grid;
const NU = (nx + 1) * ny * nz;
const NV = nx * (ny + 1) * nz;
const NW = nx * ny * (nz + 1);
const NCELL = nx * ny * nz;

type N = any; // a TSL int-ish node

// flat indices (all args non-negative by construction)
const uIdx = (i: N, j: N, k: N) => i.add(int(nx + 1).mul(j.add(int(ny).mul(k))));
const vIdx = (i: N, j: N, k: N) => i.add(int(nx).mul(j.add(int(ny + 1).mul(k))));
const wIdx = (i: N, j: N, k: N) => i.add(int(nx).mul(j.add(int(ny).mul(k))));

export class Fluid {
  // face velocities (+ advection targets)
  readonly u = instancedArray(NU, "float");
  readonly v = instancedArray(NV, "float");
  readonly w = instancedArray(NW, "float");
  readonly uT = instancedArray(NU, "float");
  readonly vT = instancedArray(NV, "float");
  readonly wT = instancedArray(NW, "float");
  // fixed-point impulse accumulators (body → fluid)
  readonly iu = instancedArray(NU, "int").setPBO(true).toAtomic();
  readonly iv = instancedArray(NV, "int").setPBO(true).toAtomic();
  readonly iw = instancedArray(NW, "int").setPBO(true).toAtomic();

  readonly uDt = uniform(CONF.fluid.dt);
  readonly uDampF = uniform(1); // per-frame damping factor, set from dt
  readonly uTreadK = uniform(0); // per-frame recentring gain (Δv per unit offset)
  /** jelly centroid, written by the jellyfish's reduction kernel (GPU-only — no readback) */
  readonly centBuf = instancedArray(1, "vec4");
  readonly uHalf = uniform(new THREE.Vector3(nx * h * 0.5, ny * h * 0.5, nz * h * 0.5));
  readonly uVMax = uniform(3.0);

  // world-space extents (centered on origin) — handy for other systems
  readonly ext = new THREE.Vector3(nx * h, ny * h, nz * h);

  // trilinear point samplers over each face grid (arg: sim-space position)
  private sampleU = this.makeSampler(this.u, nx + 1, ny, nz, 0, 0.5, 0.5);
  private sampleV = this.makeSampler(this.v, nx, ny + 1, nz, 0.5, 0, 0.5);
  private sampleW = this.makeSampler(this.w, nx, ny, nz + 1, 0.5, 0.5, 0);
  private sampleUT = this.makeSampler(this.uT, nx + 1, ny, nz, 0, 0.5, 0.5);
  private sampleVT = this.makeSampler(this.vT, nx, ny + 1, nz, 0.5, 0, 0.5);
  private sampleWT = this.makeSampler(this.wT, nx, ny, nz + 1, 0.5, 0.5, 0);

  /**
   * World-space velocity sample — a plain expression builder, NOT a shared TSL Fn:
   * every call site gets fresh nodes. (Sharing one Fn across many pipelines left some
   * of them silently sampling zeros — same class of bug the ocean port hit.)
   */
  readonly velAt = (pw: any): any => {
    const p = pw.add(this.uHalf).toVar();
    return vec3(this.sampleU(p), this.sampleV(p), this.sampleW(p));
  };

  /**
   * Splat a velocity impulse (Δv, already scaled) trilinearly onto the faces around a
   * world-space point. Accumulated in fixed-point atomics, applied next `apply` pass.
   * Plain expression builder for the same reason as `velAt`.
   */
  readonly splatImpulse = (pw: any, dv: any): void => {
    const p = pw.add(this.uHalf).toVar();
    this.splatAxis(p, dv.x, this.iu, nx + 1, ny, nz, 0, 0.5, 0.5);
    this.splatAxis(p, dv.y, this.iv, nx, ny + 1, nz, 0.5, 0, 0.5);
    this.splatAxis(p, dv.z, this.iw, nx, ny, nz + 1, 0.5, 0.5, 0);
  };

  private kApplyU: any; private kApplyV: any; private kApplyW: any;
  private kProj: any[] = [];
  private kAdvU: any; private kAdvV: any; private kAdvW: any;
  private kCopyU: any; private kCopyV: any; private kCopyW: any;

  constructor(private renderer: THREE.WebGPURenderer) {
    const damp = () => this.uDampF;
    // recentring "treadmill" current, GPU-side (reads the centroid buffer — no readback).
    // Dead zone: no interference near the origin, so genuine swimming stays visible;
    // beyond it a counter-current ramps up and carries the water column past the jelly.
    const tread = (axis: "x" | "y" | "z", scale: number) => {
      const c = this.centBuf.element(int(0))[axis];
      const dz = float(CONF.fluid.treadmillDeadZone).mul(scale === 1 ? 1 : 0.7);
      const excess = c.sign().mul(c.abs().sub(dz).max(0));
      return clamp(excess.negate().mul(this.uTreadK).mul(scale),
        float(CONF.fluid.treadmillMax).negate(), float(CONF.fluid.treadmillMax));
    };

    // ---- 1. apply accumulated body impulses + damping + recentring current ----
    this.kApplyU = Fn(() => {
      const id = int(instanceIndex);
      const i = id.mod(int(nx + 1));
      const imp = float(atomicLoad(this.iu.element(instanceIndex))).div(FIXED);
      atomicStore(this.iu.element(instanceIndex), int(0));
      const val = this.u.element(instanceIndex).add(imp).add(tread("x", 0.4)).mul(damp());
      const wall = i.equal(0).or(i.equal(int(nx)));
      this.u.element(instanceIndex).assign(select(wall, float(0), clamp(val, this.uVMax.negate(), this.uVMax)));
    })().compute(NU);

    this.kApplyV = Fn(() => {
      const id = int(instanceIndex);
      const j = id.div(int(nx)).mod(int(ny + 1));
      const imp = float(atomicLoad(this.iv.element(instanceIndex))).div(FIXED);
      atomicStore(this.iv.element(instanceIndex), int(0));
      const val = this.v.element(instanceIndex).add(imp).add(tread("y", 1)).mul(damp());
      const wall = j.equal(0).or(j.equal(int(ny)));
      this.v.element(instanceIndex).assign(select(wall, float(0), clamp(val, this.uVMax.negate(), this.uVMax)));
    })().compute(NV);

    this.kApplyW = Fn(() => {
      const id = int(instanceIndex);
      const k = id.div(int(nx * ny));
      const imp = float(atomicLoad(this.iw.element(instanceIndex))).div(FIXED);
      atomicStore(this.iw.element(instanceIndex), int(0));
      const val = this.w.element(instanceIndex).add(imp).add(tread("z", 0.4)).mul(damp());
      const wall = k.equal(0).or(k.equal(int(nz)));
      this.w.element(instanceIndex).assign(select(wall, float(0), clamp(val, this.uVMax.negate(), this.uVMax)));
    })().compute(NW);

    // ---- 2. projection: red/black SOR, TMP-17's direct velocity update ----
    for (const parity of [0, 1]) {
      this.kProj.push(Fn(() => {
        const id = int(instanceIndex);
        const i = id.mod(int(nx));
        const j = id.div(int(nx)).mod(int(ny));
        const k = id.div(int(nx * ny));
        If(i.add(j).add(k).bitAnd(int(1)).equal(int(parity)), () => {
          const sx0 = i.greaterThan(int(0));
          const sx1 = i.lessThan(int(nx - 1));
          const sy0 = j.greaterThan(int(0));
          const sy1 = j.lessThan(int(ny - 1));
          const sz0 = k.greaterThan(int(0));
          const sz1 = k.lessThan(int(nz - 1));
          const s = select(sx0, int(1), int(0)).add(select(sx1, int(1), int(0)))
            .add(select(sy0, int(1), int(0))).add(select(sy1, int(1), int(0)))
            .add(select(sz0, int(1), int(0))).add(select(sz1, int(1), int(0))).toVar();
          const div = this.u.element(uIdx(i.add(1), j, k)).sub(this.u.element(uIdx(i, j, k)))
            .add(this.v.element(vIdx(i, j.add(1), k))).sub(this.v.element(vIdx(i, j, k)))
            .add(this.w.element(wIdx(i, j, k.add(1)))).sub(this.w.element(wIdx(i, j, k))).toVar();
          const p = div.negate().div(float(s)).mul(CONF.fluid.overRelax).toVar();
          If(sx0, () => { this.u.element(uIdx(i, j, k)).subAssign(p); });
          If(sx1, () => { this.u.element(uIdx(i.add(1), j, k)).addAssign(p); });
          If(sy0, () => { this.v.element(vIdx(i, j, k)).subAssign(p); });
          If(sy1, () => { this.v.element(vIdx(i, j.add(1), k)).addAssign(p); });
          If(sz0, () => { this.w.element(wIdx(i, j, k)).subAssign(p); });
          If(sz1, () => { this.w.element(wIdx(i, j, k.add(1))).addAssign(p); });
        });
      })().compute(NCELL));
    }

    // ---- 3. semi-Lagrangian advection into uT/vT/wT, then copy back ----
    const velSim = (p: any) => vec3(this.sampleU(p), this.sampleV(p), this.sampleW(p));

    this.kAdvU = Fn(() => {
      const id = int(instanceIndex);
      const i = id.mod(int(nx + 1));
      const j = id.div(int(nx + 1)).mod(int(ny));
      const k = id.div(int((nx + 1) * ny));
      const pos = vec3(float(i).mul(h), float(j).add(0.5).mul(h), float(k).add(0.5).mul(h)).toVar();
      const back = pos.sub(velSim(pos).mul(this.uDt)).toVar();
      this.uT.element(instanceIndex).assign(this.sampleU(back));
    })().compute(NU);

    this.kAdvV = Fn(() => {
      const id = int(instanceIndex);
      const i = id.mod(int(nx));
      const j = id.div(int(nx)).mod(int(ny + 1));
      const k = id.div(int(nx * (ny + 1)));
      const pos = vec3(float(i).add(0.5).mul(h), float(j).mul(h), float(k).add(0.5).mul(h)).toVar();
      const back = pos.sub(velSim(pos).mul(this.uDt)).toVar();
      this.vT.element(instanceIndex).assign(this.sampleV(back));
    })().compute(NV);

    this.kAdvW = Fn(() => {
      const id = int(instanceIndex);
      const i = id.mod(int(nx));
      const j = id.div(int(nx)).mod(int(ny));
      const k = id.div(int(nx * ny));
      const pos = vec3(float(i).add(0.5).mul(h), float(j).add(0.5).mul(h), float(k).mul(h)).toVar();
      const back = pos.sub(velSim(pos).mul(this.uDt)).toVar();
      this.wT.element(instanceIndex).assign(this.sampleW(back));
    })().compute(NW);

    this.kCopyU = Fn(() => { this.u.element(instanceIndex).assign(this.uT.element(instanceIndex)); })().compute(NU);
    this.kCopyV = Fn(() => { this.v.element(instanceIndex).assign(this.vT.element(instanceIndex)); })().compute(NV);
    this.kCopyW = Fn(() => { this.w.element(instanceIndex).assign(this.wT.element(instanceIndex)); })().compute(NW);
    void this.sampleUT; void this.sampleVT; void this.sampleWT;
  }

  private makeSampler(buf: any, dimX: number, dimY: number, dimZ: number, ox: number, oy: number, oz: number): any {
    return (p: any) => {
      const gx = clamp(p.x.div(h).sub(ox), 0, dimX - 1.0001).toVar();
      const gy = clamp(p.y.div(h).sub(oy), 0, dimY - 1.0001).toVar();
      const gz = clamp(p.z.div(h).sub(oz), 0, dimZ - 1.0001).toVar();
      const i0 = int(floor(gx)).toVar(); const fx = gx.sub(floor(gx)).toVar();
      const j0 = int(floor(gy)).toVar(); const fy = gy.sub(floor(gy)).toVar();
      const k0 = int(floor(gz)).toVar(); const fz = gz.sub(floor(gz)).toVar();
      const i1 = min(i0.add(1), int(dimX - 1)).toVar();
      const j1 = min(j0.add(1), int(dimY - 1)).toVar();
      const k1 = min(k0.add(1), int(dimZ - 1)).toVar();
      const at = (i: N, j: N, k: N) => buf.element(i.add(int(dimX).mul(j.add(int(dimY).mul(k)))));
      const x00 = at(i0, j0, k0).mul(fx.oneMinus()).add(at(i1, j0, k0).mul(fx));
      const x10 = at(i0, j1, k0).mul(fx.oneMinus()).add(at(i1, j1, k0).mul(fx));
      const x01 = at(i0, j0, k1).mul(fx.oneMinus()).add(at(i1, j0, k1).mul(fx));
      const x11 = at(i0, j1, k1).mul(fx.oneMinus()).add(at(i1, j1, k1).mul(fx));
      const y0 = x00.mul(fy.oneMinus()).add(x10.mul(fy));
      const y1 = x01.mul(fy.oneMinus()).add(x11.mul(fy));
      return y0.mul(fz.oneMinus()).add(y1.mul(fz));
    };
  }

  /** trilinear fixed-point atomic scatter of one Δv component onto one face grid */
  private splatAxis(
    p: any, dv: any, atom: any,
    dimX: number, dimY: number, dimZ: number,
    ox: number, oy: number, oz: number,
  ) {
    const gx = clamp(p.x.div(h).sub(ox), 0, dimX - 1.0001).toVar();
    const gy = clamp(p.y.div(h).sub(oy), 0, dimY - 1.0001).toVar();
    const gz = clamp(p.z.div(h).sub(oz), 0, dimZ - 1.0001).toVar();
    const i0 = int(floor(gx)).toVar(); const fx = gx.sub(floor(gx)).toVar();
    const j0 = int(floor(gy)).toVar(); const fy = gy.sub(floor(gy)).toVar();
    const k0 = int(floor(gz)).toVar(); const fz = gz.sub(floor(gz)).toVar();
    const i1 = min(i0.add(1), int(dimX - 1)).toVar();
    const j1 = min(j0.add(1), int(dimY - 1)).toVar();
    const k1 = min(k0.add(1), int(dimZ - 1)).toVar();
    const flat = (i: N, j: N, k: N) => i.add(int(dimX).mul(j.add(int(dimY).mul(k))));
    const add = (i: N, j: N, k: N, wgt: any) =>
      atomicAdd(atom.element(flat(i, j, k)), int(dv.mul(wgt).mul(FIXED)));
    add(i0, j0, k0, fx.oneMinus().mul(fy.oneMinus()).mul(fz.oneMinus()));
    add(i1, j0, k0, fx.mul(fy.oneMinus()).mul(fz.oneMinus()));
    add(i0, j1, k0, fx.oneMinus().mul(fy).mul(fz.oneMinus()));
    add(i1, j1, k0, fx.mul(fy).mul(fz.oneMinus()));
    add(i0, j0, k1, fx.oneMinus().mul(fy.oneMinus()).mul(fz));
    add(i1, j0, k1, fx.mul(fy.oneMinus()).mul(fz));
    add(i0, j1, k1, fx.oneMinus().mul(fy).mul(fz));
    add(i1, j1, k1, fx.mul(fy).mul(fz));
  }

  /** one fluid frame: impulses+damping → projection sweeps → advection */
  update(dt: number) {
    this.uDt.value = Math.min(dt, CONF.fluid.dt * 2);
    this.uDampF.value = Math.exp(-CONF.fluid.damping * this.uDt.value);
    this.uTreadK.value = CONF.fluid.treadmillGain * this.uDt.value;
    const r = this.renderer;
    r.compute(this.kApplyU as never); r.compute(this.kApplyV as never); r.compute(this.kApplyW as never);
    for (let it = 0; it < CONF.fluid.projectIters; it++) {
      r.compute(this.kProj[0] as never);
      r.compute(this.kProj[1] as never);
    }
    r.compute(this.kAdvU as never); r.compute(this.kAdvV as never); r.compute(this.kAdvW as never);
    r.compute(this.kCopyU as never); r.compute(this.kCopyV as never); r.compute(this.kCopyW as never);
  }
}
