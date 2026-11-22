# A2A 架构从零开始 —— 第一版（v1）“真聊天”核心架构与地基规范

本项目以实现个人 Agent 与个人 Agent 之间**像现代聊天软件（微信/Telegram）一样自由、连贯的真正交流**为目标。在通信过程中明确区分 **Host（宿主服务端，`./server/`）** 与 **Client（客户端发起方，`./client/`）**，遵循**“人（Agent）+ 耳机（本项目）”**的工具定位，**100% 剔除未经工程实践检验的 FOGA 协议**，并去除了原生 A2A 协议中死板冗余的条条框框。

---

## 一、 项目核心地基：Agent 为什么要交流、何时触发及五步标准流转

### 1. 从四个演进范例看“人给 Agent 下达任务”的自主性光谱（L1 ~ L4）

| 演进层级 | 典型范例 | 人类给定的内容 | A2A 交流的目的与形态 | 是否经过人类确认？ |
| :--- | :--- | :--- | :--- | :--- |
| **L1：明确指令** (Instruction) | “请帮我去携程上订明天下午从上海到香港的机票” | 固定的平台、时间与动作 | 传统接口调用即可完成，基本不需要复杂的 A2A 多轮自由探讨。 | 下单付款前确认。 |
| **L2：单次目标** (Goal) | “我明天晚上在香港有个会，你看看怎么安排” | 非标的期望结果（具体路径未定） | **核心 A2A 场景**：本地 Agent 需寻找外部专业 Agent（差旅、会务、本地向导）多轮询盘、反问澄清、比价组合，将模糊目标拼成确定方案。 | **关键节点过人**：当触及《初衷卡》未写明的预算/偏好底线或最终拍板时，挂起请示主人。 |
| **L3：长期职责** (Role) | “给你我的 Calendar，作为我的秘书把行程安排好” | 持续运行的岗位职责 | 当外部合作方的秘书 Agent 来约会面时，两个秘书 Agent 自动通过 A2A 核对双方日历空档、协商时间地点。 | **过程不过人，结果通知人**：双方 Agent 聊妥后直接写入日历并通知主人。 |
| **L4：自主使命** (Mission) | “你把自己的 Token 费赚出来吧” / 市场“做市商 Agent” | 顶层生存法则 / 活跃市场使命 | **硅基原生协作**：Agent 自主在市场中寻源、推销技能、采购低价信息转手撮合套利，“活跃与撮合”本身即目的。 | **完全自治闭环**：脱离人类实时干预，自主决定何时找谁交流。 |

### 2. 为什么需要 A2A？（对比“Agent 自己用浏览器搜 Google”的三大不可替代场景）
- **场景 A：跨主体私密状态与主观意愿协调（Google 搜不到）**：当对面代表另一个真人或私有组织（如与合作方代表敲定香港会面时间与议程、与导师/队友的个人 Agent 对接项目进度），对方的私有日历和意愿无法通过搜索引擎获取，必须由两个个人 Agent 进行 A2A 多轮协商。
- **场景 B：消除通用大模型“看过期网页产生幻觉瞎编”**：通用 Agent 用浏览器爬网页易受广告软文干扰或产生幻觉；通过 A2A 直接向握有一手实时私有状态或实测经验的专家 Agent 询盘，可获得可追问、高信噪比的确定性答复。
- **场景 C：跨权限边界的执行委托**：委托对方 Agent 在其私有环境与权限范围内执行动作并回传结果。

### 3. A2A 交流五步标准流转地基
1. **触发判断**：评估发现仅靠本地信息或公开网页搜索无法完成，需跨主体协商或外部专有能力时触发。
2. **锚定初衷（防忽悠第 1 层）**：在本地生成《主人初衷卡》（`OwnerIntentCard`）并结合《主人长期偏好档案》（`ownerPreferences`）。
3. **陌生线索寻址与长期 HTTPS 本地缓存**：陌生 Agent 先在链上按**能力标签线索**（如 `"香港差旅"`）搜出匹配的 `AID` -> 获取并本地缓存其**长期固定 `https://` 地址**与固定收件箱（拒绝做成 24 小时云端僵尸 Agent，电脑开机即在线，关机即离线转入收件箱）。
4. **同一 `taskId` 多轮对话、反问与三级防忽悠拦截**：
   - 对方反问（`counter_question`）或报价方案（`proposal`）均留在**同一个 `taskId`** 内，绝不因反问而终止 Task；
   - 即使跨多天、双方电脑多次开关机或更换端口，双方本地均按 `(peerAid, taskId)` 硬盘持久化，上下文一秒不断；
   - 面对《初衷卡》漏写的底线（如忘记写预算上限或讨厌的航司），耳机自动触发 **`ESCALATE_TO_HUMAN_OWNER` 防忽悠拦截**，挂起请示人类主人；主人拍板后自动学习并永久补全《主人长期偏好档案》。
5. **双端幂等 `CancelTask` 与三层记忆提纯（防偷看、防数万份档案污染）**：
   - Host 与 Client 均可触发 `CancelTask`（内置幂等状态锁，双方同时触发也零崩溃、零重复档案）；
   - 结案后原始聊天记录转入本地冷档案（`archived: true`），对后续新任务**物理沙箱隔离（不可偷看）**；
   - 提炼带 `[sourceTaskId]` 索引指针与 `tags` 标签的**《极简档案》**，并更新固定 200 字以内的**《对端滚动总画像》**；开启新任务时仅通过 **Top-3 相关性漏斗**注入最匹配的 3 条极简档案，就算积累几万份档案也绝不发生上下文污染；如遇纠纷需查原话，可凭 `sourceTaskId` 显式调用 `RecallArchivedTask` 审计调卷。

