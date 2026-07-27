/**
 * Historical live-v3 artifact vocabulary. Runtime routing is profile-relative;
 * these labels remain only to decode immutable, observability-only receipts.
 */
export const effortValues = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof effortValues)[number];
export type AutomaticEffort = Exclude<Effort, "max">;
