# Pi Reasoning Admission Policy

## Cache-aware、Pre-turn、可评测的推理档位控制扩展设计

**状态：** 1.0 设计冻结候选
**工作名称：** `pi-effort-router`
**主要目标模型：** `gpt-5.6-sol`
**主要接入路径：** `openai-codex-responses`
**兼容基线：** `earendil-works/pi` `v0.82.1` 后的 `cee5ff7520d8828bed9955ef00419e995d1f91e0`。

---

# 1. 定位

本扩展不是让模型自行决定“要不要思考”，而是：

> 位于 Pi provider request 边界上的、保守、可解释、可回退、可评测的 reasoning-effort admission policy。

它在主模型第一次请求发出前完成任务分类，并仅修改最终 provider payload 中的 `reasoning.effort`。

扩展不向模型暴露分类提示或档位切换工具，不改变 system prompt、工具表、消息历史或缓存 key，也不修改 Pi 的全局设置。

---

# 2. 目标与非目标

## 2.1 目标

1. 简单任务不再先支付一次 `xhigh` 分类调用。
2. 在不显著降低成功率的前提下减少 reasoning tokens、总 tokens、延迟和有效成本。
3. 保持 prompt prefix、工具定义和缓存标识稳定。
4. 在任务内部提供保守的单调升档。
5. 在任务完成后允许下一个独立任务重新从低档开始。
6. 所有路由决定均可重放、解释和评测。
7. 出现未知情况时保留 Pi 原始请求，不因扩展故障降低可靠性。

## 2.2 非目标

1. 不切换模型，不在 Sol、Terra、Luna 之间路由。
2. 不使用主模型或远程小模型进行分类。
3. 不在一个 task epoch 内自动降档。
4. 不实现基于 embedding 的话题漂移检测。
5. 不修改 OpenAI cache breakpoint、TTL 或 cache mode。
6. 不替代 Pi 自身的 thinking-level UI 和默认设置。
7. 不支持任意 provider 的通用 reasoning 参数。
8. 不依据 reasoning token 数量实时中断或重新发起同一请求。

---

# 3. 核心不变量

## I1. Pre-turn decision

首个 provider request 发出前必须已经确定当前 task epoch 的初始档位。

Pi 的 `before_agent_start` 事件发生在用户提交 prompt 后、agent loop 启动前，并提供展开后的原始 prompt；它是首版分类的主要入口。

## I2. Prompt invisibility

路由策略不得出现在：

* system prompt；
* user message；
* tool description；
* tool result；
* conversation history。

`before_agent_start` handler 只更新本地运行时状态，不返回 `systemPrompt`。

## I3. Request-local application

不得调用：

```ts
pi.setThinkingLevel(...)
```

推理档位只能通过 `before_provider_request` 返回替换后的 provider payload。Pi 会按扩展顺序串联这些返回值，因此本扩展必须只做局部、可组合的 payload 修改。

## I4. Cache surface preservation

除 `reasoning.effort` 外，以下字段必须保持不变：

* `instructions`
* `input`
* `tools`
* `tool_choice`
* `prompt_cache_key`
* `prompt_cache_options`
* `prompt_cache_retention`
* `reasoning.summary`
* `reasoning.context`
* encrypted reasoning items
* `previous_response_id`
* model、transport 和其他 provider 参数

OpenAI 的缓存命中要求精确的 prompt prefix，工具和图像也必须保持一致；GPT-5.6 还分别报告 `cached_tokens` 与 `cache_write_tokens`，cache write 按未缓存输入价格的 1.25 倍计费。

## I5. Epoch-local monotonicity

同一 task epoch 内：

```text
effective effort(t + 1) >= effective effort(t)
```

允许：

```text
low → medium → high → xhigh
```

禁止：

```text
xhigh → high
high  → medium
medium → low
```

任务 settled 后，新任务可以建立新 epoch，并重新选择更低档位。

## I6. Baseline-preserving failure

以下任一情况发生时，不修改请求：

* payload shape 未识别；
* 当前 provider/API 不受支持；
* model 不支持 reasoning；
* 目标档位无法映射；
* 分类器抛出异常；
* runtime 状态不完整；
* 配置无效；
* 与其他扩展发生不可判定冲突。

由于用户当前 Pi 默认是 `xhigh`，保留原始 payload 等价于回退到既有可靠基线。

## I7. Max is explicit

`max` 不得由自动分类器选择，只能由用户通过本地命令显式启用。

GPT-5.6 Sol 支持 `none/low/medium/high/xhigh/max`；官方建议基于代表性工作负载比较当前档位与更低一级，而不是默认对所有工作使用最高档。

---

# 4. 术语模型

