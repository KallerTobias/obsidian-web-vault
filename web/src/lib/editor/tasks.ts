/** `- [ ] `, `* [x] `, `+ [X] `, `1. [ ] `, `2) [ ] ` (also inside block quotes): prefix up to the box character. */
const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\]/;

/**
 * The change that ticks/unticks the task item on 0-based `line` of `text`, or `null` when that line is
 * no `[ ]`/`[x]` task item. Line endings (CRLF) are untouched: only the box character changes.
 */
export function taskToggle(text: string, line: number): { from: number; to: number; insert: string } | null {
  if (!Number.isInteger(line) || line < 0) return null;
  let start = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  const end = text.indexOf('\n', start);
  const m = TASK.exec(text.slice(start, end < 0 ? text.length : end));
  if (!m) return null;
  const from = start + m[1]!.length;
  return { from, to: from + 1, insert: m[2] === ' ' ? 'x' : ' ' };
}
