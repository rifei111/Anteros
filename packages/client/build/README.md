# packages/client/build — 打包资源

本目录放 Electron / electron-builder 构建时需要、但不进代码打包的静态资源。
目前只有应用图标：

| 文件 | 用途 |
| --- | --- |
| `icon.ico` | Windows 窗口图标、任务栏图标、NSIS 安装器/卸载器图标（electron-builder `win.icon`、`nsis.installerIcon`） |
| `icon.png` | 256×256 预览图，渲染进程/文档/README 可用；给非 Windows 目标留的 PNG 版本 |

## 设计说明

- 深色圆角底（`#1A2336 → #0B101A` 竖向渐变，Windows 11 风格圆角与细金色内框）。
- 金色 **A**（Anteros 首字母，圆头窄腰笔画，兼有弓形意象），是主识别元素。
- A 背后一圈很淡的环 + 10 个明暗不一的记忆光点，表达「可召回的记忆片段」，不是真实数据。
- 无文字、无渐变高光滥用，16×16 缩到任务栏仍能认出轮廓。

## 重新生成

图标由脚本生成，**不要手工用画图改 `icon.ico`**（多尺寸/透明边缘会坏）：

```powershell
# 仓库根目录；需要 Python 3.10+ 与 Pillow
python -m pip install pillow
python scripts/make-icon.py
```

脚本默认输出到本目录，也可以用 `--out-dir` 指定其他目录：

```powershell
python scripts/make-icon.py --out-dir packages/client/build
```

生成物：

- `icon.png`：256×256 PNG。
- `icon.ico`：包含 16/32/48/64/128/256 六个尺寸，Windows 按 DPI 和场景自动选择。

脚本用 1024×1024 母版绘制后 LANCZOS 缩小，所以小尺寸边缘不会糊；全部几何绘制、不依赖字体，
换机器生成结果一致。改配色/图形时直接改 `scripts/make-icon.py` 顶部的常量与 `_draw_a()`。

> 本机（开发机）`python` 可能是 WindowsApps 占位符；如果 `python --version` 弹应用商店，
> 用装了 Pillow 的 Python 3 显式路径运行即可，脚本本身不依赖环境。
