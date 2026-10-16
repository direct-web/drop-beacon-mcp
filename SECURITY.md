# Security

Report vulnerabilities privately to direct@edc4me.com. Never put passwords, tokens, or full database URLs in an issue, directory listing, support attachment, or terminal output.

The public MCP uses fixed, read-only catalog API endpoints with no database credentials. Existing secrets must be removed from host configuration separately when upgrading; new code does not consume them.

Run `npm run security:scan` before sharing code. The scanner checks **all tracked text files**, including Markdown, lockfiles, dotfiles and environment backups. Reports contain path, line, rule and `[REDACTED]` only. It does not inspect binary files, untracked files or Git history and cannot detect every kind of secret. Passing is not proof that a repository contains no sensitive material.

To enable the staged-file guard in a new clone:

```sh
node scripts/install-secret-hook.mjs
```

The installer refuses to replace an existing hook or custom hooks path; preserve and chain your existing guard in that case. The hook scans staged blobs, so cleaning a working file without staging the fix cannot bypass it. CI also scans tracked files and must pass before publishing. `.env*` and backups are ignored; only credential-free `.env.example` / `.env.*.example` templates are exceptions.

If a credential is exposed, revoke it, verify the old value no longer authenticates, identify affected consumers, remove public copies, and investigate retained access records. History rewriting is a separate coordinated operation and never substitutes for revocation.
