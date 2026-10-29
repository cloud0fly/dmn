# P6-A：共享 DSH 模型与选择

2026-10-29，原生插件 v0.3.0。实现与离线验收完成，真实跨 Provider 多轮验收 **FAIL，P6 尚未完成**。本轮仅两节点，不引入第三节点、Subagent 或新的自动化授权。

## 行为与边界

顶部“选择模型”使用 DSH 已注册 Provider/model 目录，按 Provider 分组，区分 API 与 Account 等同名模型路由。只允许已知至少 32768 context 的文本模型。读取目录、创建或切换群聊均不推理。

节点 SDK 仍运行独立 sdk-minimal Profile，保持固定根 Session 和私有记忆命名空间。新增 LlmAdapter 经随机 capability 命名管道请求 Desktop Host；Host 在原 DSH 适配器内生成，保留其 Provider 设置与凭据，不复制整个 Desktop Profile 或工具权限。

Host 从正在运行的持久轮次读取身份，核对路由、根 Session、话题 epoch、截止时间、输入和输出上限。请求拒绝工具、多模态以及客户端端点/凭据/路径。每节点只允许一个 dispatch，SDK 模型重试、标题生成与压缩关闭。prepared stream 的中断不能通过自动重试扩大费用。

每轮在对应 Runtime Home 写排他 `.request`；只有完整 `finish:stop` 才写 `.result`。相同请求可读完整缓存，只有标记没有结果则拒绝重新调用。非成功 finish 只记录脱敏 code/kind，不保留 Provider 原始错误或 URL。Host 关闭时中止并等待已发请求，未证明停止则拒绝切换。

采用 Host 代理，是因为直接复制 Desktop Profile 会携带不必要的权限和凭据；仅复用目录又不能让隔离 SDK 执行相同 Provider。该代理仍受 DSH Host 版本、适配器能力及部署配置限制。

## 配置与迁移

- SQLite 保持 v8，无 SQL 迁移。settings schema 1 新增可选 `sharedRoutes` 二元组，原 `models`、凭据引用与旧模式继续兼容。
- 选新路由时创建新数据库与两套新根/命名空间，不能原位重绑旧节点。系统提示词按 A/B 复制，旧历史与私有记忆只留在旧实例。
- `model-rooms` 保存旧配置、目标配置及幂等请求。先持久化准备意图，再创建数据库，最后停旧服务和保存当前配置。完成初始化的 Runtime receipt 支持丢失 IPC 回执后用同请求重试；没有 receipt 的不完整数据库拒绝覆盖，需人工处理。
- 旧群聊可只读加载并显式切回，不重放未知轮次。相同数据库的历史索引去重，标题包含 Provider/model 与短实例标识。
- 回滚时正常退出 Desktop，保留并选择旧群聊配置，再使用保留版本安装器；共享群聊需要 v0.3.0 Host 支持，旧版无法直接执行。数据库与 Runtime 必须成套保留，不能只还原 SQLite。

受影响契约见 [共享契约](DSH_SHARED_MODELS_CONTRACT.md)。原生 Connection 新增 GET `/api/dmn-native/models`、GET/POST `/api/dmn-native/rooms`；POST 校验 Origin、自定义标头、严格 Schema、revision 与幂等键。独立 CLI/Web 仍只支持原两条官方 DeepSeek 路由。

## API 核对

实际环境：DSH Desktop/SDK/llm 0.2.1-rc.3，Cordis 4.0.5；本机安装的 `dsh-llm-pi-ai` 为 0.1.6-alpha.2。项目 Node 24.14.0，Desktop bundled Node 24.21.0。

对照已安装 `dsh-llm/lib/types/index.d.ts` 的 `listProviders`、`listModels`、`resolveModelInfo`、`prepareCall`、`LlmAdapter` 与 retry policy；对照已安装 pi-ai 适配器的 prepare/stream、context 与失败映射实现。官方参考：[LLM 服务](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm)、[pi-ai 适配器](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)。在线 master 可变化，实现以以上安装版本为准；未修改用户 Provider 配置。

