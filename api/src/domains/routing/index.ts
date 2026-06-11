// Routing domain entrypoint.
// This centralizes routing-related imports before the underlying modules move.

export { default } from '../../routes/routing';
export { default as routingRouter } from '../../routes/routing';
export { default as dispatchRouter } from '../../routes/dispatch';
export { default as modelRoutingRouter } from '../../routes/model-routing';
export * from './admin';
export * from './config';
export * from './policy';
