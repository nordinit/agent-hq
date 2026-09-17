import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
// These tests exercise immutable historical schemas and the detector must name
// the forbidden term. Applied SQL migrations are outside the runtime roots.
const exceptions=new Set([
  'scripts/check-workflow-terminology.mjs',
  'api/src/db/pg/migration19TenantOwnership.test.ts',
  'api/src/db/pg/migration32WorkflowTerminology.test.ts',
]);
const roots=/^(api\/(src|scripts)|ui\/(app|components|features|lib|scripts)|scripts|cli|plugins|skills|docker|\.github)\//;
const forbidden=/sprint(?!f)/i;
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0');
const failures=[];
for(const file of new Set(files)){
  if(!roots.test(file)||exceptions.has(file)||!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
  if(/(?:package-lock\.json|\.(?:png|jpg|jpeg|gif|ico|woff2?|pdf))$/.test(file))continue;
  if(forbidden.test(file))failures.push(file);
  const lines=fs.readFileSync(file,'utf8').split('\n');
  for(let i=0;i<lines.length;i++)if(forbidden.test(lines[i]))failures.push(`${file}:${i+1}`);
}
if(failures.length){console.error('Use workflow terminology in active code:\n'+failures.join('\n'));process.exitCode=1;}
else console.log('Workflow terminology check passed.');
