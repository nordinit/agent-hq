import { containsSecretMetadata } from './provider-connections';

describe('provider connection metadata safety', () => {
  it('rejects credential values even when their key looks innocuous', () => {
    expect(containsSecretMetadata({ account_label: 'sk-ant-oat01-verysecretvalue' })).toBe(true);
    expect(containsSecretMetadata({ note: 'Authorization: Bearer bearer-secret' })).toBe(true);
    expect(containsSecretMetadata({ endpoint: 'postgres://agent:database-password@db/agent_hq' })).toBe(true);
  });

  it('allows opaque profile metadata and the credential owner label', () => {
    expect(containsSecretMetadata({
      credential_owner: 'claude-code',
      profile: '8d93ab41',
      account_label: 'Work profile',
    })).toBe(false);
  });
});
