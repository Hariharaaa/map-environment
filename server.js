// Local development server. Vercel production uses /api serverless functions.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { handleMapItem, handleMapsCollection, handlePlaces } = require('./lib/pathmapper');
const { createLocalStorage } = require('./lib/localStorage');

const PORT = process.env.PORT || 3210;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const storage = createLocalStorage(DATA_DIR);

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('app file missing');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/places') {
    await handlePlaces(req, res, storage);
    return;
  }

  if (p === '/api/maps') {
    await handleMapsCollection(req, res, storage);
    return;
  }

  const single = p.match(/^\/api\/maps\/([^/]+)$/);
  if (single) {
    await handleMapItem(req, res, storage, decodeURIComponent(single[1]));
    return;
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    serveIndex(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log('PathMapper local server running on http://localhost:' + PORT);
  console.log('Storing maps in ' + DATA_DIR);
});
