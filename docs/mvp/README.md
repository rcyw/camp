# Camp：Raft + DSH + LayerFS MVP

Camp 把频道变成一个可观察的工作室：人提交目标，协调者提交有序任务计划，开发和审查角色逐项执行、审查和返工。每次执行都有独立 Sandbox、DSH 会话和 LayerFS 候选版本，频道保留进度、问题回复和测试证据。整体验收和协调总结通过后，下一需求可以继承已接受成果。

完整设计、复用清单、接口及验收标准见 [详细设计](./raft-dsh-layerfs.md)。

当前串行交付流程、接口与验收见 [单 Room 自主交付](./serial-room-workflow.md)。目标分组、人工重试历史、执行预算、Worker 崩溃恢复与持久结果补交见 [可靠执行方案](./durable-execution.md)；后续并行任务及可信候选合并见 [工作流设计](./durable-workflows-next.md)。

共享类型、校验与工具 Schema、领取前的能力检查及升级恢复边界见 [Worker 协议与能力协商](./worker-protocol.md)。真实旧 Worker 拒绝、兼容 Worker 接手和导出验收可运行 `node scripts/mvp/protocol-real-smoke.mjs --real`；该命令使用已有串行演示 Room，需要先停止其常驻 Worker，避免它抢先领取探针目标。

新增 [候选 Diff 与可信验证](./delivery-evidence.md)：Room 管理员先配置检查策略，新串行目标冻结协议 2 和策略摘要；所有任务审查后由独立普通沙箱验证，失败自动有界返工，通过后才允许最终审查和接受成果。开发版本的文件变化与验证回执可在面板中逐次查看。旧 v1 目标保留原语义。

新增 [单机 Worker 部署与恢复](./single-host-worker.md)：固定工具链和标准镜像、项目路径修正、配置下载和无领取预检、CPU/内存/PID 限制，以及 API 离线时的本地回收和重连补交。控制侧仍使用现有服务；多机执行尚未启用。

新增 [同基线双候选可信集成](./trusted-integration.md)：显式选择两个独立事项，依次从同一基线构建、审查，再执行系统集成、独立验证和整体验收；普通逐项模式保持原语义。0.5.0 支持协议 3，仍兼容 1/2。

本轮变更的审查发现、修复约束与升级方式见 [代码审查记录](./code-review.md)。

## 本机使用

现有服务：Web `http://localhost:15190`，API `http://localhost:13018`。继续使用当前开发环境；`raftdev stop camp` 会删除其临时数据，不用于重启代码。

1. 打开一个普通频道的“团队执行”标签，填写 Worker 可读取的项目目录并创建团队。管理员配置项目检查命令并签发 Worker 凭据；设置好检查策略后，频道中有发言权限的成员可以提交目标。
2. 在“连接 Worker”中填写 Worker 可访问的 API、稳定身份和私有目录，签发凭据并下载 `.camp/worker.env`，文件权限设为 `600`。下载内容还可包含精确镜像 ID 和 bundle 路径，以下仅示意核心字段：

   ```dotenv
   CAMP_API_URL=http://127.0.0.1:13018
   CAMP_WORKER_TOKEN=<界面签发的 Room 凭据>
   CAMP_WORKER_ID=camp-local-worker
   ```

