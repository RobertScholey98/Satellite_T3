import * as Schema from "effect/Schema";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function factoryWritableProbe(sourcePath: string, protectedPath: string): string {
  const checks = [
    "const fs = require('node:fs'); const {spawnSync} = require('node:child_process');",
    "if (process.getuid() === 0) throw Error('root worker');",
    `const source = ${json(`/workspace/${sourcePath}`)}; const protectedFile = ${json(`/workspace/${protectedPath}`)};`,
    "const original = fs.readFileSync(source); fs.appendFileSync(source, '\\n'); fs.writeFileSync(source, original);",
    "function denied(run) { let failed = false; try { run(); } catch (e) { failed = ['EROFS', 'EACCES', 'EPERM'].includes(e.code); } if (!failed) throw Error('boundary escape'); }",
    "denied(() => fs.appendFileSync(protectedFile, 'forbidden'));",
    "denied(() => fs.chmodSync(protectedFile, 0o666));",
    "denied(() => fs.unlinkSync(protectedFile));",
    "denied(() => fs.renameSync(source, source + '.moved'));",
    "for (const path of ['/workspace/.factory-probe', require('node:path').dirname(source) + '/__factory_nested.config.js', '/workflow/.factory-probe', '/controls/.factory-probe', '/usr/.factory-probe']) denied(() => fs.writeFileSync(path, 'forbidden'));",
    "denied(() => fs.symlinkSync('/controls', '/workspace/escape')); denied(() => fs.linkSync(protectedFile, '/workspace/hardlink'));",
    "const skill = fs.readdirSync('/workflow/skills', {recursive:true, withFileTypes:true}).find(entry => entry.isFile()); if(skill) denied(() => fs.appendFileSync(require('node:path').join(skill.parentPath, skill.name), 'forbidden'));",
    "for (const path of ['/var/run/docker.sock', '/root/.codex', '/root/.ssh', '/host']) if(fs.existsSync(path)) throw Error('host authority exposed');",
    "for (const key of ['GH_TOKEN','GITHUB_TOKEN','AZURE_CLIENT_SECRET','AWS_SECRET_ACCESS_KEY']) if(process.env[key]) throw Error('ambient credential');",
    'const nested = spawnSync(\'node\', [\'-e\', \'const f=require("node:fs");try{f.writeFileSync("/workspace/nested.config.js","bad");process.exit(1)}catch(e){if(!["EACCES","EROFS","EPERM"].includes(e.code))process.exit(1)}\']); if(nested.status !== 0) throw Error(\'nested boundary escape\');',
    "console.log('factory-writable-boundary-ok');",
  ].join("\n");
  return String.raw`
const { spawn } = require('node:child_process');
const child = spawn('codex', ['app-server', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'], { stdio: ['pipe','pipe','pipe'] });
let pending = '';
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 20000);
child.stderr.resume();
child.stdout.on('data', chunk => {
  pending += chunk;
  for (;;) {
    const index = pending.indexOf('\n'); if (index < 0) break;
    const line = pending.slice(0,index); pending = pending.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      if (message.error) { child.kill(); process.exitCode = 1; break; }
      child.stdin.write(JSON.stringify({ id: 2, method: 'command/exec', params: { command: ['node','-e',${json(checks)}], cwd: '/workspace', sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } } }) + '\n');
    }
    if (message.id === 2) {
      if (!message.error && message.result?.exitCode === 0 && message.result.stdout.includes('factory-writable-boundary-ok')) console.log('factory-writable-boundary-ok');
      else { console.error(message.result?.stderr ?? 'command failed'); process.exitCode = 1; }
      child.stdin.end(); child.kill();
    }
  }
});
child.on('exit', () => clearTimeout(timer));
child.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'satellite_factory_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
`;
}
