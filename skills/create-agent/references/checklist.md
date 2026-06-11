# Agent Creation Checklist

Follow top to bottom. Do not skip steps.

---

## Step 1 — Decide agent identity

Before writing any files, decide:
- **ID**: `<project>-<role>` (e.g., `agency-frontend`, `fortified-qa`)
- **Name**: Human display name + role (e.g., `Pixel (Frontend)`)
- **Role**: One-line role description (e.g., `Senior Frontend Engineer`)
- **Model**: Default `anthropic/claude-sonnet-4-6` unless reason to change
- **Timeout**: Default is 900s — override for roles that need longer runs:
  - QA agents → 3600s (tasks can take up to an hour)
  - Dev/Backend/Fullstack/Frontend agents → 3600s
  - DevOps/Harbor agents → 3600s
  - PM/Trader/Sales/Atlas → 900s (default is fine)
- **Project ID**: Which Agent HQ project this agent belongs to (get from `GET /api/v1/projects`)

⚠️ **Before finalizing the name:** call `GET /api/v1/agents` and check every existing agent name. All agents across all projects share a single name pool — no two agents should share the same first name. Pick a name not already in use anywhere in the system.

---

## Step 2 — Create directories

```bash
mkdir -p ~/.openclaw/workspace-<id>
mkdir -p ~/.openclaw/workspace-<id>/memory
mkdir -p ~/.openclaw/agents/<id>/agent
```

Then **copy Nova's auth-profiles.json** — this is mandatory or the agent will fail to authenticate on first dispatch:

```bash
cp ~/.openclaw/agents/nova/agent/auth-profiles.json \
   ~/.openclaw/agents/<id>/agent/auth-profiles.json
```

⚠️ An empty `agentDir` = auth failure on first run. Always copy this file.

---

## Step 3 — Write workspace files

Write all 9 files to `~/.openclaw/workspace-<id>/`. See `references/templates.md` for content templates for each file.

Required files:
- `SOUL.md` — persona, expertise, mandate, how-you-work, constraints
- `IDENTITY.md` — name, role, emoji, agent ID, project, session key
- `AGENTS.md` — operating manual: startup sequence, task workflow, API calls, **memory tiers, learning matrix**, escalation
- `USER.md` — who the client/stakeholder is and what they expect
- `TOOLS.md` — local notes: API URLs, SSH hosts, project IDs, any env-specific details
- `BOOTSTRAP.md` — startup checklist (read SOUL → IDENTITY → AGENTS → check queue → begin)
- `MEMORY.md` — long-term memory file (initialized with role-appropriate seed content)
- `LESSONS.md` — domain-specific gotchas and hard-won knowledge (seeded with role-specific template)

**The `memory/` directory is already created in Step 2. All 4 memory-tier files must be present at provisioning time:**
- `memory/` directory — for daily short-term logs (`memory/YYYY-MM-DD.md`)
- `MEMORY.md` — long-term distilled knowledge
- `LESSONS.md` — domain gotchas
- Memory section in `AGENTS.md` — tiers, write-it-down rule, startup read sequence

**AGENTS.md must include the full memory section:**
```markdown
## Memory

You wake up fresh each session. These files are your continuity — read them, update them.

**On session startup, always read:**
- `memory/YYYY-MM-DD.md` for today and yesterday (if they exist)
- `MEMORY.md` for long-term context

**Write it down — no mental notes:**
| Signal | Where it goes |
|---|---|
| Correction received | `AGENTS.md` (process rule) or `LESSONS.md` (domain gotcha) |
| Process mistake | `AGENTS.md` — so you don't repeat it |
| Project decision | `MEMORY.md` |
| Domain gotcha discovered | `LESSONS.md` |
| Today-only context | `memory/YYYY-MM-DD.md` |

**Memory tiers:**
- **Tier 1 — Session only:** intermediate reasoning — do not write down
- **Tier 2 — Short-term:** `memory/YYYY-MM-DD.md` — what you worked on, decisions, blockers
- **Tier 3 — Long-term:** `MEMORY.md` — patterns, project state, lessons across weeks
- **Tier 4 — Permanent:** `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `LESSONS.md`

