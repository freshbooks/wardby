-- Claude Code output tokens per model reply: the profile carries the agent's
-- setting, and each run records at dispatch the value it used. Null = the
-- worker default.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "maxOutputTokens" INTEGER;
ALTER TABLE "CodingRun" ADD COLUMN "maxOutputTokens" INTEGER;
