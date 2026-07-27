// Minimal tuning panel — sliders map straight onto sim uniforms/fields.
import { CONF } from "./config";
import type { Jellyfish } from "./sim/jellyfish";
import type { Plankton } from "./sim/particles";
import type { Bell } from "./render/bell";

export function wireUI(jelly: Jellyfish, plankton: Plankton, bell: Bell) {
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;

  const gear = document.getElementById("gear");
  const panel = document.getElementById("panel");
  gear?.addEventListener("click", () => panel?.classList.toggle("open"));

  const freq = $("uiFreq");
  if (freq) {
    freq.value = String(CONF.jelly.muscle.freq);
    freq.addEventListener("input", () => (jelly.freq = Number(freq.value)));
  }
  const contract = $("uiContract");
  if (contract) {
    contract.value = String(CONF.jelly.muscle.contract);
    contract.addEventListener("input", () => (jelly.userContract = Number(contract.value)));
  }
  const drag = $("uiDrag");
  if (drag) {
    drag.value = String(CONF.jelly.drag);
    drag.addEventListener("input", () => (jelly.drag = Number(drag.value)));
  }
  const glow = $("uiGlow");
  if (glow) {
    glow.value = "1";
    glow.addEventListener("input", () => (plankton.uGlow.value = Number(glow.value)));
  }
  const flowChk = $("uiFlow");
  flowChk?.addEventListener("change", () => (plankton.uFlowViz.value = flowChk.checked ? 1 : 0));
  const muscleChk = $("uiMuscle");
  muscleChk?.addEventListener("change", () => (bell.uMuscleVis.value = muscleChk.checked ? 0.9 : 0));
}
