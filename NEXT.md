# NEXT: `@strutvane/health` (branch `fix/hardening-2026-11-20`)

## Branch `fix/hardening-2026-11-20` (2026-11-21)

- **Endpoint:** the credential is checked first; a valid token or an allowed policy is always served. Only failures are counted, per client bucket (`src/http/ip-bucket.ts`, the same buckets as the framework's `throttle`, which the published framework does not export; `test/http/ip-bucket.test.ts` pins it to the framework's examples). Property test: any number of failures from one bucket, `unknown` included, never blocks a valid credential.
- **Output masking (`src/sanitize.ts`):** encoded forms of known secrets (percent, JSON, base64, base64url); URL credentials to the last `@`; more key names; whole quoted values; header lines; Redis `AUTH`; Digest `response`. Values are measured by hand so the work stays linear. Property test `test/sanitize-carriers.test.ts`: unknown secrets from the full printable alphabet in every carrier leave no 6-character piece.
- Changeset (patch) added.
- **Gate (2026-11-21, Windows, Node 24; agent-reported until the coordinator re-runs):** plain `npm ci` OK; `npm run ci` 3× in a row green: 16 files, 190 tests, coverage 98.54 / 94.16 / 98.24 / 99.4, build OK. (An earlier batch had 2 green runs and 1 run where every slow test hit its 30 s timeout while the machine was saturated by other jobs; it was re-run.)
- **Next:** the coordinator re-runs the gate 3×, then merges into `main` with the release.

Last updated: 2026-11-19. Built against `@strutvane/framework` 0.2.0-next.1, which is on npm.

## Done

- **Package scaffold:**
  - manifest (`strutvane` block: id, installs, `commands`, `installer`, `compat`);
  - synced tooling files (library profile, applied with strutvane-tooling's own sync code);
  - Changesets in pre mode (`next`).
- **Checks:**
  - database (`SELECT 1` + latency);
  - migrations (pending or missing files, by name);
  - cache (write/read/forget);
  - disk space (`statfs`);
  - storage (writable folders, plus an optional storage disk);
  - app key and previous keys (the framework's `keyProblem`);
  - debug mode per environment;
  - environment against `.env.example`;
  - heartbeats (`recordHeartbeat` and `heartbeatCheck`, the interface the scheduler and queue will use).
- **Custom checks API:** `defineCheck` and `Result`. The runner adds per-check deadlines with an `AbortSignal`, turns a throw or a malformed result into `failed`, and sanitizes all output.
- **History:** `DatabaseResultStore` over the `health_check_results` table, created by a migration the installer writes (fixed name, so it is idempotent). `MemoryResultStore` is the in-memory option. Old rows are pruned after `keep_days`.
- **Alerts:**
  - `Notifier` throttles per check and status through the cache's atomic `add` (safe across servers), sends recovery messages, and isolates failing channels;
  - Slack (host pinned) and webhook (signed with HMAC) channels use the SSRF-safe `HttpClient`;
  - mail goes through a port (`HealthMailerToken`).
- **Endpoint `GET /health.json`:**
  - access by token (constant-time compare) or by policy (`authorizeUsing`); `404` when neither is configured;
  - failures counted per client bucket (`429` for further failures; a valid credential always passes);
  - `no-store`, and `503` when a check failed;
  - single-flight runs with a short reuse window;
  - `/up` is untouched.
- **CLI:** `health:check` (exit 0/1/2, `--only`, `--fail-on`, `--skip-history`, `--skip-notifications`, `--force-debug`, `--json`) and `health:list`.
- **Installer** (`node strut add health`):
  - writes the config, the migration and the env token;
  - registers the provider in `bootstrap/providers.ts` and adds `health` to `config/index.ts`;
  - uninstall is reversible.
- **Tests:** 14 files, 149 tests on real engines, coverage 98.34/94.43/97.61/99.32 (statements/branches/functions/lines; agent-reported):
  - SQLite through the framework driver;
  - the real migration sandbox and runner;
  - a real booted `Application`;
  - the real CLI runner;
  - the real devkit installer.
- **Security tests:** endpoint access, lockout, query-string tokens ignored, no secrets in output (including a sanitizer property test), SSRF on webhooks, header injection in mail, prototype pollution in stored meta, SQL-injection-shaped check names.

## Open (for the project lead or other repos)

1. **`node strut install:<name>` doesn't exist in the framework yet.** The installer runs through `node strut add health` (`strutvane.installer`). The framework's devkit `registerProvider` edits v1's `strutvane.config.ts`, so this package edits `bootstrap/providers.ts` and `config/index.ts` itself (`src/install/patch.ts`). The framework could offer this edit for every add-on.
2. **The `strutvane.commands` contribution needs `@strutvane/health` as a direct dependency** of the app (framework rule). `app.addCommand()` from a provider is not seen by the CLI, because the CLI loads `app.commands` without booting the app. So the commands come only from package.json.
3. **The health screen (`/_strutvane/health`, in the catalogue's `installs.screens`) is not built.** It belongs with `@strutvane/ui` / log-viewer-style screens. It is left out of this package's manifest on purpose.
4. **The catalogue entry** (hub `spikes/21-package-catalogue/seed/catalogue.json`) still says `frameworkRange ^1.0`, version 0.1.0 and `planned`. Update it once this is released.
5. **strutvane-tooling `manifest.json` has no `health` target.** Add `{ "name": "health", "profile": "library" }` so `sync.mjs --check` covers this repo.
6. **Mail alerts wait for the framework mailer.** Until then, apps bind `HealthMailerToken`.

## Gate (agent-reported, 2026-11-19, Windows, Node 24, against framework 0.2.0-next.1 from npm)

- Plain `npm ci` passes (allowScripts pins esbuild 0.18.20 / 0.25.12 / 0.28.2 and denies fsevents 2.3.3).
- `npm run ci` 3× green: 14 files, 149 tests each run, coverage 98.34 / 94.43 / 97.61 / 99.32, build OK.
- `check-code-rules`, `check-deps` and `check-package` (26 files) pass; publint --strict "All good"; attw --profile esm-only clean; `npm audit --omit=dev` 0 vulnerabilities.

## Next

1. Have the coordinator re-run the gate 3× (`npm ci && npm run ci`).
2. Do the security review (`security-reviewer` agent) and the `strutvane-ecosystem-guardian` review.
3. Merge into `main` and release `0.2.0-next.0` with the next add-on wave. `RELEASE_ENABLED` is not set on this repo yet.

## How to verify

```bash
npm ci
npm run ci
```

The full suite takes about 1 to 2 minutes on a quiet machine. The migration tests spawn the framework's replay sandbox.
