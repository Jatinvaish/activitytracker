const http = require('http');

const PORT = 3056;

// Local lightweight server — just health check
// All real logic lives on the hosted backend (render.yaml)
function start() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'running' }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(PORT, '127.0.0.1', () =>
    console.log(`Local health server on http://127.0.0.1:${PORT}`)
  );
}

module.exports = { start };
