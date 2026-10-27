#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Anteros 内置微信通道的旁路进程（sidecar）。

职责（只做这四件事，别的都不做）：
  1. 握手与体检：报告 Python / wechatauto-replica / 微信安装与运行状态。
  2. 读：用 wechatauto 的 WeChatDB 读本机微信数据库里的新消息（只读，不发送 SQL 写操作）。
  3. 发：用 wechatauto 的 guia 驱动微信界面，把一段文本发到指定会话。
  4. 诊断：把 PIDs、账号、密钥缓存位置等排障信息吐出来，给用户自己看。

通信协议：stdin/stdout 上的 NDJSON（一行一个 JSON 对象），不用任何网络端口。
  请求  {"id": 1, "method": "poll", "params": {"sinceSeq": 120, "limit": 100}}
  响应  {"id": 1, "result": {...}}  或  {"id": 1, "error": {"code": "...", "message": "..."}}
  事件  {"event": "log", "line": "..."}（可选，内核只记日志）

这个文件刻意保持"零依赖即可启动"：没装 wechatauto 也能跑，只是 health 会如实报告缺什么。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import threading
import time
import traceback
from typing import Any, Dict, List, Optional

SIDECAR_VERSION = "1.0.0"
CHAT_DEFAULT = "filehelper"  # 文件传输助手：最安全的默认白名单

# ----------------------------------------------------------------------------- 全局状态


class State:
    def __init__(self) -> None:
        self.chat_username: str = CHAT_DEFAULT
        self.chat_title: Optional[str] = None
        self.db: Any = None
        self.db_error: Optional[str] = None
        self.guia_error: Optional[str] = None
        self.lock = threading.RLock()
        self._wechatauto_version: Optional[str] = None
        self._hello_done = False


STATE = State()


def log(message: str) -> None:
    """日志走事件通道，不污染 stdout 的 JSON 流。"""
    emit({"event": "log", "line": str(message)[:2000]})


def emit(payload: Dict[str, Any]) -> None:
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        # stdout 断了（内核退出）就以退出的方式结束，不要在死循环里刷错误
        os._exit(0)


# ----------------------------------------------------------------------------- 第三方库


def wechatauto_version() -> Optional[str]:
    if STATE._wechatauto_version is not None:
        return STATE._wechatauto_version
    try:
        import wechatauto  # type: ignore

        STATE._wechatauto_version = str(getattr(wechatauto, "__version__", "unknown"))
    except Exception as error:  # noqa: BLE001 - 这里就是要吞掉并如实上报
        STATE._wechatauto_version = None
        log(f"import wechatauto 失败：{error}")
    return STATE._wechatauto_version


def load_db() -> Any:
    """惰性打开微信数据库。失败不抛给调用方，只记录原因，health 会报告。"""
    with STATE.lock:
        if STATE.db is not None:
            return STATE.db
        try:
            from wechatauto import WeChatDB  # type: ignore

            STATE.db = WeChatDB()
            STATE.db_error = None
            log(f"微信数据库已打开：{getattr(STATE.db, 'wxid', '?')}")
        except Exception as error:  # noqa: BLE001
            STATE.db = None
            STATE.db_error = f"{type(error).__name__}: {error}"
            log(f"打开微信数据库失败：{STATE.db_error}")
        return STATE.db


def normalize_username(raw: str) -> str:
    """把会话标识归一：wxid_* / xxx@chatroom 直接用，其它当成昵称去查。"""
    value = (raw or "").strip() or CHAT_DEFAULT
    if value.startswith("wxid_") or value.endswith("@chatroom") or value == CHAT_DEFAULT:
        return value
    db = load_db()
    if db is None:
        return value
    try:
        resolved = db.username_by_nickname(value)
        return str(resolved) if resolved else value
    except Exception as error:  # noqa: BLE001
        log(f"昵称转会话标识失败（{value}）：{error}")
        return value


# ----------------------------------------------------------------------------- 体检


def check(id_: str, label: str, state: str, message: str, hint: Optional[str] = None) -> Dict[str, Any]:
    item: Dict[str, Any] = {"id": id_, "label": label, "state": state, "message": message}
    if hint:
        item["hint"] = hint
    return item


def wechat_installed() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Tencent\Weixin\Weixin.exe",
        r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe",
        r"C:\Program Files\Tencent\WeChat\WeChat.exe",
        r"C:\Program Files (x86)\Tencent\WeChat\WeChat.exe",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def wechat_running() -> bool:
    try:
        output = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
        return "Weixin.exe" in output
    except Exception:  # noqa: BLE001
        return False


