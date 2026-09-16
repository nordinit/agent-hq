import {canReapWorkerDatabase,makeWorkerDatabaseName,processDefinitelyExited,reapStaleTestDatabases,workerDatabaseOwnerComment} from './testDatabaseCleanup';

const host='test-host',name='agent_hq_test_w1_p21029_35d02a09325c';
const owned={datname:name,owner_comment:workerDatabaseOwnerComment(21029,host)};

it('separates identical worker/PID pairs on different hosts sharing PostgreSQL',()=>{
  const datname=makeWorkerDatabaseName('1','35d02a09325c',21029,host);
  expect(datname).not.toBe(makeWorkerDatabaseName('1','35d02a09325c',21029,'another-host'));
  expect(canReapWorkerDatabase({...owned,datname},host,()=>true)).toBe(true);
  expect(canReapWorkerDatabase({...owned,datname:makeWorkerDatabaseName('1','35d02a09325c',21029,'another-host')},host,()=>true)).toBe(false);
});

it('rejects invalid or truncated database identities before interpolating SQL',()=>{
  expect(()=>makeWorkerDatabaseName('1; DROP DATABASE production','35d02a09325c')).toThrow('Invalid');
  expect(()=>makeWorkerDatabaseName('1'.repeat(64),'35d02a09325c')).toThrow('length');
});

it('retains the disconnected database of a live parallel worker',async()=>{
  const exited=jest.fn(()=>false),query=jest.fn(async()=>({rows:[owned]}));
  expect(await reapStaleTestDatabases({query},host,exited)).toBe(0);
  expect(exited).toHaveBeenCalledWith(21029);expect(query).toHaveBeenCalledTimes(1);
});

it('reaps only an unconnected database with a proven exited local owner',async()=>{
  const query=jest.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[owned]:[]}));
  expect(await reapStaleTestDatabases({query},host,()=>true)).toBe(1);
  expect(query.mock.calls[0][0]).toContain('NOT EXISTS (SELECT 1 FROM pg_stat_activity');
  expect(query.mock.calls[1][0]).toBe(`DROP DATABASE IF EXISTS "${name}"`);
  expect(query.mock.calls.every(([sql])=>!sql.includes('FORCE'))).toBe(true);
});

it.each([
  {datname:name,owner_comment:null},
  {datname:name,owner_comment:'not json'},
  {datname:name,owner_comment:workerDatabaseOwnerComment(21029,'another-host')},
  {datname:name,owner_comment:workerDatabaseOwnerComment(999,host)},
  {datname:'agent_hq_test_template_35d02a09325c',owner_comment:owned.owner_comment},
  {datname:'agent_hq_test_w1',owner_comment:owned.owner_comment},
  {datname:'production',owner_comment:owned.owner_comment},
  {datname:`${name}"; DROP DATABASE production;--`,owner_comment:owned.owner_comment},
])('retains unproven, remote, shared or invalid ownership: $datname',candidate=>{
  const exited=jest.fn(()=>true);
  expect(canReapWorkerDatabase(candidate,host,exited)).toBe(false);
  expect(exited).not.toHaveBeenCalled();
});

it('requires ESRCH, not permission or unexpected process-inspection errors',()=>{
  expect(processDefinitelyExited(1,()=>{})).toBe(false);
  for(const code of ['EPERM','EACCES','UNKNOWN'])expect(processDefinitelyExited(1,()=>{throw Object.assign(new Error('unknown'),{code});})).toBe(false);
  expect(processDefinitelyExited(1,()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});})).toBe(true);
});

it('does not count or force a drop when a connection appears after inventory',async()=>{
  const query=jest.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT'))return {rows:[owned]};
    throw Object.assign(new Error('database is being accessed by other users'),{code:'55006'});
  });
  expect(await reapStaleTestDatabases({query},host,()=>true)).toBe(0);
  expect(query).toHaveBeenCalledTimes(2);
});