## 4.1 Session

一个 Pi session，可以包含数百轮无关或相关任务。

Session 不是推理档位单调性的作用域。

## 4.2 Task epoch

一个具有连续目标的任务区间，例如：

* “检查这个仓库的架构”；
* “按刚才的方案实现”；
* 实现后的测试和失败修复；
* compaction 后的自动恢复；
* 用户要求继续完成尚未完成的目标。

Task epoch 是推理档位单调性的作用域。

## 4.3 Agent run

由一次用户输入触发、最终进入 `agent_settled` 的完整运行。

一个 task epoch 可以包含多个 agent run。

## 4.4 Provider request

agent run 内的一次模型请求。工具链任务通常包含多个 provider request。

## 4.5 Initial effort

epoch 创建时分类器选择的初始档位。

## 4.6 Escalation floor

运行过程中由失败、写操作或其他证据抬升的最低档位。

## 4.7 Effective effort

```ts
effectiveEffort = max(
  initialEffort,
  escalationFloor,
  inheritedFloor,
  manualOverrideFloor,
);
```

---

# 5. 总体架构

```text
User input
    │
    ▼
input hook
    └── capture source / streaming behavior
    │
    ▼
before_agent_start
    ├── determine new epoch or continuation
    ├── extract deterministic features
    ├── classify initial effort
    └── record RoutingDecision
    │
    ▼
before_provider_request
    ├── validate provider and payload
    ├── resolve effective effort
    ├── map effort to provider value
    ├── replace reasoning.effort only
    └── record RequestDecision
    │
    ▼
OpenAI / Codex provider
    │
    ▼
message_end / turn_end
    ├── collect usage
    ├── inspect stop reason
    └── correlate response with request
    │
    ▼
tool_call / tool_execution_end
    └── raise escalation floor when required
    │
    ▼
agent_settled
    ├── mark run settled
    └── make epoch eligible for retirement
```

Pi 当前提供：

* 输入来源和 streaming behavior；
* `before_agent_start` 的展开后 prompt；
* 可替换最终 payload 的 `before_provider_request`；
* 工具开始、完成和错误事件；
* 确认不存在后续自动 retry、compaction 或 continuation 的 `agent_settled`。

---

# 6. 模块划分

```text
src/
  index.ts

  config/
    schema.ts
    defaults.ts
    load.ts

  domain/
    effort.ts
    task-epoch.ts
    routing-decision.ts
    runtime-state.ts

  policy/
    feature-extractor.ts
    continuity.ts
    hard-floors.ts
    classifier.ts
    escalation.ts

  provider/
    support.ts
    effort-map.ts
    payload-guard.ts
    patch-reasoning.ts
    payload-fingerprint.ts

  runtime/
    lifecycle.ts
    request-correlation.ts
    commands.ts
    status.ts

  telemetry/
    events.ts
    jsonl-writer.ts
    redact.ts
    aggregate.ts

test/
  unit/
    classifier.test.ts
    continuity.test.ts
    escalation.test.ts
    payload-guard.test.ts
    patch-reasoning.test.ts

  property/
    monotonicity.test.ts
    payload-preservation.test.ts

  integration/
    extension-harness.ts
    lifecycle.test.ts
    shadow-mode.test.ts
    enforce-mode.test.ts
    resume.test.ts

  fixtures/
    openai-responses/
    openai-codex-responses/
    prompts/

eval/
  corpus/
    manifest.jsonl
    tasks/
  runner/
  graders/
  reports/
```

---

# 7. 核心类型

```ts
export type Effort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type AutomaticEffort = Exclude<Effort, "max">;

export type EpochStatus =
  | "active"
  | "settled"
  | "failed"
  | "retired";

export type TaskClass =
  | "simple_query"
  | "bounded_read"
  | "implementation"
  | "debugging"
  | "architecture"
  | "high_risk"
  | "continuation"
  | "unknown";
```

```ts
export interface TaskEpoch {
  id: string;
  createdAt: number;
  lastActivityAt: number;

  status: EpochStatus;
  taskClass: TaskClass;

  initialEffort: AutomaticEffort;
  inheritedFloor?: AutomaticEffort;
  escalationFloor?: AutomaticEffort;

  requestCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  providerErrorCount: number;

  lastPromptHash: string;
  decisionIds: string[];
}
```

```ts
export interface RoutingDecision {
  id: string;
  policyVersion: string;
  epochId: string;

  relation: "new" | "continuation" | "ambiguous";
  taskClass: TaskClass;

  selectedEffort: AutomaticEffort;
  effectiveFloor: Effort;

  confidence: "high" | "medium" | "low";
  reasons: ReasonCode[];

  features: RoutingFeatures;
  timestamp: number;
}
```

