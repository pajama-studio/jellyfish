// Spatial hash over the bell's outer-shell nodes — Ten Minute Physics #11 style
// (integer cell coords → multiplicative hash → dense table), adapted to the GPU with
// fixed-capacity atomic buckets instead of a prefix-sum counting sort.
// Used by the plankton particles to swirl around the bell instead of drifting through it.
import type * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
const {
  Fn, instancedArray, instanceIndex, int, If, Loop,
  floor, atomicAdd, atomicLoad, atomicStore, min,
} = TSL as unknown as Record<string, any>;
import { CONF } from "../config";
import type { Jellyfish } from "./jellyfish";
import { NB1 } from "./jellyfish";

const SIZE = CONF.hash.size;      // power of two
const BUCKET = CONF.hash.bucket;
const CELL = CONF.hash.cell;

export class SpatialHash {
  readonly cnt: any = instancedArray(SIZE, "int").setPBO(true).toAtomic();
  readonly slots: any = instancedArray(SIZE * BUCKET, "int");
  /** the hashed positions buffer (bell nodes) — for queriers to resolve indices */
  readonly nodePos: any;

  private kClear: any; private kInsert: any;

  constructor(private renderer: THREE.WebGPURenderer, jelly: Jellyfish) {
    this.nodePos = jelly.pos;
    this.kClear = Fn(() => {
      atomicStore(this.cnt.element(instanceIndex), int(0));
    })().compute(SIZE);

    this.kInsert = Fn(() => {
      const i = instanceIndex;
      const p = jelly.pos.element(i);
      const key = this.keyOf(p);
      const slot = atomicAdd(this.cnt.element(key), int(1));
      If(slot.lessThan(int(BUCKET)), () => {
        this.slots.element(key.mul(int(BUCKET)).add(slot)).assign(int(i));
      });
    })().compute(NB1); // outer shell only
  }

  /** TMP-11 hash of a world-space position's integer cell */
  private keyOf(p: any) {
    const ci = int(floor(p.x.div(CELL)));
    const cj = int(floor(p.y.div(CELL)));
    const ck = int(floor(p.z.div(CELL)));
    return this.keyOfCell(ci, cj, ck);
  }

  keyOfCell(ci: any, cj: any, ck: any) {
    return ci.mul(int(92837111)).bitXor(cj.mul(int(689287499))).bitXor(ck.mul(int(283923481)))
      .bitAnd(int(SIZE - 1));
  }

  /**
   * Inline a neighbourhood visit into another kernel: calls `cb(nodeIdx)` for every
   * bell node whose hash cell overlaps the query sphere around `p` (world space).
   */
  forEachNeighbor(p: any, radius: number, cb: (idx: any) => void) {
    const c0x = int(floor(p.x.sub(radius).div(CELL))).toVar();
    const c0y = int(floor(p.y.sub(radius).div(CELL))).toVar();
    const c0z = int(floor(p.z.sub(radius).div(CELL))).toVar();
    const c1x = int(floor(p.x.add(radius).div(CELL))).toVar();
    const c1y = int(floor(p.y.add(radius).div(CELL))).toVar();
    const c1z = int(floor(p.z.add(radius).div(CELL))).toVar();
    Loop({ start: c0z, end: c1z.add(1), type: "int", name: "cz" }, ({ cz }: any) => {
      Loop({ start: c0y, end: c1y.add(1), type: "int", name: "cy" }, ({ cy }: any) => {
        Loop({ start: c0x, end: c1x.add(1), type: "int", name: "cx" }, ({ cx }: any) => {
          const key = this.keyOfCell(cx, cy, cz).toVar();
          const n = min(atomicLoad(this.cnt.element(key)), int(BUCKET)).toVar();
          Loop({ start: int(0), end: n, type: "int", name: "b" }, ({ b }: any) => {
            cb(this.slots.element(key.mul(int(BUCKET)).add(b)));
          });
        });
      });
    });
  }

  build() {
    this.renderer.compute(this.kClear as never);
    this.renderer.compute(this.kInsert as never);
  }
}
