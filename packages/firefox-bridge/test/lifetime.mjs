// Hard lifetime cap smoke test: spawn the CLI with idle timer disabled and a
// 3-second max lifetime (0.05 min); the process must log the lifetime shutdown
// and exit 0 on its own even though nothing is "idle-detected".
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.execPath,
  [join(pkgRoot, 'src', 'cli.js'), '--secret', 'lifetime-smoke-secret-123', '--idle-timeout', '0', '--max-lifetime', '0.05'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const killer = setTimeout(() => {
  console.error('FAIL: bridge did not lifetime-exit within 30s');
  console.error(out);
  child.kill('SIGKILL');
  process.exit(1);
}, 30000);

child.on('exit', (code) => {
  clearTimeout(killer);
  if (code === 0 && /max lifetime/.test(out) && /shutting down/.test(out)) {
    console.log('PASS: max-lifetime cap fired, process exited 0');
    process.exit(0);
  }
  console.error(`FAIL: exit code ${code}; output:\n${out}`);
  process.exit(1);
});
