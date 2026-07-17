// Hybrid Logical Clock — gives a causally-consistent total order across peers
// with no central sequencer. Format: `${wallMs}:${counter}:${nodeShort}`, zero-
// padded so lexicographic string comparison matches chronological order.
// `nodeShort` (a suffix of the author's identityId) breaks ties deterministically
// so two peers never disagree on ordering.

const WALL_PAD = 15; // ms since epoch fits in 13 digits well past year 2286
// Wide enough that sustained clock skew (e.g. a peer with a badly-set future
// wall clock, forcing the local counter to climb for as long as the skew
// persists) can't plausibly overflow it — padStart doesn't truncate, so if the
// counter's digit count ever exceeded this width, lexicographic comparison
// against a same-wall, narrower-counter HLC would silently invert.
const COUNTER_PAD = 12;

export type Hlc = string;

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

export function parseHlc(hlc: Hlc): { wall: number; counter: number; node: string } {
  const [wall, counter, node] = hlc.split(":");
  return { wall: Number(wall), counter: Number(counter), node };
}

export function formatHlc(wall: number, counter: number, node: string): Hlc {
  return `${pad(wall, WALL_PAD)}:${pad(counter, COUNTER_PAD)}:${node}`;
}

/** Advance the clock for a locally-originated event. `physicalNow` is passed in
 * (never read from Date here) so callers stay in control and it's testable. */
export function tickLocal(last: Hlc | null, physicalNow: number, node: string): Hlc {
  const lastWall = last ? parseHlc(last).wall : 0;
  const lastCounter = last ? parseHlc(last).counter : 0;
  if (physicalNow > lastWall) return formatHlc(physicalNow, 0, node);
  return formatHlc(lastWall, lastCounter + 1, node);
}

/** Advance the clock on receiving a remote event, per the HLC merge rule:
 * take the max wall of local/remote/physical, and a counter that stays ahead
 * of whichever contributed that max. */
export function tickReceive(
  last: Hlc | null,
  remote: Hlc,
  physicalNow: number,
  node: string,
): Hlc {
  const l = last ? parseHlc(last) : { wall: 0, counter: 0 };
  const r = parseHlc(remote);
  const wall = Math.max(l.wall, r.wall, physicalNow);

  let counter: number;
  if (wall === l.wall && wall === r.wall) counter = Math.max(l.counter, r.counter) + 1;
  else if (wall === l.wall) counter = l.counter + 1;
  else if (wall === r.wall) counter = r.counter + 1;
  else counter = 0;

  return formatHlc(wall, counter, node);
}
