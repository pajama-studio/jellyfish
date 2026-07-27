// Plankton tracer particles — they ARE the flow visualisation (the paper's fig. 6 uses
// trace particles the same way). Advected by the fluid each frame, gently pushed out of
// the bell via the spatial hash, wrapped inside the tank, and drawn as soft additive
// motes whose brightness follows local flow speed (so the jet becomes visible).
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
const {
  Fn, instancedArray, instanceIndex, uniform, float, vec3, If, uv,
  hash, length, smoothstep, mix, positionLocal, max, clamp, varying,
} = TSL as unknown as Record<string, any>;
import { CONF } from "../config";
import type { Fluid } from "./fluid";
import type { SpatialHash } from "./hash";

const N = CONF.particles.count;

export class Plankton {
  readonly mesh: THREE.InstancedMesh;
  readonly uGlow = uniform(1);
  readonly uT = uniform(0);
  /** "show currents" mode: streaks lengthen & brighten with flow speed (0 or 1) */
  readonly uFlowViz = uniform(0);
  private uCamRight = uniform(new THREE.Vector3(1, 0, 0));
  private uCamUp = uniform(new THREE.Vector3(0, 1, 0));
  private uDt = uniform(1 / 60);
  private kInit: any; private kUpdate: any; private kShift: any;
  readonly uShiftK = uniform(0);
  private inited = false;

