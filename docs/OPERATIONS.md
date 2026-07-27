# Pi REAP 1.0 operations

The default is shadow mode. Enforcement remains an explicit local `/effort enforce` session opt-in; it is not promoted by default and no Pi settings or effort-router configuration is written.

Pi REAP changes only `reasoning.effort` in supported OpenAI Responses payloads and leaves unsupported, malformed, unknown, invalid, or conflicted requests unchanged. It decides an initial effort before the first provider request, never lowers effort within an epoch, and never selects `max` automatically.

## Other effort mutators

`before_provider_request` handlers are ordered. Pi REAP's telemetry reports what this extension requested/applied locally, not the provider's final wire value. A later extension can overwrite `reasoning.effort` after Pi REAP runs.

If a payload logger placed after Pi REAP locally observes a different effort, run the Pi-local command `/effort-conflict <requested-effort> <locally-observed-effort>`; for example, `/effort-conflict high low`. It directs the operator to remove the later mutator or place Pi REAP last, then re-check with that final-payload logger. This diagnostic compares local observations only and is not a claim about provider wire truth. Pi does not currently expose a final-wire observation hook to this extension.

## Release claims and gates

All 1.0 mandatory and quality gates remain required: no LLM tool, prompt, `setThinkingLevel`, or settings mutation; payload preservation and baseline fallback; epoch monotonicity and settled-task reset; command-only `max`; redacted telemetry; high-risk/coding/regression corpus gates and fixed under-routing regressions.

The V3 live-cache record remains `OBSERVABILITY_UNAVAILABLE` with no positive read. The `openai-codex/gpt-5.4-mini` run is only a live observability canary. Therefore do not claim cache crossover pass/fail, cache preservation across effort switching, gpt-5.6-sol behavior, production savings, or default-enforcement promotion. These are deferred external release claims, not a blocker for the ordered 1.0 delivery.
