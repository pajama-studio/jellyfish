// Post: scene pass + bloom, then a hue-preserving scalar-luminance ACES tonemap
// (per-channel ACES rotates saturated cyan → green; scalar-luminance keeps our palette).
import * as THREE from "three/webgpu";
import { PostProcessing } from "three/webgpu";
import { clamp, dot, float, max, pass, uniform, vec3 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { CONF } from "../config";

export class Post {
  private post: PostProcessing;
  private uExposure = uniform(1.12);

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    renderer.toneMapping = THREE.NoToneMapping; // we tonemap below — avoid double-mapping
    this.post = new PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const b = CONF.render.bloom;
    const withBloom = scenePass.add(bloom(scenePass, b.strength, b.radius, b.threshold));

    const LUMA = vec3(0.2126, 0.7152, 0.0722);
    const lin = withBloom.mul(this.uExposure);
    const Lin = dot(lin, LUMA);
    const Lout = clamp(
      Lin.mul(Lin.mul(2.51).add(0.03)).div(Lin.mul(Lin.mul(2.43).add(0.59)).add(0.14)), 0, 1);
    this.post.outputNode = clamp(lin.mul(Lout.div(max(Lin, float(1e-5)))), 0, 1);
  }

  render() {
    const p = this.post as unknown as { render?: () => void; renderAsync?: () => Promise<void> };
    if (p.render) p.render(); else void p.renderAsync?.();
  }
}
