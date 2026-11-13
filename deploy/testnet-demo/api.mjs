// Demo API for the `report` resource, reached at http://api:3001 on the Compose
// network; docker-compose.yml leaves its port unpublished
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/report') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        title: 'Agent Commerce demo report',
        generatedAt: new Date().toISOString(),
        items: [
          { name: 'requests', value: 1280 },
          { name: 'paid_calls', value: 342 },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

server.listen(3001);
