pass (agent-reported) | logs only through the framework Logger (LoggerToken); this package is the health check provider | 2026-11-18 |partial (agent-reported) | README.md; docs site page not written | 2026-11-18 |partial (agent-reported) | test/installer.test.ts (idempotent, reversible, dry run via the real devkit); hub nightly not run | 2026-11-18 || tarball not built in CI yet | 2026-11-18 |partial (agent-reported) | test/runner.test.ts (deadlines, throws), test/notify/notifier.test.ts (channel isolation, cache down), test/history/store.test.ts (atomic save); no soak test | 2026-11-18 |partial (agent-reported) | attack tests: test/http/endpoint.test.ts, test/sanitize.test.ts (fast-check), test/notify/channels.test.ts, test/history/store.test.ts; security-reviewer not run yet | 2026-11-18 |partial (agent-reported) | local gate 3x on Windows/Node 24 (see NEXT.md); CI matrix not run yet (not pushed) | 2026-11-18 |pass (agent-reported) | local `npm run ci` (biome, tsc, check-code-rules: no console in src); TSDoc on every export | 2026-11-18 |# Release readiness

<!--
  Created once by strutvane-tooling (canonical/RELEASE-READINESS.md). This repo owns this file:
  sync never overwrites it. Gates and rules: hub docs/19-production-readiness.md
  (https://github.com/vishwajit-vm/strutvane/blob/main/docs/19-production-readiness.md).

  A version reaches npm `latest` only when every gate below is "pass" with evidence. One row per
  gate: the status (pass / fail / not checked), a link to the evidence (CI run, report or test
  file; never "trust me"), and the date it was checked (YYYY-MM-DD). The coordinator re-runs the
  checks before a gate is accepted; the project lead approves the staged release.
-->

Package: @strutvane/health · Version: 0.2.0-next.0 · Last reviewed: 2026-11-19

| Gate | What must be true (summary; docs/19 is the source) | Checked by | Status | Evidence | Date |
|---|---|---|---|---|---|
| R1 Code | Strict TS, ESM, lint clean, no `console.` in `src/`, no TODO/FIXME without an issue, TSDoc on every export | CI `verify` (`npm run ci`, `check-code-rules.mjs`) | pass (agent-reported) | local `npm run ci` (biome, tsc, check-code-rules: no console in src); TSDoc on every export | 2026-11-18 |
| R2 Tests | Green on Node 24 and 26 × Linux, Windows, macOS; coverage ≥ 90/90/85/90; type-level tests; 3 green runs in a row; no unhandled rejections or open handles | CI `verify` matrix and `repeat` job | partial (agent-reported) | local gate 3x green on Windows / Node 24, 149 tests, coverage 98.34/94.43/97.61/99.32 (NEXT.md); CI matrix not run yet | 2026-11-18 |
| R3 Security | Threat model; attack-style tests; parsers fuzzed; review with 0 open critical/high; `npm audit --omit=dev` 0 high/critical; secrets scan clean | `security-reviewer` report; CI `security` job | partial (agent-reported) | attack tests: test/http/endpoint.test.ts, test/sanitize.test.ts (fast-check), test/notify/channels.test.ts, test/history/store.test.ts; security-reviewer not run yet | 2026-11-18 |
| R4 Resilience | Failure scenarios named and tested; fails closed; idempotent retries; soak test with no growth | Resilience suites; `npm run test:soak` | partial (agent-reported) | test/runner.test.ts (deadlines, throws), test/notify/notifier.test.ts (channel isolation, cache down), test/history/store.test.ts (atomic save); no soak test | 2026-11-18 |
| R5 Packaging | publint and attw clean; tarball has no tests, fixtures, secrets or local map paths; exports resolve; `engines.node` ≥ 24.3; one framework copy; LICENSE, README, CHANGELOG; a changeset | CI `package-check` job | partial (agent-reported) | local: check-package (26 files), publint --strict clean, attw esm-only clean, CHANGELOG + changeset present; CI package-check not run yet | 2026-11-19 |
| R6 Integration | Installs alone and with every package, in any order, identically; re-install is a no-op; complete `.env.example`; boot fails closed; only the six connections; Northwind Ops green | Hub nightly ecosystem job; installer e2e | partial (agent-reported) | test/installer.test.ts (idempotent, reversible, dry run through the real devkit); hub nightly not run | 2026-11-18 |
| R7 Docs | Every public feature documented with tested examples; upgrade guide; packages data, what's-new, versioning table and deprecations updated in the same change | Docs site tests | partial (agent-reported) | README.md; no docs-site page yet | 2026-11-18 |
| R8 Release | Version per ADR-0020; staged by CI with provenance, approved with 2FA (ADR-0018); right dist-tag; release notes; rollback plan; `versions.json` updated | Release workflow; owner approval | not checked | | |
| R9 Operations | Logs only through the framework Logger with redaction (ADR-0022); health and readiness checks; no debug tool reachable in production | Tests; `security:check` | pass (agent-reported) | logs only through the framework Logger (LoggerToken); never logs URLs, tokens or bodies | 2026-11-18 |
