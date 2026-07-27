你说得对。上一版仍然把 `low → medium → high → xhigh` 当成跨模型稳定存在的控制空间，只把 provider value 的映射做了抽象；这不够。**真正需要抽象的是整个推理能力阶梯，而不只是标签拼写。**

当前代码把档位集合、排序和大量策略 floor 固定在全局类型中。 即便 `thinkingLevelMap` 能把 `high` 映射为另一个字符串，它仍假设未来模型具有相同数量、相同次序和相同语义的档位。这个假设应删除。

# Pi-REAP v1 Profile 化修订规划

## 一、修订后的核心定位

Pi-REAP 不应直接决定：

```text
low / medium / high / xhigh / max
```

它应当决定：

```text
任务类别
continuation 关系
风险与失败证据
所需的相对推理能力约束
```

随后由当前模型的 reasoning profile 将这些约束解析为该模型实际支持的推理配置。

完整路径应为：

```text
Prompt
  ↓
Deterministic classification
  ↓
Admission demand + runtime evidence
  ↓
Reasoning profile resolution
  ↓
Profile-relative rung
  ↓
Provider wire value
```

因此必须严格分离三个对象：

```text
Policy semantics
Model capability profile
Provider payload encoding
```

---

# 二、删除全局 Effort 枚举的权威地位

当前全局定义：

```ts
type Effort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
```

不应再作为 runtime state、policy result 和 monotonicity 的共同权威。

它最多只能存在于某个具体 profile 中，例如：

```text
openai-codex / gpt-5.6-sol / profile revision N
```

未来模型可能出现：

```text
none
minimal
low
medium
high
xhigh
max
```

也可能只有：

```text
standard
deep
```

或者推理控制不再是离散标签，而是：

```text
token budget
time budget
latency tier
service tier
adaptive mode
```

因此核心 runtime 应使用不依赖档位名称的 profile rung。

建议基础类型：

```ts
type RungId = string;

interface ResolvedRung {
  profileId: string;
  rungId: RungId;
  ordinal: number;
}
```

单调性定义改为：

```text
同一 profile、同一 epoch 内：

ordinal(t + 1) >= ordinal(t)
```

而不是：

```text
low < medium < high < xhigh
```

---

# 三、Profile 模型

## 3.1 Capability Profile

Capability profile 只描述模型提供什么能力，不包含任务分类策略。

```ts
interface ReasoningCapabilityProfile {
  schemaVersion: 1;

  profileId: string;
  profileRevision: string;

  match: {
    provider: string;
    api: string;
    model: string;
    catalogRevision?: string;
  };

  rungs: readonly ReasoningRung[];

  automaticFloor: RungId;
  automaticCeiling: RungId;
  explicitCeiling?: RungId;

  baselineBehavior:
    | "preserve-request"
    | "known-profile-default";

  source: ProfileSource;
}
```

每个 rung：

```ts
interface ReasoningRung {
  id: RungId;
  ordinal: number;

  providerValue: unknown;

  automaticEligible: boolean;
  explicitOnly: boolean;

  aliases?: readonly string[];
}
```

例如 GPT 某版本可能定义：

```ts
rungs: [
  {
    id: "r0",
    ordinal: 0,
    providerValue: "low",
    automaticEligible: true,
    explicitOnly: false
  },
  {
    id: "r1",
    ordinal: 1,
    providerValue: "medium",
    automaticEligible: true,
    explicitOnly: false
  },
  {
    id: "r2",
    ordinal: 2,
    providerValue: "high",
    automaticEligible: true,
    explicitOnly: false
  },
  {
    id: "r3",
    ordinal: 3,
    providerValue: "xhigh",
    automaticEligible: true,
    explicitOnly: false
  },
  {
    id: "r4",
    ordinal: 4,
    providerValue: "max",
    automaticEligible: false,
    explicitOnly: true
  }
]
```

另一个模型可以只有两个 rung，而不需要伪造 `medium` 或 `xhigh`。

---

## 3.2 Admission Profile

模型具有多少档，和哪些任务应该使用哪一档，是两个不同问题。

因此还应独立定义 admission profile：

