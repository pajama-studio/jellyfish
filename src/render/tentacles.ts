// Tentacles + oral arms as camera-facing ribbons, positions read from the chain buffers.
import * as THREE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
const {
  attribute, uniform, float, int, vec3, normalize, cross, sin,
  smoothstep, mix, clamp, cameraPosition, min,
} = TSL as unknown as Record<string, any>;
import { CONF } from "../config";
import type { Jellyfish } from "../sim/jellyfish";

const TCOUNT = CONF.tentacles.count;
const TCH = TCOUNT + CONF.arms.count;
const SEGS = CONF.tentacles.segs; // == arms.segs (kernel assumes equal)

export class Tentacles {
  readonly mesh: THREE.Mesh;
  readonly uTime = uniform(0);

  constructor(jelly: Jellyfish) {
    // two vertices per node per chain; quads between successive nodes
    const verts = TCH * SEGS * 2;
    const aChain = new Float32Array(verts);
    const aSeg = new Float32Array(verts);
    const aSide = new Float32Array(verts);
    const basePos = new Float32Array(verts * 3);
    const idx: number[] = [];
    for (let c = 0; c < TCH; c++) {
      for (let s = 0; s < SEGS; s++) {
        const v = (c * SEGS + s) * 2;
        aChain[v] = c; aChain[v + 1] = c;
        aSeg[v] = s; aSeg[v + 1] = s;
        aSide[v] = -1; aSide[v + 1] = 1;
        if (s < SEGS - 1) idx.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(basePos, 3));
    geo.setAttribute("aChain", new THREE.BufferAttribute(aChain, 1));
    geo.setAttribute("aSeg", new THREE.BufferAttribute(aSeg, 1));
    geo.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    const chain = attribute("aChain");
    const seg = attribute("aSeg");
    const side = attribute("aSide");
    const id = int(chain).mul(int(SEGS)).add(int(seg));
    const segF = seg.div(SEGS - 1);
    const isArm = smoothstep(TCOUNT - 0.5, TCOUNT + 0.5, chain);

    const p = jelly.tPos.element(id).toVar();
    const idNext = int(chain).mul(int(SEGS)).add(min(int(seg).add(1), int(SEGS - 1)));
    const idPrev = int(chain).mul(int(SEGS)).add(int(seg).sub(1).max(0));
    const tang = normalize(jelly.tPos.element(idNext).sub(jelly.tPos.element(idPrev))).toVar();
    const view = normalize(cameraPosition.sub(p)).toVar();
    const ribbonDir = normalize(cross(tang, view)).toVar();

    // width: tentacles are threads; oral arms are frilly curtains that taper
    const wTent = float(0.012).mul(segF.mul(0.75).oneMinus());
    const wArm = float(0.075).mul(smoothstep(0, 0.18, segF)).mul(segF.mul(0.55).oneMinus());
    const width = mix(wTent, wArm, isArm);
    // slow ruffle on the arms
    const ruffle = sin(segF.mul(9).add(this.uTime.mul(1.6)).add(chain.mul(2.1)))
      .mul(0.03).mul(isArm).mul(segF);
    mat.positionNode = p.add(ribbonDir.mul(side.mul(width))).add(tang.mul(ruffle));

    const tentCol = vec3(0.62, 0.85, 1.0);
    const armCol = vec3(0.95, 0.72, 0.78);
    mat.colorNode = mix(tentCol, armCol, isArm);
    const fade = smoothstep(1.0, 0.15, segF);
    const alphaT = fade.mul(0.35);
    const alphaA = fade.mul(0.45);
    mat.opacityNode = clamp(mix(alphaT, alphaA, isArm), 0, 1);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
  }

  update(t: number) { this.uTime.value = t; }
}
