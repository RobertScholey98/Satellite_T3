export const factoryVolumeHelper = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (fs.existsSync('/authority/revoked.json')) throw Error('revoked execution');
if (fs.existsSync('/authority/incidents') && fs.readdirSync('/authority/incidents').length > 0) throw Error('incident execution hold');
if (fs.existsSync('/authority/suspension.json') && JSON.parse(fs.readFileSync('/authority/suspension.json', 'utf8')).state !== 'resumed') throw Error('suspended execution');
if (fs.existsSync('/authority/delivery-hold.json') && JSON.parse(fs.readFileSync('/authority/delivery-hold.json', 'utf8')).state === 'held') throw Error('delivery flow hold');
function safe(name) {
  if (typeof name !== 'string' || name.length > 1024 || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw Error('unsafe path');
  const target = '/workspace/' + name;
  let current = '/workspace';
  for (const part of name.split('/')) {
    if (fs.existsSync(current) && fs.readdirSync(current).some(entry => entry !== part && entry.toLowerCase() === part.toLowerCase())) throw Error('case alias');
    current += '/' + part;
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw Error('unsafe entry');
    }
  }
  return target;
}
function parent(target) {
  const directory = path.dirname(target);
  if (!fs.existsSync(directory)) {
    parent(directory);
    fs.mkdirSync(directory, { mode: 0o755 });
  }
}
function collect(directory, prefix = '') {
  const files = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const relative = prefix + name;
    const target = safe(relative);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) files.push(...collect(target, relative + '/'));
    else {
      if (stat.size > 16 * 1024 * 1024) throw Error('file size limit');
      const bytes = fs.readFileSync(target);
      if (bytes.length > 16 * 1024 * 1024) throw Error('file size limit');
      files.push({ path: relative, content: bytes.toString('base64'), digest: crypto.createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o111 ? '100755' : '100644' });
    }
  }
  return files;
}
if (input.kind === 'initialize') {
  if (fs.readdirSync('/workspace').length) throw Error('volume is not empty');
  for (const file of input.files) {
    const target = safe(file.path);
    parent(target);
    const mode = file.mode === '100755' ? file.writable ? 0o777 : 0o555 : file.writable ? 0o666 : 0o444;
    fs.writeFileSync(target, Buffer.from(file.content, 'base64'), { flag: 'wx', mode });
    fs.chmodSync(target, mode);
  }
  fs.chmodSync('/workspace', 0o755);
  console.log('initialized');
} else if (input.kind === 'mutate') {
  const operation = input.operation;
  const target = safe(operation.path);
  if (!/^[a-f0-9-]{36}$/.test(input.commandId)) throw Error('invalid command');
  const receiptPath = '/journal/' + input.commandId + '.json';
  const completeReceipt = receipt => {
    const temporary = receiptPath + '.' + crypto.randomUUID();
    fs.writeFileSync(temporary, JSON.stringify({ ...receipt, complete: true }), { flag: 'wx', flush: true });
    fs.renameSync(temporary, receiptPath);
  };
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const fileDigest = target => fs.existsSync(target) ? digest(fs.readFileSync(target)) : null;
  const destination = operation.kind === 'rename' ? safe(operation.to) : null;
  let receipt;
  if (fs.existsSync(receiptPath)) {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.request !== input.request) throw Error('command conflict');
    if (receipt.complete) { console.log('mutated'); process.exit(0); }
    const finished = operation.kind === 'delete' ? !fs.existsSync(target) : operation.kind === 'rename' ? !fs.existsSync(target) && fileDigest(destination) === receipt.before : fileDigest(target) === receipt.after;
    if (finished) {
      completeReceipt(receipt);
      console.log('mutated'); process.exit(0);
    }
    if (fileDigest(target) !== receipt.before || (destination !== null && fs.existsSync(destination))) throw Error('uncertain mutation outcome');
  } else {
    const before = fileDigest(target);
    if ((operation.kind === 'create') !== (before === null) || (destination !== null && fs.existsSync(destination))) throw Error('mutation precondition changed');
    receipt = { request: input.request, before, after: 'content' in operation ? digest(Buffer.from(operation.content, 'base64')) : null, complete: false };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx', flush: true });
  }
  if (operation.kind === 'create') {
    parent(target);
    fs.writeFileSync(target, Buffer.from(operation.content, 'base64'), { flag: 'wx', mode: 0o666 });
    fs.chmodSync(target, 0o666);
  } else if (operation.kind === 'write') {
    if (!fs.lstatSync(target).isFile()) throw Error('not a file');
    fs.writeFileSync(target, Buffer.from(operation.content, 'base64'));
  } else if (operation.kind === 'delete') {
    if (!fs.lstatSync(target).isFile()) throw Error('not a file');
    fs.unlinkSync(target);
  } else if (operation.kind === 'rename') {
    if (!fs.lstatSync(target).isFile() || fs.existsSync(destination)) throw Error('invalid rename');
    parent(destination);
    fs.renameSync(target, destination);
  } else throw Error('unknown mutation');
  completeReceipt(receipt);
  console.log('mutated');
} else if (input.kind === 'capture') {
  const files = collect('/workspace');
  if (files.reduce((size, file) => size + file.content.length, 0) > 350 * 1024 * 1024) throw Error('snapshot size limit');
  console.log(JSON.stringify({ files, digest: crypto.createHash('sha256').update(JSON.stringify(files.map(({ path, digest, mode }) => ({ path, digest, mode })))).digest('hex') }));
} else throw Error('unknown operation');
`;