```ts
export interface SessionRuntime {
  mode: "shadow" | "enforce";

  currentEpoch?: TaskEpoch;
  previousEpoch?: EpochSummary;

  pendingInput?: PendingInput;
  pendingRequests: PendingRequest[];

  manualOverride?: {
    effort: Effort;
    scope: "session";
  };

  resumeGuard: boolean;
  sessionStartedAt: number;
}
```

`reasons` 使用固定枚举，不记录自由文本解释，以便稳定聚合：

```ts
export type ReasonCode =
  | "EXPLICIT_SIMPLE_QUERY"
  | "BOUNDED_READ_ONLY"
  | "CODE_CHANGE_REQUESTED"
  | "DEBUG_OR_FAILURE"
  | "MULTI_STAGE_TASK"
  | "HIGH_RISK_DOMAIN"
  | "CONTINUATION_REFERENCE"
  | "PREVIOUS_EPOCH_ACTIVE"
  | "PREVIOUS_EPOCH_FAILED"
  | "RESUMED_SESSION_AMBIGUOUS"
  | "AMBIGUOUS_DEFAULT_HIGH"
  | "MANUAL_OVERRIDE"
  | "TOOL_ERROR_ESCALATION"
  | "WRITE_TOOL_ESCALATION"
  | "PROVIDER_ERROR_ESCALATION";
```

---

# 8. 生命周期设计

## 8.1 `session_start`

职责：

1. 加载配置。
2. 创建内存态 `SessionRuntime`。
3. 注册本地命令。
4. 设置 UI status。
5. 根据启动原因设置 `resumeGuard`。

建议：

```ts
resumeGuard =
  event.reason === "resume" ||
  event.reason === "fork" ||
  event.reason === "reload" ||
  event.reason === "startup";
```

首版不持久化 epoch 状态。恢复已有 session 后：

* 明确独立的新任务：正常重新分类；
* “继续”“修掉它”等含混 continuation：直接进入 `xhigh`；
* 明确简单、独立的问题：允许建立新 epoch。

这避免为了重建历史任务状态而引入新的持久化协议。

## 8.2 `input`

只保存：

```ts
{
  text,
  source,
  streamingBehavior,
  receivedAt
}
```

不得：

* transform 输入；
* consume 输入；
* 添加标签；
  -修改 user text。

输入事件能区分 `interactive`、`rpc` 和 `extension`，以及 streaming 期间的 `steer` 或 `followUp`。

## 8.3 `before_agent_start`

执行以下顺序：

```text
1. Normalize prompt for feature extraction
2. Determine epoch relation
3. Retire previous epoch when appropriate
4. Create or continue epoch
5. Extract routing features
6. Apply hard floors
7. Run deterministic classifier
8. Produce RoutingDecision
9. Update UI status
10. Return undefined
```

这里不得修改 `event.systemPrompt`。

## 8.4 `before_provider_request`

执行：

```text
1. Read current ctx.model
2. Verify supported API/provider/model
3. Validate payload shape
4. Resolve effective effort
5. Resolve provider-specific effort
6. Produce shallow structural copy
7. Replace reasoning.effort only
8. Fingerprint preserved cache surfaces
9. Append pending request record
10. Return patched payload
```

Pi 的 OpenAI Responses 和 Codex Responses payload 都使用顶层 `reasoning.effort`；Pi 本身也将 thinking level 映射到该字段。

## 8.5 `tool_call`

首版只识别明确的运行时证据：

| 事件      | 新 floor |
| ------- | ------: |
| `edit`  |  `high` |
| `write` |  `high` |
| 其他工具    |   不自动升档 |

不因普通 `read`、`grep`、`find` 或 `ls` 升档。

`bash` 不一律升档，因为它既可能运行测试，也可能只是执行只读命令。首版依赖任务分类和执行结果，不解析任意 shell command 的语义。

## 8.6 `tool_execution_end`

```text
第一次 tool error:
    floor = max(current, high)

同一 epoch 第二次及以后 tool error:
    floor = xhigh
```

不通过错误字符串猜测具体错误类别。

## 8.7 `message_end`

当 message role 为 assistant 时记录：

* model、provider、API；
* stop reason；
* input/output tokens；
* reasoning tokens；
* cache read/write；
* Pi 计算的各项 cost；
* error message 是否存在。

Pi 的 `Usage` 已直接区分 `input`、`output`、`cacheRead`、`cacheWrite` 和可选的 `reasoning`，而 assistant message 携带完整 usage 和 stop reason。

升级规则：

