import { parseJsonLines } from "./jsonl.js";

const MAX_UPDATE_CHARS = 200;

/** Collapses whitespace and shortens text to a single progress line. */
export function oneLine(text: string, max = MAX_UPDATE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Turns one line of a CLI's JSONL output into a progress line, if it is worth reporting.
 * Never throws: a malformed event must not break the run it came from.
 */
export function describeLine(describe: (event: Record<string, unknown>) => string | undefined, line: string): string | undefined {
  try {
    const [event] = parseJsonLines(line);
    const text = event ? describe(event)?.trim() : undefined;
    return text ? oneLine(text) : undefined;
  } catch {
    return undefined;
  }
}

/** `/bin/zsh -lc 'npm test'` → `npm test`: CLIs wrap every command in a login shell. */
export function unwrapShell(command: string): string {
  return /^\S*sh -lc '(.*)'$/s.exec(command)?.[1] ?? command;
}

/**
 * A timestamped progress log for the shell: each update as one line, plus a heartbeat whenever nothing has been
 * written for `heartbeatMs`, so a long quiet run still shows it is alive. Call stop() when the run ends.
 */
export function progressLog(write: (line: string) => void, heartbeat: string, heartbeatMs: number) {
  const started = Date.now();
  let last = started;
  const update = (text: string) => {
    last = Date.now();
    write(`[${Math.round((last - started) / 1000)}s] ${text}\n`);
  };
  const timer = setInterval(() => {
    if (Date.now() - last >= heartbeatMs) update(heartbeat);
  }, Math.max(1, Math.round(heartbeatMs / 3)));
  return { update, stop: () => clearInterval(timer) };
}
