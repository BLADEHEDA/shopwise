/** Small sound + vibration for important moments (clock in / out, sale done).
 *  Uses the Web Audio API, so no sound files to download; silently does
 *  nothing where the phone or browser doesn't support it. */
let ctx: AudioContext | null = null;

function tone(freq: number, start: number, dur: number, vol = 0.18) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + dur + 0.05);
}

export function chime(kind: "in" | "out" | "success") {
  try {
    if (typeof window === "undefined") return;
    navigator.vibrate?.(kind === "out" ? [60, 80, 60] : kind === "in" ? [40, 60, 120] : [35]);
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = ctx || new AC();
    if (ctx.state === "suspended") ctx.resume();
    if (kind === "in") { tone(523, 0, 0.18); tone(659, 0.12, 0.18); tone(784, 0.24, 0.32); }       // rising C-E-G
    else if (kind === "out") { tone(784, 0, 0.18); tone(659, 0.12, 0.18); tone(523, 0.24, 0.36); } // falling
    else { tone(880, 0, 0.12); tone(1175, 0.09, 0.22); }
  } catch { /* sound is a nice-to-have */ }
}
