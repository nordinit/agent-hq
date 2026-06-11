/**
 * Compatibility shim for the OpenClaw runtime package.
 *
 * Keep this public import path stable while the runtime internals move into
 * api/src/runtimes/openclaw/.
 */
export {
  GATEWAY_URL,
  GATEWAY_WS_URL,
  __resetGatewayConnectionPoolForTests,
  buildOpenClawGatewayConnectParams,
  gatewayFetch,
  gatewayGetHistory,
  gatewayRpcCall,
  gatewayWsPatchSession,
  gatewayWsSend,
  getGatewayAuthToken,
  getHooksToken,
  loadDeviceIdentity,
  readGatewayTokenFromConfig,
  readHooksTokenFromConfig,
  reloadOpenClawSecretsRuntimeForAuthSync,
} from './openclaw/gatewayClient';
export * from './openclaw';
