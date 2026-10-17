// Email-verified updates for existing Talenox employees.
//
// OTP, session, cooldown and rate-limit state lives in Map-like stores. Express
// uses in-memory Maps, so it must stay single-process. The Cloudflare Worker
// routes every request through one Durable Object that swaps in persistent
// stores (see worker/particulars-state.js).
//
// Stored state is minimised because the Durable Object persists it: NRIC/FIN,
// IP and token keys are keyed hashes, OTPs are keyed hashes, and particulars
// snapshots are encrypted (session snapshots with a key that also needs the
// client's update token, which is never stored).

const crypto = require('crypto');
const { Resend } = require('resend');
const dataProtection = require('./data-protection');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_COOLDOWN_MS = 60 * 1000;
const VERIFIED_SESSION_TTL_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_REQUESTS = 10;
const UPSTREAM_TIMEOUT_MS = 15 * 1000;

const ALLOWED_GENDERS = new Set(['male', 'female']);
const ALLOWED_CITIZENSHIP = new Set(['sg_citizen', 'sg_pr', 'other']);
const ALLOWED_BANKS = new Set([
  'DBS',
  'POSB',
  'OCBC - Oversea-Chinese Banking Corporation Ltd',
  'UOB - United Overseas Bank Ltd',
  'Standard Chartered',
  'Citibank N.A Singapore Branch (CNAS)',
  'HSBC BANK (SINGAPORE) LTD',
  'Maybank - Singapore Branch(Malayan Banking Berhad)',
  'Trust Bank Singapore'
]);

const createMemoryStores = () => ({
  otp: new Map(),
  sessions: new Map(),
  cooldowns: new Map(),
  ipRequests: new Map()
});
let stores = createMemoryStores();

const defaultRuntime = {
  fetch: (...args) => globalThis.fetch(...args),
  sendEmail: null,
  now: () => Date.now(),
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  // Persistent stores need a stable key; in-memory stores may use a per-process one.
  requireProtectionKey: false
};
const runtime = { ...defaultRuntime };

const GENERIC_CODE_MESSAGE =
  'If this NRIC/FIN is on our records, a verification code has been sent to the email address we have on file. Check your inbox (and spam folder).';
const GENERIC_VERIFY_FAILURE =
  'Verification failed. Please check the code and try again, or request a new code.';

const now = () => runtime.now();
const normaliseNric = (nric) => String(nric || '').trim().toUpperCase();
const normaliseText = (value) => String(value || '').trim();
const normaliseEmail = (value) => normaliseText(value).toLowerCase();
const validateNRIC = (nric) => /^[STFGM]\d{7}[A-Z]$/i.test(nric);

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const optionsResponse = () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  },
  body: ''
});

