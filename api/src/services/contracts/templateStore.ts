import fs from 'fs';
import path from 'path';
import { renderTemplate, type TemplateValue } from './templateRenderer';

export type ContractTemplateValues = Record<string, TemplateValue>;

export interface LoadedContractTemplate {
  content: string;
  path: string;
  inheritedFrom: string | null;
}

export function getAgentContractRoot(): string {
  return path.resolve(
    process.env.AGENT_CONTRACT_ROOT ?? path.join(__dirname, '../../../../agent-contracts'),
  );
}

export function normalizeContractTemplateKey(raw: string | null | undefined, fallback = 'generic'): string {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : fallback;
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

/**
 * Marker splitting a contract into its stable half and its per-run half.
 *
 * Everything before it is identical for every dispatch of a workflow type; everything after it
 * carries instance ids, session keys and the ready-to-paste lifecycle calls that embed them.
 * Emitting them as one block put ~3.5KB of unchanging procedure behind values that change every
 * single run, which is exactly the wrong side of a cache prefix.
 *
 * A template without the marker is not split — the whole thing stays a single trailing section,
 * which is what every template did before this existed.
 */
export const CONTRACT_RUN_IDENTIFIERS_MARKER = '<!-- AGENT_HQ_RUN_IDENTIFIERS -->';

export interface SplitContractTemplate {
  /** Stable procedure. Empty only if a template consists solely of run identifiers. */
  procedure: string;
  /** Per-run identifiers and examples, or '' when the template declares no split. */
  runIdentifiers: string;
}

/**
 * Split rendered contract text on the marker.
 *
 * Splits after rendering, not before, so a template author can put placeholders on either side
 * and the marker's position is the only thing that decides which half they land in.
 */
export function splitRenderedContract(rendered: string): SplitContractTemplate {
  const index = rendered.indexOf(CONTRACT_RUN_IDENTIFIERS_MARKER);
  if (index < 0) return { procedure: rendered, runIdentifiers: '' };
  return {
    procedure: rendered.slice(0, index).trimEnd(),
    runIdentifiers: rendered.slice(index + CONTRACT_RUN_IDENTIFIERS_MARKER.length).trim(),
  };
}

export function renderLoadedContractTemplate(template: LoadedContractTemplate, values: ContractTemplateValues): string {
  return renderTemplate(template.content, values);
}

