# 0005. Structured outputs, and which model answers

## Context

The extractor must return one value, evidence quote or gap reason per field, in a shape the
validator can trust. The project must run end to end on a free tier, and the tests must not
call any API.

## Decision

- Responses are constrained with a JSON schema (Gemini's response schema), not a forced tool call.
- **Gemini is the default** (`EXTRACTOR` unset or `gemini`, free tier, `GEMINI_API_KEY` required). A
  missing key makes the version `failed`, visibly and retryably. A busy model (429, 503, timeout) is
  retried once, then the next in `GEMINI_FALLBACK_MODELS` is used; results record the model.
- **Fake extractor** (`EXTRACTOR=fake`) returns deterministic values from the fixtures offline, with
  an optional delay. It drives the integration tests and `scripts/verify-phase1.sh`.
- Evidence validation (0003) runs identically on both. Token counting for Gemini and the fake is
  local (length / 4), so Gemini uses no quota to count.
- Any other `EXTRACTOR` value fails each version with a clear "not supported" message.

## Alternatives

- Claude, as the spec named. Removed by the project owner's choice (cost): it needs a paid API.
  Another provider is one `Extractor` implementation plus a factory branch.
- Forced tool use for structure. Rejected: structured outputs constrain the schema directly.

## Consequences

- Free-tier models can be overloaded; the fallback chain bounds it and a failure is retryable.
- Extractor choice is one env var; no code path skips validation.
