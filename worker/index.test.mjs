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