def build_health() -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    python_ok = sys.version_info >= (3, 9) and "64" in platform.architecture()[0]
    checks.append(
        check(
            "python",
            "Python 解释器",
            "ok" if python_ok else "fail",
            f"Python {platform.python_version()}（{platform.architecture()[0]}）" if python_ok else f"Python {platform.python_version()} 不满足 64 位 3.9+",
            None if python_ok else "去 python.org 装 64 位 Python 3.10+，安装时勾选 Add python.exe to PATH",
        )
    )

    version = wechatauto_version()
    checks.append(
        check(
            "wechatauto",
            "wechatauto-replica",
            "ok" if version else "fail",
            f"已安装 {version}" if version else "没装（pip 里找不到这个包）",
            None if version else "点「安装运行依赖」，或手动执行：python -m pip install --upgrade wechatauto-replica",
        )
    )

    exe = wechat_installed()
    checks.append(
        check(
            "wechat-installed",
            "微信桌面版",
            "ok" if exe else "fail",
            f"已安装：{exe}" if exe else "没在常见路径找到 Weixin.exe",
            None if exe else "装 4.x 版微信桌面客户端（老版 3.x 的数据库结构不一样）",
        )
    )
    running = wechat_running()
    checks.append(
        check(
            "wechat-running",
            "微信正在运行",
            "ok" if running else "warn",
            "微信在跑，读消息才能解密数据库" if running else "微信没在跑：数据库密钥拿不到，读消息会失败",
            None if running else "先登录电脑版微信，再点「重新体检」",
        )
    )

    account: Optional[Dict[str, Any]] = None
    can_read = False
    can_send = False
    db = load_db()
    if db is None:
        checks.append(
            check(
                "wechat-db",
                "微信数据库",
                "fail",
                f"打不开：{STATE.db_error or '未知原因'}",
                "确认微信已登录；首次解密约 6 秒，失败可以点「诊断」看密钥缓存",
            )
        )
    else:
        try:
            info = db.get_self_info() or {}
            wxid = str(getattr(db, "wxid", "") or info.get("wxid") or "")
            nickname = info.get("nickname") or info.get("nick_name") or None
            account = {"wxid": wxid, "nickname": nickname}
            can_read = True
            checks.append(check("wechat-db", "微信数据库", "ok", f"已解密（账号 {nickname or wxid}）"))
        except Exception as error:  # noqa: BLE001
            checks.append(
                check("wechat-db", "微信数据库", "fail", f"能连上但读账号失败：{type(error).__name__}: {error}")
            )

    try:
        import wechatauto.guia  # type: ignore  # noqa: F401

        can_send = True
        checks.append(check("guia", "发消息通道（GUI）", "ok", "界面驱动模块可用；发送时会抢占前台，请别在发送时动鼠标键盘"))
    except Exception as error:  # noqa: BLE001
        STATE.guia_error = f"{type(error).__name__}: {error}"
        checks.append(
            check(
                "guia",
                "发消息通道（GUI）",
                "fail",
                f"加载失败：{STATE.guia_error}",
                "多半是缺 pywin32 / pyautogui / opencv-python 这类依赖，点「安装运行依赖」重装",
            )
        )

    ok = all(item["state"] != "fail" for item in checks)
    return {
        "ok": ok,
        "checks": checks,
        "account": account,
        "canRead": can_read,
        "canSend": can_send,
    }


# ----------------------------------------------------------------------------- 业务方法


def method_hello(params: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "version": SIDECAR_VERSION,
        "python": platform.python_version(),
        "wechatauto": wechatauto_version(),
        "platform": platform.platform(),
    }


def method_health(params: Dict[str, Any]) -> Dict[str, Any]:
    return build_health()


def method_configure(params: Dict[str, Any]) -> Dict[str, Any]:
    raw = str(params.get("chatUsername") or CHAT_DEFAULT)
    with STATE.lock:
        STATE.chat_username = normalize_username(raw)
        title = None
        db = load_db()
        if db is not None:
            try:
                title = db.get_nickname(STATE.chat_username)
            except Exception as error:  # noqa: BLE001
                log(f"取会话标题失败：{error}")
        STATE.chat_title = str(title) if title else None
        return {"ok": True, "chatUsername": STATE.chat_username, "chatTitle": STATE.chat_title}


def method_poll(params: Dict[str, Any]) -> Dict[str, Any]:
    db = load_db()
    if db is None:
        return {"messages": [], "nextSeq": int(params.get("sinceSeq") or 0), "error": STATE.db_error}
    since = int(params.get("sinceSeq") or 0)
    limit = max(1, min(500, int(params.get("limit") or 100)))
    with STATE.lock:
        username = STATE.chat_username
    try:
        rows = db.get_new_messages(username, since_seq=since, limit=limit) or []
    except Exception as error:  # noqa: BLE001
        return {
            "messages": [],
            "nextSeq": since,
            "error": f"{type(error).__name__}: {error}",
        }
    messages: List[Dict[str, Any]] = []
    next_seq = since
    for row in rows:
        seq = int(row.get("sort_seq") or row.get("seq") or 0)
        next_seq = max(next_seq, seq)
        messages.append(
            {
                "seq": seq,
                "msgId": str(row.get("msg_id") or row.get("msgId") or "") or None,
                "chatUsername": str(row.get("username") or username),
                "senderUsername": str(row.get("sender") or row.get("sender_username") or ""),
                "isSelf": bool(row.get("is_self") if "is_self" in row else row.get("isSelf")),
                "kind": str(row.get("kind") or row.get("type") or "text"),
                "text": row.get("content") if row.get("content") is not None else row.get("text"),
            }
        )
    return {"messages": messages, "nextSeq": next_seq}


