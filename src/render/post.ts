// Post: scene pass + bloom, then a hue-preserving scalar-luminance ACES tonemap
// (per-channel ACES rotates saturated cyan → green; scalar-luminance keeps our palette).
import * as THREE from "three/webgpu";
import { PostProcessing } from "three/webgpu";
import { clamp, dot, float, max, mix, pass, screenUV, smoothstep, uniform, vec2, vec3, length } from "three/tsl";
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
    let x = clamp(lin.mul(Lout.div(max(Lin, float(1e-5)))), 0, 1);
    // soft cool vignette — frames the jelly like a diver's memory of it
    const vd = length(screenUV.sub(vec2(0.5, 0.46)));
    const vig = smoothstep(0.35, 0.95, vd);
    x = mix(x, x.mul(vec3(0.55, 0.72, 0.9)).mul(0.55), vig.mul(0.55));
    this.post.outputNode = x;
  }

  render() {
    const p = this.post as unknown as { render?: () => void; renderAsync?: () => Promise<void> };
    if (p.render) p.render(); else void p.renderAsync?.();
  }
}
