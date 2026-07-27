# Pi 0.82.1 live-acceptance driver

The driver has four explicit commands. It has no signing/private-key route and
does not accept a model catalog, credential, prompt, or provider option on the
command line.

```text
pnpm eval:live:dry-run -- --tasks /private/path/tasks.json
node scripts/live-acceptance-driver.mjs capture --tasks /private/path/tasks.json --authorization-digest <sha256>
node scripts/live-acceptance-driver.mjs finalize --root /private/tmp/pi-reap-pr6-live-... [--review /private/tmp/pi-reap-pr6-live-.../review.json]
node scripts/live-acceptance-driver.mjs cleanup --root /private/tmp/pi-reap-pr6-live-...
```

The external task file must be an owner-owned, mode-0600 regular file outside
the repository. It contains an ordered array of exactly the six frozen task
IDs. Each row has only:

```json
{
  "id": "task-simple-query",
  "body": "private task prompt",
  "grader": { "kind": "exact", "expected": "private exact answer" }
}
```

Dry-run is offline. It locates the installed `pi` executable, requires
`@earendil-works/pi-coding-agent` 0.82.1, fingerprints the executable, the
critical SDK/provider runtime-file manifest, and the installed
`openai-codex.json`, and checks
`openai-codex/gpt-5.4-mini`, `openai-codex-responses`, reasoning support, and
the exact catalog rates. Before authentication can be touched, it also gives
each private task a fresh production `EpochRouter` and requires its initial
production task class and selected effort to match the frozen task route. Both
fields are checked so a conservative effort fallback cannot mask a mislabeled
fixture from another class. A mislabeled or incomplete fixture therefore fails
during offline dry-run instead of after a provider response. It prints only
hashes, call IDs, caps, and prices.

The authorization digest binds those runtime fingerprints, task-manifest hash,
source/build/plan/base pins, the canonical deep hash of all 33 call rows, and
the complete sanitized exact-prefix measurement. Envelope schema v3 therefore
cannot reuse an older schema-v2 digest or substitute a tokenizer, encoding,
prefix boundary, or count. The measurement preserves only the common-prefix
SHA-256, exact token count, cache-row count, tokenizer name, and tokenizer
fingerprint in the envelope and private schema-v3 capture.

Pi 0.82.1 itself provides only a four-characters-per-token estimate. The driver
instead uses exact-pinned `js-tiktoken@1.0.21` with its bundled
`o200k_base` data, entirely offline. OpenAI's tiktoken maps the `gpt-5-`
family to `o200k_base`; the driver expands the bundled ranks and requires the
authoritative OpenAI rank-file SHA-256
`446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`.
It also pins the encoding pattern, special-token map, package versions, pnpm
integrities for `js-tiktoken` and `base64-js`, and implementation vectors into
tokenizer fingerprint
`fc2139538d73fe447c400bebed90e1397c0ffe1a7487660497697b201b1b69e3`.
The third-party port remains a supply-chain and implementation risk; those
exact integrities and the authoritative data fingerprint make the installed
artifacts reproducible, while the vector checks detect incompatible encoder
behavior.
No tokenizer data is fetched from a CDN or provider at runtime.
The upstream mapping and rank pin are recorded in OpenAI tiktoken's
[`model.py`](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py)
and
[`openai_public.py`](https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py).

Each call row also binds the SHA-256 of its system prompt. Cache rows use a
deterministic, source-safe cache primer while route rows retain the minimal
grading prompt. The measured common boundary is exactly the cache system
content through the final primer token, before the private task begins:
SHA-256 `e578aed13602cfc7ef597920087483eed15671325d36849b5a5c22e23344c471`
and 1,112 `o200k_base` tokens. The primer never enters conversation history or
sanitized evidence. The driver never substitutes bytes, aggregate provider
usage, or Pi's estimate for this exact prefix count.

`capture` compares that digest and every planned call field before creating a
Pi model runtime, reading a credential, creating a session, or instantiating
the capture adapter. It then creates a fresh sentinel-bound mode-0700 temporary
root. All contained files are mode 0600 and all directories are mode 0700.
Nothing is written to the repository.

The adapter uses these installed Pi 0.82.1 APIs:

- `ModelRuntime.create({ allowModelNetwork: false })` with an in-memory copy of
  the already-valid production credential;
- `SettingsManager.inMemory()` with agent retries, provider retries, and
  compaction disabled, plus transport fixed to SSE;
- `DefaultResourceLoader` with context files, skills, prompt templates, and
  themes disabled, and explicit inline extension factories;
- `SessionManager.inMemory()` and `createAgentSession()` with `noTools: "all"`
  and an empty tool allowlist;
- `before_provider_request` and `after_provider_response` extension events for
  client-observable request/response-attempt counts and full private payload
  snapshots plus their hashes;
- `message_update`, `auto_retry_start`, `tool_execution_start`, and terminal assistant-message
  usage for retries, tool rounds, uncached input, cache read/write, output, and
  reasoning tokens.

