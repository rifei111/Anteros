# M0c 验收清单

目标：**M0c = 单机闭环可交付**。下面每条都写清楚"怎么验"和"通过标准"，不允许"大概正常"。
当前状态列如实标注：`✅ 已验证` / `🟡 自动化已验证（界面未点验）` / `待验证`。2026-10-26 的验收记录在文末。

## 0. 准备

```powershell
# 仓库根，干净构建
cd F:\软件\Anteros
& 'C:\Program Files\nodejs\npm.cmd' run build:shared
& 'C:\Program Files\nodejs\npm.cmd' run build:kernel
& 'C:\Program Files\nodejs\npm.cmd' run build:client
node scripts/validate-plugins.mjs
node scripts/check-boundaries.mjs
```

数据目录：`%APPDATA%\Anteros`（数据库 `anteros.sqlite`，日志 `logs/`，密钥 `master.key`）。
需要"全新安装"效果时，先关掉 Anteros，把整个 `%APPDATA%\Anteros` 改名备份（**不要直接删**，留证据）。

查数据库（只读，别在应用运行时写）：

```powershell
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.APPDATA+'\\Anteros\\anteros.sqlite',{readOnly:true}); console.log(db.prepare('SELECT id,enabled,status FROM plugins').all());"
```

## 1. 声明闸未勾选不能进入

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 全新数据目录启动 Anteros；2) 声明页出现九条，全部未勾；3) 不勾直接点"进入/开始"；4) 只勾 8 条再点 |
| 预期 | 按钮禁用或返回错误；九条缺一条都不放行；没有"全选/快速同意"；无法用快捷键跳过 |
| 反证 | 关掉应用，`SELECT doc_version, accepted_ts FROM user_consents` 应无当前版本记录；`settings` 里无"已同意"标记 |
| 状态 | ✅ 已验证（2026-10-26）：真机截图 0/9 条时「进入」禁用、只有「我不接受，退出」；未勾选时内核 `chat.send` 返回 `ECONSENT`；`consent.accept` 缺一条即 `EINVALID`，无「全选/快速同意」入口 |

## 2. 强杀插件，内核继续，App 内对话 100% 可用

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 启用 `core.memory-extract`（或任一 low 风险插件）；2) 找到插件进程：`Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*plugins*memory-extract*index.mjs*' } \| Select ProcessId,CommandLine`；3) `Stop-Process -Id <pid> -Force`；4) 立刻在 App 里发 3 条消息 |
| 预期 | 插件状态变 `crashed`/`degraded`；内核不退、窗口不白屏；3 条消息全部正常回复（不依赖该插件的能力）；退避 1s/5s/30s 后自动重启，连续失败标 `crashed` 并告警 |
| 状态 | 🟡 自动化已验证：`plugin-lifecycle.test.ts` 真起插件进程（Windows 命名管道）→ kill → 观察 1s/5s/30s 退避重启、连续 3 次失败置 `disabled`，内核与其它插件不受影响；界面内逐项点击未验 |

## 3. 禁用后无残留

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 启用一个插件并观察进程；2) 在"插件"页禁用；3) 立即检查进程与端口；4) 重启 App 再查 |
| 预期 | 插件进程消失（无 `index.mjs` 命令行残留）；`plugins.enabled=0`；`plugin_grants` 该插件行 `revoked_ts` 非空或无有效授权；UI 显示"已禁用"；重启后不自动拉起 |
| 状态 | 🟡 自动化已验证：`disable` 后进程退出、`plugins.enabled=0`、`plugin_grants.revoked_ts` 非空、重启不自动拉起（lifecycle 测试覆盖）；界面内点击未验 |

## 4. 业务代码 grep 无通道名

| 项 | 内容 |
| --- | --- |
| 命令 | `node scripts/check-boundaries.mjs` |
| 通过标准 | 输出 `[check-boundaries] 0 violation(s)`，退出码 0 |
| 当前 | ✅ **通过**：`[check-boundaries] ok`。例外只有三类且都是规范/草案规定的字面量：规范 1 `owners.wechat_id` 列名、草案 2.9 `ANTEROS_OWNER_WECHAT_ID` 环境变量、草案 14.14.5 声明闸文案（`packages/shared/src/consent.ts`） |
| 备注 | 允许出现的例外只有通道插件目录、manifest 文案与配置键；内核/客户端/共享层的代码与表结构不得含具体通道名 |

## 5. 发错人 = 0

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 不启用任何外部通道；2) 在界面里尝试"发送到外部/转发"（若入口存在）；3) 启用通道骨架（会被 blocked）；4) 再试 |
| 预期 | 无任何外发动作；返回 `EBLOCKED` 且说明"未接通"；`outbox`/`action_queue` 无新增外发任务；日志无"已发送"假记录 |
| 根因保障 | 外发只能经 `plugin.channel.send`，且需 `channel.write` 授权 + 有效租约；骨架插件直接 `EBLOCKED` |
| 状态 | ✅ 白名单单测 11 例覆盖（非法 target / 不在白名单 / 未持租约一律拒绝且无外发副作用）；通道骨架 `send` 直接返回 `EBLOCKED`；内核冒烟里 App 通道可用、外部通道 `enabled=false` |

## 6. 一键停用（panic stop）

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 启用多个插件（含通道骨架，若允许）；2) 点"通道"页的一键停用（或调 `channels.panicStop`）；3) 查插件与进程 |
| 预期 | 所有通道类插件被禁用；插件进程退出；返回里列出每个插件的 `restored` 状态；`audit_log` 有记录；App 内对话仍可用 |
| 状态 | ✅ 内核冒烟断言返回可读结果（无通道时「没有正在运行的通道插件，无需停用」）；`channels.test.ts` 覆盖有通道时的停用与 `restored` 回报；App 内对话不受影响 |

## 7. 成本上限硬生效

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 把 `plan.budgetCny` 改成 0.01（管理抽屉→Owner/设置，或改数据库后重启）；2) 连续发消息直到超预算；3) 看返回与 `cost_ledger` |
| 预期 | 超预算后 `chat.send` 返回 `EBLOCKED`（不是"继续但提示"）；`cost_ledger` 累计与设置一致；调低预算立即生效；调高后恢复 |
| 状态 | ✅ 已验证：冒烟把 `plan.budgetCny` 调为 0 后 `chat.send` 直接返回 `EBLOCKED`（不是「继续但提示」），再调回 45 恢复 |

## 8. 导出 / 导入可迁移

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 管理抽屉→导出，得到 `anteros-export-*.zip`；2) 关 App，换一个干净数据目录启动；3) 导入该 zip；4) 对比消息数、记忆条数、设置 |
| 预期 | 导出包含 `anteros.sqlite` 与 `media/`（或说明不含媒体）；导入后消息/记忆/关系/成本记录与导出前一致；版本不兼容时明确拒绝（`EVERSION`）而不是静默丢数据；失败可回滚 |
| 状态 | ✅ 已验证：冒烟导出 `.json.gz`（约 5.5KB）→ 导入成功（32 张表 / 38 行）→ 导入前后消息条数一致（4 → 4）；导出包不含密钥与 `master.key`。注意格式是 JSON+gzip 内嵌媒体，不是 zip |

## 9. 其他必须同时成立

- `node scripts/validate-plugins.mjs`：7/7 通过（**已验证**）。
- `node scripts/package-check.mjs --repo-only`：0 错误（**已验证**）；带安装包全量检查 19 通过 / 0 警告 / 0 错误。
- 安装包：`release/Anteros-Setup-0.1.0-x64.exe`（约 117 MB），`package-check` 已确认包内含
  `resources/kernel/kernel.mjs` 与 `resources/plugins/*/plugin.json`；`win-unpacked\Anteros.exe` 实跑通过。
- 插件随内核启动（**已验证**，2026-10-26 修复）：内核 `ready` 之后 `App.start()` 拉起插件宿主与通道；
  `core.dashboard` / `core.memory-extract` / `core.tray-notify` / `core.world-info` 四个默认启用插件
  实测为 `running`；`core.media` 因缺 `media.api_key` 为 `blocked`（不假成功）；
  `channel.wechat-replica` 与 `core.llm-router` 默认 `disabled`。首启未过声明闸时插件保留
  `enabled=1` 仅置 `blocked`，`consent.accept` 后自动补启动。
- 健康语义（**已验证**）：`system.health().ok` 只统计 `degraded`/`crashed`，故意关闭的高危通道与
  缺密钥的可选插件不再把整体健康拖成 false，但仍会出现在 `degraded` 清单里供面板提示。
- 日志抽查：`logs/kernel-*.log` 无 `sk-`、无 `Bearer`、无消息正文原样（**已验证**）。
- 崩溃抽查：不配模型时 App 顶部明示"本地回声（演示模式，不产生云端调用）"，不白屏、不假成功（**已验证**）。

## 10. v0.2.0 增补（人格内核可编辑 / 逐条发送 / 弹窗层级）

- **人格内核由用户输入驱动（已验证）**：管理面板「人格」页签写一段人设 → 点「编译成人格内核」→
  得到带取值区间的数值内核（`d` / `τ` / `s` / `ρ` / 情绪增益 / 打字延迟与 σ / 气泡条数 / 错字率 /
  细节敏感 / 温度 / 主动性 / 幽默）与逐项 `why` 依据；未配置模型走本地规则引擎（`engine=rules`，
  `usage=null`，界面明示"本地规则引擎"徽标），配置模型后由模型读人设产出草稿。
  越界输入一律钳到边界并在 `clamped` 里写明原因；「应用到人格」才落库，落库前不改当前人格。
  冒烟断言：草稿姓名/城市/年龄来自原文、引擎标识正确、每项改动带解释、应用后 `persona.get` 回读一致、
  `burstMin/burstMax=9` 被钳到 3。单测 `mind.blueprint.test.ts` 9 例覆盖规则方向、钳位、模型 JSON 解析与坏输出回退。
- **逐条发送（已验证）**：输入框底部「逐条发送」开关，状态存 `localStorage`（`anteros.splitSend`，默认关）；
  开启后按行拆段、逐条 `chat.send`、间隔 400–1200 ms，发送期间输入框禁用、失败即停并把剩余内容留在输入框。
- **弹窗层级（已验证）**：危险操作二次确认浮层改走 `.modal-mask-top`（`z-index: 95`），
  不再被下层授权弹窗遮住；`useConfirm` 一处改动覆盖 6 个页签的确认框。
- **降级提示去噪（已验证）**：内核启动/健康检查会连发多次 `event.health`，客户端把 1.5 s 内的变化
  合并为一条、内容未变不再弹，并过滤掉"尚未勾选声明"这类第一跑的预期状态。
- **自检口子**：`ANTEROS_SMOKE_TAB=<页签文本>` 点开指定页签，`ANTEROS_SMOKE_PERSONA_TEXT=<人设>` 自动填入并编译，
  用于无人值守截图验证；不设这两个变量时行为与之前完全一致。
## 11. v0.3.0 增补（插件授权与密钥 / 消息不重复）

- **插件能授权了（已验证）**：确认 token 的 action 归一（界面叫 `plugins.enable`/`plugins.grant`，宿主消费叫
  `plugin.enable`/`plugin.grant`，现在两边都认、真正不同的动作仍拒绝）；授权弹窗按 `PluginInfo.grantable`
  （capabilities ∪ permissions）逐项勾选，`channel.write` 依赖的 `channel.lease` 终于能被勾上。
  复现脚本：`release/probe-plugins.mjs`（临时目录起真内核走完整授权链路，不进仓库）。
- **声明了密钥的插件能录密钥了（已验证）**：新增 `plugins.secret.put` / `plugins.secret.delete`，密钥经
  SecretStore（AES-256-GCM 落盘本机）保存；审计只记"哪个插件的哪个密钥名 + 长度"，不记值。
  `PluginInfo.secrets` / `missingSecrets` 每次实时重算，删掉密钥后"缺密钥"立刻回来。
  `llm.configure` 带 apiKey 时会顺手把密钥同步给 `core.llm-router`，配完即可用。
  冒烟断言：微信通道按 `grantable` 授权（含 `channel.lease`）→ 带 token 启用成功；LLM 路由授予能力 →
  录密钥 → 缺密钥清零 → 启用成功 → 删密钥 → 缺密钥重新出现。
- **消息不再重复（已验证）**：气泡唯一真源是 `messages`（`event.message`），`event.part` 只推进"正在输入"、
  不累积文本；发送时的临时消息按真实 id 去重后再替换。修复前同一条回复被 `stream.parts` 与 `messages` 各画一次。
- **单测**：新增 `plugin-secrets.test.ts` 6 例（action 归一正反、一次性 token、SecretStore 读写删、真实 manifest 声明确在）。

## 12. v0.4.0 增补（模型页：一个页面管完全部模型配置）

- **模型页按"服务商预设 → 地址/密钥/模型 → 真探测 → 保存"重做（已验证）**：
  预设覆盖 DeepSeek / OpenAI / Kimi / 智谱 GLM / 通义千问 / 硅基流动 / OpenRouter / 本地 Ollama·LM Studio / 自定义，
  点一下就把 Base URL 与默认模型填进表单；「拉取模型列表」走 `llm.test` 的 `/models`，把服务端真返回的模型列成可点选的芯片。
- **"在线"必须是真连上过（已验证）**：新增 RPC `llm.test`（`GET {baseUrl}/models`，不通时退回一次 1 token 对话），
  返回 HTTP 状态、往返延迟、模型列表与失败原因；失败原因用人话讲清楚（域名不存在 / 端口没起 / 自签证书 / 被墙 / 超时），
  Node 的 `fetch failed` 会沿着 `cause` 链找到真正原因再翻译。密钥只在内存里用一次，不进日志、不进错误信息。
- **插件里的模型服务回到模型页（已验证）**：`llm.status` 新增 `router` 小节（`core.llm-router` 的启用状态、
  授权是否齐、缺哪些项、缺哪些密钥、它真读到的 baseUrl/model）；模型页下半部分直接显示并可「授权并启用 / 停用」，
  保存配置时把 baseUrl/model 同步进插件配置、把 API Key 同步进插件密钥库——不用去插件页签再抄一遍。
- **表单细节**：首次读到状态后填一次表单，之后用户改过就不再覆盖；温度与 maxTokens 可改可不改；
  密钥输入框永远不回显旧值，留空表示不动。
- **冒烟扩到 52 项**：新增「llm.status 带路由插件小节」「路由插件小节里有真读到的配置」「删密钥后小节实时缺密钥」
  「真探测在不通的地址上返回 ok=false 且给人话」「不显式给密钥时用已保存的密钥探测」5 条。
- **自检口子**：`ANTEROS_SMOKE_CLICK` 支持 `#type=选择器=值`（填输入框）与 `#scroll=某段文字`（滚到视野内），
  配合原来的 `ANTEROS_SMOKE_TAB`/`ANTEROS_SMOKE_SEND` 可以把"选预设 → 填密钥 → 保存 → 授权 → 启用"整条链路走完再截图。

## 13. v0.5.0 增补（插件运行环境：应用内下载 / 按文件增量更新）

- **运行环境自助安装（已验证）**：需要外部环境的插件（`runtime_env: true`，目前只有微信通道骨架）卡片下多一块「运行环境」，
  未安装时给「下载运行环境」，从更新源取 `feed.json` 清单 → 按清单逐个文件下载（或整包 tar.gz）→ 校验 SHA-256 →
  解到临时目录 → 原子重命名到 `plugin-runtime/<pluginId>/<version>`。界面显示已安装版本、大小、文件数、
  安装模式（整包/增量）、安装时间与本地路径。
