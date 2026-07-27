// Plankton tracer particles — they ARE the flow visualisation (the paper's fig. 6 uses
// trace particles the same way). Advected by the fluid each frame, gently pushed out of
// the bell via the spatial hash, wrapped inside the tank, and drawn as soft additive
// motes whose brightness follows local flow speed (so the jet becomes visible).
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
const {
  Fn, instancedArray, instanceIndex, uniform, float, vec3, If, uv,
  hash, length, smoothstep, mix, positionLocal, max,
} = TSL as unknown as Record<string, any>;
import { CONF } from "../config";
import type { Fluid } from "./fluid";
import type { SpatialHash } from "./hash";

const N = CONF.particles.count;

export class Plankton {
  readonly mesh: THREE.InstancedMesh;
  readonly uGlow = uniform(1);
  private uCamRight = uniform(new THREE.Vector3(1, 0, 0));
  private uCamUp = uniform(new THREE.Vector3(0, 1, 0));
  private uDt = uniform(1 / 60);
  private kInit; private kUpdate;
  private inited = false;

  constructor(private renderer: THREE.WebGPURenderer, fluid: Fluid, shash: SpatialHash) {
    const pPos = instancedArray(N, "vec3");
    const pGlow = instancedArray(N, "float");
    const ext = fluid.ext;

    this.kInit = Fn(() => {
      const i = instanceIndex;
      const fi = float(i);
      const rx = hash(fi.mul(0.01711).add(0.13)).sub(0.5).mul(ext.x * 0.96);
      const ry = hash(fi.mul(0.02313).add(7.7)).sub(0.5).mul(ext.y * 0.96);
      const rz = hash(fi.mul(0.00931).add(3.1)).sub(0.5).mul(ext.z * 0.96);
      pPos.element(i).assign(vec3(rx, ry, rz));
      pGlow.element(i).assign(0);
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
      const g = pGlow.element(i).toVar();
      const target = smoothstep(0.03, 0.5, length(vF));
      pGlow.element(i).assign(g.add(target.sub(g).mul(0.08)));
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
    mat.positionNode = p
      .add(this.uCamRight.mul(positionLocal.x.mul(size)))
      .add(this.uCamUp.mul(positionLocal.y.mul(size)));
    const dot = smoothstep(0.5, 0.05, length(uv().sub(0.5)));
    const warm = smoothstep(0.85, 0.87, hash(fi.mul(0.531)));
    mat.colorNode = mix(vec3(0.55, 0.78, 1.0), vec3(1.0, 0.83, 0.55), warm);
    const twinkle = hash(fi.mul(2.71)).mul(0.5).add(0.5);
    mat.opacityNode = dot.mul(pGlow.element(i).mul(0.85).add(0.10)).mul(twinkle).mul(this.uGlow);

    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, N);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.inited) { this.renderer.compute(this.kInit as never); this.inited = true; }
    this.uDt.value = Math.min(dt, 1 / 30);
    const m = camera.matrixWorld.elements;
    this.uCamRight.value.set(m[0], m[1], m[2]);
    this.uCamUp.value.set(m[4], m[5], m[6]);
    this.renderer.compute(this.kUpdate as never);
  }
}
