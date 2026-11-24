# Model Routing Guide

Model routing controls model and thinking level by story points and provider.

It should be treated as cost/quality policy, not as agent identity.

## Inputs

Before editing model routing, inspect:

- configured providers
- agent `preferred_provider` values
- available model IDs for those providers
- current story-point routing rules
- whether thinking levels are supported by the runtime/provider

Provider keys must match stored provider slugs exactly.

Examples of provider slugs:

- `anthropic`
- `openai-codex`
- `openai`
- `google`
- `ollama`
- `mlx-studio`
- `minimax`

Do not confuse display labels with provider keys. "OpenAI Codex (OAuth)" may display nicely, but the provider key used for routing is `openai-codex`.

## Provider Matching Rule

The dispatcher resolves story-point model routes by matching the agent's provider.

If an agent has:

```text
preferred_provider = openai-codex
```

then a model routing rule with:

```text
provider = openai
```

will not match that agent unless the resolver explicitly aliases those providers. Prefer correct provider slugs over relying on aliases.

This is important for thinking levels. A model string may still fall back from the agent config, but the route's thinking level will be lost if the story-point rule does not match.

## Story Point Buckets

Use the existing scale unless the team has a better policy:

- 1 point: trivial, typo, tiny config
- 2 points: small bug/tweak
- 3 points: medium feature or localized change
- 5 points: large or cross-cutting change
- 8 points: architectural/high-risk work

Suggested routing:

```text
<= 2: cheapest reliable model, low/medium thinking
<= 4: balanced model, medium/high thinking
<= 8: strongest model, high thinking
```

## Thinking Level Guidance

Use explicit thinking levels only when they improve reliability enough to justify cost/latency.

Typical defaults:

- trivial/small: `medium` or `low`
- medium: `high` when design/debugging is expected
- large/epic: `high`
- simple operational tasks: `off` or provider default when safe

Avoid setting thinking levels for providers/runtimes that ignore or reject them.

## When To Edit Model Routing

Edit model routing when:

- the team adds or removes providers
- agents move from one provider slug to another
- cost is too high for small tasks
- quality is too low for high-point tasks
- a new model becomes the preferred default
- thinking levels need explicit policy

Do not edit model routing to solve:

- bad prompts
- missing assignment rules
- bad task scoping
- unavailable provider auth

## Verification Checklist

After editing model routing:

1. Confirm providers are configured and connected.
2. Confirm each model-routing row uses a provider slug that exists.
3. Confirm agents' `preferred_provider` values match the intended rows.
4. Create or inspect a sample task with known story points.
5. Confirm the created `job_instances.effective_model` and `effective_thinking_level`.
6. Confirm runtime session logs show the intended model/thinking level where supported.

## Known Failure Pattern

Symptom:

```text
effective_model is set, but effective_thinking_level is blank
```

Likely cause:

```text
story-point route did not match provider; dispatcher fell back to agent.model
```

Example:

```text
agent preferred_provider = openai-codex
model route provider = openai
result: sp_model = null, thinking level not applied
```

Fix:

```text
Set the model route provider to openai-codex, or update the product so model routing providers are dynamically linked to configured provider slugs.
```
