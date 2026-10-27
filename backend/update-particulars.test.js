const test = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

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
  let markPutStarted;
  const putStarted = new Promise((resolve) => { markPutStarted = resolve; });

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
        markPutStarted();
        const status = await putStatuses[Math.min(putIndex, putStatuses.length - 1)];
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

  return { calls, emails, putStarted };
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

  updateParticulars._testing.reset();
  const known = createRuntime(makeEmployee());
  const knownResult = parseResult(await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC })));
  assert.deepEqual(knownResult, result, 'The response must not reveal whether an employee exists');
  assert.equal(known.emails.length, 1);
});

test('updates reject non-string and oversized emails without consuming the verified session', async () => {
  const runtimeState = createRuntime(makeEmployee());
  const verified = await requestAndVerify(runtimeState);
  const callsBeforeValidation = runtimeState.calls.length;
  for (const email of [
    'a'.repeat(243) + '@example.com',
    ['alex@example.com'],
    'a@' + '.'.repeat(20000) + ' '
  ]) {
    const result = parseResult(await updateParticulars.handler(makeEvent({
      ...verified.particulars, updateToken: verified.updateToken, email
    })));
    assert.equal(result.status, 400);
    assert.ok(result.body.details.includes('Invalid email format'));
    assert.equal(runtimeState.calls.length, callsBeforeValidation);
  }
  const email = 'a'.repeat(242) + '@example.com';
  const result = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars, updateToken: verified.updateToken, email
  })));
  assert.equal(result.status, 200);
  const put = runtimeState.calls.find((call) => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(put.options.body), { employee: { email } });
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
  const runtimeState = createRuntime(makeEmployee());
  updateParticulars.configureState({ requireProtectionKey: true });
  delete process.env.DATA_PROTECTION_KEY;

  const result = parseResult(await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC })));
  assert.equal(result.status, 500);
  assert.equal(runtimeState.calls.length, 0);
  assert.equal(runtimeState.emails.length, 0);
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

  const replay = parseResult(await updateParticulars.handler(makeEvent({
    ...verified.particulars,
    accountNumber: '987654321',
    updateToken: verified.updateToken
  })));
  assert.equal(replay.status, 401);
});

test('an email-only update preserves Other citizenship, legacy bank labels and a blank account number', async () => {
  const employee = makeEmployee({
    citizenship: 'Employment Pass',
    bank_account: { id: 77, bank_type: 'OCBC', account_name: 'Alex Tan', number: '123456789' }
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
});

test('update notifications run independently after PUT and never replay a successful update', async () => {
  for (const [previousEmailOk, hrOk] of [[true, true], [true, false], [false, true], [false, false]]) {
    updateParticulars._testing.reset();
    let finishPut;
    const putStatus = new Promise((resolve) => { finishPut = resolve; });
    const runtimeState = createRuntime(makeEmployee(), [putStatus]);
    const verified = await requestAndVerify(runtimeState);
    let finishPreviousEmail;
    let failPreviousEmail;
    const previousEmail = new Promise((resolve, reject) => {
      finishPreviousEmail = resolve;
      failPreviousEmail = reject;
    });
    const notices = [];
    updateParticulars._testing.setRuntime({
      sendEmail: async (email) => {
        notices.push(email);
        if (email.to === 'alex@example.com') return previousEmail;
        // HR delivery must begin without waiting for the previous-address notice.
        if (previousEmailOk) finishPreviousEmail({ data: { id: 'previous-email' } });
        else failPreviousEmail(new Error('Previous-address delivery unavailable'));
        if (!hrOk) throw new Error('HR delivery unavailable');
        return { data: { id: 'hr-email' } };
      }
    });
    const submission = makeEvent({
      ...verified.particulars,
      email: 'alex.new@example.com',
      accountNumber: '',
      updateToken: verified.updateToken
    });

    const pending = updateParticulars.handler(submission);
    await runtimeState.putStarted;
    assert.equal(runtimeState.calls.filter((call) => call.options.method === 'PUT').length, 1);
    assert.deepEqual(notices, [], 'No success notice may precede a successful PUT');
    finishPut(200);
    const result = parseResult(await pending);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.notifications, { previousEmail: previousEmailOk, hr: hrOk });
    assert.deepEqual(notices.map((email) => email.to).sort(), ['alex@example.com', 'hr@example.com']);
    assert.equal(parseResult(await updateParticulars.handler(submission)).status, 401);
    assert.equal(runtimeState.calls.filter((call) => call.options.method === 'PUT').length, 1);
  }
});

test('verification logs exclude addresses and raw provider failures', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(inspect(args, { depth: null })));
  t.mock.method(console, 'error', (...args) => output.push(inspect(args, { depth: null })));
  const runtimeState = createRuntime(makeEmployee());
  await requestAndVerify(runtimeState);

  updateParticulars._testing.reset();
  createRuntime(makeEmployee());
  updateParticulars._testing.setRuntime({
    sendEmail: async () => { throw new Error('Rejected alex@example.com'); }
  });
  const emailFailure = parseResult(await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC })));
  assert.equal(emailFailure.status, 200);
  assert.match(output.join('\n'), /Verification email failed/);

  updateParticulars._testing.reset();
  updateParticulars._testing.setRuntime({
    fetch: async () => { throw new Error(`Provider rejected ${NRIC}`); },
    sendEmail: async () => ({})
  });
  const result = parseResult(await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC })));
  assert.equal(result.status, 200);
  for (const value of [NRIC, 'example.com', 'Alex Tan', '1990-01-15', '123456789']) {
    assert.ok(!output.join('\n').includes(value), `Logs must not contain ${value}`);
  }
  assert.match(output.join('\n'), /Employee lookup failed/);
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

