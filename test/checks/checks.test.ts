/**
 * The built-in checks, on real engines where there is one: SQLite for the database and
 * migrations checks, the framework's real cache stores, real folders and a real memory disk.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CacheManagerToken,
  type CacheStore,
  createCacheManager,
  createMemoryDisk,
  createStorageManager,
  DatabaseConnectionToken,
  isBootError,
  StorageManagerToken,
} from '@strutvane/framework'
import { sql } from '@strutvane/framework/database'
import { describe, expect, it } from 'vitest'
import { appKeyCheck } from '../../src/checks/app-key.ts'
import { builtInChecks } from '../../src/checks/built-in.ts'
import { CACHE_PROBE_PREFIX, cacheCheck } from '../../src/checks/cache.ts'
import { databaseCheck } from '../../src/checks/database.ts'
import { debugModeCheck } from '../../src/checks/debug-mode.ts'
import { diskSpaceCheck } from '../../src/checks/disk-space.ts'
import { environmentCheck, envKeys } from '../../src/checks/environment.ts'
import { HEARTBEAT_PREFIX, heartbeatCheck, recordHeartbeat } from '../../src/checks/heartbeat.ts'
import { migrationNames, migrationsCheck } from '../../src/checks/migrations.ts'
import { isContainedPath } from '../../src/checks/options.ts'
import { storageCheck } from '../../src/checks/storage.ts'
import { resolveHealthSettings } from '../../src/settings.ts'
import { contextFor, StepClock, sqliteConnection, tempDir } from '../helpers.ts'

const KEY = `base64:${randomBytes(32).toString('base64')}`

function expectBootError(make: () => unknown, pattern: RegExp): void {
  let thrown: unknown
  try {
    make()
  } catch (error) {
    thrown = error
  }
  expect(isBootError(thrown)).toBe(true)
  expect((thrown as Error).message).toMatch(pattern)
}

describe('database', () => {
  it('answers ok with the latency from the clock', async () => {
    const clock = new StepClock()
    const connection = sqliteConnection()
    const result = await databaseCheck().run(
      contextFor({
        services: new Map([[DatabaseConnectionToken, connection]]),
        now: () => clock.now(),
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      summary: '0 ms',
      meta: { latencyMs: 0, dialect: 'sqlite' },
    })
  })

  it('warns and fails at the latency thresholds', async () => {
    const connection = sqliteConnection()
    for (const [elapsed, status] of [
      [49, 'ok'],
      [50, 'warning'],
      [500, 'failed'],
    ] as const) {
      const clock = new StepClock()
      let calls = 0
      const now = () => {
        calls += 1
        if (calls === 2) clock.advance(elapsed)
        return clock.now()
      }
      const result = await databaseCheck({ warnMs: 50, failMs: 500 }).run(
        contextFor({ services: new Map([[DatabaseConnectionToken, connection]]), now }),
      )
      expect(result.status).toBe(status)
      if (status !== 'ok') expect(result.message).toMatch(/overloaded/)
    }
  })

  it('fails with a hint when the database is unreachable or not bound', async () => {
    const connection = sqliteConnection()
    await connection.close()
    const down = await databaseCheck().run(
      contextFor({ services: new Map([[DatabaseConnectionToken, connection]]) }),
    )
    expect(down).toMatchObject({ status: 'failed', summary: 'unreachable' })
    expect(down.message).toMatch(/Check DB_\*/)
    const unbound = await databaseCheck().run(contextFor())
    expect(unbound).toMatchObject({ status: 'failed', summary: 'not configured' })
  })

  it('refuses inverted thresholds at creation', () => {
    expectBootError(() => databaseCheck({ warnMs: 900, failMs: 100 }), /databaseCheck\(\): warnAt/)
  })
})

