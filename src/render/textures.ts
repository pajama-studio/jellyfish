// Procedurally "hand-painted" canvas textures, after Chrysaora's painted atlas
// (arodic/Chrysaora): the bell's radial veins + margin band, the frilly oral-arm
// ribbon, and a scrolling caustic light web. Painted once at boot — no downloads.
import * as THREE from "three/webgpu";

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")!] as const;
}

// deterministic tiny rng so the jelly looks the same on every visit
function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/** Bell surface: u = azimuth (wraps), v = apex→margin. Amber sea-nettle palette. */
export function bellTexture(): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const [c, g] = canvas(W, H);
  const r = rng(20260727);

  // base: pale amber, darkening + saturating toward the margin (bottom)
  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, "#f3e6cf");
  base.addColorStop(0.55, "#eccfa4");
  base.addColorStop(0.85, "#e0a468");
  base.addColorStop(1, "#c96f3a");
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  // fine speckle
  for (let i = 0; i < 9000; i++) {
    const x = r() * W, y = r() * H;
    g.fillStyle = r() > 0.5 ? "rgba(255,250,235,0.05)" : "rgba(120,60,30,0.045)";
    g.fillRect(x, y, 1.5, 1.5);
  }

  // 16 principal radial veins with wobble + branching (Chrysaora's signature)
  const VEINS = 16;
  for (let v = 0; v < VEINS; v++) {
    const x0 = ((v + 0.5) / VEINS) * W;
    drawVein(g, r, x0, H * 0.08, H, 3.2, "rgba(122,44,22,0.55)");
    // minor veins between
    drawVein(g, r, x0 + W / VEINS / 2, H * 0.35, H * 0.98, 1.6, "rgba(122,44,22,0.28)");
  }

  // margin band: saturated red-orange rim like the reference painting
  const rim = g.createLinearGradient(0, H * 0.86, 0, H);
  rim.addColorStop(0, "rgba(200,80,30,0)");
  rim.addColorStop(0.7, "rgba(196,60,20,0.55)");
  rim.addColorStop(1, "rgba(150,30,10,0.8)");
  g.fillStyle = rim;
  g.fillRect(0, H * 0.86, W, H * 0.14);

  // pale top disc (thick apex mesoglea reads lighter)
  const apex = g.createLinearGradient(0, 0, 0, H * 0.3);
  apex.addColorStop(0, "rgba(255,248,235,0.5)");
  apex.addColorStop(1, "rgba(255,248,235,0)");
  g.fillStyle = apex;
  g.fillRect(0, 0, W, H * 0.3);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawVein(
  g: CanvasRenderingContext2D, r: () => number,
  x0: number, y0: number, y1: number, width: number, style: string,
) {
  g.strokeStyle = style;
  g.lineCap = "round";
  let x = x0, y = y0;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x, y);
  const steps = 14;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const ny = y0 + (y1 - y0) * t;
    const nx = x0 + (r() - 0.5) * 26 * Math.sin(t * Math.PI);
    g.quadraticCurveTo(x, (y + ny) / 2, nx, ny);
    // occasional branch
    if (s > 4 && r() > 0.72) {
      g.moveTo(nx, ny);
      g.lineTo(nx + (r() - 0.5) * 46, ny + 18 + r() * 30);
      g.moveTo(nx, ny);
    }
    x = nx; y = ny;
  }
  g.stroke();
}

/** Frilly oral-arm ribbon: u across, v along. Alpha in the texture's alpha channel. */
export function armTexture(): THREE.CanvasTexture {
  const W = 256, H = 1024;
  const [c, g] = canvas(W, H);
  const r = rng(777);
  g.clearRect(0, 0, W, H);

  // soft core
  const core = g.createLinearGradient(0, 0, W, 0);
  core.addColorStop(0, "rgba(235,190,150,0)");
  core.addColorStop(0.28, "rgba(243,210,175,0.85)");
  core.addColorStop(0.5, "rgba(250,232,205,0.95)");
  core.addColorStop(0.72, "rgba(243,210,175,0.85)");
  core.addColorStop(1, "rgba(235,190,150,0)");
  g.fillStyle = core;
  g.fillRect(0, 0, W, H);

  // central darker vein
  const vein = g.createLinearGradient(0, 0, W, 0);
  vein.addColorStop(0.42, "rgba(150,70,40,0)");
  vein.addColorStop(0.5, "rgba(140,55,30,0.55)");
  vein.addColorStop(0.58, "rgba(150,70,40,0)");
  g.fillStyle = vein;
  g.fillRect(0, 0, W, H);

  // frilly translucent feathers along the edges
  for (let i = 0; i < 500; i++) {
    const y = r() * H;
    const side = r() > 0.5 ? 1 : -1;
    const x = W / 2 + side * (W * 0.18 + r() * W * 0.3);
    const rad = 5 + r() * 18;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, "rgba(250,225,195,0.25)");
    grad.addColorStop(1, "rgba(250,225,195,0)");
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Caustic light web, world-space scrolled over the bell (Chrysaora's uSampler1). */
export function causticTexture(): THREE.CanvasTexture {
  const W = 512, H = 512;
  const [c, g] = canvas(W, H);
  const r = rng(4242);
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 260; i++) {
    const x = r() * W, y = r() * H;
    const rad = 18 + r() * 46;
    const a = 0.05 + r() * 0.1;
    g.strokeStyle = `rgba(255,246,220,${a})`;
    g.lineWidth = 1.5 + r() * 3;
    g.beginPath();
    g.arc(x, y, rad, r() * Math.PI * 2, r() * Math.PI * 1.4);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
