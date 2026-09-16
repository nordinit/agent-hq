import {hostname} from 'os';
import {createHash} from 'crypto';
import {escapeIdentifier} from 'pg';

const workerName=/^agent_hq_test_w[1-9]\d*_p([1-9]\d*)(?:_h([a-f0-9]{8}))?_[a-f0-9]{12}$/;
const hostKey=(host:string)=>createHash('sha256').update(host).digest('hex').slice(0,8);
interface WorkerOwner {format:'agent-hq-test-worker';version:1;host:string;pid:number}
interface Candidate {datname:string;owner_comment:string|null}
interface CleanupClient {query(sql:string):Promise<{rows:Candidate[]}>}

export function workerDatabaseOwnerComment(pid=process.pid,host=hostname()):string {
  return JSON.stringify({format:'agent-hq-test-worker',version:1,host,pid} satisfies WorkerOwner);
}

export function makeWorkerDatabaseName(worker:string,fingerprint:string,pid=process.pid,host=hostname()):string {
  if(!/^[1-9]\d*$/.test(worker)||!Number.isSafeInteger(pid)||pid<1||!/^[a-f0-9]{12}$/.test(fingerprint))throw new Error('Invalid test database identity.');
  // PID alone is not unique when several hosts use one PostgreSQL test server.
  const name=`agent_hq_test_w${worker}_p${pid}_h${hostKey(host)}_${fingerprint}`;
  if(name.length>63)throw new Error('Test database identity exceeds PostgreSQL identifier length.');
  return name;
}

/** Permission/inspection errors do not prove that a process has exited. */
export function processDefinitelyExited(pid:number,probe:(pid:number,signal:0)=>unknown=process.kill):boolean {
  try{probe(pid,0);return false;}
  catch(error){return (error as NodeJS.ErrnoException)?.code==='ESRCH';}
}

export function canReapWorkerDatabase(candidate:Candidate,localHost=hostname(),exited=processDefinitelyExited):boolean {
  const match=workerName.exec(candidate.datname);if(!match||!candidate.owner_comment)return false;
  let owner:Partial<WorkerOwner>;
  try{owner=JSON.parse(candidate.owner_comment);}catch{return false;}
  if(!owner||owner.format!=='agent-hq-test-worker'||owner.version!==1||owner.host!==localHost||
    !Number.isSafeInteger(owner.pid)||owner.pid!==Number(match[1])||(match[2]&&match[2]!==hostKey(owner.host)))return false;
  return exited(owner.pid!);
}

/** An idle connection pool is not an abandoned test run. Reap only workers
 * whose locally stamped owner has definitely exited. Unknown/remote ownership
 * and shared fingerprint templates require explicit cleanup, never guessing.
 */
export async function reapStaleTestDatabases(client:CleanupClient,localHost=hostname(),exited=processDefinitelyExited):Promise<number> {
  const {rows}=await client.query(`SELECT d.datname,shobj_description(d.oid,'pg_database') AS owner_comment
    FROM pg_database d WHERE d.datname LIKE 'agent_hq_test_w%'
    AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname=d.datname)`);
  let removed=0;
  for(const candidate of rows){
    if(!canReapWorkerDatabase(candidate,localHost,exited))continue;
    try{
      // No FORCE: a connection appearing after the inventory protects the DB.
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(candidate.datname)}`);
      removed++;
    }catch{ /* A connection, ownership or concurrent cleanup race is harmless. */ }
  }
  return removed;
}
