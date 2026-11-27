# 0003. Strict evidence check: verbatim quote, and the value must be in the quote

## Context

The model can hallucinate a quote, or quote a real sentence next to a wrong number. A reviewer
trusts the highlighted evidence, so a value without real evidence is worse than a gap.

## Decision

A value is kept only if (1) its quote appears verbatim in the version's own parsed text, after
identical normalization of both sides (NFKC, curly quotes and dashes to ASCII, whitespace runs
collapsed), and (2) the value appears in its own quote, compared per type: money, number and
percent by digits (`5230.29` ~ `$5,230.29`), dates by parsed date (`2026-03-15` ~ `March 15, 2026`),
strings by case-insensitive substring. Nothing fuzzier. A failure becomes a gap with a reason
("evidence not found in document text" or "value not found in its quote"). The quote is searched
inside its own chunk and mapped to version offsets, so repeated phrases resolve correctly.
The check is applied identically to every extractor (Gemini, fake).

## Alternatives

- Fuzzy or embedding match on quotes. Rejected: it lets near-misses through.
- Trust the model's value if the quote exists. Rejected: right quote, wrong number slips through.

## Consequences

- Occasional false gaps (an odd rendering the comparer does not know); a reviewer corrects them.
- Offsets and page of the quote are exact, which drives the page jump and highlight in the UI.
- Carry-over later reuses the same matching against the new text.
