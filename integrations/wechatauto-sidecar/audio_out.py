# -*- coding: utf-8 -*-
"""往指定输出设备播一段 WAV（只用 winmm，不引入第三方库）。

为什么要自己播：微信「按住说话」录的是**系统默认录音设备**。要让微信录到我们的
合成语音，就得把它播进虚拟声卡的播放端（CABLE Input），录音端（CABLE Output）
自然会收到。这里只负责「按名字找到那个设备并播完」，不关心微信。
"""

from __future__ import annotations

import ctypes
import os
import struct
import wave
from ctypes import wintypes

winmm = ctypes.WinDLL("winmm", use_last_error=True)

WAVE_FORMAT_PCM = 0x0001
WAVE_MAPPER = ctypes.c_uint(-1).value
WHDR_DONE = 0x00000001
WHDR_PREPARED = 0x00000002
WAVE_FORMAT_QUERY = 0x0001


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD),
        ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD),
        ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD),
        ("wBitsPerSample", wintypes.WORD),
        ("cbSize", wintypes.WORD),
    ]


class WAVEHDR(ctypes.Structure):
    _fields_ = [
        ("lpData", ctypes.c_void_p),
        ("dwBufferLength", wintypes.DWORD),
        ("dwBytesRecorded", wintypes.DWORD),
        ("dwUser", ctypes.c_size_t),
        ("dwFlags", wintypes.DWORD),
        ("dwLoops", wintypes.DWORD),
        ("lpNext", ctypes.c_void_p),
        ("reserved", ctypes.c_size_t),
    ]


class WAVEOUTCAPS(ctypes.Structure):
    _fields_ = [
        ("wMid", wintypes.WORD),
        ("wPid", wintypes.WORD),
        ("vDriverVersion", wintypes.UINT),
        ("szPname", wintypes.WCHAR * 32),
        ("dwFormats", wintypes.DWORD),
        ("wChannels", wintypes.WORD),
        ("wReserved1", wintypes.WORD),
        ("dwSupport", wintypes.DWORD),
    ]


class WAVEINCAPS(ctypes.Structure):
    _fields_ = [
        ("wMid", wintypes.WORD),
        ("wPid", wintypes.WORD),
        ("vDriverVersion", wintypes.UINT),
        ("szPname", wintypes.WCHAR * 32),
        ("dwFormats", wintypes.DWORD),
        ("wChannels", wintypes.WORD),
        ("wReserved1", wintypes.WORD),
    ]


