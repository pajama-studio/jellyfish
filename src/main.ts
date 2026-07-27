// Boot + frame loop. Order per frame:
//   jelly springs/muscle (substepped) → coupling splat → tentacles → spatial hash →
//   fluid (impulses → project → advect) → plankton → render (bloom post).
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CONF } from "./config";
import { Fluid } from "./sim/fluid";
import { Jellyfish } from "./sim/jellyfish";
import { SpatialHash } from "./sim/hash";
import { Plankton } from "./sim/particles";
import { Bell } from "./render/bell";
import { Tentacles } from "./render/tentacles";
import { Environment } from "./render/environment";
import { FlowField } from "./render/flowfield";
import { Trails } from "./render/trails";
import { Post } from "./render/post";
import { wireUI } from "./ui";

async function boot() {
  const nogpu = document.getElementById("nogpu")!;
  const loading = document.getElementById("loading")!;
  if (!("gpu" in navigator)) {
    loading.style.display = "none";
    nogpu.style.display = "grid";
    return;
  }

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(CONF.render.maxPixelRatio, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.prepend(renderer.domElement);
  try {
    await renderer.init();
  } catch (e) {
    console.error("WebGPU init failed", e);
    loading.style.display = "none";
    nogpu.style.display = "grid";
    return;
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(CONF.render.fogColor, 5.5, 17);
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0.6, 0.35, 3.6);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 1.3;
  controls.maxDistance = 8;
  controls.maxPolarAngle = 2.7;
  controls.target.set(0, 0.1, 0);

  // ---- systems ----
  const fluid = new Fluid(renderer);
  const jelly = new Jellyfish(renderer, fluid);
  const shash = new SpatialHash(renderer, jelly);
  const plankton = new Plankton(renderer, fluid, shash);
  const bell = new Bell(jelly);
  const tentacles = new Tentacles(jelly);
  const env = new Environment();
  const flow = new FlowField(renderer, fluid);
  const trails = new Trails(renderer, fluid);
  scene.add(env.group, plankton.mesh, trails.mesh, flow.mesh, tentacles.mesh, bell.mesh);
  const post = new Post(renderer, scene, camera);

  wireUI(jelly, plankton, flow, bell);

  // click (not drag) → eager stroke
  let downAt = 0, downX = 0, downY = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => { downAt = performance.now(); downX = e.clientX; downY = e.clientY; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (performance.now() - downAt < 300 && Math.hypot(e.clientX - downX, e.clientY - downY) < 8) jelly.poke();
  });

  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // the GPU-side treadmill current keeps the jelly anchored near the origin,
  // so the camera target can stay fixed — no GPU→CPU readback anywhere.
  const centroid = new THREE.Vector3();

  const fpsEl = document.getElementById("fps")!;
  let fpsAcc = 0, fpsN = 0, fpsLast = performance.now();

  let last = performance.now();
  let firstFrame = true;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    const t = now / 1000;

    // simulation
    jelly.update(dt);
    shash.build();
    fluid.update(dt);
    plankton.update(dt, camera);
    trails.update(dt);
    flow.update();

    // render
    env.update(t, camera);
    bell.update(t, jelly.actVis, centroid);
    tentacles.update(t);
    controls.update();
    void post.render();

    if (firstFrame) {
      firstFrame = false;
      loading.style.opacity = "0";
      setTimeout(() => (loading.style.display = "none"), 1000);
      setTimeout(() => { const h = document.getElementById("hint"); if (h) h.style.opacity = "0"; }, 9000);
    }

    fpsAcc += dt; fpsN++;
    if (now - fpsLast > 500) {
      fpsEl.textContent = `${Math.round(fpsN / fpsAcc)} fps`;
      fpsAcc = 0; fpsN = 0; fpsLast = now;
    }
  });
}

boot();
