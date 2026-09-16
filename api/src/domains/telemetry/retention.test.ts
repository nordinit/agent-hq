import type {Db} from '../../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../../db/testDb';
import {drainTelemetryOutbox,getTelemetryCoverage} from './capture';
import {enforceTelemetryRetention} from './retention';
let db:Db;
beforeEach(async()=>{
  db=await setupTestDb();
  await db.run(`INSERT INTO tenants(id,name,slug) VALUES(1,'One','one'),(2,'Two','two')`);
  await db.run(`INSERT INTO telemetry_settings(tenant_id,history_retention_days) VALUES(1,1),(2,365)`);
});
afterEach(async()=>teardownTestDb());
async function fact(key:string,days:number,tenant=1){
  await db.run(`INSERT INTO telemetry_outbox(tenant_id,source,source_key,entity_type,entity_id,kind,occurred_at,payload)
    VALUES(?,'tasks',?,'task',1,'task.changed',clock_timestamp()-make_interval(days=>?),'{}')`,tenant,key,days);
}
it('bounds tenant sweeps and preserves newer facts plus independent frozen artifact retention',async()=>{
  await fact('old1',2);await fact('old2',3);await fact('recent',0);await fact('other',3,2);
  await drainTelemetryOutbox(db);
  await db.run(`INSERT INTO telemetry_query_results(id,tenant_id,scope,request,state,actor,expires_at,snapshot)
    VALUES('expired',1,'{}','{}','complete','test',clock_timestamp()-interval '1 second',false),
      ('frozen',1,'{}','{}','complete','test',clock_timestamp()+interval '30 days',true)`);
  expect(await enforceTelemetryRetention(db,{tenantId:1,batchSize:1})).toMatchObject({observations_deleted:1,outbox_deleted:1,results_deleted:1});
  expect(await enforceTelemetryRetention(db,{tenantId:1})).toMatchObject({observations_deleted:1,outbox_deleted:1,results_deleted:0});
  expect((await db.all<any>('SELECT source_key FROM telemetry_observations ORDER BY source_key')).map(x=>x.source_key)).toEqual(['other','recent']);
  expect(await db.value('SELECT id FROM telemetry_query_results')).toBe('frozen');
  expect((await getTelemetryCoverage(db,1)).sources.every(row=>row.retained_from!=null)).toBe(true);
});
it('does not resurrect expired observations through late projection or a longer retention setting',async()=>{
  await enforceTelemetryRetention(db,{tenantId:1});
  const before=await db.value<Date>('SELECT retained_from FROM telemetry_retention_state WHERE tenant_id=1');
  await fact('late-old',10);await drainTelemetryOutbox(db);
  expect(await db.value('SELECT COUNT(*) FROM telemetry_observations')).toBe(0);
  await db.run('UPDATE telemetry_settings SET history_retention_days=365 WHERE tenant_id=1');
  await enforceTelemetryRetention(db,{tenantId:1});
  expect(await db.value<Date>('SELECT retained_from FROM telemetry_retention_state WHERE tenant_id=1')).toEqual(before);
  expect(await db.value('SELECT COUNT(*) FROM telemetry_outbox')).toBe(0);
});
it('rotates tenants fairly and rolls back a failed sweep including its evidence boundary',async()=>{
  expect((await enforceTelemetryRetention(db)).tenant_id).toBe(1);
  expect((await enforceTelemetryRetention(db)).tenant_id).toBe(2);
  expect((await enforceTelemetryRetention(db)).tenant_id).toBe(1);
  await expect(db.withTransaction(async tx=>{await enforceTelemetryRetention(tx,{tenantId:2});throw new Error('abort');})).rejects.toThrow('abort');
  expect((await enforceTelemetryRetention(db)).tenant_id).toBe(2);
});
it.each(['projection','sweep'])('retracts retained ancestors when an expired correction is discarded by %s',async(mode)=>{
  await fact('original',0);await fact('intermediate',0);
  await db.run(`UPDATE telemetry_outbox SET payload='{"supersedes_source_key":"original"}' WHERE source_key='intermediate'`);
  await drainTelemetryOutbox(db);
  if(mode==='projection')await enforceTelemetryRetention(db,{tenantId:1});
  await fact('corrected-before-retention',10);
  await db.run(`UPDATE telemetry_outbox SET payload='{"supersedes_source_key":"intermediate"}' WHERE source_key='corrected-before-retention'`);
  await drainTelemetryOutbox(db);
  if(mode==='sweep')await enforceTelemetryRetention(db,{tenantId:1});
  expect(await db.value('SELECT COUNT(*) FROM telemetry_observations')).toBe(0);
  expect(await db.value('SELECT COUNT(*) FROM telemetry_outbox')).toBe(0);
});
