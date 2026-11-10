const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const check = process.argv.includes('--check');
const output = check ? null : path.join(root, 'api/operation-inventory'); if(output) fs.mkdirSync(output,{recursive:true});
const ts = require(path.join(root, 'api/node_modules/typescript'));
const cache = new Map();
const issues = [];
const verbs = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all']);
function resolveFile(base, relative) {
  const stem = path.resolve(path.dirname(base), relative);
  return [stem, stem + '.ts', path.join(stem, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
}
function moduleInfo(file) {
  if (cache.has(file)) return cache.get(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const info = { source, imports: new Map(), exports: new Map(), calls: [], functions: new Map() };
  cache.set(file, info);
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
      const target = resolveFile(file, node.moduleSpecifier.text);
      const clause = node.importClause;
      if (clause?.name) info.imports.set(clause.name.text, { file: target, symbol: 'default' });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const x of clause.namedBindings.elements) info.imports.set(x.name.text, { file: target, symbol: (x.propertyName || x.name).text });
      }
    }
    if (ts.isExportAssignment(node)) info.exports.set('default', { local: node.expression.getText(source) });
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const target = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? resolveFile(file, node.moduleSpecifier.text) : null;
      for (const x of node.exportClause.elements) info.exports.set(x.name.text, target ? { file: target, symbol: (x.propertyName || x.name).text } : { local: (x.propertyName || x.name).text });
    }
    if (ts.isFunctionDeclaration(node) && node.name) info.functions.set(node.name.text, node);
    if (ts.isCallExpression(node)) info.calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return info;
}
function literals(node, bindings = {}) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      if (!ts.isIdentifier(span.expression) || !(span.expression.text in bindings)) return null;
      value += bindings[span.expression.text] + span.literal.text;
    }
    return [value];
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(x=>literals(x,bindings));
    return values.every(Boolean) ? values.flat() : null;
  }
  return null;
}
function contextualPaths(call) {
  const plain = literals(call.arguments[0]);
  if (plain) return plain;
  let parent = call.parent;
  while (parent) {
    if (ts.isForOfStatement(parent)) {
      let expr = parent.expression;
      while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
      const declaration = ts.isVariableDeclarationList(parent.initializer) ? parent.initializer.declarations[0] : null;
      if (declaration && ts.isArrayBindingPattern(declaration.name) && ts.isCallExpression(expr) && expr.expression.getText() === 'Object.entries' && ts.isObjectLiteralExpression(expr.arguments[0])) {
        const keyName = declaration.name.elements[0].name.getText();
        const expanded = expr.arguments[0].properties.map(p=>literals(call.arguments[0],{[keyName]:p.name.text}));
        if (expanded.every(Boolean)) return expanded.flat();
      }
    }
    parent=parent.parent;
  }
  return null;
}
const join = (a, b) => ('/' + [a, b].join('/')).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
function routesFor(file, symbol, prefix, trail = []) {
  if (!file) { issues.push({ kind: 'unresolved_module', symbol, prefix }); return []; }
  const info = moduleInfo(file);
  const exported = info.exports.get(symbol);
  if (exported?.file) return routesFor(exported.file, exported.symbol, prefix, trail);
  const local = exported?.local || symbol;
  const binding = info.imports.get(local);
  if (binding) return routesFor(binding.file, binding.symbol, prefix, trail);
  const guard = file + '#' + local;
  if (trail.includes(guard)) return [];
  const nextTrail = [...trail, guard];
  const result = [];
  const fn = info.functions.get(local);
  // app.use also imports middleware. Its req.get/header calls are not routes.
  if(fn&&!/^register.*Routes$/.test(local))return [];
  const receiver = fn ? fn.parameters[0]?.name.getText(info.source) : local;
  const calls = fn ? info.calls.filter(c => c.pos >= fn.pos && c.end <= fn.end) : info.calls;
  for (const call of calls) {
    const expression = call.expression;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === receiver) {
      const method = expression.name.text;
      if (verbs.has(method)) {
        const paths = contextualPaths(call);
        if (!paths) { issues.push({ kind: 'dynamic_route', file: path.relative(root,file), line: info.source.getLineAndCharacterOfPosition(call.getStart()).line + 1, expression: call.arguments[0]?.getText(info.source) }); continue; }
        const handlerNodes = call.arguments.slice(1);
        for (const suffix of paths) result.push({ method: method.toUpperCase(), path: join(prefix,suffix), source: path.relative(root,file), line: info.source.getLineAndCharacterOfPosition(call.getStart()).line + 1,
          generated_from_loop: ts.isTemplateExpression(call.arguments[0]),
          handler: handlerNodes.map(h => ts.isIdentifier(h) ? h.text : ts.isCallExpression(h) ? h.expression.getText(info.source) : '<inline>'),
          delegates_or_redirects: handlerNodes.some(h => /res\.redirect\(|dispatchTo\w+Alias\(/.test(h.getText(info.source))) });
      }
      if (method === 'use') {
        const mount = literals(call.arguments[0]);
        const targets = mount ? call.arguments.slice(1) : call.arguments;
        for (const target of targets) if (ts.isIdentifier(target)) {
          const imported = info.imports.get(target.text);
          if (imported) for (const p of mount || ['']) result.push(...routesFor(imported.file, imported.symbol, join(prefix,p), nextTrail));
        }
      }
    } else if (ts.isIdentifier(expression) && call.arguments.some(a => ts.isIdentifier(a) && a.text === receiver)) {
      const imported = info.imports.get(expression.text);
      if (imported && /^register.*Routes$/.test(imported.symbol)) result.push(...routesFor(imported.file, imported.symbol, prefix, nextTrail));
    }
  }
  return result;
}
const index = path.join(root, 'api/src/index.ts');
let routes = routesFor(index, 'app', '');
// Transport and OAuth SDK mounts have dynamically constructed routers: record them explicitly
// rather than guessing the SDK's full conditional URL set from a static scan.
const dynamicMounts = [
  { mount: '/mcp', source: 'api/src/mcp/httpServer.ts', kind: 'conditional JSON-RPC transport' },
  { mount: '<OAuth issuer>', source: 'api/src/mcp/oauth/router.ts', kind: 'conditional OAuth SDK router: authorize, token, register, revoke and discovery' },
  { mount: '/api/v1/chat/ws', source: 'api/src/index.ts', kind: 'WebSocket upgrade; not an Express HTTP operation' },
];
const unique = new Map();
for (const route of routes) unique.set(route.method + ' ' + route.path, route);
routes = [...unique.values()].sort((a,b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const { registerAgentHqMcpCatalog } = require(path.join(root, 'api/src/mcp/registerCatalog.ts'));
const { getMcpCatalog } = require(path.join(root, 'api/src/mcp/catalog.ts'));
const { getOpenApiDocument } = require(path.join(root, 'api/src/openapi/document.ts'));
const openApiDocument = getOpenApiDocument();
registerAgentHqMcpCatalog();
const liveCatalog=getMcpCatalog();
const catalog={...liveCatalog,tools:liveCatalog.tools.map(({operations,operation_mapping,annotations,retry_policy,...tool})=>tool)};

const toolSources = new Map();
const toolMethods = new Map();
const toolContracts = new Map();
const crypto=require('node:crypto');
const clientSource=moduleInfo(path.join(root,'api/src/mcp/apiClient.ts')).source;
const clientMethods=new Map();
function indexMethods(node){if(ts.isMethodDeclaration(node)&&node.name)clientMethods.set(node.name.getText(clientSource),node);ts.forEachChild(node,indexMethods);}
indexMethods(clientSource);
function requestMethods(node,seen=new Set(),sources=new Set()) {
 const result=new Set();
 function visit(n){
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)) {
   const property=n.expression.name.text;
   if(['request','requestMultipart','apiRequest','telemetryMutate','telemetryWrite'].includes(property)&&ts.isStringLiteral(n.arguments[0])&&verbs.has(n.arguments[0].text.toLowerCase()))result.add(n.arguments[0].text.toUpperCase());
   if(['requestArrayBuffer','telemetryGet'].includes(property))result.add('GET');
   if(clientMethods.has(property)&&!seen.has(property)){const next=new Set(seen);next.add(property);sources.add(clientMethods.get(property).getText(clientSource));for(const m of requestMethods(clientMethods.get(property),next,sources))result.add(m);}
  }
  ts.forEachChild(n,visit);
 }
 visit(node);return [...result].sort();
}
for (const name of fs.readdirSync(path.join(root,'api/src/mcp/domains')).filter(n=>n.endsWith('.ts')&&!n.endsWith('.test.ts'))) {
  const file = path.join(root, 'api/src/mcp/domains', name);
  const info = moduleInfo(file);
  for (const call of info.calls) {
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'registerTool') continue;
    let names = literals(call.arguments[0]);
    if(!names) {
      let loop=call.parent;
      while(loop&&!ts.isForOfStatement(loop))loop=loop.parent;
      if(loop) {
        let expr=loop.expression;while(ts.isAsExpression(expr)||ts.isParenthesizedExpression(expr))expr=expr.expression;
        const declaration=ts.isVariableDeclarationList(loop.initializer)?loop.initializer.declarations[0]:null;
        if(declaration&&ts.isArrayBindingPattern(declaration.name)&&ts.isArrayLiteralExpression(expr)) {
          const expanded=expr.elements.map(tuple=>{
            if(!ts.isArrayLiteralExpression(tuple))return null;
            const bindings=Object.fromEntries(declaration.name.elements.map((element,i)=>[element.name.getText(info.source),literals(tuple.elements[i])?.[0]]));
            return literals(call.arguments[0],bindings);
          });
          if(expanded.every(Boolean))names=expanded.flat();
        }
      }
    }
    if (!names) {issues.push({kind:'unresolved_mcp_registration',file:path.relative(root,file),line:info.source.getLineAndCharacterOfPosition(call.getStart()).line+1});continue;}
    for (const tool of names) {toolSources.set(tool, { source: path.relative(root,file), line: info.source.getLineAndCharacterOfPosition(call.getStart()).line+1 });const sources=new Set();toolMethods.set(tool,requestMethods(call,new Set(),sources));toolContracts.set(tool,crypto.createHash('sha256').update([call.getText(info.source),...[...sources].sort()].join('\n')).digest('hex'));}
  }
}
function normalize(p) { return p.split('?')[0].replace(/\{[^}]+\}/g, ':param').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param').replace(/:param\([^)]*\)/g, ':param').replace(/\/$/,''); }
const published = new Map();
for (const [p, methods] of Object.entries(openApiDocument.paths)) for (const [method, op] of Object.entries(methods)) if (verbs.has(method)) published.set(method.toUpperCase()+' '+normalize(p), op.operationId);
for (const route of routes) {
  route.public_operation_id = published.get(route.method+' '+normalize(route.path)) || null;
  route.mcp_tools = catalog.tools.filter(t => (t.rest_paths || []).some(p => normalize(p) === normalize(route.path))).map(t=>t.canonical_name);
  route.api_group = route.path.startsWith('/api/v1/') ? route.path.slice(8).split('/')[0] : '<outside-api-v1>';
}
const tools = catalog.tools.map(t=>({ ...t, ...(toolSources.get(t.canonical_name) || { source: 'api/src/mcp/domains/telemetry.ts', generated_registration: true }),
  candidate_rest_operations: routes.filter(r=>(t.rest_paths||[]).some(p=>normalize(p)===normalize(r.path))).map(r=>r.method+' '+r.path),
  source_client_methods:toolMethods.get(t.canonical_name)??[],mapping_note:'HTTP verbs are traced through the domain handler and API client. Declared backing paths are checked against mounted routes; source contracts are pinned for drift review.' }));
