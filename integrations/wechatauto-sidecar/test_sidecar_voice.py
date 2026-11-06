# -*- coding: utf-8 -*-
"""语音条旁路接口的单元测试（不碰微信、不需要客户在跑）。

只测这几件不怕环境的事：
  1) audio_out 能写/读 wav，时长算得对（微信按按住时长记语音条长度，这个数错了会截断）；
  2) voice.send 的入参守卫：相对路径、文件不存在、时长缺失、声卡自检没过，都必须拒绝；
  3) 虚拟声卡（VB-CABLE）的检测与「没有驱动包就别装作能装」。

跑法：python integrations/wechatauto-sidecar/test_sidecar_voice.py
"""

from __future__ import annotations

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import audio_out  # noqa: E402
import sidecar  # noqa: E402


failures = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        failures.append(name)


def main() -> int:
    print("[voice] audio_out: 写一段 0.8 秒的测试音再读回来")
    work = tempfile.mkdtemp(prefix="anteros-voice-test-")
    wav = os.path.join(work, "tone.wav")
    audio_out.write_tone(wav, seconds=0.8, rate=16000, freq=440.0)
    check("wav 文件写出来了", os.path.isfile(wav) and os.path.getsize(wav) > 44, wav)
    _fmt, pcm, duration = audio_out.read_wav(wav)
    check("16bit 单声道能被解析", len(pcm) > 0)
    check("时长约 0.8 秒（±0.05）", abs(duration - 0.8) <= 0.05, "got %.3f" % duration)
    check("采样率 16000", int(_fmt.nSamplesPerSec) == 16000, "got %s" % _fmt.nSamplesPerSec)

    print("[voice] voice.send 入参守卫")
    result = sidecar.method_voice_send({"wav": "tone.wav", "durationMs": 1000})
    check("相对路径被拒", result.get("ok") is False and "绝对路径" in str(result.get("error")), result)

    result = sidecar.method_voice_send({"wav": os.path.join(work, "nope.wav"), "durationMs": 1000})
    check("文件不存在被拒", result.get("ok") is False and "不存在" in str(result.get("error")), result)

    result = sidecar.method_voice_send({"wav": wav})
    check("没给时长被拒", result.get("ok") is False and "时长" in str(result.get("error")), result)

    empty = os.path.join(work, "empty.wav")
    open(empty, "wb").close()
    result = sidecar.method_voice_send({"wav": empty, "durationMs": 1000})
    check("空文件被拒", result.get("ok") is False and "空文件" in str(result.get("error")), result)

    print("[voice] 声卡自检没过时必须拒绝发送（否则会录到房间里的声音）")
    original = sidecar._voice_probe
    sidecar._voice_probe = lambda force=False: {"ok": False, "message": "probe-fail"}  # type: ignore[assignment]
    try:
        result = sidecar.method_voice_send({"wav": wav, "durationMs": 800})
        check("自检失败被拒", result.get("ok") is False and "虚拟声卡" in str(result.get("error")), result)
    finally:
        sidecar._voice_probe = original  # type: ignore[assignment]

    print("[voice] 时长钳位：小于 300ms 抬到 300ms，超过 60 秒压到 60 秒")
    sidecar._voice_probe = lambda force=False: {"ok": False, "message": "probe-fail"}  # type: ignore[assignment]
    try:
        # 自检失败会先返回，钳位发生在它之前——这里只看返回里没有崩
        result = sidecar.method_voice_send({"wav": wav, "durationMs": 1})
        check("极短时长不崩", result.get("ok") is False, result)
    finally:
        sidecar._voice_probe = original  # type: ignore[assignment]

    print("[soundcard] 都没有 → installed 为 False，提示里点出 VB-CABLE")
    # 设备查询是 winmm 的真调用，这里换成假的：测试不能依赖客户机器上装过什么。
    original_outputs = audio_out.list_outputs
    original_inputs = audio_out.list_inputs
    audio_out.list_outputs = lambda: []  # type: ignore[assignment]
    audio_out.list_inputs = lambda: []  # type: ignore[assignment]
    try:
        state = audio_out.soundcard_state()
        check("两头都没有时 installed 为 False", state.get("installed") is False, state)
        check("两头都没有时 message 提到 VB-CABLE", "VB-CABLE" in str(state.get("message")), state.get("message"))
        check("两头都没有时不回填设备名", state.get("playbackDevice") is None and state.get("captureDevice") is None, state)

        print("[soundcard] 被截断的设备名也要认出来（CABLE Input (VB-Audio Virtual C…）")
        audio_out.list_outputs = lambda: [  # type: ignore[assignment]
            {"index": 0, "name": "扬声器 (Realtek(R) Audio)", "channels": 2},
            {"index": 1, "name": "CABLE Input (VB-Audio Virtual C", "channels": 2},
        ]
        audio_out.list_inputs = lambda: [  # type: ignore[assignment]
            {"index": 0, "name": "麦克风 (Realtek(R) Audio)", "channels": 1},
            {"index": 1, "name": "CABLE Output (VB-Audio Virtual C", "channels": 2},
        ]
        state = audio_out.soundcard_state()
        check("两头都在时 installed 为 True", state.get("installed") is True, state)
        check(
            "回放端名字回填的是那台 CABLE Input",
            "CABLE Input" in str(state.get("playbackDevice")),
            state.get("playbackDevice"),
        )
        check(
            "录音端名字回填的是那台 CABLE Output",
            "CABLE Output" in str(state.get("captureDevice")),
            state.get("captureDevice"),
        )
        check("装好时 message 说的是已就绪", "已就绪" in str(state.get("message")), state.get("message"))
    finally:
        audio_out.list_outputs = original_outputs  # type: ignore[assignment]
        audio_out.list_inputs = original_inputs  # type: ignore[assignment]

    print("[soundcard] 驱动包目录是空的 → 不能假装能一键装")
    # 这一条要在没有真安装程序的地方跑：ANTEROS_VBCABLE_DIR 一旦设了，旁路就只认它，
    # 不会落到仓库里的 release/vbcable 上真的弹一次 UAC（那是事故，不是测试）。
    empty_dir = tempfile.mkdtemp(prefix="anteros-vbcable-empty-")
    saved_env = os.environ.get("ANTEROS_VBCABLE_DIR")
    os.environ["ANTEROS_VBCABLE_DIR"] = empty_dir
    try:
        result = sidecar.method_install_soundcard({})
        check("没有驱动包时 ok 为 False", result.get("ok") is False, result)
        check("没有驱动包时 message 提到「驱动包」", "驱动包" in str(result.get("message")), result.get("message"))
        check("没有驱动包时不谎报可以装", result.get("bundled") is False, result)
        check("没有驱动包时不该弹权限", result.get("needsAdmin") is not True, result)
        status = sidecar.method_soundcard_status({})
        check("状态里 bundled 跟着驱动包走", status.get("bundled") is False, status)
        check("状态里必须有 installed / message", "installed" in status and "message" in status, status)
    finally:
        if saved_env is None:
            os.environ.pop("ANTEROS_VBCABLE_DIR", None)
        else:
            os.environ["ANTEROS_VBCABLE_DIR"] = saved_env

    print("[voice] 便携版 Python 的 sys.path 不可靠，audio_out 得能靠文件路径加载")
    # 现象（v1.0.26 用户报障）：应用里跑 `import audio_out` 报 ModuleNotFoundError。
    # 原因是 embeddable python 带 python311._pth，脚本目录不再进 sys.path（`.` 是相对 _pth 自身解析的）。
    # 这里模拟那种环境：把 sidecar/audio_out 所在目录从 sys.path 里摘掉，确认兜底加载仍然可用。
    saved_path = list(sys.path)
    saved_module = sidecar._AUDIO_OUT
    try:
        sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != HERE]
        sys.modules.pop("audio_out", None)
        sidecar._AUDIO_OUT = None
        loaded = sidecar._audio_out()
        check("摘掉 sys.path 后仍能加载 audio_out", hasattr(loaded, "play_wav"), type(loaded))
        check("兜底加载带出了设备查询", hasattr(loaded, "list_inputs"))
    finally:
        sys.path[:] = saved_path
        sidecar._AUDIO_OUT = saved_module
        sys.modules.pop("audio_out", None)

    if failures:
        print("\n[voice] %d 项失败：%s" % (len(failures), ", ".join(failures)))
        return 1
    print("\n[voice] 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())