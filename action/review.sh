#!/usr/bin/env bash
# Finds the migration files a pull request adds or changes, and reviews them offline
# (no database). Writes the report to the job summary and sets step outputs:
#   report = path of the Markdown file ("" if no file matched)
#   failed = true if --fail-on tripped
set -euo pipefail

cli="$GITHUB_ACTION_PATH/dist/cli/index.js"
report="$RUNNER_TEMP/pgvouch-review.md"

# One glob per line -> git pathspecs with "glob" magic (so ** works).
specs=()
while IFS= read -r pattern; do
  if [ -n "$pattern" ]; then specs+=(":(glob)$pattern"); fi
done <<< "$PATHS"
if [ ${#specs[@]} -eq 0 ]; then
  echo "::error::input 'paths' is empty"
  exit 1
fi

# The list goes to a file first: if git fails, set -e stops here. (Reading from
# "< <(git ...)" would hide the failure and look like "no files changed".)
list="$RUNNER_TEMP/pgvouch-files"
if [ -n "${BASE_SHA:-}" ]; then
  # Pull request: the default checkout is shallow, so fetch the base commit to diff with.
  git fetch --no-tags --quiet --depth=1 origin "$BASE_SHA" 2> /dev/null || true
  git diff -z --name-only --diff-filter=AMR "$BASE_SHA" HEAD -- "${specs[@]}" > "$list"
else
  # Not a pull request (e.g. a push): review every matching file.
  git ls-files -z -- "${specs[@]}" > "$list"
fi

# NUL-separated names, so any file name (spaces, newlines) arrives intact.
files=()
while IFS= read -r -d '' f; do files+=("$f"); done < "$list"

if [ ${#files[@]} -eq 0 ]; then
  echo "No migration files matched: $PATHS" | tee -a "$GITHUB_STEP_SUMMARY"
  echo "report=" >> "$GITHUB_OUTPUT"
  echo "failed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# "--" ends the options, so a file named like "--out=x" is still just a file.
status=0
node "$cli" review --format markdown --out "$report" ${FAIL_ON:+--fail-on "$FAIL_ON"} -- "${files[@]}" || status=$?

# No report means the CLI itself failed (bad input, crash): fail the step with that.
if [ ! -s "$report" ]; then exit "$((status == 0 ? 1 : status))"; fi

cat "$report" >> "$GITHUB_STEP_SUMMARY"
echo "report=$report" >> "$GITHUB_OUTPUT"
if [ "$status" -ne 0 ]; then echo "failed=true" >> "$GITHUB_OUTPUT"; else echo "failed=false" >> "$GITHUB_OUTPUT"; fi
