/**
 * Manual Jest mock for @anthropic-ai/claude-agent-sdk.
 *
 * The real SDK ships as ESM (.mjs) which Jest cannot process with ts-jest
 * in CommonJS mode. This stub provides the same surface used by ClaudeCodeRuntime
 * so tests can run without spawning a real Claude Code process.
 *
 * Tests that need to control query() behaviour should do so via jest.mock().
 */

export const query = jest.fn().mockImplementation(async function* () {
  // Default: emit nothing — non-blocking by default
});
