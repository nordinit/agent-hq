import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelemetryRecoveryGate, isTelemetryResultUnavailable } from './telemetryRecovery.ts';

test('recover missing, expired and revoked calculations without retrying permission or metric errors', () => {
  assert.equal(isTelemetryResultUnavailable({status:404,code:'not_found',message:'Query result not found.'}),true);
  assert.equal(isTelemetryResultUnavailable({status:410,code:'result_expired'}),true);
  assert.equal(isTelemetryResultUnavailable({status:409,code:'result_unavailable'}),true);
  assert.equal(isTelemetryResultUnavailable({status:404,code:'not_found',message:'Metric result not found.'}),false);
  assert.equal(isTelemetryResultUnavailable({status:403,code:'forbidden'}),false);
  assert.equal(isTelemetryResultUnavailable({status:409,code:'query_not_complete'}),false);
});

test('concurrent widgets share recovery, replacement results cannot loop, and manual retry remains possible', async () => {
  const gate=createTelemetryRecoveryGate(); let calls=0; let finish!:()=>void;
  const hold=new Promise<void>(resolve=>{finish=resolve;});
  const refresh=async()=>{calls++;await hold;};
  const first=gate.run('binding-query',refresh), second=gate.run('binding-query',refresh);
  assert.equal(first,second); await Promise.resolve(); assert.equal(calls,1);
  finish(); assert.equal(await first,true);
  assert.equal(await gate.run('binding-query',refresh),false);
  assert.equal(await gate.run('binding-query',refresh,true),true); assert.equal(calls,2);
  assert.equal(await gate.run('different-filter',refresh),true); assert.equal(calls,3);
});

test('failed recovery consumes the automatic attempt but permits an explicit retry', async () => {
  const gate=createTelemetryRecoveryGate(); let calls=0;
  const fail=async()=>{calls++;throw new Error('offline');};
  await assert.rejects(gate.run('binding',fail),/offline/);
  assert.equal(await gate.run('binding',fail),false); assert.equal(calls,1);
  await assert.rejects(gate.run('binding',fail,true),/offline/); assert.equal(calls,2);
});
