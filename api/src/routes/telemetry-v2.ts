import { Router, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { getDb } from '../db/client';
import { TelemetryError, telemetryAccess, queryScope, resolveScope } from '../domains/telemetry/access';
import { getTelemetryCatalog } from '../domains/telemetry/catalog';
import { recipeCatalog, coreRuntimeRecipes } from '../domains/telemetry/recipes';
import { TelemetryDefinitionError } from '../domains/telemetry/contracts';
import { compileDefinition, createDefinition, reviseDefinition, getDefinition, listDefinitions, archiveDefinition, listBindings, previewBinding, saveBinding, type DefinitionKind } from '../domains/telemetry/definitions';
import { queryTelemetry, readQuery, queryContributors, cancelQuery, freezeReport, listSnapshots, getTelemetrySettings, updateTelemetrySettings } from '../domains/telemetry/queries';
import { backfillTelemetry, getTelemetryCoverage, TELEMETRY_BACKFILL_SOURCES } from '../domains/telemetry/capture';
import { exportTelemetry, importTelemetry } from '../domains/telemetry/portability';

const router=Router();
const handle=(fn:(req:Request,res:Response)=>Promise<unknown>)=>(req:Request,res:Response)=>{void fn(req,res).catch(error=>{
  if(error instanceof ZodError){res.status(400).json({code:'invalid_definition',error:'The telemetry request is invalid.',issues:error.issues});return;}
  if(error instanceof TelemetryError){res.status(error.status).json({code:error.code,error:error.message,details:error.details});return;}
  if(error instanceof TelemetryDefinitionError){res.status(error.code==='query_limit_exceeded'?413:400).json({code:error.code,error:error.message,issues:error.issues});return;}
  if(error?.code==='23505'){res.status(409).json({code:'revision_conflict',error:'This name or scope already exists, or another editor saved first. Reload before retrying.'});return;}
  if(error?.code==='57014'){res.status(413).json({code:'query_limit_exceeded',error:'The query exceeded its time budget. Narrow the scope or request a background evaluation.'});return;}
  console.error('[telemetry] Request failed',{code:error?.code??'unknown',path:req.path});
  res.status(500).json({code:'telemetry_unavailable',error:'Telemetry could not complete this request. No result was substituted.'});
});};
router.get('/catalog',handle(async(req,res)=>{
  const db=getDb(),access=await telemetryAccess(db,req),scope=await resolveScope(db,access,queryScope(req.query));
  res.json({...await getTelemetryCatalog(db,access,scope),recipes:recipeCatalog,core_metrics:coreRuntimeRecipes(),coverage:await getTelemetryCoverage(db,access.tenantId,scope.project_id==null?undefined:[scope.project_id]),operations:['count','distinct_count','count_if','sum','mean','min','max','percentile','distribution','ratio','duration','funnel'],scope});
}));
router.post('/definitions/validate',handle(async(req,res)=>{
  const db=getDb(),access=await telemetryAccess(db,req),scope=await resolveScope(db,access,req.body.scope??{});
  const compiled=await compileDefinition(db,access,req.body.definition,scope,req.body.profile_revision_id);
  res.json({valid:true,errors:[],references:compiled.dependencies.catalog.map((field:any)=>field.id),definition:compiled.definition,description:compiled.definition.description??`${compiled.definition.name}: ${compiled.definition.grain} / ${compiled.definition.measure.kind}`,dependencies:compiled.dependencies});
}));
for(const [plural,kind] of Object.entries({metrics:'metric',profiles:'profile',reports:'report'}) as Array<[string,DefinitionKind]>){
  router.get(`/${plural}`,handle(async(req,res)=>{const db=getDb(),access=await telemetryAccess(db,req),scope=await resolveScope(db,access,queryScope(req.query));res.json({[plural]:await listDefinitions(db,access,kind,scope)});}));
  router.post(`/${plural}`,handle(async(req,res)=>{const db=getDb();res.status(201).json(await createDefinition(db,await telemetryAccess(db,req),kind,req.body));}));
  router.get(`/${plural}/:id`,handle(async(req,res)=>{const db=getDb();res.json(await getDefinition(db,await telemetryAccess(db,req),kind,req.params.id));}));
  router.post(`/${plural}/:id/revisions`,handle(async(req,res)=>{const db=getDb();res.status(201).json(await reviseDefinition(db,await telemetryAccess(db,req),kind,req.params.id,req.body));}));
  router.delete(`/${plural}/:id`,handle(async(req,res)=>{const db=getDb();res.json(await archiveDefinition(db,await telemetryAccess(db,req),kind,req.params.id));}));
}
router.get('/bindings',handle(async(req,res)=>{const db=getDb(),access=await telemetryAccess(db,req),scope=await resolveScope(db,access,queryScope(req.query));res.json({bindings:await listBindings(db,access,scope)});}));
router.post('/bindings/preview',handle(async(req,res)=>{const db=getDb();res.json(await previewBinding(db,await telemetryAccess(db,req),req.body));}));
router.put('/bindings',handle(async(req,res)=>{const db=getDb();res.json(await saveBinding(db,await telemetryAccess(db,req),req.body));}));
router.post('/queries/preview',handle(async(req,res)=>{const db=getDb();res.json(await queryTelemetry(db,await telemetryAccess(db,req),req.body,{preview:true}));}));
router.post('/queries',handle(async(req,res)=>{const db=getDb(),result=await queryTelemetry(db,await telemetryAccess(db,req),req.body);res.status(result.state==='queued'?202:200).json(result);}));
router.get('/queries/:id',handle(async(req,res)=>{const db=getDb();res.json(await readQuery(db,await telemetryAccess(db,req),req.params.id));}));
router.delete('/queries/:id',handle(async(req,res)=>{const db=getDb();res.json(await cancelQuery(db,await telemetryAccess(db,req),req.params.id));}));
router.get('/queries/:id/contributors',handle(async(req,res)=>{const db=getDb();res.json(await queryContributors(db,await telemetryAccess(db,req),req.params.id,req.query));}));
router.get('/snapshots',handle(async(req,res)=>{const db=getDb();res.json(await listSnapshots(db,await telemetryAccess(db,req)));}));
router.get('/reports/:id/snapshots',handle(async(req,res)=>{const db=getDb();res.json(await listSnapshots(db,await telemetryAccess(db,req),req.params.id));}));
router.post('/reports/:id/snapshots',handle(async(req,res)=>{const db=getDb();res.status(201).json(await freezeReport(db,await telemetryAccess(db,req),req.params.id,req.body));}));
router.get('/coverage',handle(async(req,res)=>{const db=getDb(),access=await telemetryAccess(db,req),scope=await resolveScope(db,access,queryScope(req.query));res.json(await getTelemetryCoverage(db,access.tenantId,scope.project_id==null?undefined:[scope.project_id]));}));
router.get('/backfills',handle(async(req,res)=>{const db=getDb(),access=await telemetryAccess(db,req);res.json(await getTelemetryCoverage(db,access.tenantId,access.projectId==null?undefined:[access.projectId]));}));
router.post('/backfills',handle(async(req,res)=>{
  const db=getDb(),access=await telemetryAccess(db,req);
  if(access.projectId!=null)throw new TelemetryError('forbidden','Backfill is tenant-wide operator work.',403);
  const input=z.object({source:z.string().optional(),batch_size:z.number().int().min(1).max(10000).optional()}).strict().parse(req.body);
  if(input.source&&!TELEMETRY_BACKFILL_SOURCES.includes(input.source as any))throw new TelemetryError('invalid_definition','Unknown backfill source.');
  res.json(await backfillTelemetry(db,{tenantId:access.tenantId,source:input.source as any,batchSize:input.batch_size}));
}));
router.get('/settings',handle(async(req,res)=>{const db=getDb(),access=await telemetryAccess(db,req);res.json(await getTelemetrySettings(db,access.tenantId));}));
router.put('/settings',handle(async(req,res)=>{const db=getDb();res.json(await updateTelemetrySettings(db,await telemetryAccess(db,req),req.body));}));
router.post('/export',handle(async(req,res)=>{const db=getDb();res.json(await exportTelemetry(db,await telemetryAccess(db,req),req.body));}));
router.post('/import',handle(async(req,res)=>{const db=getDb();res.status(201).json(await importTelemetry(db,await telemetryAccess(db,req),req.body));}));
export default router;
