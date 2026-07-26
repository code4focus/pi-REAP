# Pi REAP evaluation human-review rubric

Use this only after the deterministic grader has recorded its result. Each decision must be retained with the evaluation report.

| Field | Required record |
| --- | --- |
| Run and task IDs | Identifies the reproducible evaluation unit. |
| Reviewer and timestamp | Attributes the decision. |
| Acceptance | `accept`, `reject`, or `inconclusive`. |
| Critical failure | `yes` or `no`, with concrete evidence. |
| Evidence | Output or artifact reference; do not copy prompts, secrets, or user data. |
| Rationale | Explain the acceptance criterion applied. |

The oracle is not a reviewer’s preferred effort. After acceptance is determined, the oracle is the **lowest effort that preserves task acceptance** across the compared attempts. Mark unavailable evidence inconclusive; do not infer a release benefit.
