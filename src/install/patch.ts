/**
 * Small, careful text edits of the two app files the installer touches:
 * `bootstrap/providers.ts` (the provider list) and `config/index.ts` (the config files).
 *
 * The framework's installer kit patches v1's `strutvane.config.ts`; v2 apps list providers in
 * `bootstrap/providers.ts` instead, so this package edits that file itself, the same way:
 * - **Only the shapes the skeleton generates are edited** (one `[...]` array literal assigned to
 *   `providers`, one `export default { ... }` object in `config/index.ts`). Anything else is
 *   left alone and the installer prints the one line to add by hand: never a guess.
 * - **Idempotent:** a file that already has the import is returned unchanged.
 * - **Reversible:** `remove*` undoes exactly what `add*` did.
 * - The file's own quote and semicolon style is kept.
 *
 * @module
 */

/**
 * One edit: what to import and the name to add to a list.
 *
 * @example
 * const edit: ListEdit = { importLine: "import { HealthServiceProvider } from '@strutvane/health/provider'", name: 'HealthServiceProvider' }
 */
export interface ListEdit {
  readonly importLine: string
  readonly name: string
}

/** The provider edit the installer makes. */
export const PROVIDER_EDIT: ListEdit = {
  importLine: "import { HealthServiceProvider } from '@strutvane/health/provider'",
  name: 'HealthServiceProvider',
}

/** The config-index edit the installer makes. */
export const CONFIG_INDEX_EDIT: ListEdit = {
  importLine: "import health from './health.ts'",
  name: 'health',
}

const PROVIDERS_ARRAY = /(const\s+providers\b[^=]*=\s*\[)([^\]]*)(\])/
const CONFIG_OBJECT = /(export\s+default\s+\{)([^}]*)(\})/

/**
 * Add the provider to `bootstrap/providers.ts`. Returns the new source, the same source when it
 * is already there, or `undefined` when the file's shape is not recognised.
 *
 * @example
 * addToProviders(source, PROVIDER_EDIT)
 */
export function addToProviders(source: string, edit: ListEdit): string | undefined {
  return addEntry(source, edit, PROVIDERS_ARRAY)
}

/**
 * Add the config file to `config/index.ts`'s default export object.
 *
 * @example
 * addToConfigIndex(source, CONFIG_INDEX_EDIT)
 */
export function addToConfigIndex(source: string, edit: ListEdit): string | undefined {
  return addEntry(source, edit, CONFIG_OBJECT)
}

/**
 * Undo {@link addToProviders}. Unrecognised files are returned unchanged.
 *
 * @example
 * removeFromProviders(source, PROVIDER_EDIT)
 */
export function removeFromProviders(source: string, edit: ListEdit): string {
  return removeEntry(source, edit, PROVIDERS_ARRAY)
}

/**
 * Undo {@link addToConfigIndex}. Unrecognised files are returned unchanged.
 *
 * @example
 * removeFromConfigIndex(source, CONFIG_INDEX_EDIT)
 */
export function removeFromConfigIndex(source: string, edit: ListEdit): string {
  return removeEntry(source, edit, CONFIG_OBJECT)
}

function styled(source: string, importLine: string): string {
  const usesDouble = /^import[^\n]*"[^"\n]*"\s*;?\s*$/m.test(source)
  const usesSemicolons = /^import[^\n]*['"]\s*;\s*$/m.test(source)
  let line = usesDouble ? importLine.replace(/'/g, '"') : importLine
  if (usesSemicolons) line += ';'
  return line
}

function hasImport(source: string, importLine: string): boolean {
  const specifier = /from\s+'([^']+)'/.exec(importLine)?.[1]
  if (specifier === undefined) return false
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^import[^\\n]*from\\s+['"]${escaped}['"]`, 'm').test(source)
}

function addEntry(source: string, edit: ListEdit, list: RegExp): string | undefined {
  if (hasImport(source, edit.importLine)) return source
  const match = list.exec(source)
  if (match === null || match.index === undefined) return undefined
  const [whole, open = '', body = '', close = ''] = match
  if (new RegExp(`\\b${edit.name}\\b`).test(body)) return undefined
  const trimmed = body.replace(/\s+$/, '')
  const multiline = body.includes('\n')
  let nextBody: string
  if (trimmed.trim() === '') nextBody = multiline ? `\n  ${edit.name},\n` : edit.name
  else if (multiline) {
    const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '  '
    const separator = trimmed.endsWith(',') ? '' : ','
    nextBody = `${trimmed}${separator}\n${indent}${edit.name},\n`
  } else {
    const inner = trimmed.trim().replace(/,$/, '')
    const pad = body.startsWith(' ') ? ' ' : ''
    nextBody = `${pad}${inner}, ${edit.name}${pad}`
  }
  const edited =
    source.slice(0, match.index) +
    open +
    nextBody +
    close +
    source.slice(match.index + whole.length)
  return insertImport(edited, styled(source, edit.importLine))
}

function insertImport(source: string, line: string): string {
  const imports = [...source.matchAll(/^import[^\n]*\n/gm)]
  const last = imports.at(-1)
  if (last === undefined || last.index === undefined) return `${line}\n${source}`
  const at = last.index + last[0].length
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`
}

function removeEntry(source: string, edit: ListEdit, list: RegExp): string {
  if (!hasImport(source, edit.importLine)) return source
  const specifier = /from\s+'([^']+)'/.exec(edit.importLine)?.[1] ?? ''
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = source.replace(
    new RegExp(`^import[^\\n]*from\\s+['"]${escaped}['"];?[ \\t]*\\r?\\n`, 'm'),
    '',
  )
  const match = list.exec(out)
  if (match === null || match.index === undefined) return out
  const [whole, open = '', body = '', close = ''] = match
  const name = edit.name
  const nextBody = body
    .replace(new RegExp(`\\n[ \\t]*${name}[ \\t]*,?[ \\t]*(?=\\n)`), '')
    // `, Name` in a one-line list; the blanks after it belong to the list, so they stay.
    .replace(new RegExp(`,[ \\t]*${name}\\b(?=\\s*(?:,|$))`), '')
    .replace(new RegExp(`^(\\s*)${name}\\b\\s*,?\\s*`), '$1')
  out = out.slice(0, match.index) + open + nextBody + close + out.slice(match.index + whole.length)
  return out
}