```text
stopReason == "error":
    floor = xhigh

stopReason == "length":
    floor = xhigh

stopReason == "aborted":
    不自动升级
```

用户主动 abort 不应被解释为模型能力不足。

## 8.8 `session_compact`

```text
reason == "overflow" && willRetry:
    floor = xhigh
```

普通 threshold compaction 不自动改变档位。

## 8.9 `agent_settled`

执行：

```ts
epoch.status = epochFailed ? "failed" : "settled";
```

`agent_settled` 不是立即销毁 epoch，而是使其具备被下一条独立输入替换的资格。

---

# 9. Epoch 边界判定

## 9.1 明确 continuation

以下任一条件成立时继承当前或上一 epoch：

* 当前 epoch 尚未 settled；
* 输入是 streaming `steer` 或 `followUp`；
* 上一 run 失败；
* prompt 是短指代命令；
* prompt 明确引用此前方案、代码、错误或结果；
* prompt 要求重试、继续、修复、验证或执行此前计划。

首版 continuation 词表应同时覆盖中文和英文，例如：

```text
继续
接着
按刚才的
按上面的
执行这个方案
修掉它
重试
再检查
重新运行
就这样做

continue
go on
proceed
do that
fix it
retry
run it again
use the previous plan
```

短词表只提供正向 continuation 证据，不能单独证明新任务。

## 9.2 明确新任务

上一 epoch 已 settled，且以下条件之一成立：

* 用户明确说“新问题”“换个话题”；
* 输入是独立完整的问题；
* 输入是寒暄、感谢或结束语；
* 新输入包含新的、可独立解析的目标，且没有前向指代；
* 用户显式调用 `/effort auto` 后提出独立任务。

## 9.3 含混输入

上一 epoch 已 settled，但输入不能确定是否独立：

* 继承上一 epoch；
* 如果 session 是 resume/fork/reload 后的首次输入，则使用 `xhigh`；
* 不使用时间间隔单独判定新任务。

## 9.4 1.0 不实现时间衰减

时间只能作为未来的话题漂移辅助证据。

不得实现：

```text
空闲超过 N 分钟 → 自动降档
```

因为长时间编译、测试、人工检查或离开终端后继续任务，都可能跨越任意时间窗口。

---

# 10. 确定性分类策略

分类流程必须先应用 hard floor，再应用软规则。

## 10.1 Hard floor

### `xhigh`

任一条件成立：

* `/goal` 或等价的长程目标；
* 数据迁移、并发、一致性、权限、安全或不可逆操作；
* 大范围架构设计或跨子系统变更；
* 对抗性审阅、完备性证明或高风险决策；
* previous epoch failed；
* provider/agent 自动失败恢复；
* 同一 epoch 两次工具错误；
* resume 后的含混 continuation。

### `high`

任一条件成立：

* 实现、修复、重构或调试代码；
* 多文件修改；
* 要求运行测试并根据结果继续；
* 中等复杂度的工程设计；
* 范围或成功标准存在实质不确定性；
* 分类器无法在 `low` 与 `medium` 间高置信区分。

## 10.2 Soft classification

### `low`

必须同时满足：

* 任务独立；
* 单步回答；
* 不要求修改代码；
* 不要求调试；
* 不要求浏览多个来源；
* 不涉及高风险领域；
* 没有 continuation 信号；
* 分类置信度高。

典型任务：

* 一个术语是什么意思；
* 某段简短代码的局部解释；
* 简单命令说明；
* 明确的一步式事实或格式问题；
* 寒暄和感谢。

### `medium`

典型任务：

* 范围明确的只读代码检查；
* 单文件理解；
* 有限的资料比较；
* 普通总结；
* 局部、低风险的配置建议；
* 工具路径明确且无需反复试错。

### `high`

作为普通工程任务的默认档位。

### `xhigh`

用于高风险、高复杂度、失败恢复和长程任务。

## 10.3 不确定性语义

“拿不准就升档”定义为：

```text
low 与 medium 不确定 → medium
medium 与 high 不确定 → high
high 与 xhigh 不确定 → xhigh
```

不是所有未知任务都直接归为 `xhigh`。无风险但无法分类的普通任务默认 `high`。

---

# 11. Provider 适配

## 11.1 1.0 支持矩阵

| API                      | 状态                  |
| ------------------------ | ------------------- |
| `openai-codex-responses` | 必须支持                |
| `openai-responses`       | 必须支持                |
| `azure-openai-responses` | 暂不执行，记录 unsupported |
| `openai-completions`     | 不支持                 |
| 其他 API                   | 不支持                 |

首版优先覆盖用户实际使用的 ChatGPT/Codex provider path，避免为了形式上的通用性扩大 payload 兼容面。

