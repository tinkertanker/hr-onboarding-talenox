# Agent guidance

Tinkercademy employee onboarding and email-verified particulars updates, backed by
Express, Talenox, and Resend.

## Safety boundaries

- **PDPA / employee privacy:** Never put real employee data in fixtures, logs,
  screenshots, commits, or prompts. Protect NRIC/FIN (`nric`/`ssn`), bank account
  numbers and names, contact details, birthdates, and other personal/payroll fields.
  Do not expose raw request/provider payloads or exceptions that can echo them.
  Keep sensitive data, especially NRIC/FIN and bank details, out of notification
  emails; prefer reference IDs. Existing redaction helpers are not full anonymizers.
- Keep API keys in environment variables; never print secrets or commit `.env`.
  Protect OTPs and update tokens as credentials. Preserve server-side validation,
  redaction, CORS controls, verification/rate limits, and production HTTPS.
- **Localhost is not a safety boundary.** Local POST handlers can use real Talenox
  and Resend credentials. `npm run dev` and `NODE_ENV` do not enable mocking.
  Assess the target credentials/environment, not the hostname. Onboarding can
  continue external writes after a 202 response; failure paths can send email too.
- Ordinary local development must mock employee creation, all other Talenox calls,
  and outbound email (including invitations, OTPs, and failure notifications).
  Use only disposable, synthetic mocked fixtures, never production employee
  records or copied production data. Fake inputs or missing keys alone do not
  establish a safe mock environment.
- **Explicit approval required:** Before any real external mutation or email,
  confirm the target environment/account, affected records/recipients, intended
  operation, and authorization without exposing secrets or employee data. This
  includes Talenox employees, jobs, accounts/invitations, updates, and deletions.
  Never submit test fixtures to production or treat production records as cleanup.
- Stop before deployment, push, merge, destructive operations, or shared
  infrastructure changes unless explicitly authorized for that action and target.
  Documentation and scripts are not authorization. Preserve others' work.

## Completion contract

Autonomously inspect relevant files and callers, implement the requested change,
run focused mocked local checks, fix failures caused by the change, and rerun
affected tests. Keep scope narrow; do not require whole-repo reading or unrelated
test itineraries. Report the outcome, checks/results, and remaining limitations.
Stop at the safety boundaries above; a coding or testing request does not authorize
real external writes, email, deployment, push, or merge.

## Context when needed

- [README](README.md): setup, [mocked testing](README.md#testing), and product context.
  [package.json](package.json) is the command source of truth.
- [server.js](server.js) (Express) and [worker/index.mjs](worker/index.mjs)
  (Cloudflare) both route to the handlers in [backend](backend/), which have adjacent
  tests. `npm run mock-providers` serves synthetic Talenox and Resend for local runs. Inspect the relevant implementation rather than relying
  on historical feature inventories or provider examples.
- [Deployment notes](DEPLOYMENT.md) describe configured targets, not permission to
  deploy. Historical migration plans under `docs/` are not current runbooks.
- Employee-facing help uses `hr.onboarding@tk.sg`; `NOTIFY_EMAIL` and `FROM_EMAIL`
  are separate delivery settings and may use the `tinkertanker.com` mailbox.
- [CLAUDE.md](CLAUDE.md) imports this file; keep shared agent instructions here.
