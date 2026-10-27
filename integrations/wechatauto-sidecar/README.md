# Anteros 内置微信通道 · 运行环境

这个目录里没有任何微信代码，也没有逆向实现。它只做两件事：把第三方开源库
[wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) 装进一个独立的
Python 环境，再用 `sidecar.py` 把它的能力以「一行一个 JSON」的方式交给 Anteros 内核。

## 它怎么工作

```
Anteros 内核（TypeScript，常驻）
  └─ services/wechat.ts  ──stdin/stdout NDJSON──▶  sidecar.py（Python 子进程）
                                                     └─▶ wechatauto-replica
                                                           ├─ 读：解密本机微信数据库
                                                           └─ 写：驱动微信界面发消息
```

- 没有网络端口，没有本地 HTTP 服务，所有通信都在父子进程的管道里。
- 内核默认不启动它（`wechat.enabled = false`），用户必须在「通道」页逐条确认风险后才会开。
- 只跟一个白名单会话说话（默认「文件传输助手」`filehelper`），也不读别人的聊天。

## 需要准备什么

1. **Windows 10/11 64 位**，**微信 4.x 桌面版**（`C:\Program Files\Tencent\Weixin\Weixin.exe`）。3.x 的数据库结构不一样，读不了。
2. **64 位 Python 3.10+**，安装时勾选 `Add python.exe to PATH`。
   装完在命令行能跑 `python --version` 就算成。
3. 在 Anteros 里打开「通道」页 → 微信通道 →「安装运行依赖」（内部执行
   `python -m pip install --upgrade wechatauto-replica pypinyin`）。
   如果没有网络代理，这一步会失败，日志会如实贴在面板上。
4. 登录电脑版微信（微信必须**正在运行**，否则拿不到数据库密钥）。
5. 回「通道」页点「重新体检」，五项都绿了再点开启。

## 手动跑（排障用）

```powershell
# 装在哪个 Python 里就用哪个
python -m pip install --upgrade wechatauto-replica pypinyin

# 只跑一次体检，看它到底缺什么
python sidecar.py --self-test

# 手动起旁路进程（然后可以手打 NDJSON 试）
python sidecar.py
{"id":1,"method":"hello","params":{}}
{"id":2,"method":"health","params":{}}
{"id":3,"method":"poll","params":{"sinceSeq":0,"limit":20}}
```

## 风险与边界（请读完再用）

- 这条通道会**读本机微信数据库**、会**驱动微信界面代替你点按发送**。这类自动化可能违反微信使用条款，存在账号被限制的风险。默认关闭就是为了这个。
- 发送时会抢占前台焦点几秒，期间不要动鼠标键盘。
- Anteros 不做注入、不做内存改写、不做协议逆向；这里用的都是上游库自己公开的接口。
- 关闭通道会立刻杀掉 Python 子进程，不残留后台进程。

## 协议（给维护者）

| method | params | result |
|---|---|---|
| `hello` | `{}` | `{version, python, wechatauto, platform}` |
| `health` | `{}` | `{ok, checks[{id,label,state,message,hint?}], account, canRead, canSend}` |
| `configure` | `{chatUsername}` | `{ok, chatUsername, chatTitle}` |
| `poll` | `{sinceSeq?, limit?}` | `{messages[{seq,msgId,chatUsername,senderUsername,isSelf,kind,text}], nextSeq}` |
| `send` | `{text, chatUsername?}` | `{ok, chatUsername, chatTitle, detail}` |
| `doctor` | `{action:"diagnose-keys"\|"dump-account"}` | `{ok, output}` |

失败一律返回 `{"id":n,"error":{"code","message"}}`，内核把它翻成中文提示，不会静默失败。