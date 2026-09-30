# tiny-agent-runtime

用 TypeScript 从零构建轻量 Agent 运行时：模型适配、工具循环、文件工具、执行事件与会话持久化。

这是「从 Pi Agent 源码拆解到最小可用 Agent」系列第 15–18 期的独立教学实现，非 Pi 官方项目，也不是上游仓库的 fork。源码学习参考：[earendil-works/pi](https://github.com/earendil-works/pi)。

## 快速开始

```bash
git clone https://github.com/syncretichunter-cloud/tiny-agent-runtime.git
cd tiny-agent-runtime
npm test
```

无需安装运行时依赖。在线模型演示需要自行配置 API Key；离线报告演示不需要 Key。

## 系列实现范围

主线：模型适配器（15）→ 顺序 Agent Loop（16）→ 文件工具与执行事件（17）→ 会话恢复与业务定制（18）。零运行时依赖，Node.js >=22.19.0。

```bash
npm test
npx --yes --package typescript --package @types/node -c 'tsc -p tsconfig.json --types node --typeRoots "$(dirname "$(dirname "$(command -v tsc)")")/@types"'
```

类型检查独立于 Node 的类型擦除执行。`npx` 只下载开发检查工具，不会请求模型；`--types node` 在较新的 TypeScript 中需要显式指定。

## 第 17 期动手

`createFileTools(workspace)` 返回 `read_file`、`write_file`。先创建一个只装练习文件的目录，再运行兼容接口演示：

```bash
mkdir -p /tmp/pi17-playground
export AGENT_WORKSPACE=/tmp/pi17-playground
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY='your-key'
export OPENAI_MODEL='your-model-id'
npm run demo -- "在工作区写一个 note.txt，内容是 hello，再读回来"
```

如果是本地服务，按其要求设置 `OPENAI_BASE_URL`、`OPENAI_MODEL` 和 Key。`onEvent` 观察 `tool_end` 并向 stderr 打出工具名、调用 ID、成功/失败；`ToolMessage` 仍进入下一轮模型输入。可把 `onEvent` 换成 UI 日志或进度条，但回调抛错会中断任务，这不是持久化日志。

仅在完全信任输入和执行环境的隔离练习中，设置 `AGENT_ALLOW_SHELL=1` 才会注册 `run_shell`。它通过 `/bin/sh -c` 执行**任意命令**；工作目录、超时、输出长度限制都**不是沙箱或权限隔离**，命令仍能访问工作区以外的主机资源。默认不要开启。文件路径做了词法与现有路径的 realpath 检查，仍存在并发替换符号链接的竞态，不要把这个示例当成对抗恶意本地进程的安全边界。

## 对照代码

- `src/tools/index.ts`：文件工具参数检查、工作目录路径约束；可选 shell。
- `src/agent/agent-loop.ts`：`onEvent` 发出 `agent_start`、`turn_start`、`message`、`tool_start`、`tool_end`、`turn_end`、成功结束时 `agent_end`。
- `src/demo.ts`：真实工具接入模型适配器，演示如何订阅事件。
- `test/tools-events.test.ts`：文件读写、越界路径、符号链接、shell opt-in/超时/输出限额、事件次序、跨模型轮次回填。

边界：课程版采用非流式兼容接口、工具顺序执行；工具定义里的 `parameters` 供模型选择，运行时只对示例工具手工验证参数，不是完整 JSON Schema 校验。工具异常转为带 `isError` 的 `ToolMessage`；截断调用不执行。没有权限审批、工具幂等/回放保障、并发工具执行或增量工具更新。第 18 期新增下述平面 session 持久化，但不实现生产 Pi 的完整 session 系统。事件回调是同步观察接口，不是生产 Pi 事件系统的同构复刻。

## 第 18 期：最小 session API

```ts
import { AgentSession, loadReportContext } from "./src/index.ts";
const setup = await loadReportContext(workspace, ["source.md"]);
const options = { path: `${workspace}/session.jsonl`, config: setup.config,
  client, tools: setup.tools };
// 使用真实模型时，把 setup.config.model 替换为实际模型标识。
const first = await AgentSession.create({ ...options, initialMessages: setup.initialMessages });
try { await first.run("读取资料并记住要点"); } finally { await first.close(); }
const second = await AgentSession.resume(options);
try { await second.run("根据之前的资料生成报告"); } finally { await second.close(); }
```

- `create({path, config, client, tools?, initialMessages?, ...loopOptions})`：父目录必须存在，`wx` 创建新文件，不覆盖旧日志。初始消息仅在创建时写入。
- `resume({path, config, client, tools?, ...loopOptions})`：完整验证文件后恢复所有内部 `Message`，包括 system/user、assistant 的调用参数与元数据、tool 的结果与错误标记。不重新执行旧工具。
- `run(input)`：返回原有 `AgentLoopResult`。同一实例并发调用拒绝；同一进程内同一规范化路径重复打开也拒绝。`close()` 释放进程内占用；运行中不能关闭，关闭后不能调用。
- 任意运行异常会将实例标为 failed，防止继续写入不确定状态。先 close、检查文件，再显式 resume；未配对工具调用依然拒绝。
- 新增 `runAgentLoop({onMessage: async message => ...})`。user 在首个模型请求前、assistant 在工具执行前、tool result 在下一次工具/模型调用前依次 `await`；每条 session 消息写入后 `fsync`。`onEvent` 保持旧的同步观察语义，不承担写盘。

### JSONL 格式与配置契约

第一行 `{ "type": "header", "version": 1, "config": {...} }`；后续每行 `{ "type": "message", "message": <内部 Message> }`，每行以换行结束。直接保存内部结构，不经过 provider wire format，以免丢失关联 ID 与元数据。

配置按 JSON 对象键排序后比较（数组顺序仍有意义）。**调用方负责准确提供模型标识、工作区、prompt/context 摘要和工具定义**，session 不会从不透明 `ModelClient` 自动推断配置。`loadReportContext` 示例提供工作区 realpath、prompt、资料 SHA-256、现有读写工具定义，模型默认是离线演示标识。

未知版本、配置不一致、非法 JSON/消息、缺失最终换行、未配对/错配/重复工具调用一律拒绝；坏 JSON/消息报告行号。工具结果允许 `isError`，但必须与调用 ID 和工具名对应。工具已写文件但结果未落盘时，恢复会拒绝，绝不自动重放副作用；请人工检查外部状态。

### 离线两进程业务定制演示

业务是**本地资料报告助手**：`REPORT_PROMPT` + 显式资料清单的 `loadReportContext` + 第 17 期 `createFileTools`，默认只有读写工具，不开启 shell。资料被标注为不可信数据，隐藏路径被拒绝，文件读取仍使用原有 workspace 路径检查。不是另一门 Harness 课程的售后项目。

```bash
WORKSPACE=$(mktemp -d /tmp/pi18-report-XXXXXX)
npm run demo:report -- save "$WORKSPACE"
npm run demo:report -- resume "$WORKSPACE"
```

两条命令启动不同 Node 进程。`save` 写真实 source.md，通过真实 read_file 读取并保存会话；`resume` 断言下一请求含旧 user、assistant 和 tool result，然后通过真实 write_file 产出 report.md。模型是确定性的离线 fixture，用来验证数据链路，**不代表验证了真实模型的报告质量**。不加载 `.env`，不发送在线模型请求。

本次真实输出（省略 npm 启动前缀）：

```text
saved messages=6
已读取 source.md：完成 3 项文档整理，待确认 1 项风险。
restored old context=true; messages=10
报告已写入 report.md，来源为 source.md。
report.md:
# 本地资料报告

来源：source.md

本地资料：本周完成 3 项文档整理，待确认 1 项风险。

未知信息：风险详情待确认。
```

### 验证与边界

严格 TDD：新增 9 项测试先跑 `npm test`，RED 为 **23 pass / 9 fail**；实现后 GREEN 为 **32 pass / 0 fail**。独立 tsc 检查最终退出 0。原始日志在 `logs/18-red.log`、`logs/18-green.log`、`logs/18-tsc.log`、`logs/18-demo.log`；类型检查的首次错误也保留。

仅单进程独占写入；两进程 demo 是**先退出第一进程，再启动第二进程**，没有 OS 文件锁，不能让不同进程同时打开同一日志。文件是平面 append-only，不做树分支、compaction、日志修复、工具幂等或 exactly-once。恢复整文件进入内存，历史增长受上下文窗口限制。最终换行能发现尾部截断，但无法发现恰好在完整行边界被删除的历史，没有校验链。`fsync` 不等于文件系统/目录层面的事务保证。日志可能含用户资料，创建权限为 0600；仍须自己管理访问权限、备份、保留周期。读写工具不是操作系统沙箱，资料中的 prompt injection 不能仅靠提示词彻底消除。
