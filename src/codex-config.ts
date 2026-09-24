import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";

export const CODEX_SERVER = "consult";
const TABLE = `mcp_servers.${CODEX_SERVER}`;

/** Where codex reads its config: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

// A whole-line table header such as `[a.b]`, `[a.'b c'] # note` or `[[a]]`. Array values like `["a", "b"],` end
// in a comma and never match; anything else this misreads is caught by the parse check in editConfig.
const TABLE_HEADER = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?\r?$/;
const TRIVIA = /^\s*(#.*)?\r?$/;

const normalize = (key: string) =>
  key
    .split(".")
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, "$2"))
    .join(".");

/** Removes `[name]` and its subtables from TOML text. Comments right above the next table stay with that table. */
export function removeTomlTable(text: string, name: string): string {
  const kept: string[] = [];
  let skipping = false;
  let trivia: string[] = [];
  for (const line of text.split("\n")) {
    const header = TABLE_HEADER.exec(line)?.[1];
    if (header !== undefined) {
      const key = normalize(header);
      const inside = key === name || key.startsWith(`${name}.`);
      if (skipping && !inside) kept.push(...trivia);
      skipping = inside;
      trivia = [];
    }
    if (!skipping) kept.push(line);
    else if (TRIVIA.test(line)) trivia.push(line);
    else trivia = [];
  }
  return kept.join("\n");
}

type Toml = Record<string, unknown>;

function parseConfig(text: string, path: string): Toml {
  try {
    return parse(text) as Toml;
  } catch (err) {
    throw new Error(`could not parse ${path}, so it was left unchanged: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Everything in the config except consult's own entry (an `mcp_servers` table left empty counts as absent). */
function withoutConsult(config: Toml): Toml {
  const { mcp_servers: servers, ...rest } = config;
  const { [CODEX_SERVER]: _removed, ...otherServers } = (servers as Toml | undefined) ?? {};
  return Object.keys(otherServers).length > 0 ? { ...rest, mcp_servers: otherServers } : rest;
}

const hasConsult = (config: Toml) => CODEX_SERVER in ((config.mcp_servers as Toml | undefined) ?? {});

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.consult-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Rewrites the config with consult's table removed and `block` (if any) appended. The result must parse, keep every
 * other setting exactly as it was, and contain consult only if `block` added it; otherwise nothing is written.
 * Returns whether consult was registered before.
 */
export function editConfig(path: string, block: string | undefined): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const before = parseConfig(current, path);
  const rest = removeTomlTable(current, TABLE).trimEnd();
  const next = block === undefined ? `${rest}\n` : `${rest ? `${rest}\n\n` : ""}${block}`;
  let after: Toml | undefined;
  try {
    after = parse(next) as Toml;
  } catch {
    // Reported below.
  }
  const safe =
    after !== undefined &&
    isDeepStrictEqual(withoutConsult(after), withoutConsult(before)) &&
    hasConsult(after) === (block !== undefined);
  if (!safe) {
    throw new Error(`could not safely edit ${path}; remove the ${TABLE} entry by hand and run this again`);
  }
  if (next !== current && !(block === undefined && !hasConsult(before))) writeAtomically(path, next);
  return hasConsult(before);
}
