import fs from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import {Pool,escapeIdentifier,escapeLiteral} from 'pg';
import {PostgresAdapter} from '../adapter/PostgresAdapter';
import {POSTGRES_MIGRATION_DIRS} from './migrationDirs';
import {loadMigrations,runMigrations} from './migrationRunner';
import {makeWorkerDatabaseName,workerDatabaseOwnerComment} from './testDatabaseCleanup';

/** Migration regressions need the schema that existed at that boundary. */
export async function historicalTestFixture(through:number){
  const url=new URL(process.env.AGENT_HQ_TEST_PG_URL!);url.pathname='/postgres';
  const admin=new Pool({connectionString:url.toString()});
  const name=makeWorkerDatabaseName(process.env.JEST_WORKER_ID??'1',randomUUID().replaceAll('-','').slice(0,12));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-hq-historical-'));
  for(const migration of loadMigrations(POSTGRES_MIGRATION_DIRS).filter(m=>parseInt(m.id,10)<=through))fs.writeFileSync(path.join(dir,migration.id),migration.sql);
  try{
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    await admin.query(`COMMENT ON DATABASE ${escapeIdentifier(name)} IS ${escapeLiteral(workerDatabaseOwnerComment())}`);
  }finally{await admin.end();}
  url.pathname=`/${name}`;
  const pool=new Pool({connectionString:url.toString()});const db=new PostgresAdapter(pool);
  // DROP DATABASE coordinates with all PostgreSQL backends and can wait beyond
  // a test's deadline under concurrent CI load. Use the same owner-stamped
  // lifecycle as the shared fixtures: close connections here, then let global
  // setup reap this database only after its worker process has exited.
  const close=async()=>{await pool.end();fs.rmSync(dir,{recursive:true,force:true});};
  try{await runMigrations(db,[dir]);return {db,dirs:[dir],close};}catch(error){await close();throw error;}
}
