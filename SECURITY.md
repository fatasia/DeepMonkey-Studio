# Security policy

## Supported versions

Security fixes target the latest release and the current default branch. Older releases may receive fixes only when maintainers explicitly announce extended support for that version.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, exploit, leaked credential, customer data, or sensitive reproduction in a public Issue, Pull Request, or Discussion.

Use the repository host's private vulnerability reporting feature. If it is unavailable, contact the repository owner through the private contact method on the owner's public profile and include only enough non-sensitive information to establish a secure follow-up channel.

Include the affected version or commit, affected component, impact, prerequisites, reproducible steps, and any suggested mitigation. Remove real credentials, personal data, production data, and customer assets from evidence.

Maintainers aim to acknowledge a complete report within three business days, establish severity and next steps within seven business days, and coordinate disclosure after a fix or mitigation is available. These are response goals rather than service-level guarantees.

## Coordinated handling

Maintainers will limit report access, reproduce the issue, assess affected versions, prepare a fix and regression test, and agree on a disclosure date with the reporter when practical. Security releases will credit the reporter unless anonymity is requested or attribution would increase risk.

If a credential is exposed, revoke or rotate it immediately. Removing it from the current branch does not remove it from Git history; maintainers must also assess history rewriting, published artifacts, caches, mirrors, logs, and downstream exposure.

## Scope

Security reports may cover the web application, API, desktop client, workers, import and conversion pipelines, authentication, authentication and authorization, storage, deployment scripts, dependency or model supply chain, and unsafe handling of untrusted project files.

Reports about unsupported third-party services should go to their maintainers unless Deep Monkey Studio's integration creates the vulnerability.
