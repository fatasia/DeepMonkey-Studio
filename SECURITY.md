# Security policy

## Supported versions

Security fixes target the latest release and the current default branch. Older releases get fixes only when maintainers explicitly announce extended support.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, exploit, leaked credential, or sensitive reproduction in a public Issue, Pull Request, or Discussion.

Use the repository host's private vulnerability reporting feature. If it is unavailable, contact the repository owner through the private contact method on the owner's public profile, including only enough non-sensitive information to establish a secure follow-up channel.

A good report includes the affected version or commit, affected component, impact, prerequisites, reproducible steps, and any suggested mitigation. Remove real credentials, personal data, and customer assets from evidence before sending.

Maintainers aim to acknowledge a complete report within three business days and establish severity and next steps within seven. These are goals, not service-level guarantees.

## Coordinated handling

Maintainers will limit report access, reproduce the issue, assess affected versions, prepare a fix and regression test, and agree on a disclosure date with the reporter when practical. Security releases credit the reporter unless anonymity is requested or attribution would increase risk.

If a credential is exposed, revoke or rotate it immediately — removing it from the current branch does not remove it from Git history. Maintainers must also assess published artifacts, caches, mirrors, and logs.

## Scope

Reports may cover the web application, API, desktop client, workers, import and conversion pipelines, authentication and authorization, storage, deployment scripts, the dependency and model supply chain, and unsafe handling of untrusted project files.

Reports about unsupported third-party services belong with their maintainers, unless Deep Monkey Studio's integration creates the vulnerability.
