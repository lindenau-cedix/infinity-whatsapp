# INFA-3 Status — Credential Vault

## Done

- `.env.example` template with every required key (Perplexity RP/DR, Firecrawl, OpenAI Whisper, ElevenLabs) and inline comments pointing at the issuer console. **Qwen has no API key** — it runs as a local CLI (`QWEN_BIN`, `QWEN_MODEL`) as of INFA-17.
- `docs/credential-vault.md` — single source of truth, key ownership map, rotation cadence per provider, boot-time validation contract.
- `src/credentials.ts` — typed loader (`loadCredentials()`), `AuthError` with adapter + key name + remediation hint. The Qwen credential slot is preserved as a vestigial shape so legacy callers don't crash; `apiKey` is always `""` and `baseUrl` is informational.
- All three remaining `EndpointAdapter` implementations wired to `ctx.credentials`. They never read `process.env` directly. The Qwen path is the local-CLI `dispatcher/qwen.js`, wrapped by `register.js` into the adapter shape.
- `EndpointAdapter` interface (`run(prompt, ctx) → Reply`) frozen in `src/types.ts`. Media returned as `MediaRef[]` (path references), never base64.
- Smoke scripts (`scripts/smoke-*.sh`) for each provider. The cloud ones (Perplexity RP/DR, Firecrawl) have been executed against the live API with a placeholder key and received the expected auth rejection from the provider (`401 invalid_api_key`, `Unauthorized: Invalid token`). The Qwen smoke runs the local CLI directly — `QWEN_BIN=qwen ./scripts/smoke-qwen.sh`.

## Smoke-test results (placeholder key → expected rejection)

| Provider              | Endpoint                                                  | Result                                                                                |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Qwen Code             | local CLI: `qwen -m qwen3:30b-a3b -p "..."`               | n/a — no network. Qwen CLI must be installed on the VPS (https://github.com/QwenLM/Qwen3-Coder). |
| Perplexity RP         | `POST https://api.perplexity.ai/chat/completions`         | `401 invalid_api_key`                                                                 |
| Perplexity DR         | `POST https://api.perplexity.ai/chat/completions`         | `401 invalid_api_key`                                                                 |
| Firecrawl             | `POST <FIRECRAWL_BASE_URL>/v1/scrape`                     | `Unauthorized: Invalid token`                                                         |

## Decisions / contract notes flagged for Tech Lead

- **Perplexity split**: two separate env vars (`PERPLEXITY_REASONING_API_KEY`, `PERPLEXITY_DEEP_RESEARCH_API_KEY`). Perplexity issues one key per account; the split lets us rotate one product without redeploying the other.
- **Firecrawl URL**: `/v1/scrape` only — single-URL sync. Multi-URL `crawl` is a job; not needed for the per-message interaction shape.
- **Whisper / ElevenLabs**: presence-checked at boot only. Values are passed through `ctx.credentials.media.*` but read by the Voice & Media Engineer in their own modules — out of our scope.
- **Provider contract ambiguity**:
  - Perplexity `sonar-reasoning-pro` may be gated on some accounts (404 on `model`). If the smoke test returns 404 once a real key is in, escalate model name to Tech Lead.
  - ~~DashScope 429 backoff~~ (obsolete — Qwen is local-CLI per INFA-17; there is no DashScope path anymore).

## Artifacts

- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/.env.example`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/docs/credential-vault.md`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/src/{credentials,types,index}.ts`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/src/adapters/{perplexityReasoning,perplexityDeepResearch,firecrawl}.ts`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/dispatcher/{index,qwen,perplexity,firecrawl,shared}.js`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/scripts/smoke-*.sh`