const parseBody = (event) => {
  try {
    const value = JSON.parse(event.body || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

const createError = (message, statusCode = 502, publicMessage = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
};

const redactSensitiveData = (data) => {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(redactSensitiveData);
  if (typeof data !== 'object') return data;

  const redacted = {};
  for (const [key, value] of Object.entries(data)) {
    const lower = key.toLowerCase();
    if (lower === 'nric' || lower === 'ssn') {
      const str = String(value || '');
      redacted[key] = str ? `${str.slice(0, 1)}****${str.slice(-1)}` : value;
    } else if (['accountnumber', 'number', 'account_number'].includes(lower)) {
      const str = String(value || '');
      redacted[key] = str ? `****${str.slice(-4)}` : value;
    } else if (
      ['verificationcode', 'code', 'codehash', 'updatetoken'].includes(lower)
    ) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
};

let processProtectionKey = null;
const getProtectionKey = () => {
  const configured = process.env.DATA_PROTECTION_KEY;
  if (configured && configured.length >= 32) return configured;
  if (configured || runtime.requireProtectionKey) return null;
  if (!processProtectionKey) processProtectionKey = crypto.randomBytes(32);
  return processProtectionKey;
};

const keyedHash = (purpose, value) => crypto
  .createHmac('sha256', getProtectionKey())
  .update(`${purpose}:${value}`)
  .digest('hex');
const nricKey = (nric) => keyedHash('nric', nric);
const ipKey = (ip) => keyedHash('ip', ip);
const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const hashOtp = (subjectKey, code) => keyedHash('otp', `${subjectKey}:${code}`);

const sealJson = (value, context) =>
  dataProtection.sealJson(value, getProtectionKey(), context);
const openJson = (sealed, context) =>
  dataProtection.openJson(sealed, getProtectionKey(), context);

const otpHashesEqual = (a, b) => {
  try {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
};

const generateOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const generateUpdateToken = () => crypto.randomBytes(32).toString('hex');

const maskEmail = (email) => {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
};

const cleanupExpiredState = () => {
  const currentTime = now();

  for (const [key, session] of stores.otp.entries()) {
    if (session.expiresAt <= currentTime) stores.otp.delete(key);
  }
  for (const [key, session] of stores.sessions.entries()) {
    if (session.expiresAt <= currentTime) stores.sessions.delete(key);
  }
  for (const [key, lastSentAt] of stores.cooldowns.entries()) {
    if (currentTime - lastSentAt > OTP_REQUEST_COOLDOWN_MS * 60) {
      stores.cooldowns.delete(key);
    }
  }
  for (const [key, timestamps] of stores.ipRequests.entries()) {
    const fresh = timestamps.filter((timestamp) => currentTime - timestamp < IP_WINDOW_MS);
    if (fresh.length) stores.ipRequests.set(key, fresh);
    else stores.ipRequests.delete(key);
  }
};

const getClientIp = (event) => {
  if (event.clientIp) return String(event.clientIp);
  const headers = event.headers || {};
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  return forwarded ? String(forwarded).split(',')[0].trim() : 'unknown';
};

const checkIpRateLimit = (ip) => {
  const currentTime = now();
  const key = ipKey(ip);
  const timestamps = (stores.ipRequests.get(key) || [])
    .filter((timestamp) => currentTime - timestamp < IP_WINDOW_MS);
  if (timestamps.length >= IP_MAX_REQUESTS) {
    stores.ipRequests.set(key, timestamps);
    return false;
  }
  timestamps.push(currentTime);
  stores.ipRequests.set(key, timestamps);
  return true;
};

const isInCooldown = (subjectKey) => {
  const lastSentAt = stores.cooldowns.get(subjectKey);
  return Boolean(lastSentAt && now() - lastSentAt < OTP_REQUEST_COOLDOWN_MS);
};

const fetchWithTimeout = async (url, options = {}, readJson = false) => {
  const controller = new AbortController();
  let timeout;
  const operation = (async () => {
    const response = await runtime.fetch(url, { ...options, signal: controller.signal });
    if (!readJson) return response;
    return { response, body: await response.json() };
  })();

  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(createError('Upstream request timed out'));
        }, runtime.upstreamTimeoutMs);
      })
    ]);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw createError('Upstream request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const withTimeout = async (promise, message) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(createError(message)),
          runtime.upstreamTimeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const talenoxHeaders = () => ({
  Authorization: `Bearer ${process.env.TALENOX_API_KEY}`,
  Accept: 'application/json'
});

const getEmployeeById = async (employeeId, requestId) => {
  const { response, body } = await fetchWithTimeout(
    `${process.env.TALENOX_API_URL}/employees/${employeeId}`,
    { method: 'GET', headers: talenoxHeaders() },
    true
  );
  if (!response.ok) {
    console.error(`[${requestId}] Talenox employee fetch failed with status ${response.status}`);
    throw createError(`Failed to fetch employee (${response.status})`);
  }
  return body;
};

// The documented endpoint returns all employees and includes ssn in each row.
// Use one bounded request rather than relying on undocumented pagination.
const findEmployeeByNric = async (nric, requestId) => {
  const { response, body } = await fetchWithTimeout(
    `${process.env.TALENOX_API_URL}/employees`,
    { method: 'GET', headers: talenoxHeaders() },
    true
  );
  if (!response.ok) {
    console.error(`[${requestId}] Talenox employee lookup failed with status ${response.status}`);
    throw createError(`Failed to list employees (${response.status})`);
  }

  const employees = Array.isArray(body) ? body : (body.data || body.employees || []);
  const matches = employees.filter((employee) =>
    normaliseNric(employee.ssn || employee.identification_number) === nric
  );

  if (matches.length > 1) {
    const error = createError('Multiple employees share this NRIC');
    error.code = 'DUPLICATE_NRIC';
    throw error;
  }
  if (!matches.length) return null;

  const employee = await getEmployeeById(matches[0].id, requestId);
  if (normaliseNric(employee.ssn || employee.identification_number) !== nric) {
    throw createError('Employee identity changed during lookup');
  }
  return employee;
};

const getBankAccount = (employee) =>
  employee.bank_account || employee.bank_account_attributes || {};

const mapCitizenshipForForm = (citizenship) => {
  if (citizenship === 'Singapore Citizen') return 'sg_citizen';
  if (citizenship === 'Singapore PR') return 'sg_pr';
  return 'other';
};

const mapCitizenshipForTalenox = (citizenshipStatus) => {
  if (citizenshipStatus === 'sg_citizen') return 'Singapore Citizen';
  if (citizenshipStatus === 'sg_pr') return 'Singapore PR';
  return null;
};

const toEditableSnapshot = (employee) => {
  const bankAccount = getBankAccount(employee);
  const accountNumber = String(bankAccount.number || '');
  const fullName = normaliseText(employee.identification_full_name) ||
    [employee.first_name, employee.middle_name, employee.last_name]
      .map(normaliseText)
      .filter(Boolean)
      .join(' ');

  return {
    fullName,
    email: normaliseText(employee.email),
    nationality: normaliseText(employee.nationality),
    citizenshipStatus: mapCitizenshipForForm(employee.citizenship),
    dob: normaliseText(employee.birthdate),
    gender: normaliseText(employee.gender).toLowerCase(),
    bank: normaliseText(bankAccount.bank_type),
    accountName: normaliseText(bankAccount.account_name),
    accountNumberLast4: accountNumber ? accountNumber.slice(-4) : ''
  };
};

const isLikelyCardNumber = (number) => {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 15 || digits.length > 16) return false;
  if (![/^4/, /^5[1-5]/, /^3[47]/, /^6(?:011|5)/, /^36/, /^2[2-7]/]
    .some((prefix) => prefix.test(digits))) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
};

