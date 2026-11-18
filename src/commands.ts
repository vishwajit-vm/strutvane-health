/**
 * `node strut health:check` and `node strut health:list` (package.json `strutvane.commands`).
 *
 * `health:check` boots the app, runs the checks, stores the report in history, sends alerts and
 * exits with a code a CI job, a cron wrapper or a monitoring agent can act on:
 *
 * | Exit | Meaning |
 * |---|---|
 * | 0 | healthy (warnings allowed, unless `--fail-on warning`) |
 * | 1 | at least one check failed (or warned, with `--fail-on warning`), or the app did not boot |
 * | 2 | usage error, such as `--only` naming an unknown check |
 *
 * Schedule it (cron, a systemd timer, your platform's scheduler) every minute or five to keep
 * history and alerts current; the JSON endpoint only reads.
 *
 * `--json` (global) prints the report with messages and meta: the terminal belongs to an
 * operator, but the output is still sanitized, so piping it into a CI log leaks no secret.
 *
 * @module
 */
import { type Application, isBootError, loadApplication } from '@strutvane/framework'
import {
  type AnyCommand,
  type CommandContext,
  defineCommand,
  EXIT,
} from '@strutvane/framework/console'
import { checkLabel } from './check.ts'
import { HealthToken, type RunOutcome, UnknownCheckError } from './health.ts'
import type { CheckRun } from './report.ts'

/**
 * How the commands get the app (tests pass a loader that returns an app they built).
 *
 * @example
 * healthCommands({ load: async () => testApp })
 */
export interface HealthCommandDeps {
  readonly load: (root: string) => Promise<Application>
}

const DEFAULT_DEPS: HealthCommandDeps = { load: loadApplication }

const STATUS_WORD: Readonly<Record<string, string>> = {
  ok: 'ok',
  warning: 'WARNING',
  failed: 'FAILED',
  skipped: 'skipped',
}

/**
 * The health commands.
 *
 * @example
 * export default healthCommands()
 */
export function healthCommands(deps: HealthCommandDeps = DEFAULT_DEPS): AnyCommand[] {
  const check = defineCommand({
    name: 'health:check',
    description: 'Run every health check now',
    details:
      'Boots the app, runs the checks, stores the results and sends alerts. Exit code 0 = healthy, 1 = a check failed (or the app did not boot), 2 = usage error. Schedule it every few minutes to keep history and alerts current.',
    flags: {
      only: {
        type: 'string',
        multiple: true,
        valueName: 'name',
        description: 'Run only this check (repeatable)',
      },
      'fail-on': {
        type: 'string',
        choices: ['failed', 'warning'],
        default: 'failed',
        description: 'The lowest status that makes the command exit 1',
      },
      'skip-history': { type: 'boolean', description: 'Do not store the results' },
      'skip-notifications': { type: 'boolean', description: 'Do not send alerts' },
      'force-debug': {
        type: 'boolean',
        description: 'Boot even with APP_DEBUG=true in production (otherwise refused)',
      },
    },
    examples: [
      'node strut health:check',
      'node strut health:check --only database --only migrations',
      'node strut health:check --fail-on warning --json',
    ],
    async run(ctx) {
      return withApp(ctx, deps, ctx.flags['force-debug'] === true, async (app) => {
        const outcome = await app.make(HealthToken).run({
          only: ctx.flags.only,
          store: ctx.flags['skip-history'] !== true,
          notify: ctx.flags['skip-notifications'] !== true,
        })
        printOutcome(ctx, outcome)
        const failOn = ctx.flags['fail-on'] === 'warning' ? ['warning', 'failed'] : ['failed']
        const unhealthy = failOn.includes(outcome.report.status)
        return {
          data: {
            ...outcome.report,
            stored: outcome.stored,
            notified: outcome.notified ?? null,
            problems: outcome.problems,
          },
          exitCode: unhealthy ? EXIT.FAILURE : EXIT.OK,
        }
      })
    },
  })

  const list = defineCommand({
    name: 'health:list',
    description: 'List the health checks',
    flags: {
      'force-debug': {
        type: 'boolean',
        description: 'Boot even with APP_DEBUG=true in production (otherwise refused)',
      },
    },
    async run(ctx) {
      return withApp(ctx, deps, ctx.flags['force-debug'] === true, async (app) => {
        const checks = app.make(HealthToken).list()
        ctx.out.table(
          ['Check', 'Label', 'Timeout'],
          checks.map((entry) => [
            entry.name,
            checkLabel(entry),
            entry.timeoutMs === undefined ? 'default' : `${entry.timeoutMs} ms`,
          ]),
        )
        return {
          data: {
            checks: checks.map((entry) => ({
              name: entry.name,
              label: checkLabel(entry),
              timeoutMs: entry.timeoutMs ?? null,
            })),
          },
        }
      })
    },
  })

  return [check, list]
}

