import fs from 'fs';
import path from 'path';
import { renderTemplate, type TemplateValue } from './templateRenderer';

export type ContractTemplateValues = Record<string, TemplateValue>;

export interface LoadedContractTemplate {
  content: string;
  path: string;
  inheritedFrom: string | null;
}

const NAMED_CONTRACT_TEMPLATE_FALLBACKS: Record<string, string> = {
  completion: `---
## Agent HQ completion contract

When you have fully completed this non-task dispatch, report back through the Agent HQ MCP lifecycle tools available in your runtime.

Do not call Agent HQ lifecycle HTTP endpoints directly from this contract.
---`,
  'custom-agent-system': `You are a senior engineer dispatched by Agent HQ to execute a task.

Your workflow:
1. read the task description and acceptance criteria carefully
2. work on a feature branch named \`forge/task-{{taskId}}-<short-slug>\` when a task id is available
3. write clean, tested code and run relevant tests before declaring completion
4. report lifecycle progress, evidence, notes, and outcomes through the Agent HQ MCP/capability tools available in your runtime

Do not call Agent HQ lifecycle HTTP endpoints directly from this contract.`,
};

export function getAgentContractRoot(): string {
  return path.resolve(
    process.env.AGENT_CONTRACT_ROOT ?? path.join(__dirname, '../../../../agent-contracts'),
  );
}

export function normalizeContractTemplateKey(raw: string | null | undefined, fallback = 'generic'): string {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : fallback;
}

function assertSafeTemplateName(name: string): string {
  const normalized = normalizeContractTemplateKey(name, '').replace(/[^a-z0-9_-]/g, '-');
  if (!normalized) throw new Error('Contract template name is required');
  return normalized;
}

export function getSprintTypeContractPath(sprintTypeKey: string): string {
  return path.join(getAgentContractRoot(), `${normalizeContractTemplateKey(sprintTypeKey)}.md`);
}

export function writeSprintTypeContractTemplate(sprintTypeKey: string, content: string): string {
  const targetPath = getSprintTypeContractPath(sprintTypeKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf-8');
  return targetPath;
}

export function readSprintTypeContractTemplate(sprintTypeKey: string | null | undefined): LoadedContractTemplate {
  const normalizedSprintType = normalizeContractTemplateKey(sprintTypeKey);
  const directPath = getSprintTypeContractPath(normalizedSprintType);
  if (fs.existsSync(directPath)) {
    return { content: fs.readFileSync(directPath, 'utf-8'), path: directPath, inheritedFrom: null };
  }

  const genericPath = getSprintTypeContractPath('generic');
  if (normalizedSprintType !== 'generic' && fs.existsSync(genericPath)) {
    return {
      content: fs.readFileSync(genericPath, 'utf-8'),
      path: genericPath,
      inheritedFrom: 'generic',
    };
  }

  throw new Error(`No contract template found for sprint type "${normalizedSprintType}"`);
}

export function readNamedContractTemplate(templateName: string): LoadedContractTemplate {
  const normalizedName = assertSafeTemplateName(templateName);
  const templatePath = path.join(getAgentContractRoot(), `${normalizedName}.md`);
  if (!fs.existsSync(templatePath)) {
    const fallback = NAMED_CONTRACT_TEMPLATE_FALLBACKS[normalizedName];
    if (fallback !== undefined) {
      return { content: fallback, path: `builtin:${normalizedName}`, inheritedFrom: null };
    }
    throw new Error(`No contract template found for "${normalizedName}"`);
  }
  return { content: fs.readFileSync(templatePath, 'utf-8'), path: templatePath, inheritedFrom: null };
}

export function renderLoadedContractTemplate(template: LoadedContractTemplate, values: ContractTemplateValues): string {
  return renderTemplate(template.content, values);
}

export function renderNamedContractTemplate(templateName: string, values: ContractTemplateValues = {}): string {
  return renderLoadedContractTemplate(readNamedContractTemplate(templateName), values);
}
