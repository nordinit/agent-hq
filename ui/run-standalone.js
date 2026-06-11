const path = require('path');
const { ensureStandaloneStatic } = require('./scripts/ensure-standalone-static');

const uiRoot = __dirname;
const standaloneRoot = path.join(uiRoot, '.next', 'standalone');

ensureStandaloneStatic();

process.chdir(standaloneRoot);
process.env.PORT = process.env.PORT || '3550';
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
require(process.cwd() + '/server.js');
