/**
 * Shared test setup: a memory logger, a stepping clock, real SQLite connections, temp folders, and
 * a real booted Application with the health provider.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Application,
  type ConfigFiles,
  DatabaseConnectionToken,
  defineConfig,
} from '@strutvane/framework'
import type { LogFields, Logger, LogLevel } from '@strutvane/framework/contracts'
import { type Clock, ClockToken, LoggerToken } from '@strutvane/framework/core'
import {
  Connection,
  replayInSandbox,
  runMigrations,
  sqliteDriver,
} from '@strutvane/framework/database'
import { afterEach } from 'vitest'
import type { CheckContext } from '../src/check.ts'
import { MIGRATION_FILE_NAME, MIGRATION_SOURCE } from '../src/history/migration-stub.ts'
import { HealthEnvToken, HealthServiceProvider } from '../src/provider.ts'

/** A generated 32-byte key (never a fixed test value). */
export const APP_KEY: string = `base64:${randomBytes(32).toString('base64')}`

/** A generated endpoint token. */
export const TOKEN: string = randomBytes(32).toString('base64url')

/** A logger that keeps every entry. */
export class MemoryLogger implements Logger {
  readonly entries: { level: LogLevel; message: string; fields: LogFields | undefined }[] = []
  trace(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'trace', message, fields })
  }
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields })
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields })
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields })
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields })
  }
  fatal(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'fatal', message, fields })
  }
  child(): Logger {
    return this
  }
  isLevelEnabled(): boolean {
    return true
  }
  async flush(): Promise<void> {}
  /** Every message and field, as one string (for "no secret anywhere" assertions). */
  dump(): string {
    return JSON.stringify(this.entries)
  }
}

/** A clock that only moves when told to. */
export class StepClock implements Clock {
  #now: number
  constructor(start = Date.UTC(2026, 10, 18, 10, 0, 0)) {
    this.#now = start
  }
  now(): number {
    return this.#now
  }
  advance(ms: number): void {
    this.#now += ms
  }
}

const temps: string[] = []

/** A fresh temp folder, removed after the test. */
export function tempDir(prefix = 'health-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

const connections: Connection[] = []

/** A real in-memory SQLite connection, closed after the test. */
export function sqliteConnection(): Connection {
  const connection = new Connection(sqliteDriver(':memory:'))
  connections.push(connection)
  return connection
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close().catch(() => undefined)
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Run the shipped migration (through the framework's real sandbox and runner) on `connection`.
 * Returns the migrations folder.
 */
export async function migrateHealthTable(connection: Connection): Promise<string> {
  const root = tempDir('health-mig-')
  const dir = join(root, 'database', 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MIGRATION_FILE_NAME), MIGRATION_SOURCE)
  const replay = await replayInSandbox(dir, { timeoutMs: 60_000 })
  await runMigrations(connection, replay)
  return root
}

/** A check context over a plain map of services, for unit tests of single checks. */
export function contextFor(
  overrides: Partial<Omit<CheckContext, 'make' | 'has'>> & {
    readonly services?: ReadonlyMap<unknown, unknown>
  } = {},
): CheckContext {
  const services = overrides.services ?? new Map()
  const config = overrides.config ?? (() => undefined)
  return {
    basePath: overrides.basePath ?? tempDir(),
    environment: overrides.environment ?? 'testing',
    env: overrides.env ?? {},
    make: <TValue>(key: unknown): TValue => {
      if (!services.has(key)) throw new Error('not bound')
      return services.get(key) as TValue
    },
    has: (key) => services.has(key),
    config,
    now: overrides.now ?? (() => 0),
    signal: overrides.signal ?? new AbortController().signal,
  }
}

/** What {@link healthApp} returns. */
export interface HealthApp {
  readonly app: Application
  readonly logger: MemoryLogger
  readonly clock: StepClock
  readonly connection: Connection
  readonly basePath: string
}

/**
 * A real Application with the health provider, a temp base path (with storage folders), an
 * in-memory SQLite connection, a memory logger and a stepping clock. Not booted yet: tests bind
 * doubles first, then `await app.boot()`.
 */
export function healthApp(
  options: {
    readonly health?: Readonly<Record<string, unknown>>
    readonly env?: Readonly<Record<string, string>>
    readonly config?: ConfigFiles
  } = {},
): HealthApp {
  const basePath = tempDir('health-app-')
  mkdirSync(join(basePath, 'storage', 'framework'), { recursive: true })
  mkdirSync(join(basePath, 'storage', 'logs'), { recursive: true })
  const env = {
    APP_NAME: 'Health Test',
    APP_ENV: 'testing',
    APP_DEBUG: 'false',
    APP_URL: 'http://localhost',
    APP_KEY,
    ...options.env,
  }
  const healthSettings = options.health ?? {}
  const app = Application.configure({ basePath, env })
    .withConfig({
      app: defineConfig((reader) => ({
        name: reader.string('APP_NAME', 'app'),
        env: reader.string('APP_ENV', 'production'),
        debug: reader.boolean('APP_DEBUG', false),
        url: reader.string('APP_URL', 'http://localhost'),
        key: reader.string('APP_KEY', ''),
      })),
      cache: defineConfig(() => ({ default: 'memory', stores: { memory: { driver: 'memory' } } })),
      health: defineConfig(() => healthSettings),
      ...options.config,
    })
    .withProviders([HealthServiceProvider])
    .create()
  const logger = new MemoryLogger()
  const clock = new StepClock()
  const connection = sqliteConnection()
  app.container.value(LoggerToken, logger)
  app.container.value(ClockToken, clock)
  app.container.value(DatabaseConnectionToken, connection)
  app.container.value(HealthEnvToken, env)
  return { app, logger, clock, connection, basePath }
}
