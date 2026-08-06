/**
 * Renders the team-awareness block injected into every team member's dispatch prompt.
 *
 * Pure and synchronous by design, exactly like its neighbours buildTaskMessage() and
 * buildDispatchMessage(): resolving which team speaks for a dispatch is a database question and
 * lives in domains/teams/context.ts, while turning a resolved team into prose lives here and is
 * covered by ordinary unit tests with no fixtures.
 *
 * BYTE STABILITY IS A REQUIREMENT, NOT A NICETY
 * This block is prepended to every dispatch for every member. Callers pass members already
 * ordered by (sort_order, id) and the renderer adds no clocks, counters or set iteration, so the
 * same team state renders the same bytes on every run. Anything that churned here would
 * invalidate the prompt prefix on every dispatch.
 */

/** Beyond this, a member roster stops being orientation and starts being a token tax. */
const MAX_RENDERED_MEMBERS = 24;

/** Long enough for "reviews diffs and gates on tests, risk and budget", short enough to stay cheap. */
const MAX_RESPONSIBILITIES_CHARS = 240;

export interface TeamContextMember {
  name: string;
  memberRole: string;
  responsibilities: string;
  isSelf: boolean;
  isLead: boolean;
}

export interface TeamContextInput {
  teamName: string;
  goal: string;
  charter: string;
  members: TeamContextMember[];
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  // Cut on a word boundary when one is close, so the tail does not read as a typo.
  const clipped = trimmed.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > max - 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** "Nova — Implementer (lead). Writes and lands code changes." with every part optional. */
function describeMember(member: TeamContextMember): string {
  const role = member.memberRole.trim();
  const lead = member.isLead ? ' (lead)' : '';
  const head = role ? `${member.name} — ${role}${lead}` : `${member.name}${lead}`;
  const responsibilities = truncate(member.responsibilities, MAX_RESPONSIBILITIES_CHARS);
  if (!responsibilities) return head;
  return `${head}. ${responsibilities.replace(/\.$/, '')}.`;
}

/**
 * buildTeamContextSection — the block an agent reads to know who it is working with.
 *
 * Returns '' when there is nothing worth saying: no goal, no charter, and no teammates other
 * than the agent itself. A team of one with no goal tells the agent nothing it does not already
 * know from its own job instructions, and an empty section would still cost tokens.
 */
export function buildTeamContextSection(team: TeamContextInput): string {
  const goal = team.goal.trim();
  const charter = team.charter.trim();
  const self = team.members.find((member) => member.isSelf);
  const teammates = team.members.filter((member) => !member.isSelf).slice(0, MAX_RENDERED_MEMBERS);
  const hiddenCount = team.members.filter((member) => !member.isSelf).length - teammates.length;

  if (!goal && !charter && teammates.length === 0) return '';

  const lines: string[] = [`--- Team: ${team.teamName} ---`];

  if (goal) lines.push(`Goal: ${goal}`);

  if (self) {
    lines.push('');
    const role = self.memberRole.trim();
    const responsibilities = truncate(self.responsibilities, MAX_RESPONSIBILITIES_CHARS);
    let line = role ? `You are ${self.name}, ${role} on this team.` : `You are ${self.name} on this team.`;
    if (responsibilities) line += ` ${responsibilities.replace(/\.$/, '')}.`;
    if (self.isLead) line += ' You lead this team.';
    lines.push(line);
  }

  if (teammates.length > 0) {
    lines.push('');
    lines.push('Your teammates:');
    for (const teammate of teammates) lines.push(`- ${describeMember(teammate)}`);
    if (hiddenCount > 0) lines.push(`- (and ${hiddenCount} more member${hiddenCount === 1 ? '' : 's'})`);
  }

  if (charter) {
    lines.push('');
    lines.push('Working agreements:');
    lines.push(charter);
  }

  if (teammates.length > 0) {
    lines.push('');
    lines.push(
      'Hand work to a teammate by recording the outcome that routes to them. Do not do a teammate\'s role yourself.',
    );
  }

  lines.push('--- End Team ---');
  return lines.join('\n');
}
