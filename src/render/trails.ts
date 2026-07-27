// Silk streamers — the "唯美" answer to visualising 3D flow direction.
// A few hundred tracers each remember a short history of positions (a GPU ring buffer);
// rendered as tapered camera-facing ribbons they become curving silk threads that wrap
// around the vortex rings, showing the flow's PATH and direction, not just its speed.
// Faded tail → bright young head = direction of travel. Invisible in still water.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
import { CONF } from "../config";
import type { Fluid } from "../sim/fluid";

const {
  Fn, instancedArray, instanceIndex, uniform, float, int, vec2, vec3, vec4,
  If, Loop, hash, length, smoothstep, mix, clamp, cameraPosition,
  normalize, cross, max, varying, attribute,
} = TSL as unknown as Record<string, any>;

const TR = 1200;   // tracer count
const HIST = 24;   // history samples per tracer

export class Trails {
  readonly mesh: THREE.Mesh;
  private hist: any = instancedArray(TR * HIST, "vec4"); // xyz pos, w speed
  private kInit: any; private kStep: any; private kShiftH: any;
  private uHead = uniform(0);
  private uPrev = uniform(0);
  private uStepDt = uniform(1 / 30);
  private uEpoch = uniform(0);
  readonly uShiftK = uniform(0);
  private head = 0;
  private frame = 0;
  private stepAcc = 0;
  private inited = false;

  constructor(private renderer: THREE.WebGPURenderer, fluid: Fluid) {
    const ext = fluid.ext;

    const seedPos = (t: any, salt: any) => vec3(
      hash(t.add(salt).add(0.31)).sub(0.5).mul(ext.x * 0.7),
      hash(t.add(salt).add(7.77)).sub(0.5).mul(ext.y * 0.7),
      hash(t.add(salt).add(3.13)).sub(0.5).mul(ext.z * 0.7),
    );

    this.kInit = Fn(() => {
      const t = float(int(instanceIndex).div(int(HIST)));
      const p = seedPos(t, float(0));
      this.hist.element(instanceIndex).assign(vec4(p, 0));
    })().compute(TR * HIST);

    // one thread per tracer: advance the head sample along the flow; occasionally respawn
    this.kStep = Fn(() => {
      const t = int(instanceIndex);
      const base = t.mul(int(HIST));
      const prev = this.hist.element(base.add(this.uPrev)).toVar();
      const vF = fluid.velAt(prev.xyz).toVar();
      const np = prev.xyz.add(vF.mul(this.uStepDt)).toVar();
      const sp = length(vF).toVar();
      // periodic respawn, staggered per tracer (epoch advances slowly)
      const myEpoch = this.uEpoch.add(hash(float(t).mul(1.618)).mul(64).floor());
      const reborn = hash(float(t).mul(0.717).add(myEpoch.mul(0.0313))).lessThan(0.006);
      const out = np.abs().sub(vec3(ext.x, ext.y, ext.z).mul(0.48)).max(0).length().greaterThan(0);
      If(reborn.or(out), () => {
        const p = seedPos(float(t), myEpoch);
        Loop({ start: int(0), end: int(HIST), type: "int", name: "s" }, ({ s }: any) => {
          this.hist.element(base.add(s)).assign(vec4(p, 0));
        });
      }).Else(() => {
        this.hist.element(base.add(this.uHead)).assign(vec4(np, sp));
      });
    })().compute(TR);

    // world-shift: trails are world points too
    this.kShiftH = Fn(() => {
      const sh = fluid.centBuf.element(0).xyz.mul(this.uShiftK);
      const s4 = this.hist.element(instanceIndex);
      s4.assign(vec4(s4.xyz.sub(sh), s4.w));
    })().compute(TR * HIST);

    // ---- ribbon rendering ----
    const verts = TR * HIST * 2;
    const aTr = new Float32Array(verts);
    const aSeg = new Float32Array(verts);
    const aSide = new Float32Array(verts);
    const basePos = new Float32Array(verts * 3);
    const idx: number[] = [];
    for (let tr = 0; tr < TR; tr++) {
      for (let s2 = 0; s2 < HIST; s2++) {
        const v = (tr * HIST + s2) * 2;
        aTr[v] = tr; aTr[v + 1] = tr;
        aSeg[v] = s2; aSeg[v + 1] = s2;
        aSide[v] = -1; aSide[v + 1] = 1;
        if (s2 < HIST - 1) idx.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(basePos, 3));
    geo.setAttribute("aTr", new THREE.BufferAttribute(aTr, 1));
    geo.setAttribute("aSeg", new THREE.BufferAttribute(aSeg, 1));
    geo.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.side = THREE.DoubleSide;

    const tr = int(attribute("aTr"));
    const seg = int(attribute("aSeg"));      // 0 = youngest (head) … HIST-1 = oldest
    const side = attribute("aSide");
    const slot = this.uHead.sub(seg).add(int(HIST * 2)).mod(int(HIST));
    const slotN = this.uHead.sub(seg.add(1).min(int(HIST - 1))).add(int(HIST * 2)).mod(int(HIST));
    const base = tr.mul(int(HIST));
    const s4 = this.hist.element(base.add(slot)).toVar();
    const s4n = this.hist.element(base.add(slotN)).toVar();
    const p = s4.xyz.toVar();
    const tang0 = s4n.xyz.sub(p).toVar();
    const tang = tang0.div(length(tang0).add(1e-5)).toVar();
    const view = normalize(cameraPosition.sub(p)).toVar();
    const ribbonDir = normalize(cross(tang, view).add(vec3(1e-5, 1e-5, 0))).toVar();
    const age = float(seg).div(HIST - 1);
    const width = float(0.011).mul(age.mul(0.85).oneMinus());
    mat.positionNode = p.add(ribbonDir.mul(side.mul(width)));

    const vAge = varying(age);
    const vSp = varying(s4.w);
    const slow = vec3(0.2, 0.5, 1.0);
    const fastC = vec3(0.6, 1.0, 0.95); // aurora mint-cyan
    mat.colorNode = mix(slow, fastC, smoothstep(0.06, 0.7, vSp)).mul(vAge.mul(0.55).oneMinus());
    mat.opacityNode = vAge.oneMinus().pow(2).mul(smoothstep(0.025, 0.25, vSp)).mul(0.5);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    void clamp; void vec2; void max;
  }

  update(dt: number) {
    const r = this.renderer;
    if (!this.inited) { r.compute(this.kInit as never); this.inited = true; }
    this.uShiftK.value = 1 - Math.exp(-Math.min(dt, 1 / 30) / CONF.fluid.recenterTau);
    r.compute(this.kShiftH as never);
    this.frame++;
    this.stepAcc += Math.min(dt, 1 / 30);
    if (this.frame % 2 === 0) { // trail samples advance at half rate → longer silk
      this.uPrev.value = this.head;
      this.head = (this.head + 1) % HIST;
      this.uHead.value = this.head;
      this.uStepDt.value = this.stepAcc;
      this.stepAcc = 0;
      this.uEpoch.value = Math.floor(performance.now() / 1000);
      r.compute(this.kStep as never);
    }
  }
}