```ts
interface AdmissionProfile {
  schemaVersion: 1;

  profileId: string;
  capabilityProfileId: string;

  initial: {
    simpleQuery: RungSelector;
    boundedRead: RungSelector;
    implementation: RungSelector;
    debugging: RungSelector;
    architecture: RungSelector;
    highRisk: RungSelector;
    continuation: RungSelector;
    unknown: RungSelector;
  };

  evidence: {
    firstToolError: EscalationRule;
    repeatedToolError: EscalationRule;
    providerError: EscalationRule;
    lengthExhaustion: EscalationRule;
    overflowRetry: EscalationRule;
    failedContinuation: EscalationRule;
  };
}
```

这样，能力描述与产品策略不会耦合。

同一个 capability profile 可以搭配：

```text
conservative admission profile
cost-sensitive admission profile
evaluation profile
```

但 v1 只提供一个冻结的 conservative profile。

---

# 四、Profile-relative selector

策略不得引用具体 rung ID，更不能引用 `high` 或 `xhigh`。

应使用相对 selector：

```ts
type RungSelector =
  | { kind: "minimum" }
  | { kind: "automatic-ceiling" }
  | { kind: "ordinal"; value: number }
  | { kind: "quantile"; value: number }
  | { kind: "from-top"; offset: number }
  | { kind: "profile-anchor"; name: string };
```

更适合 v1 的是有限 selector：

```ts
type RungSelector =
  | { kind: "lowest-automatic" }
  | { kind: "next-above-lowest" }
  | { kind: "next-below-ceiling" }
  | { kind: "automatic-ceiling" }
  | { kind: "anchor"; name: AdmissionAnchor };
```

但仅使用位置表达仍有问题。

例如一个 profile 有五档，另一个只有两档：

```text
next-above-lowest
```

在两者中的能力含义未必相近。

因此推荐 profile 显式声明 semantic anchors：

```ts
interface ReasoningCapabilityProfile {
  // ...
  anchors: {
    economical: RungId;
    balanced: RungId;
    deliberate: RungId;
    exhaustive: RungId;
  };
}
```

并允许多个 anchor 指向同一 rung：

```text
只有两档的模型：

economical → r0
balanced   → r0
deliberate → r1
exhaustive → r1
```

这些 anchor 是 Pi-REAP 的稳定语义接口，而不是 provider 档位名称。

需要注意：

```text
anchor 不是对模型能力的客观绝对刻度
```

它只是经过 profile 作者和评测确认的 admission binding。

---

# 五、Profile-relative escalation

## 5.1 Tool error

Tool error 不应硬编码：

```text
第一次 → high
第二次 → xhigh
```

也不应笼统写成：

```text
第一次 → 下一个 rung
```

因为不同 profile 的相邻 rung 差距不同。

正确做法是由 admission profile 定义：

```ts
evidence: {
  firstToolError: {
    kind: "raise-to-anchor",
    anchor: "deliberate"
  },

  repeatedToolError: {
    kind: "raise-to-anchor",
    anchor: "exhaustive"
  }
}
```

对于当前 GPT profile，可以解析为：

```text
first tool error:
  raise to deliberate
  → 当前可能对应 high

repeated tool error:
  raise to exhaustive
  → 当前可能对应 xhigh
```

但这是该 profile 的结果，不是全局规则。

另一模型可能解析为：

```text
first tool error  → deep
repeated error    → deep
```

因为它只有一个可升级档位。

---

## 5.2 Provider error、length 和 overflow

同样不能直接写成 `xhigh`。

应定义为：

```ts
providerError: {
  kind: "raise-to-anchor",
  anchor: "exhaustive"
}
```

或：

```ts
lengthExhaustion: {
  kind: "raise-to-automatic-ceiling"
}
```

选择 anchor 还是 ceiling 应由冻结 admission profile 决定。

建议：

```text
普通执行失败证据
→ deliberate

强恢复证据
→ exhaustive

profile 无 exhaustive anchor
→ automatic ceiling
```

---

## 5.3 Failed continuation

`failureEffort` 配置字段也应删除或改型。

当前字符串形式：

```json
{
  "failureEffort": "xhigh"
}
```

仍然绑定某个 GPT 档位。

应改为：

```json
{
  "failureAdmission": {
    "anchor": "exhaustive"
  }
}
```

或者 v1 不开放该配置，直接由 admission profile 冻结。

更推荐后者，因为首版没有必要允许用户修改核心 failure semantics。

---

# 六、Profile resolution

## 6.1 Profile identity

Profile 必须绑定到足够具体的运行环境：

