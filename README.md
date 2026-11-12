# Claude Code Multi-Agent

Claude Code 多模型任务编排插件。主规划模型拆分任务、写验收条件和依赖，并派发原生子 agent。子 agent 回报后，主模型检查证据，再验收、重试或调整后续计划。

## 启动

克隆仓库后，在仓库根目录执行以下命令。插件无需安装 npm 依赖，已在 Claude Code 2.1.318 验证。

```sh
claude --plugin-dir .
```

要在其他项目中使用插件，请在目标项目目录启动 Claude Code，并将 `--plugin-dir` 指向此插件仓库。

在 Claude Code 会话中输入以下命令，先查看当前模型映射，再用一个只读任务体验流程。

```text
/ma config
/ma run 将项目的入口和测试命令拆成两个独立的只读调查任务并行执行，验收后汇总具体文件和证据
```

| 命令 | 用途 |
| --- | --- |
| `/ma run <目标>` | 启用主规划模型，提交目标并开始规划 |
| `/ma on` | 启用规划模式，之后直接输入任务 |
| `/ma status` | 查看任务状态、派发模型、回报和验收证据 |
| `/ma config` | 查看实际配置的模型和任务上限 |
| `/ma resume` | 让主模型查看已有任务板并继续。也可用于中断后的恢复 |
| `/ma off` | 关闭规划模式。已启动的子 agent 仍可写回任务结果 |
| `/ma reset` | 清空已停止执行的任务板。文件修改由项目自身管理 |

## 模型配置

默认从 Claude Code 已生效的 `settings.json` 或进程环境读取 `ANTHROPIC_DEFAULT_*_MODEL`。下表中的 Claude 别名会按这些设置解析。若同一个模型同时配置给 Opus 和 Sonnet，多个角色使用同一个模型属于预期行为。

| 用途 | 档位 | 默认别名 |
| --- | --- | --- |
| 主规划与验收 | `planning` | `opus` |
| 只读探索 `explorer` | `fast` | `haiku` |
| 复杂诊断 `debugger`、复杂任务与失败重试 | `reasoning` | `opus` |
| 实现 `implementer` 与运行验证 `verifier` | `coding` | `sonnet` |
| 独立审查 `reviewer` | `review` | `opus` |

需要覆盖时，在目标项目创建 `.claude/multiagent.json`，参考 [examples/multiagent.json](examples/multiagent.json)。`models` 可以只写要覆盖的字段，值支持别名或网关实际接受的模型 ID。配置在插件加载时读取，修改后重启会话。可选的 `effort` 按档位设置，省略时沿用 Claude Code 自身行为。插件在每次受管模型请求前写入选定的模型 ID，API 路径和凭据由 Claude Code 的网关配置管理。

## 调度

主模型通过 `mcp__multiagent__tasks` 创建任务图并提交准备就绪的任务 ID，示例见 [examples/plan.json](examples/plan.json)。插件会检查循环依赖、并发上限和声明的工作范围，然后保存派发预留，避免同一任务被重复启动。后台子 agent 完成后，插件保存回报，并在本批任务全部结束时排队提交一次续接提示。

任务返回后进入 `reported`，需要主模型提交具体证据并验收为 `done` 才能解锁依赖它的任务。失败或驳回后可以给出反馈，使用 `reasoning` 档位重试。默认最多同时运行 2 个子 agent，每个任务最多尝试 2 次，单个计划最多派发 24 次。任务的角色决定可用工具，多个任务共享项目工作目录，`scope` 用于调度互斥和提示，实际文件权限由 Claude Code 控制。

| 文件 | 内容 |
| --- | --- |
| [`hooks/register.ts`](hooks/register.ts) | 命令、工具、原生子 agent 派发与续接 |
| [`lib/board.ts`](lib/board.ts) | 任务图、依赖、并发与状态流转 |
| [`lib/config.ts`](lib/config.ts) | 角色档位、设置解析和重试路由 |
| [`lib/prompts.ts`](lib/prompts.ts) | 主模型、子 agent 指令和工具参数 |

Claude Code 直接加载 TypeScript 源码，使用插件无需构建。开发时先运行 `npm ci` 安装 TypeScript，再运行 `npm run check` 检查任务图、模型路由、原生 hooks 和插件清单。

完整类型检查使用本机 Claude Code 生成的 API 声明。在仓库根目录交互式启动一次 `claude --plugin-dir .`，待 `.claude-plugin/types/` 生成后运行 `npm run typecheck`。

`npm run test:e2e` 使用回环地址上的模拟 API 验证真实 CLI 派发和回报流程。实际网关需支持 Anthropic Messages API、流式输出与工具调用，运行时可用 `/ma config` 检查解析出的 ID。

接口参考 [Claude Code Mods API](https://code.claude.com/docs/en/plugins/mods/api)。
