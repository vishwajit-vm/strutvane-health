/**
 * The installer through the framework's real installer kit (staged, transactional writes), on a
 * skeleton-shaped app, plus the text patcher on every shape it must (and must not) edit.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkIdempotent, runInstaller } from '@strutvane/framework/devkit'
import { describe, expect, it } from 'vitest'
import { MIGRATION_PATH } from '../src/history/migration-stub.ts'
import { CONFIG_PATH, CONFIG_SOURCE } from '../src/install/config-stub.ts'
import {
  addToConfigIndex,
  addToProviders,
  CONFIG_INDEX_EDIT,
  PROVIDER_EDIT,
  removeFromConfigIndex,
  removeFromProviders,
} from '../src/install/patch.ts'
import installerDefault, { installer } from '../src/installer.ts'
import { tempDir } from './helpers.ts'

const PROVIDERS = `// The service providers that run at boot.
import type { AnyProvider } from '@strutvane/framework'
import { AppServiceProvider } from '../app/providers/app.provider.ts'

const providers: readonly AnyProvider[] = [AppServiceProvider]

export default providers
`

const CONFIG_INDEX = `import type { ConfigFiles } from '@strutvane/framework'
import app from './app.ts'
import cache from './cache.ts'

export default { app, cache } satisfies ConfigFiles
`

function skeleton(): string {
  const root = tempDir('health-install-')
  mkdirSync(join(root, 'bootstrap'), { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'database', 'migrations'), { recursive: true })
  writeFileSync(join(root, 'bootstrap', 'providers.ts'), PROVIDERS)
  writeFileSync(join(root, 'config', 'index.ts'), CONFIG_INDEX)
  writeFileSync(join(root, '.env'), 'APP_NAME=Blog\n')
  writeFileSync(join(root, '.env.example'), 'APP_NAME=\n')
  writeFileSync(join(root, 'package.json'), '{ "name": "blog", "private": true }\n')
  return root
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')

describe('installer', () => {
  it('writes config, migration, env token and registers provider + config', async () => {
    const root = skeleton()
    const result = await runInstaller(installer, { projectRoot: root })
    expect(result.committed).toBe(true)
    expect(read(root, CONFIG_PATH)).toBe(CONFIG_SOURCE)
    expect(read(root, MIGRATION_PATH)).toContain("schema.create('health_check_results'")
    const env = read(root, '.env')
    const token = /^HEALTH_CHECK_TOKEN=(.+)$/m.exec(env)?.[1] ?? ''
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(read(root, '.env.example')).toMatch(/^HEALTH_CHECK_TOKEN=$/m)
    expect(read(root, '.env.example')).not.toContain(token)
    expect(read(root, 'bootstrap/providers.ts')).toContain(
      "import { HealthServiceProvider } from '@strutvane/health/provider'",
    )
    expect(read(root, 'bootstrap/providers.ts')).toContain(
      '[AppServiceProvider, HealthServiceProvider]',
    )
    expect(read(root, 'config/index.ts')).toContain("import health from './health.ts'")
    expect(read(root, 'config/index.ts')).toContain('{ app, cache, health }')
    expect(result.messages.map((message) => message.message).join('\n')).toContain(
      'node strut migrate',
    )
    expect(installerDefault).toBe(installer)
  })

  it('is idempotent (a second run changes nothing) and keeps an existing config', async () => {
    const root = skeleton()
    await checkIdempotent(installer, { projectRoot: root })
    writeFileSync(join(root, CONFIG_PATH), '// mine\n')
    const again = await runInstaller(installer, { projectRoot: root })
    expect(read(root, CONFIG_PATH)).toBe('// mine\n')
    expect(again.messages.some((message) => message.message.includes('kept as it is'))).toBe(true)
  })

  it('leaves unrecognised files alone and says what to add', async () => {
    const root = skeleton()
    writeFileSync(join(root, 'bootstrap', 'providers.ts'), 'export default loadProviders()\n')
    rmSync(join(root, 'config', 'index.ts'))
    const result = await runInstaller(installer, { projectRoot: root })
    expect(read(root, 'bootstrap/providers.ts')).toBe('export default loadProviders()\n')
    const warnings = result.messages
      .filter((message) => message.level === 'warn')
      .map((message) => message.message)
    expect(warnings.join('\n')).toContain(
      'bootstrap/providers.ts has a shape the installer does not edit',
    )
    expect(warnings.join('\n')).toContain('config/index.ts not found')
  })

  it('uninstall removes the provider, config entry and env key; keeps config, migration and data', async () => {
    const root = skeleton()
    await runInstaller(installer, { projectRoot: root })
    await runInstaller(installer, { projectRoot: root, mode: 'uninstall' })
    expect(read(root, 'bootstrap/providers.ts')).toBe(PROVIDERS)
    expect(read(root, 'config/index.ts')).toBe(CONFIG_INDEX)
    expect(read(root, '.env')).not.toContain('HEALTH_CHECK_TOKEN')
    expect(existsSync(join(root, CONFIG_PATH))).toBe(true)
    expect(existsSync(join(root, MIGRATION_PATH))).toBe(true)
  })

  it('a dry run writes nothing', async () => {
    const root = skeleton()
    const result = await runInstaller(installer, { projectRoot: root, dryRun: true })
    expect(result.committed).toBe(false)
    expect(existsSync(join(root, CONFIG_PATH))).toBe(false)
    expect(read(root, 'bootstrap/providers.ts')).toBe(PROVIDERS)
  })
})

describe('patch', () => {
  it('adds to a one-line list and an empty list, keeping quote and semicolon style', () => {
    expect(addToProviders(PROVIDERS, PROVIDER_EDIT)).toContain(
      '[AppServiceProvider, HealthServiceProvider]',
    )
    const empty = addToProviders(
      'import type { AnyProvider } from "x";\nconst providers: AnyProvider[] = []\n',
      PROVIDER_EDIT,
    )
    expect(empty).toContain('= [HealthServiceProvider]')
    expect(empty).toContain('import { HealthServiceProvider } from "@strutvane/health/provider";')
    expect(addToProviders('const providers = [ A ]\n', PROVIDER_EDIT)).toBe(
      "import { HealthServiceProvider } from '@strutvane/health/provider'\nconst providers = [ A, HealthServiceProvider ]\n",
    )
  })

  it('adds to a multi-line list with its indentation and trailing comma', () => {
    const source = "import x from 'x'\n\nconst providers = [\n    A,\n    B,\n]\n"
    const out = addToProviders(source, PROVIDER_EDIT)
    expect(out).toContain('const providers = [\n    A,\n    B,\n    HealthServiceProvider,\n]')
    expect(addToProviders('const providers = [\n  A\n]\n', PROVIDER_EDIT)).toContain(
      '[\n  A,\n  HealthServiceProvider,\n]',
    )
    expect(addToProviders('const providers = [\n]\n', PROVIDER_EDIT)).toContain(
      '[\n  HealthServiceProvider,\n]',
    )
  })

  it('is idempotent, refuses a name already listed without our import, and unknown shapes', () => {
    const once = addToProviders(PROVIDERS, PROVIDER_EDIT) ?? ''
    expect(addToProviders(once, PROVIDER_EDIT)).toBe(once)
    expect(
      addToProviders('const providers = [HealthServiceProvider]\n', PROVIDER_EDIT),
    ).toBeUndefined()
    expect(addToProviders('export default []\n', PROVIDER_EDIT)).toBeUndefined()
    expect(addToConfigIndex('export default config\n', CONFIG_INDEX_EDIT)).toBeUndefined()
  })

  it('removal restores the original byte for byte, in every list shape', () => {
    for (const source of [
      PROVIDERS,
      "import x from 'x'\nconst providers = [\n  A,\n  B,\n]\n",
      "import x from 'x'\nconst providers = []\n",
    ]) {
      const added = addToProviders(source, PROVIDER_EDIT) ?? ''
      expect(removeFromProviders(added, PROVIDER_EDIT)).toBe(source)
    }
    const config = addToConfigIndex(CONFIG_INDEX, CONFIG_INDEX_EDIT) ?? ''
    expect(removeFromConfigIndex(config, CONFIG_INDEX_EDIT)).toBe(CONFIG_INDEX)
    expect(removeFromProviders(PROVIDERS, PROVIDER_EDIT)).toBe(PROVIDERS)
    expect(
      removeFromProviders(
        "import { HealthServiceProvider } from '@strutvane/health/provider'\nexport default x\n",
        PROVIDER_EDIT,
      ),
    ).toBe('export default x\n')
  })

  it('puts the import first in a file without imports', () => {
    expect(addToProviders('const providers = []\n', PROVIDER_EDIT)).toBe(
      "import { HealthServiceProvider } from '@strutvane/health/provider'\nconst providers = [HealthServiceProvider]\n",
    )
  })
})
