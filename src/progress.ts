import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Returns a function that sends one progress notification, or undefined if the client did not ask for progress.
 * Progress values only go up, as the spec requires, however many sources share the function.
 */
export function progressSender(extra: ToolExtra): ((message: string) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let progress = 0;
  return (message) => {
    progress++;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } })
      .catch(() => {
        // The client went away; the call itself will be cancelled.
      });
  };
}

/**
 * Sends a progress notification every `intervalMs` while `work` runs, if the client asked for progress.
 * Long advisor calls otherwise look hung, and some hosts reset their tool timeout on progress.
 */
export async function withProgress<T>(
  extra: ToolExtra,
  intervalMs: number,
  describe: (elapsedSec: number) => string,
  work: Promise<T>,
  send = progressSender(extra),
): Promise<T> {
  if (!send) return work;
  const started = Date.now();
  const timer = setInterval(() => send(describe(Math.round((Date.now() - started) / 1000))), intervalMs);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
