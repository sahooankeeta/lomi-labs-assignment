# 0005. Structured outputs, and which model answers

## Context

The extractor must return one value, evidence quote or gap reason per field, in a shape the
validator can trust. Claude is the product default, but the project also needs a free way to run
end to end, and the tests must not call any API.

## Decision

- Responses are constrained with a JSON schema (`output_config.format` for Claude; the equivalent
  response schema for Gemini). Structured outputs are preferred over forcing a tool call.
- **Claude is the default** (`EXTRACTOR=claude`, `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`), as
  the spec says. A missing key makes the version `failed`, visibly and retryably.
- **Gemini is the free alternative** (`EXTRACTOR=gemini`, free tier). A busy model (429, 503, timeout) is
  retried once, then the next in `GEMINI_FALLBACK_MODELS` is used; results record the model.
- **Fake extractor** (`EXTRACTOR=fake`) returns deterministic values from the fixtures offline, with
  an optional delay. It drives the integration tests and `scripts/verify-phase1.sh`.
- Evidence validation (0003) runs identically on all three. Token counting for Gemini and the fake is
  local (length / 4), so Gemini uses no quota to count.

## Alternatives

- Claude only. Rejected: the free tier lets the project run without credits.
- Forced tool use for structure. Rejected: structured outputs constrain the schema directly.

## Consequences

- Free-tier models can be overloaded; the fallback chain bounds it and a failure is retryable.
- Extractor choice is one env var; no code path skips validation.