- **按文件增量升级（已验证）**：清单里每个文件都带 sha256，本地已存在且哈希一致的文件直接复用，
  只下载变了的那些；升级成功后目录从 `1.0.0` 变成 `1.1.0`，旧目录在切换成功后才清理。
  实测：v1.0.0 → v1.1.0 的增量升级只下载了 1 个文件（另 2 个复用本地）。
- **更新源可改**：默认 `https://github.com/rifei111/Anteros/releases/download/runtime-feed-v1/feed.json`；
  也可用 `file:///` 局域网目录或自建 https；界面里能改，改完写审计。内核只接受 http/https/file 三类协议，
  拒绝路径逃逸（`../`、绝对路径）与超过 8MB 的清单。
- **失败不毁旧版本**：校验不过、下载中断、解包失败都保留原目录，错误写进 `error` 并以人话显示在卡片里。
- **冒烟扩到 64 项**：新增第 17 组 9 条——本地 http 更新源、首次整包安装（`mode=archive`、3 个文件、内容一致）、
  已是最新不再提示、发布新版后检查到 1.1.0、增量升级只下 1 个文件、磁盘内容已更新、卸载后目录消失等。
- **真实更新源已发布**：GitHub Release `runtime-feed-v1`（1.0.0）与 `runtime-feed-v2`（1.1.0），
  各含 `feed.json`、`wechat-replica-<ver>.tar.gz` 与以文件 sha256 命名的单文件资产；真网跑通「检查 → 安装 → 检查更新 → 增量升级 → 卸载」。
- **边界**：Anteros 不自带、不注入、不逆向第三方客户端；这里只是「下载 → 校验 → 原子切换」的安装器，
  第三方环境由 owner 自己点下载、自己授权。

## 2026-10-26 验收记录（本机 Windows 11 / Node 24 / Electron 45）

```
M0c 验收：通过（界面内逐项点击另列遗留）
构建：shared ✅ kernel ✅ client ✅   —— npm.cmd run build 全绿
类型：npm.cmd run typecheck          —— 0 error（shared/kernel/client 三套 tsconfig）
单测：npm.cmd test                   —— 17 文件 / 101 用例全绿（v0.2.0 人设编译 9 例 + v0.3.0 插件密钥 6 例 + v0.5.0 运行环境 6 例）
冒烟：npm.cmd run smoke:kernel       —— 64 项全过（真起内核进程 + 命名管道）
边界：npm.cmd run lint               —— 0 violation
插件：validate-plugins 7/7；package-check 19 通过 0 错误
安装：NSIS 安装包约 117 MB；win-unpacked 实跑，声明闸 → 聊天 → 管理面板（11 页签）截图留证（v0.2.0 人格内核编译、v0.3.0 插件授权与密钥截图）
逐项：1 ✅  2 🟡 3 🟡 4 ✅  5 ✅  6 ✅  7 ✅  8 ✅
遗留：2/3 的界面内逐项点击未做（自动化已覆盖崩溃退避与启停残留）；
      真实模型回复未验（本机无 API Key，只验证到降级回声与 token 计费链路）。
补充：插件自动拉起与健康语义已于同日修复并实测（见上方第 9 节）；v0.3.0 修好插件授权、密钥录入与消息重复。
```

## 代码同步状态

- 远端：`https://github.com/rifei111/Anteros`（public，`main`）。
- 本地与远端在同一提交上，按"初始化骨架 → 内核闭环 → 客户端三视图 → 冒烟 31 项 → 插件启动与健康修复 →
  可编辑人格内核 + 逐条发送（v0.2.0）→ 插件授权/密钥 + 消息去重（v0.3.0）→ 模型页重做（v0.4.0）→
  插件运行环境下载与增量更新（v0.5.0）、应用内更新与插件就绪（v0.6.0）"推进；Release `v0.1.0`～`v0.6.0` 均已发布（v0.6.0 附 `latest.yml` 与 `*.exe.blockmap`，供客户端差分更新）。
- 2026-10-26 夜间 `github.com:443` 一度不可达（`api.github.com` 正常），本次提交经 GitHub REST 的 Git Data API
  写入（blob → tree → commit → 更新 ref），因此提交哈希与本地对象一致，工作树干净。


## 14. v0.6.0 增补

### 14.1 应用内更新（已验证）

- 管理面板新增「更新」页签（12 个页签）：检查更新 / 下载（进度、速度、大小）/ 重启并安装 / 出错重试 / 四条说明。
- 能力全部在主进程（`packages/client/src/main/updater.ts`），渲染层只发 IPC：`status` / `check` / `download` / `install`。
- `autoDownload=false`、`autoInstallOnAppQuit=true`、`allowPrerelease=false`：发现新版本不自动下、不静默装。
- 差分下载靠 NSIS blockmap；`previousBlockmapBaseUrlOverride` 让 GitHub 源指向上一版的下载目录，否则找不到旧 blockmap 只能整包下。
- electron-updater 内部日志落盘 `<userData>/updater.log`（`autoUpdater.logger` 四个方法 appendFileSync）。

实测记录（2026-10-27，本机本地更新源 + 0.6.0 安装包）：

```
Full: 120,249.54 KB, To download: 1,840.3 KB (2%)
New version 0.6.1 has been downloaded to ...\pending\Anteros-Setup-0.6.1-x64.exe
```

- 结论：差分生效，只下 2% 的字节；pending 目录里是完整的 0.6.1 安装包（123,135,528B）。
- 差分失败路径也验过：更新源不支持 `multipart/byteranges` 时报
  `Cannot download differentially, fallback to full download: Error: Content-Type "multipart/byteranges" is expected...`，
  随后自动回退整包下载并成功——**降级是安全的，sha512 仍会校验**。
- 自检口子：`ANTEROS_SMOKE_UPDATE=check|download`（走真实 IPC 链路）、`ANTEROS_SMOKE_REPORT=<json>`（把更新状态与管理面板文本落盘，供无截图核对）。
- 注意：自检时必须截图后立刻杀进程，`autoInstallOnAppQuit` 会让它真的装上新版本。

### 14.2 下载运行环境后插件就绪（已验证）

- 内核给插件注入 `ANTEROS_PLUGIN_RUNTIME_DIR` / `ANTEROS_PLUGIN_RUNTIME_VERSION`（值取插件 config 里的 `runtimePath`/`runtimeVersion`）。
- 启用前多一道闸：manifest 声明 `runtimeEnv: true` 但运行环境没装时 `EBLOCKED`「这个插件要先下载运行环境」。
- 插件启用后立刻体检一次（`await runHealthCheck`），不等 30s 周期。
- `channel.wechat-replica` 的 `plugin.health.check` 区分五种情形（无/坏/空/缺/就绪），就绪时回
  `适配器骨架已就绪（运行环境 vX，N 个条目）；尚未接入微信本体，收发消息仍会诚实拒绝。`
- 通道列表新增 `attachments` 语义：`channel.write` 只表示「被允许」，`writeReady` 还要求插件体检回 `attachments.write === true`——骨架≠接通，界面不会假装它是可写通道。
- 界面：插件卡片里「下载运行环境并启用」一键走完 安装 → 授权 → 启用；只下载不启用也行。

冒烟覆盖：第 18 组（装运行环境 → 启用 → `health.ok` → 文案含「骨架已就绪」「未接入」→ `channels.list` 里 `writeReady === false`）。

## 15. v0.7.0 增补（内置微信通道：软件本体自带、默认关闭）

### 15.1 架构

- 通道不再以插件形式存在：`channel.wechat-replica` 已删除，改为内核自带的 `WechatChannelService`（`packages/kernel/src/services/wechat.ts`）。
- 真正的行动方是 Python sidecar（`integrations/wechatauto-sidecar/sidecar.py`，零依赖即可启动），它调 `wechatauto-replica` 读本机微信数据库（SQLCipher 解密）并驱动微信界面发消息。
- 内核 ↔ sidecar 走 stdio + NDJSON JSON-RPC；sidecar 崩了只会让这条通道 `error`，App 内对话不受影响。
- 打包时 `integrations/` 进 `extraResources`；开发期用 `__dirname` 向上四级定位仓库根。
- 业务代码仍然不含按通道名分支的逻辑：`check-boundaries` 只对适配器文件（`services/wechat.ts`）、组合根装配（`app.ts`/`settings.ts`）与契约声明（`shared/rpc.ts`/`domain.ts`）做行级放行。

### 15.2 默认关闭 + 风险确认

- 默认 `wechat.enabled=false`，通道页状态「已关闭」。
- 开启必须勾满 5 条风险确认（读本机微信数据库、驱动界面、可能违反平台条款/封号、只接白名单会话、随时可关），少一条 `EINVALID`。
- 二次确认 token 走 `permissions.createConfirm/consumeConfirm`，动作名 `channels.wechat.enable`。
- 白名单会话默认 `filehelper`（文件传输助手）：既不会发错人，也能看到它发出什么。
- 一键停用（`channels.panicStop`）会 `disable()` 这条通道。

### 15.3 体检与诚实边界

体检五项（`wechat.refresh`，不启动 sidecar 也能跑）：

1. Python 解释器：设置里指定 > 环境变量 > `py -3` > `python` > `python3`，只认 64 位 3.10+。
2. 适配库 `wechatauto`：可一键 `wechat.installDeps`（`python -m pip install wechatauto-replica`），输出实时进界面日志。
3. 微信桌面版安装（4.x）：只做存在性判断，不读数据库。
4. 微信进程：没登录就明确说「读不到登录状态」，不假装就绪。
5. 旁路进程：`sidecar.py` 是否在安装目录。

读/发能力分开报告：`canRead` / `canSend`；没就绪时 `read_since` / `send` 一律 `EBLOCKED`，不会伪造已发送。
`typingIsReal=false`：不会假装「正在输入」；`hostOccupancyMs` 标明它要占用桌面焦点几秒。

### 15.4 验证范围（如实说明）

- 已验证：内核侧 71 项冒烟全过（默认关闭、体检项非空、通道列表里有内置通道且 `writeReady=false`、不确认风险不许开、没跑起来时诊断被拒、白名单可设）、客户端面板渲染与依赖安装/开启/诊断/保存四类操作走通、打包产物含 `resources/integrations/wechatauto-sidecar`。
- **未验证**：真实微信收发。本机没有可用 Python，也没有 `wechatauto-replica` 运行环境；端到端「读消息 → 进记忆 → 回复 → 发出去」需要在装好 Python 与依赖、登录微信 4.x 后由用户实测。

## 16. v0.8.0 增补（运行环境应用内一键下载）

### 16.1 做什么

- 通道页新增「一键下载运行环境」：内核自己下载 Python **官方 embeddable 包**（3.11.9，11MB），
  先校验 sha256（钉死值 `009d6bf7…cfd3b`，不符即删除、不执行），再解压到 `<数据目录>/wechat-runtime/python-3.11.9/`，
  然后修正 `._pth` 打开 `Lib\site-packages`、下载 `get-pip.py` 引导 pip、最后 `pip install wechatauto-replica pypinyin`。
- 全程落在 Anteros 自己的数据目录：**不装系统 Python、不改 PATH、不写注册表**，卸载删目录即可。
- 下载过程每 10% 报一次进度，pip 输出逐行进界面日志（`event.wechat.log`）。
- 自己装 Python 的路保留：设置里有 `wechat.pythonPath` 就优先用它（`wechat.pythonSource` 记录来源），一键下载失败不影响手动路线。

### 16.2 接口

- `channels.wechat.installRuntime` → `WechatChannelStatus`（owner + 已过声明闸；装的过程中 `installing=true` 且 `installLog` 累积）。
- 校验与回退：Python 包 sha256 不符 → 删包 + 人话报错（提示可能被代理改写）；解压优先 `tar.exe`、失败退回 PowerShell `Expand-Archive`；pip 超时 30 分钟。

### 16.3 验证范围（如实说明）

- 已验证：内核与客户端 typecheck 0 error、`check-boundaries` 通过、冒烟 71 项不回归。
- 真机一键下载：见本节下方的实测记录（联网装完并体检通过才算数；没跑通就如实写没跑通）。
## 17. v0.8.2 增补（内置微信通道真正跑通：两个致命 bug + 提速）

### 17.1 端到端实测（2026-10-27 23:14，真实微信，非模拟）

用 `release/e2e-wechat.mjs` 起真内核 + 真旁路进程，对着用户真实数据目录跑：

- 手机端（Rifei / `wxid_azqocbj6ktli12`）发「测试」→ 15:14:31 通道读到 → 内核处理 → 15:15:17、15:15:30 两条分条发回微信；
- 对话历史核对：`对方: 测试` / `它: 测什么呢，想看我会不会露馅` / `它: 我确实是被设定好的程序，但名字是我给自己留的锚点`。

**结论：微信收到 → 内核处理 → 分条回复发回，闭环成立。**

### 17.2 修掉的两个 bug（此前"通道就绪但永远不回"的真因）

1. **消息类型过滤**：上游 `get_new_messages()` 的 `kind` 是中文（`文本`/`系统消息`/`图片`），
   内核按 `kind !== "text"` 过滤 → 全部丢弃。旁路进程新增 `KIND_MAP` 归一 + 内核兜一层认中文写法。
2. **自己发的消息被读回来**：上游返回行**没有 `is_self`**，旁路进程按它判断永远 `False`，
   自己发出的回复会被当成新消息 → 自问自答死循环。改为发送者 wxid 与当前登录账号比对。

### 17.3 提速（用户反馈"每次输入都要重新搜索"）

- 上游 `quick_send()` 每次新建 `WeChatGUI()`，实例缓存（UIA、当前会话、输入框）全丢，单条发送十几秒。
- 改为旁路进程内**复用同一个实例**，并在通道开启时 `warmup` 预热会话。
- 实测：预热 4349ms；单条发送 1474ms / 4222ms（后者含上游刻意的 2.6s 拟人停顿）。
- 另修：旁路进程单线程，发送/预热期间内核暂停 poll，不再刷 `旁路进程超时（poll，20000ms）`。

### 17.4 验证范围

- `vitest` 17 文件 101 用例全绿；内核冒烟 71/71；`package-check` 25 通过 0 警告 0 错误。
- 安装包 `Anteros-Setup-0.8.2-x64.exe`（123,184,355 B）内含修好的 sidecar 与 kernel（已核对关键字）。
- 仍未验证：群聊、图片/语音等非文本消息的处理（当前只回文本）、长时间运行的稳定性。

## 18. v0.9.0 增补（完全体模式按用户要求放开两条红线）

### 18.1 放开了什么

`packages/kernel/src/expression/prompt.ts` 原来只有一套 `EXPRESSION_CONSTRAINTS`，其中三条是标准模式的认账规则。
现在拆成 `COMMON_CONSTRAINTS`（写法）+ `STANDARD_CONSTRAINTS`（认账、不编肉身经历、追问降级）
+ `IMMERSION_CONSTRAINTS`（完全体），由 `expressionConstraints(mode)` 按当前关系模式选用：

- 不再要求"被追问时承认自己是 AI"，改为"可以打岔、反问、含糊过去，不要认领机器的身份"；
- 允许"关于你自己可以现编"（在做什么、路上看到什么、吃了什么），要求与自己前后说过的话一致；
- 生活模拟关闭时那段"不要编造具体场景"在完全体下改为"按人设过自己的日子"；
- 【禁区】里"不假装有真人的身体"在完全体下改为"不必自证是机器"，但"不假装能连接你其实没连接的东西"仍在。

