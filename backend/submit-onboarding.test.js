const test = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

const submitOnboarding = require('./submit-onboarding');

// Exercise the public processor and the real Resend SDK, stopping all network
// traffic at fetch. Unexpected requests fail closed rather than reaching a provider.
const mockProviders = (t, {
  employees = [], lookupStatus = 200, creationStatus = 200,
  creationError = {}, emailStatuses = [200], lookupError = null
} = {}) => {
  const calls = [];
  const emails = [];
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    const { pathname } = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ pathname, method, body });
    if (pathname === '/api/v2/employees' && method === 'GET') {
      if (lookupError) throw lookupError;
      return Response.json(employees, { status: lookupStatus });
    }
    if (pathname === '/api/v2/employees' && method === 'POST') {
      return Response.json(creationStatus === 200 ? { id: 9001 } : creationError, { status: creationStatus });
    }
    if (pathname === '/api/v2/jobs' && method === 'POST') return Response.json({ id: 9002 });
    if (pathname === '/emails' && method === 'POST') {
      const status = emailStatuses[Math.min(emails.length, emailStatuses.length - 1)];
      emails.push(body);
      return Response.json(status === 200 ? { id: 'mock-email' } : {
        name: 'validation_error', message: 'Invalid recipient'
      }, { status });
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  });
  return { calls, emails };
};

const formData = {
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

test.beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.NOTIFY_EMAIL = 'hr@example.com';
  process.env.TALENOX_API_KEY = 'test-talenox-key';
  process.env.TALENOX_API_URL = 'https://talenox.test/api/v2';
  process.env.RESEND_BASE_URL = 'https://resend.test';
});

test('onboarding accepts only string emails up to 254 characters before dispatch', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('Unexpected provider call'); });
  t.mock.method(console, 'log', () => {});
  for (const [email, accepted] of [
    ['a'.repeat(242) + '@example.com', true],
    ['a'.repeat(243) + '@example.com', false],
    [['alex@example.com'], false],
    ['a@' + '.'.repeat(20000) + ' ', false],
    ['alex+tag@dept.example.test', true],
    ['alex@example', false],
    ['alex@example.', false],
    ['alex@.test', false],
    ['alex@@example.test', false]
  ]) {
    let dispatched = false;
    const result = await submitOnboarding.handler({
      httpMethod: 'POST', body: JSON.stringify({ ...formData, email })
    }, { dispatch: async () => { dispatched = true; } });
    assert.equal(result.statusCode, accepted ? 202 : 400);
    assert.equal(dispatched, accepted);
    if (!accepted) assert.ok(JSON.parse(result.body).details.includes('Invalid email format'));
  }
});

test('onboarding failures notify HR and submitter, falling back to HR when delivery is rejected', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  for (const emailStatuses of [[200], [400, 200], [400, 400]]) {
    output.length = 0;
    const { calls, emails } = mockProviders(t, { lookupStatus: 503, emailStatuses });
    await assert.rejects(submitOnboarding.processOnboarding(formData, 'test-failure'),
      /Could not retrieve existing employees/);
    assert.equal(calls.some((call) => call.pathname.startsWith('/api/v2/') && call.method === 'POST'), false);
    assert.deepEqual(emails.map((email) => email.to), emailStatuses.length === 1
      ? [['hr@example.com', 'alex@example.com']]
      : [['hr@example.com', 'alex@example.com'], ['hr@example.com']]);
    assert.equal(emails[0].reply_to, 'hr@example.com');
    assert.match(emails[0].text, /could not finish setting up the account/);
    for (const email of emails) {
      for (const value of [formData.nric, formData.accountNumber, formData.dob]) {
        assert.ok(!email.text.includes(value));
      }
    }
    if (emailStatuses[1] === 400) {
      assert.ok(!output.join('\n').includes('sent to HR only'));
      assert.match(output.join('\n'), /Failed to send failure notification/);
    }
  }
});

test('submission logs exclude particulars, malformed input and dispatch exceptions', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(inspect(args)));
  t.mock.method(console, 'error', (...args) => output.push(inspect(args)));
  const event = { httpMethod: 'POST', body: JSON.stringify(formData) };
  const accepted = await submitOnboarding.handler(event, { dispatch: async () => {} });
  assert.equal(accepted.statusCode, 202);
  const unavailable = await submitOnboarding.handler(event, {
    dispatch: async () => { throw new Error(`Rejected ${formData.email}`); }
  });
  assert.equal(unavailable.statusCode, 503);
  const malformed = await submitOnboarding.handler({
    ...event, body: `{"nric":"${formData.nric}", invalid}`
  });
  assert.equal(malformed.statusCode, 400);

  for (const value of [formData.fullName, formData.email, formData.nric, formData.dob, formData.accountNumber]) {
    assert.ok(!output.join('\n').includes(value), `Logs must not contain ${value}`);
  }
  assert.match(output.join('\n'), /Could not queue submission/);
  assert.match(output.join('\n'), /Request parsing error/);
});