describe('migrations', () => {
  async function setup(files: readonly string[], ran: readonly string[] | undefined) {
    const basePath = tempDir()
    const dir = join(basePath, 'database', 'migrations')
    mkdirSync(dir, { recursive: true })
    for (const file of files) writeFileSync(join(dir, file), 'export default {}')
    const connection = sqliteConnection()
    if (ran !== undefined) {
      await connection.run(
        sql`CREATE TABLE migrations (id integer primary key, migration text, batch integer)`,
      )
      for (const name of ran)
        await connection.run(sql`INSERT INTO migrations (migration, batch) VALUES (${name}, 1)`)
    }
    return contextFor({ basePath, services: new Map([[DatabaseConnectionToken, connection]]) })
  }
  const users = '2026_01_01_000000_create_users_table'
  const posts = '2026_01_02_000000_create_posts_table'

  it('is ok when every file ran', async () => {
    const result = await migrationsCheck().run(
      await setup([`${users}.ts`, `${posts}.ts`, 'README.md'], [users, posts]),
    )
    expect(result).toMatchObject({ status: 'ok', summary: '2 ran', meta: { pending: 0 } })
  })

  it('fails on pending migrations, naming the first and the command', async () => {
    const result = await migrationsCheck().run(await setup([`${users}.ts`, `${posts}.ts`], [users]))
    expect(result).toMatchObject({ status: 'failed', summary: '1 pending' })
    expect(result.message).toContain(posts)
    expect(result.message).toContain('node strut migrate')
  })

  it('treats a missing migrations table as "nothing ran"', async () => {
    const result = await migrationsCheck().run(await setup([`${users}.ts`], undefined))
    expect(result).toMatchObject({ status: 'failed', summary: '1 pending' })
  })

  it('warns when a migration ran but its file is gone', async () => {
    const result = await migrationsCheck().run(await setup([`${users}.ts`], [users, posts]))
    expect(result).toMatchObject({ status: 'warning', summary: '1 without a file' })
  })

  it('skips without a migrations folder, fails without a connection, rethrows other errors', async () => {
    expect((await migrationsCheck().run(contextFor())).status).toBe('skipped')
    const basePath = tempDir()
    mkdirSync(join(basePath, 'database', 'migrations'), { recursive: true })
    expect((await migrationsCheck().run(contextFor({ basePath }))).summary).toBe('not configured')
    const closed = sqliteConnection()
    await closed.close()
    await expect(
      migrationsCheck().run(
        contextFor({ basePath, services: new Map([[DatabaseConnectionToken, closed]]) }),
      ),
    ).rejects.toThrow()
  })

  it('reads only Laravel-named files and refuses folders outside the app', () => {
    expect(migrationNames([`${users}.ts`, `${users}.js`, 'x.ts', '2026_01_01_create.ts'])).toEqual([
      users,
    ])
    expectBootError(() => migrationsCheck({ directory: '../elsewhere' }), /inside the app/)
  })
})

describe('cache', () => {
  function manager(clock = new StepClock()) {
    return createCacheManager({ basePath: tempDir(), clock, config: { default: 'memory' } })
  }

  it('writes, reads back and removes its probe', async () => {
    const cache = manager()
    const result = await cacheCheck().run(
      contextFor({ services: new Map([[CacheManagerToken, cache]]) }),
    )
    expect(result).toMatchObject({ status: 'ok', meta: { store: 'memory' } })
    // the file store too, on a real folder
    const file = await cacheCheck({ store: 'file' }).run(
      contextFor({ services: new Map([[CacheManagerToken, cache]]) }),
    )
    expect(file.status).toBe('ok')
  })

  it('leaves no probe behind', async () => {
    const basePath = tempDir()
    const cache = createCacheManager({
      basePath,
      clock: new StepClock(),
      config: { default: 'file' },
    })
    await cacheCheck().run(contextFor({ services: new Map([[CacheManagerToken, cache]]) }))
    const folder = join(basePath, 'storage', 'framework', 'cache')
    const leftovers = readdirSync(folder, { recursive: true }).filter((entry) =>
      String(entry).includes('health'),
    )
    expect(leftovers).toEqual([])
  })

  it('fails on a read mismatch or an error, skips without a cache, fails on an unknown store', async () => {
    const broken = (behaviour: Partial<CacheStore>) => ({
      defaultStore: 'x',
      storeNames: ['x'],
      store: (): CacheStore => ({
        get: async () => 'other',
        has: async () => false,
        put: async () => undefined,
        add: async () => true,
        increment: async () => 1,
        ttl: async () => undefined,
        forget: async () => {
          throw new Error('cannot delete')
        },
        flush: async () => undefined,
        ...behaviour,
      }),
    })
    const mismatch = await cacheCheck().run(
      contextFor({ services: new Map([[CacheManagerToken, broken({})]]) }),
    )
    expect(mismatch).toMatchObject({ status: 'failed', summary: 'read mismatch' })
    const failing = await cacheCheck().run(
      contextFor({
        services: new Map([
          [
            CacheManagerToken,
            broken({
              put: async () => {
                throw new Error('disk full')
              },
            }),
          ],
        ]),
      }),
    )
    expect(failing).toMatchObject({ status: 'failed', summary: 'unavailable' })
    expect(failing.message).toContain('disk full')
    expect((await cacheCheck().run(contextFor())).status).toBe('skipped')
    const unknown = await cacheCheck({ store: 'redis' }).run(
      contextFor({ services: new Map([[CacheManagerToken, manager()]]) }),
    )
    expect(unknown).toMatchObject({ status: 'failed', summary: 'unknown store' })
  })

  it('rates slow round trips', async () => {
    const clock = new StepClock()
    const cache = manager(clock)
    let calls = 0
    const now = () => {
      calls += 1
      if (calls === 2) clock.advance(300)
      return clock.now()
    }
    const result = await cacheCheck({ warnMs: 100, failMs: 1000 }).run(
      contextFor({ services: new Map([[CacheManagerToken, cache]]), now }),
    )
    expect(result.status).toBe('warning')
    expect(CACHE_PROBE_PREFIX).toBe('health:probe:')
    expectBootError(() => cacheCheck({ warnMs: 10, failMs: 1 }), /cacheCheck/)
  })
})

