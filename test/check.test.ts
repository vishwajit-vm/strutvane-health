import { isBootError } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import {
  CHECK_NAME,
  checkLabel,
  checkProblem,
  defineCheck,
  MAX_CHECK_NAME_LENGTH,
  MAX_CHECK_TIMEOUT_MS,
} from '../src/check.ts'
import { Result } from '../src/result.ts'

const run = () => Result.ok()

describe('defineCheck', () => {
  it('returns a valid check unchanged', () => {
    const check = { name: 'payments-api', label: 'Payments API', timeoutMs: 2000, run }
    expect(defineCheck(check)).toBe(check)
    expect(checkLabel(check)).toBe('Payments API')
    expect(checkLabel({ name: 'db' })).toBe('db')
  })

  it.each([
    ['Bad Name'],
    ['-leading'],
    ['trailing-'],
    ['double--dash'],
    ['under_score'],
    ['a'.repeat(MAX_CHECK_NAME_LENGTH + 1)],
    [''],
  ])('refuses the name %j with a BootError that says how to fix it', (name) => {
    let thrown: unknown
    try {
      defineCheck({ name, run })
    } catch (error) {
      thrown = error
    }
    expect(isBootError(thrown)).toBe(true)
    expect((thrown as Error).message).toMatch(/kebab-case/)
  })

  it('refuses bad labels, timeouts and missing run functions', () => {
    expect(checkProblem(null)).toMatch(/object/)
    expect(checkProblem({ name: 'a', label: ' ', run })).toMatch(/label/)
    expect(checkProblem({ name: 'a', label: 'x'.repeat(101), run })).toMatch(/label/)
    expect(checkProblem({ name: 'a', timeoutMs: 0, run })).toMatch(/timeoutMs/)
    expect(checkProblem({ name: 'a', timeoutMs: 1.5, run })).toMatch(/timeoutMs/)
    expect(checkProblem({ name: 'a', timeoutMs: MAX_CHECK_TIMEOUT_MS + 1, run })).toMatch(
      /timeoutMs/,
    )
    expect(checkProblem({ name: 'a' })).toMatch(/run must be a function/)
    expect(checkProblem({ name: 'a', run })).toBeUndefined()
    expect(CHECK_NAME.test('disk-space2')).toBe(true)
  })
})