```ts
interface ProfileMatch {
  provider: string;
  api: string;
  model: string;

  modelCatalogRevision?: string;
  piVersion?: string;
  providerAdapterRevision?: string;
}
```

不能只按：

```text
api == openai-responses
```

因为同一 API 下的模型可能支持不同 reasoning surface。

---

## 6.2 Resolver 状态

```ts
type ProfileResolution =
  | {
      status: "resolved";
      capability: ReasoningCapabilityProfile;
      admission: AdmissionProfile;
    }
  | {
      status: "unknown-model";
    }
  | {
      status: "profile-revision-mismatch";
    }
  | {
      status: "unsupported-api";
    }
  | {
      status: "invalid-provider-metadata";
    };
```

任何未解析状态都必须：

```text
preserve baseline payload
```

不得根据全局 `low/high/xhigh` 猜测。

---

## 6.3 Profile 来源

Profile 来源按权威级别排序：

```text
1. repository-pinned exact profile
2. user-approved local profile
3. validated catalog-derived candidate
4. unknown → baseline preservation
```

v1 不应默认相信 provider catalog 中的字符串顺序。

例如：

```ts
thinkingLevelMap = {
  low: "foo",
  high: "bar"
}
```

只能说明映射存在，不能证明：

```text
foo < bar
```

profile 必须显式提供顺序及语义 anchor。

---

# 七、Profile 的演进与更新

## 7.1 不自动静默更新

模型或 Pi catalog 更新后，不得自动继承旧 profile。

Profile identity 应包含 digest：

```ts
interface ProfileBinding {
  profileId: string;
  profileRevision: string;
  profileDigest: string;

  modelCatalogDigest?: string;
  providerAdapterDigest?: string;
}
```

运行时 telemetry 必须记录：

```text
profileId
profileRevision
profileDigest
resolvedRungId
resolvedOrdinal
providerValue
```

这样未来模型更新不会让相同的：

```text
taskClass = implementation
```

在不可追踪的情况下改变实际推理行为。

---

## 7.2 Profile candidate workflow

当发现新模型或模型元数据变化时：

```text
discover
→ generate candidate profile
→ static validation
→ synthetic replay
→ representative evaluation
→ human approval
→ pin profile digest
```

Profile candidate 不具备 enforcement authority。

在获得批准前：

```text
shadow only
或 preserve baseline
```

---

## 7.3 Profile 兼容性

允许显式声明：

```ts
compatibleWith: [
  {
    modelPattern: "...",
    catalogDigest: "...",
    evidenceDigest: "..."
  }
]
```

但不要实现模糊的版本范围，例如：

```text
gpt-5.*
```

模型名称相似不代表 reasoning semantics 兼容。

---

# 八、Runtime 状态重构

当前 epoch 中的：

```ts
initialEffort
inheritedFloor
escalationFloor
manualOverride
```

都应换成 profile-relative rung。

```ts
interface TaskEpoch {
  profileBinding: ProfileBinding;

  initialRung: ResolvedRung;
  inheritedFloor?: ResolvedRung;
  escalationFloor?: ResolvedRung;

  highestAutomaticRungReached: ResolvedRung;
}
```

有效 rung：

```ts
effectiveRung = maxByOrdinal(
  initialRung,
  inheritedFloor,
  escalationFloor,
  manualOverrideFloor
);
```

比较前必须验证：

```text
所有 rung 属于同一 profile digest
```

若 session 中模型改变，不能继续直接比较 ordinal。

---

# 九、模型切换与 profile 切换

模型切换后 profile 也必然变化。

因此未来不能写：

```text
old xhigh → new high
```

因为两个标签没有可比较性。

正确边界为：

```text
旧模型 epoch 终止或冻结
→ 上层决定切换模型
→ 解析新模型 profile
→ 创建新的 execution attempt / epoch binding
→ 根据迁移策略选择新 profile anchor
```

跨模型迁移应使用 semantic anchor：

```text
旧 profile 已达到 exhaustive
→ 新 profile 从 deliberate 或 exhaustive 开始
```

而不是复制 provider value。

这属于未来 Salp flow 的模型升级协议，不纳入当前 v1 自动执行。

---

# 十、配置面修订

当前这些字段应删除：

```json
{
  "ambiguousEffort": "high",
  "failureEffort": "xhigh"
}
```

替换方案有两种。

## v1 推荐方案

用户不能修改核心 admission policy：

