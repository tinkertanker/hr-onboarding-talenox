const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');

test('Express rejects malformed and oversized JSON without logging request contents', { timeout: 5000 }, async (t) => {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://hr.example.test',
      TALENOX_API_URL: 'http://127.0.0.1:1/api/v2',
      TALENOX_API_KEY: 'mock-key',
      RESEND_BASE_URL: 'http://127.0.0.1:1',
      RESEND_API_KEY: 're_mock_key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', () => reject(new Error('Express exited before becoming ready')));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`Server running on port ${port}`)) resolve();
    });
  });

  const syntheticNric = 'S0000009Z';
  for (const [body, status] of [
    [JSON.stringify(syntheticNric), 400],
    [JSON.stringify({ padding: 'x'.repeat(110 * 1024) }), 413]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/submit-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    assert.equal(response.status, status);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.deepEqual(await response.json(), {
      success: false,
      message: status === 400 ? 'Invalid request' : 'Request too large'
    });
  }
  child.kill();
  await closed;
  assert.ok(!output.includes(syntheticNric), 'Parser errors must not echo the request body');
});

test('mock provider logs omit email subjects and their control characters', { timeout: 5000 }, async (t) => {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const child = spawn(process.execPath, ['scripts/mock-providers.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MOCK_PROVIDERS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', () => reject(new Error('Mock provider exited before becoming ready')));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`127.0.0.1:${port}`)) resolve();
    });
  });
  const subject = 'Synthetic subject\r\nFORGED RECORD\x1b[2J';
  const response = await fetch(`http://127.0.0.1:${port}/emails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject })
  });
  assert.equal(response.status, 200);
  const calls = await (await fetch(`http://127.0.0.1:${port}/__calls`)).json();
  assert.equal(calls[0].body.subject, subject, 'Synthetic payload remains available for local inspection');
  child.kill();
  await closed;
  assert.match(output, /POST \/emails/);
  for (const value of ['Synthetic subject', 'FORGED RECORD', '\r', '\x1b']) {
    assert.ok(!output.includes(value), 'Operational logs must not print email content');
  }
});
