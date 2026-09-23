# Licensing guide

Deep Monkey Studio is licensed under the **MIT License with Ethical Restrictions** ([LICENSE](LICENSE), identifier `DMS-MIT-ER-1.0`): the MIT license text (Part 1) plus an additional ethical-restrictions section (Part 2) that withholds and terminates the license for organizations committing or conspiring in severe human rights abuses — forced labor, child labor, systematic employment discrimination, and war-crime association — as informed by the UN Guiding Principles on Business and Human Rights (UNGP) and ILO fundamental conventions. The wording follows the approach of the Hippocratic License 3.0 but keeps the MIT text as the operative grant.

This guide is explanatory. The English [LICENSE](LICENSE) controls. The Chinese [LICENSE.zh-CN.md](LICENSE.zh-CN.md) is a translation and still describes the predecessor license (`DMCSL-1.0`) pending update; where it conflicts with the English text, the English text governs.

## What applies to what

| Tier | Scope | License |
|---|---|---|
| First-party code | All first-party applications, packages, tools, scripts, and documentation in this repository unless a file states otherwise | MIT License + Ethical Restrictions (`DMS-MIT-ER-1.0`) |
| First-party assets | Original assets shipped in this repository (models, images, fonts stored in-repo) | MIT License + Ethical Restrictions unless the asset or an adjacent file states a different license |
| Third-party assets | Models, sample scenes, textures, fonts, and packs obtained from external sources | Each asset keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the license file stored next to the asset |
| Third-party dependencies | npm, Cargo, and other dependencies | Their own licenses; inventoried by `pnpm audit:licenses` into [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

Third-party licenses are never modified or subsumed by this repository's license. If an asset is incompatible with redistribution, it must not enter the repository.

## Usage matrix

| User and use | Permission |
|---|---|
| Any person or organization that does not commit, conspire in, or materially assist a Covered Violation (LICENSE Part 2.2) | Full MIT permissions: use, modify, distribute, sublicense, commercial use, closed-source derivatives |
| An organization committing or conspiring in severe human rights abuses as defined in LICENSE Part 2.2 (forced labor, child labor, systematic discrimination, war-crime association, or comparable severe UNGP violations) | No permission for any purpose; rights terminate automatically with no cure period |
| Any person exercising permissions for the benefit of such an organization | Prohibited, including via affiliates, contractors, or intermediaries |

Unlike the predecessor `DMCSL-1.0`, the restriction scope is now limited to severe human rights violations. Ordinary commercial use, lawful competition, lawful employment practices, and internal business use are unrestricted.

## Honest status: not OSI open source

The MIT text plus additional conditions is a common "ethical source" pattern, but the combination is **not** an Open Source license under the Open Source Initiative definition (OSD criterion 5 and 6: no field-of-use restriction, no discrimination against persons). This trade-off was made deliberately: the project wants the simple, familiar MIT grant for everyone, with a narrow carve-out for severe human rights abuse, rather than a fully unrestricted license.

Consequences to state plainly:

- GitHub (Licensee) and most license scanners will display **Other** instead of "MIT" for this repository.
- Do not use an OSI-approved badge, and do not describe the project as "open source licensed" or "free software" in official wording. Use "MIT with ethical restrictions" / "source-available"（“公开源码”）.
- SPDX has no identifier for this combination. Package manifests should use `LicenseRef-Deep-Monkey-MIT-ER-1.0` (see below), never a bare `MIT`.

## Machine-readable fields

- Root `package.json` currently declares `"license": "LicenseRef-Deep-Monkey-Community-1.0"` (the predecessor license). It must be updated to `LicenseRef-Deep-Monkey-MIT-ER-1.0` to match [LICENSE](LICENSE). Pending — tracked in the night-shift report.
- Packages under `packages/` and `apps/` carry their own `license` fields; the same `LicenseRef-Deep-Monkey-MIT-ER-1.0` convention applies. Verify with `pnpm audit:licenses` before release.
- `pnpm verify:release` runs `pnpm audit:licenses`, which fails on undeclared third-party licenses.

## Project wording

Use “MIT with ethical restrictions”、“source-available” or “公开源码” when describing this repository. Do not use an OSI approval badge or describe `DMS-MIT-ER-1.0` as an open-source/free-software license. The project can still use professional open-development practices such as public review, transparent releases, issue tracking, documented governance, and reproducible quality gates.
