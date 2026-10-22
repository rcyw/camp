# Camp：Raft + DSH + LayerFS MVP

Camp 把频道变成一个可观察的工作室：人提交目标，规划、开发、审查三个角色依次领取任务，每次执行都有独立 Sandbox、DSH 会话和 LayerFS 候选版本。频道保留进度、交接和测试证据。

完整设计、复用清单、接口及验收标准见 [详细设计](./raft-dsh-layerfs.md)。

长期第一阶段已加入目标分组、人工重试历史、执行预算、Worker 崩溃恢复与持久结果补交。设计和故障验证见 [可靠执行方案](./durable-execution.md)；下一阶段的结构化规划和可信候选合并见 [工作流设计](./durable-workflows-next.md)。

## 本机使用

现有服务：Web `http://localhost:15190`，API `http://localhost:13018`。继续使用当前开发环境；`raftdev stop camp` 会删除其临时数据，不用于重启代码。

1. 打开一个普通频道的“团队执行”标签，填写 Worker 可读取的项目目录并创建团队。管理员负责配置 Room 和签发 Worker 凭据，频道中有发言权限的成员可以提交目标。
2. 在“连接 Worker”中签发凭据，将其保存在 Git 忽略的 `.camp/worker.env`，文件权限设为 `600`：

   ```dotenv
   CAMP_API_URL=http://127.0.0.1:13018
   CAMP_WORKER_TOKEN=<界面签发的 Room 凭据>
   CAMP_WORKER_ID=camp-local-worker
   ```

3. 模型配置放在 `.camp/runtime.env`，例如 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`。不要把配置提交到 Git。
4. 在仓库根启动 Worker：

   ```sh
   node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
     --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs
   ```

5. 在频道发送 `/camp 目标和验收方式`，也可以在“团队执行”面板提交。普通聊天不会自动创建付费执行任务。停止按钮先请求取消，Worker 停止 DSH 并清理 Sandbox 后才确认终态。

每个目标默认一轮最多 12 次运行、3 次复审、30 分钟总时间。面板可设置本次目标的预算。预算耗尽或业务执行失败时进入“需要处理”，由管理员显式重试；每次重试保留旧一轮的任务、证据、预算和结束原因。基础设施中断可以在同一轮预算内重新分配新 epoch。

“旧沙箱清理待确认”表示执行权已经失效，但控制侧尚未收到物理清理确认。Worker 重启会核对日志并回收自己登记的旧执行，然后报告清理事实；它不会清除另一个有效 Worker 的资源。

本次演示的常驻 Worker 已在 `tmux slock-camp` 的 `camp-worker` 窗口启动，使用 `.camp/worker.env` 连接演示 Room。它与每个 Room 的凭据绑定；其他频道需要对应的 Worker 配置。

Worker 需要当前 Linux 主机上的 Docker、LayerFS Native/Daemon 构建、运行镜像和固定版本的 DSH。构建及运行说明见 [Runtime](../../packages/camp-runtime/README.md)，插件契约见 [DSH 插件](../../packages/dsh-plugin/README.md)。本机这些运行依赖已准备；新机器需按说明构建。

## 重现演示

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

当前固定三角色依赖链，审查提出修改后在目标预算内追加开发与复审任务。审查结论绑定服务端指定的开发候选；批准时工作区文件根必须保持一致。角色消息和交接建议已经持久化；任意消息驱动的自由组队、动态拆分任务还未实现。现有 Raft 其他 Runtime 代码保留以支持旧功能，Camp 新执行路径只使用 DSH。

可信 Worker 在 Sandbox 外管理资源和租约。Sandbox 内运行 LayerFS 文件系统 Daemon、DSH ACP 应用与 Camp 插件。DSH 只拿当前 Run 的能力凭据和临时模型代理凭据。这样可以在后续引入 Sandbox 内常驻执行 Daemon，同时让基础设施凭据留在控制侧。

LayerFS 当前使用 Disposable Store；只支持同一 Linux 内核、本地存储的部署方式。候选 Commit 保存文件状态，不恢复进程或外部服务。MVP 保存候选及审查证据，不自动发布到主分支。源目录应使用不含凭据的工作副本；LayerFS 本身会包含忽略文件，导入策略见 Runtime 文档。

后续按下面顺序推进，每步都有可以展示和复现的结果：

| 阶段 | 工作 | 验收 |
| --- | --- | --- |
| 当前 MVP | 三角色、租约、插件、候选版本、频道进度、取消 | 真实 DSH 从失败测试出发，完成修改、独立复审和资源清理 |
| 可靠目标工作流 | 目标分组、预算、重试历史、持久结果、崩溃后的资源回收 | 响应丢失和 SIGKILL 后可恢复；执行权与物理清理分别可观察 |
| 协作能力 | 结构化任务拆分、角色收件箱、问题回复、并发上限、可信候选合并 | 两个独立任务并行执行，合并候选保留两边修改，日常进度不触发唤醒风暴 |
| 结果整合 | 基线检查、候选 Diff、测试证据、可信发布入口 | 基线变化时拒绝直接发布，测试必须对应将要整合的 Commit |
| 可复现部署 | 可分发镜像、源导入策略、独立制品导出、资源配额与存储恢复 | 新机器按文档启动；掉电后的制品和存储恢复有独立验证 |
| 开源体验 | 三分钟演示、录屏、架构图、示例任务、贡献指南 | 用户无需了解 Raft 内部概念即可完成一次协作并检查证据 |

项目吸引力应围绕一个明确体验：在频道里看见团队如何推进，并且可以打开每次执行的文件版本和验证证据。星数无法保证，优先让首次体验和失败恢复都可以复现。

原 Raft 许可证及版权声明保留。当前继承的 `FSL-1.1-ALv2` 属于 source-available 许可，不能直接把整个派生仓库标成 MIT/Apache 或 OSI 开源；公开发行前需要按上游许可保留相应条款。
