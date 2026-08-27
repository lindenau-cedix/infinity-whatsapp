# INFA-24 — Perplexity `fetch failed` / `UND_ERR_SOCKET`: root-cause diagnosis

Measured on the actual runtime host (Node v24.19.0, undici 7.24.4).

## TL;DR

The host is **not** unreachable. The endpoint is healthy and the API key is valid.
The failures are a **timeout race inside our own client**, and the error envelope
was then *mislabelling* that race as "host unreachable".

## Evidence

| Probe | Result |
| --- | --- |
| `curl -4 https://api.perplexity.ai/` | `http=404 ip=104.18.26.48` — reachable |
| `curl -6 https://api.perplexity.ai/` | `rc=7` — no IPv6 egress on this host |
| `getent hosts api.perplexity.ai` | returns **AAAA first** (`2606:4700::…`) |
| plain `fetch()` × 6 | `401` × 6 — transport fine |
| authenticated `curl` `sonar-reasoning-pro` | **HTTP 200 in 4.2 s** |
| dispatcher `sonar-reasoning-pro` | **OK in 3.5 s** |
| raw `fetch` `sonar-deep-research` | **HTTP 200 in 121.8 s** |
| dispatcher `sonar-deep-research` | **OK in 185.4 s** |
| keep-alive reuse after 65 s idle | OK — not a stale-socket bug |

## Root causes

### 1. `headersTimeout` collides with our own timeout (the real bug)

undici's effective defaults on this host, read out of the agent:

```
Symbol(headers timeout) = 300000
Symbol(body timeout)    = 300000
```

`sonar-deep-research` sends **no bytes at all** until the report is finished —
headers arrive only at the very end. Measured runs took 121 s and 185 s; Perplexity
documents 30 s–5 min. So a normal deep-research call sits at 300 s ± noise, i.e.
right on top of undici's 300 s `headersTimeout`.

`perplexity.js` set `timeoutMs = 300_000` for deep-research — **exactly equal** to
undici's `headersTimeout`. The two timers race, and whichever fires first wins.

Reproduced deterministically (server delays headers past `headersTimeout`):

```
FAIL after 1518ms: fetch failed | cause.code: UND_ERR_HEADERS_TIMEOUT
                                | cause.name: HeadersTimeoutError
```

undici reports this as a bare **`TypeError: fetch failed`** — which is precisely
the original INFA-24 symptom.

### 2. The transport-cluster classifier mislabels timeouts as "unreachable"

`UND_ERR_SOCKET` / `HeadersTimeoutError` were routed into
`isTransportClusterError()`, which after 2 consecutive hits emits
`HOST_CONNECTIVITY_HINT` — "Perplexity endpoint unreachable from this host …
check your firewall/DNS/TLS proxy".

That advice is **false here**: we proved the host reaches the API fine. The
operator was sent to debug a firewall that was never the problem. A long request
that times out mid-flight is not an unreachable host.

### 3. IPv6-first DNS with no IPv6 egress (latent, secondary)

DNS returns AAAA records first and this host has no IPv6 route (`curl -6` → `rc=7`).
Node's happy-eyeballs (`autoSelectFamily=true`, 250 ms attempt timeout) currently
masks it, but it costs a 250 ms penalty on every fresh connection and turns into
hard `UND_ERR_SOCKET`/`ENETUNREACH` failures whenever that fallback is slow.

## Fixes applied

1. Give long-running calls an undici dispatcher with `headersTimeout` /
   `bodyTimeout` **disabled**, so our `AbortController` is the single source of
   truth for deadlines. `undici` is *not* a declared dependency, so the require is
   optional and guarded — absent it, we degrade to global `fetch`.
2. Raise the deep-research budget past the 300 s cliff and stop the timer race.
3. Treat `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` as retriable timeouts.
4. **Only claim "unreachable host" when a live probe actually confirms it.** On the
   failure path we now probe the base URL: if it answers, the envelope reports a
   slow/timed-out upstream instead of sending the operator after a phantom firewall.