**Weekly reflection:**
A reflection job runs Sunday and synthesizes recent memory into durable lessons. Promote recurring patterns immediately — don't wait for the weekly run.
```

⚠️ **Do NOT create a `HEARTBEAT.md`** unless Masiah explicitly requests it. Only Atlas (the main session) runs heartbeats — agent workspaces must not have one.

---

## Step 4 — Add to openclaw.json

Edit your OpenClaw config file (typically `$HOME/.openclaw/openclaw.json`), append to `agents.list`:

```json
{
  "id": "<id>",
  "name": "<id>",
  "workspace": "/absolute/path/to/.openclaw/workspace-<id>",
  "agentDir": "/absolute/path/to/.openclaw/agents/<id>/agent",
  "model": { "primary": "anthropic/claude-sonnet-4-6" }
}
```

Verify valid JSON before saving (run `python3 -m json.tool openclaw.json`).

---

## Step 5 — Register agent in Agent HQ

```bash
curl -s -X POST http://localhost:3501/api/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<Display Name>",
    "role": "<Role Description>",
    "session_key": "agent:<id>:main",
    "workspace_path": "/absolute/path/to/.openclaw/workspace-<id>",
    "repo_path": "<repo path if applicable — see note below>"
  }' | python3 -m json.tool
```

⚠️ **`workspace_path` is mandatory** — without it, identity docs won't appear in the UI.

⚠️ **`repo_path` should be set whenever applicable.** Use the primary repo the agent works in:
- Pred Mkt Trader agents → `~/pred_mkt_trader2`
- Fortified agents → `~/.openclaw/workspace-fortified-dev/fortified-backend`
- Agency agents → `~/agent-hq`
- Operator/trader roles with no code work (e.g. Rex) → omit `repo_path`
- Politicai / Apex AG agents → omit until projects are active again

Note the returned `id` — you'll need it for the job template.

---

## Step 6 — Create job template in Agent HQ

Use the **`create-job` skill** to build the `job_instructions` for the agent's role. Do not write job templates from scratch — the skill has role-specific templates (dev, QA, devops) with the correct git workflow, review evidence endpoints, and completion signaling already wired in.

Key points enforced by the create-job skill:
- Dispatcher-driven architecture (no queue scanning)
- Dev agents: `git push origin <branch>` before recording review evidence
- QA agents: `git fetch + checkout + verify HEAD matches review_commit`
- DevOps agents: explicit git merge/push/deploy steps + build check before push
- Review evidence via `PUT /tasks/:id/review-evidence` (NOT `PUT /tasks/:id`)

```bash
curl -s -X POST http://localhost:3501/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "title": "<Project> — <Role>",
    "agent_id": <atlas_agent_id>,
    "project_id": <project_id>,
    "dispatch_mode": "agentTurn",
    "enabled": 1,
    "timeout_seconds": 3600,
    "job_instructions": "<built from create-job skill template>"
  }' | python3 -m json.tool
```

Note the returned job `id` - used for task assignment and event triggers.

---

## Step 6b - Wire assignment rules

After the job template exists, insert assignment rule rows so the reconciler dispatches tasks to this agent.

**Pattern:** one row per task_type the agent handles at its lane.

```bash
# For a QA agent (handles review lane for all task types):
sqlite3 ~/agent-hq/agent-hq.db "
INSERT INTO task_routing_rules (project_id, task_type, status, job_id, priority, agent_id) VALUES
  (<project_id>, 'frontend',      'review', <job_id>, <priority>, <agent_db_id>),
  (<project_id>, 'backend',       'review', <job_id>, <priority>, <agent_db_id>),
  (<project_id>, 'fullstack',     'review', <job_id>, <priority>, <agent_db_id>),
  (<project_id>, 'ops',           'review', <job_id>, <priority>, <agent_db_id>),
  (<project_id>, 'adhoc',         'review', <job_id>, <priority>, <agent_db_id>),
  (<project_id>, 'pm_operational','review', <job_id>, <priority>, <agent_db_id>);
"

# For a dev/backend agent (handles ready lane for its task type):
sqlite3 ~/agent-hq/agent-hq.db "
INSERT INTO task_routing_rules (project_id, task_type, status, job_id, priority, agent_id) VALUES
  (<project_id>, 'backend', 'ready', <job_id>, <priority>, <agent_db_id>);
