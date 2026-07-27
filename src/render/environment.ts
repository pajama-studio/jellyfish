// Deep-sea backdrop: a big gradient sphere, slow god-ray planes, and soft
// fresnel-edged volumetric light cones descending from the surface.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
import {
  uniform, float, vec3, mix, smoothstep, clamp, positionWorld, uv, sin, abs,
} from "three/tsl";

export class Environment {
  readonly group = new THREE.Group();
  private uTime = uniform(0);
  private shafts: THREE.Group;
  private cone1?: THREE.Mesh;
  private cone2?: THREE.Mesh;
  private halo?: THREE.Mesh;

  constructor() {
    // gradient dome
    const bgMat = new MeshBasicNodeMaterial();
    bgMat.side = THREE.BackSide;
    bgMat.depthWrite = false;
    const hNorm = clamp(positionWorld.y.div(30).add(0.5), 0, 1);
    const deep = vec3(0.006, 0.028, 0.06);
    const mid = vec3(0.02, 0.1, 0.17);
    const top = vec3(0.16, 0.38, 0.46);
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
    shaftMat.colorNode = vec3(0.45, 0.68, 0.72);
    shaftMat.opacityNode = band.mul(vFade).mul(hFade).mul(0.11);
    for (let i = 0; i < 7; i++) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), shaftMat);
      plane.position.set(0, 12, 0);
      plane.rotation.y = (i / 7) * Math.PI;
      plane.renderOrder = -5;
      plane.frustumCulled = false;
      this.shafts.add(plane);
    }

    // volumetric light cones descending from the surface — soft fresnel-edged,
    // slowly counter-rotating, with animated density bands: cheap volume lighting
    const mkCone = (rTop: number, rBot: number, hgt: number, y: number, op: number, dir: number) => {
      const m = new MeshBasicNodeMaterial();
      m.transparent = true;
      m.depthWrite = false;
      m.blending = THREE.AdditiveBlending;
      m.side = THREE.DoubleSide;
      const cu = uv();
      const nrm = (TSL as unknown as Record<string, any>).normalWorld;
      const viewDir = (TSL as unknown as Record<string, any>).positionWorld.sub(
        (TSL as unknown as Record<string, any>).cameraPosition).normalize();
      const rimSoft = nrm.dot(viewDir).abs().pow(1.6); // faces edge-on fade out → soft silhouette
      const bands = abs(sin(cu.x.mul(14).add(this.uTime.mul(dir * 0.05)))).pow(2.0).mul(0.6).add(0.4);
      const vfade = smoothstep(0.0, 0.35, cu.y).mul(smoothstep(1.05, 0.55, cu.y));
      m.colorNode = vec3(0.55, 0.78, 0.85);
      m.opacityNode = rimSoft.mul(bands).mul(vfade).mul(op);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, hgt, 40, 1, true), m);
      cone.position.set(0.8, y, -1.5);
      cone.renderOrder = -4;
      cone.frustumCulled = false;
      this.shafts.add(cone);
      return cone;
    };
    this.cone1 = mkCone(1.6, 5.2, 15, 9.5, 0.16, 1);
    this.cone2 = mkCone(2.6, 7.5, 16, 9.0, 0.1, -1);

    // backlight halo — a soft radial glow always BEHIND the jelly along the view
    // axis. The single biggest trick of aquarium jellyfish photography: the animal
    // reads as a luminous silhouette floating in front of a distant light.
    const haloMat = new MeshBasicNodeMaterial();
    haloMat.transparent = true;
    haloMat.depthWrite = false;
    haloMat.blending = THREE.AdditiveBlending;
    haloMat.side = THREE.DoubleSide;
    const hd = uv().sub(0.5).length();
    haloMat.colorNode = mix(vec3(0.1, 0.4, 0.55), vec3(0.03, 0.1, 0.22), smoothstep(0.0, 0.5, hd));
    haloMat.opacityNode = smoothstep(0.5, 0.02, hd).pow(1.6).mul(0.55);
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 7.5), haloMat);
    this.halo.renderOrder = -3;
    this.halo.frustumCulled = false;
    this.group.add(this.halo);
    this.group.add(this.shafts);

    // warm sun glow far above — gives the amber palette its light source
    const glowMat = new MeshBasicNodeMaterial();
    glowMat.transparent = true;
    glowMat.depthWrite = false;
    glowMat.blending = THREE.AdditiveBlending;
    glowMat.side = THREE.DoubleSide;
    const gu = uv();
    const d = gu.sub(0.5).length();
    glowMat.colorNode = vec3(0.75, 0.9, 1.0);
    glowMat.opacityNode = smoothstep(0.5, 0.0, d).pow(2.2).mul(0.5);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), glowMat);
    glow.position.set(2, 16, -6);
    glow.rotation.x = Math.PI / 2;
    glow.renderOrder = -6;
    glow.frustumCulled = false;
    this.group.add(glow);
    void float;
  }

  update(t: number, camera?: THREE.Camera) {
    this.uTime.value = t;
    this.shafts.rotation.y = t * 0.012;
    if (this.cone1) this.cone1.rotation.y = t * 0.05;
    if (this.cone2) this.cone2.rotation.y = -t * 0.033;
    if (this.halo && camera) {
      // sit 2.6 units behind the origin as seen from the camera, facing it
      const dir = camera.position.clone().normalize();
      this.halo.position.copy(dir.multiplyScalar(-2.6));
      this.halo.lookAt(camera.position);
    }
  }
}
