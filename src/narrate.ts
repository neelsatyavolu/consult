const MAX_UPDATE_CHARS = 200;

/** Collapses whitespace and shortens text to a single progress line. */
export function oneLine(text: string, max = MAX_UPDATE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `/bin/zsh -lc 'npm test'` → `npm test`: CLIs wrap every command in a login shell. */
export function unwrapShell(command: string): string {
  return /^\S*sh -lc '(.*)'$/s.exec(command)?.[1] ?? command;
}
