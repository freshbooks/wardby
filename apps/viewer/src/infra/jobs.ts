import type { PodView } from "./adapter";

const HOUR_MS = 3_600_000;

/** Jobs that finished over an hour ago are hidden from both the Map and the Table. */
export function visibleJobs(
  jobs: PodView[],
  jobFinishedAt: ReadonlyMap<string, string | null> | undefined,
  now: number,
): PodView[] {
  return jobs.filter((p) => {
    const finished = jobFinishedAt?.get(p.title);
    return !finished || now - Date.parse(finished) <= HOUR_MS;
  });
}
