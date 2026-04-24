# Security Policy

## Reporting a Vulnerability

If you discover a security issue, **do not open a public GitHub issue**. Instead:

- Open a private security advisory at https://github.com/BuildDownAI/AI-Implement/security/advisories/new.

Please include enough detail for the issue to be reproduced (versions, configuration, repro steps). You'll get an acknowledgement within 5 business days.

## What's in scope

This service:

1. Holds long-lived credentials for Linear, GitHub (via a GitHub App), and Fly.io.
2. Dispatches GitHub Actions workflows in target repositories on the basis of Linear issue labels.
3. Boots Fly Machines that run Claude Code with checkout access to those repos.
4. Exposes an HTTP admin UI guarded by a single shared `ADMIN_ACCESS_CODE`.

Anything in those four areas that allows an unauthenticated user to dispatch work, leak credentials, or read/modify SQLite state is in scope. The same holds for path traversal, SSRF, or template injection in the workflow files.

## What's out of scope

- Vulnerabilities in dependencies that have not yet been disclosed upstream — please report those to the upstream project first.
- Issues that require a privileged operator (e.g. someone who already has the `ADMIN_ACCESS_CODE`) to exploit themselves.
- Bedrock / AWS account misconfiguration in *your* deployment.

## Operator hardening checklist

If you're running this in production, the following are your responsibility, not the project's:

- Rotate the `ADMIN_ACCESS_CODE` periodically and serve the admin UI over a private network or VPN-only host.
- Keep the GitHub App's permissions minimal — `contents: write`, `pull_requests: write`, `actions: write`, and `issues: read` are typically sufficient.
- Ensure the `dedup.sqlite` volume is encrypted at rest.
- Audit `dispatch_log` regularly for unexpected dispatches (visible in the admin UI).

## Disclosure

We aim to publish a fix and an advisory within 30 days of confirmation, coordinated with the reporter. Credit is given by default unless you ask otherwise.
