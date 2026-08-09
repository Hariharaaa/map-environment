'use strict';

const { handleMapItem } = require('../../lib/pathmapper');
const { createBlobStorage } = require('../../lib/vercelBlobStorage');

module.exports = function mapById(req, res) {
  return handleMapItem(req, res, createBlobStorage());
};
