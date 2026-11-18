/**
 * The built-in checks an app gets from `config/health.ts`, in a stable order.
 *
 * @module
 */
import type { HealthCheck } from '../check.ts'
import type { HealthSettings } from '../settings.ts'
import { appKeyCheck } from './app-key.ts'
import { cacheCheck } from './cache.ts'
import { databaseCheck } from './database.ts'
import { debugModeCheck } from './debug-mode.ts'
import { diskSpaceCheck } from './disk-space.ts'
import { environmentCheck } from './environment.ts'
import { heartbeatCheck } from './heartbeat.ts'
import { migrationsCheck } from './migrations.ts'
import { storageCheck } from './storage.ts'

/**
 * The enabled built-in checks for these settings.
 *
 * @example
 * builtInChecks(resolveHealthSettings(app.config('health'))).map((check) => check.name)
 * // ['database', 'migrations', 'cache', 'disk-space', 'storage', 'app-key', 'debug-mode', 'environment']
 */
export function builtInChecks(settings: HealthSettings): HealthCheck[] {
  const { checks } = settings
  const out: HealthCheck[] = []
  if (checks.database.enabled)
    out.push(databaseCheck({ warnMs: checks.database.warnMs, failMs: checks.database.failMs }))
  if (checks.migrations.enabled) out.push(migrationsCheck())
  if (checks.cache.enabled)
    out.push(cacheCheck(checks.cache.store === undefined ? {} : { store: checks.cache.store }))
  if (checks.diskSpace.enabled)
    out.push(
      diskSpaceCheck({
        path: checks.diskSpace.path,
        warnPercent: checks.diskSpace.warnPercent,
        failPercent: checks.diskSpace.failPercent,
      }),
    )
  if (checks.storage.enabled)
    out.push(
      storageCheck({
        paths: checks.storage.paths,
        ...(checks.storage.disk === undefined ? {} : { disk: checks.storage.disk }),
      }),
    )
  if (checks.appKey.enabled) out.push(appKeyCheck())
  if (checks.debugMode.enabled) out.push(debugModeCheck())
  if (checks.environment.enabled)
    out.push(
      environmentCheck({
        ignore: checks.environment.ignore,
        required: checks.environment.required,
      }),
    )
  for (const heartbeat of checks.heartbeats) out.push(heartbeatCheck({ heartbeat }))
  return out
}
