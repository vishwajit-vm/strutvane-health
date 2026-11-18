/**
 * `@strutvane/health/installer`: what `node strut add health` (and `node strut install:health`
 * once the framework ships it) does to an app. Declared in package.json `strutvane.installer`.
 *
 * Install:
 * 1. writes `config/health.ts` (never overwriting yours);
 * 2. writes the `create_health_check_results_table` migration into `database/migrations`
 *    (fixed name, so installing twice never makes a second copy);
 * 3. adds `HEALTH_CHECK_TOKEN` to `.env` (a random secret) and `.env.example` (empty);
 * 4. lists `HealthServiceProvider` in `bootstrap/providers.ts` and `health` in `config/index.ts`.
 *
 * Every step is idempotent and independent of other packages, so the install order never
 * changes the result (ECOSYSTEM rule 3). A file in a shape the installer doesn't recognise is
 * left untouched, with the exact line to add printed instead.
 *
 * Uninstall removes the provider, the config-index entry and the env key, and keeps
 * `config/health.ts`, the migration and the table: history is data, and dropping a table is a
 * decision for a migration, not an uninstaller.
 *
 * @module
 */
import type { DevkitInstallContext, DevkitInstaller } from '@strutvane/framework/devkit'
import { MIGRATION_PATH, MIGRATION_SOURCE } from './history/migration-stub.ts'
import { CONFIG_PATH, CONFIG_SOURCE } from './install/config-stub.ts'
import {
  addToConfigIndex,
  addToProviders,
  CONFIG_INDEX_EDIT,
  type ListEdit,
  PROVIDER_EDIT,
  removeFromConfigIndex,
  removeFromProviders,
} from './install/patch.ts'

const PROVIDERS_FILE = 'bootstrap/providers.ts'
const CONFIG_INDEX_FILE = 'config/index.ts'
const ENV_KEYS = ['HEALTH_CHECK_TOKEN'] as const

/**
 * The installer (see the module docs).
 *
 * @example
 * await runInstaller(installer, { projectRoot: '/srv/blog' })
 */
export const installer: DevkitInstaller = {
  name: '@strutvane/health',
  description: 'Health checks: config, results table migration, endpoint token and provider',
  async install(ctx: DevkitInstallContext): Promise<void> {
    if (await ctx.fs.exists(CONFIG_PATH)) ctx.log.info(`${CONFIG_PATH} exists; kept as it is.`)
    else await ctx.fs.write(CONFIG_PATH, CONFIG_SOURCE)
    if (!(await ctx.fs.exists(MIGRATION_PATH))) await ctx.fs.write(MIGRATION_PATH, MIGRATION_SOURCE)
    await ctx.env.add('Health checks (@strutvane/health)', [
      {
        key: 'HEALTH_CHECK_TOKEN',
        secret: true,
        comment: 'Monitors send it as "Authorization: Bearer <token>" to GET /health.json',
      },
    ])
    await patch(ctx, PROVIDERS_FILE, PROVIDER_EDIT, addToProviders)
    await patch(ctx, CONFIG_INDEX_FILE, CONFIG_INDEX_EDIT, addToConfigIndex)
    ctx.log.info('Run `node strut migrate` to create the health_check_results table.')
    ctx.log.info('Schedule `node strut health:check` every few minutes for history and alerts.')
  },
  async uninstall(ctx: DevkitInstallContext): Promise<void> {
    await unpatch(ctx, PROVIDERS_FILE, PROVIDER_EDIT, removeFromProviders)
    await unpatch(ctx, CONFIG_INDEX_FILE, CONFIG_INDEX_EDIT, removeFromConfigIndex)
    await ctx.env.remove(ENV_KEYS)
    ctx.log.info(
      `Kept ${CONFIG_PATH}, the migration and the health_check_results table (history is data). Remove them yourself if you no longer need them.`,
    )
  },
}

export default installer

async function patch(
  ctx: DevkitInstallContext,
  file: string,
  edit: ListEdit,
  apply: (source: string, edit: ListEdit) => string | undefined,
): Promise<void> {
  if (!(await ctx.fs.exists(file))) {
    ctx.log.warn(`${file} not found. Add by hand: ${edit.importLine}, and list ${edit.name}.`)
    return
  }
  const source = await ctx.fs.read(file)
  const next = apply(source, edit)
  if (next === undefined) {
    ctx.log.warn(
      `${file} has a shape the installer does not edit. Add by hand: ${edit.importLine}, and list ${edit.name}.`,
    )
    return
  }
  if (next !== source) await ctx.fs.write(file, next, { overwrite: true })
}

async function unpatch(
  ctx: DevkitInstallContext,
  file: string,
  edit: ListEdit,
  apply: (source: string, edit: ListEdit) => string,
): Promise<void> {
  if (!(await ctx.fs.exists(file))) return
  const source = await ctx.fs.read(file)
  const next = apply(source, edit)
  if (next !== source) await ctx.fs.write(file, next, { overwrite: true })
}
