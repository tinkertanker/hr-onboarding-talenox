// Cloudflare Worker entry point: static assets, the API routes from server.js,
// the onboarding queue consumer, and the Durable Object that holds
// update-particulars state.

import submitOnboarding from '../backend/submit-onboarding.js';
import updateParticulars from '../backend/update-particulars.js';
import dataProtection from '../backend/data-protection.js';
import { countStoredRows, createSqlStores } from './sql-store.mjs';

const MAX_BODY_BYTES = 100 * 1024; // Matches express.json()'s default limit
const MAX_DRAIN_BYTES = 1024 * 1024;
const STATE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const QUEUE_CONTEXT = 'onboarding-queue';

const PARTICULARS_HANDLERS = {
  '/api/update-particulars/request-code': updateParticulars.requestCodeHandler,
  '/api/update-particulars/verify-code': updateParticulars.verifyCodeHandler,
  '/api/update-particulars': updateParticulars.handler
};
const API_ROUTES = new Set(['/api/submit-onboarding', ...Object.keys(PARTICULARS_HANDLERS)]);

const isLocalHost = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

const protectionKey = (env) => {
  const key = env.DATA_PROTECTION_KEY;
  if (!key || key.length < 32) throw new Error('DATA_PROTECTION_KEY missing or too short');
  return key;
};

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });

// Same-origin requests and requests without an Origin are always allowed;
// cross-origin callers must be listed in ALLOWED_ORIGINS. Returns null to reject.
const corsHeaders = (request, env) => {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (origin !== new URL(request.url).origin && !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin'
  };
};

// Counts bytes as they arrive: chunked requests have no Content-Length.
const readBody = async (request) => {
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // Past the limit, drain without storing so ordinary oversized requests end
    // cleanly (cancelling broke the next request on the connection in wrangler
    // dev), but stop a body that keeps going.
    if (total > MAX_DRAIN_BYTES) {
      await reader.cancel();
      return null;
    }
    if (total <= MAX_BODY_BYTES) chunks.push(value);
  }
  if (total > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

// Function-style handlers may set their own CORS headers; the Worker owns CORS.
const toResponse = (result, cors) => {
  const headers = new Headers(cors);
  for (const [key, value] of Object.entries(result.headers || {})) {
    if (!key.toLowerCase().startsWith('access-control-') && value) headers.set(key, value);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Response(result.body, { status: result.statusCode, headers });
};

const particularsStub = (env) => env.PARTICULARS_STATE.get(
  env.PARTICULARS_STATE.idFromName('global'),
  { locationHint: 'apac' }
);

const handleApi = async (request, env, url) => {
  if (url.pathname === '/api/health') {
    return jsonResponse(200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'tinkercademy-onboarding'
    });
  }
  if (!API_ROUTES.has(url.pathname)) return jsonResponse(404, { error: 'Not found' });

  const cors = corsHeaders(request, env);
  if (!cors) return jsonResponse(403, { error: 'Origin not allowed' });
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' }, cors);

  const body = await readBody(request);
  if (body === null) return jsonResponse(413, { error: 'Request too large' }, cors);
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  try {
    if (url.pathname === '/api/submit-onboarding') {
      const result = await submitOnboarding.handler(
        { httpMethod: 'POST', headers: {}, clientIp, body },
        {
          dispatch: async (formData, requestId) => {
            const sealed = await dataProtection.sealJson(
              { formData, requestId },
              protectionKey(env),
              QUEUE_CONTEXT
            );
            await env.ONBOARDING_QUEUE.send({ requestId, sealed });
          }
        }
      );
      return toResponse(result, cors);
    }

    // All update-particulars traffic goes through one Durable Object, which
    // serialises state access the way the single Express process did.
    const response = await particularsStub(env).fetch(`https://particulars-state${url.pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-IP': clientIp },
      body
    });
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    console.error(`Error in ${url.pathname}`);
    return jsonResponse(500, { success: false, message: 'Internal server error' }, cors);
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },

  // max_batch_size is 1 and max_concurrency is 1, so submissions run one at a
  // time and employee ID allocation cannot race.
  async queue(batch, env) {
    // A missing key is a configuration error: throw so the queue retries
    // rather than acking (and losing) submissions.
    const key = protectionKey(env);
    for (const message of batch.messages) {
      const requestId = message.body && message.body.requestId;
      let submission;
      try {
        submission = await dataProtection.openJson(message.body.sealed, key, QUEUE_CONTEXT);
      } catch {
        // Retrying cannot help, and there is no readable address to notify.
        console.error(`[${requestId}] Discarding unreadable onboarding message`);
        message.ack();
        continue;
      }

      try {
        await submitOnboarding.processOnboarding(submission.formData, submission.requestId);
      } catch {
        // processOnboarding has already logged the error and emailed HR and the
        // submitter. Acking avoids a retry that could repeat Talenox writes.
      }
      message.ack();
    }
  }
};

export class ParticularsState {
  constructor(ctx) {
    this.ctx = ctx;
    updateParticulars.configureState({
      stores: createSqlStores(ctx.storage.sql),
      requireProtectionKey: true
    });
  }

  async fetch(request) {
    const handler = PARTICULARS_HANDLERS[new URL(request.url).pathname];
    if (!handler) return jsonResponse(404, { error: 'Not found' });

    const result = await handler({
      httpMethod: 'POST',
      headers: {},
      clientIp: request.headers.get('X-Client-IP') || 'unknown',
      body: await request.text()
    });
    await this.scheduleCleanup();
    return new Response(result.body, {
      status: result.statusCode,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Expired state is also purged on each request; the alarm covers idle periods.
  async alarm() {
    updateParticulars.cleanupExpiredState();
    await this.scheduleCleanup();
  }

  async scheduleCleanup() {
    if (!countStoredRows(this.ctx.storage.sql)) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + STATE_CLEANUP_INTERVAL_MS);
    }
  }
}
