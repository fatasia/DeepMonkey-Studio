# Public source readiness

Last reviewed: 2026-09-16. Release evidence must be collected again for the revision being published.

This document tracks repository publication readiness. It is a release gate, not a statement that every experimental subsystem is production-ready.

## Current audit

- Historical repository-size observations are not current release evidence. Measure reachable refs and distributed artifacts for the selected release revision.
- The repository gate checks tracked paths for local configuration, credentials and generated output. A passing result covers the current tree, not every historical blob or external artifact.
- Historical asset removal does not prove that all reachable revisions are safe to publish. Complete the history and redistribution review for the selected release.
- Studio integrates Deep WebGPU as a selectable backend. Deep Native remains a separate delivery target with its own capability and verification requirements.
- The project license is [Deep Monkey Community Source License 1.0](../LICENSE), identified as `LicenseRef-Deep-Monkey-Community-1.0`. The project is source-available. Contribution, governance, security, conduct and release policies are linked from the [documentation index](README.md).

## Required before making the repository public

1. Run a full secret scan across every ref and inspect all findings, including historical binary blobs.
2. Audit every redistributed model, image, font, shader sample, and generated asset. Keep source URL, exact license, modification status, and attribution next to each asset.
3. Confirm that optional proprietary SDK integrations contain no vendor binaries, confidential headers, customer data, or redistributable output that violates their terms.
4. Review brand and trademark assets separately from the project source license.
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

Track publication evidence with the [release checklist](open-source-release-checklist.md). Repository host settings and full-history findings require separate verification.
