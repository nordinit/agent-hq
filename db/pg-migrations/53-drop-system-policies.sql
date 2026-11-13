-- system_policies is a retired baseline table: no code reads or writes it. Its 15 production rows
-- (status-transition policies, last changed 2026-05-15) are in the pre-deploy backup.
DROP TABLE core.system_policies;
