/** Columns and rows for `n` camera tiles.
 *
 * The call window has a fixed height, so the grid has to divide that height
 * rather than derive it from tile width — a width-driven 16:9 tile overflows
 * the window the moment there are two rows of them. Callers pair this with
 * `minmax(0, 1fr)` tracks and `fit="fill"` tiles.
 *
 * Square-ish by preference (ceil(sqrt)), which keeps tiles as large as the
 * window allows: a single wide row of 3+ tiles in a landscape window makes
 * each one tall and narrow, which is worse than a filled second row.
 *
 * One exception: if one more column divides `n` exactly, take it, so counts
 * like 8 lay out as a full 4x2 instead of a 3x3 with a gap. Only when that
 * still leaves two rows — otherwise 3 would collapse to a 3x1 strip. */
export function tileGrid(n: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.floor(n) || 1);
  let cols = Math.ceil(Math.sqrt(count));
  if (count % cols !== 0 && count % (cols + 1) === 0 && count / (cols + 1) >= 2) {
    cols += 1;
  }
  return { cols, rows: Math.ceil(count / cols) };
}

/** Grid tracks for the container. Columns are doubled and every tile spans two
 * of them, which is what buys a half-column offset for centring a short last
 * row. Tile widths are unchanged by the split: a tile spans two sub-columns
 * plus the gap between them, which is exactly one full column. */
export function tileTracks(cols: number, rows: number): {
  gridTemplateColumns: string;
  gridTemplateRows: string;
} {
  return {
    gridTemplateColumns: `repeat(${cols * 2}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };
}

/** `grid-column` for the tile at `index`.
 *
 * A last row with fewer tiles than columns reads as a broken layout when it's
 * left-aligned against an empty cell, so it gets centred instead. Only the
 * first tile of that row needs an explicit start — auto-placement lays the
 * rest of the row out after it. */
export function tileColumn(index: number, n: number, cols: number): string {
  const remainder = n % cols;
  const startsShortRow = remainder !== 0 && index === n - remainder;
  return startsShortRow ? `${1 + (cols - remainder)} / span 2` : "auto / span 2";
}