  constructor(private renderer: THREE.WebGPURenderer, fluid: Fluid, shash: SpatialHash) {
    // NOTE: velocity + glow share one vec4 buffer — the update kernel binds pPos, this,
    // u/v/w, the hash (cnt+slots) and the bell nodes: exactly 8 storage buffers, the
    // WebGPU default per-stage limit. Splitting glow out pushes it to 9 and the whole
    // compute pipeline silently dies with a validation error.
    const pPos = instancedArray(N, "vec3");
    const pVelGlow = instancedArray(N, "vec4"); // xyz = fluid velocity, w = glow envelope
    const ext = fluid.ext;
    const vec4 = (TSL as unknown as Record<string, any>).vec4;

    this.kInit = Fn(() => {
      const i = instanceIndex;
      const fi = float(i);
      const rx = hash(fi.mul(1.313).add(0.13)).sub(0.5).mul(ext.x * 0.96);
      const ry = hash(fi.mul(2.717).add(7.7)).sub(0.5).mul(ext.y * 0.96);
      const rz = hash(fi.mul(3.531).add(3.1)).sub(0.5).mul(ext.z * 0.96);
      pPos.element(i).assign(vec3(rx, ry, rz));
      pVelGlow.element(i).assign(vec4(0, 0, 0, 0));
    })().compute(N);

    this.kShift = Fn(() => {
      const sh = fluid.centBuf.element(0).xyz.mul(this.uShiftK);
      pPos.element(instanceIndex).subAssign(sh);
    })().compute(N);

    this.kUpdate = Fn(() => {
      const i = instanceIndex;
      const fi = float(i);
      const p = pPos.element(i).toVar();
      const vF = fluid.velAt(p).toVar();
      // slow personal drift so still water still feels alive
      const drift = vec3(
        hash(fi.add(0.7)).sub(0.5),
        hash(fi.add(1.9)).sub(0.5).mul(0.4).add(0.12), // slight upward bias
        hash(fi.add(4.2)).sub(0.5),
      ).mul(CONF.particles.drift);
      p.addAssign(vF.add(drift).mul(this.uDt));
      // keep out of the bell shell (spatial hash over bell nodes)
      shash.forEachNeighbor(p, CONF.hash.pushRadius, (idx: any) => {
        const q = p.sub(shash.nodePos.element(idx)).toVar();
        const d = max(length(q), 1e-5);
        If(d.lessThan(CONF.hash.pushRadius), () => {
          p.addAssign(q.div(d).mul(float(CONF.hash.pushRadius).sub(d)).mul(0.5));
        });
      });
      // wrap inside the tank (treadmill current streams plankton past the jelly)
      const hx = ext.x * 0.5, hy = ext.y * 0.5, hz = ext.z * 0.5;
      If(p.x.greaterThan(hx), () => p.x.subAssign(ext.x));
      If(p.x.lessThan(-hx), () => p.x.addAssign(ext.x));
      If(p.y.greaterThan(hy), () => p.y.subAssign(ext.y));
      If(p.y.lessThan(-hy), () => p.y.addAssign(ext.y));
      If(p.z.greaterThan(hz), () => p.z.subAssign(ext.z));
      If(p.z.lessThan(-hz), () => p.z.addAssign(ext.z));
      pPos.element(i).assign(p);
      // brightness follows flow speed, with a soft envelope
      const g = pVelGlow.element(i).w.toVar();
      const target = smoothstep(0.03, 0.5, length(vF));
      pVelGlow.element(i).assign(vec4(vF, g.add(target.sub(g).mul(0.08))));
    })().compute(N);

    // ---- rendering: camera-facing additive motes ----
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    const i = instanceIndex;
    const fi = float(i);
    const p = pPos.element(i);
    const size = float(CONF.particles.size).mul(hash(fi.mul(1.317)).mul(1.4).add(0.45));
    // motion-streaked motes: the quad stretches along the screen-projected flow
    // direction, so the water's motion is readable at a glance. Built purely in the
    // camera's right/up basis — no cross products, no degenerate normalize.
    const DBG = new URL(location.href).searchParams.has("pp");
    const vp = pVelGlow.element(i).xyz.toVar();
    const vx = vp.dot(this.uCamRight).toVar();
    const vy = vp.dot(this.uCamUp).toVar();
    const sp = vx.mul(vx).add(vy.mul(vy)).add(1e-8).sqrt().toVar();
    const ax = vx.div(sp).mul(sp.min(1)).add(sp.min(1).oneMinus()).toVar(); // → (1,0) when still
    const ay = vy.div(sp).mul(sp.min(1)).toVar();
    const an = ax.mul(ax).add(ay.mul(ay)).sqrt().add(1e-6);
    const axn = ax.div(an).toVar();
    const ayn = ay.div(an).toVar();
    const stretch = clamp(sp.mul(6).add(1), 1, 4.5)
      .mul(this.uFlowViz.mul(clamp(sp.mul(4), 0, 2.5)).add(1)).toVar();
    const lx = positionLocal.x.mul(size).mul(stretch);
    const ly = positionLocal.y.mul(size);
    mat.positionNode = DBG
      ? p.add(this.uCamRight.mul(positionLocal.x.mul(size))).add(this.uCamUp.mul(positionLocal.y.mul(size)))
      : p.add(this.uCamRight.mul(axn.mul(lx).sub(ayn.mul(ly))))
        .add(this.uCamUp.mul(ayn.mul(lx).add(axn.mul(ly))));
    // fragment-side values must cross the stage boundary explicitly
    const vStretch = varying(stretch);
    const vGlow = varying(pVelGlow.element(i).w);
    const vSp = varying(sp);
    const dot = smoothstep(0.5, 0.05, length(uv().sub(0.5)));
    const warm = smoothstep(0.85, 0.87, hash(fi.mul(0.531)));
    const baseCol = mix(vec3(0.45, 0.8, 1.0), vec3(1.0, 0.5, 0.85), warm); // cyan + rare magenta motes
    // currents mode: fast water tints toward hot white so the jet reads instantly
    const speedTint = mix(vec3(0.25, 0.6, 1.0), vec3(1.0, 1.0, 0.92), smoothstep(0.06, 0.7, vSp));
    mat.colorNode = mix(baseCol, speedTint, this.uFlowViz);
    // slow breathing twinkle, phase-scattered per mote
    const sin_ = (TSL as unknown as Record<string, any>).sin;
    const twinkle = sin_(this.uT.mul(hash(fi.add(9.1)).mul(1.4).add(0.5)).add(hash(fi.mul(3.7)).mul(6.28)))
      .mul(0.3).add(0.7);
    mat.opacityNode = DBG
      ? dot.mul(0.5)
      : dot.mul(vGlow.mul(0.85).add(0.055)).mul(twinkle)
          .div(vStretch.sqrt()).mul(this.uGlow)
          .mul(this.uFlowViz.mul(smoothstep(0.05, 0.4, vSp)).mul(2).add(1));

    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, N);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.inited) { this.renderer.compute(this.kInit as never); this.inited = true; }
    this.uDt.value = Math.min(dt, 1 / 30);
    this.uT.value += dt;
    const m = camera.matrixWorld.elements;
    this.uCamRight.value.set(m[0], m[1], m[2]);
    this.uCamUp.value.set(m[4], m[5], m[6]);
    this.uShiftK.value = 1 - Math.exp(-this.uDt.value / CONF.fluid.recenterTau);
    this.renderer.compute(this.kShift as never);
    this.renderer.compute(this.kUpdate as never);
  }
}
