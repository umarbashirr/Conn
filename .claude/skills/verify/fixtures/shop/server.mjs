import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./index.html', import.meta.url));

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
  console.log(`Local: http://localhost:${server.address().port}/`);
});