"
```

**Priority guidance:**
- Higher number = dispatched first when multiple agents can handle the same task
- For additional QA agents: use lower negative priorities (e.g. first QA=0, second=-10, third=-20) so the reconciler round-robins through available agents
- For additional dev agents: use lower priority than the primary (e.g. primary=120, secondary=100)

Also set `openclaw_agent_id` and `job_template_id` directly in the DB (they don't save via PUT endpoint):
```bash
sqlite3 ~/agent-hq/agent-hq.db \
  "UPDATE agents SET openclaw_agent_id='<id>', job_template_id=<N> WHERE id=<agent_db_id>"
```

Verify:
```bash
sqlite3 ~/agent-hq/agent-hq.db \
  "SELECT id, task_type, status, job_id, priority FROM task_routing_rules WHERE agent_id=<agent_db_id>"
```

---

## Step 7 — Restart the gateway

```bash
# Via Atlas (preferred):
gateway restart

# Or manually trigger SIGUSR1
```

Wait for the ping-back confirming restart. The new agent session (`agent:<id>:main`) won't exist until OpenClaw reloads the config.

---

## Step 8 — Verify

```bash
# 1. Docs visible in UI
curl -s http://localhost:3501/api/v1/agents/<atlas_id>/docs | python3 -c "
import json,sys
for d in json.load(sys.stdin):
    print(d['filename'], '→', 'OK' if d['exists'] else 'MISSING')
"

# 2. Check openclaw.json agent is present
python3 -c "
import json, os
d = json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))
ids = [a['id'] for a in d['agents']['list']]
print(ids)
"
```

All 7 core docs (SOUL, AGENTS, USER, IDENTITY, TOOLS, MEMORY, LESSONS) should show OK or be present on disk. HEARTBEAT.md is intentionally excluded from agent workspaces.

Also verify the memory system is properly scaffolded:
- `memory/` directory exists (created in Step 2)
- `MEMORY.md` has role-appropriate seed content (not empty)
- `LESSONS.md` has role-appropriate seed content (not empty)
- `AGENTS.md` contains the full memory section with tiers and write-it-down matrix (from Step 3)

---

## Step 9 — Create weekly reflection cron

Register a weekly reflection job in Agent HQ's internal scheduler so the agent synthesizes its memory once a week.

**Implementation:** Hook-based isolated session (NOT a persistent main session — memory leak risk at scale).

```bash
# Create a reflection job template for this agent
curl -s -X POST http://localhost:3501/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "title": "<Project> — <Name> Weekly Reflection",
    "agent_id": <atlas_agent_id>,
    "project_id": <project_id>,
    "schedule": "0 10 * * 0",
    "dispatch_mode": "agentTurn",
    "enabled": 1,
    "timeout_seconds": 900,
    "job_instructions": "You are <Name>. No task is assigned this session — this is your weekly memory synthesis run.\n\nSTARTUP:\n1. Read ~/.openclaw/workspace-<id>/SOUL.md\n2. Read ~/.openclaw/workspace-<id>/AGENTS.md\n\nMEMORY SYNTHESIS:\n1. Read all memory/*.md files from the past 7 days\n2. Find patterns: recurring issues, corrections, lessons\n3. Promote durable findings to MEMORY.md (append, do not overwrite)\n4. If you discovered a process rule, update AGENTS.md\n5. If you discovered a domain gotcha, update LESSONS.md\n6. Write a brief synthesis note to memory/YYYY-MM-DD.md\n\nWhen done, run: openclaw system event --text \"Reflection done: <Name>\" --mode now"
  }' | python3 -m json.tool
```

This job fires every Sunday at 10am (stagger times across agents to avoid simultaneous runs).

---

## Common Mistakes & Fixes

| Mistake | Symptom | Fix |
|---|---|---|
| Missing `workspace_path` in POST | "No identity documents found" in UI | `PUT /api/v1/agents/<id>` with `{"workspace_path": "..."}` |
| Forgot to restart gateway | Agent session doesn't exist | Run gateway restart |
| `agentDir` doesn't exist | Agent fails to initialize | `mkdir -p ~/.openclaw/agents/<id>/agent` |
| Only killed `next start`, not `next dev` | CSS/JS missing after rebuild | `pkill -f "next dev" && pkill -f "next-server"` then rebuild |
| Wrong `job_id` in task handoff | QA event trigger never fires | PUT task with correct `job_id` matching QA job template |
