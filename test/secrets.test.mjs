import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { scanText } from '../scripts/scan-secrets.mjs';
const token = ['npg', 'notARealCredential12345'].join('_');
const scanner = resolve('scripts/scan-secrets.mjs');
test('detects credential in README or env backup and does not return the value', () => {
  const result = scanText(`DATABASE_URL=postgresql://owner:${token}@db.example/db`);
  assert.equal(result.length, 2); assert(!JSON.stringify(result).includes(token));
  assert.equal(scanText('postgresql://user:your-password@host/db').length, 0);
});
test('rejects staged secret even when working file was cleaned; accepts staged safe data despite unstaged secret', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'secret-scan-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio:'pipe' });
  git('init', '-q'); mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs/README.md'),token); writeFileSync(join(cwd,'.env.local.bak'),'value='+token);
  git('add', '.'); writeFileSync(join(cwd,'docs/README.md'),'safe'); writeFileSync(join(cwd,'.env.local.bak'),'safe');
  let r = spawnSync(process.execPath, [scanner,'--staged'], { cwd, encoding:'utf8' });
  assert.equal(r.status,1); assert(r.stderr.includes('docs/README.md')); assert(r.stderr.includes('.env.local.bak')); assert(!r.stderr.includes(token));
  git('add','.'); writeFileSync(join(cwd,'docs/README.md'),token);
  r = spawnSync(process.execPath,[scanner,'--staged'],{cwd,encoding:'utf8'}); assert.equal(r.status,0);
  r = spawnSync(process.execPath,[scanner,'--tracked'],{cwd,encoding:'utf8'}); assert.equal(r.status,1); assert(!r.stderr.includes(token));
});
