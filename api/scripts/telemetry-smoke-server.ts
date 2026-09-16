/** Disposable UI target. Never connects to a saved Agent HQ database. */
import express from 'express';
import cors from 'cors';
import {setupTestDb,teardownTestDb} from '../src/db/testDb';
import {dropWorkerDatabase} from '../src/db/pg/testFixture';
import {getDb} from '../src/db/client';
import {seedTelemetryScenario} from '../src/domains/telemetry/testScenario';
import telemetryRouter from '../src/routes/telemetry-v2';
import {startTelemetryCaptureWorker} from '../src/domains/telemetry/capture';
import {startTelemetryQueryWorker} from '../src/domains/telemetry/queries';
import type {AddressInfo} from 'net';

async function main(){
  await setupTestDb();const db=getDb();await seedTelemetryScenario(db);
  const app=express();app.use(cors());app.use(express.json({limit:'10mb'}));app.use('/api/v1/telemetry/v2',telemetryRouter);
  app.get('/api/v1/projects',async(_req,res)=>res.json(await db.all('SELECT id,name,tenant_id FROM projects WHERE tenant_id=1')));
  app.get('/api/v1/tenants',async(_req,res)=>res.json(await db.all('SELECT * FROM tenants WHERE id=1')));
  app.get('/api/v1/setup/status',(_req,res)=>res.json({onboarding_completed:true,hasProjects:true,onboarding_provider_gate_passed:true}));
  const stopCapture=startTelemetryCaptureWorker(db),stopQueries=startTelemetryQueryWorker(db);
  const server=app.listen(56183,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  console.log(JSON.stringify({api_url:`http://127.0.0.1:${(server.address()as AddressInfo).port}`,database:'disposable synthetic fixture'}));
  let closing=false;const close=async()=>{if(closing)return;closing=true;stopCapture();stopQueries();await new Promise<void>(resolve=>server.close(()=>resolve()));await teardownTestDb();await dropWorkerDatabase();process.exit(0);};
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
