# Filter metrics by task title

In Telemetry → Explorer, enter an optional **Task title regex** and select
**Ignore case in task titles** when needed. The pattern combines with the selected
project, workflow, task type, and any other population filter. Clearing the pattern
removes this extra filter. Preview and inspect contributing records before saving.

Examples (enter without JavaScript `/` delimiters):

- `^Lead:` — titles beginning with `Lead:`.
- `^(Lead|Proposal):` — either prefix.
- `client-[0-9]+` — this substring anywhere in the title.
- `^Review$` — exactly `Review`.

The condition is part of the saved metric definition, so revisions, pinned reports,
background queries, and exports keep it. Current measurements use the current title;
historical event and journey measurements use the recorded event or entry title.
Missing historical titles are disclosed as missing evidence, never replaced with a
current title.

The same condition is available through Advanced JSON, REST, and MCP:

```json
{"field":"title","op":"matches_regex","value":"^(Lead|Proposal):","flags":"i"}
```

Use it as `definition.population` for a saved metric or `filter` for an additional
query restriction. Combine conditions with `all` or negate one with `not`.
Other text fields also support this operator in Advanced JSON.

API and browser validation share [RE2JS](https://github.com/le0pard/re2js), a
non-backtracking regex engine. Supported flags are `i`, `m`, and `s`; lookaround,
backreferences, and stateful JavaScript flags such as `g` are rejected. Patterns are
limited to 512 characters and 4,096 compiled instructions. Invalid patterns fail
validation rather than silently selecting all records.
