// Stable names for the generated API types (see generated.ts; do not edit that file).
import type { GraphSnapshot, RunDetail, ViewerEvent, InfraInfo } from "./generated";

export type { GraphSnapshot, RunDetail, ViewerEvent, InfraInfo };

export type GraphRun = GraphSnapshot["runs"][number];
export type Outcome = GraphRun["outcomes"][number];
export type ServiceStatus = GraphRun["services"][number];
export type RunTrigger = GraphRun["trigger"];
export type RunStatus = GraphRun["status"];
export type ServiceState = ServiceStatus["state"];
