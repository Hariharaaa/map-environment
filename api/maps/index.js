'use strict';

const { handleMapsCollection } = require('../../lib/pathmapper');
const { createBlobStorage } = require('../../lib/vercelBlobStorage');

function maps(req, res) {
  return handleMapsCollection(req, res, createBlobStorage());
}

module.exports = maps;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
