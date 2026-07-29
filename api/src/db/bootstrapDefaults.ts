import { getDb } from './client';
import { ensureRoutingMetadata } from '../domains/routing/policy/metadata';
import { seedDefaultWorkflowEventMappings } from '../domains/routing/externalEventMappings';
import { type Db } from "./adapter/types";

export async function bootstrapRoutingAndWorkflowDefaults(db: Db = getDb()): Promise<void> {
  await ensureRoutingMetadata(db);
  seedDefaultWorkflowEventMappings(db);
}