const validateUpdateFormData = (data, originalSnapshot) => {
  const errors = [];
  const requiredFields = [
    ['fullName', 'Full name'],
    ['email', 'Email'],
    ['nationality', 'Nationality'],
    ['citizenshipStatus', 'Citizenship status'],
    ['dob', 'Date of birth'],
    ['gender', 'Gender'],
    ['bank', 'Bank'],
    ['accountName', 'Account name']
  ];

  for (const [field, label] of requiredFields) {
    if (!normaliseText(data[field])) errors.push(`${label} is required`);
  }

  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push('Invalid email format');
  }
  if (data.accountNumber && !/^\d+$/.test(data.accountNumber)) {
    errors.push('Account number must contain only digits');
  } else if (data.accountNumber && isLikelyCardNumber(data.accountNumber)) {
    errors.push('This looks like a card number. Please enter your bank account number.');
  }
  if (data.gender && !ALLOWED_GENDERS.has(String(data.gender).toLowerCase())) {
    errors.push('Invalid gender');
  }
  if (data.citizenshipStatus && !ALLOWED_CITIZENSHIP.has(data.citizenshipStatus)) {
    errors.push('Invalid citizenship status');
  }
  // Existing Talenox records contain legacy bank labels that are no longer in
  // the form's canonical list. Preserve an unchanged server-sourced value,
  // while still rejecting arbitrary new values supplied by the client.
  if (
    data.bank &&
    data.bank !== originalSnapshot.bank &&
    !ALLOWED_BANKS.has(data.bank)
  ) {
    errors.push('Invalid bank selection');
  }
  if (data.dob) {
    const dob = new Date(data.dob);
    if (Number.isNaN(dob.getTime()) || dob > new Date(now())) {
      errors.push('Invalid date of birth');
    }
  }
  if (
    data.citizenshipStatus === 'other' &&
    originalSnapshot.citizenshipStatus !== 'other'
  ) {
    errors.push('Please contact HR to change citizenship to Others so your payroll classification can be reviewed.');
  }

  return errors;
};

