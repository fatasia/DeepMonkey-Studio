declare module "bacstack" {
  const Bacnet: new (options?: Record<string, unknown>) => any;
  export default Bacnet;
}

declare module "nodes7" {
  const NodeS7: new () => any;
  export default NodeS7;
}
