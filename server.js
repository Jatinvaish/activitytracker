const http = require('http');
const services = require('./services');

const PORT = 3056;

function reply(res, status, body) {
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
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function start() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return reply(res, 204, {});

    try {
      if (req.method === 'GET' && req.url === '/status') {
        return reply(res, 200, { status: 'running', port: PORT });
      }

      // POST /log — { activity, username, timestamp?, screenshotBase64? }
      if (req.method === 'POST' && req.url === '/log') {
        const body = await readBody(req);
        if (!body.activity) return reply(res, 400, { error: 'Missing activity' });
        await services.appendToSheet({
          activity:        body.activity,
          username:        body.username || 'User',
          timestamp:       body.timestamp || new Date().toISOString(),
          screenshotBase64: body.screenshotBase64 || null,
        });
        return reply(res, 200, { ok: true });
      }

      // POST /email
      if (req.method === 'POST' && req.url === '/email') {
        const body = await readBody(req);
        if (!body.to || !body.subject) return reply(res, 400, { error: 'Missing to or subject' });
        await services.sendEmail(body);
        return reply(res, 200, { ok: true });
      }

      // POST /crm
      if (req.method === 'POST' && req.url === '/crm') {
        const body = await readBody(req);
        await services.postToCRM(body);
        return reply(res, 200, { ok: true });
      }

      reply(res, 404, { error: 'Not found' });
    } catch (err) {
      reply(res, 500, { error: err.message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Server on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { start };
