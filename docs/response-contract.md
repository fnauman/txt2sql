# Response contract version 2

The optimized product has three explicit decisions: `answer`, `clarify`, and
`abstain`. The model receives this contract in its prompt and strict JSON schema.
The basic SQL-only teaching CLI remains unchanged.

- `answer` carries SQL, which still passes the existing read-only, table-scope
  and semantic checks before bounded execution.
- `clarify` carries a short explanation and specific `clarification_questions`.
  It must have empty SQL, tables and assumptions. The UI asks the person to
  update their question with the missing detail and submit it again; it does
  not silently append conversation context or invent a business convention.
- `abstain` explains why the schema or read-only operation cannot answer the
  request. SQL, tables, assumptions and clarification questions must be empty.

A missing decision in a legacy answer is treated as `answer`. An explicit
unknown or inconsistent decision is an `LLM_INVALID_DECISION` failure, may use
the ordinary corrective retry budget, and never bypasses SQL checks. Model
usage and cost remain recorded for nonanswers and malformed decisions. A
clarification or abstention completes successfully at the API level (HTTP 200),
but does not claim that a SQL answer was produced.

The blocking API includes `decision` and `clarificationQuestions`. The SSE route
sends a `decision` event followed by usage metrics and `done`, without empty
SQL/data frames. Both routes support the existing authentication, cancellation
and debug controls. There is no new authorization boundary.

## Evaluation and historical evidence

New provenance records `responseContractVersion: 2`. The prompt fingerprint
changes even with historical HINTS_VERSION settings: hints version selects the
business hints, not a historical response protocol. Historical baselines,
prompt fixtures, oracle definitions and experiment results remain unchanged.
An offline replay checks recorded SQL; it cannot demonstrate how a model would
respond to today's decision prompt.

Behavior cases score the matching typed decision separately from SQL accuracy:
`clarified` and `abstained` are handled, `wrong_behavior` is not. A nonanswer to
an answerable case is a counted model failure (`declined_answer`). Every live
repetition records `responseContractVersion: 2`; an empty SQL
answer or provider refusal is a failed response, not a handled behavior case.
Legacy recordings without protocol metadata are treated as version 1 and
retain their old empty-SQL/refusal `declined` score; do not interpret
that score as proof that a useful clarification was asked. Compact reports and
rescoring preserve each repetition's original protocol
version, decision and actual clarification questions. Older v2 reports missing
the repetition field inherit their run's protocol metadata; a rescore of a v1
recording keeps v1 even though the current scorer uses v2.

Automated tests exercise the real product loop with controlled model replies,
HTTP/SSE serialization, the client stream reducer, rejection of conflicting
SQL/decision combinations, and evaluation attribution. They establish the
mechanism, not model quality. A new paid development run and then a separately
sealed evaluation are still needed to measure behavior and answer regressions.

## Unresolved semantic decision

The ledger-credit request discussed in Experiment 06 does not specify whether
March refers to document date or accounting posting date, nor its cancellation
policy. No gold SQL or fixture has been changed to match model consensus. A
domain owner must select the convention or require explicit clarification;
version any revised case/oracle and author new discriminating controls before
using it as accuracy evidence.