const buildUpdatePayload = (formData, originalSnapshot, freshEmployee) => {
  const payload = {};
  const changedFields = [];
  const addChange = (field) => changedFields.push(field);

  const fullName = normaliseText(formData.fullName);
  if (fullName !== originalSnapshot.fullName) {
    payload.first_name = fullName;
    payload.last_name = '';
    payload.identification_full_name = fullName;
    addChange('name');
  }

  const email = normaliseText(formData.email);
  if (normaliseEmail(email) !== normaliseEmail(originalSnapshot.email)) {
    payload.email = email;
    addChange('email');
  }

  const nationality = normaliseText(formData.nationality);
  if (nationality !== originalSnapshot.nationality) {
    payload.nationality = nationality;
    addChange('nationality');
  }

  if (formData.citizenshipStatus !== originalSnapshot.citizenshipStatus) {
    const citizenship = mapCitizenshipForTalenox(formData.citizenshipStatus);
    if (citizenship) {
      payload.citizenship = citizenship;
      addChange('citizenship');
    }
  }

  if (formData.dob !== originalSnapshot.dob) {
    payload.birthdate = formData.dob;
    addChange('date of birth');
  }

  const gender = String(formData.gender).toLowerCase();
  if (gender !== originalSnapshot.gender) {
    payload.gender = gender.charAt(0).toUpperCase() + gender.slice(1);
    addChange('gender');
  }

  const bankChanges = {};
  if (formData.bank !== originalSnapshot.bank) {
    bankChanges.bank_type = formData.bank;
    addChange('bank');
  }
  if (normaliseText(formData.accountName) !== originalSnapshot.accountName) {
    bankChanges.account_name = normaliseText(formData.accountName);
    addChange('bank account name');
  }
  if (normaliseText(formData.accountNumber)) {
    bankChanges.number = normaliseText(formData.accountNumber);
    addChange('bank account number');
  }

  if (Object.keys(bankChanges).length) {
    const existingBank = getBankAccount(freshEmployee);
    if (existingBank.id) bankChanges.id = existingBank.id;
    payload.bank_account_attributes = bankChanges;
  }

  return { payload, changedFields };
};

const sendResendEmail = async ({ to, subject, text }) => {
  if (runtime.sendEmail) {
    return withTimeout(runtime.sendEmail({ to, subject, text }), 'Email request timed out');
  }
  if (!process.env.RESEND_API_KEY) throw createError('Email service is not configured', 500);

  const resend = new Resend(process.env.RESEND_API_KEY);
  const result = await withTimeout(
    resend.emails.send({
      from: process.env.FROM_EMAIL || 'Tinkercademy Onboarding <hr.onboarding@tinkertanker.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      text
    }),
    'Email request timed out'
  );
  if (result && result.error) {
    throw createError(`Resend error: ${result.error.message || 'unknown error'}`);
  }
  return result;
};

const sendVerificationEmail = (to, code, employeeName) => sendResendEmail({
  to,
  subject: 'Your Tinkercademy particulars verification code',
  text: `${employeeName ? `Hi ${employeeName},` : 'Hi,'}

Your verification code for updating personal particulars is: ${code}

This code expires in 10 minutes. If you did not request this, you can ignore this email and contact HR at hr.onboarding@tk.sg.

— Tinkercademy Onboarding`
});

const sendEmailChangeNotice = (oldEmail, newEmail, employeeName) => sendResendEmail({
  to: oldEmail,
  subject: 'Your Tinkercademy payroll email was changed',
  text: `${employeeName ? `Hi ${employeeName},` : 'Hi,'}

Your payroll email on file was changed from ${oldEmail} to ${newEmail}.

If you did not request this change, contact HR immediately at hr.onboarding@tk.sg.

— Tinkercademy Onboarding`
});

