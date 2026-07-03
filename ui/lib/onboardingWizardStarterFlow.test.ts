import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wizardSource = readFileSync(join(here, '..', 'components', 'OnboardingWizard.tsx'), 'utf8');
const agentsApiSource = readFileSync(join(here, 'api', 'agents.ts'), 'utf8');
const apiTypesSource = readFileSync(join(here, 'api', 'types.ts'), 'utf8');

test('onboarding API client exposes shared starter-template setup endpoints', () => {
  assert.match(agentsApiSource, /getStarterTemplates:\s*\(\)\s*=>\s*apiFetch<StarterTemplateCatalogResponse>\('\/api\/v1\/setup\/templates'\)/);
  assert.match(agentsApiSource, /previewStarterPlan:\s*\(data: StarterPlanInput\)\s*=>\s*\n\s*apiFetch<StarterPlanPreviewResponse>\('\/api\/v1\/setup\/starter-plan\/preview'/);
  assert.match(agentsApiSource, /applyStarterPlan:\s*\(data: StarterPlanInput\)\s*=>\s*\n\s*apiFetch<StarterPlanApplyResponse>\('\/api\/v1\/setup\/starter-plan\/apply'/);
  assert.match(agentsApiSource, /configureRuntime:\s*\(data: \{ kind: 'openclaw' \| 'hermes' \| 'custom'/);
});

test('onboarding API types model template catalog, multi-template input, preview, and apply responses', () => {
  assert.match(apiTypesSource, /export type StarterTemplateKey = 'development' \| 'ops' \| 'lead-generation' \| 'blank'/);
  assert.match(apiTypesSource, /template_keys\?: StarterTemplateKey\[\]/);
  assert.match(apiTypesSource, /export interface StarterPlanPreviewResponse/);
  assert.match(apiTypesSource, /export interface StarterPlanApplyResponse/);
  assert.match(apiTypesSource, /compatibility:\s*\{\s*\n\s*ok: boolean;/);
});

test('onboarding wizard fetches templates from API and supports multi-template selection', () => {
  assert.match(wizardSource, /api\.getStarterTemplates\(\)/);
  assert.match(wizardSource, /selectedTemplateKeys, setSelectedTemplateKeys.*\['development'\]/);
  assert.match(wizardSource, /return \[\.\.\.withoutBlank, key\]/);
  assert.match(wizardSource, /if \(key === 'blank'\) return \['blank'\]/);
});

test('onboarding wizard previews then applies the shared starter plan', () => {
  assert.match(wizardSource, /api\.previewStarterPlan\(starterPlanPayload\(\)\)/);
  assert.match(wizardSource, /This preview comes from the shared setup API/);
  assert.match(wizardSource, /api\.applyStarterPlan\(starterPlanPayload\(\)\)/);
  assert.match(wizardSource, /await api\.completeOnboarding\(\)/);
  assert.match(wizardSource, /Starter setup was applied, but final onboarding completion is still waiting on a setup gate/);
});

test('onboarding wizard gates incompatible plans and preserves manual setup', () => {
  assert.match(wizardSource, /!starterPlan\.compatibility\.ok/);
  assert.match(wizardSource, /compatibility\.errors\.join/);
  assert.match(wizardSource, /Cannot apply yet/);
  assert.match(wizardSource, /selectedTemplateKeys\.length === 1 && selectedTemplateKeys\[0\] === 'blank'/);
  assert.match(wizardSource, /handleManualSetup/);
  assert.match(wizardSource, /api\.skipOnboarding\(\)/);
});

test('onboarding wizard renders API failure states for template, preview, and apply failures', () => {
  assert.match(wizardSource, /setTemplateError\(err instanceof Error \? err\.message : String\(err\)\)/);
  assert.match(wizardSource, /setAgentError\(message\)/);
  assert.match(wizardSource, /setAgentError\(err instanceof Error \? err\.message : String\(err\)\)/);
  assert.match(wizardSource, /templateError &&/);
  assert.match(wizardSource, /agentError &&/);
});

test('onboarding wizard does not automatically refetch templates after catalog failure', () => {
  assert.match(wizardSource, /templates\.length === 0 && !templatesLoading && !templateError/);
  assert.match(wizardSource, /onClick=\{\(\) => void loadStarterTemplates\(\)\}/);
});