describe('disk-space', () => {
  const stats = (usedPercent: number) => async () => ({
    blocks: 1000,
    bavail: 1000 - usedPercent * 10,
    bsize: 4096,
  })

  it('measures a real folder', async () => {
    const basePath = tempDir()
    mkdirSync(join(basePath, 'storage'))
    const result = await diskSpaceCheck({ warnPercent: 100, failPercent: 100 }).run(
      contextFor({ basePath }),
    )
    expect(['ok', 'warning', 'failed']).toContain(result.status)
    expect(typeof result.meta['usedPercent']).toBe('number')
  })

  it('rates the share used', async () => {
    expect((await diskSpaceCheck({ statfs: stats(50) }).run(contextFor())).status).toBe('ok')
    const warn = await diskSpaceCheck({ statfs: stats(75) }).run(contextFor())
    expect(warn).toMatchObject({ status: 'warning', meta: { usedPercent: 75 } })
    expect(warn.summary).toMatch(/^75% used, \d+ MB free$/)
    expect((await diskSpaceCheck({ statfs: stats(95) }).run(contextFor())).status).toBe('failed')
  })

  it('fails when the folder is missing or the numbers are nonsense', async () => {
    const missing = await diskSpaceCheck().run(contextFor())
    expect(missing).toMatchObject({ status: 'failed', summary: 'unreadable' })
    const zero = await diskSpaceCheck({
      statfs: async () => ({ blocks: 0, bavail: 0, bsize: 0 }),
    }).run(contextFor())
    expect(zero.status).toBe('failed')
  })

  it('refuses bad options', () => {
    expectBootError(() => diskSpaceCheck({ path: '/etc' }), /inside the app/)
    expectBootError(() => diskSpaceCheck({ warnPercent: 95, failPercent: 90 }), /warnAt/)
    expectBootError(() => diskSpaceCheck({ warnPercent: 95, failPercent: 120 }), /at most 100/)
  })
})

describe('storage', () => {
  it('is ok when the folders are writable, and leaves no probe files', async () => {
    const basePath = tempDir()
    mkdirSync(join(basePath, 'storage', 'framework'), { recursive: true })
    mkdirSync(join(basePath, 'storage', 'logs'), { recursive: true })
    const result = await storageCheck().run(contextFor({ basePath }))
    expect(result).toMatchObject({ status: 'ok', summary: '2 writable' })
    expect(readdirSync(join(basePath, 'storage', 'logs'))).toEqual([])
  })

  it('fails naming each folder that is missing (or is a file)', async () => {
    const basePath = tempDir()
    mkdirSync(join(basePath, 'storage'), { recursive: true })
    writeFileSync(join(basePath, 'storage', 'logs'), 'not a folder')
    const result = await storageCheck().run(contextFor({ basePath }))
    expect(result).toMatchObject({ status: 'failed', summary: '2 of 2 not writable' })
    expect(result.message).toContain('storage/framework: ENOENT')
    expect(result.message).toMatch(/storage\/logs: E(NOTDIR|NOENT)/)
  })

  it('probes a storage disk too', async () => {
    const basePath = tempDir()
    const disk = createMemoryDisk({ name: 'local' })
    const storage = createStorageManager({ default: 'local', disks: [disk] })
    const ok = await storageCheck({ paths: [], disk: 'local' }).run(
      contextFor({ basePath, services: new Map([[StorageManagerToken, storage]]) }),
    )
    expect(ok).toMatchObject({ status: 'ok', summary: '1 writable' })
    expect((await disk.list('health-checks')).items).toEqual([])
    const unknown = await storageCheck({ paths: [], disk: 's3' }).run(
      contextFor({ basePath, services: new Map([[StorageManagerToken, storage]]) }),
    )
    expect(unknown.message).toMatch(/disk "s3": Unknown storage disk/)
    const unbound = await storageCheck({ paths: [], disk: 'local' }).run(contextFor({ basePath }))
    expect(unbound.message).toMatch(/no storage manager/)
  })

  it('reports a disk that fails to write or reads back garbage', async () => {
    const disk = createMemoryDisk({ name: 'local' })
    const failing = { ...disk, put: async () => Promise.reject(new Error('quota exceeded')) }
    const lying = {
      ...disk,
      get: async () => new Response('garbage').body as ReadableStream<Uint8Array>,
    }
    for (const [bad, pattern] of [
      [failing, /quota exceeded/],
      [lying, /different value/],
    ] as const) {
      const storage = createStorageManager({ default: 'local', disks: [bad] })
      const result = await storageCheck({ paths: [], disk: 'local' }).run(
        contextFor({ services: new Map([[StorageManagerToken, storage]]) }),
      )
      expect(result.message).toMatch(pattern)
    }
  })

  it('refuses paths outside the app', () => {
    expectBootError(() => storageCheck({ paths: ['storage/../../etc'] }), /inside the app/)
    expect(isContainedPath('C:\\Windows')).toBe(false)
    expect(isContainedPath('a\0b')).toBe(false)
    expect(isContainedPath(' ')).toBe(false)
  })
})

