export const effortValues = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof effortValues)[number];
export type AutomaticEffort = Exclude<Effort, "max">;

const effortRank: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

export function higherEffort(left: Effort, right: Effort): Effort {
  return effortRank[left] >= effortRank[right] ? left : right;
}

export function isAutomaticEffort(effort: Effort): effort is AutomaticEffort {
  return effort !== "max";
}
