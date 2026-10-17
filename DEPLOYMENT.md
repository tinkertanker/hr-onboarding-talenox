# Deployment reference

**Deployment is an external write, not a routine verification step.** Obtain
explicit approval for the target and revision before deploying, restarting, or
stopping shared services. Push and merge require their own authorization. Follow
the [employee-data and external-action boundaries](AGENTS.md#safety-boundaries).

## Cloudflare Workers

[wrangler.jsonc](wrangler.jsonc) defines the Worker `hr-onboarding` (Workers Paid plan):

- Static site from `public/`; the Worker runs first and redirects HTTP to HTTPS.
- `POST /api/submit-onboarding` validates, encrypts the submission with
  `DATA_PROTECTION_KEY`, queues it on `hr-onboarding-submissions` and returns 202.
  The queue consumer runs the existing onboarding logic one message at a time.
- Update-particulars requests go to one SQLite-backed Durable Object
  (`ParticularsState`, location hint APAC). It stores keyed hashes, reference IDs
  and encrypted snapshots, purges expired rows on requests and by alarm, and
  survives restarts. Cloudflare may keep deleted rows in its 30-day recovery history.
- No public URL until a route is added (`workers_dev` is off). Persistent Workers
  Logs are off because redacted logs still contain names and emails; use
  `npx wrangler tail` for live logs.

Every step below is an external write. Get explicit approval for the Cloudflare
account and each step, and do not print secret values.

1. Authenticate Wrangler to the Tinkertanker account pinned in `wrangler.jsonc`
   (`npx wrangler whoami` to confirm).
2. Create the queue: `npx wrangler queues create hr-onboarding-submissions`.
3. Set secrets with `npx wrangler secret put <NAME>`: `TALENOX_API_KEY`,
   `RESEND_API_KEY`, `NOTIFY_EMAIL`, `FROM_EMAIL`, and `DATA_PROTECTION_KEY`
   (`openssl rand -base64 32`, kept in the team password manager). Changing the key
   invalidates outstanding codes and any queued submissions. `TALENOX_API_URL` is a
   checked-in var. `ALLOWED_ORIGINS` is only needed for other-origin callers.
4. `npx wrangler deploy` with the reviewed revision. The Durable Object migration
   `v1` runs on the first deploy.
5. Domain: `wrangler.jsonc` attaches `hr-onboarding.tk.sg` (zone `tk.sg`, same
   account) as a custom domain. The hostname has no DNS record of its own; it
   previously reached the Docker server through the `*.tk.sg` wildcard. To roll back,
   remove the custom domain (Workers > hr-onboarding > Domains, or comment out
   `routes` and redeploy) and the wildcard routes traffic to the server again.
6. Check `/` and `/api/health` only. Do not submit test data to production.

## Docker / Express (current server)

### Checked-in configuration

- Repository: `tinkertanker/hr-onboarding-talenox`.
- [deploy.sh](deploy.sh) connects to `tinkertanker@dev.tk.sg`, enters
  `Docker/hr-onboarder-talenox`, pulls the remote checkout's current tracking branch,
  then rebuilds/restarts with Docker Compose. It does not select or pin a revision.
- [docker-compose.yml](docker-compose.yml) configures `hr-onboarding.tk.sg`, internal
  port 3000, the external `devtksg` network, and nginx-proxy / Let's Encrypt routing.
  It loads `.env` and sets `NODE_ENV=production`; it is not a local mock environment.
- [Dockerfile](Dockerfile) defines the runtime image. The health check is a read-only
  GET to `/api/health`; it does not validate Talenox integration or email delivery.

These are repository-configured targets, not confirmation of live server state.
Older migration documents may name different repositories, branches, or paths.

### Before an authorized deployment

Confirm the live checkout path, remote, branch, exact revision, working-tree state,
and rollback plan. Do not run `deploy.sh` blindly: its unpinned pull may deploy more
than the reviewed change. Confirm the shared network/proxy and TLS configuration.

Confirm the intended Talenox account/API endpoint and Resend sender/recipients
without printing credentials or employee data. See [configuration](README.md#configuration)
and [.env.example](.env.example); production also requires `ALLOWED_ORIGINS`, which
the template does not currently include. Keep `.env` out of version control.

Under Express, update-particulars OTP/session storage is in memory: retain a single
app process; a restart invalidates active sessions.

After an authorized rollout, check health and inspect logs without copying employee
data or secrets. Deployment approval does not authorize test employee creation,
updates, invitations, OTPs, or other real email. Never submit fixtures to production.
Update the infrastructure's Active Containers documentation when applicable.