test('five incorrect codes invalidate the OTP, but four still permit correct verification', async () => {
  for (const [wrongAttempts, expectedStatus] of [[4, 200], [5, 401]]) {
    updateParticulars._testing.reset();
    const runtimeState = createRuntime(makeEmployee());
    await updateParticulars.requestCodeHandler(makeEvent({ nric: NRIC }));
    const correctCode = runtimeState.emails[0].text.match(/is: (\d{6})/)[1];
    const wrongCode = correctCode === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < wrongAttempts; attempt += 1) {
      const result = parseResult(await updateParticulars.verifyCodeHandler(
        makeEvent({ nric: NRIC, verificationCode: wrongCode })
      ));
      assert.equal(result.status, 401);
    }
    const result = parseResult(await updateParticulars.verifyCodeHandler(
      makeEvent({ nric: NRIC, verificationCode: correctCode })
    ));
    assert.equal(result.status, expectedStatus);
  }
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
  assert.equal(runtimeState.emails.some((email) =>
    /payroll email was changed|particulars updated/i.test(email.subject)
  ), false, 'A failed PUT must not send success notifications');

  const retried = parseResult(await updateParticulars.handler(makeEvent(submission)));
  assert.equal(retried.status, 200);
  assert.equal(parseResult(await updateParticulars.handler(makeEvent(submission))).status, 401);
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

test('verified sessions expire at exactly fifteen minutes, not before or after', async () => {
  let currentTime = Date.parse('2026-07-22T00:00:00Z');
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee);
  updateParticulars._testing.setRuntime({ now: () => currentTime });
  const verified = await requestAndVerify(runtimeState);
  const submission = makeEvent({
    ...verified.particulars,
    accountNumber: '',
    updateToken: verified.updateToken
  });

  currentTime += 15 * 60 * 1000 - 1;
  const stillValid = parseResult(await updateParticulars.handler(submission));
  assert.equal(stillValid.status, 400);
  assert.equal(stillValid.body.error, 'No changes detected');
  const callCountBeforeExpiry = runtimeState.calls.length;

  currentTime += 1;
  const result = parseResult(await updateParticulars.handler(submission));
  assert.equal(result.status, 401);
  assert.equal(runtimeState.calls.length, callCountBeforeExpiry);
});

test('employee lookup times out while reading a stalled response body', async () => {
  let signal;
  let readingBody = false;
  const emails = [];
  updateParticulars._testing.setRuntime({
    fetch: async (url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => {
          readingBody = true;
          return new Promise(() => {});
        }
      };
    },
    sendEmail: async (email) => { emails.push(email); },
    upstreamTimeoutMs: 10
  });

  const startedAt = Date.now();
  const result = parseResult(await updateParticulars.requestCodeHandler(
    makeEvent({ nric: NRIC })
  ));

  assert.equal(result.status, 200);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(readingBody, true);
  assert.equal(signal.aborted, true);
  assert.equal(emails.length, 0);
});

test('the final update rejects a record whose NRIC changed after verification', async () => {
  const employee = makeEmployee();
  const runtimeState = createRuntime(employee);
  const verified = await requestAndVerify(runtimeState);
  employee.ssn = 'T7654321A';

  const submission = makeEvent({
    ...verified.particulars,
    email: 'alex.new@example.com',
    accountNumber: '',
    updateToken: verified.updateToken
  });
  const result = parseResult(await updateParticulars.handler(submission));

  assert.equal(result.status, 409);
  assert.equal(runtimeState.calls.some((call) => call.options.method === 'PUT'), false);
  assert.equal(parseResult(await updateParticulars.handler(submission)).status, 401);
});
