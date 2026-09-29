# Security Policy

DriftGuard connects to databases, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately with a [GitHub security advisory](https://github.com/Shubh-Sgr/driftguard/security/advisories/new) (Security tab → "Report a vulnerability"). Include steps to reproduce and the version or commit.

You can expect an acknowledgement within a few days.

## Security model (what DriftGuard promises)

- It connects through a read-only role, and every session also forces `default_transaction_read_only`, `statement_timeout` and `lock_timeout`.
- No MCP tool can write to a database. Plans are returned as text for a human to review.
- Connection strings come only from the environment, never from tool input.
- No row data is sent to an LLM. Row values are returned over MCP only when explicitly requested.
- Shadow runs write only to a disposable container that DriftGuard creates on `127.0.0.1`.

Anything that breaks one of these promises is a security bug.
