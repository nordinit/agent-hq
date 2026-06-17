export interface GatewayPairingGuide {
  title: string;
  description: string;
  location: string;
  commands: string[];
  explicitCommand: string;
  afterApproval: string;
}

const SCOPE_REAPPROVAL_TEXT = 'more scopes than currently approved';

export function isGatewayScopeReapprovalRequired(...messages: Array<string | null | undefined>): boolean {
  return messages.some(message => (message ?? '').toLowerCase().includes(SCOPE_REAPPROVAL_TEXT));
}

export function gatewayPairingLocation(isRemoteGateway: boolean): string {
  return isRemoteGateway ? 'in the environment that owns the gateway' : 'on this machine';
}

export function gatewayPairingCommands(): string[] {
  return [
    'openclaw devices list --url <gateway-url>',
    'openclaw devices approve --latest --url <gateway-url>',
  ];
}

export function explicitGatewayPairingCommand(): string {
  return 'openclaw devices approve <requestId> --url <gateway-url>';
}

export function buildGatewayPairingGuide(isRemoteGateway: boolean, needsScopeReapproval: boolean): GatewayPairingGuide {
  return {
    title: 'Pair or approve this device',
    description: needsScopeReapproval
      ? 'This Agent HQ device was previously approved, but it now needs re-approval for expanded Agent HQ scopes.'
      : 'Approve this Agent HQ device before it can use the OpenClaw gateway.',
    location: gatewayPairingLocation(isRemoteGateway),
    commands: gatewayPairingCommands(),
    explicitCommand: explicitGatewayPairingCommand(),
    afterApproval: 'After approval, click Re-check Gateway or run Check pairing again.',
  };
}
