export interface DiffLine {
  /** `mine`: only in my text; `disk`: only in the disk text. */
  type: 'same' | 'mine' | 'disk';
  text: string;
}

/** Above this many cells (changed lines mine × disk) the middle is shown as replaced en bloc. */
const LCS_LIMIT = 4_000_000;

const lines = (text: string) => text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

/** Line diff of two texts (longest common subsequence after trimming the common start and end). */
export function lineDiff(mine: string, disk: string): DiffLine[] {
  const a = lines(mine);
  const b = lines(disk);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > LCS_LIMIT) {
    for (const text of midA) out.push({ type: 'mine', text });
    for (const text of midB) out.push({ type: 'disk', text });
  } else {
    // lcs[i][j]: length of the LCS of midA[i..] and midB[j..], flattened.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ type: 'same', text: midA[i]! });
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) out.push({ type: 'mine', text: midA[i++]! });
      else out.push({ type: 'disk', text: midB[j++]! });
    }
  }
  for (const text of a.slice(endA)) out.push({ type: 'same', text });
  return out;
}