def method_send(params: Dict[str, Any]) -> Dict[str, Any]:
    text = str(params.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "不发送空文本"}
    raw = str(params.get("chatUsername") or STATE.chat_username or CHAT_DEFAULT)
    try:
        import wechatauto.guia as guia  # type: ignore
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"发消息模块不可用：{type(error).__name__}: {error}"}

    with STATE.lock:
        username = normalize_username(raw)
        title = STATE.chat_title
    try:
        response = guia.quick_send(text, who=username, verify=False)
    except TypeError:
        # 兼容旧签名：没有 who 参数时先切会话再发（上游不同版本差异）
        try:
            switch = getattr(guia, "open_chat", None) or getattr(guia, "switch_chat", None)
            if switch is not None:
                switch(username)
            response = guia.quick_send(text, verify=False)
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "error": f"{type(error).__name__}: {error}"}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}

    ok = True
    for attribute in ("success", "ok", "sent"):
        value = getattr(response, attribute, None)
        if isinstance(value, bool):
            ok = value
            break
    return {
        "ok": ok,
        "chatUsername": username,
        "chatTitle": title,
        "detail": str(response)[:500],
    }


def method_doctor(params: Dict[str, Any]) -> Dict[str, Any]:
    action = str(params.get("action") or "diagnose-keys")
    lines: List[str] = []
    lines.append(f"sidecar {SIDECAR_VERSION} / python {platform.python_version()} / {platform.platform()}")
    lines.append(f"wechatauto: {wechatauto_version() or '未安装'}")
    lines.append(f"微信安装路径: {wechat_installed() or '未找到'}")
    lines.append(f"微信在运行: {wechat_running()}")
    lines.append(f"聊天白名单: {STATE.chat_username}（{STATE.chat_title or '标题未知'}）")
    lines.append(f"数据库错误: {STATE.db_error or '无'}")
    lines.append(f"GUI 错误: {STATE.guia_error or '无'}")
    try:
        cache = os.path.join(os.environ.get("TEMP", ""), "wechatauto_db")
        if os.path.isdir(cache):
            for root, _dirs, files in os.walk(cache):
                for name in files:
                    lines.append(f"密钥缓存: {os.path.join(root, name)}")
        else:
            lines.append(f"密钥缓存: 还没有（{cache}）")
    except Exception as error:  # noqa: BLE001
        lines.append(f"列密钥缓存失败: {error}")

    if action == "dump-account":
        db = load_db()
        if db is None:
            lines.append("账号信息: 数据库没打开，读不到")
        else:
            try:
                lines.append(f"账号: {json.dumps(db.get_self_info() or {}, ensure_ascii=False)[:800]}")
                lines.append(f"wxid: {getattr(db, 'wxid', '?')}")
            except Exception as error:  # noqa: BLE001
                lines.append(f"读账号失败: {type(error).__name__}: {error}")
    return {"ok": True, "output": "\n".join(lines)}


METHODS = {
    "hello": method_hello,
    "health": method_health,
    "configure": method_configure,
    "poll": method_poll,
    "send": method_send,
    "doctor": method_doctor,
}


# ----------------------------------------------------------------------------- 主循环


def handle(line: str) -> None:
    try:
        request = json.loads(line)
    except Exception:
        log("收到不是 JSON 的一行，已忽略")
        return
    request_id = request.get("id")
    method = str(request.get("method") or "")
    params = request.get("params") or {}
    handler = METHODS.get(method)
    if handler is None:
        emit({"id": request_id, "error": {"code": "ENOMETHOD", "message": f"不认识的方法：{method}"}})
        return
    started = time.time()
    try:
        result = handler(params if isinstance(params, dict) else {})
        emit({"id": request_id, "result": result})
    except Exception as error:  # noqa: BLE001
        emit(
            {
                "id": request_id,
                "error": {
                    "code": "EINTERNAL",
                    "message": f"{type(error).__name__}: {error}",
                    "trace": traceback.format_exc()[-1500:],
                },
            }
        )
    finally:
        elapsed = int((time.time() - started) * 1000)
        if elapsed > 2000:
            log(f"{method} 用了 {elapsed}ms")


def main() -> None:
    parser = argparse.ArgumentParser(description="Anteros 内置微信通道 sidecar")
    parser.add_argument("--self-test", action="store_true", help="打印一次体检结果就退出（调试用）")
    args = parser.parse_args()
    if args.self_test:
        print(json.dumps(method_health({}), ensure_ascii=False, indent=2))
        return

    # 让 Windows 控制台的编码问题不至于把中文日志打死
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    log(f"sidecar {SIDECAR_VERSION} 启动（python {platform.python_version()}）")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        handle(line)
        # 读文件/驱动 GUI 都是阻塞操作，这里主动让出一次时间片，避免事件堆积
        time.sleep(0)


if __name__ == "__main__":
    main()