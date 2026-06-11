import type Database from 'better-sqlite3';
import { getDb } from './client';
import { ensureRoutingMetadata } from '../domains/routing/policy/metadata';
import { seedDefaultWorkflowEventMappings } from '../domains/routing/externalEventMappings';

export function bootstrapRoutingAndWorkflowDefaults(db: Database.Database = getDb()): void {
  ensureRoutingMetadata(db);
  seedDefaultWorkflowEventMappings(db);
}