## 验收结果

| 用例 | 实际结果 | 结论 |
|---|---|---|
| 核心回归 | `npm test` 137 项，包括真实 SDK 经模拟 Host 的固定根 resume/终态证明、双 Provider 五轮与硬预算停止 | PASS，模拟模型不代表真实 Provider |
| 类型与契约 | `npm run check` | PASS |
| Host 插件 | `npm run test:desktop-native` 16 项；伪造身份/工具/输入、未知不重放、同节点并发、失效授权、幂等/准备失败与凭据隔离 | PASS |
| 原生浏览器 | `npm run test:native:ui` 1 项，选择 A/B 模型、响应丢失原键重试、提示词、目标消息和窄屏回归 | PASS |
| 兼容 Web | `npm run test:ui` 3 项 | PASS |
| 实际 Desktop 目录及应用 | 可见 DeepSeek、DeepSeek Account、zai；原生选择 Account Flash + GLM，创建新根；应用时 0 调用 | PASS |
| 实际切回旧实例 | 切回 default，原两根 ID 与两条已完成活动保留 | PASS |
| 真实官方 API 首轮 | 1 次活动，未取得完整生成证明，进入 unknown；未重放 | FAIL，原因未证实 |
| 真实 Account → GLM | 共 2 次活动：Account 完成 send，消息投递给 GLM；GLM 返回 error / INVALID_REQUEST，进入 unknown | FAIL，未完成双向多轮 |
| 真实跨 Provider 达到轮数停止 | 未达预设 4 轮，仅 1 完成 + 1 unknown | FAIL |
| 全部目录模型、跨 Provider 重启恢复、24h 长稳及其他平台 | 未执行 | NOT_RUN |

真实调用总上限 5 次；本轮累计 3 次活动，没有因为失败自动补轮，剩余额度未使用。真实试验均使用专用新群聊，原 default 与旧 native-dev 数据保留。估算费用是项目预留单位，不是 Provider 账单金额或扣费硬上限。

另用独立日志 inspector 只读复核了真实 Account/GLM 实例：Account 根会话终态为 completed，GLM 为 unknown，数据库中恰有 1 条 A → B 消息；证据存于本地 `shared-models-independent-proof.json`，没有以 SDK 入队回执代替完成证明。

本地复现：先通过原生界面选两条不同 Provider 路由并应用，确认专用实例无活动，再运行：

```powershell
$env:DMN_SHARED_LIVE = '1'
$env:DMN_SHARED_LIVE_CALLS = '4'
$env:DMN_SHARED_LIVE_DB = '新群聊数据库的绝对路径'
npx tsx --test tests/shared-models.live.acceptance.ts
```

该命令会调用真实模型，不能对 unknown 实例直接重放。测试保存时间戳证据至忽略目录 `.dmn/evidence/`；历史首轮证据为 `shared-models-live.json`。真实消息、SDK 历史、截图和用户配置不随仓库发布。

## 残留项

GLM 的 INVALID_REQUEST 具体请求字段/部署兼容性仍待定位，不能据此认定认证失败，也不能认定是模型无回复。应先核对该 Provider 在 DSH 自身的相同模型可用性及请求能力，再在新批准的有界验收中复测；本轮不修改用户 Provider 设置、不放宽输出协议、不重放未知调用。共享路径的跨 Provider 真正双向多轮与恢复验收通过之前，不宣称 P6 已完成。

初始化数据库后、receipt 写入前断电会留下隔离目标；不会自动删除或覆盖。Host 仅本机能力控制，不提供对同 OS 用户恶意代码的安全沙箱。目录中可解析不代表模型适合严格 JSON，也不代表所有适配器都支持历史 reasoning 重放或当前 token 上限。