Pi's supported `after_provider_response` seam contains only status and
headers. Terminal assistant messages contain normalized cache-read and
cache-write numbers, not the raw `input_tokens_details` object. Pi's installed
Responses adapter maps an absent or numeric-zero `cached_tokens` or
`cache_write_tokens` field to the same normalized zero. Private observations
therefore record the boundary as `pi_normalized_assistant_usage` and both raw
presence states as `pi_normalized_presence_unknown`, alongside the normalized
numbers. A normalized zero is not labeled a provider cache miss. The driver
does not intercept global networking or patch the installed Pi package.

Every call uses a fresh in-memory session and empty history. Cache rows reuse
one deterministic Pi session ID inside each A/B/C group, which preserves the
actual `prompt_cache_key` while keeping system prompt, tools, input, transport,
history, cache mode, and the provider-managed default TTL fixed. Groups use
distinct session IDs so B1 and C1 are independently cold.

The production extension is loaded from the pinned built `dist/index.js`.
Fixed baselines and cache rows load it explicitly in shadow mode; the
evaluation adapter changes only the baseline `reasoning.effort`. Policy-shadow
and policy-enforce rows exercise the extension's actual
`before_provider_request` handler. The adapter records the canonical payload
before and after routing and rejects any mutation outside
`reasoning.effort`, including changes to output limits, cache fields, reasoning
context, or other provider options.

The adapter imposes safety limits outside the provider payload: a two-minute
wall-clock timer and a one-MiB streamed-event byte limit abort the local
session. Aggregate token and conservative-cost caps are checked before each
new request and again from observed terminal usage. Because Pi exposes final
token usage only after a response, one in-flight call can overshoot an
aggregate token or cost cap; that overshoot is recorded and rejected before
another call is scheduled. No claim is made that the driver enforces a
provider-side per-call token ceiling.

Pi reports `usage.input` as uncached input after subtracting cache read/write,
and reports reasoning as a subset of output. Cost therefore prices uncached
input, cache read, cache write, and output exactly once with catalog prices.
The separate conservative ceiling additionally charges reasoning at its
specified ceiling rate. The installed catalog's zero cache-write price means
that observed cache-write tokens contribute zero catalog cost; it does not
mean cache writes were absent. The cache-control fingerprint describes Pi's
provider-managed default retention/TTL behavior rather than asserting a
client-selected TTL.

Raw outputs, redacted production telemetry, and capture errors remain private.
Capture writes a deterministic review worksheet only for a policy-enforce
failure relative to a passing fixed-xhigh row. `finalize` requires a closed
private review and exact fixed-fixture binding for any such under-route.
Tasks and capture evidence are stored in separate mode-0600 files.
Finalization reopens tasks, capture, and review inputs with no-follow
descriptor reads, recomputes the authorization envelope/digest and exact
33-call plan from the current source/build/plan/base/runtime/catalog pins,
then revalidates every payload, counter, usage, grade, cost, hash, and cache
control before writing an unsigned schema-v2 artifact. Cache acceptance is a
separate typed protocol: it is `PASS` only when a same-environment,
same-effort positive control and its crossover each have a positive raw
`cached_tokens` read; a positive control hit plus crossover miss is
`REGRESSION`; raw fields known present but no qualifying positive control is
`ENVIRONMENT_UNQUALIFIED`; and Pi-normalized values whose raw-field presence
cannot be known are `OBSERVABILITY_UNAVAILABLE`. The installed Pi 0.82.1
surface is the latter: it exposes no raw provider `cached_tokens` presence
seam, so `openai-codex/gpt-5.4-mini` is a live observability canary only, not
evidence about `gpt-5.6-sol` cache preservation. A complete normalized-zero
capture is retained as negative evidence, not relabeled as a regression or
used to block implementation delivery. The sanitized artifact binds this
verdict and raw-observability provenance into its canonical hash and detached
attestation bytes. Only a raw-observed qualified `PASS` can produce a trusted
cache-acceptance receipt; `REGRESSION`, `ENVIRONMENT_UNQUALIFIED`, and
`OBSERVABILITY_UNAVAILABLE` remain retainable negative/canary evidence and
cannot promote default enforcement. Only a private schema-v3 capture carrying a
provider-compatible exact measurement of at least 1,024 common-prefix tokens
may reach artifact finalization. Private schema-v2 capture compatibility is
forensic and rejection-only: verification preserves its legacy schema and
missing provenance/measurement state, and finalization fails closed with
`legacy_or_missing_exact_prefix_measurement` even if all warm cache reads are
positive. A typed schema-v2 failure receipt contains only a
sanitized code, an explicit `capture` or `post_capture` phase, and the number
of fully validated calls. Capture-phase failures permit only 0–32 completed
calls. Post-capture validation failures permit exactly 33 and use a specific
code such as `cache_crossover_no_cache_read` or
`legacy_or_missing_exact_prefix_measurement`, with other finalization failures
mapped to `post_capture_finalization_failed`. Trusted acceptance still requires a later independent witness
signature; unsigned artifacts are rejected by the trusted validator.

Cleanup first verifies the exact temp namespace, real root, sentinel contents,
owner, modes, and every descendant. It refuses all symlinks and cannot escape
the validated root.

Both Pi's agent retry and pi-ai's provider retry are set to zero and WebSocket
fallback is disabled. The request, response, and retry counters nevertheless
cover only events observable at the Pi client boundary. Retries, redirects,
or equivalent work performed inside an HTTP stack or the remote provider
service before Pi receives an event cannot be proven absent by this adapter.
