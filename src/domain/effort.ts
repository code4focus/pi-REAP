export const effortValues = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof effortValues)[number];
export type AutomaticEffort = Exclude<Effort, "max">;
