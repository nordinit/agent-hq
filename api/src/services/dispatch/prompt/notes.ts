import { type Db } from "../../../db/adapter/types";

export interface DispatchTaskNoteRow {
  created_at: string;
  author: string;
  content: string;
}

export interface DispatchTaskNotesContext {
  firstRun: boolean;
  cutoff: string | null;
  totalNotes: number;
  includedNotes: DispatchTaskNoteRow[];
  truncated: boolean;
}

const DISPATCH_TASK_NOTES_CHAR_CAP = 12_000;

export function formatDispatchTaskNote(note: DispatchTaskNoteRow): string {
  const content = String(note.content ?? '')
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
  return `- [${note.created_at}] ${note.author}\n${content}`;
}

export async function getDispatchTaskNotesContext(
  db: Db,
  params: { taskId: number; agentId: number; currentInstanceId: number },
): Promise<DispatchTaskNotesContext> {
  const priorInstance = await db.get(`
    SELECT created_at
    FROM job_instances
    WHERE task_id = ?
      AND agent_id = ?
      AND id != ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `, params.taskId, params.agentId, params.currentInstanceId) as { created_at: string } | undefined;

  const firstRun = !priorInstance?.created_at;
  const cutoff = priorInstance?.created_at ?? null;

  const notes = (cutoff
    ? await db.all(`
        SELECT created_at, author, content
        FROM task_notes
        WHERE task_id = ?
          AND created_at >= ?
        ORDER BY datetime(created_at) ASC, id ASC
      `, params.taskId, cutoff)
    : await db.all(`
        SELECT created_at, author, content
        FROM task_notes
        WHERE task_id = ?
        ORDER BY datetime(created_at) ASC, id ASC
      `, params.taskId)) as DispatchTaskNoteRow[];

  let totalChars = 0;
  const selected: DispatchTaskNoteRow[] = [];
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const rendered = formatDispatchTaskNote(notes[i]);
    const renderedLen = rendered.length + 2;
    if (selected.length > 0 && totalChars + renderedLen > DISPATCH_TASK_NOTES_CHAR_CAP) break;
    selected.push(notes[i]);
    totalChars += renderedLen;
  }

  selected.reverse();

  return {
    firstRun,
    cutoff,
    totalNotes: notes.length,
    includedNotes: selected,
    truncated: selected.length < notes.length,
  };
}

export function buildDispatchTaskNotesSection(context: DispatchTaskNotesContext): string {
  if (context.totalNotes === 0) return '';

  const title = context.firstRun
    ? '## Existing Task Notes'
    : '## Task Notes Since Your Last Run';
  const lines: string[] = [title];

  if (context.truncated) {
    lines.push(
      `NOTE: Task notes were truncated to stay within the dispatch size cap. Showing ${context.includedNotes.length} of ${context.totalNotes} note(s), keeping the most recent notes in chronological order.`,
    );
  }

  lines.push(
    `[Dispatch note context: first_run=${context.firstRun ? 'yes' : 'no'} | notes_included=${context.includedNotes.length}/${context.totalNotes} | cutoff=${context.cutoff ?? 'none'}]`,
    '',
    ...context.includedNotes.map(formatDispatchTaskNote),
  );

  return lines.join('\n');
}
