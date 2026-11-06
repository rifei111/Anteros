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
import contextlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile

try:  # Windows 专有的文件锁：保证同一时刻只有一个发送在动界面
    import msvcrt
except ImportError:  # pragma: no cover - 非 Windows 下退化为无锁
    msvcrt = None  # type: ignore[assignment]
import threading
import time
import traceback
from typing import Any, Dict, List, Optional

SIDECAR_VERSION = "1.0.0"
CHAT_DEFAULT = "filehelper"  # 文件传输助手：最安全的默认白名单

# 便携版 Python（python-3.11.9-embed-amd64）带 python311._pth，这个文件一存在，
# 解释器就不再自动把「脚本所在目录」放进 sys.path。于是 `import audio_out` 这种
# 同级模块会 ModuleNotFoundError——本机调试时手动加过路径，装到应用里就暴露了。
# 这里显式补一次，对所有同级模块（audio_out 等）都生效。
_SELF_DIR = os.path.dirname(os.path.abspath(__file__))
if _SELF_DIR not in sys.path:
    sys.path.insert(0, _SELF_DIR)

# ----------------------------------------------------------------------------- 全局状态


class State:
    def __init__(self) -> None:
        self.chat_username: str = CHAT_DEFAULT
        self.chat_title: Optional[str] = None
        self.db: Any = None
        self.db_error: Optional[str] = None
        self.gui: Any = None
        self.gui_error: Optional[str] = None
        self.lock = threading.RLock()
        self._wechatauto_version: Optional[str] = None
        self._hello_done = False
        self.voice_probe: Optional[Dict[str, Any]] = None
        self.voice_probe_ts: float = 0.0


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


_TITLE_CACHE: Dict[str, str] = {}


_MAX_GROUP_MEMBERS_IN_TITLE = 4


def compose_group_title(db: Any, chatroom_wxid: str) -> str:
    """没有自定义群名时，按微信的显示规则拼「成员昵称、成员昵称…」。

    微信对没起名的群显示前几个成员名；搜索框按这个串能命中该群。
    拼不出来就返回空串，让调用方退到「只按 wxid 搜」而不是猜一个名字。
    """
    try:
        groups = db.get_groups() or []
    except Exception:  # noqa: BLE001
        return ""
    for group in groups:
        if str(group.get("username") or "") != chatroom_wxid:
            continue
        names: List[str] = []
        for member in group.get("members") or []:
            nickname = str(member.get("remark") or member.get("nick_name") or "").strip()
            if nickname and nickname not in names:
                names.append(nickname)
            if len(names) >= _MAX_GROUP_MEMBERS_IN_TITLE:
                break
        return "、".join(names)
    return ""

def resolve_chat_title(username: str) -> str:
    """把 wxid / xxx@chatroom 解析成界面里显示的会话名。

    群聊的显示名必须解析出来：只传 wxid 时上游要按名字搜索会话，
    搜不到就会退回「当前打开的会话」，于是回复发错人。
    """
    key = normalize_username(username)
    if not key:
        return ""
    cached = _TITLE_CACHE.get(key)
    if cached is not None:
        return cached
    title = ""
    try:
        db = load_db()
        if db is not None:
            for session in db.get_sessions(limit=500) or []:
                if normalize_username(str(session.get("username") or "")) == key:
                    title = str(session.get("title") or "").strip()
                    break
            if not title and key.endswith("@chatroom"):
                # 没有自定义群名时，微信显示的是「成员昵称、成员昵称…」这种自动名。
                # 这种群在库里 nick_name 是空的，只能照微信的规则拼一个出来。
                title = compose_group_title(db, key)
            if not title:
                title = str(db.get_nickname(key) or "").strip()
    except Exception:  # noqa: BLE001
        title = ""
    _TITLE_CACHE[key] = title
    return title

def get_gui() -> Any:
    """复用同一个 WeChatGUI 实例。

    上游的 `quick_send()` 每次调用都会 `WeChatGUI()` 新建一个实例，实例里缓存的
    `_uia`、`_current_chat`、`_last_input_box` 就全丢了 —— 于是每发一条都要
    重新找窗口、重新搜会话、重新 OCR，一条回复要十几秒。这里改成进程内复用，
    第一次定位之后，后续发送走 UIA 的「当前会话已经是目标」快路径。
    """
    with STATE.lock:
        if STATE.gui is not None:
            return STATE.gui
        try:
            import wechatauto.guia as guia  # type: ignore

            STATE.gui = guia.WeChatGUI()
            STATE.gui_error = None
            log("界面驱动已就绪（后续发送复用同一个实例）")
        except Exception as error:  # noqa: BLE001
            STATE.gui = None
            STATE.gui_error = f"{type(error).__name__}: {error}"
            log(f"界面驱动初始化失败：{STATE.gui_error}")
        return STATE.gui


def alias_lookup(db: Any, value: str) -> Optional[str]:
    """按**微信号**（contact.alias）反查 wxid。

    上游只公开了按昵称/备注查（username_by_nickname），但人平时记的是微信号
    （比如 rifei111），不是 wxid_xxx。这里补一条别名查询：先试 contact.alias，
    退回 search_contact 的唯一命中。查不到就返回 None，由调用方决定怎么提示。
    """
    key = (value or "").strip()
    if not key:
        return None
    try:
        conn = db._contact_conn()  # noqa: SLF001 - 上游没有公开的别名查询接口
    except Exception as error:  # noqa: BLE001
        conn = None
        log(f"取联系人库连接失败：{error}")
    if conn is not None:
        try:
            row = conn.execute(
                "SELECT username FROM contact WHERE alias = ? COLLATE NOCASE LIMIT 1",
                (key,),
            ).fetchone()
            if row and row[0]:
                return str(row[0])
        except Exception as error:  # noqa: BLE001
            log(f"按微信号查联系人失败（{key}）：{error}")
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - 关不上就算了
                pass
    try:
        rows = db.search_contact(key) or []
    except Exception as error:  # noqa: BLE001
        log(f"search_contact 失败（{key}）：{error}")
        return None
    for row in rows:
        username = str(row.get("username") or "")
        if username and (row.get("alias") or "").lower() == key.lower():
            return username
    return None


def normalize_username(raw: str) -> str:
    """把会话标识归一：wxid_* / xxx@chatroom 直接用，其它先按昵称、再按微信号查。"""
    value = (raw or "").strip() or CHAT_DEFAULT
    if value.startswith("wxid_") or value.endswith("@chatroom") or value == CHAT_DEFAULT:
        return value
    db = load_db()
    if db is None:
        return value
    try:
        resolved = db.username_by_nickname(value)
        if resolved:
            return str(resolved)
    except Exception as error:  # noqa: BLE001
        log(f"昵称转会话标识失败（{value}）：{error}")
    by_alias = alias_lookup(db, value)
    if by_alias:
        log(f"按微信号解析会话：{value} → {by_alias}")
        return by_alias
    log(f"没解析出会话「{value}」：昵称和微信号都没对上，会去读一个不存在的会话")
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
        # resolved：这个会话真的在联系人库里存在吗？不存在就别让界面以为在跟人说话
        resolved = STATE.chat_title is not None
        if not resolved and db is not None:
            try:
                resolved = bool((db.search_contact(STATE.chat_username) or []))
            except Exception:  # noqa: BLE001 - 查不到就是没解析出来
                resolved = False
        return {
            "ok": True,
            "chatUsername": STATE.chat_username,
            "chatTitle": STATE.chat_title,
            "resolved": resolved,
        }


KIND_MAP = {
    "文本": "text",
    "文字": "text",
    "图片": "image",
    "语音": "voice",
    "视频": "video",
    "文件": "file",
    "表情": "sticker",
    "动画表情": "sticker",
    "系统消息": "system",
    "引用": "quote",
    "位置": "location",
    "位置共享": "location",
    "链接": "link",
    "名片": "card",
    "转账": "transfer",
    "红包": "redpacket",
    "撤回": "revoke",
}