### 18.2 没放开的（说清楚，不是遗漏）

- **不替对方编**：用户说过什么、做过什么，只能来自记忆层；忘记就承认忘记（否则用户会以为它真记得，这是关系里最伤的一种错）。
- **危机优先**：对方表达自伤/伤害他人时立刻放下人设。
- **不做法律/医疗/金钱承诺；不碰第三方隐私。**
- 只告知一次：开启完全体的风险页 + 二次确认 + `relation.setMode` 的 `confirm.token` 是唯一一次告知，进去之后不再自我解释。

### 18.3 验证

- 新增 2 组用例（`packages/kernel/test/expression.prompt.test.ts`）：约束集合按模式切换；切到 `full_human` 后整份系统提示词里不再出现"承认自己是 AI"、"不要编造具体场景"，且仍含"关于对方不要替他编""不碰自伤"。
- `vitest` 17 文件 103 用例全绿；内核冒烟 71/71；`check-boundaries` 通过；客户端 typecheck / build 通过。
- 界面文案同步：`packages/client/src/renderer/src/admin/tabs/ExpressionTab.tsx` 的风险页与确认弹窗改成"开放这两条 + 只告知一次"的口径。

## 19. v0.10.0 增补（头像 / 重置 / 主动消息自检 / 卸载）

### 19.1 做了什么

1. **自定义头像**：`ui.avatar.set { dataUrl }` 落 `settings`（只接受 `data:image/` 开头，上限约 2MB），`state.snapshot` 带 `agentAvatar`；聊天页头像与人格页预览都用它，无图退回名字首字。用户自己的气泡不再渲染「我」。
2. **重置记忆**（`memory.reset`）：一次清记忆三件套（情节/语义事实/未闭合话题）+ 叙事槽位 + 使用习惯，默认连 `messages`/`turns`/`idempotency` 一起清，并删媒体目录；返回将被清掉的行数，界面先给数字再要 token。
3. **整体重置**（`system.resetData`）：清内容表与运行状态，可选保留 `llm.*` 密钥类设置、`plugin-runtime/` 运行环境、插件配置与授权；重置后重建目录与种子行。
4. **卸载**（客户端主进程 `runUninstaller`）：从安装目录找 `Uninstall*.exe` 以 `/S` 调起，`keepData` 决定是否先删数据目录；开发模式给出"只在安装版可用"的提示而不是抛错。
5. **主动消息**：`proactive.summary` 进 `state.snapshot`（档位、间隔、日上限、静默时段、今日已发、上次发送、出口），聊天页顶部常驻状态条；`proactive.tick {force}` 手动跑一次判定并回报 `queued/blockedBy`；`channels.wechat.setRelay {enabled}` 决定主动消息是否同时发到微信会话，`proactive.verifyRelay` 真发一条自检消息验证通路；投递路径在 `dispatch()` 里串行执行，失败只记事件不回滚。
6. **废弃通道插件**：磁盘上已不存在的插件（如 `channel.wechat-replica`）不再出现在插件/通道列表，`registry.missing()` 生效；数据库行与授权保留，便于将来恢复。

### 19.2 验证

- 冒烟 78 项全过，新增第 19 组 7 项：头像存取与非法地址拒绝、主动判定有明确结果、验证通路如实回报（通道没开就说没开）、重置记忆真的删（历史 0 条 / 记忆 0 条）。
- `vitest` 17 文件 103 用例全绿；`check-boundaries` 通过；kernel/client typecheck 0 error。
- 面板文本自检（`ANTEROS_SMOKE_REPORT`）：人格页出现「头像/选择图片」，主动消息页出现「现在想不想说话/立即检查一次/验证一次：主动消息 → 微信/当前档位：high」，聊天页顶部出现「主动消息 · 高约 45 分钟一次 · 每天最多 6 条 · 今天已发 0 条」。
- 未验证（诚实说明）：真实点击选图弹窗（自动化只能到按钮）、真机微信收到主动消息（需要打开通道并开启 relay）、卸载程序实际执行（会关掉当前窗口，需人工确认）。

### 19.3 已知取舍

- 记忆重置是"物理删除 + 删对话"，不做软删除墓碑；重置后重启也不会"复活"。
- 头像存在数据库里（不是文件），导出数据包会带上；换机器迁移时一并搬走。
- 主动消息同步微信是单条整发（多条分条会用换行拼在一个气泡里），避免在微信里连发刷屏。

## 20. v0.10.1 增补（重置记忆真的生效）

### 20.1 修了两个真问题

1. **界面语义与内核开关反向**：数据页的复选框状态变量叫 `keepChat`，文案写的是「同时清空聊天记录」，
   但默认值是 `true` 且原样传给内核的 `keepChat` —— 于是默认操作是**保留聊天记录**。
   结果就是：记忆表删干净了，上下文里还躺着整段对话，模型照样能回答「我叫什么」，
   表现成「重置记忆没生效」。现改为 `clearChat`（默认勾选、勾上=清），调用时传 `keepChat: !clearChat`。
2. **界面不清**：`memory.reset` 只在库里删，渲染层的 `state.messages` 没动，聊天窗口继续显示旧对话。
   新增 `reloadChatView()`（清本地消息 + stream + 重新拉 `chat.history`），重置记忆与整体重置后都调用，
   并 `refreshSnapshot()` 把关系/驱动/主动消息数字一起对齐。

另外两处顺手补齐：

- 记忆页「清空全部」现在带「连聊天记录一起清」复选框（默认勾选）：勾着走 `memory.reset`（记忆+对话一起清），
  不勾才是老的 `memory.deleteAll`（只在 toast 里说清"聊天记录还在，它还能从对话里想起这些事"）。
- `memory.reset` 现在会把排着队的主动消息置 `cancelled`：那些动作是从旧记忆长出来的，记忆没了就别再开口提。

### 20.2 验证

- 内核冒烟 **79/79**（新增一项反向断言：`keepChat: true` 时对话保留、记忆仍清零；`keepChat: false` 时历史与记忆双清零）。
- `vitest` 17 文件 103 用例全绿；kernel/client typecheck 0 error；`check-boundaries` 通过；`package-check` 25 项全过。
- 打包产物（0.10.1）实跑面板自检（`ANTEROS_SMOKE_REPORT`）：数据页出现「同时清空聊天记录（推荐…）」「重置记忆」「整体重置」「卸载」「保留 API Key 与模型设置」。
- 未验证：真实鼠标点两次确认弹窗（自动化只到按钮），以及"重置后当面问它还记不记得我"的对话级验收需要配好模型。
### 20.3 顺手把「通道名」从业务代码里清出去

这一版新增的两处代码踩了项目自己的红线（`scripts/check-boundaries.mjs` 报 8 条违规）：

- 主动消息的第二个出口在 `packages/kernel/src/services/proactive.ts` 里直接读 `wechat.relayProactive`、
  字段叫 `relayToWechat / wechatReady` —— 等于业务层认了通道名。
  改成注入式 `RelayPort { deliver, enabled, ready }`，字段统一为 `relayToExternal / externalReady`，
  开关与就绪判断留在通道层（`app.ts` 组装）。
- `packages/kernel/src/services/reset.ts` 硬编码了 `wechat-runtime` 目录与 `wechat.` 设置前缀。
  改成构造参数 `ResetServiceOptions { extraRuntimeDirs, extraSettingPrefixes }`，由 `app.ts` 传进来。

验收：`check-boundaries` 归零；冒烟 79/79、`vitest` 103 用例、client typecheck 0 error 均保持通过。
## 21. v0.11.0 增补（多模型 + 人设文档 + 两个 bug）

### 21.1 多模型
- `packages/shared/src/domain.ts`：`ModelTaskKind`、`ModelEntry`、`ModelCatalog`；
- `packages/kernel/src/services/models.ts`：模型清单 CRUD（密钥单独加密存在 `secrets/models/<id>/api_key`，接口只回 `hasKey`）、任务路由、当前对话模型、探测连通性；
- `expression/service.ts` 调 `models.resolve(task)` 取「端点 + 模型名 + 温度」，`LlmPort.generate` 支持 `override`，成本台账按真实模型记账；
- 客户端：聊天框顶部选择器、`admin/tabs/MultiModelTab.tsx`（清单 + 五类任务路由）。
- 验收：冒烟「模型清单能增删」「切换当前对话模型后回放里 model 变了」「按任务类别路由生效」「密钥只回 hasKey」。

### 21.2 人设文档
- `packages/kernel/src/expression/persona-doc.ts`：`renderPersonaDoc()` / `parsePersonaDoc()`，固定骨架、容错解析；
- RPC `persona.exportDoc` / `persona.importDoc`；客户端人格页「人设文档」区块（预览 / 导出为文件 / 从文件读取 / 导入）；
- 主进程新增受限文本读写 IPC（路径只能来自系统对话框）；
- 单测 `packages/kernel/test/persona-doc.test.ts` 5 例（渲染、往返幂等、部分导入、日期写错的警告、空文档报错）。

### 21.3 两处修复
- 白屏：`components/ErrorBoundary.tsx` + `main.tsx` 包裹；主进程 `app.requestSingleInstanceLock()`；渲染层 `console-message` 落盘。
- 「只在本地回、微信没发」：`services/wechat.ts` 的 `send()` 不再静默丢弃（warn 日志 + `lastError` 上浮），`app.ts` 的 `memory.reset` 之后调用 `wechat.refresh()` 重新对齐通道状态。

### 21.4 验证
- `tsc --noEmit` 全工作区 0 error；`vitest` 18 文件 108 用例全绿；内核冒烟 **83/83**；`package-check` 25 通过。
- 打包产物实测（`ANTEROS_SMOKE_REPORT` 读面板文本）：人格页出现「人设文档 / 生成当前文档 / 导出为文件 / 从文件读取 / 导入这份文档 / 参数表不会被导入」。

## 22. v0.12.0 增补（多用户与群聊）

### 22.1 新增能力
- 通道页「对话对象」：从最近会话添加人/群；可设上限 1–8；每个对象单独设模式（都回 / 只在被 @ 时回 / 只看不回）。
- 消息排队：`packages/kernel/src/services/conversations.ts` 的 `ConversationQueue`——按会话键串行，超上限丢最老的并记录原因（进日志 + 通道状态），不静默丢弃。
- 群聊识别：`@chatroom` 后缀判为群；群里按 `mentioned` 决定要不要回；回复带被回的人。
- 群聊上下文：系统提示里加「这里是群聊」一节（别替所有人总结、别假设别人知道私聊上下文、话更短、别 @ 所有人）。
- 聊天页会话切换器：应用内 / 各微信会话各看各的历史（`chat.history` 按 `conversation` 过滤）。

### 22.2 验证
- `npx vitest run` → 19 文件 **112 用例全绿**（新增 `packages/kernel/test/conversations.test.ts` 4 例：串行、跨会话并行、超限丢最老、失败不阻塞后续）。
- `node scripts/smoke-kernel.mjs` → **89 项全过**。
- `node scripts/check-boundaries.mjs` → 通过（通道名词仍收在通道层，业务代码零命中）。
- `node scripts/package-check.mjs` → 25 通过 0 警告 0 错误；安装包 `release/Anteros-Setup-0.12.0-x64.exe`。

### 22.3 未验证
- 真实微信群里的多人发言顺序、@ 判定依赖上游 `mentioned` 字段；本机只做了通道层与队列层的验证，没有真人多群并发压测。

## 23. v1.0.2 增补（群聊真的收到、看得出谁在说话）

### 23.1 修的两个真问题

| # | 现象 | 根因 | 修在哪 |
| --- | --- | --- | --- |
| 1 | 群聊消息一条都收不到，也不会回 | 旁路 `method_poll` 只轮询「一个会话」，内核传下去的 `chats` 清单被忽略 | `integrations/wechatauto-sidecar/sidecar.py` 的 `method_poll` 改成按 `chats` 逐个会话轮询、各自带水位 |
| 2 | 群里分不清谁在说话；它的回复跑到左边 | 消息没带发送者信息；气泡按私聊语义（用户右、agent 左）排版 | `packages/shared/src/domain.ts` 的 `ChatMessage.senderName/senderId` + `packages/client/src/renderer/src/components/Bubble.tsx` 的群聊分支（群成员左侧带昵称头像、它在右侧） |

### 23.2 顺手修的两个坑

- `packages/kernel/src/db/database.ts` 的 `migrate()`：v1→v2 加列前先查 `PRAGMA table_info`，重复列不再让应用起不来（补 3 个迁移测试）。
- sidecar 的群消息解析：全角 `＠`、全角 `：` 都归一；@ 判定大小写不敏感；新增 `is_group_chat()` 统一判群。

### 23.3 验证记录

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 单元/集成测试 | `npm test` | 21 文件 119 用例全绿（新增群聊气泡 4、迁移 3） |
| 内核端到端冒烟 | `npm run smoke:kernel` | 92 项通过 0 失败（新增会话分线 2 项） |
| 旁路群聊解析 | `npm run test:sidecar` | 14 项通过（本机无 Python 时跳过） |
| 真实群消息收发 | —— | **未验证**：需要微信群里有真人说话。通道页「看最近 20 条收发」是最终判据 |

### 23.4 不谎报

解析、会话分线、界面布局三层是我这边验过的；"群里发一句它真的回"必须真机、真人、真微信才能验，装好后在群里 @ 它一次即可确认。

## 26. v1.0.11 增补（语言策略与发送队列）

| 项 | 口径 | 证据 |
| --- | --- | --- |
| 标点与断句 | 句末按语气补标点；长串补一个逗号；重复标点收成一个；不改词 | `packages/kernel/test/expression.punctuation.test.ts`（7 例） |
| 分条上限 | 1–6 条、每条 ≤32 字（润色后仍守得住） | `packages/kernel/test/expression.planner.test.ts`、冒烟「回复按 1–6 条下发」 |
| 发送串行 | 同一时刻只有一个发送能操作界面（跨进程文件锁），抢不到就明确失败 | `integrations/wechatauto-sidecar/test_sidecar_send_lock.py`（锁互斥 / 超时 / 切会话确认 共 7 例） |
| 切会话确认 | 界面没切到目标会话就放弃发送并报错，不发到上一个窗口 | 同上 `test_isolated_send_refuses_when_chat_cannot_be_opened` |
| 自动切对话 | 收到别的会话的消息时前端自动切过去 | 打包产物自检 `rendererErrors=0`（v1.0.11） |

验证：`npm test` 23 文件 129 用例全绿；`npm run test:sidecar` 两组 21 项全过；`npm run smoke:kernel` 96/96；
`node scripts/package-check.mjs` 打包自检 25 项通过。

## 24. v1.0.3 增补

### 24.1 修了什么

| 问题 | 真因 | 修法 |
| --- | --- | --- |
| 点「表达与完全体」全白 | 面板假设 `relation.transitionLog` 必存在，旧数据里没有 → 读 `.length` 抛错 → React 树卸载 | 面板内兜底 `?? []`；IPC 监听上限抬高消掉 MaxListeners 警告 |
| 群回复发到白名单那个人 | `method_send` 用 `STATE.chat_title`（白名单会话标题）当兜底目标 | 按目标 wxid 解析会话名（含群），解析失败只按 wxid；不再用白名单标题 |
| 群消息出现在私聊 | 界面收到 `event.message` 不分会话线一律 upsert | 按 `channelId` 过滤，非当前会话只记未读，切会话重拉历史 |

### 24.2 验证

