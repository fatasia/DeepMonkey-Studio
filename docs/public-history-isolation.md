# Public history isolation

The development repository keeps its existing Git history. It contains internal handoffs and older customer/project references that are not part of the public product. Rewriting the shared development history is not required for this release and would invalidate existing references.

## Release rule

Publish a **new repository** (or an orphan `public-main` branch copied to a new remote) from the reviewed release commit. Do not push the development `main` history to the public remote.

The export must omit:

- `docs/handoffs/`, `docs/reports/`, `docs/active-task-recovery-ledger.md`, and `docs/codex-*`;
- `test-output/`, `build-trial/`, `data/`, local API bundles, and `.env*` files;
- any customer/project data or machine-specific absolute paths.

## Reproducible export

Run this from a disposable clone. The commands create a new orphan branch and leave the source repository unchanged:

```powershell
$src = (Get-Location).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("bim-studio-public-" + [guid]::NewGuid())
git clone --no-local $src $tmp
Set-Location $tmp
git switch --orphan public-main
git rm -rf .
git archive main | tar -xf -
Remove-Item -Recurse -Force docs/handoffs, docs/reports, test-output, build-trial, data -ErrorAction SilentlyContinue
Remove-Item docs/active-task-recovery-ledger.md -ErrorAction SilentlyContinue
Get-ChildItem docs/codex-*.md -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem -Force -Filter '.env*' -ErrorAction SilentlyContinue | Remove-Item -Force
node scripts/verify-public-history.mjs
git add -A
git commit -m "chore: initialize public release history"
```

The first public push is then made to a new remote after a human review of the file list. The development remote and its history are left intact.

## Gate

`node scripts/verify-public-history.mjs` is read-only and fails on the known historical customer identifiers or machine paths in the exported tree. `node scripts/verify-public-history.mjs --history` is an audit of the current development history; matches there are expected until the public orphan export is created and must not be treated as evidence that the export is unsafe.

Record the public repository URL, source commit, export commit, file exclusion list, and verifier output in the release notes. Never copy `.git`, local caches, test evidence, private assets, or credentials into the public repository.