def normalize_kind(raw: Any) -> str:
    """把上游的中文消息类型归一成内核认识的英文 kind。

    上游 get_new_messages 给的 kind 是中文（"文本"、"图片"、"系统消息"…），
    内核按 "text" 过滤。之前直接把中文原样透传，内核那条 `kind !== "text"`
    就把**所有**消息都丢掉了，表现成"通道就绪、也读得到，但永远不回"。
    """
    value = str(raw or "").strip()
    if not value:
        return "text"
    mapped = KIND_MAP.get(value)
    if mapped:
        return mapped
    lowered = value.lower()
    if lowered in KIND_MAP.values():
        return lowered
    return "other"


GROUP_PREFIX = re.compile(r"^[A-Za-z0-9_@.\-]{3,64}[:：]\n?")


def self_names() -> List[str]:
    """当前登录账号在群聊里可能被 @ 的名字：昵称 + 备注。"""
    names: List[str] = []
    db = load_db()
    if db is None:
        return names
    try:
        info = db.get_self_info() or {}
    except Exception:  # noqa: BLE001
        return names
    for key in ("nick_name", "remark"):
        value = str(info.get(key) or "").strip()
        if value and value not in names:
            names.append(value)
    return names


def clean_group_text(raw: Any, sender: str) -> str:
    """剥掉群消息里的 "发送者wxid:\\n" 前缀。"""
    value = str(raw or "")
    if sender:
        for colon in (":", "："):
            prefix = f"{sender}{colon}"
            if value.startswith(prefix):
                value = value[len(prefix) :]
                break
    match = GROUP_PREFIX.match(value)
    if match:
        value = value[match.end() :]
    return value.strip()


def mentioned_me(text_value: str, names: List[str]) -> bool:
    """群里有没有 @ 我，或 @所有人。"""
    if not text_value:
        return False
    # 全角＠也要认：有人用中文输入法打出来的就是全角
    normalized = text_value.replace("＠", "@")
    lowered = normalized.lower()
    for token in ("@所有人", "@all", "@全体成员"):
        if token.lower() in lowered:
            return True
    lowered_names = [name.lower() for name in names if name]
    for name in lowered_names:
        if f"@{name}" in lowered:
            return True
    return False


def is_group_chat(username: str) -> bool:
    """群会话的 username 一定是 xxx@chatroom；私聊是 wxid_* / 自定义微信号。"""
    return str(username or "").strip().lower().endswith("@chatroom")


def method_list_chats(params: Dict[str, Any]) -> Dict[str, Any]:
    """最近会话（session.db 的 SessionTable）。内核的"从最近会话添加"用它。"""
    db = load_db()
    if db is None:
        return {"chats": [], "error": STATE.db_error}
    limit = max(1, min(200, int(params.get("limit") or 40)))
    try:
        sessions = db.get_sessions(limit=limit) or []
    except Exception as error:  # noqa: BLE001
        return {"chats": [], "error": f"{type(error).__name__}: {error}"}
    chats: List[Dict[str, Any]] = []
    for row in sessions:
        username = str(row.get("username") or "")
        if not username or username.endswith("@chatroom_placeholder"):
            continue
        # 公众号 / 折叠群聊等系统账号用 wxid_ 之外的前缀，这里按需过滤最常见的噪声
        if username.startswith("gh_") or username == "weixin":
            continue
        title = str(row.get("title") or "") or str(row.get("summary") or "") or username
        chats.append(
            {
                "username": username,
                "title": title,
                "kind": "group" if is_group_chat(username) else "direct",
                "unread": int(row.get("unread") or 0),
                "lastTime": int(row.get("last_time") or 0),
                "lastSender": str(row.get("last_sender") or ""),
            }
        )
    return {"chats": chats, "self": str(getattr(db, "wxid", "") or "")}


def method_inspect(params: Dict[str, Any]) -> Dict[str, Any]:
    """按会话读最近消息（只读，用于自检"到底读没读到"）。"""
    db = load_db()
    if db is None:
        return {"ok": False, "error": STATE.db_error, "messages": []}
    raw = str(params.get("chatUsername") or STATE.chat_username or CHAT_DEFAULT)
    username = normalize_username(raw)
    limit = max(1, min(100, int(params.get("limit") or 20)))
    try:
        rows = db.get_messages(username, limit=limit) or []
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"{type(error).__name__}: {error}", "messages": []}
    self_wxid = str(getattr(db, "wxid", "") or "")
    is_group = str(username or "").endswith("@chatroom")
    names = self_names() if is_group else []
    messages: List[Dict[str, Any]] = []
    for row in rows:
        sender = str(row.get("sender_username") or row.get("sender") or "")
        content = row.get("content") if row.get("content") is not None else row.get("text")
        body = clean_group_text(content, sender) if is_group else str(content or "")
        messages.append(
            {
                "chatUsername": username,
                "senderUsername": sender,
                "isSelf": bool(self_wxid) and sender == self_wxid,
                "kind": normalize_kind(row.get("kind") or row.get("type")),
                "text": body[:400],
                "mentioned": mentioned_me(body, names) if is_group else False,
                "createTime": int(row.get("create_time") or 0),
            }
        )
    return {
        "ok": True,
        "chatUsername": username,
        "chatTitle": STATE.chat_title,
        "self": self_wxid,
        "messages": messages,
    }


def method_poll(params: Dict[str, Any]) -> Dict[str, Any]:
    db = load_db()
    if db is None:
        return {
            "messages": [],
            "nextSeq": int(params.get("sinceSeq") or 0),
            "nextSeqs": {},
            "error": STATE.db_error,
        }
    fallback_since = int(params.get("sinceSeq") or 0)
    limit = max(1, min(500, int(params.get("limit") or 100)))
    # 内核传进来的「这条时间之前的消息一律不要」：清空记忆/重启后不能把历史
    # 消息当新消息逐条回复，否则用户会看到它对着旧消息一条条作答。
    try:
        skip_before_ts = int(float(params.get("skipBeforeTs") or 0))
    except (TypeError, ValueError):
        skip_before_ts = 0
    with STATE.lock:
        default_chat = STATE.chat_username
        default_title = STATE.chat_title

    # 内核会一次把「所有要盯的会话」带过来：群聊和私聊同时盯，各盯各的水位。
    targets: List[Dict[str, Any]] = []
    raw_chats = params.get("chats")
    if isinstance(raw_chats, list):
        for item in raw_chats:
            if not isinstance(item, dict):
                continue
            username = str(item.get("username") or "").strip()
            if not username:
                continue
            targets.append(
                {
                    "username": username,
                    "title": str(item.get("title") or ""),
                    "kind": "group" if str(item.get("kind") or "").lower() == "group" else "direct",
                    "sinceSeq": int(item.get("sinceSeq") or 0),
                }
            )
    if not targets:
        username = str(default_chat or "")
        targets = [
            {
                "username": username,
                "title": str(default_title or ""),
                "kind": "group" if username.endswith("@chatroom") else "direct",
                "sinceSeq": fallback_since,
            }
        ]

    # 上游 get_new_messages 返回的字段是 local_id / type / sender_username / content /
    # sort_seq / shard，**没有 is_self**。以前按 is_self 取，永远拿到 False，
    # 于是它自己发出去的回复又会被当成新消息读回来 → 自己跟自己无限对话。
    # 正确判据：发送者 wxid 等于当前登录账号的 wxid。
    self_wxid = str(getattr(db, "wxid", "") or "")
    all_names = self_names()
    messages: List[Dict[str, Any]] = []
    next_seqs: Dict[str, int] = {}
    error: Optional[str] = None
    nick_cache: Dict[str, str] = {}

    def sender_title(username: str) -> str:
        if not username:
            return ""
        cached = nick_cache.get(username)
        if cached is not None:
            return cached
        try:
            value = db.get_nickname(username)
        except Exception:  # noqa: BLE001
            value = None
        text_value = str(value or "").strip()
        nick_cache[username] = text_value
        return text_value

    # 内核传进来的是用户在设置里写的「会话标识」，可能是微信号（rifei111）、
    # 昵称，也可能是 wxid_xxx / xxx@chatroom。数据库只认后者，所以这里必须先归一，
    # 否则拿 rifei111 去查消息永远返回空——表现就是通道一切正常但一条消息都收不到。
    resolved_cache: Dict[str, str] = {}

    def resolve_target(username: str) -> str:
        key = username.strip()
        if not key:
            return key
        cached = resolved_cache.get(key)
        if cached is not None:
            return cached
        resolved = normalize_username(key)
        resolved_cache[key] = resolved
        if resolved != key:
            log(f"巡检会话归一：{key} → {resolved}")
        return resolved

    for target in targets:
        username = target["username"]
        chat_since = max(int(target.get("sinceSeq") or 0), 0)
        next_seqs[username] = chat_since
        db_username = resolve_target(username)
        is_group = target["kind"] == "group" or is_group_chat(username)
        try:
            rows = db.get_new_messages(db_username, since_seq=chat_since, limit=limit) or []
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            continue
        for row in rows:
            seq = int(row.get("sort_seq") or row.get("seq") or 0)
            next_seqs[username] = max(next_seqs[username], seq)
            if skip_before_ts > 0:
                try:
                    created = int(row.get("create_time") or row.get("create_ts") or 0)
                except (TypeError, ValueError):
                    created = 0
                if created > 0 and created < skip_before_ts:
                    continue
            sender = str(row.get("sender_username") or row.get("sender") or "")
            is_self = bool(self_wxid) and sender == self_wxid
            raw_text = row.get("content") if row.get("content") is not None else row.get("text")
            text_value = clean_group_text(raw_text, sender) if is_group else raw_text
            messages.append(
                {
                    "seq": seq,
                    "msgId": str(row.get("msg_id") or row.get("server_id") or row.get("local_id") or "") or None,
                    "chatUsername": username,
                    "chatTitle": target.get("title") or "",
                    "chatKind": "group" if is_group else "direct",
                    "senderUsername": sender,
                    "senderTitle": sender_title(sender) if is_group else "",
                    "isSelf": is_self,
                    "kind": normalize_kind(row.get("kind") or row.get("type")),
                    "text": text_value,
                    "mentioned": (mentioned_me(text_value, all_names) if is_group else False),
                }
            )

    result: Dict[str, Any] = {"messages": messages, "nextSeqs": next_seqs}
    if next_seqs:
        result["nextSeq"] = max(next_seqs.values())
    else:
        result["nextSeq"] = fallback_since
    if error:
        result["error"] = error
    return result

