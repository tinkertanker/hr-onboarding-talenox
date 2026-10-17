const test = require('node:test');
const assert = require('node:assert/strict');

const updateParticulars = require('./update-particulars');

const NRIC = 'S1234567D';
const API_URL = 'https://talenox.test/api/v2';

const makeEmployee = (overrides = {}) => ({
  id: 123,
  employee_id: '301',
  first_name: 'Alex Tan',
  last_name: '',
  identification_full_name: 'Alex Tan',
  email: 'alex@example.com',
  ssn: NRIC,
  citizenship: 'Contract (No CPF, No SDL)',
  nationality: 'Singaporean',
  gender: 'Male',
  birthdate: '1990-01-15',
  bank_account: {
    id: 77,
    bank_type: 'DBS',
    account_name: 'Alex Tan',
    number: '123456789'
  },
  ...overrides
});

const makeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const makeEvent = (body, clientIp = '203.0.113.10') => ({
  httpMethod: 'POST',
  headers: {},
  clientIp,
  body: JSON.stringify(body)
});

const parseResult = (result) => ({
  status: result.statusCode,
  body: JSON.parse(result.body)
});

const createRuntime = (employee, putStatuses = [200]) => {
  const calls = [];
  const emails = [];
  let putIndex = 0;

  updateParticulars._testing.setRuntime({
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === `${API_URL}/employees` && options.method === 'GET') {
        return makeResponse(200, employee ? [employee] : []);
      }
      if (url === `${API_URL}/employees/123` && options.method === 'GET') {
        return makeResponse(200, employee);
      }
      if (url === `${API_URL}/employees/123` && options.method === 'PUT') {
        const status = putStatuses[Math.min(putIndex, putStatuses.length - 1)];
        putIndex += 1;
        return makeResponse(status, status === 200 ? employee : { error: 'upstream failure' });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${url}`);
    },
    sendEmail: async (email) => {
      emails.push(email);
      return { data: { id: `email-${emails.length}` } };
    },
    upstreamTimeoutMs: 100
  });

  return { calls, emails };
};

const requestAndVerify = async (runtimeState) => {
  const request = parseResult(await updateParticulars.requestCodeHandler(
    makeEvent({ nric: NRIC })
  ));
  assert.equal(request.status, 200);

  const verificationEmail = runtimeState.emails.find((email) =>
    email.subject.includes('verification code')
  );
  assert.ok(verificationEmail);
  assert.deepEqual(verificationEmail.to, 'alex@example.com');
  const code = verificationEmail.text.match(/is: (\d{6})/)[1];

  const verified = parseResult(await updateParticulars.verifyCodeHandler(
    makeEvent({ nric: NRIC, verificationCode: code })
  ));
  assert.equal(verified.status, 200);
  return { code, ...verified.body };
};

test.beforeEach(() => {
  updateParticulars._testing.reset();
  process.env.TALENOX_API_KEY = 'test-key';
  process.env.TALENOX_API_URL = API_URL;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.NOTIFY_EMAIL = 'hr@example.com';
});

test('unknown NRIC returns the generic response after one bounded list request', async () => {
  const runtimeState = createRuntime(null);
  const result = parseResult(await updateParticulars.requestCodeHandler(
    makeEvent({ nric: NRIC })
  ));

  assert.equal(result.status, 200);
  assert.match(result.body.message, /If this NRIC\/FIN is on our records/);
  assert.equal(runtimeState.calls.length, 1);
  assert.equal(runtimeState.calls[0].url, `${API_URL}/employees`);
  assert.equal(runtimeState.emails.length, 0);
  assert.equal(updateParticulars._testing.state().otpCount, 0);
});

test('OTP verification is single-use and returns only a safe editable snapshot', async () => {
  const runtimeState = createRuntime(makeEmployee());
  const verified = await requestAndVerify(runtimeState);

  assert.equal(verified.particulars.fullName, 'Alex Tan');
  assert.equal(verified.particulars.accountNumberLast4, '6789');
  assert.equal(verified.particulars.accountNumber, undefined);
  assert.equal(verified.particulars.id, undefined);
  assert.equal(verified.particulars.employee_id, undefined);
  assert.equal(verified.particulars.nric, undefined);
  assert.equal(verified.particulars.ssn, undefined);
  assert.equal(updateParticulars._testing.state().otpCount, 0);
  assert.equal(updateParticulars._testing.state().verifiedSessionCount, 1);

  const replay = parseResult(await updateParticulars.verifyCodeHandler(
    makeEvent({ nric: NRIC, verificationCode: verified.code })
  ));
  assert.equal(replay.status, 401);
});

test('stored verification state contains no raw identifiers, codes, tokens or particulars', async () => {
  const runtimeState = createRuntime(makeEmployee());
  const dumpState = () => JSON.stringify(
    Object.fromEntries(Object.entries(updateParticulars._testing.state().stores)
      .map(([name, store]) => [name, [...store.entries()]]))
  );
  const forbidden = (extra = []) => [
    NRIC, '203.0.113.10', 'alex@example.com', 'Alex Tan', '123456789', 'DBS', '1990-01-15', ...extra
  ];

  await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC }));
  const code = runtimeState.emails[0].text.match(/is: (\d{6})/)[1];
  const afterRequest = dumpState();
  for (const value of forbidden([code])) assert.ok(!afterRequest.includes(value), value);

  const verified = parseResult(await updateParticulars.verifyCodeHandler(
    makeEvent({ nric: NRIC, verificationCode: code })
  ));
  assert.equal(verified.body.particulars.bank, 'DBS');
  const afterVerify = dumpState();
  for (const value of forbidden([code, verified.body.updateToken])) {
    assert.ok(!afterVerify.includes(value), value);
  }
});

test('persistent-state mode refuses to run without a stable protection key', async () => {
  createRuntime(makeEmployee());
  updateParticulars.configureState({ requireProtectionKey: true });
  delete process.env.DATA_PROTECTION_KEY;

  const result = parseResult(await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC })));
  assert.equal(result.status, 500);
  assert.equal(updateParticulars._testing.state().otpCount, 0);
});

test('a bank-only update preserves all other fields and uses the documented envelope', async () => {
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);

  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    accountNumber: '987654321',
    updateToken: verified.updateToken
  })));

  assert.equal(result.status, 200);
  const putCall = runtimeState.calls.find((call) => call.options.method === 'PUT');
  assert.ok(putCall);
  assert.deepEqual(JSON.parse(putCall.options.body), {
    employee: {
      bank_account_attributes: {
        number: '987654321',
        id: 77
      }
    }
  });
  assert.equal(updateParticulars._testing.state().verifiedSessionCount, 0);

  const replay = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    accountNumber: '987654321',
    updateToken: verified.updateToken
  })));
  assert.equal(replay.status, 401);
});

test('an unchanged Other classification is preserved rather than mapped to contractor', async () => {
  const employee = makeEmployee({ citizenship: 'Employment Pass' });
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);

  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  })));

  assert.equal(result.status, 200);
  const putBody = JSON.parse(
    runtimeState.calls.find((call) => call.options.method === 'PUT').options.body
  );
  assert.deepEqual(putBody, { employee: { email: 'alex.new@example.com' } });
  assert.equal(putBody.employee.citizenship, undefined);
});

test('an unchanged legacy bank label is preserved during an unrelated update', async () => {
  const employee = makeEmployee({
    bank_account: {
      id: 77,
      bank_type: 'OCBC',
      account_name: 'Alex Tan',
      number: '123456789'
    }
  });
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);

  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  })));

  assert.equal(result.status, 200);
  const putBody = JSON.parse(
    runtimeState.calls.find((call) => call.options.method === 'PUT').options.body
  );
  assert.deepEqual(putBody, { employee: { email: 'alex.new@example.com' } });
  assert.equal(putBody.employee.bank_account_attributes, undefined);
});

test('changing a legacy bank label to an unsupported value is rejected', async () => {
  const employee = makeEmployee({
    bank_account: {
      id: 77,
      bank_type: 'OCBC',
      account_name: 'Alex Tan',
      number: '123456789'
    }
  });
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);

  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    bank: 'Not A Bank',
    accountNumber: '',
    updateToken: verified.updateToken
  })));

  assert.equal(result.status, 400);
  assert.match(result.body.details.join('\n'), /Invalid bank selection/);
  assert.equal(runtimeState.calls.some((call) => call.options.method === 'PUT'), false);
});

test('five incorrect codes invalidate the OTP', async () => {
  const runtimeState = createRuntime(makeEmployee());
  await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC }));
  const verificationEmail = runtimeState.emails.find((email) =>
    email.subject.includes('verification code')
  );
  const correctCode = verificationEmail.text.match(/is: (\d{6})/)[1];
  const wrongCode = correctCode === '000000' ? '111111' : '000000';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = parseResult(await updateParticulars.verifyCodeHandler(
      makeEvent({ nric: NRIC, verificationCode: wrongCode })
    ));
    assert.equal(result.status, 401);
  }

  const result = parseResult(await updateParticulars.verifyCodeHandler(
    makeEvent({ nric: NRIC, verificationCode: correctCode })
  ));
  assert.equal(result.status, 401);
  assert.equal(updateParticulars._testing.state().otpCount, 0);
});

test('a Talenox failure keeps the verified session available for retry', async () => {
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee, [500, 200]);
  const verified = await requestAndVerify(runtimeState);
  const submission = {
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  };

  const failed = parseResult(await updateParticulars.handler(makeEvent(submission)));
  assert.equal(failed.status, 502);
  assert.equal(updateParticulars._testing.state().verifiedSessionCount, 1);

  const retried = parseResult(await updateParticulars.handler(makeEvent(submission)));
  assert.equal(retried.status, 200);
  assert.equal(updateParticulars._testing.state().verifiedSessionCount, 0);
  assert.equal(runtimeState.calls.filter((call) => call.options.method === 'PUT').length, 2);
});

test('concurrent submissions can claim a verified token only once', async () => {
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);
  const submission = makeEvent({
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  });

  const first = updateParticulars.handler(submission);
  const second = updateParticulars.handler(submission);
  const results = (await Promise.all([first, second]))
    .map(parseResult)
    .map((result) => result.status)
    .sort();

  assert.deepEqual(results, [200, 409]);
  assert.equal(runtimeState.calls.filter((call) => call.options.method === 'PUT').length, 1);
});

test('verified sessions expire before an update can be submitted', async () => {
  let currentTime = Date.parse('2026-07-22T00:00:00Z');
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee);
  updateParticulars._testing.setRuntime({ now: () => currentTime });
  const verified = await requestAndVerify(runtimeState);
  const callCountBeforeSubmit = runtimeState.calls.length;

  currentTime += 16 * 60 * 1000;
  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  })));

  assert.equal(result.status, 401);
  assert.equal(runtimeState.calls.length, callCountBeforeSubmit);
  assert.equal(updateParticulars._testing.state().verifiedSessionCount, 0);
});

test('employee lookup times out while reading a stalled response body', async () => {
  updateParticulars._testing.setRuntime({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    }),
    sendEmail: async () => ({ data: { id: 'unused' } }),
    upstreamTimeoutMs: 10
  });

  const startedAt = Date.now();
  const result = parseResult(await updateParticulars.requestCodeHandler(
    makeEvent({ nric: NRIC })
  ));

  assert.equal(result.status, 200);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(updateParticulars._testing.state().otpCount, 0);
});

test('the final update rejects a record whose NRIC changed after verification', async () => {
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);
  employee.ssn = 'T7654321A';

  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  })));

  assert.equal(result.status, 409);
  assert.equal(runtimeState.calls.some((call) => call.options.method === 'PUT'), false);
  assert.equal(updateParticulars._testing.state().verifiedSessionCount, 0);
});
