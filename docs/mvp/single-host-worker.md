# 单机 Worker 部署与恢复

本记录保留 0.4.0 阶段的设计与验收；当前 0.5.0 的新增能力见 [双候选可信集成](./trusted-integration.md)。这一阶段将已验证的串行交付链封装成可安装、可诊断、可恢复的 Worker。执行仍为三个 DSH 角色，目标和接受门禁仍由控制侧管理；协议继续支持 1/2，Worker、插件和共享包版本为 0.4.0。

本阶段的完整切片是：准备固定工具链 → 在 Room 修正项目与检查策略 → 下载 Worker 配置 → 无领取预检 → 执行与资源限制 → 停机或失联后的本地回收 → 重连补交 → 独立验证与导出。控制侧使用已有 Camp 服务；完整控制侧 Compose、任意 DAG、多主机和自动发布另行实施。

## 固定工具链

按 [Runtime 构建说明](../../packages/camp-runtime/README.md) 准备锁定的 LayerFS checkout、Rust 和 DSH 依赖，生成包含 SDK、native、daemon、DSH、插件/协议及许可证的 bundle，再构建固定官方 Node 基础摘要的标准镜像。构建不复制宿主 Node、git、npm 或共享库。默认输出：

- `packages/camp-runtime/.local/toolchain-bundle/manifest.json`：每个文件的 SHA-256、大小、权限和宿主 ABI。
- `packages/camp-runtime/.local/standard-image.json`：新镜像精确 ID、基础镜像与 bundle 摘要。

运行时设置 `CAMP_TOOLCHAIN_BUNDLE`，无需原 LayerFS checkout。显式 `LAYERFS_SOURCE` 仍可用于本地开发。SDK 子进程在 bundle 模式下使用已核验的 native/daemon，不被旧 project record 中的构建路径覆盖；既有 Store、候选、镜像身份和 outbox 不迁移或改写。

这里的可复现指固定输入与可核验产物。它不等于编译器位级重现、签名或远程证明。当前真实构建和运行验证为 Linux glibc/amd64；arm64 固定清单仍需独立机器验证。SDK/Store 的绝对本机路径不会因 bundle 搬迁自动迁移。

## 首次连接

已有 Camp 服务器与仓库依赖准备好后，在频道的“团队执行”中：

1. 创建 Room，填写 Worker 主机上的项目绝对目录。可使用 [计数器示例](../../examples/camp-counter/README.md)，不需要下载项目依赖。
2. 配置管理员检查策略，例如 `["node", "--test"]`。新目标冻结该策略。
3. 在连接向导填写 Worker 可访问的 API 地址、稳定 Worker ID、私有 runtime home，以及新项目所用精确镜像 ID；可指定 bundle 目录。浏览器的 localhost 不会自动当作 Worker 的服务器地址。
4. 签发凭据并下载配置，保存到 `.camp/worker.env`。下载文件的权限由浏览器/系统决定，必须按指引设置 `600`；模型配置只放在 `.camp/runtime.env`。
5. 运行向导给出的初始化、预检与启动命令：

   ```sh
   chmod 600 .camp/worker.env .camp/runtime.env
   node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs init
   node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
     packages/camp-runtime/scripts/doctor.mjs --report --require-agent
   node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
     --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs
   ```

`init` 仅建立私有目录，不创建 Store。默认 doctor 只读；`--report` 额外保存一次服务端自报，不领取任务、不执行项目程序、不调用模型。`--require-agent` 可发现遗漏的模型配置，但有配置不表示密钥或模型服务已经验证可用。省略模型环境文件和该选项，可以连接专用验证 Worker；它不能单独完成规划与开发。

只读检查覆盖平台、Node、宿主工具、私有目录、bundle/native ABI、Docker/FUSE、精确镜像、插件、harness、源目录、剩余容量、API、资源策略和模型配置。报告只含固定检查 ID、状态和诊断码，不上传原始 stderr、凭据或宿主路径。Room 展示服务端观察时间、模式和项目摘要，明确标注自报；它不证明 Worker 当前在线或远端隔离可信。

预检会运行可信宿主工具的版本查询，并在子进程加载核验过的 native 模块；FUSE 与源目录只检查访问条件，harness 检查固定内容摘要。它不代替真实挂载、完整源导入或某个目标的检查执行。

在创建任何目标/任务/执行历史前，管理员可以修正项目路径；保存以原项目摘要 CAS 防止覆盖别人的修改。源检查不初始化正式 Store。已有历史后项目配置冻结，需要另一个源项目时创建新 Room。改配置后的旧检查报告保留，但不能显示为当前项目检查已通过。

## 接口与执行准入