# 单条消息的发送上限：超过就当界面卡住，放弃这一条（内核那边还有自己的超时）
SEND_TIMEOUT_SECONDS = 20.0
# 一批最多等多久（首条）：上游拟人节流可能在发送前就 sleep 最多 75 秒
BATCH_TIMEOUT_BASE_SECONDS = 90.0
# 一次回复拆成多条时，每条之间的停顿（模拟人打字完一句再敲下一句）
BATCH_SEND_STEP_SECONDS = 1.6
WARMUP_TIMEOUT_SECONDS = 25.0


def _runtime_python() -> str:
    """跑在哪个解释器里：子进程发送要用同一个（便携 Python 里才装了 wechatauto）。"""
    return sys.executable or "python"


def _run_isolated(payload: Dict[str, Any], timeout_seconds: float) -> Dict[str, Any]:
    """把界面操作丢到一个子进程里做，超时就杀掉。

    为什么要子进程：uiautomation / WinRT 的调用会卡在 C 层并占着 GIL，主线程里的
    「看门狗」根本抢不到 CPU 去回话，表现就是整条通道一起卡死（连巡检都停）。
    子进程被杀掉时，Python 层的一切都会跟着结束，主进程只损失这一次发送。
    """
    script = os.path.abspath(__file__)
    try:
        completed = subprocess.run(
            [_runtime_python(), script, "--isolated", json.dumps(payload, ensure_ascii=False)],
            timeout=max(5.0, float(timeout_seconds)),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "微信界面 %.0f 秒没响应，已强制结束这次操作（后面的消息不受影响）" % timeout_seconds}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": "拉起发送进程失败：%s" % error}

    for line in reversed((completed.stdout or "").strip().splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(parsed, dict) and "ok" in parsed:
            return parsed
    tail = (completed.stderr or completed.stdout or "").strip().splitlines()
    return {"ok": False, "error": (tail[-1] if tail else "发送进程没有返回结果")[:400]}


def method_send(params: Dict[str, Any]) -> Dict[str, Any]:
    raw_texts = params.get("texts")
    texts: List[str] = []
    if isinstance(raw_texts, list):
        for item in raw_texts:
            value = str(item or "").strip()
            if value:
                texts.append(value)
    text = str(params.get("text") or "").strip()
    if not texts and not text:
        return {"ok": False, "error": "不发送空文本"}
    raw = str(params.get("chatUsername") or STATE.chat_username or CHAT_DEFAULT)
    requested_title = str(params.get("chatTitle") or "").strip()
    with STATE.lock:
        username = normalize_username(raw)
        configured = normalize_username(str(STATE.chat_username or ""))

    # 界面里认的是会话显示名；传 wxid 每发一条都要重新搜会话。
    # 但白名单会话的标题绝不能拿来兜底别的目标——那会把群消息发到白名单那个人。
    title = requested_title or resolve_chat_title(username) or ""
    if username and configured and username == configured and not title:
        title = STATE.chat_title or ""

    payload: Dict[str, Any] = {
        "action": "send",
        "text": text,
        "username": username,
        "title": title,
        "verify": bool(params.get("verify")),
    }
    if texts:
        payload["texts"] = texts
    # 只在一种目标上试一次：以前失败后会换另一种写法重试，结果是「已经发出去了、
    # 但回读没确认上」时又发一遍，群里看到的就是同一条消息出现两次。
    # 预算要给够：上游拟人节流（rhythm.py）120 秒内写满 6 次后会真的 sleep 30–75 秒，
    # 一条回复 6 段就可能撞上；宁可多等，也不要杀子进程导致「只发出去前三句」。
    budget = BATCH_TIMEOUT_BASE_SECONDS + (BATCH_SEND_STEP_SECONDS + 20.0) * max(0, len(texts) - 1)
    result = _run_isolated(payload, budget)
    sent = int(result.get("sent") or 0) if isinstance(result, dict) else 0
    if result.get("ok"):
        return {
            "ok": True,
            "sent": sent or (len(texts) if texts else 1),
            "chatUsername": username,
            "chatTitle": title,
            "detail": str(result.get("detail") or "")[:500],
        }
    try:
        with STATE.lock:
            STATE.gui = None
    except Exception:  # noqa: BLE001
        pass
    return {
        "ok": False,
        # 发到一半失败时也要把「已经发出去几条」带回去：内核要按这个数把剩下的标成失败，
        # 不然界面显示全部已发送，用户以为对方收到了。
        "sent": sent,
        "chatUsername": username,
        "chatTitle": title,
        "error": str(result.get("error") or "发送失败")[:500],
    }


def isolated_warmup(payload: Dict[str, Any]) -> Dict[str, Any]:
    """子进程里只做一件事：把目标会话打开（后面发消息就只剩粘贴 + 回车）。"""
    username = str(payload.get("username") or "")
    title = str(payload.get("title") or "")
    target = title or username
    if not target:
        return {"ok": False, "error": "没给预热目标"}
    try:
        import wechatauto.guia as gui_module  # type: ignore

        gui = gui_module.WeChatGUI()
        gui.open_chat(target)
        return {"ok": True, "detail": "已打开 %s" % target}
    except BaseException as error:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}


SEND_LOCK_PATH = os.path.join(tempfile.gettempdir(), "anteros-wechat-send.lock")


@contextlib.contextmanager
def send_lock(timeout: float = 30.0):
    """同一时刻只允许一个发送在动微信界面。

    没有这把锁时，两条消息（不同对话、或上一轮的重试）会同时去点搜索框：
    一个刚打开会话 A，另一个已经把消息粘进了 B 的输入框——用户看到的就是
    「切换聊天时切换异常，还停在上一个聊天界面，消息发不出去」。
    """
    handle = open(SEND_LOCK_PATH, "a+b")
    if msvcrt is None:  # pragma: no cover
        try:
            yield
        finally:
            handle.close()
        return
    deadline = time.time() + timeout
    acquired = False
    try:
        while not acquired:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                acquired = True
            except OSError:
                if time.time() >= deadline:
                    raise RuntimeError("上一个发送还没结束（等了 %.0f 秒），这次先不发" % timeout)
                time.sleep(0.15)
        yield
    finally:
        if acquired:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        handle.close()


