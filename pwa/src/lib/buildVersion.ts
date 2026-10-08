// The PWA's build stamp: the version from git ('1.0.<commit count>+<hash>') and the UTC time of
// the build, so Jonathan can tell on his phone whether a new build has loaded. Shared by
// vite.config.ts (which stamps __APP_VERSION__) and its test.

/** '<version> · YYYY-MM-DD HH:MMZ', the time in UTC. */
export function buildVersion(version: string, when: Date): string {
  return `${version} · ${when.toISOString().slice(0, 16).replace("T", " ")}Z`;
}