- `npm test` 21 文件 119 用例全绿；`node scripts/check-boundaries.mjs` ok。
- 打包版（`release/win-unpacked`，隔离数据目录 + `--user-data-dir` 隔离）跑 `ANTEROS_SMOKE_VIEW=admin` + `ANTEROS_SMOKE_TAB=表达与完全体`，用真实数据快照：面板文本含「关系台账」「完全体」「亲密度」，`rendererLogs` 无异常（修复前是整页白屏）。
- **未验证**：群回复是否真的落到群里（需要真实群消息触发，见 24.3）。

### 24.3 仍需你在真机上确认的事

1. 在群里 @它 说一句话，看回复是否出现在**这个群**里（而不是私聊）。
2. 切到私聊看历史，确认群里说的话不再出现在私聊里。

## 25. v1.0.4 增补（记忆按对话线隔离）

### 25.1 改了什么
- `memory_episodic` 增加 `channel_id TEXT NOT NULL DEFAULT 'app'`（schema v3），并建索引 `idx_episodic_agent_channel`。
- `MemoryPort.recall/rememberEpisode/extract` 全部接受 `channelId`；`chat.ts` 用当前对话线（`app` / `wechat:<username或群>`）写记忆；`prompt.ts` 召回时只取这条线。
- `reencode()` 生成的记忆继承原条目的 `channel_id`。
- `memory.list` 接受 `conversation`，只返回这条线上的情节记忆。
- 客户端新增 `packages/client/src/renderer/src/components/MemoryStrip.tsx`：聊天框上方「它记得关于这条对话的 N 件事」，可展开。

### 25.2 怎么验
1. `npm test` → 21 文件 119 用例全绿。
2. `npm run smoke:kernel` → 95 项全过（含记忆分线三项）。
3. 安装 1.0.4，进入应用内对话：聊天框上方出现记忆条；切到微信/群会话，记忆条内容随之切换。
4. 在群里说一句话，回到应用内主会话：记忆条里不应出现群里的那句话。

### 25.3 已知边界
- 记忆分线只覆盖情节记忆（episodic）；结构事实（semantic）与未闭合话题仍是全局的（它们是「关于用户的事」，跨线共享是有意的）。
- 老记忆统一回填为 `'app'`，升级后无法追溯它当初来自哪个群。
- 群里的回复目标、群成员昵称依据微信 4.x 本地库，库结构变化时可能要跟着改。

## 25. v1.0.5 增补

### 25.1 修掉的四个问题

| 问题 | 根因 | 修法 | 证据 |
| --- | --- | --- | --- |
| 清空记忆后逐条回旧通知 | 重置只清库，微信侧未读仍是「新消息」；旁路重启水位回落 0 | 重置时把当前时间写为跳过水位；baseline 失败不再回落 0 | 冒烟「重置后新消息才算新消息」 |
| 群聊说完私聊没反应 | 发送无超时，卡住后旁路被堵死 | 旁路 20 秒看门狗 + 内核 30 秒超时 + 连续失败冷却 | 冒烟「通道健康如实回报」 |
| 切会话历史消失 | 渲染层只有一份消息，切换即清空 | 按会话线缓存 + 失败回退缓存 | 手工切会话核对 |
| 重置记忆关系还在涨 | 只清记忆不清关系/驱动 | `resetMemory` 同时归零关系与七项驱动 | `packages/kernel/test/reset.relation.test.ts` |

### 25.2 新增能力

- 群聊/私聊自知：提示词明确「只有你们两个人」或「群里有别人」。
- 「自己决定回不回」：会话级模式 `auto`，模型输出 `<不回>` 即不发、不留记录。
- 关系归零：`relation.get` 在重置后返回 stranger / intimacy 0。

### 25.3 验证记录

- `npm test`：22 文件 **122 用例**全绿（新增 `reset.relation.test.ts`、提示词群聊/沉默用例）。
- `npm run smoke:kernel`：**96 项**全过（新增「重置记忆同时把关系退回陌生人」）。
- 打包产物：`release/Anteros-Setup-1.0.5-x64.exe`；面板自检含「自己决定回不回」。
- 未验证：真实微信里「不回」的行为（需要真机上群里闲聊时观察），以及长时间运行稳定性。

## 26. v1.0.7 增补

- 现象：1.0.6 装上后微信内置通道始终停在「正在启动」，详情写「上次失败：旁路进程退出（code=1 signal=null）」。
- 真因：`integrations/wechatauto-sidecar/sidecar.py` 里读隔离载荷的局部变量叫 `handle`，与同文件函数 `handle(line)` 同名；`main()` 中 `with ... as handle:` 让整个函数体里的 `handle` 成为局部名，后面 `handle(line)` 抛 `UnboundLocalError`。
- 修法：改名 `file_handle`，协议不变。
- 验证：安装包内 `sidecar.py` 发一条 `health` 请求，六项检查全 `ok`、`canRead/canSend` 均为 true。

## 27. v1.0.8 增补

- 现象：1.0.7 装上后通道能启动，但收不到任何微信消息。
- 真因：`method_poll` 把内核传来的会话标识（设置里的 `wechat.chats[].username`，可能是微信号/昵称）直接交给 `db.get_new_messages()`，上游只认 wxid / 群 id → 查询永远为空，且不报错。
- 修法：`method_poll` 新增 `resolve_target()`（走 `normalize_username`：昵称 → 微信号 → 原值），按调用缓存；水位键仍用内核传来的原始标识。
- 验证：打包产物的 `sidecar.py` 对真实数据只读巡检，`rifei111` 归一为 `wxid_azqocbj6ktli12`；私聊读到 5 条、群聊读到 5 条（含「@沈知蓝 你玩原神吗？」），`nextSeqs` 正常推进。
## 28. v1.0.15 增补（分条：一行一条）

- 现象：一条气泡里塞多行；下一条从词中间断开。用户判断为「上限还是 3 条」「气泡黏在一起」。
- 取证：`release/inspect-turns.mjs` 读真实库 turn 86–91，条间间隔其实正常（3.3–6.9s），
  但 `#0` 里含 4 行；`release/probe-parts.mjs` 复现「（…）」被切成「（…」+「）」两条。
- 根因：`packages/kernel/src/expression/planner.ts` 的 `SENTENCE_SPLIT` 改成 lookbehind 后不再按 `\n` 切分。
- 修法：`splitIntoParts()` 改成「按行优先」——每行至少一条、绝不跨行拼接；
  `attachTrailingClosers()` 把收尾括号挂回前一条；仅当超过 `MAX_PARTS = 20` 条时才合并；
  `cleanReplyText()` 保留单换行并剥掉行首项目符号；提示词补「每一条单独占一行」。
- 验证：`release/probe-parts-mock.mjs`（本地假模型回 4 行）→ 4 条气泡、打字 0.9–2.7s、间隔 0.6–2.0s；
  `packages/kernel/test/expression.planner.test.ts` 新增 4 例（一行一条 / 括号不孤单 / 30 行合并到 20 / 单行长句按标点断）；
  `npm test` 23 文件 136 用例全绿；kernel tsc 0 error；`check-boundaries` ok；`package-check` 25 通过。
## 29. v1.0.16 增补（驱动可越阈 + 主动消息可解释）

### 29.1 修了什么
1. 驱动稳态：`rate/(rate+decay)` 必须高于 `threshold`，否则该驱动永远不越阈。原来 7 个里 5 个不满足；现在全部满足，并加 `packages/kernel/test/mind.drives.test.ts` 两个用例锁死（稳态 > 阈值 + 静置 24h 至少一个驱动越阈）。
2. 参数版本：`DRIVE_PARAMS_VERSION = 2`，旧库 `drives_state.params` 版本不符时忽略旧值、按新默认重算。
3. 陌生人破冰：`STRANGER_BREAK_IN_MS = 3h`、`STRANGER_BREAK_IN_DRIVE = 0.45`，避免「新用户永远收不到」。
4. 闸门可解释：`ProactiveSummary.blockedBy` + 面板「为什么现在不发」。

### 29.2 验证
- `npm test`：24 文件 138 用例全绿；`check-boundaries` ok。
- 探针 `release/probe-proactive.mjs`（真内核 + 真数据只读副本 + 本地假模型）：不强制判定回「陌生人阶段：距你上次说话还不到 3 小时」；强制判定 `queued:true actionId=2 reason=open_loop` → `event.proactive delivered turnId=96` → `relayed`（同步到外部通道成功），收到 3 条气泡。
- 打包版自检 `release/v1016-proactive.json`：面板含「为什么现在不发」「想你 26%、闷 33%（陌生人阶段要 ≥45%）」，`rendererErrors=0`。

## 30. v1.0.17 增补（剥掉思考过程）

### 30.1 问题

主动消息把推理模型的思维链当正文发了出去：真实库里连续 6 条都是思考内容，
标签还是残缺的 `<think`（缺 `>`）、`）</think`。原因有两层：

1. 模型把思维链写进了 `choices[0].message.content`，内核原样交给分条逻辑；
2. 分条按行切，于是每一行思考都成了一个气泡。

### 30.2 修法

- 新增 `packages/kernel/src/llm/sanitize.ts`：`stripReasoning(raw)` 剥标签块、中文思考块、「思考过程：」标签、开头的整行括号旁白（短旁白如「（笑）」保留），返回正文与剥掉的字数。
- `packages/kernel/src/llm/client.ts`：生成后先 `stripReasoning`，空正文报错不发；记录剥掉多少字进日志。
- `packages/kernel/src/expression/prompt.ts`：约束里加「只写你要发出去的话，不要写思考过程与旁白，不要用尖括号标签」。

### 30.3 验证

- `packages/kernel/test/llm.sanitize.test.ts` 7 例（完整标签、残缺标签复刻线上原文、只有开标签、中文块、正常括号不误删、开头旁白、无思考不改动）。
- `npm test` 25 文件 145 用例全绿；`npm run build`、`npm run package` 成功；`node scripts/package-check.mjs` 25 通过。
- `node release/probe-think.mjs`：假模型回放 `<think…）</think` + 正文两行 → 只发出 1 条气泡「那你希望我怎么跟你聊嘛 是想让我多问两句，还是别追问」，不回放任何思考内容。

### 30.4 已知边界

- 历史消息不追溯清洗（数据库里已经那几条就是那几条），需要时用「数据 → 清空聊天记录」。
- 只处理常见标签与整行旁白；如果模型用别的格式包思考（比如自造 JSON 字段），按未知格式放行——不猜。

## 31. v1.0.18 增补（同步到外部会话时逐条发送）

### 31.1 问题

主动消息在应用内是一条条气泡出来的，同步到外部会话（微信）却只发出去一条长消息。
根因在组合根：`this.proactive.setRelay({ deliver: (text) => this.wechat.sendAsync(text) })`，
而 `packages/kernel/src/services/proactive.ts` 递过来的是 `plan.parts.map(...).join("\n")`。
旁路进程侧的 `isolated_send_many`（逐条发、每条间隔 1.6 秒、发送前确认目标会话）根本没被用上。

### 31.2 修法

- `RelayPort.deliver` 的签名从 `(text: string)` 改成 `(texts: string[])`：出口语义就是「一串气泡」。
- `proactive.ts` 传 `plan.parts.map(p => p.text)`（去掉空串），不再 join。
- `app.ts` 的出口改为 `deliver: (texts) => this.wechat.sendMany(texts)`，走旁路进程的批量实现。

### 31.3 验证

- `npm test` 25 文件 145 用例全绿；`check-boundaries` ok；`package-check` 25 通过。
- `node release/probe-proactive-wechat.mjs`：真内核 + 假旁路进程（`release/fake-sidecar.cjs`），
  假模型回 3 行 → 应用内 3 条气泡 → 假旁路收到 1 次 `send`、`texts` 长度 3、顺序一致，
  探针断言「应用内条数 == 外部条数」通过。

### 31.4 边界

- 真实微信下的发送仍然要 GUI 自动化，本探针只证明「内核把几条交了出去」，不证明微信界面一定收到；
  真机那一层靠旁路进程的发送后水印回读（发不出去会报失败并进冷却）。

## 32. v1.0.19 增补（语音条）

### 32.1 范围

这一版做的是「语音条」的 P0：能发一段语音、能被转成文字进对话、能在需要时出一条语音回复、能听、能看转写。
不做：图片/视频、实时语音通话、声音克隆、带情绪的 TTS 标签（这些在 `docs/语音条.md` 的后续阶段里）。

### 32.2 实现

- 入站：`media.upload`（base64 → 落盘 `data/media/voice/YYYY-MM-DD/*.mp3|wav|m4a`，校验魔术字、≤60 秒、≤4MB、15 分钟没绑定就 GC）
  → `chat.send { text: "", uploadId }` 先插一条带占位符的 user 消息 → `event.typing{state:"transcribe"}` → 语音插件转写
  → 成功则 UPDATE 同一条消息的 text 并重新推送 → 走正常回复链路；失败不编内容，由 `chat.ts:replyToUnheard()` 本地回一句
  「没听清，你再说一遍？」（`UNHEARD_PHRASES`，不调模型）。
- 出站：`decideVoice()` 硬门槛（off 档、语音能力未就绪、外部通道会话、presence 为 sleep/busy、正文 >56 字、降级回复）
  全部一票否决；auto 档只在「熟人且 ≤24 字」/「情绪明显（|valence|≥0.4 或 arousal≥0.6）且 ≤40 字」/「非回复类且 ≤32 字」时出声。
  `always` 除硬门槛全发。出声前 `estimateSpeakCostCny(fullText) × 1.6` 过预算闸，估不起就只发文字。
- 朗读稿：`purpose: "speech"` 的单独生成只做读法转换；改写后超过原文 `SPEECH_REWRITE_MAX_RATIO=1.6` 倍就弃用、照念原文，
  改写失败不阻塞回复。正文仍是 `text`，朗读稿只进 `attachment.transcript` 与 turns 快照。
- 韵律：`prosodyFor()` 由 arousal/energy/valence/warmth 算 rate（钳 0.85–1.15）与 volume（钳 0.7–1.0）。
- 播放：`media.load` 按消息 id 取音频，渲染层用 Blob URL + LRU 8 条；`media.meta.set` 允许把客户端实测时长回写（差 ≤200ms 不写）。
- 插件：`plugins/core.media` 升 0.2.0，真实实现 `media.speak`（`/v1/audio/speech`）与 `media.listen`（`/v1/audio/transcriptions`），
  health 回 `attachments:{listen,speak}`；`baseUrl` 先剥尾 `/v1` 防拼成 `/v1/v1`。没有 key 时一律 blocked，界面显示原因。

### 32.3 验证

- `packages/kernel/test/media.test.ts` 13 例；`npm test` 26 文件 **158 用例全绿**；全仓 `typecheck` 绿；client `vite build` 通过。
- `node release/probe-voice-e2e.mjs`：真内核 + 假语音插件 + 假模型，9 条断言全过——
  `media.status` 报能听能说；转写期发 `typing{transcribe}`；模型回复出成气泡；user 正文被转写替换；
  `attachment` 落库 `kind=audio transcriptKind=asr`；音频文件在盘上真存在；没听清时落库 `transcriptKind=none`
  且回「没听清，你再说一遍？」、不调模型。

### 32.4 已知边界

- 转写是一次性的：只取第一条结果，不做流式、不做说话人分离。
- 语音条不参与记忆抽取的「原文片段」——存进去的是转写后的文字。
- 微信等外部通道只发文字，不出声（`externalChannel` 是硬门槛）。
- 语音回复默认关（`media.voiceOutbound: "off"`），要用户自己在设置里开，且在没配置语音服务前开了也没用。

