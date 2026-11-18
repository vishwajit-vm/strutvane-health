/**
 * `@strutvane/health`: application health checks for Strutvane apps.
 *
 * - Built-in checks: database (reachable + latency), migrations (none pending), cache
 *   (read/write), disk space, storage (writable folders and disks), app key, debug mode in
 *   production, environment complete, heartbeats (scheduler/queue).
 * - Custom checks: `defineCheck({ name, run })` returning `Result.ok/warning/failed/skipped`.
 * - History in the `health_check_results` table, ok/warning/failed thresholds, rate-limited
 *   alerts (Slack, webhooks, mail), `node strut health:check` with CI exit codes, and a JSON
 *   endpoint behind a token or your policy (never public; `/up` stays the liveness probe).
 *
 * The provider is on its own subpath (`@strutvane/health/provider`), the CLI commands on
 * `/commands` and the installer on `/installer`.
 *
 * @packageDocumentation
 */
export {
  CHECK_NAME,
  type CheckContext,
  checkLabel,
  checkProblem,
  defineCheck,
  type HealthCheck,
  MAX_CHECK_NAME_LENGTH,
  MAX_CHECK_TIMEOUT_MS,
} from './check.ts'
export { type AppKeyCheckOptions, appKeyCheck } from './checks/app-key.ts'
export { builtInChecks } from './checks/built-in.ts'
export { CACHE_PROBE_PREFIX, type CacheCheckOptions, cacheCheck } from './checks/cache.ts'
export { type DatabaseCheckOptions, databaseCheck } from './checks/database.ts'
export { type DebugModeCheckOptions, debugModeCheck } from './checks/debug-mode.ts'
export { type DiskSpaceCheckOptions, type DiskStats, diskSpaceCheck } from './checks/disk-space.ts'
export {
  type EnvironmentCheckOptions,
  environmentCheck,
  envKeys,
} from './checks/environment.ts'
export {
  HEARTBEAT_PREFIX,
  type HeartbeatCheckOptions,
  heartbeatCheck,
  recordHeartbeat,
} from './checks/heartbeat.ts'
export {
  type MigrationsCheckOptions,
  migrationNames,
  migrationsCheck,
} from './checks/migrations.ts'
export {
  DEFAULT_WRITABLE_PATHS,
  type StorageCheckOptions,
  storageCheck,
} from './checks/storage.ts'
export {
  Health,
  type HealthAuthorizer,
  type HealthOptions,
  HealthToken,
  type RunOptions,
  type RunOutcome,
  UnknownCheckError,
} from './health.ts'
export { MIGRATION_FILE_NAME, MIGRATION_PATH, MIGRATION_SOURCE } from './history/migration-stub.ts'
export {
  DatabaseResultStore,
  MAX_HISTORY_ROWS,
  MemoryResultStore,
  RESULTS_TABLE,
  type ResultStore,
  type StoredRun,
} from './history/store.ts'
export { type EndpointOptions, healthEndpoint, presentedToken } from './http/endpoint.ts'
export {
  type HealthMail,
  type HealthNotification,
  type MailChannelOptions,
  mailChannel,
  type NotificationChannel,
  type SlackChannelOptions,
  signature,
  slackChannel,
  type WebhookChannelOptions,
  webhookChannel,
} from './notify/channels.ts'
export { Notifier, type NotifierOptions, type NotifyOutcome } from './notify/notifier.ts'
export { type CheckRun, createReport, type HealthReport, publicReport } from './report.ts'
export {
  type CheckResult,
  HEALTH_STATUSES,
  type HealthStatus,
  isHealthStatus,
  type MetaValue,
  Result,
  type ResultMeta,
  severity,
  type Thresholds,
  thresholdProblem,
  thresholdStatus,
  worstStatus,
} from './result.ts'
export { DEFAULT_CHECK_TIMEOUT_MS, failureFrom, runChecks } from './runner.ts'
export { sanitizeMeta, sanitizeResult, sanitizeText, secretValues } from './sanitize.ts'
export { type HealthSettings, MIN_TOKEN_LENGTH, resolveHealthSettings } from './settings.ts'
