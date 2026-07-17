// Idle self-cleanup smoke test: spawn the CLI with a 3-second idle timeout
// (0.05 min) and no client ever connecting; the process must log the idle
// shutdown and exit 0 on its own. Requires network (real DHT bootstrap).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.execPath,
  [join(pkgRoot, 'src', 'cli.js'), '--secret', 'idle-smoke-secret-123', '--idle-timeout', '0.05'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const killer = setTimeout(() => {
  console.error('FAIL: bridge did not idle-exit within 30s');
  console.error(out);
  child.kill('SIGKILL');
  process.exit(1);
}, 30000);

child.on('exit', (code) => {
  clearTimeout(killer);
  if (code === 0 && /idle self-cleanup/.test(out) && /shutting down/.test(out)) {
    console.log('PASS: idle self-cleanup fired, process exited 0');
    process.exit(0);
  }
  console.error(`FAIL: exit code ${code}; output:\n${out}`);
  process.exit(1);
});