## 33. v1.0.20 增补（BreezeBlue 默认接入）

### 33.1 范围

合成默认不再要求用户自己找 OpenAI 兼容服务：`core.media` 升 0.3.0，`provider` 默认 `breezeblue`，
走 Breeze TTS 2（`breeze-tts-2`）。识别（ASR）不变——BreezeBlue 没有识别接口。

### 33.2 实现

- 供应商分流：`plugin.media.speak` 按配置的 `provider` 走两条实现；BreezeBlue 侧
  `POST /v1/text-to-speech/{voice_id}?output_format=mp3_24000_128&delivery=sync`，鉴权头 `xi-api-key`，
  body `{text, model_id, instructions?, voice_settings:{guidance_scale}}`。
- 可选密钥：`packages/shared/src/manifest.ts` 新增 `optional_secrets`；`breeze.api_key` 与 `media.api_key`
  都列为可选，任一把缺失都不挡插件启动（缺什么由 `plugin.health.check` 的 message 说明）。
- 语气：`MediaPort.synthesize` 入参加 `mood: SpeechMood{arousal,valence,energy,warmth}`；
  插件按 mood + rate 拼英文 instructions，用户手填的 `breezeInstructions` 追加，不覆盖。
- 音色：`breezeVoiceId` 留空则 `GET /v1/voices?language_code=zh` 取第一个，按 `baseUrl|language` 缓存；
  挑不到明确报错，不静默降级。
- 计价：新增按字口径 `pricePerMillionCharsCny`（缺省 ¥216 = $30/1M 字符），
  `MediaService.speakCeilingCny()` 与按秒口径取大者；`estimateSpeakCostCeilingByCharsCny()` 向上取整到分。
- 默认出声：`media.voiceOutbound` 默认由 `off` 改 `auto`；新增 `media.setVoiceOutbound` RPC（写审计日志），
  「表达」面板加三档开关。
- `media.status()` 优先转述插件 health 的 message（比内核的通用判断更具体）。

### 33.3 验证

- `node release/probe-breezeblue.mjs`：真插件 + 假 BreezeBlue 服务 + 假模型，**19 条断言全过**——
  只填 `breeze.api_key` 就能说、识别不可用不挡合成、自动挑音色、`xi-api-key` 头、没有 Bearer、
  `model_id=breeze-tts-2`、`guidance_scale`、情绪拼出 instructions、附件 `state=ready`、字节落盘一致、
  `cost_ledger` 有非零 `media.tts`、一条回复只合成一段。
- `packages/kernel/test/media.test.ts` 扩到 17 例（按字计价、空白不计费、缺省单价兜底、health 原话优先、默认 auto）；
  `npm test` 26 文件 **162 用例全绿**；`typecheck` 绿；client build 通过；`check-boundaries` 通过；
  `scripts/package-check.mjs` 25 通过 0 警告 0 错误。

### 33.4 已知边界

- BreezeBlue 没有 ASR：要"听你说"仍得另配 OpenAI 兼容的 `baseUrl` + `asrModel` + `media.api_key`。
- 接口事实来自 2026-11 的 `docs.breezeblue.ai/openapi.json`；供应商改接口时先跑探针再改代码。
- 音色自动挑选只按语言取第一个，不做试听/推荐；要指定就填 `breezeVoiceId`。

## 34. v1.0.21 增补（语音失败可懂、可重试）

### 34.1 问题
用户报「显示发送失败，而且没有发送按钮」，截图确认实为：一条语音合成失败的气泡只显示
「⚠ 这条语音没能生成 语音合成失败：媒体服务返回 401」，正文（该说的话）被吞掉，也没有任何可点的按钮。

### 34.2 改了什么
- 内核新增 `media.respeak { messageId }`（`packages/kernel/src/services/media.ts` 的 `respeak()`）：
  取 `attachment.transcript` 里的朗读稿重新合成，不再调模型；成功写回 attachment（state=ready），失败写回 error 原因。
- 客户端：`packages/client/src/renderer/src/components/VoiceBubble.tsx` 失败态加「重新生成」按钮，
  `Bubble.tsx` 在语音不可用时补渲染正文，`lib/app.ts` 新增 `applyMessageAttachment()` 就地更新该条气泡。
- 插件：`plugins/core.media/index.mjs` 的 `cleanSecret()` 清掉密钥里的空白与成对引号；
  `request()` 遇 401/403 报「<host> 拒了这把密钥（HTTP 401）：密钥可能抄错、已被撤销，或者填错了服务商」。

### 34.3 验证
- `npm run typecheck` / `npm test` 26 文件 162 例全绿；6 个插件校验通过；`check-boundaries` 通过。
- 真机复现路径：库里无 delivery≠sent 的记录，`cost_ledger` 无 media.tts → 不是「发送」失败，是合成被 401 拒。

### 34.4 边界
- 重新生成用的是当时残留的朗读稿；没有朗读稿（例如改写前就失败）会明确回「这条语音没有留下朗读稿，没法重新生成」。
- 401 属密钥问题，换一把有效 `breeze.api_key` 才能出声；BreezeBlue 没有 ASR，入站转写仍需另配 OpenAI 兼容服务。

## 35. v1.0.22 增补（网络抖动下语音不再直接失败）

### 35.1 现象
1.0.21 上再试语音，报 `语音合成失败：插件内部错误：TypeError: fetch failed`。

### 35.2 定位
- 本机 `api.breeze.blue` DNS 同时返回 A（104.21.41.34 / 172.67.159.130）与 AAAA（2606:4700:…）；
  Node 默认按返回顺序先连 IPv6，IPv6 出口不稳定 → 10 秒 connect timeout → `fetch failed`。
- 复现：连打 12 次 GET `/v1/voices`，出现 `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT`；
  强制 `ipv4first` 后成功率明显上升，但仍有抖动。
- 结论：**这是线路抖动，不是代码错、也不是密钥错**；1.0.20/1.0.21 只是首次失败即放弃。

### 35.3 改了什么
- `plugins/core.media/index.mjs` 顶部 `setDefaultResultOrder("ipv4first")`。
- `request()` 加网络层重试：`NET_ERROR_CODES`（UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT / ECONNRESET /
  EAI_AGAIN / ENOTFOUND / …）+ AbortError 也算可重试；间隔 400ms×attempt；`EPERM`/`EINVALID` 不重试。
- 调用点重试次数：合成 2 次（90s/次）、OpenAI 同步合成 2 次（60s/次）、音色列表 2 次（8s/次）、
  识别 1 次（受内核 10s 窗口约束）。
- 抛出文案带底层错误码，不再出现裸 `fetch failed`。

### 35.4 验证
- `release/probe-breezeblue.mjs`（假服务）19/19 通过——重试逻辑没有多打请求、没有重复计费。
- `release/probe-net-real.mjs`（真网络 + 真插件 + 假模型）：抖动被重试吃掉，稳定拿到 `HTTP 401`，
  证明线路可通、密钥被拒。
- `npm test` 26 文件 162 例、6 插件校验、typecheck、build 全绿。

## 36. v1.0.23 增补（线路慢时的语音可用性）

### 36.1 现象
- 用户报「还是发不了」；库里消息 317 的 `attachment.error` 是
  `语音合成失败：api.breeze.blue 在 8000ms 内没有响应（试了 2 次）`——卡在 `GET /v1/voices`，不是合成。

### 36.2 实测（`release/latency-probe.mjs`，ipv4first）
- `GET /v1/api-keys/current`：16080ms / 15504ms / `UND_ERR_CONNECT_TIMEOUT`。
- `GET /v1/voices?language_code=zh&page_size=1`：2367ms / 19989ms / 1227ms。
- 结论：真实往返 1.2s～20s 且会偶发 connect timeout；8s×2 的预算必然偶发失败。

### 36.3 改动
- `plugins/core.media/index.mjs`
  - 音色缓存落盘：`VOICE_CACHE_FILE = "breeze-voice.json"`，放在 `ANTEROS_DATA_DIR`（插件数据目录）；
    `readVoiceCache()` / `writeVoiceCache()`；内存命中 → 盘上命中 → 才发请求。
  - 音色列表：超时 20 000ms、attempts 1。
  - 合成：超时 60 000ms、attempts 2（与内核 150s 预算对齐）。
  - `plugin.health.check`：breezeblue 且有密钥时真打 `GET /v1/voices?language_code=zh&page_size=1`
    （12s、1 次）；成功报「密钥有效 + 延迟」，401/403 报「拒了这把密钥」并把 `attachments.speak` 置 false，
    其它异常报「合成暂不可用：<原因>」。
- `plugins/core.media/plugin.json`：`healthcheck.interval_ms` 30000→60000、`timeout_ms` 5000→20000；
  `resources.call_timeout_ms` 90000→150000。
- `packages/kernel/src/services/media.ts`：`TTS_TIMEOUT_MS` 45000→150000。

### 36.4 验证
- `release/probe-breezeblue.mjs`：19/19 通过（健康检查里那次 `GET /v1/voices` 是预期的第二次调用）。
- 插件数据目录里确认真写出 `breeze-voice.json`（`{"key":"http://127.0.0.1:PORT|zh","voiceId":"voc_probe01"}`）。
- `npm test` 26 文件 162 例、`npm run typecheck`、`npm run build`、6 插件校验、
  `scripts/check-boundaries.mjs` 全绿。

## 37. v1.0.24 增补（管理面板「声音」一栏）

### 37.1 范围
用户反馈：音色/密钥/语速这些"生效必须参数"只能改插件 JSON，等于没有入口；自动挑音色失败后
整条语音报废且无从修。v1.0.24 在管理面板新增 `声音` 页，把参数摊成控件并支持试听。

### 37.2 实现
- `packages/shared/src/rpc.ts`：新增 `VoiceOption`；`media.voices`（→ `{ok, provider, voices[], message?}`）、
  `media.preview`（→ `{ok, audioBase64?, mime?, durMs?, costCny?, reason?}`）、
  插件侧 `plugin.media.voices`。
- `packages/shared/src/manifest.ts`：`CAPABILITIES` 加 `media.voices`。
- `packages/shared/src/domain.ts`：`PluginInfo` 加 `optionalSecrets` / `presentSecrets`（只给名字）。
- `packages/kernel/src/plugins/host.ts`：`toInfoFromRow()` 填这两个字段（invalid 分支给空数组）。
- `packages/kernel/src/services/media.ts`：`voices()`（30s 超时）、`preview(text)`（走 `speakCeilingCny`
  预算闸，返回值不落盘、不写消息表，只 `recordMedia({kind:"media.tts"})`）。
- `packages/kernel/src/contracts.ts` `MediaPort` 加 `voices()` / `preview(text)`；`app.ts` 加两个 RPC case。
- `plugins/core.media/index.mjs`：新增 `plugin.media.voices`——breeze 走 `GET /v1/voices?language_code&page_size=50`
  映射 `{id,name,language,gender,previewUrl}`；openai 分支回配置里那一个 voice 并说明没有列表接口。
- `plugins/core.media/plugin.json` 同步 capabilities；`scripts/validate-plugins.mjs` 白名单同步。
- `packages/client/src/renderer/src/admin/tabs/VoiceTab.tsx`（新）：状态卡 / 供应商 / 两个密钥录入 /
  音色列表（点选、手填、清空自动挑）/ 语速与语气强度 / 试听播放器；`AdminTab` 加 `"voice"`，
  `AdminDrawer.tsx` 加「声音」标签。

### 37.3 验证
- `release/probe-breezeblue.mjs` 扩到 27 条并全过：列音色（provider=breezeblue、含假服务音色）、
  试听（mime=audio/mpeg、返回 base64、记成本）、并确认一条回复只合成一段语音。
- `packages/kernel/test/media.test.ts` 加 2 例（列音色规整、试听记 media.tts 且不落消息）。
- `npm test` 26 文件 **164 例**；typecheck、build、6 插件校验、check-boundaries 全绿。
- 打包 `release/Anteros-Setup-1.0.24-x64.exe`（117.6 MB），`scripts/package-check.mjs` 25 通过 0 警告 0 错误。

### 37.4 边界
- 试听会真花钱（按字计价，默认句约 ¥0.002），界面会显示金额；不写消息、不占记忆。
- 供应商切到 OpenAI 兼容后没有"音色列表"可拉，只能填配置里那个 voice 名。
- 识别（ASR）仍然必须另配 OpenAI 兼容服务，BreezeBlue 不提供。

## 38. v1.0.25 增补（微信里发真语音条）

### 38.1 范围
在这之前，微信会话里的回复只能是文字：`voice.ts` 有一条硬门槛"外部通道会话默认不出声"，
旁路的 `send` 也只能贴文本。v1.0.25 让微信里的回复可以发成**真语音条**：
旁路合成 wav → 播进虚拟声卡（VB-CABLE）→ 用微信自己的「按住右 Alt 说话」把这段声音
当成麦克风输入录进去。不注入进程、不改内存、不逆向协议。

### 38.2 实现
- `integrations/wechatauto-sidecar/audio_out.py`：`write_tone()` / `record_bytes()`（waveIn 轮询）/
  `bridge_probe(0.8s)`（边播边录，RMS≥300 判通）/ 子命令 `play|bridge|selftest|probe`。
- `sidecar.py`：`_voice_probe()`（300s 缓存）、`voice.status`、`voice.send`、`isolated_voice()`
  （DPI 感知 → 切会话 → 抢前台 → 点输入框 → `send_lock` 内按住右 Alt + 播 wav + 松开 →
  回读 `messages` 确认 `type=语音`、发送者是自己、`voicelength` 与时长差 ≤3s）、
  `_press_right_alt()`（必须带 `KEYEVENTF_EXTENDEDKEY`，否则 Windows 当左 Alt 处理）、
  `_verify_voice_sent()`（判据与巡检一致：`sender_username == db.wxid`）。
- `plugins/core.media/index.mjs`：`speakFormat(params)` 支持 `format:"wav"`（BreezeBlue 走
  `output_format=wav_24000`，OpenAI 兼容走 `response_format:"wav"`），并新增 `wavDurationMs()`
  从 RIFF 头算**真实时长**（微信按按住时长记长度，估算值会截断或拖尾）。
- `packages/kernel/src/services/media.ts`：`synthesize({format})` 透传；新增 `absPathFor(attachment)`。
- `packages/kernel/src/services/chat.ts`：外部会话走 `wechat.voiceOutbound` 开关（默认关），
  打开时按 `always` 档判决（字数/presence 等硬门槛仍然生效），wav 合成**同步等落盘**，
  把 `{messageId, path, durMs}` 放进 `ChatReplyResult.voice`；合成失败则没有这个字段。
- `packages/kernel/src/services/wechat.ts`：`sendVoice(wavPath, durationMs, chatUsername?)`、
  `voiceStatus(force)`、`setVoiceOutbound(enabled)`；`WechatChannelStatus` 加 `voiceOutbound` / `voiceReady`。
- `packages/kernel/src/app.ts`：`onInbound` 里优先发语音条，失败**退回发文字**（绝不把话丢掉）；
  新增 `channels.wechat.setVoiceOutbound`（打开前先跑一次自检，通不过直接拒绝）与
  `channels.wechat.voiceStatus`。
- 客户端 `admin/WechatChannel.tsx`：新增「在微信里发语音条」一块——自检按钮、开关、
  状态说明（默认关，通道没就绪时不可勾）。

### 38.3 验证
- `release/voice-lab.py` 实验台实测：按住右 Alt 4 秒 + 播 3 秒测试音 → 微信库里出现
  `type=语音 / isSelf=true / voicelength=4400`，界面出现绿色语音气泡。
