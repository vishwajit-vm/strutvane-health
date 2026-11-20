/**
 * `ipBucket` must agree with the framework's `throttle` buckets (`ipBucket` in the framework's
 * `src/http/app/throttle.ts`, not exported by the published package). The first test is the
 * framework's own examples and test vectors, verbatim; the properties pin the /64 and
 * IPv4-mapped rules for every address.
 */
import { isIP } from 'node:net'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ipBucket } from '../../src/http/ip-bucket.ts'

/** Expand an IPv6 address to 8 full groups through the WHATWG URL parser (an independent parser). */
function expanded(ip: string): string[] {
  const host = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  const [left = '', right] = host.split('::')
  const l = left === '' ? [] : left.split(':')
  const r = right === undefined || right === '' ? [] : right.split(':')
  const groups = right === undefined ? l : [...l, ...Array<string>(8 - l.length - r.length).fill('0'), ...r]
  return groups.map((group) => Number.parseInt(group, 16).toString(16))
}

describe('ipBucket', () => {
  it("matches the framework's throttle buckets (its own examples and test vectors)", () => {
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:0db8:0001:0002::9')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7')
    expect(ipBucket('unknown')).toBe('unknown')
  })

  it('leaves non-addresses and zone ids unchanged, and reads bracketed IPv6', () => {
    for (const value of ['', 'localhost', 'fe80::1%eth0', '1.2.3', '::ffff:1.2.3.999'])
      expect(ipBucket(value)).toBe(value)
    expect(ipBucket('[2001:db8:1:2::5]')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('[::ffff:c000:22c]')).toBe('192.0.2.44')
  })

  it('every IPv4 address is its own bucket, and its IPv4-mapped forms share it', () => {
    fc.assert(
      fc.property(fc.ipV4(), (v4) => {
        expect(ipBucket(v4)).toBe(v4)
        expect(ipBucket(`::ffff:${v4}`)).toBe(v4)
        const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number)
        const hex = `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
        expect(ipBucket(hex)).toBe(v4)
        expect(ipBucket(`0:0:0:0:0:ffff:${v4}`)).toBe(v4)
      }),
    )
  })

  it('two IPv6 addresses share a bucket exactly when their first 64 bits are equal', () => {
    const mapped = (ip: string) => {
      const groups = expanded(ip)
      return groups.slice(0, 6).join(':') === '0:0:0:0:0:ffff'
    }
    fc.assert(
      fc.property(fc.ipV6(), fc.ipV6(), (first, second) => {
        fc.pre(isIP(first) === 6 && isIP(second) === 6 && !mapped(first) && !mapped(second))
        const sameNetwork =
          expanded(first).slice(0, 4).join(':') === expanded(second).slice(0, 4).join(':')
        expect(ipBucket(first) === ipBucket(second)).toBe(sameNetwork)
        expect(ipBucket(first)).toBe(`${expanded(first).slice(0, 4).join(':')}::/64`)
      }),
    )
  })

  it('any interface id inside one /64 lands in the same bucket', () => {
    const group = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16))
    fc.assert(
      fc.property(
        fc.array(group, { minLength: 4, maxLength: 4 }),
        fc.array(group, { minLength: 4, maxLength: 4 }),
        fc.array(group, { minLength: 4, maxLength: 4 }),
        (network, one, two) => {
          fc.pre(network.slice(0, 2).join(':') !== '0:0')
          expect(ipBucket([...network, ...one].join(':'))).toBe(ipBucket([...network, ...two].join(':')))
        },
      ),
    )
  })
})