const histogram = (items, get) => Object.fromEntries([...items.reduce((m,x)=>m.set(get(x),(m.get(get(x))||0)+1),new Map())].sort((a,b)=>a[0].localeCompare(b[0])));
const actualDomains = [...new Set(tools.map(t=>t.domain))].sort();
const routeSourceGroups = new Map();
for (const r of routes) {
  const key = r.source+':'+r.line+':'+r.method;
  if (!routeSourceGroups.has(key)) routeSourceGroups.set(key,[]);
  routeSourceGroups.get(key).push(r.path);
}
const generatedSourceKeys = new Set(routes.filter(r=>r.generated_from_loop).map(r=>r.source+':'+r.line+':'+r.method));
const sourceDeclarationAliases = [...routeSourceGroups.entries()].filter(([key,paths])=>paths.length>1&&!generatedSourceKeys.has(key)).map(([source_operation,paths])=>({source_operation,paths}));
const summary = {
  source_commit: cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  generated_at: new Date().toISOString(),
  mcp_tools: tools.length, mcp_resources: catalog.resources.length,
  mcp_by_domain: histogram(tools,t=>t.domain),
  admin_only_mcp_tools: tools.filter(t=>t.requires_any.length===1&&t.requires_any[0].length===1&&t.requires_any[0][0]==='admin.full_access').length,
  static_http_operations_including_aliases: routes.length,
  static_http_methods: histogram(routes,r=>r.method),
  static_http_by_group: histogram(routes,r=>r.api_group),
  http_api_v1_operations: routes.filter(r=>r.path.startsWith('/api/v1/')).length,
  openapi_published_operations: published.size,
  matched_public_http_operations: routes.filter(r=>r.public_operation_id).length,
  source_declarations_with_multiple_mounted_paths: sourceDeclarationAliases.length,
  unique_route_source_operations: routeSourceGroups.size,
  extra_paths_from_compatibility_mounts_or_arrays: sourceDeclarationAliases.reduce((n,x)=>n+x.paths.length-1,0),
  extra_paths_from_generated_collection_routes: [...routeSourceGroups.entries()].filter(([key])=>generatedSourceKeys.has(key)).reduce((n,[,paths])=>n+paths.length-1,0),
  tools_with_no_exact_rest_path_match: tools.filter(t=>t.candidate_rest_operations.length===0).map(t=>({name:t.canonical_name,rest_paths:t.rest_paths})),
  duplicate_mcp_names: tools.filter((t,i)=>tools.findIndex(x=>x.canonical_name===t.canonical_name)!==i).map(t=>t.canonical_name),
  catalog_domains_missing_from_declared_list: actualDomains.filter(d=>!catalog.domains.includes(d)),
  catalog_declared_domains_without_tools: catalog.domains.filter(d=>!actualDomains.includes(d)),
  static_scan_issues: issues,
  limitations: [
    'Source-level catalog, not a live deployment or authorization test. No API request or tool handler is executed.',
    'HTTP operation count includes compatibility aliases and conditional source registrations; it is not a count of distinct business actions.',
    'OAuth SDK-generated routes, Streamable HTTP transport methods, and WebSocket messages are listed as dynamic mounts, not fabricated as static operations.',
    'MCP methods are traced through source client calls. The manifest pins source contracts; dynamic runtime branch semantics still require authorization tests.',
    'OpenAPI is deliberately a public subset. Unpublished routes are not automatically defects.',
  ],
};
if(output) fs.writeFileSync(path.join(output,'inventory.json'),JSON.stringify({summary,tools,resources:catalog.resources,http_operations:routes,dynamic_mounts:dynamicMounts,source_declaration_aliases:sourceDeclarationAliases},null,2)+'\n');
const lines = ['AGENT HQ MCP / API SOURCE INVENTORY',`Commit: ${summary.source_commit}`,`Generated: ${summary.generated_at}`,'',...summary.limitations.map(x=>'NOTE: '+x),'','MCP FUNCTIONS'];
for (const domain of actualDomains) {
  lines.push('',domain.toUpperCase());
  for (const t of tools.filter(t=>t.domain===domain)) lines.push(`${t.canonical_name} | ${t.requires_any.map(c=>c.join(' + ')).join(' OR ')} | ${(t.rest_paths||[]).join(', ')} | ${t.description}`);
}
lines.push('','STATIC HTTP OPERATIONS (INCLUDING COMPATIBILITY ALIASES)');
for (const r of routes) lines.push(`${r.method.padEnd(6)} ${r.path} | ${r.source}:${r.line} | ${r.public_operation_id?'public OpenAPI':'not in public OpenAPI'}${r.delegates_or_redirects?' | redirects/delegates':''}`);
lines.push('','DYNAMIC / NON-HTTP SURFACES',...dynamicMounts.map(x=>`${x.mount} | ${x.kind} | ${x.source}`));
if(output) fs.writeFileSync(path.join(output,'function-list.txt'),lines.join('\n')+'\n');
if(output) fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
if(!check) console.log(JSON.stringify(summary,null,2));