const sendUpdateHRNotification = (formData, employee, changedFields) => {
  if (!process.env.NOTIFY_EMAIL) return Promise.resolve(false);
  return sendResendEmail({
    to: process.env.NOTIFY_EMAIL,
    subject: `Particulars Updated: ${formData.fullName}`,
    text: `Employee Particulars Update

Employee Details:
- Name: ${formData.fullName}
- Email: ${formData.email}
- Changed fields: ${changedFields.join(', ')}

Talenox Record:
- Internal Employee ID: ${employee.employee_id || 'Unknown'}
- Talenox Database ID: ${employee.id}
- Status: Updated successfully after email verification

Please review the updated details in Talenox.

This is an automated notification from the Tinkercademy onboarding system.`
  }).then(() => true);
};

const sendUpdateFailureNotification = (formData, errorType, errorDetails) => {
  if (!process.env.NOTIFY_EMAIL) return Promise.resolve(false);
  return sendResendEmail({
    to: process.env.NOTIFY_EMAIL,
    subject: `FAILED Particulars Update: ${formData.fullName || 'Unknown'}`,
    text: `FAILED Employee Particulars Update

Employee Details:
- Name: ${formData.fullName || 'Not provided'}
- Email: ${formData.email || 'Not provided'}

Failure Details:
- Error Type: ${errorType}
- Error Message: ${errorDetails}
- Timestamp: ${new Date(now()).toISOString()}

Please review the employee record and contact the employee if needed.`
  }).then(() => true);
};

const consumeOtp = (subjectKey, verificationCode) => {
  cleanupExpiredState();
  const session = stores.otp.get(subjectKey);
  if (!session) return null;

  const codeMatches = otpHashesEqual(hashOtp(subjectKey, verificationCode), session.codeHash);
  if (!codeMatches) {
    session.attempts += 1;
    if (session.attempts >= OTP_MAX_ATTEMPTS) stores.otp.delete(subjectKey);
    else stores.otp.set(subjectKey, session);
    return null;
  }

  // This synchronous check-and-delete makes a correct code single-use.
  stores.otp.delete(subjectKey);
  return session;
};

exports.requestCodeHandler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return optionsResponse();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const requestId = `otp_${now()}_${Math.random().toString(36).slice(2, 9)}`;
  const genericSuccess = { success: true, message: GENERIC_CODE_MESSAGE };
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Invalid request' });

  const nric = normaliseNric(body.nric);
  if (!validateNRIC(nric)) {
    return jsonResponse(400, {
      error: 'Invalid NRIC/FIN',
      details: 'Please enter a valid 9-character NRIC/FIN (e.g., S1234567A).'
    });
  }
  if (!process.env.TALENOX_API_KEY || !process.env.TALENOX_API_URL) {
    console.error(`[${requestId}] Talenox API credentials not configured`);
    return jsonResponse(500, { error: 'Configuration error' });
  }
  if (!process.env.RESEND_API_KEY && !runtime.sendEmail) {
    console.error(`[${requestId}] Email service not configured`);
    return jsonResponse(500, { error: 'Configuration error' });
  }
  if (!getProtectionKey()) {
    console.error(`[${requestId}] DATA_PROTECTION_KEY missing or shorter than 32 characters`);
    return jsonResponse(500, { error: 'Configuration error' });
  }

  cleanupExpiredState();
  const subjectKey = nricKey(nric);
  const clientIp = getClientIp(event);
  if (!checkIpRateLimit(clientIp) || isInCooldown(subjectKey)) {
    return jsonResponse(200, genericSuccess);
  }
  stores.cooldowns.set(subjectKey, now());

  let employee;
  try {
    employee = await findEmployeeByNric(nric, requestId);
  } catch (error) {
    console.error(`[${requestId}] Employee lookup failed: ${error.message}`);
    if (error.code === 'DUPLICATE_NRIC') {
      sendUpdateFailureNotification(
        {},
        'Duplicate NRIC',
        'Multiple Talenox employees share the same NRIC/FIN; verification was refused.'
      ).catch(() => {});
    }
    return jsonResponse(200, genericSuccess);
  }

  if (!employee || !employee.email) return jsonResponse(200, genericSuccess);

  const code = generateOtp();
  const employeeName = normaliseText(employee.identification_full_name) ||
    [employee.first_name, employee.last_name].map(normaliseText).filter(Boolean).join(' ');
  try {
    await sendVerificationEmail(employee.email, code, employeeName);
  } catch (error) {
    console.error(`[${requestId}] Verification email failed: ${error.message}`);
    return jsonResponse(200, genericSuccess);
  }

  stores.otp.set(subjectKey, {
    codeHash: hashOtp(subjectKey, code),
    expiresAt: now() + OTP_TTL_MS,
    attempts: 0,
    employeeId: employee.id,
    sealedSnapshot: await sealJson(toEditableSnapshot(employee), `otp:${subjectKey}`)
  });
  console.log(`[${requestId}] Verification code sent to ${maskEmail(employee.email)}`);
  return jsonResponse(200, genericSuccess);
};

