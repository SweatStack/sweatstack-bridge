export type Handler = (request: Request) => Response | Promise<Response>;

/**
 * The bridge's whole network in a test: each host goes to a fake, and any other host fails the test, so
 * nothing reaches the real world by accident.
 */
export function network(hosts: Record<string, Handler>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const handler = hosts[new URL(request.url).host];
    if (!handler) throw new Error(`No fake for ${new URL(request.url).host}`);
    return handler(request);
  };
}