def list_outputs() -> list[dict]:
    """所有播放设备（名字、索引、声道数）。"""
    out = []
    total = winmm.waveOutGetNumDevs()
    caps = WAVEOUTCAPS()
    for index in range(total):
        if winmm.waveOutGetDevCapsW(ctypes.c_uint(index), ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            out.append({"index": index, "name": caps.szPname, "channels": caps.wChannels})
    return out


def list_inputs() -> list[dict]:
    """所有录音设备（名字、索引、声道数）。"""
    out = []
    total = winmm.waveInGetNumDevs()
    caps = WAVEINCAPS()
    for index in range(total):
        if winmm.waveInGetDevCapsW(ctypes.c_uint(index), ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            out.append({"index": index, "name": caps.szPname, "channels": caps.wChannels})
    return out


def find_output(name_substring: str) -> int | None:
    """按名字片段找播放设备索引（大小写不敏感）。"""
    needle = (name_substring or "").lower()
    for item in list_outputs():
        if needle and needle in item["name"].lower():
            return item["index"]
    return None


def find_input(name_substring: str) -> int | None:
    needle = (name_substring or "").lower()
    for item in list_inputs():
        if needle and needle in item["name"].lower():
            return item["index"]
    return None


def read_wav(path: str) -> tuple[WAVEFORMATEX, bytes, float]:
    """读 wav，返回（格式、原始 PCM、时长秒）。只支持 16bit PCM —— TTS 输出就是它。"""
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.getnframes()
        data = handle.readframes(frames)
    if width != 2:
        raise ValueError(f"只支持 16bit PCM 的 wav，这条是 {width * 8}bit")
    fmt = WAVEFORMATEX()
    fmt.wFormatTag = WAVE_FORMAT_PCM
    fmt.nChannels = channels
    fmt.nSamplesPerSec = rate
    fmt.wBitsPerSample = 16
    fmt.nBlockAlign = channels * 2
    fmt.nAvgBytesPerSec = rate * fmt.nBlockAlign
    fmt.cbSize = 0
    duration = frames / float(rate) if rate else 0.0
    return fmt, data, duration


def play_wav(path: str, device_name_substring: str = "CABLE Input", timeout_seconds: float = 120.0) -> dict:
    """把 wav 播到指定设备，**播完才返回**（调用方要在这段时间里保持微信录音）。

    返回 {"ok": bool, "device": 设备名, "durationMs": 实际播放时长, "error": ...}
    """
    try:
        fmt, data, duration = read_wav(path)
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"读不了这条 wav：{error}"}

    index = find_output(device_name_substring)
    if index is None:
        names = ", ".join(f"#{i['index']} {i['name']}" for i in list_outputs()) or "（一台也没有）"
        return {"ok": False, "error": f"没找到播放设备「{device_name_substring}」，现有：{names}"}

    handle = wintypes.HANDLE()
    opened = winmm.waveOutOpen(ctypes.byref(handle), ctypes.c_uint(index), ctypes.byref(fmt), 0, 0, 0)
    if opened != 0:
        return {"ok": False, "error": f"waveOutOpen 失败：{opened}（设备可能被独占）"}

    buffer = ctypes.create_string_buffer(data, len(data))
    header = WAVEHDR()
    header.lpData = ctypes.cast(buffer, ctypes.c_void_p)
    header.dwBufferLength = len(data)
    header.dwFlags = 0
    try:
        if winmm.waveOutPrepareHeader(handle, ctypes.byref(header), ctypes.sizeof(header)) != 0:
            return {"ok": False, "error": "waveOutPrepareHeader 失败"}
        if winmm.waveOutWrite(handle, ctypes.byref(header), ctypes.sizeof(header)) != 0:
            return {"ok": False, "error": "waveOutWrite 失败"}

        import time

        started = time.time()
        while not (header.dwFlags & WHDR_DONE):
            if time.time() - started > timeout_seconds:
                winmm.waveOutReset(handle)
                return {"ok": False, "error": f"播放超过 {timeout_seconds:.0f} 秒还没结束"}
            time.sleep(0.02)
        elapsed = time.time() - started
        winmm.waveOutUnprepareHeader(handle, ctypes.byref(header), ctypes.sizeof(header))
        return {
            "ok": True,
            "device": list_outputs()[index]["name"] if index < len(list_outputs()) else device_name_substring,
            "durationMs": int(round(duration * 1000)),
            "wallMs": int(round(elapsed * 1000)),
        }
    finally:
        winmm.waveOutClose(handle)


def _pcm_format(rate: int, channels: int = 1) -> WAVEFORMATEX:
    fmt = WAVEFORMATEX()
    fmt.wFormatTag = WAVE_FORMAT_PCM
    fmt.nChannels = channels
    fmt.nSamplesPerSec = rate
    fmt.wBitsPerSample = 16
    fmt.nBlockAlign = channels * 2
    fmt.nAvgBytesPerSec = rate * fmt.nBlockAlign
    fmt.cbSize = 0
    return fmt


def write_tone(path: str, seconds: float = 0.8, rate: int = 16000, freq: float = 440.0, amplitude: float = 0.35) -> str:
    """写一段正弦测试音（16bit 单声道 wav），给「桥接自检」用。"""
    import math

    frames = int(rate * max(0.1, seconds))
    samples = bytearray()
    for index in range(frames):
        value = int(32767 * amplitude * math.sin(2 * math.pi * freq * index / rate))
        samples += struct.pack("<h", value)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(samples))
    return path


