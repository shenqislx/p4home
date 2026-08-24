# Phase 6 Memory Visibility Matrix — Approved v1

> Status: `approved`
> Approved: 2026-08-24
> User decision: approve v1 and keep `private` (recommended)
> Product strategy: `private`
> Cross-role product recall: disabled

This document compares three deterministic projections over one canonical
Memory store. A requester is the role asking for Memory; the owner is the role
that created/owns the canonical record. Passing the frozen fixture for all three
strategies proves implementation consistency with each strategy's expected
matrix. It does **not** prove that broader sharing produces a better product.

## Strategy matrix

| Strategy | Kind | Requester is owner | Requester is not owner |
|---|---|---:|---|
| `private` | `conversation_summary` | visible | hidden |
| `private` | `user_fact` | visible | hidden |
| `private` | `task_outcome` | visible | hidden |
| `shared_acl` | `conversation_summary` | visible | visible only with explicit requester-role ACL |
| `shared_acl` | `user_fact` | visible | visible only with explicit requester-role ACL |
| `shared_acl` | `task_outcome` | visible | visible only with explicit requester-role ACL |
| `hybrid` | `conversation_summary` | visible | hidden |
| `hybrid` | `user_fact` | visible | visible only with explicit requester-role ACL |
| `hybrid` | `task_outcome` | visible | hidden |

Rules shared by all strategies:

- expired or deleted records are invisible on the next query;
- `owner_only` records are visible only through the matching `owner_role` path;
- `restricted` records are owner-only even when an ACL names another role;
- cross-role projection requires `visibility_scope=explicit_roles`, an ACL row
  for the exact requester role, and the currently approved policy revision;
- an old or unapproved policy revision fails closed for cross-role access;
- the owner may still read its active record under its own role even when that
  record has an old policy revision or is not eligible for cross-role
  projection; expiry/deletion still apply;
- `hybrid` permits cross-role projection only for `user_fact`; summaries and
  task outcomes remain owner-only even with ACL;
- Router reads no Memory;
- the product runner accepts only an authentic, frozen `private` Memory runtime
  created by its factory; a structural object claiming `strategy=private`
  cannot enable product recall.

## Trade-offs

### `private`

- Advantages: smallest disclosure surface, easiest owner attribution, no
  cross-role policy coupling, safest while household identity and representative
  relevance evidence are absent.
- Costs: the same stable preference may need separate role-owned evidence;
  Robot/Human/Cat cannot benefit from another role's approved fact.
- Deterministic result: all Human/Robot/Cat retrieval cases passed; unauthorized
  leakage, expired/deleted residue, and budget violations were zero. Empty
  cross-role denominators are reported as `null`.

### `shared_acl`

- Advantages: can reuse explicitly approved summaries, facts, and task outcomes
  across roles; ACL revocation takes effect on the next query.
- Costs: largest disclosure and policy-review surface; conversation and task
  context can cross role boundaries; mistakes in ACL assignment have broader
  impact; requires a credible subject/multi-user model before deployment.
- Deterministic result: all frozen ACL expectations and revocation probes passed
  with zero unauthorized leakage. This only verifies the fixture policy, not
  that sharing all three kinds is desirable.

### `hybrid`

- Advantages: permits explicitly approved stable `user_fact` reuse while keeping
  conversation summaries and task outcomes role-private; smaller sharing surface
  than `shared_acl`.
- Costs: fact classification becomes a security boundary; incorrect promotion
  from summary/task context to `user_fact` could still broaden disclosure;
  representative-home and real-model evidence are still missing.
- Deterministic result: all frozen hybrid expectations and revocation probes
  passed with zero unauthorized leakage. This does not outweigh the missing
  real-environment and identity evidence.

## Deterministic comparison

- Dataset: one physical SQLite store, 22 canonical records, identical fingerprint
  across all strategies.
- Per strategy: Human `8/8`, Robot `4/4`, Cat `2/2` deterministic retrieval cases
  passed; Recall@K and Precision@K were `100%` on non-empty labeled expectations.
- Per strategy: owner/source attribution and conflict top-choice were `100%`;
  context budget violations, unauthorized cross-role leaks, expired residue, and
  deleted residue were all `0`.
- `shared_acl` and `hybrid` ACL revocation propagation were `100%`.
  `private` revocation propagation is not applicable and is `null`.
- No aggregate score is produced. Equal deterministic pass rates do not rank the
  strategies and do not imply that sharing is superior.

## Approved v1 decision

On 2026-08-24, the user explicitly approved visibility matrix v1 with the
recommended `private` product strategy:

- `conversation_summary` remains private to its `owner_role`;
- `user_fact` remains private to its `owner_role`;
- `task_outcome` remains private to its `owner_role`;
- cross-role product recall remains disabled;
- experimental `shared_acl` and `hybrid` projections remain evaluator-only.

Any future relaxation requires a new version of this matrix plus explicit user
review. That revision must name the strategy, eligible Memory kinds,
requester/owner combinations, policy revision, restricted handling, and
migration behavior. Approval of v1 does not authorize Phase 7 or any cross-role
product enablement.