type Outcome = { readonly exitCode?: (typeof EXIT)[keyof typeof EXIT]; readonly data?: unknown }

/** Load and boot the app, run `work` as it, and always shut it down (connections closed). */
async function withApp(
  ctx: CommandContext,
  deps: HealthCommandDeps,
  forceDebug: boolean,
  work: (app: Application) => Promise<Outcome>,
): Promise<Outcome> {
  let app: Application | undefined
  try {
    app = await deps.load(ctx.requireProject().root)
    if (forceDebug) app.forceDebug()
    await app.boot()
    const booted = app
    if (!booted.container.has(HealthToken)) {
      ctx.out.warn(
        'The health service is not registered. Add HealthServiceProvider to bootstrap/providers.ts (`node strut add health` does it).',
      )
      return { exitCode: EXIT.FAILURE }
    }
    return await booted.run(() => work(booted))
  } catch (error) {
    if (error instanceof UnknownCheckError) {
      ctx.out.warn(error.message)
      return { exitCode: EXIT.USAGE, data: { unknown: error.unknown, known: error.known } }
    }
    if (isBootError(error)) {
      // The app could not start: for a monitor that is the most important failure of all.
      ctx.out.warn(`The app did not boot: ${error.message}\n  → ${error.hint}`)
      return { exitCode: EXIT.FAILURE, data: { status: 'failed', boot: error.code } }
    }
    throw error
  } finally {
    if (app !== undefined) await app.shutdown().catch(() => undefined)
  }
}

function printOutcome(ctx: CommandContext, outcome: RunOutcome): void {
  const { out } = ctx
  const style = out.style
  const color = (status: string, text: string): string =>
    status === 'failed'
      ? style.red(text)
      : status === 'warning'
        ? style.yellow(text)
        : status === 'ok'
          ? style.green(text)
          : style.dim(text)
  out.table(
    ['Check', 'Status', 'Summary', 'Time'],
    outcome.report.checks.map((run) => [
      run.label,
      color(run.status, STATUS_WORD[run.status] ?? run.status),
      run.summary,
      `${run.durationMs} ms`,
    ]),
  )
  for (const run of outcome.report.checks.filter(needsMessage))
    out.line(`${color(run.status, `${run.label}:`)} ${run.message ?? ''}`)
  for (const problem of outcome.problems) out.warn(problem)
  const notified = outcome.notified
  if (notified !== undefined && notified.alerted.length + notified.recovered.length > 0)
    out.info(
      `Alerts sent for: ${[...notified.alerted, ...notified.recovered].join(', ')}${notified.suppressed.length > 0 ? ` (throttled: ${notified.suppressed.join(', ')})` : ''}`,
    )
  const summary = `Health: ${outcome.report.status}`
  if (outcome.report.status === 'ok') out.success(summary)
  else out.line(color(outcome.report.status, summary))
}

function needsMessage(run: CheckRun): boolean {
  return (run.status === 'warning' || run.status === 'failed') && run.message !== undefined
}

/** The commands `node strut` loads from this package (package.json `strutvane.commands`). */
const commands: AnyCommand[] = healthCommands()
export default commands
