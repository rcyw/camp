# Worker 协议与能力协商

本阶段在单 Room 自主交付之上建立可版本化的执行契约。目标是把不兼容部署挡在任务领取之前，并为后续多个 Worker、sandbox 适配器和滚动升级提供明确边界。它不增加并行任务图或自动合并。

当前版本已推进至 Worker 0.5.0、协议 1/2/3 支持。协议 3 仅用于显式的同基线双候选目标，默认逐项目标继续冻结协议 2，见 [可信集成](./trusted-integration.md)。下文保留协议 1 的设计和升级验收记录；新的串行目标冻结协议 2，需要管理员检查策略、候选 Diff 和独立可信验证，详细变化见 [候选 Diff 与可信验证](./delivery-evidence.md)。协议 1 的既有目标与结果重放继续使用原契约。0.4.0 增加的项目摘要、自报预检和离线回收见 [单机 Worker 部署](./single-host-worker.md)，没有改变执行协议版本。

## 单一协议来源

`packages/camp-protocol/src/index.js` 是纯 ESM、零运行依赖的共享模块，包含角色、不同层次的状态、任务类型、预算、计划、候选、问答和成果类型，以及计划/候选校验、模型工具 JSON Schema 和兼容性判断。服务端保留权限和事务，Runtime 保留文件操作与进程策略，Web 保留浏览器投影和 HTTP 客户端。

类型声明从同一 JavaScript 的 JSDoc 自动生成，提供新鲜度检查；不再分别手写四份执行契约。Worker 安装 DSH 插件时必须同时带入这一协议模块，不能依赖宿主机的 workspace 软链接。候选规范身份要求明确的 `refKind/refId`，旧制品的显示和导出兼容通过显式选项处理。

## 协商与分配

Worker 先使用 Room 凭据读取 `GET /api/camp/worker/protocol`，检查服务端的版本和能力。此操作只读，不领取任务。服务端不认识该端点、发现文档缺字段或版本不兼容时，新 Worker 不尝试新分配；既有 journal 的恢复与清理仍可进行。

新领取请求携带：

```json
{
  "workerId": "camp-local",
  "claimId": "<durable claim UUID>",
  "runToken": "<derived run capability>",
  "protocol": {
    "protocolVersions": [1],
    "workerVersion": "0.2.0",
    "taskKinds": ["plan", "build", "review", "final_review", "summary", "clarification"],
    "refKinds": ["layer", "commit"],
    "capabilities": [
      "dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1",
      "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1"
    ]
  }
}
```

协议版本、任务类型、文件引用类型和具体能力分别校验，不能仅凭 `protocolVersion: 1` 推断插件支持全部工具。v1 串行执行需要七项模型能力；v2 另按工作类型检查候选 Diff、可信验证及固定外部检查能力。初始基线和开发任务要求支持 Layer 与 Commit，其他任务根据确定的输入引用检查。Worker 同时检查实际选择的插件包，防止新 Worker 搭配旧插件后才发现工具缺失。

每个串行 Goal 固定 `protocolVersion`；已存在的串行目标迁移为版本 1，旧 legacy 目标保留 null。Run 保存协商快照 `{version, declaration, requirements}`，后续发布不能改变正在执行或历史 Run 所使用的协议。有版本声明的 Worker 执行 legacy 任务时，同样把实际选定的版本写入 Run 及其 requirements；不能在一个快照中混用目标的 null 和执行的 1。包版本与协议版本分别演进。

协商与实际执行使用同一输入候选解析：legacy 的前置执行制品也必须先解析成确切引用，再计算任务要求和固定 Run 输入，不能协商时按空输入检查，返回上下文时才补上另一种引用要求。

服务端先解析已绑定的 claim intent 重放，再对新分配检查兼容性。相同 intent 不能因为声明改变而得到第二个 Run。不兼容时返回 `run: null` 和具体诊断，不分配租约、不增加执行预算，也不因缺能力把目标变成失败。已有 deadline、取消和权限撤销规则继续有效。

缺少声明的旧 Worker 可以继续原 legacy 路径，但不能领取串行执行。只声明未来版本而不支持当前版本时拒绝；同时明确支持版本 1 和未来版本时，可以匹配当前已实现的版本。未知额外能力标识不会赋予执行权；未知字段、畸形声明及未知任务语义仍拒绝。

## 恢复与诊断

`state`、`reconcile`、`cleanup` 和原 `complete` 结果重放不增加新的必填协议字段。新协商失败不能重写、丢弃或重新计算原 outbox；执行权失效后的物理清理仍需独立确认。Worker 不把旧 Run 的能力快照当作新的领取授权。

`camp_workers` 只保存每个 Room/Worker 最近的合法声明、实际任务要求、兼容结果及时间。Room 快照最多返回最近 50 条观测，不暴露令牌、模型密钥或本机路径。界面展示最近一次报告和实际缺项，不把它解释为机器在线探测。没有任务可检查时兼容结果为 null；旧服务端没有 `workers` 字段时保持旧界面。

