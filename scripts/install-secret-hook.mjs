#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const git = args => execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const root=git(['rev-parse','--show-toplevel']);
const common=resolve(git(['rev-parse','--git-common-dir']));
let custom='';try{custom=git(['config','--get','core.hooksPath']);}catch{}
if(custom)throw new Error('Existing core.hooksPath detected; preserve and chain that hook manually.');
const hooks=join(common,'hooks');mkdirSync(hooks,{recursive:true});
const target=join(hooks,'pre-commit');
const marker='# Drop Beacon redacted staged-secret guard';
if(existsSync(target) && !readFileSync(target,'utf8').includes(marker))throw new Error('Existing pre-commit hook detected; preserve and chain it manually.');
copyFileSync(join(root,'scripts/scan-secrets.mjs'),join(hooks,'drop-beacon-scan-secrets.mjs'));
writeFileSync(target,`#!/bin/sh\n${marker}\ncommon=$(git rev-parse --git-common-dir) || exit 2\nexec node "$common/hooks/drop-beacon-scan-secrets.mjs" --staged\n`);
chmodSync(target,0o755);
console.log('Installed redacted staged-secret guard for this repository and its worktrees. Existing hooks were not overwritten.');
