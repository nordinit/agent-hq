# Tool Payload Checklist

Use this before calling the Agent HQ Tools API.

## Shape checks

- `input_schema` should be produced with `json.dumps(schema_object)` exactly once
- `tags` should be produced with `json.dumps(list_of_strings)` exactly once
- if reading a tool back from the API:
  - `json.loads(input_schema)` must yield an object
  - `json.loads(tags)` must yield a list

## Safety checks

- Narrow permissions to the least needed level
- Prefer atomic workflows over multi-step operator instructions
- Validate path inputs before filesystem or PM2 actions
- Add health checks for environment-switching tools
- Record enough state for rollback if the tool mutates runtime state

## Suggested verification snippet

```python
import json

json.loads(payload["input_schema"])
assert isinstance(json.loads(payload["input_schema"]), dict)
assert isinstance(json.loads(payload["tags"]), list)
```
