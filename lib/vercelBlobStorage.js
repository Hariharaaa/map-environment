'use strict';

const { summarize } = require('./pathmapper');

const MAP_PREFIX = 'pathmapper/maps/';
const INDEX_PATH = 'pathmapper/index.json';

function blobAccess() {
  const access = process.env.BLOB_ACCESS || 'private';
  return access === 'public' ? 'public' : 'private';
}

function mapPath(id) {
  return MAP_PREFIX + id + '.json';
}

async function blobSdk() {
  return import('@vercel/blob');
}

async function streamToText(stream) {
  if (!stream) return '';
  if (typeof Response !== 'undefined') {
    return new Response(stream).text();
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBlob(pathname) {
  const { get } = await blobSdk();
  const result = await get(pathname, { access: blobAccess() });
  if (!result || result.statusCode === 404) return null;
  if (result.statusCode !== 200) throw new Error('could not read blob ' + pathname);
  const text = await streamToText(result.stream);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('corrupt JSON blob ' + pathname);
  }
}

async function writeJsonBlob(pathname, value) {
  const { put } = await blobSdk();
  await put(pathname, JSON.stringify(value), {
    access: blobAccess(),
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: 'application/json; charset=utf-8'
  });
}

function validIndex(index) {
  return index && index.version === 1 && index.maps && typeof index.maps === 'object' && !Array.isArray(index.maps);
}

async function rebuildIndex() {
  const maps = {};
  let cursor;
  let hasMore = true;
  while (hasMore) {
    const { list } = await blobSdk();
    const page = await list({ prefix: MAP_PREFIX, cursor, limit: 1000 });
    for (const blob of page.blobs || []) {
      const match = blob.pathname.match(/^pathmapper\/maps\/(.+)\.json$/);
      if (!match) continue;
      const wrapper = await readJsonBlob(blob.pathname);
      if (!wrapper || !wrapper.map) continue;
      maps[match[1]] = summarize({ map_id: match[1], wrapper });
    }
    hasMore = Boolean(page.hasMore);
    cursor = page.cursor;
  }
  const index = { version: 1, maps };
  await writeJsonBlob(INDEX_PATH, index);
  return index;
}

async function readIndex() {
  const index = await readJsonBlob(INDEX_PATH);
  return validIndex(index) ? index : rebuildIndex();
}

function createBlobStorage() {
  return {
    async listSummaries() {
      const index = await readIndex();
      return Object.values(index.maps);
    },

    async getWrapper(id) {
      return readJsonBlob(mapPath(id));
    },

    async saveWrapper(id, wrapper) {
      await writeJsonBlob(mapPath(id), wrapper);
      const index = await readIndex();
      index.maps[id] = summarize({ map_id: id, wrapper });
      await writeJsonBlob(INDEX_PATH, index);
    },

    async deleteWrapper(id) {
      const existing = await readJsonBlob(mapPath(id));
      if (!existing) return false;
      const { del } = await blobSdk();
      await del(mapPath(id));
      const index = await readIndex();
      delete index.maps[id];
      await writeJsonBlob(INDEX_PATH, index);
      return true;
    }
  };
}

module.exports = { createBlobStorage };
