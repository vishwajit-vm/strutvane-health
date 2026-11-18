/**
 * `node strut health:check` / `health:list`, run through the framework's real CLI runner
 * (argument parsing, `--json` envelope, exit codes) against a real booted Application.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Application, BootError } from '@strutvane/framework'
import { runCli } from '@strutvane/framework/console'
import { describe, expect, it } from 'vitest'
import { defineCheck } from '../src/check.ts'
import commands, { healthCommands } from '../src/commands.ts'
import { HealthToken } from '../src/health.ts'
import { Result } from '../src/result.ts'
import { healthApp, MemoryLogger } from './helpers.ts'

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function cli(
  app: Application,
  basePath: string,
  argv: readonly string[],
  load?: (root: string) => Promise<Application>,
): Promise<Ran> {
  writeFileSync(join(basePath, 'strut.js'), '')
  let stdout = ''
  let stderr = ''
  const code = await runCli({
    argv,
    cwd: basePath,
    builtins: healthCommands({ load: load ?? (async () => app) }),
    streams: {
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
    },
    services: { isTTY: false, env: {} },
    version: '0.2.0-next.0',
  })
  return { code, stdout, stderr }
}

/** A fixture app with only deterministic checks registered (in a provider's boot, as apps do). */
function fixture(): ReturnType<typeof healthApp> {
  return healthApp({ health: { checks: noBuiltIns } })
}

const noBuiltIns = {
  database: { enabled: false },
  migrations: { enabled: false },
  cache: { enabled: false },
  disk_space: { enabled: false },
  storage: { enabled: false },
  app_key: { enabled: false },
  debug_mode: { enabled: false },
  environment: { enabled: false },
}

async function bootWith(statuses: Record<string, 'ok' | 'warning' | 'failed'>) {
  const made = fixture()
  await made.app.boot()
  for (const [name, status] of Object.entries(statuses))
    made.app.make(HealthToken).register(
      defineCheck({
        name,
        run: () =>
          status === 'ok' ? Result.ok('fine') : status === 'warning' ? Result.warning('meh', 'look') : Result.failed('down', 'fix it'),
      }),
    )
  return made
}

describe('health:check', () => {
  it('exits 0 when healthy and prints a table', async () => {
    const { app, basePath } = await bootWith({ alpha: 'ok' })
    const ran = await cli(app, basePath, ['health:check'])
    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('alpha')
    expect(ran.stdout).toContain('Health: ok')
  })

  it('exits 1 on a failure, printing the message', async () => {
    const { app, basePath } = await bootWith({ alpha: 'ok', beta: 'failed' })
    const ran = await cli(app, basePath, ['health:check'])
    expect(ran.code).toBe(1)
    expect(ran.stdout + ran.stderr).toContain('fix it')
  })

  it('treats warnings as healthy unless --fail-on warning', async () => {
    const first = await bootWith({ alpha: 'warning' })
    expect((await cli(first.app, first.basePath, ['health:check'])).code).toBe(0)
    // Every CLI run loads (and shuts down) its own app, as node strut does.
    const second = await bootWith({ alpha: 'warning' })
    expect((await cli(second.app, second.basePath, ['health:check', '--fail-on', 'warning'])).code).toBe(1)
  })

  it('--only runs the named checks; an unknown name is a usage error (exit 2)', async () => {
    const first = await bootWith({ alpha: 'ok', beta: 'failed' })
    expect((await cli(first.app, first.basePath, ['health:check', '--only', 'alpha'])).code).toBe(0)
    const second = await bootWith({ alpha: 'ok', beta: 'failed' })
    const unknown = await cli(second.app, second.basePath, ['health:check', '--only', 'gamma'])
    expect(unknown.code).toBe(2)
    expect(unknown.stdout + unknown.stderr).toContain('Unknown health check(s): gamma')
  })

  it('--json prints the report in the CLI envelope', async () => {
    const { app, basePath } = await bootWith({ alpha: 'failed' })
    const ran = await cli(app, basePath, ['health:check', '--json', '--skip-history', '--skip-notifications'])
    expect(ran.code).toBe(1)
    const envelope = JSON.parse(ran.stdout) as {
      exitCode: number
      data: { status: string; stored: boolean; checks: { name: string; message: string }[] }
    }
    expect(envelope.exitCode).toBe(1)
    expect(envelope.data.status).toBe('failed')
    expect(envelope.data.stored).toBe(false)
    expect(envelope.data.checks[0]).toMatchObject({ name: 'alpha', message: 'fix it' })
  })

  it('reports history problems (no table yet) without failing a healthy run', async () => {
    const { app, basePath } = await bootWith({ alpha: 'ok' })
    const ran = await cli(app, basePath, ['health:check'])
    expect(ran.code).toBe(0)
    expect(ran.stdout + ran.stderr).toMatch(/history: .*no such table/)
  })

  it('exits 1 when the app does not boot, with the fix', async () => {
    const made = fixture()
    const ran = await cli(made.app, made.basePath, ['health:check'], async () => {
      throw new BootError('missing_bootstrap', 'There is no bootstrap/app.ts.', 'Run it from the app root.')
    })
    expect(ran.code).toBe(1)
    expect(ran.stdout + ran.stderr).toContain('The app did not boot: There is no bootstrap/app.ts.')
  })

  it('exits 1 with a hint when the provider is not registered', async () => {
    const made = fixture()
    const bare = (await import('@strutvane/framework')).Application.configure({
      basePath: made.basePath,
      env: { APP_ENV: 'testing', APP_KEY: `base64:${Buffer.alloc(32, 7).toString('base64')}` },
    }).create()
    bare.container.value((await import('@strutvane/framework/core')).LoggerToken, new MemoryLogger())
    const ran = await cli(bare, made.basePath, ['health:check'])
    expect(ran.code).toBe(1)
    expect(ran.stdout + ran.stderr).toContain('Add HealthServiceProvider to bootstrap/providers.ts')
  })

  it('accepts --force-debug (passes it to the app before boot)', async () => {
    const made = fixture()
    const ran = await cli(made.app, made.basePath, ['health:check', '--force-debug'])
    expect(ran.code).toBe(0)
  })
})

describe('health:list', () => {
  it('lists the registered checks', async () => {
    const { app, basePath } = await bootWith({ alpha: 'ok' })
    app.make(HealthToken).register(defineCheck({ name: 'slowpoke', label: 'Slow', timeoutMs: 900, run: () => Result.ok() }))
    const ran = await cli(app, basePath, ['health:list', '--json'])
    expect(ran.code).toBe(0)
    const envelope = JSON.parse(ran.stdout) as { data: { checks: unknown[] } }
    expect(envelope.data.checks).toEqual([
      { name: 'alpha', label: 'alpha', timeoutMs: null },
      { name: 'slowpoke', label: 'Slow', timeoutMs: 900 },
    ])
    const again = await bootWith({})
    again.app.make(HealthToken).register(defineCheck({ name: 'slowpoke', timeoutMs: 900, run: () => Result.ok() }))
    const human = await cli(again.app, again.basePath, ['health:list'])
    expect(human.stdout).toContain('900 ms')
  })
})

describe('the default export', () => {
  it('is the two commands the CLI loads from package.json strutvane.commands', () => {
    expect(commands.map((command) => command.name)).toEqual(['health:check', 'health:list'])
  })
})