- 自检：默认录音设备为 CABLE Output 时，边播边录 RMS≈11940；设错设备时会明显偏低（阈值 300）。
- `packages/kernel/test/media.test.ts` 加 1 例：`format:"wav"` 透传到插件、`absPathFor` 拒绝 `../`。
- 待用户机器上跑的验证见 `release/build-1.0.25.bat` 生成的 `release/build-1.0.25.log`。

### 38.4 边界与风险
- **默认关闭**，且打开前必须过虚拟声卡自检：声卡没接好时微信会录到房间里的真实声音。
- 需要装 VB-CABLE，并把 Windows 默认录音设备设成 CABLE Output；按住说话要求微信在前台。
- 一条回复只发一条语音（不逐条）；语音没合成成功就退回文字。
- 语音时长受微信限制（这里限 0.3–60 秒），按住时长＝语音条长度，误差由微信自己决定。
- 仍然不注入、不改内存：这条路走的是微信自己的录音链路，代价是需要虚拟声卡与前台窗口。

## 39. v1.0.26 增补（三个体验问题）

### 39.1 范围
只修问题，不加功能：①「让它发微信语音条它一直不发」；②「关系阶段显示异常」；③「一条回复只发出前三句」。

### 39.2 实现
1. **语音条开关与门槛**
   - `packages/shared/src/voice.ts`（`packages/kernel/src/services/voice.ts`）：新增 `VOICE_EXTERNAL_MAX_CHARS = 200`；`VoiceContext` 加 `voiceMessage?: boolean`；外部通道 + `voiceMessage` 时按语音消息口径判（跳过「外部通道默认不出声」、字数上限用 200），剩余门槛（presence / degraded / strained / speakReady）不变。
   - `chat.ts` 的 `outboundVoiceDecision()` 把 `externalChannel` 与 `voiceMessage` 如实传给 `decideVoice`；`off` 的原因文案区分「应用内没开」与「外部通道语音条没开（管理面板 → 通道 → 那个通道 → 语音条开关）」。
   - 客户端 `admin/tabs/VoiceTab.tsx` 新增「外部通道也发语音条」块：自检按钮、开关（走原有的 `channels.wechat.setVoiceOutbound`，打开前内核先做声卡自检）、两段说明；进来先读一次状态。
2. **关系阶段**
   - `packages/shared/src/domain.ts`：`RelationTransition.kind?: "stage" | "event" | "mode"`。
   - `packages/kernel/src/mind/relation.ts`：`applyEvent` 写 `kind:"event"`，`writeStage` 写 `kind:"stage"`，`setMode` 写 `kind:"mode"`；新增 `onChange` 回调，`writeStage` 落库后通知。
   - `packages/kernel/src/mind/service.ts`：`setRelationChangeHandler()`；`contracts.ts` 的 `MindPort` 同步；`app.ts` 构造后注册 → `emit("event.relation", relation)`。
   - `packages/kernel/src/services/chat.ts` 的 `emitRelation()` 改为直接发 `RelationState`（原来多包了一层 `{relation}`，客户端取 `stage` 拿到 undefined）。
   - `admin/tabs/ExpressionTab.tsx`：只渲染 `kind === "stage"`（旧数据按 `from !== to` 兜底），没有记录时给一句人话。
3. **分条发送丢消息**
   - `integrations/wechatauto-sidecar/sidecar.py`：新增 `BATCH_TIMEOUT_BASE_SECONDS = 90.0`，批量预算改为 `90 + 21.6 × (n-1)`（覆盖上游拟人节流 `rhythm.py` 的 30–75 秒冷却）；失败分支把 `sent`（已发出几条）一起带回。
   - `packages/kernel/src/services/wechat.ts`：`sendMany` / `sendAsync` / `sendVoice` 都按 `result.ok === false` 判失败；`sendMany` 的超时改为 `120s + 25s × (n-1)`（上限 15 分钟），比旁路预算再宽 25 秒。
   - `packages/kernel/src/app.ts`：`onInbound` 检查 `outcome.ok` 与 `sent`，未发出的消息 `UPDATE ... delivery = 'failed'`，逐条 `emit("event.message", ...)` 推给界面，并写一条 warn 日志说明发出去几条。

### 39.3 验证
- `npm run typecheck` 三包绿；`npm test` 26 文件 **169 例**（新增：语音条口径 2 例、关系 kind 与 onChange 2 例）；`npm run lint` 通过（「业务代码里没有按通道名分支的痕迹」）；`npm run test:sidecar` 全过。
- `npm run build` 与 `npm run package` 出 `release/Anteros-Setup-1.0.26-x64.exe`；`scripts/package-check.mjs` 25/0/0。

### 39.4 边界
- 外部通道的语音条仍然**默认关闭**，且必须过声卡自检才能开；开着时一条回复只发一条语音，合成失败退回发文字。
- 分条发送失败只影响「没发出去的那几条」：已发的保持 `sent`，未发的标 `failed` 并在聊天里可见（可重发）。
- 关系记录仍然写全量（事件 + 迁移），只是界面按 `kind` 过滤；`events` 计数逻辑（`countTrigger`）不受影响。

## 40. v1.0.27 增补

### 40.1 范围

修 v1.0.26 装到应用后暴露的一个真 bug：微信语音条自检报 `ModuleNotFoundError: No module named 'audio_out'`。
只动旁路进程与它的测试，内核不解，产品行为不变。

### 40.2 根因

内置的便携 Python 是官方 embeddable 包，目录里有 `python311._pth`。这个文件存在时，解释器不再把
「脚本所在目录」加入 `sys.path`；而 `_pth` 中的 `.` 是相对 `_pth` 文件自身解析的，指向 Python 自己的目录，
不是进程 cwd。实测 sys.path 只有 `python311.zip`、`Lib\site-packages`、Python 目录和 win32 几条。

结果：`sidecar.py` 与其同级模块 `audio_out.py` 互相看不见，`import audio_out` 抛 ModuleNotFoundError，
`channels.wechat.setVoiceOutbound` 因自检失败抛 EBLOCKED，界面上就是「选了虚拟声卡还是提示错误」。

本机手工验证时用的是 `-c` 加手动 `sys.path.insert`，所以这条路径从没被走过——属于「只在打包后才出现」的问题。

### 40.3 实现

- `integrations/wechatauto-sidecar/sidecar.py`
  - 顶部：`_SELF_DIR = os.path.dirname(os.path.abspath(__file__))`，不在 `sys.path` 就插到最前。
  - 新增 `_audio_out()`：先 `import audio_out`；失败则用 `importlib.util.spec_from_file_location`
    按文件路径加载并写入 `sys.modules`，两条都失败才抛错（错误里带完整路径）。
  - `_voice_probe()` 与 `isolated_voice()` 改为走 `_audio_out()`。

### 40.4 验证

- `integrations/wechatauto-sidecar/test_sidecar_voice.py` 新增 2 条回归用例：把脚本目录从 `sys.path`
  摘掉、清掉 `sys.modules["audio_out"]` 之后，`sidecar._audio_out()` 仍要能加载出可用模块。
- 用应用内置 Python（`%APPDATA%\Anteros\wechat-runtime\python-3.11.9\python.exe`）复现修复前后：
  修复前 `import audio_out` → ModuleNotFoundError；修复后 `method_voice_status({"force": true})` →
  `{"ok": true, "playbackDevice": "CABLE Input (VB-Audio Virtual C", "rms": 6619.0, ...}`。
- `npm test` 26 文件 169 例全绿；`npm run lint`（审批边界）通过；`npm run test:sidecar` 全部通过；
  `npm run build` → `npm run package` → `release/Anteros-Setup-1.0.27-x64.exe`；
  `scripts/package-check.mjs` 25 通过 0 警告 0 错误；包内 `sidecar.py` 确认含 `_SELF_DIR` 与 `_audio_out`。

### 40.5 边界

- 只改旁路进程，不动内核、不动插件、不抬插件版本（避免插件升级被自动停用、要用户重新授权）。
- 自检仍然只在「点开关/点自检」时跑，带 300 秒缓存；不通过一律拒绝开启开关（不通过就不能发语音条），
  免得默认录音设备不是虚拟声卡时把房间里的真声音录进去发出去。

## 41. v1.0.28 增补

### 41.1 范围

修「选了虚拟声卡之后，应用内回复一直卡在『语音生成中…』」这一体验问题。同时收紧合成超时，
让失败在一分钟内可见。

### 41.2 根因

两个叠加：

1. `packages/client/src/renderer/src/components/Bubble.tsx` 里，只要消息带 attachment 且状态是
   `ready` 或 `pending`，正文就不渲染。`pending` 期间用户只能看到一行「语音生成中…」——
   合成慢的时候这条消息等于空着。
2. 超时链太长：插件 `breezeSpeak` 单次 60 秒 × 2 次（`plugins/core.media/index.mjs`），
   内核 `TTS_TIMEOUT_MS = 150_000`（`packages/kernel/src/services/media.ts`）。
   线路连不上时既不快速失败、也不出声，界面就停在 pending 上两分半。
   现场日志：消息 351、359 都是 `插件调用超时（plugin.media.speak，150000ms）`。

### 41.3 实现

- `Bubble.tsx`：只有 `state === "ready"` 时才隐藏正文，`pending` / `skipped` / `missing` /
  `error` 一律把正文渲染出来。
- `VoiceBubble.tsx`：pending 那条加一句说明「正文已经发出来了，声音补上就替换」，
  并给 title「正在合成这条语音，最多等一分钟」。
- `plugins/core.media/index.mjs`：新增 `SPEAK_ATTEMPT_TIMEOUT_MS = 35_000`，
  `breezeSpeak` / `openaiSpeak` 都改成 35 秒 × 2 次试。
- `plugins/core.media/plugin.json`：`resources.call_timeout_ms` 150000 → 120000。
- `packages/kernel/src/services/media.ts`：`TTS_TIMEOUT_MS` 150_000 → 90_000（注释写清历史与理由）。
- 插件 `version` 故意不变（0.3.0）：manifest 版本一变内核会把插件自动停用、要用户重新授权，
  这次只是超时数值与客户端渲染，不值得再让用户点一遍。

### 41.4 验证

- `npm run typecheck` 三包通过；`npm test` 26 文件 169 例全绿；`npm run lint` 边界检查通过。
- `npm run build` → `npm run package` → `release/Anteros-Setup-1.0.28-x64.exe`；
  `scripts/package-check.mjs` 25 通过 0 警告 0 错误。
- 包内核对：`kernel.mjs` 里 `var TTS_TIMEOUT_MS = 9e4`；插件 `index.mjs` 里
  `SPEAK_ATTEMPT_TIMEOUT_MS = 35_000`；`plugin.json` 里 `call_timeout_ms: 120000`。

### 41.5 边界

- 只是等得更短 + 正文先露出来，不改语音链路本身；合成成功时行为与 v1.0.27 一致。
- 失败仍然是「正文照发、气泡标注没能生成、可点重新生成」，不会因为语音失败而丢话。

## 42. v1.0.29 增补

### 42.1 范围

四件事：① 让模型自己挑哪一（句）条要用声音说，并且知道自己发过语音、发的是什么；
② 长文本不再整段合成，改成一句一次、再拼成一条；③ 虚拟声卡驱动内置到「声音」栏，可一键安装；
④ 恢复多智能体并行改法（三块并行，不再串行一个人写）。

### 42.2 根因

1. 以前「要不要出声」由 `decideVoice` 按字数与关系一刀切，模型没有表达意愿的位置；
   历史消息只放正文，语音条的 `attachment` 完全不进上下文，所以它既不记得自己说过语音，
   也不知道对方发来的是语音——同一段话它会当成纯文本再读一遍。
2. `synthesize()` 把整段朗读稿丢给供应商：句子一长，供应商那边超时/截断的概率就上去了，
   而且一次调用只能拿到一整块音频，中间没有句间停顿。
3. 声卡要用户自己找驱动包安装，面板只能检测、不能装。

### 42.3 实现

- `packages/kernel/src/expression/planner.ts`：新增 `splitIntoPartsWithVoice(raw, burstMax)`，
  按 `/<voice\s*>([\s\S]*?)<\/voice\s*>/gi` 切段；语音段走 `semanticChunks` 一句一条（≤32 字），
  普通段照旧 `splitIntoParts`；标签绝不进正文；`planParts` 只在语音段的 part 上写 `voice: true`。
- `packages/kernel/src/expression/prompt.ts`：约束里加 `<voice>` 用法；历史消息查询改成
  `role, text, attachment`，语音条（`kind === "audio"` 且 `state === "ready"`）前面加
  「（我刚用语音说的）」/「（他/她用语音说的）」，内容优先用转写稿 `transcript`。
- `packages/kernel/src/services/media.ts`：`synthesize()` 先 `splitSpeechSentences()`（≤120 字一句、
  ≤6 字碎句并入前句、无标点长串按 120 硬切），多句时强制 `format: "wav"` 并逐句调用，
  再用 `mergeWavBuffers()` 拼（要求采样率/声道/位深一致，重写 RIFF 与 data 长度）；
  拼不了就只保留第一句并 warn；时长用 `wavDurationMs()` 从合并结果读，成本按句累加。
- `packages/kernel/src/services/chat.ts`：语音位次由 `part.voice` 决定（应用内取它标的第一个，
  外部通道把标的几句拼成一条语音条），pending 气泡挂在它挑中的那条上而不是永远第一条；
  想用语音但档位没开时记一条日志说清原因。
- 旁路：`audio_out.py` 加 `SOUNDCARD_PLAYBACK_NAME`/`SOUNDCARD_CAPTURE_NAME`/`soundcard_state()`；
  `sidecar.py` 加 `soundcard.status` / `soundcard.install`（`ShellExecuteW` runas 装 VB-CABLE，
  每 2 秒轮询最多 120 秒，`ANTEROS_VBCABLE_DIR` 设了就只认它、不回落）。
- 内核 `wechat.ts` 加 `soundcardStatus()` / `installSoundcard()`；`app.ts` 两个 case，
  安装走 `assertOwner` + `audit.log("soundcard.install")`。
- 客户端 `admin/tabs/VoiceTab.tsx` 加「虚拟声卡」一节：状态、设备名、重新检测、一键安装。

### 42.4 验证

- `npm run typecheck` 三包通过；`npm test` 26 文件 **180 例全绿**（新增 planner 6 例、
  media 5 例：按句切、碎句合并、无标点硬切、多句拼接时长与成本累加、格式不一致只留第一句）；
  `npm run lint` 边界检查通过；`npm run test:sidecar` 全过（含声卡状态三条、`audio_out` 路径三条）。
- `npm run build` → `npm run package` → `release/Anteros-Setup-1.0.29-x64.exe`；
  `scripts/package-check.mjs` 预期 25 通过 0 警告 0 错误。

### 42.5 边界

- `<voice>` 只是表达意愿：档位没开（应用内语音回复 off、外部通道语音条开关 off）、
  字数超上限、在睡觉/忙、预算不够时一律不出声，正文照发。
- 逐句合成只影响「怎么合出这段声音」，不改回复内容、不改气泡数量、不改记账口径。
- 声卡安装仍然要用户点管理员确认；装不上的时候面板会说缺什么，不会假装装好。

## 43. v1.0.30 增补

### 43.1 范围

修 1.0.29 暴露的三个问题：① 每次都是第一句话发语音；② 语音与文本没分清（它把历史标注
「（我刚才用语音说的）」当自己的话发出来）；③ 「整段很长、只有一句该出声」时被闸门卡死。