describe('app-key', () => {
  it('is ok with a valid key, from config or env', async () => {
    expect((await appKeyCheck().run(contextFor({ env: { APP_KEY: KEY } }))).status).toBe('ok')
    const fromConfig = await appKeyCheck().run(
      contextFor({ config: (path) => (path === 'app.key' ? KEY : undefined) }),
    )
    expect(fromConfig).toMatchObject({ status: 'ok', meta: { previousKeys: 0 } })
  })

  it('fails when missing or weak, and never echoes the value', async () => {
    const missing = await appKeyCheck().run(contextFor())
    expect(missing).toMatchObject({ status: 'failed', summary: 'APP_KEY is missing' })
    expect(missing.message).toContain('node strut key:generate')
    const weak = await appKeyCheck().run(contextFor({ env: { APP_KEY: 'short-weak-key' } }))
    expect(weak.status).toBe('failed')
    expect(JSON.stringify(weak)).not.toContain('short-weak-key')
  })

  it('validates previous keys', async () => {
    const good = `base64:${randomBytes(32).toString('base64')}`
    const ok = await appKeyCheck().run(
      contextFor({ env: { APP_KEY: KEY, APP_PREVIOUS_KEYS: ` ${good} ,` } }),
    )
    expect(ok.meta).toEqual({ previousKeys: 1 })
    const bad = await appKeyCheck().run(
      contextFor({ env: { APP_KEY: KEY, APP_PREVIOUS_KEYS: `${good},nope-not-a-key` } }),
    )
    expect(bad).toMatchObject({ status: 'failed', summary: 'APP_PREVIOUS_KEYS entry 2 is invalid' })
    expect(JSON.stringify(bad)).not.toContain('nope-not-a-key')
    const viaConfig = await appKeyCheck().run(
      contextFor({
        config: (path) =>
          path === 'app.key' ? KEY : path === 'app.previous_keys' ? 'x' : undefined,
      }),
    )
    expect(viaConfig.status).toBe('failed')
  })
})

describe('debug-mode', () => {
  const debugOn = (path: string) => (path === 'app.debug' ? true : undefined)
  it('fails in production, warns in staging, allows elsewhere', async () => {
    expect((await debugModeCheck().run(contextFor({ environment: 'production' }))).summary).toBe(
      'off',
    )
    expect(
      (await debugModeCheck().run(contextFor({ environment: 'production', config: debugOn })))
        .status,
    ).toBe('failed')
    expect(
      (await debugModeCheck().run(contextFor({ environment: 'staging', config: debugOn }))).status,
    ).toBe('warning')
    expect(
      (await debugModeCheck().run(contextFor({ environment: 'local', config: debugOn }))).status,
    ).toBe('ok')
    const custom = debugModeCheck({ failIn: ['staging'], warnIn: [] })
    expect((await custom.run(contextFor({ environment: 'staging', config: debugOn }))).status).toBe(
      'failed',
    )
  })
})

