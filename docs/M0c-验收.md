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
- 安装包：`release/Anteros-Setup-0.1.0-x64.exe`（117 MB），`package-check` 已确认包内含
  `resources/kernel/kernel.mjs` 与 `resources/plugins/*/plugin.json`；`win-unpacked\Anteros.exe` 实跑通过。
- 日志抽查：`logs/kernel-*.log` 无 `sk-`、无 `Bearer`、无消息正文原样（**已验证**）。
- 崩溃抽查：不配模型时 App 顶部明示"本地回声（演示模式，不产生云端调用）"，不白屏、不假成功（**已验证**）。

## 2026-10-26 验收记录（本机 Windows 11 / Node 24 / Electron 45）

```
M0c 验收：通过（界面内逐项点击另列遗留）
构建：shared ✅ kernel ✅ client ✅   —— npm.cmd run build 全绿
类型：npm.cmd run typecheck          —— 0 error（shared/kernel/client 三套 tsconfig）
单测：npm.cmd test                   —— 14 文件 / 80 用例全绿
冒烟：npm.cmd run smoke:kernel       —— 31 项全过（真起内核进程 + 命名管道）
边界：npm.cmd run lint               —— 0 violation
插件：validate-plugins 7/7；package-check 19 通过 0 错误
安装：NSIS 安装包 117 MB；win-unpacked 实跑，声明闸 → 聊天 → 管理面板（11 页签）截图留证
逐项：1 ✅  2 🟡 3 🟡 4 ✅  5 ✅  6 ✅  7 ✅  8 ✅
遗留：2/3 的界面内逐项点击未做（自动化已覆盖崩溃退避与启停残留）；
      2 的日志里暂未看到插件"已启动"行，说明默认启用插件是按需拉起——点验时注意这一点；
      真实模型回复未验（本机无 API Key，只验证到降级回声与 token 计费链路）。
```

