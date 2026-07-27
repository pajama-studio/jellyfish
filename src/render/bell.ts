// Bell rendering — mesh reads node positions/normals straight from the sim buffers.
// Shading follows Chrysaora's recipe (arodic/Chrysaora): painted colour map ×
// (ambient + warm top-light diffuse + world-scrolled caustics·diffuse) + fresnel rim
// + specular, with the paper's §3.4 detail displacement on top of the sim shape.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
import { CONF } from "../config";
import type { Jellyfish } from "../sim/jellyfish";
import { NB1 } from "../sim/jellyfish";
import { bellTexture, causticTexture } from "./textures";

const {
  attribute, uniform, float, int, vec2, vec3, varying, normalize, abs, sin, pow,
  smoothstep, clamp, positionWorld, cameraPosition, atan, mx_noise_float,
  fract, select, texture, max, reflect, dot,
} = TSL as unknown as Record<string, any>;

const R = CONF.jelly.rings, S = CONF.jelly.segs;
const nId = (layer: number, r: number, s: number) => layer * NB1 + 1 + r * S + ((s % S) + S) % S;

export class Bell {
  readonly mesh: THREE.Mesh;
  readonly uTime = uniform(0);
  readonly uAct = uniform(0);          // current margin muscle activation (CPU mirror)
  readonly uCenter = uniform(new THREE.Vector3());
  readonly uMuscleVis = uniform(0.9);  // muscle-layer visibility (panel toggle)

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

    // ---- painted textures ----
    const bellTex = bellTexture();
    const causTex = causticTexture();
    bellTex.generateMipmaps = false; bellTex.minFilter = THREE.LinearFilter;

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

    // paper-style fine detail + scalloped margin lobes, vertex-stage, outer shell only
    const sigmaV = atan(p.z.sub(this.uCenter.z), p.x.sub(this.uCenter.x));
    const cStr = abs(sin(sigmaV.mul(8))).mul(0.02).mul(ring.mul(ring));            // Eq.2 → 16 lobes
    const cCmp = sin(sigmaV.mul(16)).mul(0.016).mul(this.uAct).mul(ring.mul(ring)); // Eq.4 ripples
    const cNoise = mx_noise_float(vec3(sigmaV.mul(1.4), ring.mul(3).sub(this.uTime.mul(0.05)), this.uTime.mul(0.07)))
      .mul(0.02);                                                                   // Eq.5 drift
    const disp = cStr.add(cCmp).add(cNoise).mul(layer.oneMinus());
    mat.positionNode = p.add(n.mul(disp));

    const vNrm = varying(n);
    const vRing = varying(ring);
    const vLayer = varying(layer);

    // ---- fragment: Chrysaora shading ----
    const V = normalize(cameraPosition.sub(positionWorld));
    const Nw = normalize(vNrm).mul(float(1).sub(vLayer.mul(2))).toVar(); // inner shell flips
    const facing = abs(Nw.dot(V));
    const fres = pow(facing.oneMinus(), 2.2);

    const sigma = atan(positionWorld.z.sub(this.uCenter.z), positionWorld.x.sub(this.uCenter.x));
    const u = fract(sigma.mul(1 / (Math.PI * 2)).add(0.5));
    const colorMap = texture(bellTex, vec2(u, vRing)).toVar();

    // warm light from above + painted caustic web scrolled in world space
    const L = normalize(vec3(0.25, 1.0, 0.15));
    const diff = max(dot(Nw, L), 0).toVar();
    const causUv = vec2(
      positionWorld.x.mul(0.42).add(this.uTime.mul(0.015)),
      positionWorld.z.sub(positionWorld.y).mul(0.21).add(this.uTime.mul(0.007)),
    );
    const caus = texture(causTex, causUv).r.mul(diff).mul(1.6);

    const spec = pow(max(dot(reflect(L.negate(), Nw), V.negate()), 0), 30).mul(0.6);
    const rimCol = vec3(0.65, 0.85, 1.0);

    let col = colorMap.rgb.mul(diff.mul(0.62).add(caus.mul(0.7)).add(0.16));
    col = col.add(rimCol.mul(fres).mul(0.4));
    col = col.add(vec3(1.0, 0.95, 0.85).mul(spec).mul(0.6));

    // the muscle made visible: subumbrellar fibre bands lit by the live activation wave
    const J = CONF.jelly.muscle;
    const ph = fract(jelly.uPhase.sub(jelly.uWave.mul(vRing)));
    const atkF = float(J.attack);
    const actHere = select(ph.lessThan(atkF),
      smoothstep(0, J.attack, ph),
      smoothstep(J.attack, J.attack + 0.42, ph).oneMinus());
    const muscleW = pow(vRing, 1.6);
    const fibres = pow(abs(sin(vRing.mul(52))), 2.0).mul(0.7).add(0.3);
    const mGlow = actHere.mul(muscleW).mul(fibres).mul(vLayer).mul(this.uMuscleVis);
    col = col.add(vec3(1.0, 0.34, 0.2).mul(mGlow).mul(0.9));

    mat.colorNode = clamp(col, 0, 3);

    // translucency: gelatinous body, denser margin + rim; inner shell a touch clearer
    const alpha = float(0.24)
      .add(fres.mul(0.38))
      .add(smoothstep(0.6, 1.0, vRing).mul(0.16))
      .add(mGlow.mul(0.25))
      .sub(vLayer.mul(0.08));
    mat.opacityNode = clamp(alpha, 0, 0.9);

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