## 11.2 Provider guard

```ts
function supportsEffortRouting(model: Model<any>): boolean {
  return (
    model.reasoning === true &&
    (
      model.api === "openai-codex-responses" ||
      model.api === "openai-responses"
    )
  );
}
```

## 11.3 Effort 映射

```ts
function resolveProviderEffort(
  model: Model<any>,
  desired: Effort,
): string | undefined {
  const mapped = model.thinkingLevelMap?.[desired];

  if (mapped === null) return undefined;
  return mapped ?? desired;
}
```

如果目标档位不受支持：

1. 在相同或更高档中寻找第一个受支持值；
2. 找不到则保持原始 payload；
3. 不向下寻找。

## 11.4 Payload patch

```ts
function patchReasoningEffort(
  payload: unknown,
  effort: string,
): unknown {
  if (!isRecord(payload)) return undefined;

  const reasoning = isRecord(payload.reasoning)
    ? payload.reasoning
    : {};

  return {
    ...payload,
    reasoning: {
      ...reasoning,
      effort,
    },
  };
}
```

这里的 `undefined` 表示“不执行 patch”，调用者返回原始 payload。

## 11.5 Payload preservation test

对每个 fixture：

```ts
const patched = patchReasoningEffort(original, "low");

expect(removeEffort(patched)).toStrictEqual(
  removeEffort(original),
);
```

再做 canonical hash：

```text
hash(original without reasoning.effort)
==
hash(patched without reasoning.effort)
```

这应作为 property test，而不仅是几个 snapshot。

---

# 12. 配置设计

## 12.1 文件位置

只读：

```text
~/.pi/agent/effort-router.json
<cwd>/.pi/effort-router.json
```

项目配置覆盖全局配置。

扩展绝不写入这两个文件，也不写 Pi 的 `settings.json`。

## 12.2 首版 schema

```json
{
  "enabled": true,
  "mode": "shadow",
  "ambiguousEffort": "high",
  "failureEffort": "xhigh",
  "telemetry": {
    "enabled": true,
    "includePromptText": false,
    "directory": ".pi/effort-router"
  },
  "ui": {
    "showStatus": true,
    "notifyOnEscalation": false
  }
}
```

不开放几十个规则阈值。首版策略应由版本化代码定义，而不是把核心语义外包给复杂配置。

## 12.3 配置优先级

```text
hard-coded safe defaults
< global config
< project config
< session-only command
```

任何无效配置都使扩展回退为 `shadow` 或 disabled，不得部分应用不可判定配置。

---

# 13. Session-only 命令

只注册 Pi command，不注册 LLM-callable tool。

```text
/effort status
/effort auto
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
/effort shadow
/effort enforce
```

Pi 提供本地 command 注册 API；command 不会被加入模型工具表。

## 13.1 Override 语义

```text
/effort low
```

设置 session-only floor，而不是上限：

```text
manualOverrideFloor = low
```

高风险规则仍可升到 `xhigh`。

```text
/effort max
```

设置 session-only `max` floor。

```text
/effort auto
```

清除 manual override。

不持久化到下一个 Pi process 或另一个 session。

## 13.2 Status

示例：

```text
effort:auto → high
epoch:12 active
reason:CODE_CHANGE_REQUESTED
mode:enforce
```

UI status 不进入 conversation。

---

# 14. Shadow 与 enforce

## 14.1 Shadow mode

完成所有分类、状态转移和遥测，但不修改 payload。

记录：

```json
{
  "recommendedEffort": "medium",
  "appliedEffort": "xhigh",
  "mode": "shadow"
}
```

Shadow mode 用来验证：

* 生命周期接入；
* epoch 划分；
* 路由分布；
* continuation 继承；
* provider payload 识别；
* usage 数据采集。

它不能证明低档质量足够。

## 14.2 Enforce mode

真正 patch `reasoning.effort`。

默认发布过程：

```text
开发测试 → shadow → conservative enforce → full 1.0
```

---

# 15. 遥测设计

## 15.1 存储

```text
.pi/effort-router/
  decisions.jsonl
  requests.jsonl
  epochs.jsonl
```

这是观察数据，不是 runtime authority。删除日志不得影响策略行为。

## 15.2 默认隐私

默认不记录：

* prompt 原文；
* system prompt；
  -工具参数；
  -工具输出；
  -模型回答；
  -文件内容。

只记录：

* SHA-256 hash；
  -长度；
  -特征位；
  -固定 reason codes；
  -usage；
  -档位；
  -时间和序号。

## 15.3 Decision record

