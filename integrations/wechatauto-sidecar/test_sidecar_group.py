"""群聊解析的单元测试：不碰微信、不碰数据库，只验证 sidecar 自己那层解析。

跑法（用应用下载的那份便携 Python）：
  <runtime>\python.exe integrations\wechatauto-sidecar\test_sidecar_group.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sidecar  # noqa: E402

FAILED = []


def check(name, actual, expected):
    if actual != expected:
        FAILED.append(f"{name}: 期望 {expected!r}，实际 {actual!r}")


# 1) 中文类型归一
check("文本", sidecar.normalize_kind("文本"), "text")
check("图片", sidecar.normalize_kind("图片"), "image")
check("系统消息", sidecar.normalize_kind("系统消息"), "system")
check("未知类型不炸", sidecar.normalize_kind("某个新类型"), "other")

# 2) 群消息去掉「昵称:」前缀和换行
check("去昵称前缀", sidecar.clean_group_text("大肥鱼:\n来打原神", "大肥鱼"), "来打原神")
check("多行保留", sidecar.clean_group_text("Rifei：\n第一行\n第二行", "Rifei"), "第一行\n第二行")

# 3) @ 判定：认 @昵称、@微信号、全角＠
names = ["小满", "rifei111"]
check("普通@", sidecar.mentioned_me("@小满 你在吗", names), True)
check("全角＠", sidecar.mentioned_me("＠小满 在吗", names), True)
check("@微信号", sidecar.mentioned_me("@rifei111 你好", names), True)
check("没@", sidecar.mentioned_me("今天天气不错", names), False)
check("名字里带@也不算", sidecar.mentioned_me("邮箱 a@b.com", names), False)

# 4) 群会话判定：@chatroom 结尾即群
check("群 username", sidecar.is_group_chat("45226657898@chatroom"), True)
check("私聊 username", sidecar.is_group_chat("wxid_azqocbj6ktli12"), False)

if FAILED:
    print("失败：")
    for item in FAILED:
        print("  - " + item)
    sys.exit(1)
print("群聊解析测试全部通过")