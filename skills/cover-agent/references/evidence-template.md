# Cover Agent Evidence Template

Use this as a compact structure when turning subagent findings into an Agent HQ note.

## Review evidence

- Cover role: <backend|frontend|fullstack|qa|pm>
- Task: #<id> <title>
- Verdict: <ready for review | QA fail | blocked | needs follow-up>
- Branch: <branch-name or missing>
- Commit: <full-sha or missing>
- Verified with:
  - `<command 1>`
  - `<command 2>`
- Findings:
  - <fact 1>
  - <fact 2>
- Risks / blockers:
  - <risk or blocker>

## Hard stop conditions

Do not write a clean review handoff if any of these are missing when required:

- branch name
- full commit SHA
- actual verification steps
- truthful verdict

In those cases, write a blocker note instead.