def record_bytes(seconds: float = 1.0, rate: int = 16000, channels: int = 1) -> dict:
    """从**系统默认录音设备**（WAVE_MAPPER）录一小段，返回 PCM 与统计。

    用轮询而不是回调：回调要跑消息泵，子进程里没有窗口循环，很容易永远等不到。
    """
    import time

    target_seconds = max(0.2, min(5.0, float(seconds)))
    fmt = _pcm_format(rate, channels)
    handle = wintypes.HANDLE()
    rc = winmm.waveInOpen(ctypes.byref(handle), ctypes.c_uint(WAVE_MAPPER), ctypes.byref(fmt), 0, 0, 0)
    if rc != 0:
        return {"ok": False, "error": f"打不开默认录音设备（waveInOpen={rc}）"}
    block = int(rate * channels * 2 * 0.1) or 3200
    buffers = []
    headers = []
    collected = bytearray()
    wanted = int(rate * channels * 2 * target_seconds)
    try:
        for _ in range(4):
            buffer = ctypes.create_string_buffer(block)
            header = WAVEHDR()
            header.lpData = ctypes.cast(buffer, ctypes.c_void_p)
            header.dwBufferLength = block
            header.dwFlags = 0
            if winmm.waveInPrepareHeader(handle, ctypes.byref(header), ctypes.sizeof(header)) != 0:
                return {"ok": False, "error": "waveInPrepareHeader 失败"}
            if winmm.waveInAddBuffer(handle, ctypes.byref(header), ctypes.sizeof(header)) != 0:
                return {"ok": False, "error": "waveInAddBuffer 失败"}
            buffers.append(buffer)
            headers.append(header)
        if winmm.waveInStart(handle) != 0:
            return {"ok": False, "error": "waveInStart 失败"}
        deadline = time.time() + target_seconds + 2.0
        while len(collected) < wanted and time.time() < deadline:
            for index, header in enumerate(headers):
                if header.dwFlags & WHDR_DONE:
                    got = int(header.dwBytesRecorded or 0)
                    if got > 0:
                        collected += buffers[index].raw[:got]
                    winmm.waveInUnprepareHeader(handle, ctypes.byref(header), ctypes.sizeof(header))
                    header.dwFlags = 0
                    header.dwBytesRecorded = 0
                    if winmm.waveInPrepareHeader(handle, ctypes.byref(header), ctypes.sizeof(header)) == 0:
                        winmm.waveInAddBuffer(handle, ctypes.byref(header), ctypes.sizeof(header))
            time.sleep(0.02)
    finally:
        try:
            winmm.waveInStop(handle)
            winmm.waveInReset(handle)
        except Exception:  # noqa: BLE001
            pass
        winmm.waveInClose(handle)

    pcm = bytes(collected[:wanted])
    count = len(pcm) // 2
    if count <= 0:
        return {"ok": False, "error": "一帧都没录到（设备被独占，或者系统不让这个进程录音）", "bytes": 0}
    samples = struct.unpack("<%dh" % count, pcm[: count * 2])
    peak = max(abs(value) for value in samples)
    energy = sum(value * value for value in samples) / float(count)
    return {
        "ok": True,
        "bytes": len(pcm),
        "seconds": round(count / float(rate), 2),
        "rms": round(energy ** 0.5, 1),
        "peak": peak,
        "pcm": pcm,
    }


def bridge_probe(tone_seconds: float = 0.8) -> dict:
    """自检：一边往 CABLE Input 播音，一边从默认录音设备录回来，看能不能听到自己。

    这是"微信会录到我们的声音"的直接证据。听不到就说明默认录音设备不是
    CABLE Output（那微信会录到房间里的真实声音，绝不能发）。
    """
    import tempfile
    import threading
    import time

    index = find_output("CABLE Input")
    if index is None:
        names = ", ".join(f"#{item['index']} {item['name']}" for item in list_outputs()) or "（一台也没有）"
        return {
            "ok": False,
            "error": "没装虚拟声卡：找不到播放设备「CABLE Input」",
            "playbackDevice": None,
            "outputs": names,
        }

    tone_path = os.path.join(tempfile.gettempdir(), "anteros-bridge-tone.wav")
    write_tone(tone_path, tone_seconds)
    captured: dict = {}

    def _record() -> None:
        captured.update(record_bytes(tone_seconds + 0.4))

    worker = threading.Thread(target=_record, daemon=True)
    worker.start()
    time.sleep(0.15)
    played = play_wav(tone_path, "CABLE Input", timeout_seconds=30.0)
    worker.join(timeout=tone_seconds + 5.0)

    if not captured.get("ok"):
        return {
            "ok": False,
            "error": captured.get("error") or "录音失败",
            "playbackDevice": played.get("device"),
        }
    rms = float(captured.get("rms") or 0.0)
    peak = int(captured.get("peak") or 0)
    heard = rms >= 300.0
    return {
        "ok": heard,
        "playbackDevice": played.get("device"),
        "playbackOk": bool(played.get("ok")),
        "rms": rms,
        "peak": peak,
        "bytes": captured.get("bytes"),
        "message": (
            f"桥接通了（回录 RMS={rms:.0f}）：微信会录到我们合成的声音"
            if heard
            else f"回录几乎是静音（RMS={rms:.0f}）：默认录音设备不是 CABLE Output，"
            "这时候发出去只会录到房间里的真实声音，已阻止"
        ),
    }


