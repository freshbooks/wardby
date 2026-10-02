-- Fixes for wardby_viewer_notify(): finishedAt formatting under a non-UTC
-- session TimeZone (the column is timestamp without time zone, already UTC),
-- and notification failures never fail the write. The triggers are unchanged.
CREATE OR REPLACE FUNCTION wardby_viewer_notify() RETURNS trigger LANGUAGE plpgsql AS $$
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
      'finishedAt', to_char(NEW."finishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
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
  -- A viewer event must never fail the write that caused it (e.g. a payload
  -- over NOTIFY's 8000-byte limit).
  BEGIN
    PERFORM pg_notify('wardby_viewer', payload::text);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