3. 模型配置放在 `.camp/runtime.env`，例如 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`。不要把配置提交到 Git。
4. 按 [部署指南](./single-host-worker.md) 准备工具链，在仓库根先初始化、预检，再启动 Worker：

   ```sh
   node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs init
   node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
     packages/camp-runtime/scripts/doctor.mjs --report --require-agent
   node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
     --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs
   ```

5. 在频道发送 `/camp 目标和验收方式`，也可以在“团队执行”面板提交。普通聊天不会自动创建付费执行任务。停止按钮先请求取消，Worker 停止 DSH 并清理 Sandbox 后才确认终态。

默认串行目标包含一至五项有序任务，一轮最多 24 次运行、10 次审查、60 分钟总时间，规划、澄清、返工、最终验收和总结全部计入预算。面板可设置本次预算；等待人工回复也受总时间约束。旧固定流程及显式单角色探针保留原来的 12 次运行、3 次审查、30 分钟默认值。

问题需要回复时，打开问题收件箱即可查看接收角色、阻塞原因及回答历史。需要人决策的问题允许有频道发言权限的成员回答；平台保存当前文件候选并释放 Worker，回复后以新执行继续。预算耗尽或业务执行失败时进入“需要处理”，由管理员显式重试，旧一轮的任务、证据、预算和结束原因保留。基础设施中断可以在同一轮预算内重新分配新 epoch。

“旧沙箱清理待确认”表示执行权已经失效，但控制侧尚未收到物理清理确认。Worker 重启会核对日志并回收自己登记的旧执行，然后报告清理事实；它不会清除另一个有效 Worker 的资源。

本次演示的常驻 Worker 已在 `tmux slock-camp` 的 `camp-worker` 窗口启动，使用 `.camp/worker.env` 连接演示 Room。它与每个 Room 的凭据绑定；其他频道需要对应的 Worker 配置。

最新演示入口和稳定 runtime home 保存在 `.camp/active-demo.json`。常驻 Worker 目前连接真实双候选集成演示 Room，回执为 `.camp/integration-model-latest.json`；此前交付验证仍保存在 `.camp/delivery-latest.json`，原 Room、候选和配置保留，切换前配置备份为忽略文件 `.camp/worker.before-integration.env`。旧升级脚本使用其原回执中的配置，不依赖当前常驻 Worker 的 Room。

Worker 需要当前 Linux 主机上的 Docker、LayerFS Native/Daemon 构建、运行镜像和固定版本的 DSH。构建及运行说明见 [Runtime](../../packages/camp-runtime/README.md)，插件契约见 [DSH 插件](../../packages/dsh-plugin/README.md)。本机这些运行依赖已准备；新机器需按说明构建。

## 重现演示

本阶段的完整真实验证会创建独立项目与频道，执行三项计划、协调者问答、审查驳回与返工、最终验收和总结，导出成果后再提交第二个需求验证继承。需要真实模型配置：

```sh
node scripts/mvp/serial-real-smoke.mjs --real
```

结果保存在忽略目录 `.camp/serial/` 及 `.camp/serial-latest.json`。验证包含独立的搜索和 HTTP 黑盒断言、隔离容器中的导出测试，以及浏览器中的搜索、空结果、错误处理、安全文本渲染和最终 Room 展示。`--prepare-only` 只准备项目，不启动模型。

`node scripts/mvp/serial-ui-smoke.mjs` 使用真实浏览器、登录和频道 HTTP，Camp API 使用明确标注的协议夹具，不启动模型或 Sandbox；用于验证人工回答、成果清单下载和继续需求的交互。

以下保留初版加法示例及可靠执行探针：

以下命令针对现有 `raftdev camp` 种子账号，只新建演示频道和项目，不改已有项目源码。演示目录包含一个故意写错的加法函数和 Node 内置测试，不需要安装项目依赖。

```sh
node scripts/mvp/prepare-demo.mjs --skip-submit
node scripts/mvp/browser-smoke.mjs --submit
node --env-file=.camp/runtime.env --env-file=.camp/mvp-worker.env \
  --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs
