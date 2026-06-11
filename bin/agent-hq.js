#!/usr/bin/env node

import('../cli/lib/index.mjs')
  .then(({ run }) => run(process.argv.slice(2)))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
