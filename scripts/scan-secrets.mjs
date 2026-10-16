#!/usr/bin/env node
// Deliberately never prints matching lines, secret values, or subprocess stderr.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const git = (args) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const placeholder = v => /^(?:password|passwd|changeme|placeholder|example|your[-_].*|<[^>]+>|\$\{[^}]+\})$/i.test(v);
export function scanText(text) {
  const findings = [];
  const rules = [
    ['postgres-password', /postgres(?:ql)?:\/\/[^\s:@/"'<>]+:([^@\s/"']+)@/gi, m => !placeholder(m[1])],
    ['neon-password', /\bnpg_[A-Za-z0-9]{12,}\b/g],
    ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
    ['service-api-key', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=]{32,}/g],
  ];
  for (const [rule, pattern, accept] of rules) {
    for (const match of text.matchAll(pattern)) {
      if (accept && !accept(match)) continue;
      findings.push({ rule, line: 1 + text.slice(0, match.index).split('\n').length - 1 });
    }
  }
  return findings;
}
export function main(mode) {
  if (!['--staged', '--tracked'].includes(mode)) throw new Error('Use --staged or --tracked');
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  process.chdir(root);
  const staged = mode === '--staged';
  const names = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']).toString().split('\0').filter(Boolean);
  let total = 0, scanned = 0;
  for (const name of new Set(names)) {
    let bytes;
    if (staged) bytes = git(['show', `:${name}`]);
    else {
      let stat; try { stat = lstatSync(name); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      if (!stat.isFile()) continue;
      bytes = readFileSync(name);
    }
    // Ordinary binary assets aren't a secret-store scan; documentation, lockfiles,
    // dotfiles and environment backups are never skipped by extension.
    if (bytes.includes(0)) continue;
    scanned++;
    for (const f of scanText(bytes.toString('utf8'))) {
      console.error(`${JSON.stringify(name)}:${f.line}: ${f.rule} [REDACTED]`);
      total++;
    }
  }
  if (total) { console.error(`Blocked: ${total} credential-like match(es). Remove/revoke the credential; values were not logged.`); return 1; }
  console.log(`Secret scan passed: ${scanned} text files (${staged ? 'staged snapshots' : 'tracked working files'}).`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv[2]); }
  catch { console.error('Secret scan failed to read the requested Git snapshot. Blocking instead of skipping.'); process.exitCode = 2; }
}