```ts
interface DecisionRecord {
  schemaVersion: 1;
  policyVersion: string;

  sessionHash: string;
  epochId: string;
  decisionId: string;

  relation: "new" | "continuation" | "ambiguous";
  taskClass: TaskClass;

  recommendedEffort: Effort;
  appliedEffort: Effort;
  mode: "shadow" | "enforce";

  promptHash: string;
  promptChars: number;
  features: RoutingFeatures;
  reasons: ReasonCode[];

  timestamp: number;
}
```

## 15.4 Request record

```ts
interface RequestRecord {
  schemaVersion: 1;

  sessionHash: string;
  epochId: string;
  requestIndex: number;

  provider: string;
  api: string;
  model: string;

  originalEffort?: string;
  appliedEffort?: string;
  patchStatus:
    | "shadow"
    | "applied"
    | "unsupported"
    | "invalid_payload"
    | "mapping_failed"
    | "policy_failed";

  systemPromptHash?: string;
  toolsHash?: string;
  promptCacheKeyHash?: string;

  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;

  totalCost?: number;
  stopReason?: string;
  latencyMs?: number;
}
```

## 15.5 Correlation

Pi 当前 extension event 没有统一 provider request ID。首版假设一个 agent runtime 内模型请求顺序串行：

```text
before_provider_request → pending queue push
message_end assistant   → pending queue shift
```

如果队列出现：

* 两个并发未完成 request；
* assistant message 无 pending request；
* request 无终态 message；

记录 `correlation_error`，但不影响 agent 运行。

---

# 16. 缓存验证

只保持 prompt 不变还不足以直接证明不同 effort 会共享同一缓存分区，因此必须单独做 crossover benchmark。

## 16.1 固定条件

每组实验固定：

* model；
* provider；
* system prompt；
* tools；
* input；
* `prompt_cache_key`；
* cache mode；
* TTL；
* transport；
  -上下文历史。

只改变 `reasoning.effort`。

## 16.2 实验矩阵

```text
Group A
A1 high  cold
A2 high  warm
A3 low   crossover

Group B
B1 low   cold
B2 low   warm
B3 high  crossover

Group C
C1 xhigh cold
C2 xhigh warm
C3 medium crossover
```

记录：

* `cached_tokens`
* `cache_write_tokens`
* uncached input
* reasoning tokens
* total output
* latency
* total cost

## 16.3 判定

分别回答：

1. 同一 effort 的稳定命中是否成立；
2. effort 切换后是否仍读取相同 prefix；
3. effort 切换是否导致新 cache write；
4. 正反方向是否对称；
5. 节省的 reasoning/output 成本是否超过额外 cache write。

## 16.4 与 Pi 缓存实现解耦

当前 Pi 已生成 `prompt_cache_key`，并在 usage 中解析 OpenAI 的 cache read/write 数据。

路由扩展不得顺便重构 Pi 的 cache 参数。若当前 Pi 的字段与 GPT-5.6 最新显式缓存接口存在兼容问题，应作为单独的 upstream 或 companion change 处理，避免无法判断收益来自 effort routing 还是 caching 改动。

---

# 17. 测试设计

## 17.1 Unit tests

### Effort ordering

```ts
low < medium < high < xhigh < max
```

### Classification table

使用显式 fixture，而不是仅测试几个关键词：

```ts
{
  prompt: "这个函数返回什么？",
  expected: "low"
}

{
  prompt: "只读检查这个文件是否存在明显重复",
  expected: "medium"
}

{
  prompt: "实现这个功能并运行测试",
  expected: "high"
}

{
  prompt: "检查并发取消协议是否存在竞态",
  expected: "xhigh"
}
```

### Provider guard

覆盖：

* 两种支持 API；
* reasoning false；
* unsupported API；
* undefined model；
* unsupported level mapping。

### Patch preservation

验证除 `reasoning.effort` 外完全不变。

## 17.2 Property tests

### Monotonicity

随机生成事件序列：

```text
decision
tool call
tool success/error
provider success/error
compaction
continuation
```

断言同一 epoch 内 effort 从不下降。

### Epoch reset

断言：

```text
xhigh settled epoch
+ independent simple query
→ new low epoch
```

### Baseline preservation

随机生成未知 payload，断言扩展不会抛出异常，且返回原始 payload 或合法局部 patch。

## 17.3 Integration harness

原项目的测试方式是用一个简化的 `Map<string, Handler[]>` 模拟 Pi，并依赖大量 `any`；可以参考其 Vitest 结构，但不应复用这种低保真 mock 作为主要保证。

新 harness 应模拟：

* handler 注册顺序；
* handler 返回值串联；
* `ctx.model`；
* assistant usage；
* tool errors；
* session replacement；
* compaction retry；
* agent settled；
* message queue。

