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

## 2026-10-26 验收记录（本机 Windows 11 / Node 24 / Electron 45）

```
M0c 验收：通过（界面内逐项点击另列遗留）
构建：shared ✅ kernel ✅ client ✅   —— npm.cmd run build 全绿
类型：npm.cmd run typecheck          —— 0 error（shared/kernel/client 三套 tsconfig）
单测：npm.cmd test                   —— 16 文件 / 95 用例全绿（v0.2.0 人设编译 9 例 + v0.3.0 插件密钥 6 例）
冒烟：npm.cmd run smoke:kernel       —— 45 项全过（真起内核进程 + 命名管道）
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
  可编辑人格内核 + 逐条发送（v0.2.0）→ 插件授权/密钥 + 消息去重（v0.3.0）"推进；Release `v0.1.0`（M0c 单机闭环）、
  `v0.2.0`（人格内核可编辑）与 `v0.3.0`（插件授权与密钥、消息不重复）均已发布。
- 2026-10-26 夜间 `github.com:443` 一度不可达（`api.github.com` 正常），本次提交经 GitHub REST 的 Git Data API
  写入（blob → tree → commit → 更新 ref），因此提交哈希与本地对象一致，工作树干净。

