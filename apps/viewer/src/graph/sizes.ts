import type { FlowNodeData } from "./build";
import { trayServices } from "./services";

/** Single source of truth for node boxes: the ELK layout reserves exactly these sizes. */
export const TRIGGER_SIZE = { width: 200, height: 44 } as const;
export const OUTCOME_SIZE = { width: 200, height: 56 } as const;
export const RUN_WIDTH = 240;
export const RUN_BASE_HEIGHT = 70;
/** The service tray under a run: services per row, row height, and its padding and border. */
export const TRAY_PER_ROW = 2;
export const TRAY_ROW_HEIGHT = 20;
export const TRAY_PAD = 9;
/** Vertical gap between stacked run trees. */
export const TREE_GAP = 40;

/** Height of the service tray pinned to a run node's bottom edge; 0 without services. */
export const trayHeight = (serviceCount: number): number =>
  serviceCount === 0 ? 0 : TRAY_PAD + TRAY_ROW_HEIGHT * Math.ceil(serviceCount / TRAY_PER_ROW);

export const runHeight = (serviceCount: number): number => RUN_BASE_HEIGHT + trayHeight(serviceCount);

/** Approx. title characters that fit a trigger or outcome node beside its "↗" button (icons count double). */
export const LINK_NODE_TITLE_MAX_CHARS = 18;

/** Approx. characters of a run node's agent name that fit its fixed width. */
export const RUN_TITLE_MAX_CHARS = 18;

/** Keep the END of long text ("…81a3-01940c3ea271"); short text is unchanged. */
export function tailTruncate(text: string, maxChars: number): string {
  if (maxChars < 1 || text.length <= maxChars) return text;
  return `…${text.slice(text.length - (maxChars - 1))}`;
}

/** Each node's fixed box; the canvas hands the same sizes to React Flow so it never has to measure. */
export function nodeSize(data: FlowNodeData): { width: number; height: number } {
  switch (data.kind) {
    case "trigger":
      return TRIGGER_SIZE;
    case "run":
      return { width: RUN_WIDTH, height: runHeight(trayServices(data.run).length) };
    case "outcome":
      return OUTCOME_SIZE;
  }
}
