# Contributing to Deep Monkey Studio

Thank you for improving Deep Monkey Studio. This repository accepts focused, reviewable changes with evidence that the behavior works.

## Before starting

1. Search existing? existing Issues, Pull Requests, [specifications](docs/specs), and the [active task ledger](docs/active-task-recovery-ledger.md) before duplicating work.
2. Open an Issue for a major feature, public contract change, migration, new dependency, or behavior that affects stored data. A small bug fix or documentation correction may go directly to a Pull Request.
3. Read [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), and [LICENSING.md](LICENSING.md). Report vulnerabilities privately rather than opening a public Issue.
4. Keep one Pull Request focused on one coherent outcome. Preserve unrelated work already present in the branch.

## Development setup

The repository requires Node.js 24 and pnpm 11.18.0.

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web
```

Use `pnpm studio start client` for the Windows desktop development client. See [README.md](README.md) for deployment and service details.

## Change requirements

- Match the architecture, naming, error handling, and test style in the surrounding module.
- Update tests when behavior, contracts, error handling, persistence, or security boundaries change.
- Update user and operator documentation in the same Pull Request as the implementation.
- Add a concise entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-visible behavior, public contracts, deployment changes, deprecations, and governance changes.
- Record every new or changed dependency, model, font, icon, or external asset in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when its license or attribution requires it.
- Never commit credentials, private keys, certificates, production data, customer assets, logs, database dumps, or login screenshots.
- Use short Conventional Commit style titles for Pull Requests, for example `fix(viewer): release stale GPU resources` or `docs: clarify deployment prerequisites`.

## Verification

Run the smallest relevant checks while developing, then run the complete checks required by the affected area before requesting review.

```bash
pnpm gate:repository
pnpm typecheck
pnpm test
pnpm build
```

Browser, GPU, asset, data, or release changes also require the applicable `gate:*` command from the root or workspace `package.json`. Include the commands and outcomes in the Pull Request. Do not mark an unrun check as passed.

## Pull Request review

A Pull Request is ready to merge when:

- the problem and resulting behavior are clear;
- the diff contains no unrelated refactor or generated noise;
- required tests and repository gates pass;
- documentation and the changelog are current;
- security, privacy, migration, rollback, dependency, and license effects are disclosed;
- review comments are resolved; and
- a maintainer approves the final diff.

Maintainers may ask for a smaller change, stronger evidence, or a design note under `docs/specs/` when the decision will affect future contributors.

## Contribution certification

By submitting a contribution, you certify that you created it or have the right to submit it; that it does not knowingly include undisclosed third-party material, confidential information, or credentials; and that you license your copyrightable contribution under [DMCSL-1.0](LICENSE) as described in Section 7 of the license. You retain copyright in your contribution unless a separate written agreement says otherwise.

If your employer or another party may own the contribution, obtain authorization before submitting it.