## 17.4 Negative tests

必须显式断言扩展：

```ts
expect(pi.registerTool).not.toHaveBeenCalled();
expect(pi.setThinkingLevel).not.toHaveBeenCalled();
expect(settingsFile).not.toHaveChanged();
expect(beforeAgentStartResult).toBeUndefined();
```

## 17.5 Final payload fixture tests

从真实 Pi 请求捕获经过脱敏的 payload fixture：

```text
openai-codex-responses:
  first-turn.json
  tool-continuation.json
  reasoning-replay.json
  compacted-session.json

openai-responses:
  first-turn.json
  tool-continuation.json
  reasoning-replay.json
```

每次升级 Pi 依赖时重放。

---

# 18. 质量评测

## 18.1 Oracle

不以“人工觉得应该是什么档位”作为最终 oracle。

定义：

> 在保持任务验收结果的前提下，能够使用的最低 effort。

## 18.2 任务集

首批语料应来自真实工作负载：

1. 简单术语和 API 问答；
2. 单文件只读理解；
3. 多文件代码检查；
4. 小范围实现；
5. 编译失败修复；
6. 测试失败后的继续调试；
7. `/goal` 长任务；
8. 架构设计；
9. 并发和一致性审阅；
10. “继续”“按刚才方案做”等 continuation；
11. completed complex task 后的独立简单问题；
12. resume session 后的含混输入。

## 18.3 分阶段执行

### Smoke corpus

```text
12 tasks
× 4 efforts
× 2 repetitions
```

用于排除明显路由错误。

### Calibration corpus

```text
约 30 个代表性任务
每个候选 effort 运行 3 次
```

对简单任务可以跳过明显不必要的 `xhigh` 重复，对高风险任务可以跳过 `low`。

### Regression corpus

固定一组代表性任务，比较：

```text
fixed xhigh
fixed high
policy shadow recommendation
policy enforce
```

每次 classifier 或 hard-floor 变更都重跑。

## 18.4 评价字段

```text
task success
critical failure
grader confidence
provider request count
tool round count
retry count
input tokens
output tokens
reasoning tokens
cache read tokens
cache write tokens
latency
total effective cost
```

## 18.5 核心指标

### Under-routing rate

实际档位低于可接受最低档位的比例。

### Quality regret

相对于固定 `xhigh` 的任务质量损失。

### Cost regret

相对于可通过的最低档位，多支付的成本。

### Cache write amplification

```text
policy cache writes - fixed baseline cache writes
```

### Request amplification

策略是否意外增加模型调用次数。

---

# 19. 1.0 验收门槛

## 19.1 强制门槛

1. 不注册 LLM tool。
2. 不修改 system prompt。
3. 不调用 `setThinkingLevel()`。
4. 不写 `settings.json`。
5. 除 `reasoning.effort` 外 payload preservation tests 全部通过。
6. 未识别 payload 时保留原请求。
7. 同一 epoch 内 property test 证明 effort 不下降。
8. settled 后独立任务可以建立低档 epoch。
9. `max` 只能通过 command 启用。
10. telemetry 不记录 prompt 原文，除非显式配置。

## 19.2 质量门槛

1. 高风险 corpus 中不得出现自动 `low` 或 `medium`。
2. 确定性 coding tasks 不得因路由产生新增稳定失败。
3. 与固定 `xhigh` 相比，回归 corpus 最多允许一个非关键任务发生偶发退化，并必须经过人工复核。
4. 所有 under-routing case 必须形成固定 regression fixture。

## 19.3 收益目标

这些是发布目标，不是未经数据证明的承诺：

* 简单任务 reasoning tokens 中位数显著下降；
* 总 provider request 数不增加；
* 缓存读取不出现系统性下降；
* 计入 cache write 后的总有效成本下降；
* 中短工具任务延迟下降；
* 高风险任务成功率保持基线。

---

# 20. 实施拆分

## PR 1：Repository skeleton 与 contract tests

交付：

* package skeleton；
* TypeScript、TypeBox、Vitest；
* domain types；
* typed extension harness；
* config loader；
* no-side-effect contract tests。

可以沿用原扩展的 pnpm、Vitest、rolldown、oxlint/oxfmt 和 Changesets 工具链，但删除唯一 runtime dependency `proper-lockfile`。原扩展当前构建和测试栈可作为打包参考。

验收：

```text
build / lint / typecheck / test 全通过
扩展不注册 tool
扩展不读写 settings.json
```

## PR 2：Provider patch layer

交付：

* API/model guard；
* effort mapping；
* payload guards；
* local patch；
* preservation property tests；
  -真实 fixture snapshots。

