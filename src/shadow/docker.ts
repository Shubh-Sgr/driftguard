import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

// execFile (not exec): arguments go straight to the docker binary with no shell in
// between, so nothing in them can be interpreted as shell syntax.
async function docker(args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await exec("docker", args, {
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...opts.env },
  });
  return stdout.trim();
}

export interface ShadowContainer {
  name: string;
  /** Superuser URL of the throwaway database, reachable from this machine. */
  url: string;
  remove(): Promise<void>;
}

/**
 * Starts a disposable Postgres container on a random localhost port.
 * It has no volume, so removing it deletes everything in it.
 */
export async function startShadowContainer(image = "postgres:16-alpine"): Promise<ShadowContainer> {
  const name = `driftguard-shadow-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  await docker([
    "run", "-d", "--rm",
    "--name", name,
    "-e", `POSTGRES_PASSWORD=${password}`,
    // Bind to 127.0.0.1 only, on a port Docker picks (no clashes, not exposed on the network).
    "-p", "127.0.0.1::5432",
    // Lets the container reach databases on the host (needed on Linux; built into Docker Desktop).
    "--add-host", "host.docker.internal:host-gateway",
    image,
  ]);
  const mapping = await docker(["port", name, "5432/tcp"]); // e.g. "127.0.0.1:55012"
  const port = mapping.split("\n")[0]!.split(":").at(-1);
  return {
    name,
    url: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
    remove: async () => {
      await docker(["rm", "-f", name]).catch(() => undefined);
    },
  };
}

/**
 * Copies the schema (no data) of `sourceUrl` into the shadow database, using the
 * pg_dump/psql that ship inside the container, so no local Postgres tools are needed.
 * The URL is passed as an environment variable, not spliced into the shell command.
 */
export async function copySchemaInto(container: ShadowContainer, sourceUrl: string): Promise<void> {
  // Inside the container, "localhost" is the container itself; the host is host.docker.internal.
  const reachable = sourceUrl.replace(/@(localhost|127\.0\.0\.1)([:/])/, "@host.docker.internal$2");
  await docker(
    [
      "exec", "-e", "SRC_URL",
      container.name,
      "sh", "-c",
      'set -o pipefail; pg_dump --schema-only --no-owner --no-privileges "$SRC_URL" | psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres',
    ],
    { env: { SRC_URL: reachable }, timeoutMs: 300_000 },
  );
}
