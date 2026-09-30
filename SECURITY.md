# Security Policy

PgVouch connects to databases, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately with a [GitHub security advisory](https://github.com/Shubh-Sgr/pgvouch/security/advisories/new) (Security tab → "Report a vulnerability"). Include steps to reproduce and the version or commit.

## Supported versions

Only the latest release (and `main`) gets security fixes while PgVouch is 0.x.

You can expect an acknowledgement within a few days.

## Security model (what PgVouch promises)

- It connects through a read-only role, and every session also forces `default_transaction_read_only`, `statement_timeout` and `lock_timeout`.
- No MCP tool can write to your databases. Plans are returned as text for a human to review.
- Connection strings come only from the environment, never from tool input.
- No row data is sent to an LLM. Row values are returned over MCP only when explicitly requested.
- Shadow runs write only to a disposable container that PgVouch creates on `127.0.0.1` and removes afterwards. With an LLM configured, `plan_migration` starts one to prove a plan before accepting it.
- Plan SQL is untrusted inside the shadow: it runs as a non-superuser role (no server file access, no `COPY ... PROGRAM`), with a per-statement timeout it can't lift, in a container limited to 256 MB, 1 CPU and 256 processes.
- `preflight` / `check_lock_queue` never return other sessions' query text and never terminate sessions.
- The GitHub Action treats pull request content as untrusted: it runs offline (no database, no secrets needed), escapes file names and identifiers in its comment, and fences SQL so it can't break out. Use it with `on: pull_request`, never `pull_request_target`.

Anything that breaks one of these promises is a security bug.
