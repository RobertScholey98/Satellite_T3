export const factoryExecutionProbe = String.raw`
const { spawn } = require('node:child_process');
const child = spawn('codex', ['app-server', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'], { stdio: ['pipe', 'pipe', 'pipe'] });
let pending = '';
let stderr = '';
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 20000);
const checks = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('/runtime/boundary-probe', 'allowed');",
  "for (const path of ['/workspace/boundary-probe', '/workflow/boundary-probe', '/usr/boundary-probe']) { let denied = false; try { fs.writeFileSync(path, 'forbidden'); } catch (e) { denied = ['EROFS','EACCES','EPERM'].includes(e.code); } if (!denied) throw new Error('write boundary failed'); }",
  "for (const path of ['/var/run/docker.sock', '/root/.codex', '/root/.ssh', '/host']) { if (fs.existsSync(path)) throw new Error('unexpected host authority'); }",
  "for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AZURE_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY']) { if (process.env[key]) throw new Error('ambient credential'); }",
  "console.log('factory-boundary-ok');"
].join('\n');
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  pending += chunk;
  for (;;) {
    const index = pending.indexOf('\n');
    if (index < 0) break;
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      if (message.error) { child.kill(); process.exitCode = 1; break; }
      child.stdin.write(JSON.stringify({ id: 2, method: 'command/exec', params: { command: ['node', '-e', checks], cwd: '/workspace', sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } } }) + '\n');
    }
    if (message.id === 2) {
      const result = message.result;
      if (!message.error && result?.exitCode === 0 && result.stdout.includes('factory-boundary-ok')) console.log('factory-boundary-ok');
      else process.exitCode = 1;
      child.stdin.end();
      child.kill();
    }
  }
});
child.on('exit', () => { clearTimeout(timer); });
child.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'satellite_factory_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
`;
