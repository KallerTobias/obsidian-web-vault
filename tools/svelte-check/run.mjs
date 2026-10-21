// Type-checks the .svelte files (`npm run check:svelte`).
//
// svelte-check drives TypeScript through its JS API, which TypeScript 7 (the project's compiler)
// no longer offers; svelte-check 4 requires TypeScript 5 or 6. npm cannot install a second
// TypeScript for one package's peer dependency next to v7, so this folder is a separate npm
// project with its own lockfile: svelte-check 4.7.7 + TypeScript 6.0.3. It is installed on first
// use (and again when its lockfile changes) and checks `web/` with `web/tsconfig.json`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const lock = join(here, 'package-lock.json');
const stamp = join(here, 'node_modules', '.installed-lock');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;

const lockText = readFileSync(lock, 'utf8');
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== lockText) {
  if (run(npm, ['ci', '--no-audit', '--no-fund', '--loglevel=error'], here) !== 0) process.exit(1);
  writeFileSync(stamp, lockText);
}

const bin = join(here, 'node_modules', 'svelte-check', 'bin', 'svelte-check');
// --tsconfig is resolved against --workspace.
process.exit(
  run(process.execPath, [bin, '--workspace', 'web', '--tsconfig', './tsconfig.json', '--fail-on-warnings', ...process.argv.slice(2)], root),
);
