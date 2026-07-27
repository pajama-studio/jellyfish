// Bell rendering — the mesh reads node positions/normals straight from the simulation's
// storage buffers (zero CPU copies). On top of the coarse sim shape we add the paper's
// §3.4 rendering detail: structural ridges (Eq.2), contraction ripples (Eq.4) and a slow
// noise field (Eq.5), all displaced along the node normal in the vertex stage.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
const {
  attribute, uniform, float, int, vec3, varying, normalize, abs, sin, pow,
  smoothstep, mix, clamp, positionWorld, cameraPosition, atan, mx_noise_float,
} = TSL as unknown as Record<string, any>;
import { CONF } from "../config";
import type { Jellyfish } from "../sim/jellyfish";
import { NB1 } from "../sim/jellyfish";

const R = CONF.jelly.rings, S = CONF.jelly.segs;
const nId = (layer: number, r: number, s: number) => layer * NB1 + 1 + r * S + ((s % S) + S) % S;

export class Bell {
  readonly mesh: THREE.Mesh;
  readonly uTime = uniform(0);
  readonly uAct = uniform(0);          // current margin muscle activation (CPU mirror)
  readonly uCenter = uniform(new THREE.Vector3());

  constructor(jelly: Jellyfish) {
    // ---- static index/attribute construction (positions live on the GPU) ----
    const NBELL = NB1 * 2;
    const aNode = new Float32Array(NBELL);
    const aRing = new Float32Array(NBELL);
    const aLayer = new Float32Array(NBELL);
    const basePos = new Float32Array(NBELL * 3); // for the bounding sphere only
    for (let i = 0; i < NBELL; i++) {
      aNode[i] = i;
      const layer = i >= NB1 ? 1 : 0;
      const li = i - layer * NB1;
      aLayer[i] = layer;
      aRing[i] = li === 0 ? 0 : (Math.floor((li - 1) / S) + 1) / R;
    }
    const idx: number[] = [];
    for (let layer = 0; layer < 2; layer++) {
      const apex = layer * NB1;
      for (let s = 0; s < S; s++) idx.push(apex, nId(layer, 0, s), nId(layer, 0, s + 1));
      for (let r = 0; r < R - 1; r++) for (let s = 0; s < S; s++) {
        const a2 = nId(layer, r, s), b = nId(layer, r, s + 1), c = nId(layer, r + 1, s + 1), d = nId(layer, r + 1, s);
        idx.push(a2, b, c, a2, c, d);
      }
    }
    for (let s = 0; s < S; s++) { // margin band joining the two shells
      const a2 = nId(0, R - 1, s), b = nId(0, R - 1, s + 1), c = nId(1, R - 1, s + 1), d = nId(1, R - 1, s);
      idx.push(a2, b, c, a2, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(basePos, 3));
    geo.setAttribute("aNode", new THREE.BufferAttribute(aNode, 1));
    geo.setAttribute("aRing", new THREE.BufferAttribute(aRing, 1));
    geo.setAttribute("aLayer", new THREE.BufferAttribute(aLayer, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

    // ---- material ----
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    const node = int(attribute("aNode"));
    const ring = attribute("aRing");
    const layer = attribute("aLayer");
    const p = jelly.pos.element(node);
    const n = jelly.nrm.element(node);

    // paper-style fine detail, vertex-stage, outer shell only
    const sigmaV = atan(p.z.sub(this.uCenter.z), p.x.sub(this.uCenter.x));
    const cStr = abs(sin(sigmaV.mul(4))).mul(0.014).mul(ring);                       // Eq.2 ridges
    const cCmp = sin(sigmaV.mul(16)).mul(0.02).mul(this.uAct).mul(ring.mul(ring));   // Eq.4 ripples
    const cNoise = mx_noise_float(vec3(sigmaV.mul(1.4), ring.mul(3).sub(this.uTime.mul(0.05)), this.uTime.mul(0.07)))
      .mul(0.022);                                                                    // Eq.5 drift
    const disp = cStr.add(cCmp).add(cNoise).mul(layer.oneMinus());
    mat.positionNode = p.add(n.mul(disp));

    const vNrm = varying(n);
    const vRing = varying(ring);
    const vLayer = varying(layer);

    // fragment: translucency, fresnel rim, radial canals, gonads
    const V = normalize(cameraPosition.sub(positionWorld));
    const Nw = normalize(vNrm).mul(float(1).sub(vLayer.mul(2))).toVar(); // inner shell flips
    const facing = abs(Nw.dot(V));
    const fres = pow(facing.oneMinus(), 2.4);

    const sigma = atan(positionWorld.z.sub(this.uCenter.z), positionWorld.x.sub(this.uCenter.x));
    const canal = smoothstep(0.976, 1.0, abs(sin(sigma.mul(4)))).mul(smoothstep(0.15, 0.75, vRing));
    const gonad = smoothstep(0.52, 0.18, vRing).mul(pow(abs(sin(sigma.mul(2).add(0.7))), 5.0))
      .mul(smoothstep(0.06, 0.2, vRing));
    const rim = smoothstep(0.82, 1.0, vRing);

    const bodyCol = mix(vec3(0.36, 0.46, 0.72), vec3(0.62, 0.55, 0.92), vRing);
    const rimCol = vec3(0.55, 0.9, 1.0);
    const gonadCol = vec3(1.0, 0.52, 0.56);
    const canalCol = vec3(0.75, 0.92, 1.0);

    let col = bodyCol.mul(fres.mul(0.9).add(0.22));
    col = col.add(rimCol.mul(fres).mul(rim.mul(0.8).add(0.25)));
    col = col.add(gonadCol.mul(gonad).mul(0.85));
    col = col.add(canalCol.mul(canal).mul(0.5));
    // subtle interior warm glow that pulses with the muscle
    col = col.add(vec3(1.0, 0.7, 0.6).mul(this.uAct).mul(smoothstep(0.6, 0.1, vRing)).mul(vLayer).mul(0.35));
    mat.colorNode = clamp(col, 0, 3);

    const alpha = float(0.13)
      .add(fres.mul(0.42))
      .add(gonad.mul(0.3))
      .add(canal.mul(0.22))
      .add(rim.mul(0.28));
    mat.opacityNode = clamp(alpha, 0, 0.92);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  update(t: number, act: number, center: THREE.Vector3) {
    this.uTime.value = t;
    this.uAct.value = act;
    this.uCenter.value.lerp(center, 0.05);
  }
}
