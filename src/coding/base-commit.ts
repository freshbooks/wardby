import { byteLength, MAX_CODING_TASK_BYTES } from "./protocol.js";

/**
 * The coding workspace has no git metadata, so the worker cannot learn which
 * commit it is looking at. The executor appends it to the task when it writes
 * the worker input (after cloning). Never grows a task past the limit.
 */
export function withBaseCommit(task: string, baseCommit: string): string {
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) return task;
  const withLine = `${task}\n\nBase commit: ${baseCommit} (the commit this workspace was checked out at; the workspace has no git metadata).`;
  return byteLength(withLine) <= MAX_CODING_TASK_BYTES ? withLine : task;
}
