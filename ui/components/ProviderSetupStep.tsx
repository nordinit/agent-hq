'use client';

import ProviderConnectionsManager from '@/features/settings/ProviderConnectionsManager';

interface Props {
  onGatePassed: () => void;
  onBack: () => void;
}

export default function ProviderSetupStep({ onGatePassed, onBack }: Props) {
  return (
    <ProviderConnectionsManager
      mode="onboarding"
      onGatePassed={onGatePassed}
      onBack={onBack}
    />
  );
}
