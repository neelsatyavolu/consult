import { configDefaults, defineConfig } from "vitest/config";

// Live sessions and session messages need macOS or Linux (they stay off on Windows), so their tests don't run there.
const POSIX_ONLY = [
  "test/hooks-install.test.ts",
  "test/inbox.test.ts",
  "test/live-session.test.ts",
  "test/registry.test.ts",
  "test/scope.test.ts",
  "test/sessions-wire.test.ts",
];

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ...(process.platform === "win32" ? POSIX_ONLY : [])] },
});
