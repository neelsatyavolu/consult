import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Sends a progress notification every `intervalMs` while `work` runs, if the client asked for progress.
 * Long advisor calls otherwise look hung, and some hosts reset their tool timeout on progress.
 */
export async function withProgress<T>(
  extra: ToolExtra,
  intervalMs: number,
  describe: (elapsedSec: number) => string,
  work: Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return work;
  const started = Date.now();
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const message = describe(Math.round((Date.now() - started) / 1000));
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress: tick, message } })
      .catch(() => {
        // The client went away; the call itself will be cancelled.
      });
  }, intervalMs);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
