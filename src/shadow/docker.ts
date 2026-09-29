import { execFile, execFileSync } from "node:child_process";
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
  /** URL for a given user, reachable from this machine (127.0.0.1 + the mapped port). */
  urlFor(user: string, password: string): string;
  /** Superuser URL: used only to set up the shadow, never to run plan SQL. */
  superuserUrl: string;
  remove(): Promise<void>;
  /** Synchronous removal, for signal handlers (async work may not finish on Ctrl-C). */
  removeSync(): void;
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
    // Lets stray containers be found (docker ps --filter label=driftguard.shadow).
    "--label", "driftguard.shadow=1",
    "-e", `POSTGRES_PASSWORD=${password}`,
    // Bind to 127.0.0.1 only, on a port Docker picks (no clashes, not exposed on the network).
    "-p", "127.0.0.1::5432",
    // Resource limits: plan SQL runs in here, so a runaway statement can't starve the laptop.
    "--memory", "256m",
    "--cpus", "1",
    "--pids-limit", "256",
    // Lets the container reach databases on the host (needed on Linux; built into Docker Desktop).
    "--add-host", "host.docker.internal:host-gateway",
    image,
  ]);
  const mapping = await docker(["port", name, "5432/tcp"]); // e.g. "127.0.0.1:55012"
  const port = mapping.split("\n")[0]!.split(":").at(-1);
  const urlFor = (user: string, pw: string) =>
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@127.0.0.1:${port}/postgres`;
  return {
    name,
    urlFor,
    superuserUrl: urlFor("postgres", password),
    remove: async () => {
      await docker(["rm", "-f", name]).catch(() => undefined);
    },
    removeSync: () => {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
      } catch {
        // Best effort: the container was started with --rm and a label, so it can be found later.
      }
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
