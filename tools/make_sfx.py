"""会議探偵 効果音の合成 (numpy) -> mp3 (ffmpeg).

出力: public/assets/audio/sfx/<id>.mp3
  crack_1..2   ガラスにヒビ (0.3 秒)
  shatter_1..3 ガラスが割れて飛散 (1.2-1.6 秒)
  stamp        付箋に判子をポン (0.25 秒)
  thud         CASE CLOSED の判子をドン (0.6 秒)

合成は 44.1kHz、軽いリバーブ (wet 0.25)、ピーク -1dBFS に正規化。
実行: python tools/make_sfx.py  (numpy 1.26 + ffmpeg が必要)
"""

import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
PEAK = 10 ** (-1 / 20)  # -1 dBFS
WET = 0.25
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "audio", "sfx")


# ---- 基本部品 ----------------------------------------------------------------
def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def bandnoise(rng, dur, lo, hi):
    """帯域制限ホワイトノイズ (FFT マスク)。"""
    n = int(SR * dur)
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spec[(freqs < lo) | (freqs > hi)] = 0
    x = np.fft.irfft(spec, n)
    return x / (np.max(np.abs(x)) + 1e-12)


def tone(freq_start, freq_end, dur, tau, amp=1.0):
    """周波数スイープ付き減衰サイン波。"""
    t = t_axis(dur)
    freq = np.linspace(freq_start, freq_end, len(t))
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return amp * np.sin(phase) * np.exp(-t / tau)


def add_at(buf, sig, start_s):
    i = int(start_s * SR)
    end = min(len(buf), i + len(sig))
    buf[i:end] += sig[: end - i]


def reverb(x, rng, length=0.9, tau=0.12):
    """減衰ノイズのインパルス応答との畳み込み (FFT)。wet 0.25 でミックス。"""
    n_ir = int(SR * length)
    t = np.arange(n_ir) / SR
    ir = rng.standard_normal(n_ir) * np.exp(-t / tau)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-12
    n_fft = 1 << int(np.ceil(np.log2(len(x) + n_ir)))
    wet = np.fft.irfft(np.fft.rfft(x, n_fft) * np.fft.rfft(ir, n_fft), n_fft)[: len(x) + n_ir]
    wet = np.pad(wet, (0, max(0, len(x) - len(wet))))[: len(x) + n_ir]
    dry = np.pad(x, (0, n_ir))
    return (1 - WET) * dry + WET * wet


def fade_out(x, sec):
    n = int(SR * sec)
    x = x.copy()
    x[-n:] *= np.linspace(1, 0, n)
    return x


def normalize(x):
    peak = np.max(np.abs(x)) + 1e-12
    return x / peak * PEAK


def write_mp3(x, name):
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{name}.mp3")
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with tempfile.TemporaryDirectory() as d:
        wav_path = os.path.join(d, f"{name}.wav")
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav_path, "-ac", "1", "-ar", str(SR),
                        "-b:a", "128k", out], check=True)
    print(f"wrote {out}")


# ---- 効果音 -------------------------------------------------------------------
def crack(seed):
    rng = np.random.default_rng(seed)
    dur = 0.3
    buf = np.zeros(int(SR * dur))
    # 鋭いクリック (2ms 程度の白色ノイズ)
    click = rng.standard_normal(int(SR * 0.004)) * np.exp(-np.arange(int(SR * 0.004)) / (SR * 0.0008))
    add_at(buf, click * 1.0, 0.0)
    # 高域の短いノイズ (ピシッ)
    hi = bandnoise(rng, 0.06, 3000, 12000) * np.exp(-t_axis(0.06) / 0.018)
    add_at(buf, hi * 0.8, 0.002)
    # 細い軋み (下降スイープ)
    squeak = tone(3200 + rng.uniform(-200, 200), 1700, 0.16, 0.06, amp=0.12)
    squeak *= 1 + 0.3 * np.sin(2 * np.pi * 37 * t_axis(0.16))
    add_at(buf, squeak, 0.01)
    # 2 回目の小さなクリック (ひび割れの伸び)
    add_at(buf, bandnoise(rng, 0.02, 4000, 10000) * np.exp(-t_axis(0.02) / 0.005) * 0.4, 0.07 + rng.uniform(0, 0.03))
    return normalize(fade_out(reverb(buf, rng)[: int(SR * 0.3)], 0.03))