exports.verifyCodeHandler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return optionsResponse();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Invalid request' });

  const nric = normaliseNric(body.nric);
  const verificationCode = normaliseText(body.verificationCode);
  if (!validateNRIC(nric) || !/^\d{6}$/.test(verificationCode)) {
    return jsonResponse(400, {
      error: 'Invalid verification details',
      details: GENERIC_VERIFY_FAILURE
    });
  }

  if (!getProtectionKey()) return jsonResponse(500, { error: 'Configuration error' });

  const subjectKey = nricKey(nric);
  const otpSession = consumeOtp(subjectKey, verificationCode);
  if (!otpSession) {
    return jsonResponse(401, {
      error: 'Verification failed',
      details: GENERIC_VERIFY_FAILURE
    });
  }

  let particulars;
  try {
    particulars = await openJson(otpSession.sealedSnapshot, `otp:${subjectKey}`);
  } catch {
    return jsonResponse(401, {
      error: 'Verification failed',
      details: GENERIC_VERIFY_FAILURE
    });
  }
  const updateToken = generateUpdateToken();
  stores.sessions.set(tokenKey(updateToken), {
    employeeId: otpSession.employeeId,
    nricKey: subjectKey,
    sealedSnapshot: await sealJson(particulars, `session:${updateToken}`),
    expiresAt: now() + VERIFIED_SESSION_TTL_MS
  });

  return jsonResponse(200, {
    success: true,
    updateToken,
    particulars,
    message: 'Identity verified. Review your current particulars below.'
  });
};

