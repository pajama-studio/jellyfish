// Deep-sea backdrop: a big gradient sphere + a few slow additive light shafts from above.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  uniform, float, vec3, mix, smoothstep, clamp, positionWorld, uv, sin, abs,
} from "three/tsl";

export class Environment {
  readonly group = new THREE.Group();
  private uTime = uniform(0);
  private shafts: THREE.Group;

  constructor() {
    // gradient dome
    const bgMat = new MeshBasicNodeMaterial();
    bgMat.side = THREE.BackSide;
    bgMat.depthWrite = false;
    const hNorm = clamp(positionWorld.y.div(30).add(0.5), 0, 1);
    const deep = vec3(0.008, 0.035, 0.075);
    const mid = vec3(0.02, 0.1, 0.19);
    const top = vec3(0.10, 0.33, 0.47);
    const grad = mix(deep, mix(mid, top, smoothstep(0.55, 1.0, hNorm)), smoothstep(0.1, 0.85, hNorm));
    bgMat.colorNode = grad;
    const bg = new THREE.Mesh(new THREE.SphereGeometry(38, 24, 16), bgMat);
    bg.renderOrder = -10;
    bg.frustumCulled = false;
    this.group.add(bg);

    // light shafts — long additive wedges hanging from the "surface"
    this.shafts = new THREE.Group();
    const shaftMat = new MeshBasicNodeMaterial();
    shaftMat.transparent = true;
    shaftMat.depthWrite = false;
    shaftMat.blending = THREE.AdditiveBlending;
    shaftMat.side = THREE.DoubleSide;
    const u = uv();
    const band = abs(sin(u.x.mul(9.0).add(this.uTime.mul(0.13)))).pow(3.0);
    const vFade = smoothstep(0.0, 0.45, u.y).mul(smoothstep(1.0, 0.6, u.y));
    const hFade = smoothstep(0.0, 0.2, u.x).mul(smoothstep(1.0, 0.8, u.x));
    shaftMat.colorNode = vec3(0.35, 0.6, 0.75);
    shaftMat.opacityNode = band.mul(vFade).mul(hFade).mul(0.05);
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(26, 22), shaftMat);
      plane.position.set(0, 12, 0);
      plane.rotation.y = (i / 3) * Math.PI;
      plane.renderOrder = -5;
      plane.frustumCulled = false;
      this.shafts.add(plane);
    }
    this.group.add(this.shafts);
    void float;
  }

  update(t: number) {
    this.uTime.value = t;
    this.shafts.rotation.y = t * 0.012;
  }
}
