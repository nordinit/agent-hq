const { ensureStandaloneStatic } = require('./scripts/ensure-standalone-static');

ensureStandaloneStatic();

process.env.PORT = process.env.PORT || '3550';
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
require('./.next/standalone/server.js');
