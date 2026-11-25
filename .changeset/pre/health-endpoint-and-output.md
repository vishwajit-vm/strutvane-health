---
"@strutvane/health": patch
---

`GET /health.json` checks the credential first: a valid token, or a policy that allows the request, is always served. Only refused requests are counted, per client (an IPv4 address, or an IPv6 /64, with IPv4-mapped IPv6 counted as its IPv4 client), and after `max_failed_attempts` in a minute further refusals answer `429` instead of `401`.

Check output masks more: the percent-encoded, JSON-escaped, base64 and base64url forms of known secret values; URL credentials up to the last `@` before the host; whole quoted values (with escapes) for keys such as `pass`, `auth`, `sig`/`signature`, `credential`, `cookie` and `session`; `Authorization`/`Cookie` header lines; Redis `AUTH` arguments; and Digest `response="…"`. Masking stays linear on long input.
