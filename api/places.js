'use strict';

const { handlePlaces } = require('../lib/pathmapper');
const { createBlobStorage } = require('../lib/vercelBlobStorage');

module.exports = function places(req, res) {
  return handlePlaces(req, res, createBlobStorage());
};
