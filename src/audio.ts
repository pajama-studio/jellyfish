// Procedural underwater ambience — no audio files, pure WebAudio synthesis.
// The underwater feel comes from aggressive low-pass filtering (water kills highs),
// slow filter/amplitude drift (currents), a sub-bass pad, sparse soft bubbles, and a
// muffled swell tied to each swim stroke.
export class Ambience {
  private ctx?: AudioContext;
  private master?: GainNode;
  private swellGain?: GainNode;
  private swellFilter?: BiquadFilterNode;
  private bubbleTimer?: number;
  muted = false;

  /** call from a user gesture (autoplay policy) */
  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.master = master;
    // fade in gently
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 4);

    const noiseBuf = this.makeNoise(ctx, 4);

    // --- deep water bed: brown-ish noise through a slowly wandering low-pass ---
    const bed = ctx.createBufferSource();
    bed.buffer = noiseBuf; bed.loop = true;
    const bedLp = ctx.createBiquadFilter();
    bedLp.type = "lowpass"; bedLp.frequency.value = 240; bedLp.Q.value = 0.6;
    const bedLp2 = ctx.createBiquadFilter();
    bedLp2.type = "lowpass"; bedLp2.frequency.value = 500;
    const bedGain = ctx.createGain(); bedGain.gain.value = 0.16;
    bed.connect(bedLp).connect(bedLp2).connect(bedGain).connect(master);
    bed.start();
    this.lfo(ctx, bedLp.frequency, 0.045, 120);   // cutoff wanders → distant washes
    this.lfo(ctx, bedGain.gain, 0.023, 0.05);     // slow breathing of the sea

    // --- abyssal pad: two detuned sub sines, barely audible, very slow tremolo ---
    for (const [f, g, tr] of [[55, 0.045, 0.011], [82.5, 0.028, 0.017]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine"; osc.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      osc.connect(og).connect(master);
      osc.start();
      this.lfo(ctx, og.gain, tr, g * 0.55);
    }

    // --- stroke swell: band-passed noise, opened by pulse() ---
    const swell = ctx.createBufferSource();
    swell.buffer = noiseBuf; swell.loop = true;
    const swf = ctx.createBiquadFilter();
    swf.type = "lowpass"; swf.frequency.value = 160; swf.Q.value = 1.2;
    const swg = ctx.createGain(); swg.gain.value = 0;
    swell.connect(swf).connect(swg).connect(master);
    swell.start();
    this.swellGain = swg; this.swellFilter = swf;

    // --- sparse bubbles: tiny rising sine chirps, heavily quieted ---
    const bubble = () => {
      if (!this.ctx || this.muted) return this.scheduleBubble();
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const f0 = 380 + Math.random() * 700;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (1.3 + Math.random() * 0.6), t + 0.12);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(0.012 + Math.random() * 0.014, t + 0.02);
      bg.gain.exponentialRampToValueAtTime(1e-4, t + 0.14 + Math.random() * 0.1);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1200;
      o.connect(bg).connect(lp).connect(this.master!);
      o.start(t); o.stop(t + 0.3);
      this.scheduleBubble();
    };
    this.scheduleBubble = () => {
      this.bubbleTimer = window.setTimeout(bubble, 2500 + Math.random() * 7000);
    };
    this.scheduleBubble();
  }

  private scheduleBubble: () => void = () => {};

  /** slow sine modulation of an AudioParam (the drift that makes it feel alive) */
  private lfo(ctx: AudioContext, param: AudioParam, freq: number, depth: number) {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
  }

  /** a muffled whoosh synced to the swim stroke (strength 0..1) */
  pulse(strength: number) {
    if (!this.ctx || !this.swellGain || !this.swellFilter || this.muted) return;
    const t = this.ctx.currentTime;
    const g = this.swellGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.1 * strength + 0.02, t + 0.18);
    g.exponentialRampToValueAtTime(1e-3, t + 1.4);
    const f = this.swellFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(300, t);
    f.exponentialRampToValueAtTime(90, t + 1.2);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx && this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(m ? 0 : 0.9, t + 0.6);
    }
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02; // brownian walk → dark noise
      d[i] = brown * 3.5;
    }
    return buf;
  }

  dispose() { if (this.bubbleTimer) clearTimeout(this.bubbleTimer); this.ctx?.close(); }
}
