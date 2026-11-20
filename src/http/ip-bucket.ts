/**
 * Which client a request counts against, for the endpoint's failed-attempt counter.
 *
 * This is the same normalisation as the framework's `throttle` middleware (`ipBucket` in
 * `@strutvane/framework`'s `src/http/app/throttle.ts`), which the published package does not
 * export. It is repeated here so the two always agree; `test/http/ip-bucket.test.ts` pins it to
 * the framework's own examples. When the framework exports it, this file becomes a re-export.
 *
 * - **IPv4** addresses are their own bucket.
 * - **IPv6** addresses are bucketed per /64: a client usually controls a whole /64, so counting
 *   per address would give it billions of separate counters.
 * - **IPv4-mapped IPv6** (`::ffff:203.0.113.7`) is the IPv4 client it maps, so a dual-stack
 *   listener counts one client once.
 * - Anything that is not an address (`'unknown'` when the app can't tell, a zone id) is returned
 *   unchanged. That is why the endpoint never lets this counter stand between a valid credential
 *   and the report: many clients can share one bucket.
 *
 * @module
 */
import { isIP } from 'node:net'

/**
 * The counter bucket for a client address.
 *
 * @example
 * ipBucket('2001:db8:1:2:3:4:5:6') // '2001:db8:1:2::/64'
 * ipBucket('::ffff:203.0.113.7')   // '203.0.113.7'
 * ipBucket('203.0.113.7')          // '203.0.113.7'
 * ipBucket('unknown')              // 'unknown'
 */
export function ipBucket(ip: string): string {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  // A zone id (`fe80::1%eth0`) names an interface, not an address: left as it is, never guessed.
  if (isIP(bare) !== 6 || bare.includes('%')) return ip
  const value = ipv6Value(bare)
  if (value >> 32n === 0xffffn) {
    const v4 = value & 0xffffffffn
    return [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join('.')
  }
  const groups: string[] = []
  for (let shift = 112n; shift >= 64n; shift -= 16n)
    groups.push(((value >> shift) & 0xffffn).toString(16))
  return `${groups.join(':')}::/64`
}

/** A valid IPv6 address (`isIP` said so) as a 128-bit integer, embedded IPv4 tails included. */
function ipv6Value(text: string): bigint {
  let head = text
  let tail32: bigint | undefined
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    tail32 = text
      .slice(lastColon + 1)
      .split('.')
      .reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n)
    head = `${text.slice(0, lastColon + 1)}0:0`
  }
  const [left = '', right] = head.split('::')
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right === undefined || right === '' ? [] : right.split(':')
  const groups =
    right === undefined
      ? leftGroups
      : [
          ...leftGroups,
          ...Array<string>(8 - leftGroups.length - rightGroups.length).fill('0'),
          ...rightGroups,
        ]
  const value = groups.reduce(
    (total, group) => (total << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  )
  return tail32 === undefined ? value : (value & ~0xffffffffn) | tail32
}
