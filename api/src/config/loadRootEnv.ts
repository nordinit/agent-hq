import path from 'path';
import dotenv from 'dotenv';

// API commands run with api/ as their working directory, while deployments keep the shared
// environment file at the repository root. Resolve from this module so `db:migrate`, status,
// seed, and the API all load the same file regardless of the caller's current directory.
// Jest supplies isolated database URLs itself and must never discover a developer's real .env.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
}
