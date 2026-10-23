const http = require('http');
const services = require('./services');

const PORT = 3056;

function route(req, res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function start() {
  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') return route(req, res, 204, {});

    try {
      // GET /status
      if (req.method === 'GET' && req.url === '/status') {
        return route(req, res, 200, { status: 'running', port: PORT });
      }

      // POST /log  — log activity to Google Sheets
      if (req.method === 'POST' && req.url === '/log') {
        const body = await readBody(req);
        if (!body.activity) return route(req, res, 400, { error: 'Missing activity field' });
        await services.appendToSheet({ activity: body.activity, timestamp: new Date().toISOString() });
        return route(req, res, 200, { ok: true });
      }

      // POST /email — send an email
      if (req.method === 'POST' && req.url === '/email') {
        const body = await readBody(req);
        if (!body.to || !body.subject) return route(req, res, 400, { error: 'Missing to or subject' });
        await services.sendEmail(body);
        return route(req, res, 200, { ok: true });
      }

      // POST /crm — push to CRM
      if (req.method === 'POST' && req.url === '/crm') {
        const body = await readBody(req);
        await services.postToCRM(body);
        return route(req, res, 200, { ok: true });
      }

      route(req, res, 404, { error: 'Not found' });
    } catch (err) {
      route(req, res, 500, { error: err.message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Local server running on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { start };