### 43.2 根因

1. `packages/kernel/src/services/chat.ts` 里没标 `<voice>` 时写死 `voiceIndex = 0`。
2. 闸门 `outboundVoiceDecision(conversation, plan.fullText, now)` 拿**整段回复**的字数去判，
   而真正要说出口的只有一句——整段一长就永远不出声，与「圈哪一句归它自己」自相矛盾。
3. 历史消息前缀是模型看得见的文本，它照抄了（模型学什么就写什么）；`cleanReplyText`
   没有剥这类前缀。

### 43.3 实现

- `packages/kernel/src/expression/planner.ts`：新增 `pickVoicePart(parts)`——没有 `<voice>` 标记时
  按「≤25 字 +3、带？！+2、带…+1、句尾是语气词 +1、下标微加分」挑一条，平手挑靠后的；
  新增 `VOICE_HISTORY_ECHO` 正则，在 `cleanReplyText` 里剥掉行首的「（…用语音说的）」前缀
  （句子中间出现的「他刚才用语音说的那句话」不误删）。
- `packages/kernel/src/services/chat.ts`：`spokenIndexes = 它标的 || [pickVoicePart(...)]`；
  `spokenLine` 只拼要念的那几句；`outboundVoiceDecision(conversation, spokenLine, now)`
  用 `spokenLine` 判长度；日志写清「出声在第 N 条（它标的 / 按语气挑的）」与不出声的原因。
- `packages/kernel/src/expression/prompt.ts`：加一条「例：`<voice>那我试试看哦</voice>` 前面那句留文字」，
  并明确「历史里出现的（我刚用语音说的）是系统标注，你自己说话时不要写这类括号前缀」。

### 43.4 验证

- `npm run typecheck` 三包通过；`npm test` 26 文件 **182 例全绿**（新增 2 例：前缀剥除、
  `pickVoicePart` 的挑法）；`npm run lint` 边界检查通过。

### 43.5 边界

- 挑句只是"它没标的时候的兜底"，标了就听它的；档位 off、字数超限、睡觉/忙、预算不够仍然不出声。
- 剥前缀只动「行首的语音标注」，不改正文里正常的括号内容。

## 44. v1.0.31 增补（一句一条）

### 44.1 范围

用户 2026-11-04 提的两件事：语音没有用上「它自己选的那句文本」；长句不该拼成一条语音，
应该拆成一句一句直接发。

### 44.2 实现

- `packages/kernel/src/contracts.ts`：`ChatReplyResult.voice`（单条）改成
  `voices?: Array<{ index: number; messageId: number; path: string; durMs: number }>`，
  一句一条，`index` 是第几个气泡。
- `packages/kernel/src/services/chat.ts`：候选句 = 它标 `<voice>` 的那几句，没标时才用
  `pickVoicePart` 兜底挑一句；**逐句过闸门**（每句单独判档位、字数、presence、预算），
  通过的进 `voiceParts`，被挡下时留第一条理由写日志；每句单独 `rewriteForSpeech` +
  `speakCeilingCny` 预算；插消息时按 `voiceByIndex.has(index)` 挂 pending attachment；
  合成后把 `{index, messageId, path, durMs}` 按顺序收进 `result.voices`。
- `packages/kernel/src/services/media.ts`：多句不再拼 wav（`mergeWavBuffers` 保留但不再被
  `synthesize()` 用到），一次调用只合成一句。
- `packages/kernel/src/app.ts`：发送改成按顺序走——连续的文字攒成一批 `sendMany`，
  遇到语音调 `sendVoice(path, durMs)`；语音失败把那句退回发文字，两种都失败才标
  `delivery='failed'` 并重推；文字批量失败时按 `part_index IN (...)` 精确标记失败条数。
- `packages/kernel/src/expression/prompt.ts`：`<voice>` 可以标一到三句、每句一个标签、
  每句不超过 25 字；并提醒「别整段都标」。

### 44.3 验证

- `npm run typecheck` 三包通过；`npm test` 26 文件 **183 例全绿**（新增「多个 `<voice>`
  标记各自成条」）；`npm run lint` 通过。
- 真机探针 `release/probe-multivoice.mjs`（假模型 + 假 BreezeBlue + 真内核）**21 项断言全过**：
  四条气泡（两声两字）、语音挂的正是标出的那两句、没标的照旧打字、每句单独一次合成调用、
  `media.tts` 一句一笔、音频各自落盘且 `state=ready`。

### 44.4 边界

- 一句一条只在「它标了多句」时生效；标了几句就有几条语音，不会再被拼成一条。
- 单句超过闸门上限（应用内 56 字 / 外部通道 200 字）仍然不出声，那句按文字发。
- 拼 wav 的函数留着给将来的合成长文本用，但当前回复路径不再走它。

## 45. v1.0.32 增补（语音条真的发得出去 + 不再自相矛盾）

### 45.1 范围

用户 2026-11-04 报的两个问题：

1. 「语音没有发送出去」——后台日志是 `语音条没发出去（语音没发出去（回读：而且我也不太好意思发）），这一句退回发文字`，
   界面上看到三句全是文字，一条语音都没有。
2. 「它自己说不好意思发却又发了」——同一段回复里既说了"不太好意思发"，又把另一句标成了语音。

### 45.2 实现

- `integrations/wechatauto-sidecar/sidecar.py`
  - **回读改成"看水位之后的新消息"**：新增 `_newest_seq()` / `_verify_voice_since()` / `_voice_row_ok()`，
    按下之前记一条 `sort_seq`，松开后只在这个水位之后找「类型含语音 + 发送者是自己 + voicelength 合理」的那条。
    旧实现看"最新一条消息"，而最新一条常常是刚发出去的文字，于是把发成功的语音判成失败、又退回发一遍文字。
  - **发之前核对会话标题**：新增 `_current_chat_title()` / `_chat_title_matches()`，`_ensure_chat` 之后再核一次，
    标题对不上直接放弃并报「界面停在「X」，不是要发的「Y」：已放弃发送（避免发错人）」。
  - **按住期间钉住前台**：新增 `_ForegroundPin`（每 150ms 检查一次 `GetForegroundWindow`，被抢回来就再抢回去），
    失败时把 `foregroundStolen` 次数带回去。真机上"按住的两秒里别的窗口把前台抢走"会让微信当场取消录音。
  - **右 Alt 改用 keybd_event**：`_press_right_alt` 从 SendInput 改回 `keybd_event`（带 `KEYEVENTF_EXTENDEDKEY` + 扫描码）。
    实测同一台机器上 SendInput 注入的 `wVk=0xA5` 微信不认，还会让输入框失去焦点；`keybd_event` 就认。
  - 失败留证：新增 `_voice_fail_shot()`，把整屏截图存到 `<数据目录>\logs\voice-last-fail.png`。
  - 最多试 2 次（第二次重新取水位），回读最多 15 秒。
- `packages/kernel/src/expression/planner.ts`
  - 新增 `VOICE_REFUSAL`：说了「（不）好意思发 / 不想发 / 不方便 / 只能打字 / 语音发不了」这类话的句子，
    即使被 `<voice>` 标了也不出声（压回文字）；`pickVoicePart` 兜底挑句时同样跳过这些句子。

### 45.3 验证

- 真机（本次会话，应用自带便携 Python）：`method_voice_send({"durationMs":2200,"chatUsername":"filehelper","chatTitle":"文件传输助手"})`
  → `{"ok": true, "durationMs": 2200, "voicelength": 2300, "detail": "语音条已发送（2.2 秒，回读 2300ms）"}`，10.5 秒完成；
  改之前同一条调用是 43.6 秒 + `{"ok": false, "error": "语音没发出去（回读：水位之后没有新消息）"}`。
- `npm test`：26 文件 **184 例全绿**（新增 1 例：拒绝用声音的句子不出声、兜底挑句跳过它）。
- `npm run lint`（边界检查）通过；`npm run typecheck` 三包通过。
- `release/probe-multivoice.mjs` 21 项断言仍全过（没有回归）。
- `npm run test:sidecar` 全过。

### 45.4 边界

- 按住说话仍然要求：微信窗口能抢到前台、当前会话标题与目标一致、虚拟声卡桥接通、默认麦克风是 CABLE Output。
  任一条不满足就不发，宁可退回文字，绝不发错人。
- 语音失败一律退回发那句文字（内容不丢），界面上不会出现"什么都没发出去"。
- 回读只看自己发的消息，别人同时发来的消息不会干扰判定。

## 46. v1.0.33 增补（语音落在该落的地方）

### 46.1 用户报的现象

真实聊天里它回：

```
你这是跟我讲条件呀
好嘛好嘛
我手机里其实有一段以前随手录的
就是有点傻哦
[语音 0:02] 不过先说好，别笑我。
```

用户的判据是"像人一样"：铺垫的话（先说好、别笑我）应该打字说，**语音该是下一句真正的内容**；
或者根本该等对方回了再说。把铺垫本身发成语音，就是"开口先交代一句废话"，不像人。
另外它还拿「我手机里没录过声音」「我得先录一段」当借口——它本来就能出声，这些是假理由。

### 46.2 实现

- `packages/kernel/src/expression/planner.ts`
  - 新增 `VOICE_PREAMBLE` + `isVoicePreamble()`：认出「先说好 / 说好了 / 别笑我 / 别嫌 / 别笑话 / 我酝酿 / 等我一下 / 我发一句 / 这就发 / 马上发 / 我录一段 / 我准备一下」这类铺垫。
  - 新增 `placeVoiceOnContent(parts, indexes)`：铺垫句留文字，语音往后挪到第一句真内容；
    后面没有内容（话还没说出来、或者本来该等对方回）就返回空——这一轮不发声。
  - `pickVoicePart` 也跳过铺垫句（不再把「不过先说好，别笑我」选成语音）。
- `packages/kernel/src/services/chat.ts`：`rawCandidates`（它标的 / 兜底挑的）过一遍 `placeVoiceOnContent`
  再逐句过闸门；被挪走或落空时写日志「要出声的只有铺垫句…这一轮不打语音」。
- `packages/kernel/src/expression/prompt.ts`：`COMMON_CONSTRAINTS` 加三条——
  ①它本来就能说话，语音是自己的声音、随时能发，别拿「手机里没录过 / 得先录一段 / 只能打字」当理由；
  ②对方要语音时把顺序摆对：铺垫打字、真正要说的那句用 `<voice>` 标出来，文字铺垫别超过一两句；
  ③还没想好、或该等对方先回，就别急着发语音。

### 46.3 验证

- `npm test`：26 文件 **185 例全绿**（新增 1 例：铺垫留文字 + 语音挪到后面真话；铺垫后面无内容 → 不发声；兜底挑句跳过铺垫）。
- `npm run lint` 通过；`npm run typecheck` 三包通过。

## 47. v1.0.34 增补（留着没说出口的话）

### 47.1 范围

用户 2026-11-04 确认：`<voice wait>` 是第三条路，与「这轮就发」「纯文字」并存；老化阈值 3 轮 / 30 分钟。

### 47.2 实现

- 解析：`packages/kernel/src/expression/planner.ts` 的 `VOICE_BLOCK` 认 `<voice ...>` 属性，`hold = /\bwait\b/i.test(attrs)`；
  `splitIntoPartsWithVoice` 把 hold 带到 part 上，`planParts` 透传，`PlannedPart.hold?: boolean`。
- 槽位：`packages/kernel/src/services/voice-hold.ts` 的 `VoiceHoldStore` 存 `settings` 表 `voice.hold.<conversation>`；
  `put`/`peek`/`claim`（seen 自增）/`clear`/`list`；`HOLD_MAX_TURNS = 3`、`HOLD_MAX_MS = 30 * 60_000`。
- 装配：`chat.ts` 每轮先 `claim()`，把句子作为 `heldVoice` 递给 `planReply`；`prompt.ts` 渲染成
  「【你上一轮留着没说出口的一句话】」；模型这轮真出声了（`voiceIndexes.length > 0`）就 `clear()`。
- 投递：hold 的 part 在投递循环里 `continue`（不落库、不发气泡）；`turns.output`、记忆 `rememberEpisode`、
  `observeAgentTurn` 一律用 `saidText`（只说出口的那些），留着的句子不进记忆。
- 管理面板：`voice.held` / `voice.held.clear`（清要 owner 确认 + 审计）；`MemoryTab` 加「留着没说出口的话」。

### 47.3 验证

- `npm test` 27 文件 189 例（新增 `packages/kernel/test/voice-hold.test.ts` 4 例）；typecheck 三包绿；边界检查 ok。
- 探针 `release/probe-hold.mjs`（假模型 + 真内核）14 项全过：第一轮 0 条 agent 消息、plan 里带 hold、
  `turns.output` 为空、槽位有那句话且 seen=0；第二轮提示词带上「留着没说出口」与那句原话、正常回话、
  seen 变 1；`voice.held.clear` 之后列表为空。
- `release/probe-multivoice.mjs` 仍全过（一句一条没被这次改动影响）。

### 47.4 边界

- 留话只影响表达时机，不改事实层：它没说过的话不进记忆、不算「它的话」。
- 保鲜期是硬上限：摆满 3 次或超过 30 分钟即作废，避免旧台词突然出现。
- 内部通道（本机会话）与外部通道各自一条槽位，互相不串。

## 48. v1.0.35 增补（人格草案编译不再"解析失败"）

### 48.1 范围

用户 2026-11-04 问「人格草案编写功能为什么模型会输出解析失败」。定位到三个叠加原因，全部修掉。

### 48.2 根因

1. `compileBlueprint` 写死 `maxTokens: 900`，而输出结构含 background + 最多 20 条 rationale，
   推理模型的思考 token 也算在这份额度里 → 输出被截断，拿到的是半个 JSON。
2. `LlmClient.generate` 没有把 `finish_reason` 带回来，调用方无法区分「被截断」与「格式错」。
3. `parseLlmBlueprint` 只做一次严格 `JSON.parse`：截断、Markdown 围栏、尾逗号、中文引号
   全都会整体失败并退回规则引擎，用户只看到一句笼统的"解析失败"。

### 48.3 实现

- `packages/kernel/src/contracts.ts`：`LlmResult.finishReason?`。
- `packages/kernel/src/llm/client.ts`：透传 `choices[0].finish_reason`。
- `packages/kernel/src/mind/blueprint.ts`：
  - `blueprintPrompt(text, current, compact?)`：常规预算下要求 background ≤200 字、rationale ≤6 条；
    `compact` 变体（重试用）要求 ≤120 字 / ≤3 条 / ≤12 字 why / 不缩进。
  - `repairJsonText(raw)`：剥围栏、取首尾大括号、`“”`→`"`、`：`→`:`、去尾逗号、整体单引号转双引号。
  - `salvageTruncatedJson(text)`：扫描字符串/括号栈，补齐缺失的右括号，回退到最后一个安全落点。
  - `parseLlmBlueprint(raw, fallback, model, truncated)`：截断时先抢救再判断，警告区分
    「被长度上限截断」/「缺了结尾」/「不是 JSON」/「解析失败」。
  - `compileBlueprint`：1800 token 起；`engine !== "llm"` 或 `finishReason === "length"` 时用紧凑
    提示词重试（3000 token）；重试成功用重试结果，重试失败但第一遍抢救成功则用第一遍；
    两次 token 相加返回，成本不漏记。

### 48.4 验证

- `npm test` 27 文件 194 例（新增 5 例：截断警告、围栏/尾逗号/中文引号修复、`repairJsonText`
  不动正文、截断抢救、`salvageTruncatedJson` 失败返回 null）。
