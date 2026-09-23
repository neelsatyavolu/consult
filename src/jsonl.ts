/** Parses newline-delimited JSON, skipping blank and non-JSON lines (CLIs sometimes mix in log text). */
export function parseJsonLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    try {
      return [JSON.parse(trimmed) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}
