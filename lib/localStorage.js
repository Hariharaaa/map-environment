'use strict';

const fs = require('fs');
const path = require('path');
const { summarize } = require('./pathmapper');

function createLocalStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });

  function fileFor(id) {
    return path.join(dataDir, id + '.json');
  }

  async function readAllEntries() {
    const files = await fs.promises.readdir(dataDir);
    const entries = await Promise.all(files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        try {
          const wrapper = JSON.parse(await fs.promises.readFile(path.join(dataDir, file), 'utf8'));
          if (!wrapper || !wrapper.map) return null;
          return { map_id: file.slice(0, -5), wrapper };
        } catch (e) {
          return null;
        }
      }));
    return entries.filter(Boolean);
  }

  return {
    async listSummaries() {
      const entries = await readAllEntries();
      return entries.map(summarize);
    },

    async getWrapper(id) {
      try {
        return JSON.parse(await fs.promises.readFile(fileFor(id), 'utf8'));
      } catch (e) {
        return null;
      }
    },

    async saveWrapper(id, wrapper) {
      const tmp = path.join(dataDir, id + '.tmp');
      await fs.promises.writeFile(tmp, JSON.stringify(wrapper), 'utf8');
      await fs.promises.rename(tmp, fileFor(id));
    },

    async deleteWrapper(id) {
      try {
        await fs.promises.unlink(fileFor(id));
        return true;
      } catch (e) {
        if (e && e.code === 'ENOENT') return false;
        throw e;
      }
    }
  };
}

module.exports = { createLocalStorage };
