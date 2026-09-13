# Open-source readiness

Last updated: 2026-09-12.

This document tracks repository publication readiness. It is a release gate, not a statement that every experimental subsystem is production-ready.

## Current audit

- The reachable Git object database is small: approximately 9.6 MiB across 220 commits at the time of this audit.
- `.env`, rotated local environment files, local certificates/private keys, browser profiles, `node_modules`, build output, Rust targets, and `test-output` are ignored and were not found as tracked paths in the currently reachable refs.
- One unused 1.5 MiB brand backup image and two related backup assets were removed from the current tree. They remain in historical commits until a coordinated publication rewrite is explicitly performed.
- Deep Engine and Deep Engine Native are new isolated packages; production applications contain no runtime import of them yet.
- The repository now has an Apache-2.0 license, contribution guide, security policy, code of conduct, changelog, issue templates, pull-request template, line-ending rules, and focused Deep Engine CI.

## Required before making the repository public

1. Run a full secret scan across every ref and inspect all findings, including historical binary blobs.
2. Audit every redistributed model, image, font, shader sample, and generated asset. Keep source URL, exact license, modification status, and attribution next to each asset.
3. Confirm that optional proprietary SDK integrations contain no vendor binaries, confidential headers, customer data, or redistributable output that violates their terms.
4. Review brand and trademark assets separately from the Apache-2.0 source license.
5. Make the focused CI workflows green on clean Linux and Windows runners.
6. Remove obsolete handoff logs, temporary verification documents, duplicate screenshots, and local-only scripts from the publication branch.
7. Re-run dependency license and vulnerability audits for JavaScript, Rust, Python, .NET, and bundled native tools.
8. Freeze a first public release scope and publish only verified capability and benchmark claims.

## History cleanup policy

Do not rewrite history merely to make the commit graph look shorter. Use ordinary removal commits for harmless generated files and outdated documentation. Rewrite published history only for exposed secrets, legally non-redistributable content, personal/customer data, or binary objects large enough to materially harm cloning.

If a rewrite becomes necessary:

1. create an offline mirror backup;
2. record the exact object IDs and removal rules;
3. use `git filter-repo` in a disposable mirror;
4. repeat secret, license, size, and checkout verification on the rewritten repository;
5. coordinate the force-push and require every contributor to re-clone.

No full history rewrite was performed by this audit because current evidence does not justify its collaboration cost.
