import test from 'node:test';
import assert from 'node:assert/strict';

import worker from './index.mjs';
import dataProtection from '../backend/data-protection.js';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://hr.example.test';
const form = {
  employeeType: 'trainer',
  fullName: 'Alex Tan',
  email: 'alex@example.com',
  nric: 'S1234567D',
  nationality: 'Singaporean',
  citizenshipStatus: 'other',
  dob: '1990-01-15',
  gender: 'male',
  bank: 'DBS',
  accountName: 'Alex Tan',
  accountNumber: '123456789'
};

const makeEnv = (queueSend) => {
  const sent = [];
  return {
    sent,
    DATA_PROTECTION_KEY: KEY,
    ASSETS: { fetch: async () => new Response('asset') },
    ONBOARDING_QUEUE: { send: queueSend || (async (message) => { sent.push(message); }) }
  };
};

const submit = (env, headers = {}) => worker.fetch(new Request(`${ORIGIN}/api/submit-onboarding`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(form)
}), env);

test('plain HTTP is redirected to HTTPS before assets or API handlers run', async () => {
  const response = await worker.fetch(new Request('http://hr.example.test/?mode=update'), makeEnv());
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), 'https://hr.example.test/?mode=update');
});

test('cross-origin API calls need ALLOWED_ORIGINS; same-origin calls do not', async () => {
  const env = makeEnv();
  assert.equal((await submit(env, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(env.sent.length, 0);

  const sameOrigin = await submit(env, { Origin: ORIGIN });
  assert.equal(sameOrigin.status, 202);
  assert.equal(sameOrigin.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  env.ALLOWED_ORIGINS = 'https://other.example.test';
  assert.equal((await submit(env, { Origin: 'https://other.example.test' })).status, 202);
});

test('accepted submissions are queued encrypted and fail visibly if queueing fails', async () => {
  const env = makeEnv();
  assert.equal((await submit(env)).status, 202);
  const [message] = env.sent;
  const raw = JSON.stringify(message);
  for (const value of [form.nric, form.accountNumber, form.email]) assert.ok(!raw.includes(value));
  const opened = await dataProtection.openJson(message.sealed, KEY, 'onboarding-queue');
  assert.deepEqual(opened.formData, form);
  assert.equal(opened.requestId, message.requestId);

  const failing = makeEnv(async () => { throw new Error('queue unavailable'); });
  const response = await submit(failing);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Submission not received');

  const missingKey = makeEnv();
  delete missingKey.DATA_PROTECTION_KEY;
  assert.equal((await submit(missingKey)).status, 503);
  assert.equal(missingKey.sent.length, 0);
});

const streamRequest = (chunks) => new Request(`${ORIGIN}/api/submit-onboarding`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  duplex: 'half',
  body: new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  })
});

test('the body limit applies to streamed bodies without Content-Length', async () => {
  const env = makeEnv();
  const oversized = streamRequest(Array.from({ length: 11 }, () => new Uint8Array(10 * 1024).fill(32)));
  assert.equal(oversized.headers.get('Content-Length'), null);
  assert.equal((await worker.fetch(oversized, env)).status, 413);

  // A multi-byte character split across chunks must still decode correctly.
  const bytes = new TextEncoder().encode(JSON.stringify({ ...form, fullName: 'Zoë Tan' }));
  const split = bytes.indexOf(0xc3) + 1;
  const accepted = await worker.fetch(streamRequest([bytes.slice(0, split), bytes.slice(split)]), env);
  assert.equal(accepted.status, 202);
  const opened = await dataProtection.openJson(env.sent[0].sealed, KEY, 'onboarding-queue');
  assert.equal(opened.formData.fullName, 'Zoë Tan');
});

test('an oversized body that never ends is rejected once the drain bound is reached', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const request = new Request(`${ORIGIN}/api/submit-onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    duplex: 'half',
    body: new ReadableStream({ pull(controller) { controller.enqueue(chunk); } })
  });
  assert.equal((await worker.fetch(request, makeEnv())).status, 413);
});

test('the queue consumer leaves messages for retry when the key is missing', async () => {
  let acked = false;
  const batch = { messages: [{ body: { requestId: 'r1', sealed: 'x.y' }, ack: () => { acked = true; } }] };
  await assert.rejects(worker.queue(batch, {}), /DATA_PROTECTION_KEY/);
  assert.equal(acked, false);

  await worker.queue(batch, { DATA_PROTECTION_KEY: KEY });
  assert.equal(acked, true);
});