test('only identity conflicts send the already-registered explanation to HR and submitter', async (t) => {
  for (const [creationError, duplicate] of [
    [{ errors: { email: ['is already registered to another employee'] } }, true],
    [{ errors: { hired_date: ['is invalid'] } }, false],
    [{ errors: { employee_id: ['has already been taken'] } }, false],
    [{ errors: { email: ['is invalid'], employee_id: ['has already been taken'] } }, false]
  ]) {
    const { calls, emails } = mockProviders(t, { creationStatus: 400, creationError });
    await assert.rejects(submitOnboarding.processOnboarding(formData, 'test-conflict'),
      duplicate ? /already registered/ : /Failed to create employee/);
    assert.equal(calls.filter((call) => call.pathname === '/api/v2/employees' && call.method === 'POST').length, 1);
    assert.equal(calls.some((call) => call.pathname === '/api/v2/jobs'), false);
    assert.equal(emails.length, 1);
    assert.deepEqual(emails[0].to, ['hr@example.com', 'alex@example.com']);
    assert.equal(emails[0].subject.includes('Already registered'), duplicate);
    if (duplicate) {
      assert.match(emails[0].text, /No new account was created/);
      assert.match(emails[0].text, /HR has been notified and will check the existing profile/);
      assert.match(emails[0].text, /Please do not submit the form again/);
    } else {
      assert.match(emails[0].text, /could not finish setting up the account/);
    }
  }
});

test('duplicate prevention requires both the normalized name and email to match', async (t) => {
  for (const [first_name, email, duplicate] of [
    ['  ALEX   TAN ', 'Alex@Example.com', true],
    ['Different Person', 'Alex@Example.com', false],
    ['  ALEX   TAN ', 'different@example.com', false]
  ]) {
    const { calls, emails } = mockProviders(t, {
      employees: [{ id: 9876, employee_id: '432', first_name, email }]
    });
    if (duplicate) {
      await assert.rejects(submitOnboarding.processOnboarding(formData, 'test-duplicate'), /already registered/);
      assert.equal(calls.some((call) => call.method === 'POST' && call.pathname === '/api/v2/employees'), false);
      assert.match(emails[0].subject, /Already registered/);
    } else {
      const result = await submitOnboarding.processOnboarding(formData, 'test-distinct');
      assert.deepEqual(result, { success: true, employeeId: 9001, jobId: 9002, jobCreated: true });
      const created = calls.filter((call) => call.method === 'POST' && call.pathname === '/api/v2/employees');
      assert.equal(created.length, 1);
      assert.equal(created[0].body.employee_id, '433');
      assert.equal(created[0].body.invite_user, true);
      assert.equal(calls.find((call) => call.pathname === '/api/v2/jobs').body.employee_id, 9001);
      assert.deepEqual(emails[0].to, ['hr@example.com']);
    }
  }
});

test('a Talenox employee-creation failure keeps particulars out of logs and notification emails', async (t) => {
  const sentinelNric = 'S7654321Z';
  const sentinelAccount = '9988776655';
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args));
  t.mock.method(console, 'error', (...args) => output.push(args));
  const { emails } = mockProviders(t, {
    creationStatus: 422,
    creationError: { message: `Rejected ${sentinelNric} with account ${sentinelAccount}` }
  });
  await assert.rejects(submitOnboarding.processOnboarding(
    { ...formData, nric: sentinelNric, accountNumber: sentinelAccount }, 'test-request'
  ), /Failed to create employee in Talenox/);
  assert.equal(emails.length, 1);
  for (const value of [sentinelNric, sentinelAccount, formData.dob]) {
    assert.ok(!JSON.stringify(emails).includes(value));
  }

  const serialisedOutput = output
    .flat()
    .map((value) => value instanceof Error
      ? `${value.name}: ${value.message}\n${value.stack || ''}`
      : inspect(value, { depth: null }))
    .join('\n');
  assert.equal(serialisedOutput.includes(sentinelNric), false);
  assert.equal(serialisedOutput.includes(sentinelAccount), false);
  for (const value of [formData.fullName, formData.email, formData.dob]) {
    assert.ok(!serialisedOutput.includes(value), `Logs must not contain ${value}`);
  }
  assert.match(serialisedOutput, /Talenox employee creation failed/);
  assert.match(serialisedOutput, /422/);
});

test('onboarding logs exclude unexpected provider exceptions', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(inspect(args)));
  t.mock.method(console, 'error', (...args) => output.push(inspect(args)));
  const { emails } = mockProviders(t, { lookupError: new Error(`Invalid ${formData.nric}`) });

  await assert.rejects(submitOnboarding.processOnboarding(formData, 'test-provider-error'),
    /Could not retrieve existing employees/);
  assert.equal(emails.length, 1);
  assert.ok(!JSON.stringify(emails).includes(formData.nric));
  assert.ok(!output.join('\n').includes(formData.nric));
  assert.match(output.join('\n'), /Could not fetch existing employees/);
});
