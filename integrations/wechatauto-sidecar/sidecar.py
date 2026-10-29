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
import re
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
        self.gui: Any = None
        self.gui_error: Optional[str] = None
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

    for target in targets:
        username = target["username"]
        chat_since = max(int(target.get("sinceSeq") or 0), 0)
        next_seqs[username] = chat_since
        is_group = target["kind"] == "group" or is_group_chat(username)
        try:
            rows = db.get_new_messages(username, since_seq=chat_since, limit=limit) or []
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            continue
        for row in rows:
            seq = int(row.get("sort_seq") or row.get("seq") or 0)
            next_seqs[username] = max(next_seqs[username], seq)
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

def method_send(params: Dict[str, Any]) -> Dict[str, Any]:
    text = str(params.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "不发送空文本"}
    raw = str(params.get("chatUsername") or STATE.chat_username or CHAT_DEFAULT)
    requested_title = str(params.get("chatTitle") or "").strip()
    gui = get_gui()
    if gui is None:
        return {"ok": False, "error": f"发消息模块不可用：{STATE.gui_error or '界面驱动未就绪'}"}

    with STATE.lock:
        username = normalize_username(raw)
        configured = normalize_username(str(STATE.chat_username or ""))
    # 界面里认的是**会话显示名**（备注/昵称），不是 wxid。传显示名才能命中上游
    # 的「当前会话就是目标」快路径；传 wxid 每发一条都要重新搜索会话。
    #
    # 注意：这里绝对不能用 STATE.chat_title 兜底。那是「白名单会话」的标题，
    # 当回复目标是别的会话（比如某个群）时，用它会把消息发到白名单那一边去。
    title = requested_title or resolve_chat_title(username) or ""
    if username and configured and username == configured and not title:
        title = STATE.chat_title or ""
    targets = [value for value in [title, username] if value] if title else [username]

    # 群聊一律回读确认：群名是拼出来的，搜错会话的话水印回读能立刻发现，
    # 宁可报「没发出去」也不能把话发到另一个会话里。
    verify = bool(params.get("verify")) or username.endswith("@chatroom")

    def attempt(target: Optional[str]) -> Any:
        if target:
            return gui.send_msg(text, who=target, verify=verify)
        return gui.send_msg(text, verify=verify)

    last_error = None
    for target in targets or [None]:
        try:
            response = attempt(target)
        except Exception as error:  # noqa: BLE001
            last_error = f"{type(error).__name__}: {error}"
            continue
        ok = True
        for attribute in ("success", "ok", "sent"):
            value = getattr(response, attribute, None)
            if isinstance(value, bool):
                ok = value
                break
        detail = str(response)[:500]
        if ok:
            return {
                "ok": True,
                "chatUsername": username,
                "chatTitle": title,
                "detail": detail,
            }
        last_error = detail
        # 没发成功就换下一个目标写法再试一次（显示名加载失败时会退到 wxid）
    return {"ok": False, "chatUsername": username, "chatTitle": title, "error": last_error or "发送失败"}


def method_warmup(params: Dict[str, Any]) -> Dict[str, Any]:
    """预热：把目标会话先打开。

    不预热的话，用户发第一条消息后要等界面驱动找窗口 + 搜会话，十几秒才回；
    提前打开一次，后面只是粘贴 + 回车。
    """
    gui = get_gui()
    if gui is None:
        return {"ok": False, "error": STATE.gui_error or "界面驱动未就绪"}
    with STATE.lock:
        target = STATE.chat_title or STATE.chat_username
    if not target:
        return {"ok": False, "error": "还没有设置会话"}
    try:
        opened = bool(gui.open_chat(target))
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "target": target, "error": f"{type(error).__name__}: {error}"}
    log(f"会话预热：{target} → {'已打开' if opened else '没打开'}")
    return {"ok": opened, "target": target}


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