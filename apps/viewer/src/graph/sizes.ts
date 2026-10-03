/** Single source of truth for node boxes: the ELK layout reserves exactly these sizes. */
export const TRIGGER_SIZE = { width: 180, height: 44 } as const;
export const OUTCOME_SIZE = { width: 200, height: 56 } as const;
export const RUN_WIDTH = 240;
export const RUN_BASE_HEIGHT = 70;
export const RUN_SERVICE_HEIGHT = 22;
/** Vertical gap between stacked run trees. */
export const TREE_GAP = 40;

export const runHeight = (serviceCount: number): number => RUN_BASE_HEIGHT + RUN_SERVICE_HEIGHT * serviceCount;

/** Approx. characters of a run node's agent name that fit its fixed width. */
export const RUN_TITLE_MAX_CHARS = 18;

/** Keep the END of long text ("…81a3-01940c3ea271"); short text is unchanged. */
export function tailTruncate(text: string, maxChars: number): string {
  if (maxChars < 1 || text.length <= maxChars) return text;
  return `…${text.slice(text.length - (maxChars - 1))}`;
}
