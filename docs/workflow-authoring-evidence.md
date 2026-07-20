# Workflow authoring evidence

This report records review evidence for the compact workflow tool contract and the packaged `workflow-authoring` skill. Provider-backed results are samples, not release gates. Normal tests and publishing remain deterministic and model-free.

## Context surfaces

Measurements use UTF-8 bytes. The historical baseline is `818fdd8` (release 3.0.0), captured when concision work began. The candidate is the final tree on `feat/self-documenting-workflow-capabilities`.

| Surface | Baseline (`818fdd8`) | Candidate | Change |
| --- | ---: | ---: | ---: |
| Permanent workflow prompt | 766 | 742 | -24 |
| Provider-visible workflow tool definition | 9,558 | 3,918 | -5,640 |
| Workflow-authoring skill discovery | 0 | 338 | +338 |
| Ordinary workflow-owned always-on total | 10,324 | 4,998 | -5,326 (-51.6%) |

The candidate also records 67,089 bytes across 27 on-demand skill files. Six representative authoring profiles have a median of 11,662 bytes. `docs/workflow-context-surfaces.json` is the generated, release-checked source for candidate measurements.

## Post-tuning comprehension validation

This validation reused the scenario families that informed the guidance changes, so it is not an independent holdout. It held the rebased runtime, prompts, deterministic fixtures, semantic oracles, model settings, and three repetitions constant. It changed only the installed workflow-authoring skill:

- **Pre-trim:** skill content from `7a41a19fb2352b2efce19e5f29af556669d150fe`.
- **Candidate:** the skill in this branch.

Each condition ran three coverage scenarios—fan-out-and-synthesize, generate-and-filter, and `judgePanel()`—three times on each of nine model configurations, for 81 generated workflows per condition:

- `openai-codex/gpt-5.3-codex-spark:medium`
- `openai-codex/gpt-5.4-mini:medium`
- `openai-codex/gpt-5.5:medium`
- `openai-codex/gpt-5.6-luna:medium`
- `openai-codex/gpt-5.6-terra:medium`
- `openai-codex/gpt-5.6-sol:medium`
- `local-vllm/cyankiwi/Qwen3.6-27B-AWQ-BF16-INT4:medium`
- `zai/glm-5.2:high`
- `zai/glm-5.2:max`

Captured workflows were replayed through the final parser, runtime, deterministic fixtures, and semantic oracles without provider calls.

| Result | Pre-trim | Candidate |
| --- | ---: | ---: |
| Semantic passes | 73/81 (90.12%) | 74/81 (91.36%) |
| Fan-out-and-synthesize | 25/27 | 25/27 |
| Generate-and-filter | 26/27 | 27/27 |
| `judgePanel()` | 22/27 | 22/27 |
| Median loaded skill context | 8,096 tokens | 2,564 tokens |
| p90 loaded skill context | 9,454 tokens | 4,075 tokens |
| Maximum loaded skill context | 10,686 tokens | 6,747 tokens |
| Observed provider tokens | 2,344,438 | 1,564,872 |

The candidate reduced median loaded skill context by 68.3% without reducing the sampled pass count. All seven configurations other than Qwen and Spark passed 63/63 candidate scenarios. The seven remaining candidate failures were model-generated JavaScript or authoring mistakes; provider-free replay found no remaining fixture or oracle false negatives.

An earlier corrected-harness sample scored pre-trim at 75/81 and optimized at 71/81. The parent prompt, fixture calibration, final guidance, and generated model outputs changed before the result above. Provider scores therefore show sampled behavior, not a stable benchmark. This is why they remain non-blocking.

A separate protected check ran the six core scenarios three times on GPT-5.4 Mini and GPT-5.6 Luna and passed 36/36. Their three-scenario coverage gate passed 18/18. The final candidate did not repeat the earlier nine-model, 162-case core panel.

## Reproduction and retention

The optional harness is available through `npm run comprehension -- --suite coverage --model <provider/model:thinking> --output <path>`. It records the selected and resolved model, thinking level, skill-loading evidence, generated workflow, runtime evidence, assertions, and token usage.

The delivery-choice harness has a deterministic scorer and optional provider CLI for default background delivery versus `background:false` inline delivery. This report includes no provider-run delivery-choice result.

Raw provider evidence remains local and uncommitted because it is large and variable. The committed release gate verifies the harness, parser/runtime replay seam, package discovery, coverage manifest, generated references, context measurements, and all model-free examples without making provider calls.