```json
{
  "enabled": true,
  "mode": "shadow",
  "profile": "builtin:gpt-current-conservative-v1",
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

其中 `profile` 必须解析到精确 digest。

## 后续扩展方案

允许自定义 admission profile 文件：

```json
{
  "profile": {
    "capability": "./profiles/model.json",
    "admission": "./profiles/conservative.json"
  }
}
```

但自定义 profile 默认只能 shadow；要进入 enforce 必须显式批准其 digest。

---

# 十一、命令面修订

当前命令：

```text
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

同样绑定 GPT 档位。

应替换为 profile-relative命令：

```text
/effort status
/effort auto
/effort economical
/effort balanced
/effort deliberate
/effort exhaustive
/effort ceiling
/effort shadow
/effort enforce
```

但更准确的命名可能是：

```text
/reasoning auto
/reasoning anchor deliberate
/reasoning rung <profile-local-rung-id>
```

v1 为降低迁移量，可以保留 `/effort` 命令名，但参数必须 profile-relative。

状态输出示例：

```text
profile:openai-gpt-sol-r7@sha256:...
mode:enforce
policy:auto
anchor:deliberate
rung:r2/4
provider-value:"high"
epoch:12 active
reason:CODE_CHANGE_REQUESTED
```

不要只显示：

```text
effort:high
```

---

# 十二、Telemetry 修订

Decision record 应拆开 policy demand 与最终 provider value：

```ts
interface DecisionRecord {
  taskClass: TaskClass;
  relation: EpochRelation;

  requestedAnchor: AdmissionAnchor;

  profileId: string;
  profileRevision: string;
  profileDigest: string;

  resolvedRungId: string;
  resolvedOrdinal: number;

  providerValue?: unknown;

  mode: "shadow" | "enforce";
}
```

Request record 记录：

```text
recommended rung
resolved provider value
actual locally applied provider value
patch outcome
```

这样才能区分：

```text
政策选择变化
profile 变化
provider encoding 变化
其他 extension 覆盖
```

---

# 十三、Evaluation 修订

Evaluation 不再按固定努力档位运行：

```text
fixed-low
fixed-high
fixed-xhigh
```

应改为 profile-relative比较。

## Baselines

```text
profile lowest automatic
profile balanced anchor
profile deliberate anchor
profile automatic ceiling
policy shadow
policy enforce
```

若多个 anchor 指向同一 rung，runner 必须识别并去重，而不是伪造不同实验臂。

---

## Oracle

Oracle 改为：

> 在指定 profile revision 下，能够保持验收结果的最低 profile rung。

记录：

```text
profile digest
rung id
ordinal
provider value
```

不能只记录：

```text
lowest effort = high
```

---

## Profile qualification

每个 enforce-capable profile 至少需要通过：

```text
rung ordering complete
provider values unique or intentionally aliased
automatic ceiling defined
explicit-only rung 不会被自动选择
anchors 均可解析
all mappings preserve payload
unknown profile preserves baseline
```

并加入 profile mutation tests：

```text
新增 rung
删除 rung
重排 rung
改变 provider value
改变 anchor
改变 automatic ceiling
改变 profile digest
```

这些变化必须使旧 evidence binding 失效。

---

# 十四、按现有 PR ownership 的重排

这次修正已经不是 PR 3 的局部补丁。它改变了 foundational domain model，因此必须重新分配。

## PR 1：Profile 基础契约

加入：

```text
RungId
ReasoningRung
ReasoningCapabilityProfile
AdmissionProfile
ProfileBinding
ProfileResolution
```

删除全局 `Effort` 作为核心 authority。

Pi 类型绑定继续保留。

---

## PR 2：Profile-aware provider adapter

Provider adapter 输入：

```ts
ResolvedRung
```

而不是：

```ts
desired: Effort
```

它只负责将：

```text
resolved rung.providerValue
```

写入 profile 指定的 payload path。

未来 profile 可以支持其他 encoding，但 v1 只允许：

```text
reasoning.effort
```

---

## PR 3：Profile-relative router

Router 使用：

```text
anchor
rung
ordinal
profile digest
```

实现：

```text
epoch monotonicity
continuation inheritance
tool-error escalation
terminal failure recovery
manual override
```

所有比较都在同一 profile 内完成。

Canonical expanded prompt 修正也在此完成。

---

## PR 4：Profile-bound telemetry

每条 decision/request/epoch observation 绑定精确 profile digest。

Profile 切换或 session 切换必须形成新的状态边界。