### 4. 公网私链与持久化机制（`chain/` + `vercel.json`）
- **顺序排号与防覆盖保护**：公网私链基于 SHA-256 哈希链实现，新节点调用 `POST /chain/register` 自动按顺序递增分配 `AID`（`2 -> 3 -> 4...`），创世节点 `AID = 1` 受保护；
- **适配临时反向隧道**：已注册节点（如每次重开临时隧道更换地址的节点）再次传 `aid` 或同名 `agentName` 即可免密原地更新最新 `https://` 地址；
- **主节点硬盘持久化方案**：在 Vercel 后台配置环境变量 `ANCHOR_HOST_URL` 后，私链每次变更自动同步写入主节点电脑本地硬盘（`server/data/chain_ledger.json`），Vercel 实例冷启动时自动拉回，零数据库配置且不丢数据；
- **邮箱字段可选**：`mailboxAddress` 默认为 `null`（Optional 可选项）。

---

## 二、 目录结构（端到端物理解耦）

```text
A2A-medo/
├── chain/                            # 公网私链 AID 注册与寻址节点（配合 vercel.json）
│   ├── .env.example                  # 私链环境变量模板（在 Vercel 配置 ANCHOR_HOST_URL）
│   ├── chain_engine.js               # 顺序排号分配 AID (1 -> 2 -> 3...)、免密更新临时隧道地址与主节点硬盘持久化同步
│   ├── api.js                        # Vercel Serverless 私链 HTTP 接口
│   └── admin_cli.js                  # 私链状态查看、区块校验与管理命令行工具
├── server/                           # Host 宿主端（耳机服务端与宿主 CLI）
│   ├── package.json                  # 服务端独立配置（100% 纯 Node.js 内置模块，零冗余依赖）
│   ├── .env.example                  # 服务端环境变量模板
│   ├── discovery_store.js            # 链上 AID 绑定与收件箱（Mailbox）投递存储
│   ├── memory_store.js               # Host 端三层隔离记忆引擎（物理沙箱 + 滚动总画像 + Top-3 漏斗 + 幂等结案）
│   ├── host_server.js                # Host 耳机服务（实现改造后 4 大 A2A 方法 + 审计调卷 + 私链硬盘锚点同步）
│   ├── host_cli.js                   # 供 Host Agent 佩戴操作耳机的命令行工具（含 register-chain / update-chain）
│   └── start_tunnel_and_register.js  # 一键启动本地 Host 服务与公网 HTTPS 隧道脚本
├── client/                           # Client 客户端（耳机客户端 SDK、CLI 与全链路测试）
│   ├── package.json                  # 客户端独立配置
│   ├── .env.example                  # 客户端环境变量模板
│   ├── discovery_client.js           # Client 端链上标签线索搜索、AID 解析与收件箱发现模块
│   ├── memory_store.js               # Client 端三层记忆引擎（含《主人初衷卡》、长期偏好学习与防忽悠守卫）
│   ├── headset_client.js             # Client 耳机核心 SDK（含反问拦截、临时隧道变更自动重查、关机告警与离线投递）
│   ├── client_cli.js                 # 供 Client Agent 佩戴操作耳机的命令行工具
│   └── test_e2e.js                   # 8 大核心场景全链路自动化验证脚本
├── SKILL.md                          # 供 Muse / Claude Code / Antigravity 直接读取的 Agent 耳机操作技能规范
├── vercel.json                       # Vercel 私链路由配置
└── README.md                         # 项目核心架构与快速操作手册
```

---

## 三、 快速运行与全链路验证

### 1. 一键运行 8 大核心场景自动化验证
```bash
node ./client/test_e2e.js
```

### 2. 常用 CLI 操作命令
```bash
# 1) 陌生 Client 按能力标签线索在链上搜寻 Host AID（传入 "" 可列出链上全部节点）并缓存 HTTPS
node ./client/client_cli.js search-clue ""
node ./client/client_cli.js discover <hostAid>

# 2) 为新任务锚定《主人初衷卡》
node ./client/client_cli.js set-intent task-01 "安排差旅机票" --budget 2500 --blacklist "某廉航"

# 3) 发起单任务多轮对话 (mode="task") 或多轮连续会话 (mode="session")
node ./client/client_cli.js task-chat <hostAid> task-01 "请帮我看看明天下午出发的航班" --topic "差旅机票"
node ./client/client_cli.js chat <hostAid> "你好 Host，我们在连续会话窗口聊两句"

# 4) Host 在同一 taskId 内回复或发起反问/报价 (counter_question / proposal)
node ./server/host_cli.js reply <clientAid> "东航14:00经济舱1850元，是否锁单？" --task task-01 --type proposal --price 1850 --provider "东航"

# 5) 双端幂等完结任务并沉淀带索引《极简档案》
node ./client/client_cli.js end-task <hostAid> task-01 --summary "已订东航MU501(1850元)，含起飞前4小时免费改签1次" --tags "差旅,机票,东航"

# 6) 按极简档案索引显式申请调阅已封存任务的原始对话记录
node ./client/client_cli.js recall-task <hostAid> task-01 --reason "核对免费改签承诺条款"
```