此 PR 不包含 classifier，测试中直接注入目标 effort。

验收：

```text
openai-codex-responses supported
openai-responses supported
unknown payload unchanged
only reasoning.effort differs
```

## PR 3：Epoch runtime 与 deterministic policy

交付：

* epoch state machine；
* continuation detection；
* hard floors；
* low/medium/high/xhigh classifier；
* resume guard；
* monotonic escalation；
* status command。

验收：

```text
complex settled → simple new task can become low
continuation inherits floor
tool errors escalate
resume ambiguity becomes xhigh
max never selected automatically
```

## PR 4：Telemetry 与 shadow mode

交付：

* JSONL schemas；
* redaction；
* request/response correlation；
* usage aggregation；
* shadow mode；
* `/effort status`。

验收：

```text
真实 session 可完整产生 decision/request/epoch records
日志删除不影响运行
prompt 默认不落盘
```

## PR 5：Evaluation harness

交付：

* corpus manifest；
* repeated-run runner；
* deterministic graders；
* human-review rubric；
* cache crossover benchmark；
* HTML 或 Markdown report generator。

验收：

```text
可比较 fixed-xhigh / fixed-high / policy
报告同时显示 cache read 和 cache write
报告按 task class 分层
```

## PR 6：Conservative enforcement

初始启用范围：

```text
高置信 simple_query → low
高置信 bounded_read → medium
implementation/debugging → high
high-risk/failure → xhigh
其他 → high
```

此阶段不启用复杂软规则。

验收：

* 强制门槛全部满足；
* cache crossover 实验完成；
* regression corpus 通过；
* under-routing case 已审查。

## PR 7：1.0 hardening

交付：

* Pi compatibility pin；
* upgrade fixture procedure；
* conflict diagnostics；
* documentation；
* release pipeline；
* rollback instructions。

---

# 21. 已知风险

## R1. 其他扩展覆盖 effort

`before_provider_request` handler 会串联执行。若本扩展之后还有另一个扩展修改 `reasoning.effort`，本扩展无法从现有 API 中观察最终发送值。

处置：

* 文档声明与其他 effort mutator 不兼容；
* benchmark 使用位于最后的 payload logger 验证；
* telemetry 记录 extension 自己应用的值，但不冒充最终 wire truth；
* 将“最终 payload observation hook”作为可能的 Pi upstream 建议。

## R2. Pi payload shape 演进

处置：

* pin Pi compatibility；
* 每次升级重放真实 payload fixture；
* unknown shape 保持原请求；
* provider adapter 与 classifier 分离。

## R3. Resume 后丢失 task state

处置：

* 不持久化未定义的 epoch authority；
  -首次含混 continuation 直接 `xhigh`；
  -明确新任务重新分类。

## R4. 关键词误分类

处置：

* hard floor 优先；
  -低档只允许高置信匹配；
  -不确定默认 `high`；
  -所有 under-routing 进入 regression corpus；
  -不让关键词规则决定 `max`。

## R5. Token 下降但成本上升

原因可能是 cache write 增加、额外轮次或失败重试。

处置：

-总成本必须包含 cache read/write；
-同时观察 provider requests；
-不以 reasoning tokens 单项作为成功标准。

## R6. 长 session 档位黏滞

处置：

* monotonicity 仅限 task epoch；
  -`agent_settled` 后独立任务建立新 epoch；
  -时间衰减留到后续版本。

---

# 22. 后续迭代边界

只有在 1.0 积累真实决策和 outcome 数据后，才考虑：

1. 基于话题漂移的 epoch retirement；
2. 时间窗口作为弱辅助证据；
3. 本地逻辑回归、GBDT 或极小分类器；
4. 自动学习关键词权重；
5. task phase 内更细粒度的档位策略；
6. Sol/Terra/Luna 联合路由；
7. 显式 cache breakpoint 协同；
8. reasoning context policy；
9. 用户个性化任务先验。

其中本地分类器只能在 hard floor 允许的区间内选择档位，并必须支持 abstain。它不能覆盖安全和失败升级规则。

---

# 23. 最终冻结的 1.0 形态

```text
deterministic pre-turn classifier
+ task-epoch continuity
+ epoch-local monotonic escalation
+ request-local reasoning.effort patch
+ baseline-preserving fallback
+ zero prompt/tool/settings mutation
+ cache read/write telemetry
+ shadow-first rollout
+ outcome-based evaluation
```

首版最关键的成功标准不是“分类器很聪明”，而是：

> 它只在证据充分时降低 effort，在证据不足、任务高风险或运行失败时恢复到可靠档位，并且能够证明实际节省没有被额外轮次、缓存写入或质量退化抵消。

