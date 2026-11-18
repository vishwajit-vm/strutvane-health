/**
 * The migration `node strut add health` writes into the app's `database/migrations`, the
 * Laravel way: the app owns its schema, so a package's table arrives as an ordinary migration
 * file the developer can read, keep and run with `node strut migrate`.
 *
 * The file name carries a fixed timestamp, so installing twice (or in any order with other
 * packages) never creates a second copy: the installer only writes it when it is missing.
 *
 * @module
 */

/** The migration's file name (without folder). */
export const MIGRATION_FILE_NAME = '2026_11_18_000000_create_health_check_results_table.ts'

/** Where the installer writes it, relative to the app root. */
export const MIGRATION_PATH: string = `database/migrations/${MIGRATION_FILE_NAME}`

/**
 * The migration's source. Columns:
 * - `batch`: the run id; every check of one run shares it.
 * - `check_name`, `check_label`, `status`, `summary`, `message`: the sanitized result.
 * - `meta`: the result's details as JSON text (text, not a JSON column, so all dialects agree).
 * - `duration_ms`, `ran_at` (epoch milliseconds, UTC).
 *
 * @example
 * await writeFile(join(root, MIGRATION_PATH), MIGRATION_SOURCE)
 */
export const MIGRATION_SOURCE: string = `import { migration } from '@strutvane/framework/schema'

// The history of health check results (@strutvane/health). One row per check per run; the rows of
// one run share a batch id. \`node strut health:check\` prunes rows older than history.keep_days
// (config/health.ts), so the table stays small.
export default migration({
  up(schema) {
    schema.create('health_check_results', (t) => {
      t.id()
      t.string('batch', 36).index()
      t.string('check_name', 64)
      t.string('check_label', 255)
      t.string('status', 16)
      t.string('summary', 255)
      t.text('message').nullable()
      t.text('meta').nullable()
      t.integer('duration_ms')
      t.bigInteger('ran_at').index()
      t.index(['check_name', 'ran_at'])
    })
  },
  down(schema) {
    schema.dropIfExists('health_check_results')
  },
})
`
