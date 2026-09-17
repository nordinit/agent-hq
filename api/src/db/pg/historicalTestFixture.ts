import fs from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import {Pool,escapeIdentifier} from 'pg';
import {PostgresAdapter} from '../adapter/PostgresAdapter';
import {POSTGRES_MIGRATION_DIRS} from './migrationDirs';
import {loadMigrations,runMigrations} from './migrationRunner';

/** Migration regressions need the schema that existed at that boundary. */
export async function historicalTestFixture(through:number){
  const url=new URL(process.env.AGENT_HQ_TEST_PG_URL!);url.pathname='/postgres';
  const admin=new Pool({connectionString:url.toString()});
  const name=`agent_hq_migration_${process.pid}_${randomUUID().replaceAll('-','')}`;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-hq-historical-'));
  for(const migration of loadMigrations(POSTGRES_MIGRATION_DIRS).filter(m=>parseInt(m.id,10)<=through))fs.writeFileSync(path.join(dir,migration.id),migration.sql);
  await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
  url.pathname=`/${name}`;
  const pool=new Pool({connectionString:url.toString()});const db=new PostgresAdapter(pool);
  const close=async()=>{await pool.end();await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`);await admin.end();fs.rmSync(dir,{recursive:true,force:true});};
  try{await runMigrations(db,[dir]);return {db,dirs:[dir],close};}catch(error){await close();throw error;}
}