---

## PR 5：Profile-aware evaluation

Runner 根据 profile 动态生成 comparison arms，不再假定四种固定 effort。

生产 extension 测试覆盖：

```text
两档 profile
四档 profile
含 explicit-only ceiling 的 profile
anchor alias profile
unknown profile
profile revision mismatch
```

---

## PR 6：Profile qualification 与 conservative enforcement

只有满足以下条件才允许 enforce：

```text
exact profile resolved
profile digest approved
capability profile valid
admission profile valid
provider adapter supports encoding
all mandatory regressions pass
```

否则：

```text
shadow 或 baseline preserve
```

---

## PR 7：Profile distribution 与升级流程

Package 中包含：

```text
profiles/
  capability/
  admission/
```

增加：

```text
profile:verify
profile:list
profile:check
```

Pi 或模型升级流程变为：

```text
升级依赖
→ profile resolution
→ candidate profile
→ qualification
→ approval
→ pin digest
→ release gate
```

---

# 十五、实施顺序

## 阶段 0：停止继续修补硬编码 Effort

不要先修：

```text
第一次 tool error high
第二次 xhigh
```

因为这会继续加固错误抽象。

先冻结新 profile schema。

---

## 阶段 1：定义最小 Profile Kernel

只完成：

```text
capability profile
admission profile
profile resolver
rung ordering
semantic anchors
profile digest
fail-closed resolution
```

暂不修改全部 evaluation/live tooling。

---

## 阶段 2：迁移 runtime

将：

```text
Effort
AutomaticEffort
higherEffort
```

迁移为：

```text
ResolvedRung
compareRungs
maxRung
nextRung
resolveAnchor
```

此时修复：

```text
canonical expanded prompt
tool-error progressive escalation
failed continuation
reason codes
session reset
```

---

## 阶段 3：迁移 provider 与 telemetry

Provider 不再解释策略，只消费 resolved rung。

Telemetry 同时记录：

```text
policy anchor
profile rung
provider value
patch outcome
```

---

## 阶段 4：迁移 evaluation 和 gates

删除固定 GPT effort arms，按 profile 生成矩阵。

引入两个最小测试 profile：

```text
two-rung-profile
five-rung-gpt-profile
```

以证明核心代码没有暗含四档或五档假设。

---

## 阶段 5：重建 PR 7 release gate

完整门禁加入：

```text
profile:verify
profile mutation tests
unknown-profile fallback
two-rung profile lifecycle
five-rung profile lifecycle
package profile loading
```

---

# 十六、最终 v1 验收标准

## 无全局档位假设

源码核心路径不得依赖：

```text
low
medium
high
xhigh
max
```

这些字符串只能出现在具体 profile fixture 或 provider-specific test 中。

---

## 任意有限有序 profile

同一 runtime 必须能够正确处理：

```text
2 个自动 rung
3 个自动 rung
5 个 rung，其中最高档 explicit-only
anchor alias
缺失 anchor
unknown model
profile digest mismatch
```

---

## Profile-relative monotonicity

```text
同 profile + 同 epoch
→ ordinal 不下降
```

跨 profile 不直接比较 ordinal。

---

## Fail closed

无法精确解析 profile 时：

```text
不 patch provider payload
不猜测默认档位
不继承旧模型 rung
不使用名称相似性匹配
```

---

## Profile-bound evidence

所有 evaluation、telemetry 和 release evidence 都必须绑定：

```text
profile ID
profile revision
profile digest
model/catalog binding
```

---

# 十七、最终边界

Pi-REAP v1 的最终产物不是：

> 一个为 GPT 固定选择 low、medium、high、xhigh 的 router。

而是：

> 一个根据版本化 reasoning profile，在模型自身可用的推理能力空间中执行 admission、单调升级、保守回退和可重放评测的控制层。

未来增加新模型时，不修改 router 核心逻辑，只增加并资格化：

```text
capability profile
admission profile
provider encoding adapter
evaluation evidence
```

未来 Salp flow 做模型升级时，也通过 profile anchor 迁移，而不是比较不同模型的 `high`、`xhigh` 字符串。

这意味着当前下一步不应继续修补 PR 3 的 `high/xhigh` 规则，而应先完成一次基础域模型迁移。上次列出的 canonical prompt、session isolation、truthful telemetry、package smoke 等建议仍成立，但都必须落在 profile-relative runtime 之上。
