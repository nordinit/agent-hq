import { z } from 'zod';

const relativePath = z.string().min(1).max(500).refine(
  (value) => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').includes('..') && !/^[A-Za-z]:/.test(value),
  'Use a path inside the repository, relative to its root',
);
const timeoutSeconds = z.number().int().min(1).max(3600).default(600);
export const environmentSetupSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('auto'), roots: z.array(relativePath).min(1).max(20).default(['.']), timeoutSeconds }).strict(),
  z.object({
    mode: z.literal('custom'),
    steps: z.array(z.object({
      command: z.array(z.string().max(8000).refine(value => !value.includes('\0'), 'Command arguments cannot contain NUL')).min(1).max(100).refine(command => Boolean(command[0]?.trim()), 'An executable is required'),
      cwd: relativePath.default('.'),
    }).strict()).min(1).max(20),
    timeoutSeconds,
  }).strict(),
]);
export type EnvironmentSetup = z.infer<typeof environmentSetupSchema>;

export function normalizeEnvironmentSetup(value: unknown): EnvironmentSetup {
  try {
    return environmentSetupSchema.parse(value == null ? { mode: 'off' }
      : typeof value === 'string' ? JSON.parse(value) : value);
  } catch (error) {
    throw Object.assign(new Error(`Invalid environment_setup: ${error instanceof Error ? error.message : error}`), { status: 400 });
  }
}
