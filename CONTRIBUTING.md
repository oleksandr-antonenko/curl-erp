# Contributing

Thank you for looking. A few things are worth knowing before you spend time on a
change.

## The licence, and why there is a CLA

The core is published under the Business Source License 1.1 and is offered
commercially alongside closed modules. Both are only possible while one party
holds the rights to the whole core. A single contribution accepted without an
agreement would freeze the licence as it stands and block commercial
distribution - so every pull request needs its author to have agreed to the
[CLA](./CLA.md). The pull request template has a box for it.

You keep the copyright in what you write. The agreement grants the right to
license it onward, including under different terms.

## Getting set up

```bash
npm install
npm run db:up          # PostgreSQL 17 and Redis in Docker, on non-default ports
cp .env.example .env
```

Four gates, all of which CI runs:

```bash
npm run lint           # formatting, linting, and the architectural boundary check
npm run typecheck      # every package, including tests
npm test               # unit tests, no database needed
npm run test:integration
npm run test:e2e       # browser tests against a real tenant
```

## What the review will look for

**Tests that could fail.** A test that passes against a mock of the thing being
tested proves nothing. Integration tests use a real database; the browser tests
use a real tenant and accounts created through the real sign-up path.

**No vendor names in the core.** The core depends on interfaces - channel,
carrier, payment, fiscal - never on a concrete implementation. `npm run lint`
fails the build otherwise. If you have a genuine exception, mark the line with a
`boundary-allow` comment and say why.

**Money in minor units.** Amounts are integers of the smallest unit. Never a
floating-point number, anywhere, for anything that is money.

**Every document records its actor.** Human, integration or bot. It is written
once and never changed.

**Nothing an AI produced is published without a person.** Enrichment and SEO
features produce drafts.

## Comments

Explain why, not what. The code already says what it does; what a reader cannot
recover is the reasoning, the alternative that was rejected, or the incident that
made a line necessary. A comment restating the line below it is noise; a comment
explaining why the obvious approach was wrong is the most valuable thing in the
file.

## Commits and pull requests

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`). Code, comments, commit
messages and public documentation in English.

Keep a pull request to one change. Say how you verified it - not that you did,
but what you ran and what you saw.

## Reporting a security problem

Do not open a public issue. Write to the maintainer directly. Include what you
found and how to reproduce it; please do not include a working exploit against a
live installation.