| 接口 | 语义 |
| --- | --- |
| `GET /api/camp/worker/setup` | Room 凭据读取项目、稳定摘要及是否仍可修改；Run 凭据不能读取 |
| `POST /api/camp/worker/preflight` | 保存 `{workerId,projectDigest,report}` 与数据库观察时间，不分配 Run 或消耗预算 |
| `PUT /api/camp/rooms/:roomId/project` | 管理员提交 `{project,expectedDigest}`，在 Room 锁下检查摘要与历史冻结 |
| Room `setup` 投影 | 项目摘要、可变性、最近自报；Worker registry 同时保留原协议声明 |

新 Worker 先恢复旧 journal/outbox，再检查新执行配置。首次执行及项目摘要变化时重新预检；每次领取前检查容量，运行中随续租继续检查。预检失败不会创建新的 claim intent 或消耗一次执行预算；历史中尚未确认的 intent 仍按原恢复流程处理。临时 API 错误沿既有退避重试；不兼容协议或确切本地配置错误要求操作员处理。旧 Worker 不被自报 API 强行改写协议语义，`canSubmit` 的频道权限规则不变。

## 资源策略

| 环境变量 | 默认 | 范围 |
| --- | --- | --- |
| `CAMP_AGENT_CPU_MILLIS` | 2000（2 CPU） | 250–64000 |
| `CAMP_AGENT_MEMORY_MIB` | 2048 | 512–65536 |
| `CAMP_AGENT_PIDS_LIMIT` | 256 | 64–4096 |
| `CAMP_MIN_FREE_MIB` | 1024 | 64–16777216 |

策略来自宿主配置，模型和项目文件不能修改。`prepareRun` 持久保存本次策略，在 LayerFS 挂载后、安装或启动 Agent 前执行 Docker update，并核对 CPU、内存、相等 swap 上限和 PID 数。每次执行保留 `resource-policy.json`。

LayerFS 当前创建接口不暴露 cgroup 参数，因此文件系统 daemon 创建至 update 存在启动窗口；不宣称容器从创建第一刻已受限。验证容器继续使用独立的固定普通沙箱限制。容量检查覆盖 journal 与 Docker 数据所在文件系统；尚不存在的 home 只读检查其最近存在父目录。容量不足或无法核对会停止新领取，运行中出现则停止执行、清理并保留明确的容量失败原因，不能记录为成功或伪装模型错误。

容量准入和运行中检查不是磁盘硬配额。运行期磁盘/egress 硬限制、跨 Worker 总资源调度和 Store GC 仍需后续实现。

## 停止、回收与恢复

正常停止向 Worker 发送 SIGTERM，等待它停止 DSH、清理资源并保存结算记录。可参考 [systemd 模板](../../deploy/camp-worker.service.example)，替换绝对路径后使用稳定配置和数据目录。模板通过 Node 的 `--env-file` 读取下载文件，与手动命令使用同一解析方式；不要直接换成 systemd `EnvironmentFile` 解析 Node dotenv 的引号。它只管理 Worker；不要用会删除开发数据的 `raftdev stop` 充当部署重启。

模板使用 `User=root`，因为当前适配器需要 Docker 和本地 Store 的直接访问。安装前将配置安全保存到 `/etc/camp/{worker,runtime}.env`（权限 `600`），使用管理员核对的绝对 `CAMP_RUNTIME_HOME`。初始化、服务启动、导出与离线回收必须使用同一 Unix 用户、同一 Node 24 和稳定 home；普通用户初始化的私有 journal 不能直接交给 root 服务。模板对应的首次检查命令例如：

```sh
cd /opt/camp
sudo /opt/node24/bin/node --env-file=/etc/camp/worker.env \
  packages/camp-runtime/scripts/worker-ops.mjs init
sudo /opt/node24/bin/node --env-file=/etc/camp/runtime.env \
  --env-file=/etc/camp/worker.env packages/camp-runtime/scripts/doctor.mjs --report --require-agent
```

离线回收也使用相同的 `sudo /opt/node24/bin/node --env-file=/etc/camp/worker.env` 前缀，在 `/opt/camp` 执行。源项目、bundle、原镜像及 Store 都应对该用户可访问。模板不自动安装服务或迁移已有用户的数据。

若 Worker 被 SIGKILL 且 API 不可用，可以在本地先检查，再显式回收：

```sh
node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs reap
# 停止对应 Worker 后，确认上面的目标，再执行本地回收
node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs reap --apply
```

