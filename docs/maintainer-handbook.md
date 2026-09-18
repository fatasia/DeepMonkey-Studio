# Maintainer handbook

Use this guide to triage contributions and prepare releases. Decision authority is defined in [GOVERNANCE.md](../GOVERNANCE.md); the current roster is in [MAINTAINERS.md](../MAINTAINERS.md).

## Triage an Issue

1. Check for a duplicate, a private security report or a usage question before assigning engineering work.
2. Reproduce against the reported revision. Ask for the smallest missing detail: input, version, failing step or expected result.
3. State the affected module and impact. Use `bug`, `documentation` or `enhancement`, plus `triage` while the report needs review.
4. Add `good first issue` only when scope, relevant files and acceptance checks are written down. Use `help wanted` when the work can proceed independently.
5. Close with a linked fix, duplicate reference or specific reason. Do not close a reproducible defect only because it is old.

The labels above are a host-configuration convention. Issue forms reference them; they must also be created on the repository host before publication.

## Review a Pull Request

Read the problem and resulting behavior before the diff. Check the smallest reproduction, failure paths, persistence, compatibility and documentation against the final revision. Require a second reviewer when the affected area is outside your expertise.

The PR template records scope, verification, documentation and dependency impact. Check evidence rather than checked boxes: an unrun GPU test or unavailable external service remains unverified. For UI work inspect actual screenshots at relevant widths and both themes.

The required `repository-governance` job validates repository policy and documentation links. Other checks depend on the change: use the contributor guide and root scripts, and run the full applicable release gates before publishing. A successful policy job does not prove application correctness.

## Prepare a release candidate

1. Select a reviewed revision on the protected default branch. Build from a clean checkout with the locked dependency versions.
2. Review `Unreleased`, identify breaking changes, and document migration and rollback before selecting a SemVer tag.
3. Run `pnpm verify:release` and the additional GPU/native/platform gates required by the distributed targets. Record the exact revision, commands, results and environment.
4. Complete the [public release checklist](open-source-release-checklist.md), including dependency and asset rights, history scanning and host settings.
5. Verify each artifact includes licenses and attribution, produce checksums and an inventory, and test installation and restoration on the supported target.

## Publish and recover

Publish release notes using the [release notes template](release-notes-template.md). Link the tag, artifact checksums, supported platforms and known limitations. Keep evidence tied to the revision used to build the artifacts.

If an artifact is defective, mark the release with a clear notice and point users to the last usable release. Publish a new patch version after validation; do not replace an artifact under the same version or silently move a tag. Follow [SECURITY.md](../SECURITY.md) when the failure exposes a vulnerability.

## Repository host setup

Before making the repository public, verify these settings on the actual host and record their state in the release review:

- The actual default branch is covered by CI triggers and protected against deletion and force pushes; merges require review and the applicable status checks.
- Maintainer access is limited to named responsibilities, with two-factor authentication and periodic review.
- Private vulnerability reporting and a working private fallback contact are available.
- Issue labels and templates work; security and dependency alerts are enabled where the host supports them.
- CI tokens use least privilege. Workflows do not execute untrusted PR code with repository secrets.

Files in `.github` configure workflows and templates. They do not enable branch protection, private reports or account security by themselves.
