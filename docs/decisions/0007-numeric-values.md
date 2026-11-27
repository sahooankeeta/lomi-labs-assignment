# 0007. Numeric values: one distinct number, words allowed around it

## Context

A live Gemini run returned the lease `term_months` as "twenty-four (24)", quoted from the text
"twenty-four (24) months". The strict check (0003) compares numbers by digits, and a value with
words around the number did not parse, so the field became a false gap (15/16 fields correct).

## Decision

For money, number and percent, a value may carry words around exactly one number
(`24 months`, `twenty-four (24)`). The comparer collects the distinct numbers in the value; if
there is exactly one, that is the value's number, and it must appear in the quote. Two different
numbers in one value, or none, still fails. Prompt v2 also asks the model for the bare number.

## Alternatives

- Reject any value that is not purely numeric. Rejected: it caused the false gap above.
- Parse spelled-out numbers ("twenty-four"). Rejected: language-specific and error-prone; the
  digits in the quote are the evidence.

## Consequences

- Accepted weakness: unit words in the value are not checked. `24 years` would pass if the quote
  contains `24`. The number must still appear in the quote, so an invented number cannot pass.
- A reviewer sees the value and its quote side by side and can correct a wrong unit.
- The recorded live Gemini check after this change was 16/16, including `term_months` = 24.
