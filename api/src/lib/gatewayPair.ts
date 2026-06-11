import { type GatewayProbeResult, probeGateway } from './gatewayHealth';
import type { GatewayRuntimeHint } from './gatewaySettings';

export interface GatewayPairResult extends GatewayProbeResult {
  auto_pair_supported: boolean;
  manual_required: boolean;
  pairing_approved: boolean;
  message: string | null;
}

function pairMessageForState(probe: GatewayProbeResult): string {
  const error = probe.error || '';
  const tokenMismatch = error.toLowerCase().includes('gateway token mismatch') || error.toLowerCase().includes('provide gateway auth token');
  switch (probe.state) {
    case 'ready':
      return 'Gateway is already paired and reachable.';
    case 'pairing_required':
      return 'Pairing is required before Agent HQ can use this gateway.';
    case 'auth_error':
      return tokenMismatch
        ? 'Gateway auth failed. If this gateway is running in WSL or another environment, paste that gateway auth token into Agent HQ, then try again.'
        : (probe.error || 'Gateway rejected the connection. Fix OpenClaw authentication, then try again.');
    case 'timeout':
    case 'offline':
    default:
      return probe.error || 'OpenClaw gateway is not reachable yet. Start it first, then pair Agent HQ.';
  }
}

function manualPairingMessage(runtimeHint: GatewayRuntimeHint): string {
  if (runtimeHint === 'wsl') {
    return 'Pairing is still required. Run `openclaw devices list`, then `openclaw devices approve <requestId>` inside WSL, then re-check the gateway.';
  }
  if (runtimeHint === 'external') {
    return 'Pairing is still required. Run `openclaw devices list`, then `openclaw devices approve <requestId>` in the environment that owns this gateway, then re-check it here.';
  }
  return 'Pairing is still required. Run `openclaw devices list`, then `openclaw devices approve <requestId>` on this machine, then re-check the gateway.';
}

function withPairingMetadata(
  probe: GatewayProbeResult,
  extras: Pick<GatewayPairResult, 'auto_pair_supported' | 'manual_required' | 'pairing_approved' | 'message'>,
): GatewayPairResult {
  return {
    ...probe,
    ...extras,
  };
}

export async function pairGateway(wsUrl: string, runtimeHint: GatewayRuntimeHint): Promise<GatewayPairResult> {
  const initialProbe = await probeGateway(wsUrl);
  const autoPairSupported = false;

  if (initialProbe.state === 'ready') {
    return withPairingMetadata(initialProbe, {
      auto_pair_supported: autoPairSupported,
      manual_required: false,
      pairing_approved: false,
      message: 'Gateway is already paired and reachable.',
    });
  }

  if (initialProbe.state !== 'pairing_required') {
    return withPairingMetadata(initialProbe, {
      auto_pair_supported: autoPairSupported,
      manual_required: false,
      pairing_approved: false,
      message: pairMessageForState(initialProbe),
    });
  }

  return withPairingMetadata(initialProbe, {
    auto_pair_supported: autoPairSupported,
    manual_required: true,
    pairing_approved: false,
    message: manualPairingMessage(runtimeHint),
  });
}
