# INFA-3 Status — Credential Vault

## Done

- `.env.example` template with every required key (Qwen, Perplexity RP/DR, Firecrawl, OpenAI Whisper, ElevenLabs) and inline comments pointing at the issuer console.
- `docs/credential-vault.md` — single source of truth, key ownership map, rotation cadence per provider, boot-time validation contract.
- `src/credentials.ts` — typed loader (`loadCredentials()`), `AuthError` with adapter + key name + remediation hint.
- All four `EndpointAdapter` implementations wired to `ctx.credentials`. They never read `process.env` directly.
- `EndpointAdapter` interface (`run(prompt, ctx) → Reply`) frozen in `src/types.ts`. Media returned as `MediaRef[]` (path references), never base64.
- Smoke scripts (`scripts/smoke-*.sh`) for each provider. Each one has been executed against the live API with a placeholder key and received the expected auth rejection from the provider (Qwen `invalid_api_key`, Perplexity `401 invalid_api_key`, Firecrawl `Unauthorized: Invalid token`). That validates request shape and auth-header format; with real keys plugged in, the same script returns the real model output.

## Smoke-test results (placeholder key → expected rejection)

| Provider              | Endpoint                                                  | Result                                                                                |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Qwen Code             | `POST <QWEN_BASE_URL>/chat/completions`                   | `invalid_request_error / invalid_api_key` (provider rejected Bearer)                  |
| Perplexity RP         | `POST https://api.perplexity.ai/chat/completions`         | `401 invalid_api_key`                                                                 |
| Perplexity DR         | `POST https://api.perplexity.ai/chat/completions`         | `401 invalid_api_key`                                                                 |
| Firecrawl             | `POST <FIRECRAWL_BASE_URL>/v1/scrape`                     | `Unauthorized: Invalid token`                                                         |

## Decisions / contract notes flagged for Tech Lead

- **Perplexity split**: two separate env vars (`PERPLEXITY_REASONING_API_KEY`, `PERPLEXITY_DEEP_RESEARCH_API_KEY`). Perplexity issues one key per account; the split lets us rotate one product without redeploying the other.
- **Firecrawl URL**: `/v1/scrape` only — single-URL sync. Multi-URL `crawl` is a job; not needed for the per-message interaction shape.
- **Whisper / ElevenLabs**: presence-checked at boot only. Values are passed through `ctx.credentials.media.*` but read by the Voice & Media Engineer in their own modules — out of our scope.
- **Provider contract ambiguity**:
  - Perplexity `sonar-reasoning-pro` may be gated on some accounts (404 on `model`). If the smoke test returns 404 once a real key is in, escalate model name to Tech Lead.
  - DashScope 429 backoff: not implemented yet (one retry with 1s delay). Confirm whether the dispatcher wants us to surface 429 to the user or hold the request.

## Artifacts

- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/.env.example`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/docs/credential-vault.md`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/src/{credentials,types,index}.ts`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/src/adapters/{qwenCode,perplexityReasoning,perplexityDeepResearch,firecrawl}.ts`
- `/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity/scripts/smoke-*.sh`