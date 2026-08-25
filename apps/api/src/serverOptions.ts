import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

/**
 * The contracts accept path-safe IDs up to 128 characters. Keep the router
 * ceiling slightly higher so the route-level validator can return a stable 400
 * for an over-limit ID instead of Fastify rejecting it as an unroutable 414.
 */
export const API_ROUTER_OPTIONS: NonNullable<FastifyServerOptions["routerOptions"]> = {
  maxParamLength: 160
};

export function createApiServer(options: FastifyServerOptions = {}): FastifyInstance {
  return Fastify({
    ...options,
    routerOptions: { ...options.routerOptions, ...API_ROUTER_OPTIONS }
  });
}