describe('environment', () => {
  function withExample(content: string) {
    const basePath = tempDir()
    writeFileSync(join(basePath, '.env.example'), content)
    return basePath
  }

  it('parses dotenv keys', () => {
    expect(
      envKeys('# c\nAPP_NAME=x\r\nexport DB_HOST = y\n\n  =bad\nAPP_NAME=dup\nlower_case=1'),
    ).toEqual(['APP_NAME', 'DB_HOST', 'lower_case'])
  })

  it('is ok when every key is defined (empty counts), lists missing names only', async () => {
    const basePath = withExample('APP_NAME=\nDB_PASSWORD=\nMAIL_HOST=\n')
    const ok = await environmentCheck().run(
      contextFor({ basePath, env: { APP_NAME: 'x', DB_PASSWORD: '', MAIL_HOST: 'm' } }),
    )
    expect(ok).toMatchObject({ status: 'ok', summary: '3 set' })
    const secret = randomBytes(8).toString('hex')
    const missing = await environmentCheck().run(
      contextFor({ basePath, env: { APP_NAME: secret } }),
    )
    expect(missing).toMatchObject({ status: 'failed', summary: '2 not set' })
    expect(missing.message).toContain('missing: DB_PASSWORD, MAIL_HOST')
    expect(JSON.stringify(missing)).not.toContain(secret)
  })

  it('honours ignore and required', async () => {
    const basePath = withExample('A=\nB=\n')
    const result = await environmentCheck({ ignore: ['B'], required: ['A', 'C'] }).run(
      contextFor({ basePath, env: { A: ' ' } }),
    )
    expect(result.message).toBe(
      "missing: C; empty but required: A. Set them in the server's environment (or .env); .env.example lists every setting.",
    )
  })

  it('lists at most ten names', async () => {
    const keys = Array.from({ length: 15 }, (_, i) => `KEY_${i}`)
    const result = await environmentCheck().run(
      contextFor({ basePath: withExample(keys.map((k) => `${k}=`).join('\n')) }),
    )
    expect(result.message).toContain('and 5 more')
  })

  it('skips without an example file and refuses paths outside the app', async () => {
    expect((await environmentCheck().run(contextFor())).status).toBe('skipped')
    expectBootError(() => environmentCheck({ example: '../.env.example' }), /inside the app/)
  })
})

describe('heartbeats', () => {
  it('reports the age of the last heartbeat', async () => {
    const clock = new StepClock()
    const cache = createCacheManager({ basePath: tempDir(), clock, config: { default: 'memory' } })
    const context = () =>
      contextFor({ services: new Map([[CacheManagerToken, cache]]), now: () => clock.now() })
    const check = heartbeatCheck({
      heartbeat: 'queue:default',
      warnAfterSeconds: 60,
      failAfterSeconds: 300,
    })
    expect(check.name).toBe('queue-default')
    expect((await check.run(context())).summary).toBe('no heartbeat')
    await recordHeartbeat(cache.store(), 'queue:default', clock.now())
    expect(await cache.store().get(`${HEARTBEAT_PREFIX}queue:default`)).toBe(clock.now())
    expect((await check.run(context())).status).toBe('ok')
    clock.advance(61_000)
    expect((await check.run(context())).status).toBe('warning')
    clock.advance(240_000)
    expect((await check.run(context())).summary).toBe('301 s ago')
    expect((await check.run(context())).status).toBe('failed')
  })

  it('validates names and thresholds, fails without a cache', async () => {
    const store = createCacheManager({ basePath: tempDir(), clock: new StepClock() }).store()
    await expect(recordHeartbeat(store, 'Bad Name', 0)).rejects.toThrow(/lowercase/)
    expectBootError(() => heartbeatCheck({ heartbeat: 'Scheduler' }), /lowercase/)
    expectBootError(
      () => heartbeatCheck({ heartbeat: 'scheduler', warnAfterSeconds: 10, failAfterSeconds: 5 }),
      /warnAt/,
    )
    expect((await heartbeatCheck({ heartbeat: 'scheduler' }).run(contextFor())).summary).toBe(
      'no cache',
    )
  })
})

describe('builtInChecks', () => {
  it('builds the enabled checks from settings, in a stable order', () => {
    const all = builtInChecks(resolveHealthSettings(undefined)).map((check) => check.name)
    expect(all).toEqual([
      'database',
      'migrations',
      'cache',
      'disk-space',
      'storage',
      'app-key',
      'debug-mode',
      'environment',
    ])
    const some = builtInChecks(
      resolveHealthSettings({
        checks: {
          database: { enabled: false },
          cache: { store: 'file' },
          storage: { disk: 'local' },
          heartbeats: ['scheduler'],
          environment: { enabled: false },
        },
      }),
    ).map((check) => check.name)
    expect(some).toEqual([
      'migrations',
      'cache',
      'disk-space',
      'storage',
      'app-key',
      'debug-mode',
      'scheduler',
    ])
  })
})
