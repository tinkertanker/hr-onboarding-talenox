# CSV 6 security dispositions (2026-10-27)

Source: `f2fb2e63-tinkertanker-agent-findings-6.csv`, downloaded with its unique
attachment filename preserved. Claims were checked against fresh remote default
`main` at `10472f40cd6f4305ecd6cd9078b555036932df92`, also the scanner's revision.
All reproduction inputs and provider responses were synthetic; no employee data
or production POST requests were used.

| Row | Source ID | Disposition |
| --- | --- | --- |
| 1 | `d1705acb-92a9-45ba-8abe-55a45e79026f` | Confirmed; fixed together with row 4 by shared bounded email validation. Onboarding is unauthenticated. |
| 2 | `a69dedcc-0bf9-445e-87ea-66953abf02d3` | Confirmed timing disclosure; deferred, **not fixed**. Rationale and residual risk below. |
| 3 | `7ed181ae-4956-45b9-9509-e75e53c583b8` | Confirmed in the development mock; fixed by omitting subjects from operational logs. Not a production service exposure. |
| 4 | `6cd976a7-5a4b-4849-8e8e-f59d5e0899f4` | Confirmed; same root cause and fix as row 1, reached after update-token verification. |

## Rows 1 and 4: synchronous email matching

Both Express and the Worker cap request bodies at 100 KiB, but the old ambiguous
domain regex still accepted enough input for quadratic work. A synthetic malformed
domain with 5k/10k/20k dots plus trailing whitespace took approximately
15/55/249 ms in this orb. The shared validator rejects non-strings and addresses
longer than 254 characters before scanning; remaining checks use linear string
operations and a whitespace test. The 20k-dot rejection took under 0.1 ms.
The existing simple address shape is preserved within the new length limit;
this is not a full RFC email parser. An exhaustive scratch comparison over 97,656
short strings found no shape changes.

Handler regression tests cover 254/255-character boundaries, array coercion,
malformed long domains, dispatch rejection, and retrying an update with the same
verified token after validation errors. Both new handler tests failed on unchanged
production code, which accepted the 255-character addresses.

## Row 2: membership timing remains a privacy risk

The generic response body is identical, but unknown identities finish after the
employee-list request. Known identities also await employee detail and email
delivery. A controlled mocked email promise left the known-identity response
pending while the unknown-identity response completed; releasing it produced the
same 200 response. The awaited path exists in both Express and the Worker.

The existing limits are ten requests per IP per 15 minutes and a 60-second
per-identity cooldown, reserved before lookup for both known and unknown inputs.
They constrain sampling, not disclosure: distributed callers or a patient caller
who knows a person's NRIC/FIN can still infer payroll membership. Employee
membership is personal information, even though the endpoint does not return
their particulars. No claim is made that the limits eliminate the timing channel.

Read-only Cloudflare inspection confirmed that `hr-onboarding.tk.sg` currently
targets the `hr-onboarding` Worker with `PARTICULARS_STATE` and `ONBOARDING_QUEUE`
bindings. Particulars state uses a single SQLite-backed Durable Object; the
existing queue handles employee creation, not OTP requests. Express remains an
alternative supported host with in-memory state.

Defer remediation in this narrow change: reliable identity-independent acceptance
would require a deliberately designed OTP job lifecycle across those hosts,
including durable acceptance, sensitive payload storage, delivery failure handling,
expiry and cooldown behavior, and retry/duplicate-email semantics. Merely detaching
the promise risks losing delivery on eviction/restart; a fixed delay is not a
reliable timing defense. Do not add that infrastructure solely on the scanner's
recommendation. Revisit if targeted enumeration is observed, exposure increases,
or the product requires stronger membership confidentiality. This is an explicit
residual risk, not a false-positive or resolved finding.

## Row 3: local diagnostic injection

`scripts/mock-providers.js` binds to loopback and is not bundled into the Worker.
The synthetic email subject remained literal after JSON parsing, including CR/LF
and terminal escape bytes. The mock now logs only HTTP method and pathname.
Its local `/__calls` inspection endpoint still retains synthetic email payloads.
A real loopback HTTP regression test failed before the change and passes after it.

## Delivery boundary and validation

GitHub reported no Actions workflows or deployments; Cloudflare's authenticated
Workers Builds trigger list for this Worker was empty. Existing deployment
records identify Wrangler uploads, and the repository's `deploy.sh` is manual.
No automatic deployment trigger was observed. GitHub webhook and classic branch
protection listings were inaccessible (403), an observability limit rather than
proof that hidden automation or protection is absent. No deploy command, data
mutation, or real email is authorized by this change.

All 31 backend/Worker tests pass (`npm test`), including the three new regressions.
`npm run worker:build` passes as a dry-run bundle without deployment. No UI files
changed. Live provider behavior and production CPU timings were not tested.
