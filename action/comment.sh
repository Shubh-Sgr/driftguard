#!/usr/bin/env bash
# Posts the review as ONE pull request comment, and updates that comment on later
# pushes instead of adding new ones. Fork PRs get a read-only token: then it only
# warns, because the report is already in the job summary.
set -euo pipefail

marker='<!-- pgvouch-review -->'
api="repos/$GITHUB_REPOSITORY/issues"

# Our earlier comment: posted by a bot and starting with the marker. (Checking the
# author stops us from editing a human's comment that happens to contain the marker.)
existing=$(gh api --paginate "$api/$PR_NUMBER/comments" \
  --jq ".[] | select(.user.type == \"Bot\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1) || existing=""

if [ -n "$existing" ]; then
  if gh api --method PATCH "$api/comments/$existing" -F "body=@$REPORT" > /dev/null; then
    echo "Updated the PgVouch comment ($existing)."
    exit 0
  fi
elif gh api --method POST "$api/$PR_NUMBER/comments" -F "body=@$REPORT" > /dev/null; then
  echo "Posted the PgVouch comment."
  exit 0
fi
echo "::warning::PgVouch could not comment on this pull request (read-only token, e.g. a fork PR). The report is in the job summary."
