import type { CampPlanMode } from "./campApi";
import type { MessageId } from "../../i18n/messages/en";

export function hasSharedBaseline(mode: CampPlanMode | undefined): boolean {
  return mode === "same_baseline_pair" || mode === "parallel_pair";
}

export function usesExecutionPool(mode: CampPlanMode | undefined): boolean {
  return mode === "parallel_pair" || mode === "bounded_dag";
}

export function planModeLabel(mode: CampPlanMode | undefined): MessageId {
  return mode === "bounded_dag" ? "camp.planMode.bounded_dag" : mode === "parallel_pair" ? "camp.planMode.parallel_pair"
    : mode === "same_baseline_pair" ? "camp.planMode.same_baseline_pair" : "camp.planMode.sequential";
}

export function planModeHelp(mode: CampPlanMode): MessageId {
  return mode === "bounded_dag" ? "camp.planMode.dagHelp" : mode === "parallel_pair" ? "camp.planMode.parallelHelp"
    : mode === "same_baseline_pair" ? "camp.planMode.pairHelp" : "camp.planMode.sequentialHelp";
}

export function planModePipeline(mode: CampPlanMode): MessageId {
  return mode === "bounded_dag" ? "camp.planMode.dagPipeline" : mode === "parallel_pair" ? "camp.planMode.parallelPipeline"
    : mode === "same_baseline_pair" ? "camp.planMode.pairPipeline" : "camp.pipeline";
}
