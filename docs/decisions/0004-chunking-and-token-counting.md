# 0004. Token-based chunking that never drops text

## Context

Documents can be longer than one model call should handle, and a restart must neither lose text
nor duplicate values. The three fixtures are one page each.

## Decision

- Count tokens for the whole text once. At or under ~6k tokens it is one chunk (all fixtures). Otherwise derive `chars_per_token` for this document, plan chunks to the target, count each,
  and re-split any chunk over the hard max (8k) at the next weaker boundary.
- Boundaries, strongest first: page, heading, blank line, line break, sentence, whitespace; never inside a word.
- Chunks tile `parsed_text` exactly; a pure `assertTiling` throws on a gap. Each chunk also sees
  the previous chunk's last paragraph (about 200 tokens) as overlap.
- More than 50 chunks fails the version ("Document too long"). The plan and each chunk's answer are
  stored per version; chunks run 3 at a time
  (`CHUNK_CONCURRENCY`) under a process-wide `LLM_MAX_INFLIGHT` limit of 4.
- Per-field merge: none found is a gap, one distinct value is kept, conflicting values become a gap
  that lists the candidates.
- Gemini and the fake both count tokens locally (length / 4).

## Alternatives

- Fixed character windows. Rejected: cuts values from their labels.
- A third-party tokenizer. Rejected: not exact for the configured model.

## Consequences

- Resume after a crash reuses the stored plan and skips finished chunks.
- Gemini counts cost no quota; the estimate only affects chunk sizing, not correctness.
