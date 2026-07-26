import type { RoutingFeatures } from "../domain/routing-decision.js";

export interface FeatureInput {
  prompt: string;
  source?: string;
  streamingBehavior?: "steer" | "followUp" | string;
}

const matches = (text: string, expressions: readonly RegExp[]) => expressions.some((expression) => expression.test(text));

/** Extracts only bounded, non-textual policy signals. The prompt is never retained. */
export function extractFeatures(input: FeatureInput): RoutingFeatures {
  const text = input.prompt.trim().toLowerCase();
  return {
    hasText: text.length > 0,
    shortPrompt: text.length > 0 && text.length <= 80,
    streamingContinuation: input.streamingBehavior === "steer" || input.streamingBehavior === "followUp",
    continuationSignal: matches(text, [/\b(continue|go on|proceed|do that|fix it|retry|run it again|use the previous plan)\b/, /继续|接着|按刚才的|按上面的|执行这个方案|修掉它|重试|再检查|重新运行|就这样做/]),
    explicitNewTask: matches(text, [/\b(new question|new topic|switch topics)\b/, /新问题|换个话题/]),
    simpleQuestion: /[?？]$/.test(text) && text.split(/\s+/).length <= 18,
    boundedRead: matches(text, [/\b(read.?only|inspect|explain|summari[sz]e|what does|check this file)\b/, /只读|检查这个文件|解释|总结/]),
    codeChange: matches(text, [/\b(implement|fix|refactor|debug|write|modify|change)\b/, /实现|修复|重构|调试|修改|编写/]),
    testsRequested: matches(text, [/\b(test|tests|run.*test)\b/, /测试/]),
    longRunningGoal: matches(text, [/^\/goal(?:\s|$)/, /\b(long[ -]running|long[ -]term) goal\b/, /长程目标/]),
    multiStage: matches(text, [/\b(plan|then|after that|end.to.end|goal)\b/, /方案|然后|完成|目标/]),
    highRisk: matches(text, [/\b(migrat|concurren|consisten|permission|security|irreversible|race|adversarial|proof)\b/, /迁移|并发|一致性|权限|安全|不可逆|竞态|证明/]),
  };
}