def shatter(seed):
    rng = np.random.default_rng(seed)
    dur = rng.uniform(1.2, 1.6)
    buf = np.zeros(int(SR * dur))

    # 1. 強いトランジェント (帯域ノイズ 2-9kHz、立ち上がり 10ms 以内)
    n_tr = int(SR * 0.08)
    tr = bandnoise(rng, 0.08, 2000, 9000)
    att = np.minimum(1.0, np.arange(n_tr) / (SR * 0.005))  # 5ms で立ち上がり
    tr = tr * att * np.exp(-np.arange(n_tr) / (SR * 0.025))
    add_at(buf, tr * 1.0, 0.0)

    # 2. 低めのドン (80-150Hz)
    thud = tone(150, 80, 0.35, 0.09, amp=0.75)
    add_at(buf, thud, 0.0)

    # 3. 破片の鈴のような音 25-45 個、0.05-0.9 秒、だんだん間隔を空ける
    n = int(rng.integers(25, 46))
    k = np.arange(n)
    times = 0.05 + 0.85 * ((k + rng.uniform(0, 0.5, n)) / n) ** 1.8
    for ti in times:
        f0 = rng.uniform(2000, 4000)
        ratios = [1.0, rng.uniform(1.31, 1.52), rng.uniform(1.7, 1.93)]
        amps = [1.0, rng.uniform(0.3, 0.6), rng.uniform(0.15, 0.3)]
        length = rng.uniform(0.02, 0.15)  # 20-150ms 減衰
        amp = rng.uniform(0.12, 0.3)
        partials = np.zeros(int(SR * length * 3))
        t = t_axis(length * 3)
        for r, a in zip(ratios[: int(rng.integers(2, 4))], amps):
            partials += a * np.sin(2 * np.pi * f0 * r * t)
        partials *= np.exp(-t / (length / 4)) * amp
        add_at(buf, partials, ti)

    return normalize(fade_out(reverb(buf, rng)[: int(SR * dur)], 0.04))


def stamp(seed=7):
    rng = np.random.default_rng(seed)
    dur = 0.25
    buf = np.zeros(int(SR * dur))
    # 判子の「ポン」 (低中域のスイープ)
    add_at(buf, tone(300, 180, 0.2, 0.04, amp=0.9), 0.0)
    # 押し付けのクリック
    add_at(buf, bandnoise(rng, 0.01, 1000, 4000) * np.exp(-t_axis(0.01) / 0.003) * 0.6, 0.0)
    # 紙の擦れ (ごく短い高域ノイズ)
    add_at(buf, bandnoise(rng, 0.05, 2500, 8000) * np.exp(-t_axis(0.05) / 0.015) * 0.2, 0.004)
    return normalize(reverb(buf, rng, length=0.4, tau=0.06)[: int(SR * dur)])


def thud(seed=11):
    rng = np.random.default_rng(seed)
    dur = 0.6
    buf = np.zeros(int(SR * dur))
    # 重いドン (45-110Hz)
    add_at(buf, tone(110, 45, 0.5, 0.15, amp=1.0), 0.0)
    # 木の打撃感 (400Hz 付近の短い成分)
    add_at(buf, tone(420, 380, 0.1, 0.02, amp=0.25), 0.0)
    # 初期の打撃ノイズ
    add_at(buf, bandnoise(rng, 0.04, 200, 800) * np.exp(-t_axis(0.04) / 0.01) * 0.7, 0.0)
    return normalize(reverb(buf, rng, length=0.6, tau=0.1)[: int(SR * dur)])


def main():
    for i in (1, 2):
        write_mp3(crack(100 + i), f"crack_{i}")
    for i in (1, 2, 3):
        write_mp3(shatter(200 + i * 17), f"shatter_{i}")
    write_mp3(stamp(), "stamp")
    write_mp3(thud(), "thud")


if __name__ == "__main__":
    main()
