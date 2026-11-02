-- Default file actions (2026-11-01). Agents whose owner already allowed some actions also get the two file actions
-- (read_document, deliver_file); both only touch the agent's own files. Agents with an empty list stay fully denied,
-- because that may be deliberate. Idempotent: lists that already contain both names, or that would pass the 64-item
-- limit, are left alone.
UPDATE "agent_policies"
SET "actions" = "actions" || ARRAY(SELECT "a" FROM unnest(ARRAY['read_document', 'deliver_file']) AS "a" WHERE NOT ("a" = ANY("actions"))),
    "updated_at" = now()
WHERE cardinality("actions") > 0
  AND cardinality("actions") <= 62
  AND NOT ("actions" @> ARRAY['read_document', 'deliver_file']);
