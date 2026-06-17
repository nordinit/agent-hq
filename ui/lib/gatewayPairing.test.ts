import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGatewayPairingGuide,
  explicitGatewayPairingCommand,
  gatewayPairingCommands,
  gatewayPairingLocation,
  isGatewayScopeReapprovalRequired,
} from './gatewayPairing.ts';

test('gateway pairing commands include latest and explicit approval forms with gateway url', () => {
  assert.deepEqual(gatewayPairingCommands(), [
    'openclaw devices list --url <gateway-url>',
    'openclaw devices approve --latest --url <gateway-url>',
  ]);
  assert.equal(explicitGatewayPairingCommand(), 'openclaw devices approve <requestId> --url <gateway-url>');
});

test('gateway pairing copy distinguishes local and remote command locations', () => {
  assert.equal(gatewayPairingLocation(false), 'on this machine');
  assert.equal(gatewayPairingLocation(true), 'in the environment that owns the gateway');
});

test('gateway pairing guide explains expanded scope re-approval', () => {
  const guide = buildGatewayPairingGuide(false, true);

  assert.match(guide.description, /previously approved/);
  assert.match(guide.description, /expanded Agent HQ scopes/);
  assert.match(guide.afterApproval, /Re-check Gateway/);
  assert.match(guide.afterApproval, /Check pairing/);
});

test('gateway scope re-approval detection checks status and pairing messages', () => {
  assert.equal(isGatewayScopeReapprovalRequired(null, 'pairing required: device is asking for more scopes than currently approved'), true);
  assert.equal(isGatewayScopeReapprovalRequired('PAIRING REQUIRED: MORE SCOPES THAN CURRENTLY APPROVED'), true);
  assert.equal(isGatewayScopeReapprovalRequired('pairing required: approve the device'), false);
});
