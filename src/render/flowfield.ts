// Flow-field visualisation — a sparse 3D lattice of velocity streaks filling the tank.
// A compute pass samples the fluid at every lattice point into a buffer; each point draws
// as a camera-facing streak pointing along the local velocity (bright head, faded tail),
// invisible in still water. This is a live volume of currents, not a slice.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
import { CONF } from "../config";
import type { Fluid } from "../sim/fluid";

const {
  Fn, instancedArray, instanceIndex, float, vec3, vec4, normalize, cross,
  length, smoothstep, mix, clamp, positionLocal, cameraPosition, max, varying, uv,
} = TSL as unknown as Record<string, any>;

const { nx, ny, nz, h } = CONF.grid;
const STEP = 3; // lattice stride in cells
const GX = Math.floor(nx / STEP), GY = Math.floor(ny / STEP), GZ = Math.floor(nz / STEP);
const COUNT = GX * GY * GZ;

export class FlowField {
  readonly mesh: THREE.Mesh;
  private samples: any = instancedArray(COUNT, "vec4"); // xyz = velocity, w = speed
  private lattice: any;
  private kSample: any;

  constructor(private renderer: THREE.WebGPURenderer, fluid: Fluid) {
    const half = fluid.ext.clone().multiplyScalar(0.5);
    // static lattice positions, CPU-precomputed — the kernel and the material read the
    // same buffer (mirrors the proven particle pattern exactly)
    const posA = new Float32Array(COUNT * 3);
    for (let k = 0; k < GZ; k++) for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const idx = i + GX * (j + GY * k);
      posA[idx * 3] = (i + 0.5) * STEP * h - half.x;
      posA[idx * 3 + 1] = (j + 0.5) * STEP * h - half.y;
      posA[idx * 3 + 2] = (k + 0.5) * STEP * h - half.z;
    }
    this.lattice = instancedArray(posA, "vec3");

    this.kSample = Fn(() => {
      const p = this.lattice.element(instanceIndex).toVar();
      const v = fluid.velAt(p).toVar();
      this.samples.element(instanceIndex).assign(vec4(v, length(v)));
    })().compute(COUNT);

    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.side = THREE.DoubleSide;

    const center = this.lattice.element(instanceIndex).toVar();
    const s4 = this.samples.element(instanceIndex).toVar();
    const speed = s4.w.toVar();
    const dir = s4.xyz.div(max(speed, 1e-4)).toVar();
    const view = normalize(cameraPosition.sub(center)).toVar();
    const side = normalize(cross(dir, view).add(vec3(1e-5, 1e-5, 0))).toVar();
    const len = clamp(speed.mul(1.2), 0.03, STEP * h * 1.3);
    const width = float(0.009);
    mat.positionNode = center
      .add(dir.mul(positionLocal.x.mul(len)))
      .add(side.mul(positionLocal.y.mul(width)));

    // uv.x runs along the streak → faded tail, bright head = direction of flow
    const vSpeed = varying(speed);
    const along = uv().x;
    const slow = vec3(0.16, 0.5, 0.95);
    const fast = vec3(1.0, 1.0, 0.9);
    mat.colorNode = mix(slow, fast, smoothstep(0.06, 0.8, vSpeed));
    mat.opacityNode = smoothstep(0.015, 0.22, vSpeed).mul(along.mul(along)).mul(0.95);

    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = true; // "show currents" defaults on
  }

  /** refresh the sample lattice each frame while visible */
  update() {
    if (this.mesh.visible) this.renderer.compute(this.kSample as never);
  }

  set visible(v: boolean) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }
}
