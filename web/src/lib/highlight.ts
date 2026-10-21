export interface Segment {
  text: string;
  mark: boolean;
}

/** Splits `text` at the `[start, end)` ranges (sorted, may be out of bounds) into plain and marked parts. */
export function segments(text: string, ranges: readonly [number, number][]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    const start = Math.max(at, Math.min(from, text.length));
    const end = Math.min(to, text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