node scripts/mvp/inspect-demo.mjs --assert-completed
node scripts/mvp/browser-smoke.mjs
```

`prepare-demo` 将 Room 地址等非敏感信息保存到 `.camp/mvp-receipt.json`，凭据单独保存到权限为 `600` 的 `.camp/mvp-worker.env`。`browser-smoke --submit` 通过真实浏览器的频道输入框发送 `/camp`。`inspect-demo --assert-completed` 要求三角色均有完成的 LayerFS 候选，并且审查有结构化 `approved` 结论。

`node scripts/mvp/cancel-smoke.mjs` 会额外创建一个取消探针任务，调用真实模型到达进度里程碑，再通过浏览器点击停止，确认清理后的取消终态。它是显式模型验证，会使用模型额度。

更多验证：

```sh
# 真实 DSH、Docker、LayerFS；会使用模型额度
node scripts/mvp/recovery-smoke.mjs
# 真实浏览器/API；协议数据夹具，不调用模型、不启动 Sandbox
node scripts/mvp/goal-ui-smoke.mjs
```

恢复实验注入 Claim 响应丢失、Worker SIGKILL、控制侧暂时不可用，以及 Completion 落库后响应丢失，再重启确认没有多分配 Run 或重复执行模型。结果保存于 `.camp/recovery-latest.json`。目标界面实验验证预算、重试、历史保留和取消，结果保存于 `.camp/goal-ui-latest.json`。

## 当前边界与下一步

默认流程是协调者提交有序计划，单开发角色串行执行，每项审查通过后推进；驳回自动返工，最后对原始需求做整体验收并记录协调总结。一个 Room 同时推进一个交付目标。问题通过持久收件箱挂起和恢复，普通进度与房间通知不触发模型唤醒。已启用显式的同基线双候选可信合并；任意依赖图与多个开发执行并行尚未启用。旧固定流程继续兼容；现有 Raft 其他 Runtime 代码保留以支持旧功能，Camp 新执行路径只使用 DSH。

候选以 `refKind` 和 `refId` 表示不可变 Layer 或 Commit。初始导入没有 Commit，未修改文件的任务可以直接审查、交付原始 Layer；实际修改后产生 Commit。审查、总结和 Room 接受的版本均由服务端绑定，下一目标继承该版本。已完成目标可下载成果清单，并在存储主机用 Runtime 导出到新的外部目录；不会自动回写原项目或发布到 Git 主分支。

可信 Worker 在 Sandbox 外管理资源和租约。Sandbox 内运行 LayerFS 文件系统 Daemon、DSH ACP 应用与 Camp 插件。DSH 只拿当前 Run 的能力凭据和临时模型代理凭据。这样可以在后续引入 Sandbox 内常驻执行 Daemon，同时让基础设施凭据留在控制侧。

LayerFS 当前使用 Disposable Store；只支持同一 Linux 内核、本地存储的部署方式。候选 Commit 保存文件状态，不恢复进程或外部服务。MVP 保存候选及审查证据，不自动发布到主分支。源目录应使用不含凭据的工作副本；LayerFS 本身会包含忽略文件，导入策略见 Runtime 文档。

已完成与后续工作按以下顺序排列，每步都有可以展示和复现的结果：

| 阶段 | 工作 | 验收 |
| --- | --- | --- |
| 当前 MVP | 三角色、租约、插件、候选版本、频道进度、取消 | 真实 DSH 从失败测试出发，完成修改、独立复审和资源清理 |
| 可靠目标工作流 | 目标分组、预算、重试历史、持久结果、崩溃后的资源回收 | 响应丢失和 SIGKILL 后可恢复；执行权与物理清理分别可观察 |
| 串行自主交付 | 结构化有序计划、逐项审查返工、角色与人工问题回复、最终验收和总结、成果导出与继承 | 三项任务、问答和返工自主完成，下一需求保留上一轮成果 |
| 执行协议与协商 | 单源类型/校验/工具 Schema、目标协议冻结、领取前能力检查、真实 Worker 诊断 | 不兼容 Worker 零分配、零执行预算，兼容 Worker 接手原目标；旧执行结果继续重放 |
| 候选与可信验证 | Layer/Commit 基线 Diff、冻结检查策略、独立验证任务、有界自动返工、历史回执 | 候选测试通过但固定外部验收失败时禁止接受，修复后再验证并完成 |
| 单机 Worker 部署（本轮完成） | 固定工具链、配置下载、预检、CPU/内存/PID 限制、离线回收 | 真实 SIGKILL 与 API 离线后保留原 outbox、重连补交并完成独立验证和导出；无模型调用 |
| 可信候选集成（本轮完成） | 同基线双亲、可信三方合并、冲突与未知结局恢复、集成候选复验 | 真实 DSH 两项改动完整保留，原生合并、独立检查与导出完成；未知结局不盲重试 |
| 并行协作 | 有界依赖图、并发上限、多个 Worker | 下游读取集成候选，日常进度不触发唤醒风暴 |
| 存储与发布 | 跨主机制品、持久 Store 恢复、显式发布入口 | 掉电恢复独立验证；发布基线与检查候选严格一致 |
| 开源体验 | 三分钟演示、录屏、架构图、示例任务、贡献指南 | 用户无需了解 Raft 内部概念即可完成一次协作并检查证据 |

项目吸引力应围绕一个明确体验：在频道里看见团队如何推进，并且可以打开每次执行的文件版本和验证证据。星数无法保证，优先让首次体验和失败恢复都可以复现。

原 Raft 许可证及版权声明保留。当前继承的 `FSL-1.1-ALv2` 属于 source-available 许可，不能直接把整个派生仓库标成 MIT/Apache 或 OSI 开源；公开发行前需要按上游许可保留相应条款。