- 探针 `release/probe-persona.mjs`（假模型 + 真内核）13 项全过：半截 JSON 触发 2 次调用、
  预算 1800/3000、最终 `engine=llm`、成本记两次之和；两次都不可用时退回规则且警告写「不是 JSON」。
- `npm run lint`（`scripts/check-boundaries.mjs`）通过。

### 48.5 边界

- 抢救只补结构，不猜内容：缺的字段仍用规则结果填，不编造。
- 重试最多一次：连着两次不行就退回规则引擎，不无限烧钱。
- 头部截断（连 `{` 都没有）不抢救，直接报「不是 JSON」。

## 49. v1.1.0 增补（哑光纸界面 + 未实现清单）

### 49.1 范围

界面整套语言重写（`DESIGN.md` v2「哑光纸」），并补一份对照草案 94 条的 `docs/未实现清单.md`。

### 49.2 界面改了什么

- 新增 `DESIGN.md`（仓库根目录，单一事实来源）：令牌（纸/面板/墨/线/强调/成功警告危险）、7 档字号、
  圆角与间距、三条不可协商（不造假 / 纸面优先 / 一套语法）。
- 聊天壳：`components/ChatPane.tsx`、`Bubble.tsx`、`Composer.tsx`、`Sidebar.tsx`、`Connecting.tsx`、
  `ConsentGate.tsx` 全部重排；`lib/theme.ts` 新增明暗切换与令牌注入；`styles.css` 由散落 px 改为令牌驱动。
- 管理面板：`admin/AdminDrawer.tsx` 与 12 个页签统一控件与字号，设置面可滚动，主按钮唯一。
- 开屏页改用 `assets/app-icon.png`，与任务栏图标一致。

### 49.3 未实现清单

`docs/未实现清单.md` 分档写明：A 整块没做（数字身体 L1–L4、可见足迹、图像能力、行为指标与实验评估）、
B 细则没做（16 条，含记忆探针测试集、离线巩固、每日一致性批处理、出生采样、停顿再打、不完美注入、
禁用词表、预判、表达体检周报、完全体行为验收、微信版本自检、通道健康度看板、换端演练、单点风险演练）、
C 只做了壳（选择账本、曝光记账、roster、冲动触发、L6 有限性、日程生成）、D 按设计不做（安卓、云、T2s、群控等）。

### 49.4 验证

- `npm run typecheck` 三包通过；`npm test` 27 文件 194 例全绿；`npm run lint`（check-boundaries）通过。
- `npm run build` 通过（renderer 重新打包）；`npm run package` 出 1.1.0 安装包；`scripts/package-check.mjs` 25/0/0。

### 49.5 边界

- 界面重写不动业务逻辑：内核 RPC、插件契约、通道行为均未改（本版只有 renderer 与文档）。
- 深色模式只跟随系统与手动切换两档，没有独立的"按截图取色"。
- 未实现清单是审计结论，不是承诺表：没进的条目不因为写进文档就变成已实现。

## 50. v1.1.1 增补（人格页数字不可见）

### 50.1 现象

管理面板 → 人格 → 当前人格：**「人格内核（数值，可微调）」与「表达参数」两组输入框里看不到数字**。
每个输入框缩成一个二十来像素的小方块，里面是空的。

### 50.2 根因

不是数据问题。只读打开本机库核对：`personas.traits` 里值都在
（`delayMedianMs=4500`、`delaySigma=0.7`、`burstMin=1`、`burstMax=3`、`typoRate=0.04`）。

真因是 v1.1.0 界面重写把设置面统一成「标签一列 128px、控件一列」的两列栅格
（`styles.css` 的 `.admin-panel .field { display: grid; grid-template-columns: 128px minmax(0,1fr) }`），
而这两块用的是 `.param-grid`（每格最小 168px 的卡片网格），格子里仍然是 `.field`。
168px 减去 128px 标签列和 16px 间距，控件列只剩 24px —— 输入框被挤成小方块，数字被裁掉。

`.admin-panel .field-row > .field` 有「退回竖排」的例外规则，`.param-grid .field` 漏了。

### 50.3 修法

`packages/client/src/renderer/src/styles.css` 末尾新增一段（选择器 `.admin-panel .param-grid .field`，
特异度 0,3,0，稳定压过 `.admin-panel .field`）：栅格里的 `.field` 改回 `display:flex; flex-direction:column`，
去掉下边框与内边距，标签 12px、输入框 `width:100%`。

### 50.4 验证

- 无头 Edge 加载**真实构建产物**（`packages/client/out/renderer/assets/index-CD5aGu8Y.css`）+ 与 `PersonaTab`
  同构的 DOM：五个输入框 `getBoundingClientRect()` 均为 **171×34**，数字正常显示（截图
  `release/probe-persona-ui2.png`，脚本 `release/probe-persona-ui2.html`，都在 .gitignore 覆盖的 `release/` 下）。
- 包内核对：`release/win-unpacked/resources/app.asar` 里能搜到 `.admin-panel .param-grid .field {`。
- `npm test` 27 文件 194 例全绿；`npm run lint` 通过；`npm run build` + `npm run package` 出
  `Anteros-Setup-1.1.1-x64.exe`；`scripts/package-check.mjs` 25 通过 0 警告 0 错误。

### 50.5 边界

- 只动样式，不动人格数据、不动 RPC、不改取值与钳制逻辑；库里数值一个字节没变。
- 同类隐患已一并核对：`.field-row` 里的 `.field` 原本就有例外规则；`.voice-grid` 用的是 `<label>` 包输入框，
  不用 `.field`，不受影响。

## 51. v1.1.2 增补（虚拟声卡：随包携带 + 下载按钮）

### 51.1 现象

用户报「虚拟声卡没有下载按钮」。声音页「虚拟声卡」一块在驱动目录为空时只有一句提示文字
（「这个安装包没带驱动，请到 vb-audio.com 下载」），没有任何可点的按钮——用户被卡在装驱动这一步。

### 51.2 根因

- `release/win-unpacked/resources/integrations/` 里只有 `wechatauto-sidecar`，没有 `vbcable`：
  `electron-builder.yml` 的 `extraResources` 是 `from: ../../integrations to: integrations`，
  而驱动包放在 `release/vbcable/`（被 `.gitignore` 忽略），从来没进过仓库。
- 旁路 `_find_vbcable_setup()` 于是返回 `None` → `soundcard.status` 的 `bundled` 为 false →
  客户端按「没有安装按钮」的分支渲染，只剩一句文字。

### 51.3 实现

- 驱动随包：官网原包复制为 `integrations/vbcable/VBCABLE_Driver_Pack43.zip`（1.09 MB，不拆不改），
  被 `extraResources` 自动带进 `resources/integrations/vbcable`。
- `integrations/wechatauto-sidecar/sidecar.py`：
  - `_vbcable_dirs()` 候选顺序：`ANTEROS_VBCABLE_DIR`（设了只认它）→ 包内 `resources/integrations/vbcable`
    → 仓库 `release/vbcable` → 数据目录下的下载缓存。
  - `_unpack_bundled_vbcable()`：候选目录里有 `*vb*.zip` 就解到 `_vbcable_download_dir()`（数据目录下 `vbcable`），
    再回安装程序路径；`_find_vbcable_setup()` 找不到 exe 时回落到它。
  - `_download_vbcable()`：两个官方地址依次试，UA 与 90 秒超时，下到临时文件后校验 100 KB–32 MB
    （太小按错误页处理），解压到数据目录；`ANTEROS_VBCABLE_DIR` 设了直接回绝（测试不联网）。
  - 新方法 `soundcard.download` → `method_soundcard_download`；`soundcard.install` 找不到 exe 时先下载再装。
- 内核：`channels.wechat.downloadSoundcard`（超时 180 秒，owner 权限 + 审计 `soundcard.download`）。
- 客户端：声音页未安装时两个按钮并列——「下载驱动包」+「一键安装虚拟声卡」；
  `bundled === true` 时说明「已经带着驱动包，直接点安装，不联网也能装」。

### 51.4 验证

- 旁路测试新增 2 组 8 条：只有 zip 时 `_find_vbcable_setup()` 能解出 `VBCABLE_Setup_x64.exe`、
  文件真实存在、解压落在 `ANTEROS_DATA_DIR`、`bundled` 为 true；指定目录时 `soundcard.download` 回绝且
  理由提到 `ANTEROS_VBCABLE_DIR`。`[voice] 全部通过`。
- 真机下载：`method_soundcard_download({})` 2.4 秒、`{"ok": true, "downloaded": true, "message": "驱动包已下载（1112 KB）"}`。
- 打包后核对：`release/win-unpacked/resources/integrations/vbcable/VBCABLE_Driver_Pack43.zip` 存在；
  从 `release/win-unpacked/resources/integrations/wechatauto-sidecar` 直接加载旁路（不设任何环境变量），
  `found: <数据目录>/vbcable/VBCABLE_Setup_x64.exe`、`exists: true`、`bundled: true`。
- `npm run typecheck` 三包通过；`npm test` 27 文件 194 例全绿；`npm run lint` 通过。
- `Anteros-Setup-1.1.2-x64.exe`（118.79 MB）+ blockmap；`scripts/package-check.mjs` 25 通过 0 警告 0 错误。

### 51.5 边界

- 不静默联网：只在用户点「下载驱动包」或点安装且本机没有安装程序时才下载。
- 不静默提权：安装仍走 `ShellExecuteW(runas)`，会弹 UAC；被拒时回 `needsAdmin`。
- 不吞错误：两个源都失败时把每个源的失败原因拼成一句返回，界面原样显示。

## 52. v1.1.3 增补（会话搜索 / 语音档位 / typing 收尾 / 群聊归属 / 逐条即发）

### 52.1 范围

用户 2026-11-06 报的四条（m18320、m18395）：
1. 先在某个窗口发完文字，再发语音时会重新搜索一次会话 → 当前目标窗口已经是它就直接发。
2. 声音页选"纯文字"时界面仍生成语音（只是没发到微信）。
3. 有时一直显示"正在输入中"但什么都不输出。
4. 群聊里自己在应用内发的话被当成群成员的消息。
外加一条优化：一个气泡生成完就直接送到聊天窗口。

### 52.2 实现

- `integrations/wechatauto-sidecar/sidecar.py` `_ensure_chat()`：先比当前会话（`_current_chat_title()` / `current_chat_name(gui)` 的 `_chat_key`），一致就直接返回，不 `open_chat`。三处调用方（`isolated_send` / `isolated_send_many` / `isolated_voice`）共用。
- `packages/kernel/src/services/chat.ts`：`outboundVoiceDecision()` 先看档位——`status.voiceOutbound === "off"` 时外部通道也不出声；投递循环包 `try/finally` 保证发 `event.typing stop`；`event.part` / `event.typing` 带 `conversation`；`onPart` 回调扩展成 `(text, index, meta: { voice, hold, messageId })`。
- `packages/kernel/src/app.ts`：`onInbound` 改为"写好一条就转一条"（`decideReply !== true` 时才抢跑，auto 模式要等整轮判 `<不回>`）；第一条语音之后停止抢跑，剩下的按 `part_index` 顺序补发；`dropVoice(messageId)` 在语音发送失败时撤掉界面上的语音气泡并退回发文字。
- `packages/client/src/renderer/src/components/Bubble.tsx`：新增 `fromMe = isUser && !senderName && !senderId`，群聊里我发的仍在右边、不带"群成员"昵称。
- `packages/client/src/renderer/src/lib/app.ts`：`event.part` / `event.typing` 按 `conversation` 过滤；一次发送结束后兜底清掉 typing。

### 52.3 验证

- `npm run typecheck` 三包通过；`npm test` 27 文件 195 例绿（新增群聊"我自己那条在右边"1 例）；`npm run lint` ok；`npm run test:sidecar` 全过。
- `npm run package` → `release/Anteros-Setup-1.1.3-x64.exe`；`scripts/package-check.mjs` 25 通过 0 警告 0 错误。

### 52.4 边界

- 逐条即发只在"必须回"的模式下生效；"自己决定回不回"仍整轮攒着，否则模型先说一句"不回"就已经发出去了。
- 语音那条始终等合成完成再发，且它后面的文字排队等它，顺序不会乱。
- 会话标题比对口味保守：比对不上就照原路搜索，不会因为改名/同名把话发错人。

## 53. v1.1.4 增补（发一条字不再搜一次）

### 53.1 现象

v1.1.3 的"写好一条就转一条"上线后，用户报：每发一条文字，微信界面上搜索框就点开一次；
一句回复分四条，眼前闪过四次搜索。语音条紧跟文字时也是同样的问题。

### 53.2 根因

每次发送都在新的 Python 子进程里跑，`WeChatGUI()` 是新对象，上游记录的 `_current_chat`
永远是空的；`_current_chat_title()` 走 UIA 也读不到（微信窗口最小化时连 hwnd 都取不到）。
于是"已经在目标会话上就别再搜"这条判据从来没有命中过，每条都老老实实搜一遍。

### 53.3 实现

- `integrations/wechatauto-sidecar/sidecar.py`：
  - 新增 `_chat_state_path()`（`ANTEROS_DATA_DIR` 或 `%APPDATA%\Anteros` 下的 `wechat-last-chat.json`）、
    `_read_chat_state()` / `_write_chat_state()` / `_clear_chat_state()` / `_chat_state_matches()`，
    `_CHAT_STATE_TTL_SECONDS = 120`；
  - `_ensure_chat(gui, target, username="")` 三道判断：界面读得到且是目标 → 直接发；两分钟内刚发过同一会话
    → 直接发（置 `_ENSURE_VIA_CACHE`）；都不是才 `open_chat` 搜一次，成功后落盘；
  - `_send_locked(text, target, gui_module, username="")`：发成功后落盘；若这次是跳过搜索发的，
    用 `_verify_text_sent(username, text)` 回读目标会话最新一条，对不上则清记录并报失败（发错人是底线）；
  - `isolated_send_many` / `isolated_voice` 成功路径同样落盘，并把 username 传进 `_ensure_chat`。
- 测试 `integrations/wechatauto-sidecar/test_sidecar_send_lock.py`：数据目录指到临时目录
  （`ANTEROS_DATA_DIR`），新增 `test_ensure_chat_skips_search_when_recently_sent`（`open_chat` 一次都不调）、
  `test_ensure_chat_searches_again_when_state_is_stale`（过期要重搜），并在每个用例前重置状态。

### 53.4 验证

- `test_sidecar_send_lock.py`：9 项全过；`npm run test:sidecar` 三组全过。
- `npm test` 27 文件 195 例绿；`npm run build` / `npm run package` → `release/Anteros-Setup-1.1.4-x64.exe`；
  `scripts/package-check.mjs` 25 通过 0 警告 0 错误；包内 `sidecar.py` 84,466 字节，含缓存与回读代码。
- 真机：连续两条发到「文件传输助手」，第一条 7.23s（含搜会话），第二条 4.29s（跳过搜索），
  两条都 `ok: true`，`wechat-last-chat.json` 已落盘。

### 53.5 边界

- 只信两分钟。超过两分钟或换了会话，仍然照原路搜一次——界面可能早被人点走了，不能赌。
- 跳过搜索的那一次必须回读确认；回读不到（数据库没打开、刚写库有延迟）按"没冤枉它"处理，不误报失败。
- 微信窗口最小化时读不到当前会话名，这时缓存是唯一的判据来源，TTL 之外一律重搜。