def default_input_name() -> str | None:
    """WAVE_MAPPER（设备 -1）实际打开的是哪一路，用来确认微信到底会录到谁。"""
    fmt = WAVEFORMATEX()
    fmt.wFormatTag = WAVE_FORMAT_PCM
    fmt.nChannels = 1
    fmt.nSamplesPerSec = 16000
    fmt.wBitsPerSample = 16
    fmt.nBlockAlign = 2
    fmt.nAvgBytesPerSec = 32000
    handle = wintypes.HANDLE()
    rc = winmm.waveInOpen(ctypes.byref(handle), ctypes.c_uint(WAVE_MAPPER), ctypes.byref(fmt), 0, 0, 0)
    if rc != 0:
        return None
    winmm.waveInClose(handle)
    # winmm 不告诉我们 mapper 展开成了哪一台；这里退化成「第一台名字里带 CABLE 的」不可靠，
    # 所以只用来判断「默认设备能不能打开」。
    return "ok"


def probe() -> dict:
    """完整体检：有没有虚拟声卡、播放/录音两头能不能打开。"""
    outputs = list_outputs()
    inputs = list_inputs()
    cable_out = next((i for i in outputs if "cable input" in i["name"].lower()), None)
    cable_in = next((i for i in inputs if "cable output" in i["name"].lower()), None)
    return {
        "outputs": outputs,
        "inputs": inputs,
        "playbackDevice": cable_out,
        "captureDevice": cable_in,
        "ready": bool(cable_out and cable_in),
        "defaultInputOpens": default_input_name() is not None,
    }


SOUNDCARD_PLAYBACK_NAME = "CABLE Input"
SOUNDCARD_CAPTURE_NAME = "CABLE Output"


def _first_device_name(devices: list[dict], needle: str) -> str | None:
    """按名字片段挑第一台设备（大小写不敏感），返回它的完整名字。"""
    lowered = (needle or "").lower()
    for device in devices or []:
        name = str(device.get("name") or "")
        if lowered and lowered in name.lower():
            return name
    return None


def soundcard_state() -> dict:
    """虚拟声卡（VB-CABLE）装到哪一步了：回放端和录音端都在才算装好。

    只查名字、**不打开设备**：「声音」页会反复点「重新检测」，这个函数不能有副作用。
    设备名常被驱动截断成 "CABLE Input (VB-Audio Virtual C"，所以用 `in` 判断，
    不能拿全名做等值比较。
    """
    try:
        playback = _first_device_name(list_outputs(), SOUNDCARD_PLAYBACK_NAME)
    except Exception:  # noqa: BLE001 - 取不到设备列表就按「没装」报，别让界面崩
        playback = None
    try:
        capture = _first_device_name(list_inputs(), SOUNDCARD_CAPTURE_NAME)
    except Exception:  # noqa: BLE001
        capture = None
    installed = bool(playback and capture)
    if installed:
        message = f"虚拟声卡已就绪：{playback} → {capture}"
    elif playback:
        message = (
            f"虚拟声卡只装了一半：有回放端「{playback}」，缺录音端（{SOUNDCARD_CAPTURE_NAME}）；"
            "重装一次 VB-CABLE 补齐，装完重启微信"
        )
    elif capture:
        message = (
            f"虚拟声卡只装了一半：有录音端「{capture}」，缺回放端（{SOUNDCARD_PLAYBACK_NAME}）；"
            "重装一次 VB-CABLE 补齐，装完重启微信"
        )
    else:
        message = "这台机器上还没装虚拟声卡（VB-CABLE）"
    return {
        "installed": installed,
        "playbackDevice": playback,
        "captureDevice": capture,
        "message": message,
    }


if __name__ == "__main__":
    import json
    import sys

    command = sys.argv[1] if len(sys.argv) >= 2 else "probe"
    if command == "play" and len(sys.argv) >= 3:
        print(json.dumps(play_wav(sys.argv[2]), ensure_ascii=False, indent=2))
    elif command == "bridge":
        print(json.dumps(bridge_probe(), ensure_ascii=False, indent=2))
    elif command == "selftest":
        report = {
            "devices": {
                "outputs": list_outputs(),
                "inputs": list_inputs(),
            },
            "bridge": bridge_probe(),
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(probe(), ensure_ascii=False, indent=2))