默认 dry-run 不改 journal 或容器。apply 必须取得同一 Worker 的内核排他锁，再重新读取私有 journal，按原 Run/epoch/目录/prefix 清理自己登记的资源。它不访问 API、不结算或续租、不删除 Store、不改写成功或取消 outbox。未知资源只报告；已知归属冲突、原生操作结果不明、已知已清理却又出现资源时均要求检查，不能直接回收。停止服务后执行操作应共享同一 `/tmp` 锁目录；模板不使用 `PrivateTmp=yes`。

离线清理只产生本地事实。恢复 API 后以同一 API 地址、Worker ID、runtime home 启动，正常恢复链核对服务端状态、补清理确认，并在原执行仍获授权或结果已结算时补交原始 outbox；过期或替代的成功结果仍受原有门禁约束。服务端失联不成为推断结果已完成的依据。

保留 runtime home、相应 Docker Store volume、工具链和项目原镜像。不要全局 prune、删除未确认 outbox 或自动清理 Store。发布成果应导出到独立目录/tar 并保存清单；导出是文件制品检查点，不包含进程、数据库或外部副作用。LayerFS 仍是 Disposable Store，保留 volume 与 journal fsync 不代表掉电耐久。

## 本阶段验收

```sh
node --test packages/camp-protocol/test/*.test.mjs
node --test packages/camp-runtime/scripts/*.test.mjs
node packages/camp-runtime/scripts/verify-toolchain-bundle.mjs --real
node packages/camp-runtime/scripts/verify-resource-policy.mjs --real
node scripts/mvp/deployment-real-smoke.mjs --real-infra
```

工具链和资源探针使用独立命名空间，验证后删除自身执行资源；完整部署探针保留自己的候选与导出，归档新增频道。后者使用本机现有服务和种子账号，不加载模型配置：5 次角色输出明确为合成，独立验证、API、数据库、Docker 和 LayerFS 为真实。它验证坏路径零分配、修正 CAS、缺模型提示、容量拒绝、真实 SIGKILL 后的 API 离线回收（零 API 请求）、其他执行存活、原 outbox 摘要不变且重连结算、无密钥验证 Worker、完整交付和新 Runtime 实例导出。不能把它当作真实模型自主协作的替代证明。

2026-10-23（Asia/Shanghai）本机验收：

| 验证 | 结果 |
| --- | --- |
| Runtime 回归 | 174/174，通过默认准入的真实本机 HTTP 503、断线、重定向拒绝及原 journal URL 兼容测试 |
| 共享协议、插件与独立示例 | 35/35 |
| Server Camp/权限、真实 PostgreSQL、相关 Docker 打包合同 | 65 + 2 + 6 项通过 |
| Web DOM | 7 组 126/126；另通过真实浏览器的配置下载、草稿保留和过期自报展示（Camp API 夹具） |
| 生成声明、插件描述符、受影响类型检查与 lint | 通过 |
| 新工具链实际运行 | 无原 checkout，SDK/native/daemon、git、npm 和 DSH profile 可用，探针资源已清理 |
| 资源实际限制 | CPU `25000/100000`、内存 512 MiB、PID 64；50 次进程创建被拒，超量内存进程 exit 137，另一执行存活 |
| 完整部署恢复 | 真实 SIGKILL/API 离线，回收时零 API 请求，原 outbox SHA 不变，重连完成独立验证及新 Runtime 导出 |
| 原演示服务 | 0.4.0 常驻 Worker 用原身份/home/镜像恢复，预检通过，旧成果仍 ready；没有新增模型调用 |

迁移 0380 以事务应用于现有本地库，旧执行字段及行数保持不变，历史自报仍为未知；没有重建已有 Room 或伪造历史迁移记录。真实基础设施探针另建频道和项目，角色输出明确为合成，没有花费模型额度。此前真实 DSH 的付费自主交付证据保留在 [交付验收记录](./delivery-evidence.md)，本轮不冒充重新验证过模型自主性。

本机回执为 `.camp/deployment-latest.json`、`.camp/setup-ui-latest.json` 和 Runtime `.local/{bundle-verification,resource-policy-proof}.json`。完整控制侧镜像本轮只修复缺少共享协议包的问题，静态打包合同通过；独立实构建在依赖下载阶段达到截止，尚未证明整个控制侧镜像构建和启动。

## 下一阶段

两项同基线候选的可信集成已实现，见 [可信集成](./trusted-integration.md)；下一步开放同存储主机的有界并发，再扩展依赖计划。LayerFS 当前确有三方 merge，但默认 `/.lww` 与 units 可能选择一侧；必须冻结共同基线与双亲，明确约束这些策略，保留 merge intent/result，处理冲突、NameTaken 与未知结局，再对集成候选重新验证、审查和接受。展示用的截断 Diff 不能作为应用补丁。完整接入门槛见 [可信集成设计](./durable-workflows-next.md)。
