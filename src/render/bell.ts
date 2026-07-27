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
  attribute, uniform, float, int, vec2, vec3, varying, normalize, cross, abs, sin, pow,
  smoothstep, mix, clamp, positionWorld, cameraPosition, atan, mx_noise_float,
  fract, select, texture, max, reflect, dot,
} = TSL as unknown as Record<string, any>;

const R = CONF.jelly.rings, S = CONF.jelly.segs;
const nId = (layer: number, r: number, s: number) => layer * NB1 + 1 + r * S + ((s % S) + S) % S;

export class Bell {
  readonly mesh: THREE.Mesh;
  readonly uTime = uniform(0);
  readonly uAct = uniform(0);          // current margin muscle activation (CPU mirror)
  readonly uCenter = uniform(new THREE.Vector3());
  readonly uMuscleVis = uniform(0.55); // muscle-layer visibility (panel toggle)

  constructor(jelly: Jellyfish) {
    // ---- render mesh: 2×-refined grid, positions bicubic-resampled from the sim ----
    // The paper's own trick (§3.4): simulate coarse, render a cubic-spline resampling.
    // Each render vertex carries fractional grid coords (aT along the meridian where
    // integer 0 = apex and k = sim ring k-1; aS around the azimuth) and evaluates a
    // Catmull-Rom bicubic over the 4×4 neighbouring sim nodes in the vertex stage.
    const ROWS = 33, COLS = 64;      // (R rings → 2× rows, S segs → 2× columns)
    const vertsPerLayer = ROWS * COLS;
    const verts = vertsPerLayer * 2;
    const aT = new Float32Array(verts);
    const aS = new Float32Array(verts);
    const aRing = new Float32Array(verts);
    const aLayer = new Float32Array(verts);
    const basePos = new Float32Array(verts * 3); // bounding sphere only
    const vid = (layer: number, row: number, colIdx: number) =>
      layer * vertsPerLayer + row * COLS + (((colIdx % COLS) + COLS) % COLS);
    for (let layer = 0; layer < 2; layer++) {
      for (let row = 0; row < ROWS; row++) {
        for (let cIdx = 0; cIdx < COLS; cIdx++) {
          const i = vid(layer, row, cIdx);
          aT[i] = (row / (ROWS - 1)) * R;      // 0 = apex … R = margin ring
          aS[i] = (cIdx / COLS) * S;
          aRing[i] = row / (ROWS - 1);
          aLayer[i] = layer;
        }
      }
    }
    const idx: number[] = [];
    for (let layer = 0; layer < 2; layer++) {
      for (let row = 0; row < ROWS - 1; row++) for (let cIdx = 0; cIdx < COLS; cIdx++) {
        const a2 = vid(layer, row, cIdx), b = vid(layer, row, cIdx + 1),
          c = vid(layer, row + 1, cIdx + 1), d = vid(layer, row + 1, cIdx);
        idx.push(a2, b, c, a2, c, d);
      }
    }
    for (let cIdx = 0; cIdx < COLS; cIdx++) { // margin band joining the two shells
      const a2 = vid(0, ROWS - 1, cIdx), b = vid(0, ROWS - 1, cIdx + 1),
        c = vid(1, ROWS - 1, cIdx + 1), d = vid(1, ROWS - 1, cIdx);
      idx.push(a2, b, c, a2, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(basePos, 3));
    geo.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
    geo.setAttribute("aS", new THREE.BufferAttribute(aS, 1));
    geo.setAttribute("aRing", new THREE.BufferAttribute(aRing, 1));
    geo.setAttribute("aLayer", new THREE.BufferAttribute(aLayer, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    void nId;

    // ---- painted textures ----
    const bellTex = bellTexture();
    const causTex = causticTexture();
    bellTex.generateMipmaps = false; bellTex.minFilter = THREE.LinearFilter;

    // ---- material ----
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    const ring = attribute("aRing");
    const layer = attribute("aLayer");

    // ---- Catmull-Rom bicubic over the sim node grid ----
    const floorT = (TSL as unknown as Record<string, any>).floor;
    const crW = (f: any) => {
      const f2 = f.mul(f), f3 = f2.mul(f);
      return [
        f3.mul(-0.5).add(f2).sub(f.mul(0.5)),
        f3.mul(1.5).sub(f2.mul(2.5)).add(1),
        f3.mul(-1.5).add(f2.mul(2)).add(f.mul(0.5)),
        f3.mul(0.5).sub(f2.mul(0.5)),
      ];
    };
    const crDW = (f: any) => {
      const f2 = f.mul(f);
      return [
        f2.mul(-1.5).add(f.mul(2)).sub(0.5),
        f2.mul(4.5).sub(f.mul(5)),
        f2.mul(-4.5).add(f.mul(4)).add(0.5),
        f2.mul(1.5).sub(f),
      ];
    };
    const layerBase = int(layer).mul(int(NB1)).toVar();
    // sim node lookup: meridian index tI (0 = apex, k = ring k-1, clamped), azimuth sI (wraps)
    const nodeAt = (tI: any, sI: any) => {
      const tc = tI.clamp(int(0), int(R));
      const sm = sI.add(int(S * 4)).mod(int(S));
      const isApex = tc.equal(int(0));
      const ringNode = layerBase.add(int(1)).add(tc.sub(1).max(0).mul(int(S))).add(sm);
      return jelly.pos.element(select(isApex, layerBase, ringNode));
    };
    const tf = attribute("aT").toVar();
    const sf = attribute("aS").toVar();
    const tI0 = int(floorT(tf.min(R - 0.001))).toVar();
    const ft = tf.sub(floorT(tf.min(R - 0.001))).toVar();
    const sI0 = int(floorT(sf)).toVar();
    const fs2 = sf.sub(floorT(sf)).toVar();
    const wT = crW(ft), wS = crW(fs2), dwT = crDW(ft), dwS = crDW(fs2);
    // pure-expression accumulation (assign ops are not allowed outside a Fn body)
    let p: any = null, dPds: any = null, dPdt: any = null;
    for (let a = -1; a <= 2; a++) {
      let rowP: any = null, rowD: any = null;
      for (let b = -1; b <= 2; b++) {
        const P = nodeAt(tI0.add(int(a)), sI0.add(int(b))).toVar();
        const wp = P.mul(wS[b + 1]); const wd = P.mul(dwS[b + 1]);
        rowP = rowP ? rowP.add(wp) : wp;
        rowD = rowD ? rowD.add(wd) : wd;
      }
      rowP = rowP.toVar();
      const tp = rowP.mul(wT[a + 1]); const ts = rowD.mul(wT[a + 1]); const tt = rowP.mul(dwT[a + 1]);
      p = p ? p.add(tp) : tp;
      dPds = dPds ? dPds.add(ts) : ts;
      dPdt = dPdt ? dPdt.add(tt) : tt;
    }
    p = p.toVar(); dPds = dPds.toVar(); dPdt = dPdt.toVar();
    // analytic spline normal (ring × meridian, same orientation as the sim's)
    const n = normalize(cross(dPds, dPdt.add(vec3(0, -1e-5, 0)))).toVar();

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
    // dual counter-scrolling caustic layers → shimmering interference, the classic trick
    const causUv1 = vec2(
      positionWorld.x.mul(0.42).add(this.uTime.mul(0.021)),
      positionWorld.z.sub(positionWorld.y).mul(0.21).add(this.uTime.mul(0.009)),
    );
    const causUv2 = vec2(
      positionWorld.x.mul(0.31).sub(this.uTime.mul(0.014)),
      positionWorld.z.sub(positionWorld.y).mul(0.17).sub(this.uTime.mul(0.006)),
    );
    const caus = texture(causTex, causUv1).r.mul(texture(causTex, causUv2).r).mul(4.0)
      .add(texture(causTex, causUv1).r.mul(0.35)).mul(diff);

    const spec = pow(max(dot(reflect(L.negate(), Nw), V.negate()), 0), 30).mul(0.6);
    // iridescent thin-film rim: hue slides cyan → violet → magenta with grazing angle,
    // so the edge shimmers through colours as the bell flexes or the camera moves
    const tGraze = pow(facing.oneMinus(), 1.1);
    const iri = mix(
      mix(vec3(0.3, 0.95, 1.0), vec3(0.6, 0.55, 1.0), smoothstep(0.15, 0.55, tGraze)),
      vec3(1.0, 0.45, 0.85), smoothstep(0.55, 0.92, tGraze));

    let col = colorMap.rgb.mul(diff.mul(0.62).add(caus.mul(0.7)).add(0.16));
    col = col.add(iri.mul(fres).mul(0.6));
    col = col.add(vec3(0.9, 0.97, 1.0).mul(spec).mul(0.5));

    // ---- bioluminescence ----
    // neon margin edge: a thin electric-cyan line of light at the bell's rim,
    // breathing with the contraction wave
    const edge = smoothstep(0.95, 1.0, vRing);
    const breathe = this.uAct.mul(0.9).add(0.6);
    col = col.add(vec3(0.25, 1.0, 0.95).mul(edge).mul(breathe).mul(1.05));
    // photophores: glowing beads spaced around the margin
    const photo = pow(abs(sin(sigma.mul(12))), 36.0).mul(smoothstep(0.86, 0.97, vRing));
    col = col.add(vec3(0.6, 1.0, 0.85).mul(photo).mul(breathe).mul(2.2));
    // magenta gonad glow shining through the apex
    const gonad = pow(abs(sin(sigma.mul(2).add(0.7))), 5.0)
      .mul(smoothstep(0.42, 0.12, vRing)).mul(smoothstep(0.03, 0.12, vRing));
    col = col.add(vec3(1.0, 0.35, 0.8).mul(gonad).mul(0.75));

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
    col = col.add(vec3(1.0, 0.3, 0.75).mul(mGlow).mul(0.9));

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

    // living core: a soft light in the bell's heart that flares with each stroke
    const coreMat = new MeshBasicNodeMaterial();
    coreMat.transparent = true;
    coreMat.depthWrite = false;
    coreMat.blending = THREE.AdditiveBlending;
    coreMat.side = THREE.DoubleSide;
    const cu = (TSL as unknown as Record<string, any>).uv();
    const cd = cu.sub(0.5).length();
    coreMat.colorNode = mix(vec3(1.0, 0.75, 0.95), vec3(0.45, 0.3, 0.75), smoothstep(0.0, 0.5, cd));
    coreMat.opacityNode = smoothstep(0.5, 0.03, cd).pow(2.0).mul(this.uAct.mul(0.4).add(0.16));
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), coreMat);
    this.core.renderOrder = 8;
    this.core.frustumCulled = false;
  }

  readonly core: THREE.Mesh;

  update(t: number, act: number, center: THREE.Vector3, camera?: THREE.Camera) {
    this.uTime.value = t;
    this.uAct.value = act;
    this.uCenter.value.lerp(center, 0.05);
    if (camera) {
      this.core.position.set(this.uCenter.value.x, this.uCenter.value.y + 0.02, this.uCenter.value.z);
      this.core.lookAt(camera.position);
    }
  }
}
