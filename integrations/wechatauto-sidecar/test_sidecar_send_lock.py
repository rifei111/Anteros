"""发送串行锁与「切会话确认」的回归测试（不需要微信、不需要 wechatauto）。

跑法（仓库根目录）：
    python integrations/wechatauto-sidecar/test_sidecar_send_lock.py
或：
    npm run test:sidecar
"""

import importlib.util
import logging
import os
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# 「刚发过哪个会话」记在数据目录里的状态文件；测试时必须指到临时目录，
# 否则会读到这台机器上真实发过的会话，把用例搅成随机的。
os.environ["ANTEROS_DATA_DIR"] = tempfile.mkdtemp(prefix="anteros-sidecar-test-")

logging.disable(logging.CRITICAL)

spec = importlib.util.spec_from_file_location("anteros_sidecar", os.path.join(HERE, "sidecar.py"))
sidecar = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["anteros_sidecar"] = sidecar
spec.loader.exec_module(sidecar)


class FakeGUI:
    """模拟上游 WeChatGUI：open_chat 只认已知会话，_current_chat 记录当前停在哪儿。"""

    def __init__(self, chats=None, switchable=True):
        self.chats = list(chats or ["沈知蓝", "大肥鱼群"])
        self.switchable = switchable
        self._current_chat = "别的会话"
        self.sent = []
        self.opened: list = []

    def open_chat(self, target):
        self.opened.append(target)
        if self.switchable and target in self.chats:
            self._current_chat = target
            return True
        return False

    def send_msg(self, text, who=None, verify=False):
        self.sent.append(text)
        return type("Resp", (), {"success": True})()


def _reset_chat_state():
    sidecar._clear_chat_state()
    sidecar._ENSURE_VIA_CACHE = False


def test_ensure_chat_ok():
    _reset_chat_state()
    gui = FakeGUI()
    assert sidecar._ensure_chat(gui, "沈知蓝") is True
    assert gui._current_chat == "沈知蓝"


def test_ensure_chat_gives_up_when_it_cannot_switch():
    _reset_chat_state()
    gui = FakeGUI(switchable=False)
    started = time.time()
    assert sidecar._ensure_chat(gui, "沈知蓝") is False
    # 两次尝试之后就该放弃，不能无限等
    assert time.time() - started < 5.0


def test_ensure_chat_skips_search_when_recently_sent():
    """刚往这个会话发过话，界面肯定还开着它：别再点开搜索框搜一次（用户在意的就是这个）。"""
    _reset_chat_state()
    sidecar._write_chat_state("wxid_shen", "沈知蓝")
    gui = FakeGUI()
    assert sidecar._ensure_chat(gui, "沈知蓝", "wxid_shen") is True
    assert gui.opened == [], gui.opened  # 一次 open_chat 都没调


def test_ensure_chat_searches_again_when_state_is_stale():
    _reset_chat_state()
    sidecar._write_chat_state("wxid_shen", "沈知蓝")
    state = sidecar._read_chat_state()
    state["ts"] = time.time() - sidecar._CHAT_STATE_TTL_SECONDS - 5
    with open(sidecar._chat_state_path(), "w", encoding="utf-8") as handle:
        import json

        json.dump(state, handle)
    gui = FakeGUI()
    assert sidecar._ensure_chat(gui, "沈知蓝", "wxid_shen") is True
    assert gui.opened == ["沈知蓝"], gui.opened


def test_ensure_chat_empty_target_is_noop():
    gui = FakeGUI()
    assert sidecar._ensure_chat(gui, "") is True
    assert gui._current_chat == "别的会话"


def test_send_lock_is_exclusive():
    order = []
    inside = threading.Event()

    def first():
        with sidecar.send_lock(timeout=5):
            order.append("first-in")
            inside.set()
            time.sleep(0.4)
            order.append("first-out")

    def second():
        inside.wait(1.0)
        with sidecar.send_lock(timeout=5):
            order.append("second-in")

    a = threading.Thread(target=first)
    b = threading.Thread(target=second)
    a.start()
    b.start()
    a.join()
    b.join()
    assert order == ["first-in", "first-out", "second-in"], order


def test_send_lock_times_out_instead_of_hanging_forever():
    hold = threading.Event()
    release = threading.Event()

    def holder():
        with sidecar.send_lock(timeout=5):
            hold.set()
            release.wait(3.0)

    worker = threading.Thread(target=holder)
    worker.start()
    hold.wait(2.0)
    started = time.time()
    failed = False
    try:
        with sidecar.send_lock(timeout=0.6):
            pass
    except RuntimeError:
        failed = True
    elapsed = time.time() - started
    release.set()
    worker.join()
    assert failed is True
    assert elapsed < 3.0, elapsed


def test_isolated_send_refuses_when_chat_cannot_be_opened(monkeypatch_module=None):
    """切不过去时必须返回失败，而不是把消息粘到上一个聊天窗口里。"""
    _reset_chat_state()
    gui = FakeGUI(switchable=False)
    module = type("GuiModule", (), {"WeChatGUI": staticmethod(lambda: gui)})
    result = sidecar._send_locked("测试一句", "沈知蓝", module)
    assert result["ok"] is False
    assert "没能切到会话" in (result["error"] or "")
    assert gui.sent == []


def test_isolated_send_sends_after_switch():
    _reset_chat_state()
    gui = FakeGUI()
    module = type("GuiModule", (), {"WeChatGUI": staticmethod(lambda: gui)})
    result = sidecar._send_locked("测试一句", "沈知蓝", module)
    assert result["ok"] is True
    assert gui.sent == ["测试一句"]
    assert gui._current_chat == "沈知蓝"
    # 发完要把「刚发到哪儿」记下来，下一条才不用再搜
    assert sidecar._read_chat_state().get("title") == "沈知蓝"


def main():
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print("ok   %s" % test.__name__)
        except AssertionError as error:
            failed += 1
            print("FAIL %s: %s" % (test.__name__, error))
    total = len(tests)
    print("共 %d 项，通过 %d 项，失败 %d 项。" % (total, total - failed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())