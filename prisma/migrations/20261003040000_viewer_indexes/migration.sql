-- Indexes for the admin viewer's queries (docs/viewer-api.md): the graph
-- window (runs started since a time, or still pending/running), the
-- ancestor/children walks, and the outcome lookup by run. Plain CREATE INDEX
-- briefly blocks writes to each table while it builds; on a large existing
-- deployment, apply this migration in a quiet period.
CREATE INDEX "Run_startedAt_idx" ON "Run"("startedAt");

CREATE INDEX "Run_status_idx" ON "Run"("status");

CREATE INDEX "Run_parentRunId_idx" ON "Run"("parentRunId");

CREATE INDEX "IssuePullRequest_openedByRunId_idx" ON "IssuePullRequest"("openedByRunId");
