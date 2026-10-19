# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** [Open a private advisory](https://github.com/saratihq/actions-sdk/security/advisories/new)
on this repository instead — it keeps the report, the fix and the disclosure in one place. If you
would rather not use GitHub, email <security@sarati.io>.

Please include the version you tested, what an attacker gains, and the smallest set of steps that
reproduces it. A proof of concept helps; a working exploit is not required.

You will get an acknowledgement within **3 working days** and an assessment — accepted, needs more
information, or not a vulnerability — within **10 working days**. If a report goes unanswered past
that, chase it on the other channel above.

We will tell you when a fix lands and credit you in the advisory unless you would rather stay
anonymous. Please give us a chance to ship the fix before disclosing publicly.

## Supported versions

Security fixes ship in a new release of `@sarati/actions-sdk`. Use the latest release; older
versions do not receive fixes, and affected versions are deprecated on npm once an advisory is
published.

## Scope

Anything in this package. Especially in scope, because they carry the sharp edges:

- The guarded outbound request: refusing private and internal addresses on every hop, redirects and
  DNS answers included.
- Credentials: an auth scheme's credential reaching only the origins it declares, and never
  appearing in an error, a log line or a result.
- Auth schemes and how they apply a credential to a request.
- Triggers' webhook signature verification.

Out of scope: problems in a third-party API an action calls — take those to the service in
question — and code that replaces the guarded request on purpose, such as a custom `fetchImpl` or a
transport passed to `createAuth`.
