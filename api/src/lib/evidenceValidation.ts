/**
 * Evidence validation helpers for atomic task lifecycle writes.
 *
 * Provides strict validation for review, QA, and deploy evidence payloads
 * to ensure coherence, reject partial or blank submissions, and validate
 * field formats (SHA hashes, URLs, timestamps).
 */

import { INLINE_EVIDENCE_FIELD_KEYS } from './starterCatalog';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewEvidence {
  review_branch?: string | null;
  review_commit?: string | null;
  review_url?: string | null;
}

export interface QaEvidence {
  qa_verified_commit?: string | null;
  qa_tested_url?: string | null;
}

export interface DeployEvidence {
  merged_commit?: string | null;
  deployed_commit?: string | null;
  deploy_target?: string | null;
  deployed_at?: string | null;
}

export interface LiveVerificationEvidence {
  live_verified_by?: string | null;
  live_verified_at?: string | null;
  deployed_commit?: string | null;
}

export interface InlineEvidence extends ReviewEvidence, QaEvidence, DeployEvidence, LiveVerificationEvidence {
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface GateRequirement {
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
}

// ── Validators ───────────────────────────────────────────────────────────────

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const PLACEHOLDER_VALUES = new Set(['—', '-', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd', 'todo', 'pending']);

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidSha(value: unknown): boolean {
  return typeof value === 'string' && SHA_PATTERN.test(value.trim());
}

function isValidUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

function isValidIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholderValue(value: unknown): boolean {
  const normalized = normalizedString(value).toLowerCase();
  return normalized.length === 0 || PLACEHOLDER_VALUES.has(normalized);
}

function isMainlineBranch(branch: string | null | undefined): boolean {
  const normalized = normalizedString(branch).toLowerCase();
  return normalized === 'main' || normalized === 'master';
}

function isProductionLikeUrl(url: string | null | undefined): boolean {
  const normalized = normalizedString(url).toLowerCase();
  if (!normalized) return false;
  return normalized.includes('prod')
    || normalized.includes('production')
    || normalized.includes('app.')
    || normalized.includes('www.')
    || normalized.includes('://app.')
    || normalized.includes('://www.');
}

// ── Review evidence validation ───────────────────────────────────────────────

export function validateReviewEvidence(ev: ReviewEvidence): ValidationResult {
  const errors: string[] = [];
  const hasBranch = isNonEmpty(ev.review_branch);
  const hasCommit = isNonEmpty(ev.review_commit);
  const hasUrl = isNonEmpty(ev.review_url);

  // At minimum, branch and commit are required together
  if (!hasBranch && !hasCommit && !hasUrl) {
    errors.push('Review evidence requires at least review_branch and review_commit');
    return { valid: false, errors };
  }

  if (!hasBranch) {
    errors.push('review_branch is required when submitting review evidence');
  }
  if (!hasCommit) {
    errors.push('review_commit is required when submitting review evidence');
  }

  // Format validation
  if (hasCommit && !isValidSha(ev.review_commit)) {
    errors.push(`review_commit must be a valid git SHA (7-40 hex chars), got: "${ev.review_commit}"`);
  }

  return { valid: errors.length === 0, errors };
}

// ── QA evidence validation ───────────────────────────────────────────────────

export function validateQaEvidence(ev: QaEvidence, existingReviewCommit?: string | null): ValidationResult {
  const errors: string[] = [];
  const hasCommit = isNonEmpty(ev.qa_verified_commit);
  const hasUrl = isNonEmpty(ev.qa_tested_url);

  if (!hasCommit && !hasUrl) {
    errors.push('QA evidence requires at least qa_verified_commit');
    return { valid: false, errors };
  }

  if (!hasCommit) {
    errors.push('qa_verified_commit is required when submitting QA evidence');
  }

  // Format validation
  if (hasCommit && !isValidSha(ev.qa_verified_commit)) {
    errors.push(`qa_verified_commit must be a valid git SHA (7-40 hex chars), got: "${ev.qa_verified_commit}"`);
  }

  // Coherence: QA commit should match review commit when review commit is known
  if (hasCommit && isNonEmpty(existingReviewCommit)) {
    if (ev.qa_verified_commit!.trim() !== existingReviewCommit!.trim()) {
      errors.push(
        `qa_verified_commit ("${ev.qa_verified_commit}") does not match review_commit ("${existingReviewCommit}"). ` +
        `QA must verify the same commit that was reviewed.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Deploy evidence validation ───────────────────────────────────────────────

export function validateDeployEvidence(ev: DeployEvidence): ValidationResult {
  const errors: string[] = [];
  const hasMerged = isNonEmpty(ev.merged_commit);
  const hasDeployed = isNonEmpty(ev.deployed_commit);
  const hasTarget = isNonEmpty(ev.deploy_target);
  const hasTimestamp = isNonEmpty(ev.deployed_at);

  if (!hasMerged && !hasDeployed) {
    errors.push('Deploy evidence requires at least merged_commit or deployed_commit');
  }
  if (!hasTarget) {
    errors.push('deploy_target is required when submitting deploy evidence');
  }
  if (!hasTimestamp) {
    errors.push('deployed_at is required when submitting deploy evidence');
  }

  // Format validation
  if (hasMerged && !isValidSha(ev.merged_commit)) {
    errors.push(`merged_commit must be a valid git SHA (7-40 hex chars), got: "${ev.merged_commit}"`);
  }
  if (hasDeployed && !isValidSha(ev.deployed_commit)) {
    errors.push(`deployed_commit must be a valid git SHA (7-40 hex chars), got: "${ev.deployed_commit}"`);
  }
  if (hasTimestamp && !isValidIsoTimestamp(ev.deployed_at)) {
    errors.push(`deployed_at must be a valid ISO timestamp, got: "${ev.deployed_at}"`);
  }

  return { valid: errors.length === 0, errors };
}

// ── Config-driven inline evidence validation ─────────────────────────────────

/**
 * Validate inline evidence for a given outcome. Returns errors if the evidence
 * is insufficient or incoherent for the requested outcome.
 *
 * This is the main entry point for atomic outcome+evidence writes.
 * It checks that the caller has provided everything needed for the transition
 * in a single coherent payload.
 */
export function validateInlineEvidenceForOutcome(
  outcome: string,
  evidence: InlineEvidence,
  taskRecord: Record<string, unknown>,
  requirements?: GateRequirement[],
): ValidationResult {
  const errors: string[] = [];
  const effectiveRecord: Record<string, unknown> = { ...taskRecord };
  for (const [field, value] of Object.entries(evidence)) {
    if (value !== undefined) effectiveRecord[field] = value;
  }

  const blockingRequirements = (requirements ?? []).filter((requirement) => requirement.severity !== 'warn');
  const fieldsToValidate = new Set<string>();

  for (const requirement of blockingRequirements) {
    const fields = parseFieldExpression(requirement.field_name);
    for (const field of fields) fieldsToValidate.add(field);
    if (requirement.match_field) fieldsToValidate.add(requirement.match_field);

    let failed = false;
    if (requirement.requirement_type === 'required') {
      failed = fields.every(field => !isNonEmpty(effectiveRecord[field]));
    } else if (requirement.requirement_type === 'match') {
      const fieldValue = effectiveRecord[requirement.field_name];
      const matchValue = requirement.match_field ? effectiveRecord[requirement.match_field] : null;
      failed = !isNonEmpty(fieldValue) || !isNonEmpty(matchValue) || fieldValue.trim() !== matchValue.trim();
    } else if (requirement.requirement_type === 'from_status') {
      failed = !requirement.match_field || effectiveRecord[requirement.field_name] !== requirement.match_field;
    }

    if (failed) {
      errors.push(requirement.message || `${outcome} requires ${formatFieldExpression(requirement.field_name)}`);
    }
  }

  for (const [field, value] of Object.entries(evidence)) {
    if (isNonEmpty(value)) fieldsToValidate.add(field);
  }

  for (const field of fieldsToValidate) {
    validateEvidenceField(field, effectiveRecord[field], errors);
  }

  return { valid: errors.length === 0, errors };
}

function parseFieldExpression(fieldName: string): string[] {
  return fieldName
    .split('|')
    .map(field => field.trim())
    .filter(Boolean);
}

function formatFieldExpression(fieldName: string): string {
  return parseFieldExpression(fieldName).join(' or ') || fieldName;
}

function validateEvidenceField(fieldName: string, value: unknown, errors: string[]): void {
  if (!isNonEmpty(value)) return;

  if (isPlaceholderValue(value)) {
    errors.push(`${fieldName} cannot be a blank placeholder value`);
    return;
  }

  if (fieldName === 'review_branch' && isMainlineBranch(value)) {
    errors.push('review_branch must be a feature branch, not main/master');
    return;
  }

  if (fieldName.endsWith('_commit') && !isValidSha(value)) {
    errors.push(`${fieldName} must be a valid git SHA (7-40 hex chars), got: "${value}"`);
    return;
  }

  if (fieldName.endsWith('_url') && !isValidUrl(value)) {
    errors.push(`${fieldName} must be a valid URL`);
    return;
  }

  if ((fieldName === 'review_url' || fieldName === 'qa_tested_url') && isProductionLikeUrl(value)) {
    errors.push(`${fieldName} must reference a non-production artifact`);
    return;
  }

  if (fieldName.endsWith('_at') && !isValidIsoTimestamp(value)) {
    errors.push(`${fieldName} must be a valid ISO timestamp, got: "${value}"`);
  }
}

/**
 * Extract evidence fields from a request body, returning only the fields
 * that are explicitly provided (not undefined).
 */
export function extractInlineEvidence(body: Record<string, unknown>, allowedFields: Iterable<string> = INLINE_EVIDENCE_FIELD_KEYS): InlineEvidence {
  const result: InlineEvidence = {};
  for (const field of allowedFields) {
    if (field in body) {
      (result as Record<string, unknown>)[field] = body[field] as string | null;
    }
  }
  return result;
}

/**
 * Returns true if the evidence object has at least one non-empty field.
 */
export function hasAnyEvidence(ev: InlineEvidence): boolean {
  return Object.values(ev).some(v => isNonEmpty(v));
}