def _chat_key(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or ""))


# 上一次真的发到哪个会话：跨进程记在盘上。
# 每次发送都是一个新的 Python 子进程，`WeChatGUI()` 也是新对象，`_current_chat` 永远是空的，
# 所以"界面上现在开着谁"读不到；不记盘的话每条消息都要重新点开搜索框搜一次（用户 2026-11-06 报的）。
_CHAT_STATE_TTL_SECONDS = 120.0
_ENSURE_VIA_CACHE = False


def _chat_state_path() -> str:
    base = os.environ.get("ANTEROS_DATA_DIR") or os.path.join(
        os.environ.get("APPDATA") or tempfile.gettempdir(), "Anteros"
    )
    return os.path.join(base, "wechat-last-chat.json")


def _read_chat_state() -> Dict[str, Any]:
    try:
        with open(_chat_state_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except BaseException:  # noqa: BLE001
        return {}


def _write_chat_state(username: str, title: str) -> None:
    try:
        path = _chat_state_path()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        payload = {"username": username or "", "title": title or "", "ts": time.time()}
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except BaseException:  # noqa: BLE001
        return


def _clear_chat_state() -> None:
    try:
        os.remove(_chat_state_path())
    except BaseException:  # noqa: BLE001
        return


def _chat_state_matches(state: Dict[str, Any], target: str, username: str) -> bool:
    """盘上记的会话跟这次要发的是不是同一处。只看最近两分钟：时间长了界面早被人点走了。"""
    if not state:
        return False
    try:
        age = time.time() - float(state.get("ts") or 0)
    except (TypeError, ValueError):
        return False
    if age < 0 or age > _CHAT_STATE_TTL_SECONDS:
        return False
    want_target = _chat_key(target)
    want_username = _chat_key(username)
    for field in ("title", "username"):
        saved = _chat_key(state.get(field))
        if not saved:
            continue
        if want_target and saved == want_target:
            return True
        if want_username and saved == want_username:
            return True
    return False


def _last_self_text(username: str) -> str:
    """读这个会话最新一条自己发的文字（回读确认用）。"""
    db = load_db()
    if db is None or not username:
        return ""
    try:
        rows = db.get_messages(username, limit=4) or []
    except BaseException:  # noqa: BLE001
        return ""
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("is_self") is True or row.get("isSelf") is True:
            return str(row.get("content") or "")
    return ""


def _verify_text_sent(username: str, text: str) -> bool:
    """跳过搜索直接发时，回读一下这句话是不是真落在目标会话里。

    万一这两分钟里有人手动把界面切到别的聊天，我们就会发错人——这是绝不能接受的。
    宁可报失败让用户知道，也不装作发好了。
    """
    if not username:
        return True
    found = _last_self_text(username)
    if not found:
        # 回读不到（数据库没打开/刚写库有延迟）就别冤枉它
        return True
    want = re.sub(r"\s+", "", text)
    got = re.sub(r"\s+", "", found)
    if not want:
        return True
    head = want[:20]
    return got.startswith(head) or head in got


def current_chat_name(gui: Any) -> str:
    for attribute in ("_current_chat", "current_chat", "_current_chat_title"):
        value = getattr(gui, attribute, None)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _ensure_chat(gui: Any, target: str, username: str = "") -> bool:
    """打开会话并确认界面真的切过去了；切不过去就返回 False（宁可不发，也别发错人）。

    **已经在目标会话上就别再搜一次**：以前每条消息（含紧接着的语音条）都会点开搜索框
    重新搜人，用户看到的是"发一条字，屏幕上搜一次"。这里三道判断，能省就省：
    1. 界面上读得到当前会话名，且就是目标 → 直接发；
    2. 两分钟内刚往这个会话发过（记在盘上的状态文件）→ 直接发，不再搜；
    3. 都不是才真的去搜一次。
    """
    global _ENSURE_VIA_CACHE
    _ENSURE_VIA_CACHE = False
    if not target:
        return True
    current = _current_chat_title() or current_chat_name(gui)
    if current and _chat_key(current) == _chat_key(target):
        _write_chat_state(username, target)
        return True
    if _chat_state_matches(_read_chat_state(), target, username):
        _ENSURE_VIA_CACHE = True
        return True
    for attempt in (1, 2):
        opened = False
        try:
            gui.open_chat(target)
            opened = True
        except BaseException:  # noqa: BLE001
            opened = False
        time.sleep(0.25 if attempt == 1 else 0.5)
        current = current_chat_name(gui)
        if current and _chat_key(current) == _chat_key(target):
            _write_chat_state(username, target)
            return True
        if not current and opened:
            # 上游没暴露「当前会话」时只能信 open_chat 的返回，总比完全不发好
            _write_chat_state(username, target)
            return True
    return False


def _restore_window(gui: Any) -> None:
    """微信窗口可能被最小化或缩到屏幕外，这时界面驱动会一直等（一发送就卡）。

    发送前先把它恢复成普通窗口并拉到前台；失败就算了，不因此阻断发送。
    """
    try:
        import win32con  # type: ignore
        import win32gui  # type: ignore

        hwnd = int(getattr(gui, "hwnd", 0) or 0)
        if hwnd <= 0:
            return
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        offscreen = left <= -16000 or top <= -16000 or right - left < 200 or bottom - top < 200
        if win32gui.IsIconic(hwnd) or offscreen:
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.6)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.2)
    except Exception:  # noqa: BLE001
        return


def isolated_send(payload: Dict[str, Any]) -> Dict[str, Any]:
    """子进程里真正干活的那一半：恢复窗口、打开会话、粘贴、回车。

    payload 里可以给 "texts"（一次发多条）：这样一次回复分成几条气泡时，
    只会搜一次会话、只打开一次窗口，而不是每条都搜一遍——用户能看见搜索框
    被点两次，既慢又难看。
    """
    texts: List[str] = []
    raw_texts = payload.get("texts")
    if isinstance(raw_texts, list):
        for item in raw_texts:
            value = str(item or "").strip()
            if value:
                texts.append(value)
    if texts:
        return isolated_send_many(payload, texts)
    text = str(payload.get("text") or "")
    title = str(payload.get("title") or "")
    username = str(payload.get("username") or "")
    if not text:
        return {"ok": False, "error": "不发送空文本"}
    import wechatauto.guia as gui_module  # type: ignore

    target = title or username or None
    with send_lock():
        return _send_locked(text, target, gui_module, username)


def _send_locked(
    text: str, target: Optional[str], gui_module: Any, username: str = ""
) -> Dict[str, Any]:
    """在发送锁里做事：恢复窗口 → 切会话并确认 → 粘贴。"""
    try:
        gui = gui_module.WeChatGUI()
        _restore_window(gui)
    except BaseException as error:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    if target and not _ensure_chat(gui, target, username):
        return {
            "ok": False,
            "error": "没能切到会话「%s」：界面上还停在上一个聊天，已放弃发送（避免发错人）" % target,
        }
    opened = bool(target)
    try:
        # 刻意不要求上游「数据库回读确认」：它会等 8 秒，然后回一个「消息已操作发送，
        # 但数据库未确认」的失败。把它当失败去重试，就会同一条消息发两遍。
        #
        # 已经切过会话就不要再把 who 传给 send_msg：上游会拿 who 再搜一次会话，
        # 界面上能看到「搜索白名单用户」这个动作做两遍。
        if opened:
            response = gui.send_msg(text, verify=False)
        elif target:
            response = gui.send_msg(text, who=target, verify=False)
        else:
            response = gui.send_msg(text, verify=False)
    except BaseException as error:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    detail = str(response)[:500]
    ok = True
    for attribute in ("success", "ok", "sent"):
        value = getattr(response, attribute, None)
        if isinstance(value, bool):
            ok = value
            break
    if not ok and ("已操作发送" in detail or "已发送" in detail or "成功" in detail):
        # 上游已经动了键盘、只是回读没确认上：算发出去，别重发
        ok = True
    if ok and target:
        _write_chat_state(username, target)
        if _ENSURE_VIA_CACHE and not _verify_text_sent(username, text):
            # 没搜会话就直接发了，结果目标会话里找不到这句话：多半界面被切到别处了。
            # 这种事绝不能装作发好了（发错人是底线），报失败并清掉状态，让用户自己看。
            _clear_chat_state()
            return {
                "ok": False,
                "error": "「%s」里回读不到刚发的这句：界面可能被切到别的会話了" % target,
            }
    return {"ok": bool(ok), "detail": detail, "error": None if ok else detail}

