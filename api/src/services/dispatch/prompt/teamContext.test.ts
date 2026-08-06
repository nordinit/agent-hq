import { buildTeamContextSection, type TeamContextMember } from './teamContext';

function member(overrides: Partial<TeamContextMember> = {}): TeamContextMember {
  return {
    name: 'Nova',
    memberRole: 'Implementer',
    responsibilities: 'Writes and lands code changes',
    isSelf: false,
    isLead: false,
    ...overrides,
  };
}

describe('dispatch prompt team context builder', () => {
  it('renders goal, own role, teammates, charter and the handoff instruction', () => {
    expect(buildTeamContextSection({
      teamName: 'Delivery Squad',
      goal: 'Ship the billing migration with no customer-visible downtime.',
      charter: 'Every change lands behind a flag.',
      members: [
        member({ name: 'Nova', memberRole: 'Implementer', isSelf: true }),
        member({ name: 'Piper', memberRole: 'Planner', responsibilities: 'Breaks work into tasks', isLead: true }),
        member({ name: 'Casper', memberRole: 'Reviewer', responsibilities: 'Reviews diffs and gates on tests' }),
      ],
    })).toBe([
      '--- Team: Delivery Squad ---',
      'Goal: Ship the billing migration with no customer-visible downtime.',
      '',
      'You are Nova, Implementer on this team. Writes and lands code changes.',
      '',
      'Your teammates:',
      '- Piper — Planner (lead). Breaks work into tasks.',
      '- Casper — Reviewer. Reviews diffs and gates on tests.',
      '',
      'Working agreements:',
      'Every change lands behind a flag.',
      '',
      "Hand work to a teammate by recording the outcome that routes to them. Do not do a teammate's role yourself.",
      '--- End Team ---',
    ].join('\n'));
  });

  it('returns nothing when a lone member has no goal and no charter', () => {
    // Nothing here that the agent's own job_instructions do not already say, so the block would
    // be pure token cost.
    expect(buildTeamContextSection({
      teamName: 'Solo',
      goal: '',
      charter: '',
      members: [member({ isSelf: true })],
    })).toBe('');
  });

  it('still renders for a lone member when the team states a goal', () => {
    expect(buildTeamContextSection({
      teamName: 'Solo',
      goal: 'Keep the lights on.',
      charter: '',
      members: [member({ name: 'Nova', memberRole: 'Operator', responsibilities: '', isSelf: true })],
    })).toBe([
      '--- Team: Solo ---',
      'Goal: Keep the lights on.',
      '',
      'You are Nova, Operator on this team.',
      '--- End Team ---',
    ].join('\n'));
  });

  it('omits the handoff instruction when there are no teammates to hand off to', () => {
    const rendered = buildTeamContextSection({
      teamName: 'Solo',
      goal: 'Keep the lights on.',
      charter: '',
      members: [member({ isSelf: true })],
    });
    expect(rendered).not.toContain('Hand work to a teammate');
  });

  it('caps the roster and says how many were withheld', () => {
    const members = [member({ name: 'Nova', isSelf: true })];
    for (let i = 0; i < 30; i += 1) {
      members.push(member({ name: `Agent${i}`, memberRole: 'Contributor', responsibilities: '' }));
    }
    const rendered = buildTeamContextSection({ teamName: 'Big', goal: 'Ship it.', charter: '', members });

    expect(rendered).toContain('- Agent23 — Contributor');
    expect(rendered).not.toContain('- Agent24 — Contributor');
    expect(rendered).toContain('- (and 6 more members)');
  });

  it('truncates a long responsibilities blurb on a word boundary', () => {
    const rendered = buildTeamContextSection({
      teamName: 'Delivery Squad',
      goal: 'Ship it.',
      charter: '',
      members: [
        member({ name: 'Nova', isSelf: true, responsibilities: '' }),
        member({ name: 'Casper', memberRole: 'Reviewer', responsibilities: `${'word '.repeat(80)}end` }),
      ],
    });

    const line = rendered.split('\n').find((l) => l.startsWith('- Casper'));
    expect(line).toBeDefined();
    expect(line!).toContain('…');
    expect(line!.length).toBeLessThan(300);
    expect(line!).not.toContain('wor…');
  });

  it('renders members in the order given, so the block is byte-stable across dispatches', () => {
    const input = {
      teamName: 'Delivery Squad',
      goal: 'Ship it.',
      charter: '',
      members: [
        member({ name: 'Nova', isSelf: true }),
        member({ name: 'Piper' }),
        member({ name: 'Casper' }),
      ],
    };
    expect(buildTeamContextSection(input)).toBe(buildTeamContextSection(input));
    expect(buildTeamContextSection(input).indexOf('Piper'))
      .toBeLessThan(buildTeamContextSection(input).indexOf('Casper'));
  });

  it('handles a member with no role and no responsibilities', () => {
    expect(buildTeamContextSection({
      teamName: 'Delivery Squad',
      goal: 'Ship it.',
      charter: '',
      members: [
        member({ name: 'Nova', isSelf: true, memberRole: '', responsibilities: '' }),
        member({ name: 'Casper', memberRole: '', responsibilities: '' }),
      ],
    })).toBe([
      '--- Team: Delivery Squad ---',
      'Goal: Ship it.',
      '',
      'You are Nova on this team.',
      '',
      'Your teammates:',
      '- Casper',
      '',
      "Hand work to a teammate by recording the outcome that routes to them. Do not do a teammate's role yourself.",
      '--- End Team ---',
    ].join('\n'));
  });

  it('renders for an agent that is not itself a member', () => {
    // Defensive: resolveTeamContext() requires membership, but the renderer must not produce
    // "You are undefined" if that guarantee is ever relaxed.
    const rendered = buildTeamContextSection({
      teamName: 'Delivery Squad',
      goal: 'Ship it.',
      charter: '',
      members: [member({ name: 'Casper', memberRole: 'Reviewer' })],
    });
    expect(rendered).toContain('- Casper — Reviewer.');
    expect(rendered).not.toContain('You are');
  });
});
