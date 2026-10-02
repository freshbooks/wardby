-- Live events for the admin viewer (docs/viewer-api.md): small pg_notify
-- payloads on channel wardby_viewer. Runs as the writing role; pg_notify
-- needs no grant. Payloads stay far below NOTIFY's 8000-byte limit.
CREATE FUNCTION wardby_viewer_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payload jsonb;
BEGIN
  IF TG_TABLE_NAME = 'Run' THEN
    IF TG_OP = 'UPDATE'
       AND NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND NEW."turns" IS NOT DISTINCT FROM OLD."turns"
       AND NEW."costUsd" IS NOT DISTINCT FROM OLD."costUsd"
       AND NEW."tokensIn" IS NOT DISTINCT FROM OLD."tokensIn"
       AND NEW."tokensOut" IS NOT DISTINCT FROM OLD."tokensOut"
       AND NEW."finishedAt" IS NOT DISTINCT FROM OLD."finishedAt"
       AND NEW."parentRunId" IS NOT DISTINCT FROM OLD."parentRunId" THEN
      RETURN NULL; -- heartbeat-only and other invisible updates
    END IF;
    payload := jsonb_build_object(
      'kind', 'run', 'runId', NEW."id", 'parentRunId', NEW."parentRunId", 'agentId', NEW."agentId",
      'status', NEW."status", 'turns', NEW."turns", 'tokensIn', NEW."tokensIn", 'tokensOut', NEW."tokensOut",
      'costUsd', NEW."costUsd"::float8,
      'finishedAt', to_char(NEW."finishedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  ELSIF TG_TABLE_NAME = 'CodingRunServiceStatus' THEN
    payload := jsonb_build_object(
      'kind', 'service', 'runId', NEW."runId", 'name', NEW."name", 'state', NEW."state", 'attempts', NEW."attempts");
  ELSIF TG_TABLE_NAME = 'IssuePullRequest' THEN
    payload := jsonb_build_object('kind', 'outcome', 'runId', NEW."openedByRunId", 'source', 'pull_request');
  ELSIF TG_TABLE_NAME = 'RunHostStatus' THEN
    payload := jsonb_build_object('kind', 'outcome', 'runId', NEW."runId", 'source', 'host_status');
  ELSIF TG_TABLE_NAME = 'RunIssueStatus' THEN
    payload := jsonb_build_object('kind', 'outcome', 'runId', NEW."runId", 'source', 'issue_status');
  ELSIF TG_TABLE_NAME = 'RunHostCheck' THEN
    payload := jsonb_build_object('kind', 'outcome', 'runId', NEW."runId", 'source', 'host_check');
  ELSE
    RETURN NULL;
  END IF;
  PERFORM pg_notify('wardby_viewer', payload::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Run_viewer_notify" AFTER INSERT OR UPDATE ON "Run"
  FOR EACH ROW EXECUTE FUNCTION wardby_viewer_notify();
CREATE TRIGGER "CodingRunServiceStatus_viewer_notify" AFTER INSERT OR UPDATE ON "CodingRunServiceStatus"
  FOR EACH ROW EXECUTE FUNCTION wardby_viewer_notify();
CREATE TRIGGER "IssuePullRequest_viewer_notify" AFTER INSERT OR UPDATE ON "IssuePullRequest"
  FOR EACH ROW EXECUTE FUNCTION wardby_viewer_notify();
CREATE TRIGGER "RunHostStatus_viewer_notify" AFTER INSERT OR UPDATE ON "RunHostStatus"
  FOR EACH ROW EXECUTE FUNCTION wardby_viewer_notify();
CREATE TRIGGER "RunIssueStatus_viewer_notify" AFTER INSERT OR UPDATE ON "RunIssueStatus"
  FOR EACH ROW EXECUTE FUNCTION wardby_viewer_notify();
CREATE TRIGGER "RunHostCheck_viewer_notify" AFTER INSERT OR UPDATE ON "RunHostCheck"
  FOR EACH ROW EXECUTE FUNCTION wardby_viewer_notify();