能力声明是可信 Worker 的自报，不是硬件或插件代码的远程证明。静态插件描述用于发现版本混用和打包错误；真正的执行约束仍由 Room 权限、租约、任务唯一写入权、不可变候选与审查绑定保证。

## 迁移与验收

新增迁移 0377；已应用的 0376 不修改。不重置现有数据库、不删除已有 Room、目标、执行或文件候选。部署时先停止旧服务端写入，再执行迁移并启动新服务端；旧二进制不懂新增的 Goal 协议字段，本阶段不支持旧新服务端混跑的零停机发布。Worker 与插件则在声明的协议能力内更新，旧执行结果仍可恢复。验收覆盖：

- 旧 Worker、缺工具、缺引用类型、未来版本和部分支持都在新分配前被检查。
- 不兼容领取保持任务、Run 数、预算与已验收版本不变，诊断可从真实界面查看。
- 合法 Worker 接手同一排队目标并完成交付；原 intent 和旧执行结果仍可重放。
- 宿主机测试、独立插件安装、真实 Docker/LayerFS、浏览器模块与界面、真实 PostgreSQL 并发，以及真实 DSH 流程分别记录。

## 协议 1 实施记录

2026-10-23（Asia/Shanghai）完成本阶段验收。共享协议为 1，Camp 协议包、Runtime 与插件的本地版本为 0.2.0。

| 验证 | 结果 |
| --- | --- |
| 共享协议 | 8 项通过；包含同一模块在真实 Chromium 中执行，生成声明新鲜度和严格 JS 类型检查通过 |
| 服务端 | 18 个相关文件、98 项通过；包括不同声明、无副作用拒绝、claim 重放、旧结果兼容及两个 legacy 候选/版本一致性回归 |
| 真实 PostgreSQL | 2 项通过，覆盖旧迁移数据、并发领取与原有锁序回归；未声明 Worker 并发尝试不增加分配 |
| Runtime 与插件 | 90 项通过，含旧服务/缺能力拒绝、静态插件检查不执行宿主代码、旧 outbox 在缺模型配置或升级不兼容时原样恢复 |
| Web | 86 项 DOM 通过；协议夹具浏览器覆盖缺项、更新后的兼容状态、问答、清单与继续需求；类型、范围 lint 与 i18n 检查通过 |
| 真实安装 | Docker 中以 UID 501 加载两个包、静态描述与 12 个共享 Schema，并解析真实 DSH profile；宿主机真实 ACP 无密钥初始化通过，均未创建模型会话 |
| 本机迁移 | 0377 事务应用，原有 8 个 Room、11 个目标、36 次执行及任务、计划、问题全部保留；3 个历史 serial 目标固定为 1，8 个 legacy 目标保留 null，历史 Run 的新协议字段保持 null |

真实升级验收命令：

```sh
node scripts/mvp/protocol-real-smoke.mjs --real
```

该命令使用 `.camp/serial-latest.json` 对应的既有演示 Room，以及该回执中的 `workerEnvPath`（旧记录没有此字段时回退到 `.camp/worker.env`），执行前停止该 Room 的常驻 Worker。五次不兼容探针分别为未声明协议、只声明未来版本、缺问答能力、缺任务类型和缺引用类型；每次检查都确认目标仍排队、零执行、零预算、原 Room head 不变，真实 UI 展示对应诊断。脚本现在适配新的协议 2 目标，缺少策略时先配置项目测试；下述是升级前协议 1 的历史实测记录。

随后兼容 Worker 接手同一个目标，从之前已验收的候选补充交付说明。5 次真实 DSH 执行、2 次审查、198 秒后完成；全部 Run 固定协议 1，Room revision 从 3 推进到 4，人工回答与人工重试均为 0。导出成果在无网络、只读容器中通过独立核心/HTTP 验收及 22/22 项目测试。

回执 `.camp/protocol-latest.json`，证据目录 `.camp/protocol/camp-protocol-mvjs1zml/` 包含拒绝、兼容执行、完成后三张真实 API 浏览器截图，以及导出清单、成果和测试日志。真实容器安装回执为 `packages/camp-runtime/.local/protocol-packaging.json`。没有重建原有基础镜像，安装验证和真实执行均在已固定镜像上安装新插件与协议包；新的 baked image 构建配方已同步包含协议包。

该轮验收结束时本机服务和常驻 Worker 已恢复，继续使用原 Room、Worker 身份和 runtime home。协议 2、跨主机 Store、多 Worker 并行以及可信合并不在这份协议 1 验收记录的范围内；后续协议 2 实现与独立验收见 [候选 Diff 与可信验证](./delivery-evidence.md)。
