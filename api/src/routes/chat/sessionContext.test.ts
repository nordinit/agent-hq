import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Database.Database;

jest.mock('../../db/client', () => ({
  getDb: () => db,
}));

import { resolveSessionContext } from './sessionContext';

function setupDb(): void {
  db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      session_key TEXT,
      openclaw_agent_id TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      session_key TEXT,
      status TEXT,
      run_stage TEXT,
      durable_run_id TEXT
    );
  `);
}

describe('resolveSessionContext', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a direct chat key as instance-less when a chat-stage job_instance already exists', () => {
    const sessionKey = 'agent:atlas:web:direct:8fa72628-c1d7-401c-a106-9190b2b623d6';
    db.prepare(`
      INSERT INTO agents (id, name, session_key, openclaw_agent_id)
      VALUES (1, 'Atlas', 'agent:atlas:main', 'atlas')
    `).run();
    db.prepare(`
      INSERT INTO job_instances (id, agent_id, task_id, session_key, status, run_stage, durable_run_id)
      VALUES (99974585, 1, NULL, ?, 'done', 'chat', 'chat-existing')
    `).run(sessionKey);

    expect(resolveSessionContext(sessionKey)).toMatchObject({
      instanceId: null,
      durableRunId: null,
      agentId: 1,
      sessionKey,
    });
  });

  it('still resolves real run-backed session keys to their job_instance', () => {
    db.prepare(`
      INSERT INTO agents (id, name, session_key, openclaw_agent_id)
      VALUES (2, 'Cinder', 'agent:cinder:main', 'cinder')
    `).run();
    db.prepare(`
      INSERT INTO job_instances (id, agent_id, task_id, session_key, status, run_stage, durable_run_id)
      VALUES (42, 2, 867, 'run:42:durable-run', 'running', 'execute', 'durable-run')
    `).run();

    expect(resolveSessionContext('run:42:durable-run')).toMatchObject({
      instanceId: 42,
      durableRunId: 'durable-run',
      agentId: 2,
      sessionKey: 'run:42:durable-run',
    });
  });
});
