# Tinkercademy Employee Onboarding System

Automated onboarding system for Tinkercademy employees with Talenox integration.

## Overview

A streamlined web form that automates employee onboarding by:
- Collecting employee information in a single form
- Creating employee records in Talenox automatically
- Sending notifications to HR
- Supporting multiple employee types (trainers, interns, full-time)

## Quick Start

### Local Development

Use synthetic data only and follow the [safety boundaries](AGENTS.md#safety-boundaries).
Local POST requests can create real Talenox records or send real email when the
server has credentials. Neither development mode nor a localhost URL prevents this.
Ordinary development must mock all Talenox calls and outbound email; see [Testing](#testing).

```bash
# Install dependencies
npm ci

# Run for UI inspection only; do not submit until external calls are mocked
npm run dev
# Visit http://localhost:3000
```

To submit forms locally, run the mock providers and point the app at them:

```bash
npm run mock-providers            # synthetic Talenox + Resend on 127.0.0.1:8790
cp .dev.vars.example .dev.vars    # mock URLs and dummy keys only
npm run worker:dev                # Cloudflare Worker locally (http://localhost:8787)
```

The mock holds one synthetic employee (NRIC `S0000001I`) for the update flow and
lists received requests, including email bodies, at `http://127.0.0.1:8790/__calls`.
The same `TALENOX_API_URL` and `RESEND_BASE_URL` values also work for Express.
Check the settings before submitting: whatever keys the app has are used for real.

The server loads `.env` as well as inherited environment variables. Do not load
production credentials for local development. [.env.example](.env.example) is a
configuration reference, not a mock preset; there is no built-in server mock mode.

### Deployment

The app runs as a Cloudflare Worker ([wrangler.jsonc](wrangler.jsonc)) or as the
original Express/Docker server. Deployment requires explicit approval for the
target. See [DEPLOYMENT.md](DEPLOYMENT.md) for configuration and approval
prerequisites; the checked-in Compose file targets shared infrastructure, not an
isolated local sandbox.

## Configuration

Integration settings in the process environment or `.env` (not needed for mocked tests):
- `TALENOX_API_KEY` - Talenox API credentials
- `TALENOX_API_URL` - Required API endpoint; `.env.example` uses `https://api.talenox.com/api/v2` (no server fallback)
- `RESEND_API_KEY` - Email service API key
- `NOTIFY_EMAIL` - HR notification email
- `FROM_EMAIL` - Sender email address
- `ALLOWED_ORIGINS` - Comma-separated allowed origins, required in production for
  Express. The Worker always allows same-origin requests and uses this only for other origins.
- `DATA_PROTECTION_KEY` - Random string of 32+ characters that keys hashes and encrypts
  stored verification state and queued submissions. Required for the Worker; Express
  generates a per-process key if it is unset.

## Features

- **Employee Types**: Support for trainers, interns, and full-time employees
- **Update Particulars**: Existing employees can use the link at the bottom of the onboarding page to verify their email and update personal or bank details
- **Data Validation**: NRIC/FIN format validation and required field checks
- **Banking Integration**: Support for major Singapore banks
- **Background Processing**: Handles long-running API operations reliably
- **Email Notifications**: Automatic HR notifications upon submission
- **Privacy**: NRIC/FIN and bank-number redaction exists, but is not full anonymization; never use real employee data for development

> **Note:** In Express, update-particulars OTP sessions are stored in memory, so run a
> single process. The Worker keeps them in one Durable Object, storing only keyed
> hashes, reference IDs and encrypted snapshots.

## Project Structure

```
├── public/                 # Static site (only this folder is served)
│   ├── index.html          # Main form interface (onboarding + update modes)
│   ├── styles.css          # Styling
│   └── script.js           # Form logic
├── server.js               # Express.js server
├── worker/                 # Cloudflare Worker, queue consumer and Durable Object
├── wrangler.jsonc          # Cloudflare configuration
├── backend/
│   ├── submit-onboarding.js    # New employee onboarding API
│   ├── update-particulars.js   # Existing employee update API
│   └── data-protection.js      # Encryption for stored/queued personal data
├── scripts/mock-providers.js   # Local synthetic Talenox + Resend
├── docker-compose.yml      # Docker configuration
├── Dockerfile              # Container definition
└── docs/                   # Additional documentation
```

## Testing

The automated suites use synthetic fixtures and mocked Talenox/email calls; they
do not need a running server or real credentials. Review mock coverage when
adding tests, including background and failure paths. Do not copy employee
records into fixtures, logs, screenshots, commits, or prompts.

```bash
# All backend tests
npm test

# Focus on the affected handler
node --test backend/submit-onboarding.test.js
node --test backend/update-particulars.test.js
node --test worker/index.test.mjs

# Bundle the Worker without deploying
npm run worker:build
```

Use [submit-onboarding.test.js](backend/submit-onboarding.test.js) for `global.fetch`
stubs and injected Resend clients (or disabled email where no send is tested).
[update-particulars.test.js](backend/update-particulars.test.js) injects both
`fetch` and `sendEmail` with `_testing.setRuntime`. Keep unexpected network calls
from falling through to real providers; dummy keys alone are not mocks.

**Manual tools are not isolated tests:** [test-api.js](test-api.js) and
[test.html](test.html) submit real HTTP requests and display input data. The CLI's
`API_URL` chooses the receiving server, not that server's upstream credentials.
Only use these tools with synthetic inputs after verifying server-side Talenox
and email mocking. A 202 response means accepted, not that background processing
succeeded or stopped. Real integration operations need separate explicit approval
and target confirmation; never send test fixtures to production.

## Troubleshooting

**Common Issues:**
- Validation errors: Check NRIC format (e.g., S1234567D)
- Server errors: Inspect logs locally without copying real employee data or secrets
- CORS issues: Verify ALLOWED_ORIGINS in environment

## Support

For issues or questions:
- Review relevant container logs without sharing employee data
- Review browser console for errors
- Contact the development team

## License

Internal use only - Tinkercademy/Tinkertanker
