# M0c 验收清单

目标：**M0c = 单机闭环可交付**。下面每条都写清楚"怎么验"和"通过标准"，不允许"大概正常"。
当前状态列如实标注：`待验证` 表示依赖构建闭合（内核尚缺 5 个 service，见 [M0范围.md](M0范围.md)）。

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
| 状态 | 待验证（ConsentGate 已有；服务端 `accept()` 校验全勾） |

## 2. 强杀插件，内核继续，App 内对话 100% 可用

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 启用 `core.memory-extract`（或任一 low 风险插件）；2) 找到插件进程：`Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*plugins*memory-extract*index.mjs*' } \| Select ProcessId,CommandLine`；3) `Stop-Process -Id <pid> -Force`；4) 立刻在 App 里发 3 条消息 |
| 预期 | 插件状态变 `crashed`/`degraded`；内核不退、窗口不白屏；3 条消息全部正常回复（不依赖该插件的能力）；退避 1s/5s/30s 后自动重启，连续失败标 `crashed` 并告警 |
| 状态 | 待验证（`plugins/host.ts` 已有退避与计数；需端到端联调） |

## 3. 禁用后无残留

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 启用一个插件并观察进程；2) 在"插件"页禁用；3) 立即检查进程与端口；4) 重启 App 再查 |
| 预期 | 插件进程消失（无 `index.mjs` 命令行残留）；`plugins.enabled=0`；`plugin_grants` 该插件行 `revoked_ts` 非空或无有效授权；UI 显示"已禁用"；重启后不自动拉起 |
| 状态 | 待验证 |

## 4. 业务代码 grep 无通道名

| 项 | 内容 |
| --- | --- |
| 命令 | `node scripts/check-boundaries.mjs` |
| 通过标准 | 输出 `[check-boundaries] 0 violation(s)`，退出码 0 |
| 当前 | **失败**：10 处（kernel 的 `wechat_id`/`ANTEROS_OWNER_WECHAT_ID`、shared 声明文案与 domain 注释），归 lead 处理 |
| 备注 | 允许出现的例外只有通道插件目录、manifest 文案与配置键；内核/客户端/共享层的代码与表结构不得含具体通道名 |

## 5. 发错人 = 0

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 不启用任何外部通道；2) 在界面里尝试"发送到外部/转发"（若入口存在）；3) 启用通道骨架（会被 blocked）；4) 再试 |
| 预期 | 无任何外发动作；返回 `EBLOCKED` 且说明"未接通"；`outbox`/`action_queue` 无新增外发任务；日志无"已发送"假记录 |
| 根因保障 | 外发只能经 `plugin.channel.send`，且需 `channel.write` 授权 + 有效租约；骨架插件直接 `EBLOCKED` |
| 状态 | 待验证（当前无真实通道可启用；骨架返回 blocked 已在插件 mock 冒烟中验证） |

## 6. 一键停用（panic stop）

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 启用多个插件（含通道骨架，若允许）；2) 点"通道"页的一键停用（或调 `channels.panicStop`）；3) 查插件与进程 |
| 预期 | 所有通道类插件被禁用；插件进程退出；返回里列出每个插件的 `restored` 状态；`audit_log` 有记录；App 内对话仍可用 |
| 状态 | 待验证（`host.ts` 的 `panicStop` 在；界面入口由 client-ui 接） |

## 7. 成本上限硬生效

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 把 `plan.budgetCny` 改成 0.01（管理抽屉→Owner/设置，或改数据库后重启）；2) 连续发消息直到超预算；3) 看返回与 `cost_ledger` |
| 预期 | 超预算后 `chat.send` 返回 `EBLOCKED`（不是"继续但提示"）；`cost_ledger` 累计与设置一致；调低预算立即生效；调高后恢复 |
| 状态 | 待验证（`services/cost.ts` 的 `checkBudget()` 是硬拒绝） |

## 8. 导出 / 导入可迁移

| 项 | 内容 |
| --- | --- |
| 步骤 | 1) 管理抽屉→导出，得到 `anteros-export-*.zip`；2) 关 App，换一个干净数据目录启动；3) 导入该 zip；4) 对比消息数、记忆条数、设置 |
| 预期 | 导出包含 `anteros.sqlite` 与 `media/`（或说明不含媒体）；导入后消息/记忆/关系/成本记录与导出前一致；版本不兼容时明确拒绝（`EVERSION`）而不是静默丢数据；失败可回滚 |
| 状态 | 待验证（`export.bundle` / `import.bundle` 入口在，格式与测试待补） |

## 9. 其他必须同时成立

- `node scripts/validate-plugins.mjs`：7/7 通过（**当前已通过**）。
- `node scripts/package-check.mjs --repo-only`：无错误（**当前会报 out/、kernel/dist 缺失**，构建后应通过）。
- 安装包：`release/Anteros-Setup-*.exe` 存在，`package-check`（不带 `--repo-only`）能确认包内含
  `resources/kernel/kernel.mjs` 与 `resources/plugins/*/plugin.json`。
- 日志抽查：`logs/kernel-*.log` 无 `sk-`、无 `Bearer`、无消息正文原样。
- 崩溃抽查：拔网线 / 断开模型 API，App 给出可读错误（`EIO`/`EDEGRADED`），不白屏、不假成功。

## 结论模板

```
M0c 验收：通过 / 不通过
日期：
构建：shared ✅ kernel ✅ client ✅
边界：0 违例
插件校验：7/7
逐项：1✅ 2✅ 3✅ 4✅ 5✅ 6✅ 7✅ 8✅
遗留：
```
