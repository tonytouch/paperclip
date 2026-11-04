-- TON-1115: the issue-scoped heartbeat_runs lookups (recovery service,
-- task-watchdog classifier, productiity-review scan) filter on
-- (company_id, context_snapshot->>'issueId'|'taskId') and then order by
-- (created_at DESC, id DESC) with a small LIMIT.
--
-- Without a composite index the planner walks the company's rows in
-- created_at order and evaluates the JSON filter as a row filter, which
-- detoasts context_snapshot for every candidate row. Measured on the live
-- instance: 43,387 buffer hits and 271 ms for a single-row lookup that
-- returns in 0.072 ms once the composite index exists. Under a wake storm
-- (several seats waking at once) that read storm saturates disk IO and
-- starves unrelated requests -- including the comment-write response path.
--
-- The composite index lets the planner satisfy the JSON predicate as an
-- index condition and returns rows already ordered by (created_at DESC,
-- id DESC), so the LIMIT stops after the first matching row.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_context_issue_id_created_at_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    ((context_snapshot ->> 'issueId'::text)),
    "created_at" DESC,
    "id" DESC
  );

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_context_task_id_created_at_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    ((context_snapshot ->> 'taskId'::text)),
    "created_at" DESC,
    "id" DESC
  );
