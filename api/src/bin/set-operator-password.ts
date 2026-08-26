/**
 * Sets the operator password used by the MCP OAuth consent screen.
 *
 * Prompts by default so the password never lands in shell history. `--generate` prints a strong
 * one instead, which is the better option when the only thing that has to remember it is a
 * password manager.
 *
 * Usage:
 *   npx tsx src/bin/set-operator-password.ts
 *   npx tsx src/bin/set-operator-password.ts --generate
 *   npx tsx src/bin/set-operator-password.ts --clear
 */

import '../config/loadRootEnv';
import crypto from 'crypto';
import readline from 'readline';
import { closeDb, getDb } from '../db/client';
import {
  clearOperatorPassword,
  isOperatorPasswordSet,
  MIN_OPERATOR_PASSWORD_LENGTH,
  setOperatorPassword,
} from '../mcp/oauth/operatorPassword';

/** Reads a line without echoing it. Falls back to a plain read when stdin is not a TTY. */
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise((resolve) => {
      rl.on('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const asMutable = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (text: string) => void };
    let muted = false;
    asMutable._writeToOutput = (text: string) => {
      if (!muted) asMutable.output.write(text);
      else if (text.includes('\n')) asMutable.output.write('\n');
    };
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const db = getDb();

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: set-operator-password [--generate] [--clear]');
    return;
  }

  if (args.includes('--clear')) {
    await clearOperatorPassword(db);
    console.log('Operator password cleared. The MCP OAuth consent screen will refuse every request until one is set again.');
    return;
  }

  const already = await isOperatorPasswordSet(db);

  if (args.includes('--generate')) {
    const generated = crypto.randomBytes(24).toString('base64url');
    await setOperatorPassword(db, generated);
    console.log(`\nOperator password ${already ? 'replaced' : 'set'}. Store it now — it is not recoverable:\n\n  ${generated}\n`);
    return;
  }

  const first = await promptHidden(`${already ? 'New' : 'Set'} operator password: `);
  if (first.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_OPERATOR_PASSWORD_LENGTH} characters.`);
  }
  const second = await promptHidden('Confirm: ');
  if (first !== second) throw new Error('Passwords did not match.');

  await setOperatorPassword(db, first);
  console.log(`Operator password ${already ? 'replaced' : 'set'}.`);
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
