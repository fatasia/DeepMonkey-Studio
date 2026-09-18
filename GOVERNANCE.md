# Project governance

This document defines how decisions are made in this repository. Usage rights are defined by the [LICENSE](LICENSE), not by this file.

The [maintainer roster](MAINTAINERS.md), [maintainer handbook](docs/maintainer-handbook.md) and [roadmap](ROADMAP.md) provide contacts, operating procedures and current priorities.

## Roles

- **Contributors** submit Issues, documentation, tests, designs, or code.
- **Reviewers** have demonstrated relevant technical judgment and provide non-binding review.
- **Maintainers** have repository write access and handle triage, review, releases, security response, and policy enforcement.
- **Project Steward** is the repository owner. The Project Steward appoints or removes maintainers and has final authority over project scope, branding, governance, and license policy.

Roles are earned through sustained, constructive contribution. Access can be removed when it is inactive, compromised, or repeatedly used against project policy.

## Decisions

Routine fixes and small features are decided in Pull Request review. Major architecture changes, public contract changes, data migrations, new trust boundaries, or anything with continuing maintenance cost require a design note under `docs/specs/` first. The note states the problem, constraints, chosen design, alternatives, compatibility, migration, rollback, and verification plan.

Maintainers seek technical consensus. When that fails, the responsible maintainer records the competing evidence and a recommendation, and the Project Steward decides. Urgent security fixes may merge with limited public detail and get a follow-up record after coordinated disclosure.

License text, restricted-organization definitions, and prohibited-use rules are reserved decisions of the Project Steward. A normal Pull Request cannot relax, replace, or create an exception to those terms.

## Merge policy

The default branch must be protected. Changes enter through Pull Requests. Each merge requires:

1. a focused diff and completed Pull Request description;
2. all required status checks, including `repository-governance`;
3. review by at least one maintainer who understands the affected area;
4. current tests, docs, changelog, migration, and third-party notices as applicable;
5. resolved security and license concerns.

Force pushes and deletion of the default branch are disabled. Administrators should not bypass required checks for ordinary changes. Prefer squash merge for a coherent change; use merge commits when preserving a deliberate multi-commit history is useful.

## Releases

Releases follow Semantic Versioning. While the project is below 1.0, minor versions may contain documented breaking changes. A release comes from the protected default branch, carries a `vMAJOR.MINOR.PATCH` tag, passes `pnpm verify:release` or the applicable GPU release gate, and ships release notes derived from [CHANGELOG.md](CHANGELOG.md).

Every release records known limitations, migrations, rollback steps, and any security fixes safe to disclose. Published artifacts must contain the project license and applicable third-party notices.

## Security and dependencies

Vulnerabilities follow [SECURITY.md](SECURITY.md). Maintainers minimize access, use two-factor authentication, and review automated dependency updates. New dependencies and external assets require provenance, license, maintenance, and security review before merge.

## Amendments

Governance changes use a normal Pull Request with an `Unreleased` changelog entry and explicit approval from the Project Steward. The repository gate checks that governance files exist and stay consistent; it does not replace human review.
