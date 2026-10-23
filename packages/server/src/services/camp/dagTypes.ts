import type { CampDagDelivery, CampDagInputResolution } from "../../../../camp-protocol/src/index.js";
export type DagInputResolution = CampDagInputResolution;
export type DagDelivery = CampDagDelivery;
export type DagNodeStatus = "waiting_dependencies" | "waiting_integration" | "ready" | "building" | "reviewing" | "waiting_question" | "approved" | "blocked";
export type DagApprovedProducer = import("./types").CampReviewedItem;
