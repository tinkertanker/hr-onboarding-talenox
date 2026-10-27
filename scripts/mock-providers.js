// Local stand-in for Talenox and Resend, for development and manual checks.
// Holds one synthetic employee (NRIC S0000001I) in memory; nothing leaves the
// machine. Point TALENOX_API_URL at http://127.0.0.1:8790/api/v2 and
// RESEND_BASE_URL at http://127.0.0.1:8790 (see .dev.vars.example).
// GET /__calls lists the requests received, including sent email bodies.

const http = require('http');

const PORT = Number(process.env.MOCK_PROVIDERS_PORT || 8790);
const calls = [];
const employees = [{
  id: 9001,
  employee_id: '301',
  first_name: 'Test Person',
  last_name: '',
  identification_full_name: 'Test Person',
  email: 'test.person@example.test',
  ssn: 'S0000001I',
  citizenship: 'Singapore Citizen',
  nationality: 'Singaporean',
  gender: 'Female',
  birthdate: '1995-05-05',
  bank_account: { id: 1, bank_type: 'DBS', account_name: 'Test Person', number: '000111222' }
}];
let nextId = 9100;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/__calls') return send(res, 200, calls);

    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { return send(res, 400, { error: 'bad json' }); }
    calls.push({ method: req.method, path: pathname, body });
    console.log(req.method, pathname);

    if (pathname === '/emails' && req.method === 'POST') {
      return send(res, 200, { id: `mock_email_${calls.length}` });
    }
    if (pathname === '/api/v2/employees' && req.method === 'GET') return send(res, 200, employees);
    if (pathname === '/api/v2/employees' && req.method === 'POST') {
      const employee = { ...body, id: nextId++ };
      employees.push(employee);
      return send(res, 200, employee);
    }
    if (pathname === '/api/v2/jobs' && req.method === 'POST') return send(res, 200, { id: nextId++ });

    const match = pathname.match(/^\/api\/v2\/employees\/(\d+)$/);
    const employee = match && employees.find((item) => String(item.id) === match[1]);
    if (employee && req.method === 'GET') return send(res, 200, employee);
    if (employee && req.method === 'PUT') {
      Object.assign(employee, body.employee);
      return send(res, 200, employee);
    }
    send(res, 404, { error: 'Not mocked' });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Talenox/Resend on http://127.0.0.1:${PORT}`);
});