const processParticularsUpdate = async (formData, session, originalSnapshot, requestId) => {
  const freshEmployee = await getEmployeeById(session.employeeId, requestId);
  const freshNric = normaliseNric(freshEmployee.ssn || freshEmployee.identification_number);
  if (nricKey(freshNric) !== session.nricKey) {
    const error = createError(
      'Employee identity changed before update',
      409,
      'Your employee record changed during verification. Please request a new code.'
    );
    error.invalidateSession = true;
    throw error;
  }

  const { payload, changedFields } = buildUpdatePayload(
    formData,
    originalSnapshot,
    freshEmployee
  );
  if (!changedFields.length) {
    throw createError(
      'No particulars changed',
      400,
      'No changes were detected. Update at least one field before submitting.'
    );
  }

  console.log(`[${requestId}] Updating fields: ${changedFields.join(', ')}`);
  const response = await fetchWithTimeout(
    `${process.env.TALENOX_API_URL}/employees/${freshEmployee.id}`,
    {
      method: 'PUT',
      headers: { ...talenoxHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee: payload })
    }
  );
  if (!response.ok) {
    console.error(`[${requestId}] Talenox update failed with status ${response.status}`);
    throw createError(`Failed to update employee (${response.status})`);
  }

  const emailChanged = changedFields.includes('email');
  let previousEmailNotified = false;
  let hrNotified = false;

  if (emailChanged && freshEmployee.email) {
    try {
      await sendEmailChangeNotice(freshEmployee.email, formData.email, formData.fullName);
      previousEmailNotified = true;
    } catch (error) {
      console.error(`[${requestId}] Previous-email notification failed: ${error.message}`);
    }
  }
  try {
    hrNotified = await sendUpdateHRNotification(formData, freshEmployee, changedFields);
  } catch (error) {
    console.error(`[${requestId}] HR notification failed: ${error.message}`);
  }

  return { changedFields, previousEmailNotified, hrNotified };
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return optionsResponse();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const requestId = `upd_${now()}_${Math.random().toString(36).slice(2, 9)}`;
  const formData = parseBody(event);
  if (!formData) return jsonResponse(400, { error: 'Invalid request' });
  if (!process.env.TALENOX_API_KEY || !process.env.TALENOX_API_URL || !getProtectionKey()) {
    return jsonResponse(500, { error: 'Configuration error' });
  }

  cleanupExpiredState();
  const updateToken = normaliseText(formData.updateToken);
  const sessionKey = tokenKey(updateToken);
  const session = updateToken ? stores.sessions.get(sessionKey) : null;
  if (!session) {
    return jsonResponse(401, {
      error: 'Verification expired',
      details: 'Please request and verify a new code.'
    });
  }
  if (session.inFlight) {
    return jsonResponse(409, {
      error: 'Update already in progress',
      details: 'This update is already being processed. Please wait for it to finish.'
    });
  }

  // Claim the token synchronously before any await. Validation failures and
  // failed upstream requests unlock it for retry; a successful request consumes it.
  session.inFlight = true;
  stores.sessions.set(sessionKey, session);
  const unlockSession = () => {
    if (session.expiresAt <= now()) {
      stores.sessions.delete(sessionKey);
    } else {
      session.inFlight = false;
      stores.sessions.set(sessionKey, session);
    }
  };

  let originalSnapshot;
  try {
    originalSnapshot = await openJson(session.sealedSnapshot, `session:${updateToken}`);
  } catch {
    stores.sessions.delete(sessionKey);
    return jsonResponse(401, {
      error: 'Verification expired',
      details: 'Please request and verify a new code.'
    });
  }

  const validationErrors = validateUpdateFormData(formData, originalSnapshot);
  if (validationErrors.length) {
    unlockSession();
    return jsonResponse(400, {
      error: 'Validation failed',
      details: validationErrors,
      requestId
    });
  }

  try {
    const result = await processParticularsUpdate(formData, session, originalSnapshot, requestId);
    stores.sessions.delete(sessionKey);
    return jsonResponse(200, {
      success: true,
      message: 'Your particulars have been updated successfully.',
      requestId,
      notifications: {
        hr: result.hrNotified,
        previousEmail: result.previousEmailNotified
      }
    });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    console.error(`[${requestId}] Update failed: ${error.message}`);
    if (error.invalidateSession) stores.sessions.delete(sessionKey);
    else unlockSession();
    if (statusCode >= 500) {
      await sendUpdateFailureNotification(
        formData,
        'Update Error',
        'The Talenox update could not be completed.'
      ).catch((notificationError) =>
        console.error(`[${requestId}] Failure notification failed: ${notificationError.message}`)
      );
    }
    return jsonResponse(statusCode, {
      error: statusCode === 400 ? 'No changes detected' : 'Update failed',
      details: error.publicMessage ||
        'We could not update your particulars. Please try again or contact HR at hr.onboarding@tk.sg.',
      requestId
    });
  }
};

// Used by the Durable Object to swap in persistent stores and run cleanup.
exports.configureState = ({ stores: nextStores, requireProtectionKey = false } = {}) => {
  if (nextStores) stores = nextStores;
  runtime.requireProtectionKey = requireProtectionKey;
};
exports.cleanupExpiredState = cleanupExpiredState;

exports._testing = {
  reset() {
    stores = createMemoryStores();
    Object.assign(runtime, defaultRuntime);
  },
  setRuntime(overrides) {
    Object.assign(runtime, overrides);
  },
  state() {
    return {
      otpCount: stores.otp.size,
      verifiedSessionCount: stores.sessions.size,
      stores
    };
  },
  buildUpdatePayload,
  toEditableSnapshot,
  redactSensitiveData
};
