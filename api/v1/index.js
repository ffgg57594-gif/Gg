'use strict';

const { handleRequest } = require('../../lib/proxy');

module.exports = handleRequest;

module.exports.config = {
  maxDuration: 60,
};
