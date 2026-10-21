/**
 * Whether `name` may be used for a new note or folder. Same rule as the server: `# ^ [ ] |` break wiki links
 * (`[[Plan #2]]` = heading "2"), `\ : * ? " < > |` are invalid on Windows/macOS, `/` would be a path.
 */
export function isValidNoteName(name: string): boolean {
  const n = name.trim();
  return n !== '' && !n.startsWith('.') && !/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f-\u009f]/.test(n);
}
