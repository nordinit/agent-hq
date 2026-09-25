'use client';

import ProviderConnectionsManager from '@/features/settings/ProviderConnectionsManager';

export default function SettingsProvidersPage() {
  return (
    <div data-tour-target="settings-providers-main">
      <ProviderConnectionsManager mode="settings" />
    </div>
  );
}
