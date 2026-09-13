-- Repository access never implicitly grants permission to install dependencies.
-- Enable preparation explicitly on development workflows during rollout.
ALTER TABLE sprints ADD COLUMN environment_setup jsonb NOT NULL DEFAULT '{"mode":"off"}'::jsonb;
ALTER TABLE sprints ADD CONSTRAINT sprints_environment_setup_mode
  CHECK (jsonb_typeof(environment_setup) = 'object'
    AND environment_setup ? 'mode'
    AND jsonb_typeof(environment_setup->'mode') = 'string'
    AND environment_setup->>'mode' IN ('off', 'auto', 'custom'));
