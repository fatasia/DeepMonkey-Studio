# Public source release checklist

This checklist prepares Deep Monkey Studio for a public repository. The license is source-available rather than OSI-approved open source; public descriptions must preserve that distinction.

## Ownership and licensing

- [ ] Confirm the legal name of the project owner and the copyright ownership or authorization for every first-party component.
- [ ] Have counsel review DMCSL-1.0 in the jurisdictions where enforcement matters, especially the definitions and evidence thresholds for Organization, Covered Misconduct, Affiliate, Restricted Use, and Covered Product.
- [ ] Verify every dependency, model, font, icon, sample, and bundled asset has redistribution rights and accurate attribution in `THIRD_PARTY_NOTICES.md`.
- [ ] Run `pnpm audit:licenses`; review and document any newly reported incomplete, ambiguous, or reciprocal license before release.
- [ ] Remove material that cannot be publicly redistributed, including proprietary SDKs, customer models, licensed datasets, and vendor binaries.
- [ ] Confirm README, package metadata, release artifacts, and repository topics say `source-available` rather than claiming OSI approval.

## Secrets and data

- [ ] Scan the complete Git history, tags, release artifacts, CI logs, LFS objects, and mirrors for credentials, certificates, tokens, private endpoints, production data, customer data, and personal information.
- [ ] Revoke and rotate every secret that has ever entered a commit or published artifact; deletion from the latest tree is insufficient.
- [ ] Confirm `.env`, local certificates, logs, screenshots, databases, uploaded assets, generated builds, and test outputs are ignored and absent from tracked files.
- [ ] Replace real infrastructure values with safe `.env.example` placeholders and reproducible local fixtures.

## Repository controls

- [ ] Run `pnpm gate:repository`, the complete release verification, and all platform-specific gates required for published artifacts.
- [ ] Enable protected default branches, required Pull Request reviews, required `repository-governance` checks, blocked force pushes, and two-factor authentication for maintainers.
- [ ] Enable secret scanning with push protection, dependency alerts, automated dependency updates, code scanning, and private vulnerability reporting.
- [ ] Configure issue labels, Discussions, release permissions, and least-privilege CI tokens.
- [ ] Verify Issue and Pull Request templates render correctly in the public host.

## Release quality

- [ ] Define the supported platforms and honest capability limits for the first public release.
- [ ] Build from a clean clone using only documented prerequisites.
- [ ] Verify installation, upgrade, rollback, backup, restore, sample data, and uninstall flows.
- [ ] Generate checksums and a software bill of materials for every distributed artifact.
- [ ] Create a signed `vMAJOR.MINOR.PATCH` tag and release notes from `CHANGELOG.md`.
- [ ] Confirm the release contains `LICENSE`, `LICENSE.zh-CN.md`, `LICENSING.md`, and `THIRD_PARTY_NOTICES.md`.