def isolated_send_many(payload: Dict[str, Any], texts: List[str]) -> Dict[str, Any]:
    """一次打开会话，连发多条。少搜几次会话，也少抢几次前台。"""
    title = str(payload.get("title") or "")
    username = str(payload.get("username") or "")
    import time as time_module
    import wechatauto.guia as gui_module  # type: ignore

    target = title or username or None
    with send_lock():
        try:
            gui = gui_module.WeChatGUI()
            _restore_window(gui)
        except BaseException as error:  # noqa: BLE001
            return {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
        if target and not _ensure_chat(gui, target, username):
            return {
                "ok": False,
                "sent": 0,
                "error": "没能切到会话「%s」：界面上还停在上一个聊天，已放弃发送（避免发错人）" % target,
                "detail": "",
            }
        opened = bool(target)
        sent = 0
        last_detail = ""
        for index, value in enumerate(texts):
            if index > 0:
                time_module.sleep(BATCH_SEND_STEP_SECONDS)
            try:
                if opened:
                    response = gui.send_msg(value, verify=False)
                elif target:
                    response = gui.send_msg(value, who=target, verify=False)
                else:
                    response = gui.send_msg(value, verify=False)
            except BaseException as error:  # noqa: BLE001
                return {
                    "ok": False,
                    "sent": sent,
                    "error": "%s: %s" % (type(error).__name__, error),
                    "detail": last_detail,
                }
            detail = str(response)[:300]
            ok = True
            for attribute in ("success", "ok", "sent"):
                attribute_value = getattr(response, attribute, None)
                if isinstance(attribute_value, bool):
                    ok = attribute_value
                    break
            if not ok and ("已操作发送" in detail or "已发送" in detail or "成功" in detail):
                ok = True
            last_detail = detail
            if ok:
                sent += 1
            else:
                return {"ok": False, "sent": sent, "error": detail, "detail": detail}
        if target and sent > 0:
            _write_chat_state(username, target)
        return {"ok": sent == len(texts), "sent": sent, "detail": last_detail, "error": None}


# ----------------------------------------------------------------------------- 语音条
# 思路（docs/微信语音条.md）：微信客户端只从"系统默认录音设备"采集，录完自己编码
# SILK 上传。所以我们把合成好的 wav 播进虚拟声卡（CABLE Input），微信那一头从
# CABLE Output 收到的就是我们的话；同时用键盘"按住右 Alt"让它进入录音态，
# 按住时长 = 音频时长。全程不注入、不改微信内存，客户端始终是个黑盒。

VOICE_PROBE_TTL_SECONDS = 300.0


def _enable_dpi_awareness() -> None:
    """子进程默认不是 DPI 感知的：不设这个，GetWindowRect 给的是逻辑坐标，
    而 SetCursorPos 要物理坐标，点击会整体偏移（实验台上踩过）。"""
    import ctypes

    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        pass


_AUDIO_OUT: Any = None


def _audio_out() -> Any:
    """拿 audio_out 模块：便携版 Python 的 sys.path 不可靠，实在找不到就按文件路径加载。"""
    global _AUDIO_OUT
    if _AUDIO_OUT is not None:
        return _AUDIO_OUT
    try:
        import audio_out as module  # type: ignore
    except ModuleNotFoundError:
        import importlib.util

        path = os.path.join(_SELF_DIR, "audio_out.py")
        spec = importlib.util.spec_from_file_location("audio_out", path)
        if spec is None or spec.loader is None:
            raise ModuleNotFoundError("找不到 audio_out.py：%s" % path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        sys.modules["audio_out"] = module
    _AUDIO_OUT = module
    return module


def _voice_probe(force: bool = False) -> Dict[str, Any]:
    """虚拟声卡桥接自检（带缓存）：默认录音设备真的能听到我们播进去的声音吗。"""
    with STATE.lock:
        cached = STATE.voice_probe
        cached_ts = STATE.voice_probe_ts
    if cached and not force and (time.time() - cached_ts) < VOICE_PROBE_TTL_SECONDS:
        return cached
    try:
        result = _audio_out().bridge_probe()
    except BaseException as error:  # noqa: BLE001
        result = {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    with STATE.lock:
        STATE.voice_probe = result
        STATE.voice_probe_ts = time.time()
    return result


def method_voice_status(params: Dict[str, Any]) -> Dict[str, Any]:
    probe = _voice_probe(bool(params.get("force")))
    return {
        "ok": bool(probe.get("ok")),
        "playbackDevice": probe.get("playbackDevice"),
        "rms": probe.get("rms"),
        "message": probe.get("message") or probe.get("error") or "自检没有结果",
    }


def _foreground_hwnd() -> int:
    import ctypes

    try:
        return int(ctypes.windll.user32.GetForegroundWindow() or 0)
    except Exception:  # noqa: BLE001
        return 0


def _force_foreground(hwnd: int, timeout: float = 2.5) -> bool:
    """把微信抢到最前。SetForegroundWindow 会被"前台锁"拒掉，所以加 AttachThreadInput 兜底。"""
    import ctypes

    if hwnd <= 0:
        return False
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    try:
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001
        pass
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _foreground_hwnd() == hwnd:
            return True
        try:
            current = kernel32.GetCurrentThreadId()
            target = user32.GetWindowThreadProcessId(hwnd, None)
            user32.AttachThreadInput(current, target, True)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.AttachThreadInput(current, target, False)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.15)
    return _foreground_hwnd() == hwnd


class _ForegroundPin:
    """按住说话期间，持续把微信钉在前台。

    真机上反复见到同一种失败：按住的那两秒里别的窗口（浏览器、本应用）把前台抢回去，
    微信当场取消录音，结果"按了、松了、什么都没发出去"，而回读什么都看不到。
    所以从按下到松开之间每 150ms 检查一次，被抢就再抢回来。
    """

    def __init__(self, hwnd: int, interval: float = 0.15) -> None:
        self.hwnd = hwnd
        self.interval = interval
        self.stolen = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self.hwnd > 0 and _foreground_hwnd() != self.hwnd:
                    self.stolen += 1
                    _force_foreground(self.hwnd, timeout=0.6)
            except BaseException:  # noqa: BLE001
                pass
            self._stop.wait(self.interval)

    def __enter__(self) -> "_ForegroundPin":
        self._thread = threading.Thread(target=self._loop, name="anteros-fg-pin", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)


def _voice_fail_shot() -> str:
    """失败时留一张现场截图，下次用户报"没发出去"能直接看当时界面在哪。"""
    try:
        from PIL import ImageGrab  # type: ignore

        root = os.environ.get("ANTEROS_DATA_DIR") or tempfile.gettempdir()
        folder = os.path.join(root, "logs")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "voice-last-fail.png")
        ImageGrab.grab(all_screens=True).save(path)
        return path
    except BaseException:  # noqa: BLE001
        return ""


def _main_hwnd() -> int:
    """找不到 gui.hwnd 时自己找一个：可见、标题是「微信/WeChat」的顶层窗。"""
    try:
        import win32gui  # type: ignore

        hits: List[int] = []
        win32gui.EnumWindows(
            lambda handle, _extra: (
                hits.append(handle)
                if win32gui.IsWindowVisible(handle) and win32gui.GetWindowText(handle) in ("微信", "WeChat", "Weixin")
                else None
            ),
            None,
        )
        return int(hits[0]) if hits else 0
    except Exception:  # noqa: BLE001
        return 0


def _click_chat_input(hwnd: int) -> bool:
    """点一下聊天输入框：按住说话需要键盘焦点在聊天窗口上。"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    client = wintypes.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(client)):
        return False
    origin = wintypes.POINT(0, 0)
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        return False
    width = int(client.right - client.left)
    height = int(client.bottom - client.top)
    if width < 200 or height < 200:
        return False
    x = int(origin.x + width * 0.55)
    y = int(origin.y + height * 0.88)
    user32.SetCursorPos(x, y)
    time.sleep(0.08)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.2)
    return True


def _press_right_alt(down: bool) -> None:
    """按下/松开右 Alt。

    两件事都是真机上踩出来的：
    1) **必须带 KEYEVENTF_EXTENDEDKEY**：右 Alt 是扩展键，不带这个标志 Windows 把它当左 Alt
       （菜单键），微信毫无反应。
    2) **必须用 keybd_event，不能用 SendInput**：实测同一台机器上 SendInput 注入的
       wVk=0xA5 + 扩展标志，微信的键盘钩子不认（还会让输入框失去焦点，像是按了什么菜单键），
       而 keybd_event + 扫描码走同一条路微信就认。别"优化"成 SendInput。
    """
    import ctypes

    user32 = ctypes.windll.user32
    vk_rmenu = 0xA5
    keyeventf_extendedkey = 0x0001
    keyeventf_keyup = 0x0002
    flags = keyeventf_extendedkey | (0 if down else keyeventf_keyup)
    user32.keybd_event(vk_rmenu, user32.MapVirtualKeyW(vk_rmenu, 0), flags, 0)
    return


def _current_chat_title() -> str:
    """读微信当前打开的会话名（读不到就回空串）。发语音前必须核对，否则可能发错人。"""
    try:
        import wechatauto.guia as gui_module  # type: ignore

        uia = getattr(gui_module, "uia", None)
        if uia is not None and hasattr(uia, "current_chat"):
            return str(uia.current_chat() or "").strip()
    except BaseException:  # noqa: BLE001
        pass
    return ""


def _chat_title_matches(target: str, current: str) -> bool:
    if not target:
        return True
    if not current:
        return True  # 读不到就不拦，交给后面的回读兜底
    left = target.strip()
    right = current.strip()
    return left == right or left in right or right in left


def _newest_seq(username: str) -> int:
    """按下之前记一条水位：回读时只看水位之后的新消息。"""
    db = load_db()
    if db is None or not username:
        return 0
    try:
        rows = db.get_messages(username, limit=1) or []
    except BaseException:  # noqa: BLE001
        return 0
    if not rows:
        return 0
    return int(rows[0].get("sort_seq") or rows[0].get("seq") or 0)


def _voice_row_ok(row: Dict[str, Any], duration_ms: int) -> bool:
    content = str(row.get("content") or "")
    match = re.search(r'voicelength="(\d+)"', content)
    length = int(match.group(1)) if match else 0
    if length <= 0:
        return False
    if abs(length - max(duration_ms, 1)) <= 4000:
        return True
    # 时长对不上但确实是语音：微信按播放时长记，宽一点也比"当成没发出去"好
    return length >= 300


def _verify_voice_since(username: str, duration_ms: int, since_seq: int) -> Dict[str, Any]:
    """回读水位之后的新消息里有没有我刚发出的那条语音。

    以前是"看最新一条"，可最新一条常常是刚发出去的文字，于是把成功的语音判成失败、
    又退回发一遍文字。现在按水位过滤，只看按下之后的新消息。
    """
    db = load_db()
    if db is None:
        return {"checked": False, "ok": True, "detail": "数据库没打开，跳过回读"}
    if not username:
        return {"checked": False, "ok": True, "detail": "没有会话 wxid，跳过回读"}
    try:
        rows = db.get_new_messages(username, since_seq=since_seq, limit=10) or []
    except BaseException as error:  # noqa: BLE001
        return {"checked": False, "ok": True, "detail": "回读失败：%s: %s" % (type(error).__name__, error)}
    self_wxid = str(getattr(db, "wxid", "") or "")
    for row in reversed(rows):
        kind = str(row.get("type") or "")
        if "语音" not in kind:
            continue
        sender = str(row.get("sender_username") or "")
        if self_wxid and sender and sender != self_wxid:
            continue
        if not _voice_row_ok(row, duration_ms):
            continue
        content = str(row.get("content") or "")
        match = re.search(r'voicelength="(\d+)"', content)
        return {
            "checked": True,
            "ok": True,
            "type": kind,
            "voicelength": int(match.group(1)) if match else 0,
            "createTime": int(row.get("create_time") or 0),
            "detail": content[:200],
        }
    tail = ""
    if rows:
        tail = str(rows[-1].get("content") or "")[:200]
        last_kind = str(rows[-1].get("type") or "")
    else:
        last_kind = ""
    return {
        "checked": True,
        "ok": False,
        "type": last_kind,
        "voicelength": 0,
        "detail": tail or "水位之后没有新消息",
    }


def isolated_voice(payload: Dict[str, Any]) -> Dict[str, Any]:
    """子进程里发一条语音条：切会话 → 抢前台 → 点输入框 → 按住右 Alt → 播 wav → 松开。"""
    wav = str(payload.get("wav") or "")
    title = str(payload.get("title") or "")
    username = str(payload.get("username") or "")
    duration_ms = int(payload.get("durationMs") or 0)
    if not wav or not os.path.isfile(wav):
        return {"ok": False, "error": "要发的音频文件不存在：%s" % wav}
    try:
        _enable_dpi_awareness()
        audio = _audio_out()
        import wechatauto.guia as gui_module  # type: ignore

        gui = gui_module.WeChatGUI()
        _restore_window(gui)
    except BaseException as error:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}

    target = title or username
    if target and not _ensure_chat(gui, target, username):
        return {
            "ok": False,
            "error": "没能切到会话「%s」：界面上还停在上一个聊天，已放弃发送（避免发错人）" % target,
        }
    # 切完再核一次：真机上见过"以为切过去了、其实还停在上一个聊天"，
    # 那种情况下按住说话会把语音发到别人那里，所以宁可放弃。
    current = _current_chat_title()
    if title and not _chat_title_matches(title, current):
        return {
            "ok": False,
            "error": "界面停在「%s」，不是要发的「%s」：已放弃发送（避免发错人）" % (current or "未知会话", title),
        }
    hwnd = int(getattr(gui, "hwnd", 0) or 0) or _main_hwnd()

    def press_once() -> Dict[str, Any]:
        """按一次「按住说话」：抢前台 → 点输入框 → 按住右 Alt → 播 wav → 松开。"""
        if not _force_foreground(hwnd):
            return {"ok": False, "error": "微信窗口抢不到前台：按住说话必须让窗口在最前面"}
        if not _click_chat_input(hwnd):
            return {"ok": False, "error": "点不到聊天输入框（窗口尺寸异常？）"}
        played_local: Dict[str, Any] = {}
        with send_lock(90.0):
            with _ForegroundPin(hwnd) as pin:
                _press_right_alt(True)
                try:
                    played_local = audio.play_wav(
                        wav, "CABLE Input", timeout_seconds=max(20.0, duration_ms / 1000.0 + 30.0)
                    )
                finally:
                    time.sleep(0.2)
                    _press_right_alt(False)
                played_local["foregroundStolen"] = pin.stolen
                if pin.stolen > 0:
                    played_local["note"] = "按住期间前台被抢走 %d 次（已抢回）" % pin.stolen
        return played_local

    playbacks: list = []
    verify: Dict[str, Any] = {}
    for attempt in range(2):
        # 每次按下之前都重新取一次水位：只看这次按下之后新出现的消息
        base_seq = _newest_seq(username)
        played = press_once()
        playbacks.append(played)
        if not played.get("ok"):
            return {"ok": False, "error": "音频没播出来：%s" % played.get("error")}
        # 松开之后微信还要编码 + 上传，通常 2~4 秒才在库里出现；给到 15 秒
        got = False
        for _round in range(15):
            time.sleep(1.0)
            verify = _verify_voice_since(username, duration_ms, base_seq)
            if verify.get("checked") and verify.get("ok"):
                got = True
                break
        if got:
            if target:
                _write_chat_state(username, target)
            return {
                "ok": True,
                "durationMs": int(played.get("durationMs") or duration_ms),
                "verify": verify,
                "attempts": attempt + 1,
                "detail": "语音条已发送（%s 秒，回读 %sms）"
                % (
                    round(int(played.get("durationMs") or duration_ms) / 1000.0, 1),
                    (verify or {}).get("voicelength") or "?",
                ),
            }
        # 第一次没成，可能是前台被抢走/没进录音态：再补一次
        if attempt == 0:
            time.sleep(1.0)

    shot = _voice_fail_shot()
    return {
        "ok": False,
        "error": "语音没发出去（回读：%s）" % str(verify.get("detail") or "")[:200],
        "playback": playbacks[-1] if playbacks else {},
        "verify": verify,
        "attempts": len(playbacks),
        "screenshot": shot,
    }


def method_voice_send(params: Dict[str, Any]) -> Dict[str, Any]:
    wav = str(params.get("wav") or "")
    if not wav or not os.path.isabs(wav):
        return {"ok": False, "error": "音频路径必须是绝对路径（内核给的是 dataDir 下的 wav）"}
    if not os.path.isfile(wav):
        return {"ok": False, "error": "要发的音频文件不存在：%s" % wav}
    size = os.path.getsize(wav)
    if size <= 0:
        return {"ok": False, "error": "音频是空文件"}
    if size > 8 * 1024 * 1024:
        return {"ok": False, "error": "音频太大（%.1f MB），微信语音条装不下" % (size / 1048576.0)}
    duration_ms = int(params.get("durationMs") or 0)
    if duration_ms <= 0:
        return {"ok": False, "error": "没给时长（微信按按住时长决定语音条长度）"}
    duration_ms = max(300, min(60_000, duration_ms))

    probe = _voice_probe(False)
    if not probe.get("ok"):
        return {
            "ok": False,
            "error": "虚拟声卡没接好：%s" % (probe.get("message") or probe.get("error") or "自检失败"),
        }

    raw = str(params.get("chatUsername") or STATE.chat_username or CHAT_DEFAULT)
    requested_title = str(params.get("chatTitle") or "").strip()
    with STATE.lock:
        username = normalize_username(raw)
        configured = normalize_username(str(STATE.chat_username or ""))
    title = requested_title or resolve_chat_title(username) or ""
    if username and configured and username == configured and not title:
        title = STATE.chat_title or ""

    payload: Dict[str, Any] = {
        "action": "voice",
        "wav": wav,
        "username": username,
        "title": title,
        "durationMs": duration_ms,
    }
    budget = duration_ms / 1000.0 + 45.0
    result = _run_isolated(payload, budget)
    if result.get("ok"):
        return {
            "ok": True,
            "chatUsername": username,
            "chatTitle": title,
            "durationMs": int(result.get("durationMs") or duration_ms),
            "voicelength": (result.get("verify") or {}).get("voicelength"),
            "detail": str(result.get("detail") or "")[:300],
        }
    return {
        "ok": False,
        "chatUsername": username,
        "chatTitle": title,
        "error": str(result.get("error") or "语音发送失败")[:500],
    }


# ----------------------------------------------------------------------------- 虚拟声卡安装
# 微信发语音条的前提是本机有虚拟声卡（VB-CABLE）：合成音频播进 CABLE Input，
# 微信从 CABLE Output 录。老机器早就装好了，新机器要能一键装——这一节只做
# 「怎么找到随应用带的驱动包、怎么提权跑那一个安装程序」。
#
# 驱动包有两种来路：随安装包带着（离线可用），或者当场从官网下（安装包被裁剪、
# 或者用户拿的是绿色版）。后者是「下载」按钮的后端。

# 驱动包可能在的几处：环境变量指定（调试/绿色版）、打包后的 resources、仓库里、下载缓存。
VBCABLE_ENV_DIR = "ANTEROS_VBCABLE_DIR"
VBCABLE_SETUP_NAMES = ("VBCABLE_Setup_x64.exe", "VBCABLE_Setup.exe")
# 官网驱动包（同一个文件，两个入口各试一次：download. 子域是国内偶尔更快的那个）。
VBCABLE_DOWNLOAD_URLS = (
    "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip",
    "https://vb-audio.com/Cable/VBCABLE_Driver_Pack43.zip",
)
VBCABLE_DOWNLOAD_TIMEOUT_SECONDS = 90.0
VBCABLE_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024
# 装驱动是异步的：安装程序自己还会再起子进程，父进程立刻返回 33 之类的假成功。
# 所以不看它的返回值，直接盯设备列表。
SOUNDCARD_POLL_SECONDS = 2.0
SOUNDCARD_POLL_TIMEOUT_SECONDS = 120.0


def _vbcable_download_dir() -> str:
    """下载来的驱动包放哪：数据目录下的 vbcable/（跟着用户数据走，升级不丢）。"""
    root = os.environ.get("ANTEROS_DATA_DIR") or tempfile.gettempdir()
    return os.path.join(root, "vbcable")


def _vbcable_dirs() -> List[str]:
    """驱动包目录的候选清单（按优先级）。

    注意：`ANTEROS_VBCABLE_DIR` 一旦设了就**只认它**，不再往后落。否则调用方给的
    「空目录」会掉到仓库里的 release/vbcable 上，真的弹一次 UAC 去装驱动——
    在测试里这就是事故。
    """
    override = str(os.environ.get(VBCABLE_ENV_DIR) or "").strip()
    if override:
        return [os.path.abspath(override)]
    return [
        # 打包后：resources/integrations/vbcable（sidecar 在 resources/app/integrations/… 下）
        os.path.abspath(os.path.join(_SELF_DIR, "..", "..", "..", "resources", "integrations", "vbcable")),
        # 仓库里调试：<repo 根>/release/vbcable
        os.path.abspath(os.path.join(_SELF_DIR, "..", "..", "release", "vbcable")),
        # 之前点过「下载驱动」：<数据目录>/vbcable
        os.path.abspath(_vbcable_download_dir()),
    ]


def _find_setup_in(directory: str) -> Optional[str]:
    """在一个目录里找安装程序，优先 x64。驱动包解开后常还套一层（…/vbcable/pack/），
    所以顺带看一层子目录：只认「目录本身 + 它的直接子目录」，不递归全盘。
    """
    if not directory or not os.path.isdir(directory):
        return None
    roots: List[str] = [directory]
    try:
        roots += [os.path.join(directory, name) for name in sorted(os.listdir(directory))]
    except OSError:
        pass
    # 先在整个候选里找 x64，再退 32 位——不能因为先遍历到 pack 里的 32 位版就用了它。
    for name in VBCABLE_SETUP_NAMES:
        for root in roots:
            path = os.path.join(root, name)
            if os.path.isfile(path):
                return path
    return None


def _find_vbcable_setup() -> Optional[str]:
    for directory in _vbcable_dirs():
        found = _find_setup_in(directory)
        if found:
            return found
    # 只带了压缩包的（我们随包放的是官网原包，未解压、未改动）：解到数据目录再用。
    return _unpack_bundled_vbcable()


def _unpack_bundled_vbcable() -> Optional[str]:
    """候选目录里有 VBCABLE_*.zip 时，解开到数据目录并回包内安装程序路径。

    优先用随包的那个 zip：官网原包原样带着（不拆开、不改），解压一次就够，
    之后 `_find_setup_in(_vbcable_download_dir())` 就能找到。
    """
    import zipfile

    target = _vbcable_download_dir()
    for directory in _vbcable_dirs():
        if not os.path.isdir(directory):
            continue
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.lower().endswith(".zip") or "vb" not in name.lower():
                continue
            archive_path = os.path.join(directory, name)
            try:
                with zipfile.ZipFile(archive_path) as archive:
                    os.makedirs(target, exist_ok=True)
                    archive.extractall(target)
            except Exception:  # noqa: BLE001 - 包坏了就换下一个候选，不在这里抛
                continue
            found = _find_setup_in(target)
            if found:
                return found
    return None


def _download_vbcable() -> Dict[str, Any]:
    """从官网下一个驱动包，解开到数据目录，回包内安装程序的路径。

    只在「本机没带驱动包」时用（安装包被裁剪、或用户拿的是绿色版）。下载失败不抛：
    把每一处的失败原因按顺序攒起来回给界面——用户至少能分清是网络不通、还是地址变了。

    `ANTEROS_VBCABLE_DIR` 设了就不下载：那个变量是「只认这个目录」的语义（测试与绿色版），
    再往别处落文件既违背它，也会让测试偷偷连网。
    """
    if str(os.environ.get(VBCABLE_ENV_DIR) or "").strip():
        return {"ok": False, "message": "已指定驱动目录（%s），不从这里下载" % VBCABLE_ENV_DIR}
    target = _vbcable_download_dir()
    existing = _find_setup_in(target)
    if existing:
        return {"ok": True, "setup": existing, "downloaded": False, "message": "本地已经有下载好的驱动包"}

    import urllib.request
    import zipfile

    archive_path = os.path.join(tempfile.gettempdir(), "VBCABLE_Driver_Pack43.zip")
    errors: List[str] = []
    for url in VBCABLE_DOWNLOAD_URLS:
        host = url.split("//")[-1].split("/")[0]
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Anteros-Soundcard/1.0"})
            with urllib.request.urlopen(request, timeout=VBCABLE_DOWNLOAD_TIMEOUT_SECONDS) as response:
                payload = response.read(VBCABLE_DOWNLOAD_MAX_BYTES + 1)
            if len(payload) > VBCABLE_DOWNLOAD_MAX_BYTES:
                raise ValueError("下回来的文件超过预期大小，不像驱动包")
            if len(payload) < 100_000:
                raise ValueError("下回来的文件只有 %d 字节，多半是错误页而不是驱动包" % len(payload))
            os.makedirs(target, exist_ok=True)
            part_path = archive_path + ".part"
            with open(part_path, "wb") as handle:
                handle.write(payload)
            with zipfile.ZipFile(part_path) as archive:
                archive.extractall(target)
            os.replace(part_path, archive_path)
            setup = _find_setup_in(target)
            if not setup:
                raise ValueError("解开了但没有找到 VBCABLE_Setup_x64.exe")
            return {
                "ok": True,
                "setup": setup,
                "downloaded": True,
                "message": "驱动包已下载（%d KB）" % (len(payload) // 1024),
            }
        except Exception as error:  # noqa: BLE001 - 换下一个地址，最后把原因一起回给界面
            errors.append("%s → %s: %s" % (host, type(error).__name__, error))
    return {"ok": False, "message": "下载驱动包失败：" + "；".join(errors)}


def method_soundcard_download(params: Dict[str, Any]) -> Dict[str, Any]:
    """「下载驱动」按钮：只下载、不安装。装不装由用户随后自己决定。"""
    result = _download_vbcable()
    ok = bool(result.get("ok"))
    return {
        "ok": ok,
        "downloaded": bool(result.get("downloaded")),
        "bundled": _find_vbcable_setup() is not None,
        "message": str(result.get("message") or ("驱动包已就位" if ok else "下载失败")),
    }


def method_soundcard_status(params: Dict[str, Any]) -> Dict[str, Any]:
    """只读：本机虚拟声卡装成什么样，「声音」页的「重新检测」按它。"""
    state = dict(_audio_out().soundcard_state())
    # bundled 额外带上：界面靠它决定「一键安装」和「下载驱动」哪个是主按钮。
    state["bundled"] = _find_vbcable_setup() is not None
    return state


def method_install_soundcard(params: Dict[str, Any]) -> Dict[str, Any]:
    """一键装虚拟声卡：提权跑安装程序，然后盯设备列表直到出现两头。

    没有随包驱动时先下一份（用户点的是「一键安装」，不该再让他自己去官网翻）。
    全程只启动那一个 exe、参数固定 `-i -h`（静默安装），不拼任何 shell 命令——
    路径里可能有空格和中文，拼字符串迟早出事。
    """
    downloaded = False
    exe = _find_vbcable_setup()
    if not exe:
        fetched = _download_vbcable()
        if not fetched.get("ok"):
            return {
                "ok": False,
                "bundled": False,
                "message": "本地没有驱动包，也没下载成：%s" % str(fetched.get("message") or "原因不明"),
            }
        exe = str(fetched.get("setup") or "")
        downloaded = True

    audio = _audio_out()
    if audio.soundcard_state().get("installed"):
        return {"ok": True, "downloaded": downloaded, "message": "虚拟声卡已经装好了"}

    import ctypes

    workdir = os.path.dirname(exe)
    try:
        shell32 = ctypes.windll.shell32
        # 不设 restype 会被截成 32 位 int：x64 下拿到的数值可能是个负数，
        # 「>32 就算启动成功」的判据就失真了。
        shell32.ShellExecuteW.restype = ctypes.c_void_p
        raw = shell32.ShellExecuteW(None, "runas", exe, "-i -h", workdir, 1)
    except Exception as error:  # noqa: BLE001 - 起不来也要如实回一句，不能抛给界面
        return {"ok": False, "message": "起不来安装程序：%s: %s" % (type(error).__name__, error)}
    launched = int(raw or 0)
    if launched <= 32:
        # ShellExecute 约定：<=32 是失败码；用户点了「否」就是 ERROR_CANCELLED(5)。
        return {"ok": False, "needsAdmin": True, "message": "装驱动需要管理员权限，刚才的弹窗被拒绝了"}

    deadline = time.time() + SOUNDCARD_POLL_TIMEOUT_SECONDS
    while time.time() < deadline:
        time.sleep(SOUNDCARD_POLL_SECONDS)
        try:
            if audio.soundcard_state().get("installed"):
                return {
                    "ok": True,
                    "downloaded": downloaded,
                    "needsRestart": True,
                    "message": "虚拟声卡装好了，需要重启微信、再重启本应用才会认到设备",
                }
        except Exception:  # noqa: BLE001 - 设备列表偶发读不到，继续等下一轮
            pass
    return {
        "ok": False,
        "message": "安装程序已启动但两分钟内没看到设备，可能还在后台装；装完重启微信再点重新检测",
    }


def method_warmup(params: Dict[str, Any]) -> Dict[str, Any]:
    """预热：把目标会话先打开（同样丢子进程，卡住也不拖累主进程）。"""
    raw = str(params.get("chatUsername") or STATE.chat_username or CHAT_DEFAULT)
    with STATE.lock:
        username = normalize_username(raw)
    title = resolve_chat_title(username) or ""
    result = _run_isolated({"action": "warmup", "username": username, "title": title}, WARMUP_TIMEOUT_SECONDS)
    return {"ok": bool(result.get("ok")), "chatUsername": username, "chatTitle": title, "error": result.get("error")}

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
    "warmup": method_warmup,
    "doctor": method_doctor,
    "list-chats": method_list_chats,
    "inspect": method_inspect,
    "voice.send": method_voice_send,
    "voice.status": method_voice_status,
    "soundcard.status": method_soundcard_status,
    "soundcard.download": method_soundcard_download,
    "soundcard.install": method_install_soundcard,
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
    parser.add_argument(
        "--isolated",
        metavar="PAYLOAD",
        default=None,
        help="内部用：只做一次界面操作（send / warmup），做完打印一行 JSON 就退出",
    )
    parser.add_argument(
        "--isolated-file",
        metavar="PATH",
        default=None,
        help="同 --isolated，但载荷从文件读（命令行转义容易把引号吃掉）",
    )
    args = parser.parse_args()

    # 子进程模式：父进程把界面操作丢到这里，超时就直接被杀掉，主进程不受影响
    if args.isolated or args.isolated_file:
        try:
            try:
                sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            payload_text = args.isolated
            if args.isolated_file:
                # 注意：这里不能叫 handle —— main() 后面还要调 handle(line)，
                # 同名局部变量会把整个函数里的 handle 变成「未赋值的局部变量」。
                with open(args.isolated_file, "r", encoding="utf-8") as file_handle:
                    payload_text = file_handle.read()
            payload = json.loads(payload_text or "{}")
            action = str(payload.get("action") or "send")
            if action == "warmup":
                result = isolated_warmup(payload)
            elif action == "voice":
                result = isolated_voice(payload)
            else:
                result = isolated_send(payload)
            print(json.dumps(result, ensure_ascii=False))
        except BaseException as error:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, error)}, ensure_ascii=False))
        return

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