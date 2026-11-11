import { automationProjectIds } from './automationScope';

describe('background automation project scope', () => {
  it('preserves existing unscoped behavior only when the variable is absent', () => {
    expect(automationProjectIds({})).toBeNull();
  });
  it('restricts scope to explicit projects and deduplicates IDs', () => {
    expect(automationProjectIds({ AGENT_HQ_AUTOMATION_PROJECT_IDS: '3, 99,3' })).toEqual([3, 99]);
  });
  it.each(['', ' ', '3,', '0', '-1', '3foo', '3;99', '3,NaN', '9007199254740992'])('fails closed for invalid scope %p', value => {
    expect(() => automationProjectIds({ AGENT_HQ_AUTOMATION_PROJECT_IDS: value })).toThrow('AGENT_HQ_AUTOMATION_PROJECT_IDS');
  });
});
