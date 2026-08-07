/** Columns and rows for `n` camera tiles.
 *
 * The call window has a fixed height, so the grid has to divide that height
 * rather than derive it from tile width — a width-driven 16:9 tile overflows
 * the window the moment there are two rows of them. Callers pair this with
 * `minmax(0, 1fr)` tracks and `fit="fill"` tiles.
 *
 * Square-ish by preference (ceil(sqrt)), which gives the usual 1, 2, 2x2,
 * 3x2 progression and keeps tiles as large as the window allows. */
export function tileGrid(n: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.floor(n) || 1);
  const cols = Math.ceil(Math.sqrt(count));
  return { cols, rows: Math.ceil(count / cols) };
}
