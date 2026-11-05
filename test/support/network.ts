export type Handler = (request: Request) => Response | Promise<Response>;

/**
 * The bridge's whole network in a test: each host goes to a fake, and any other host fails the test, so
 * nothing reaches the real world by accident.
 */
export function network(hosts: Record<string, Handler>, elsewhere?: Handler): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // The fakes answer on https only, so anything sent in the clear shows up as going elsewhere.
    const handler = (url.protocol === "https:" ? hosts[url.host] : undefined) ?? elsewhere;
    if (!handler) throw new Error(`No fake for ${url.origin}`);
    return handler(request);
  };
}
