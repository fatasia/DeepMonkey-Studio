# Contributing to Deep Monkey Studio

Thanks for helping improve Deep Monkey Studio. A few things to know before you start.

## Before you write code

- Search existing Issues, Pull Requests, and the [documentation index](docs/README.md) to avoid duplicating work.
- Open an Issue first for anything big: new features, public contract changes, migrations, new dependencies, or changes to stored data. Small bug fixes and doc corrections can go straight to a Pull Request.
- One Pull Request, one coherent change. Leave unrelated edits in the branch alone.
- Security problems go through the private process in [SECURITY.md](SECURITY.md), not a public Issue.

## Setup

See the [developer guide](docs/development.md) for the repository map and a first contribution walkthrough. Product documentation follows the [documentation guide](docs/documentation.md).

Node.js 24 and pnpm 11.18.0:

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web
```

## What a good Pull Request looks like

- Matches the architecture, naming, error handling, and test style of the surrounding module.
- Tests updated when behavior, contracts, error handling, persistence, or security boundaries change.
- Docs updated in the same Pull Request as the code they describe.
- A short entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything user-visible: behavior, public contracts, deployment, deprecations.
- New dependencies, models, fonts, icons, or external assets recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when their license requires attribution.
- No credentials, private keys, customer data, logs, or database dumps. Ever.
- A Conventional Commit style title, e.g. `fix(viewer): release stale GPU resources`.

## Verification

Run the smallest relevant checks while developing, then the full set before requesting review:

```bash
pnpm gate:repository
pnpm typecheck
pnpm test
pnpm build
```

Browser, GPU, asset, data, and release changes have additional `gate:*` scripts — check the root `package.json` for the ones that apply. List the commands you ran and their outcomes in the Pull Request, and don't mark an unrun check as passed.

Maintainers may ask for a smaller change, stronger evidence, or a design note under `docs/` when the decision affects future contributors.

## Review and follow-up

Open a draft Pull Request if you need early feedback. Before requesting review, complete the template and link the original Issue when there is one. Keep review discussions tied to the current diff and rerun affected checks after changes.

The [maintainers](MAINTAINERS.md) decide whether a change is ready under [GOVERNANCE.md](GOVERNANCE.md). After merge, the [changelog](CHANGELOG.md) and release notes track delivery; merge alone does not mean an installable release is available. For questions, use [SUPPORT.md](SUPPORT.md).

## Contribution certification

By submitting a contribution, you certify that you created it or have the right to submit it; that it does not knowingly include undisclosed third-party material, confidential information, or credentials; and that you license your copyrightable contribution under [DMCSL-1.0](LICENSE) as described in Section 7 of the license. You retain copyright in your contribution unless a separate written agreement says otherwise.

If your employer or another party may own the contribution, obtain authorization before submitting it.