const {canonicalPolicyPath}=require(path.join(root,'api/src/domains/access/operations.ts'));
const manifest = routes.map(r=>{
 const key=r.source+':'+r.line+':'+r.method;
 const peers=generatedSourceKeys.has(key)?[r.path]:routeSourceGroups.get(key);
 const canonical=peers.find(p=>canonicalPolicyPath(p.replace(/^\/api\/v1/,''))===p.replace(/^\/api\/v1/,'')&&catalog.tools.some(t=>(t.rest_paths??[]).includes(p)))??peers.find(p=>canonicalPolicyPath(p.replace(/^\/api\/v1/,''))===p.replace(/^\/api\/v1/,''))??peers[0];
 const retired=r.source==='api/src/routes/workflows.ts'&&/\/(jobs|schedules)(\/|$)/.test(r.path)&&r.method!=='GET';
 return {method:r.method,path:r.path,canonical_path:canonical,aliases:peers.filter(p=>p!==canonical),source:r.source,line:r.line,public:!!r.public_operation_id,compatibility:r.delegates_or_redirects||r.path!==canonical,retired,deprecation_replacement:retired?(r.path.includes('/schedules')?'/api/v1/recurring-task-series':'/api/v1/tasks'):r.path!==canonical?canonical:null};
});
const target=path.join(root,'api/src/domains/access/operations.generated.json');
const mcp_operations=Object.fromEntries(catalog.tools.map(t=>[t.canonical_name,{source_contract_digest:toolContracts.get(t.canonical_name)??null,methods:toolMethods.get(t.canonical_name)??[],operations:routes.filter(r=>(t.rest_paths??[]).some(p=>normalize(p)===normalize(r.path))&&(toolMethods.get(t.canonical_name)??[]).includes(r.method)).map(r=>({method:r.method,path:r.path})),mapping:toolMethods.has(t.canonical_name)?'source_client_methods':'generated_domain_contract'}]));
const generated=JSON.stringify({operations:manifest,dynamic_mounts:dynamicMounts,mcp_operations},null,2)+'\n';
if(check) {
  if(fs.readFileSync(target,'utf8')!==generated) throw new Error('Operation inventory drift: run npm run catalog:generate');
  if(issues.length || summary.duplicate_mcp_names.length || summary.catalog_domains_missing_from_declared_list.length || summary.tools_with_no_exact_rest_path_match.some(t=>t.name!=='agent_hq_api_request') || Object.entries(mcp_operations).some(([name,value])=>name!=='agent_hq_api_request'&&!value.operations.length)) throw new Error('Unclassified catalog registrations: '+JSON.stringify(summary));
  const {operationCatalog}=require(path.join(root,'api/src/domains/access/operations.ts'));
  const ids=operationCatalog().map(operation=>operation.operation_id);
  if(new Set(ids).size!==ids.length)throw new Error('Duplicate operation identities in catalog');
  console.log('Operation inventory and catalog registrations match.');
} else fs.writeFileSync(target,generated);
