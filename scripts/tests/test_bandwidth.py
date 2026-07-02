"""Tests for mic bandwidth estimation (Bluetooth SCO codec detection)."""

import importlib.util
import math
import os
import sys

import pytest

# Add scripts directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    """Import whisper-server.py as a module."""
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def server():
    return _load_server_module()


SAMPLE_RATE = 16000


def make_tones(freqs_amps, duration_sec=2.0):
    """Synthesize a sum of sine tones as int16-range samples."""
    n = int(SAMPLE_RATE * duration_sec)
    return [
        int(sum(a * math.sin(2 * math.pi * f * i / SAMPLE_RATE) for f, a in freqs_amps))
        for i in range(n)
    ]


class TestFft:
    def test_pure_tone_peaks_at_expected_bin(self, server):
        n = 512
        # 1000 Hz at 16 kHz with a 512-point FFT -> bin 32 (31.25 Hz/bin)
        x = [complex(math.sin(2 * math.pi * 1000 * i / SAMPLE_RATE)) for i in range(n)]
        mags = [abs(v) for v in server._fft(x)[: n // 2 + 1]]
        assert mags.index(max(mags)) == 32


class TestEstimateBandwidth:
    def test_narrowband_speech_is_detected(self, server):
        # All energy below 4 kHz — what an upsampled 8 kHz CVSD link looks like
        samples = make_tones([(300, 4000), (1200, 2500), (3000, 1200)])
        result = server.estimate_bandwidth(samples)
        assert result["verdict"] == "narrowband"
        assert result["high_band_ratio"] < 0.015
        assert result["rolloff_hz"] < 4200

    def test_wideband_speech_is_detected(self, server):
        # Vowel-like lows plus fricative-like energy at 5-6.5 kHz
        samples = make_tones([(300, 4000), (1200, 2500), (5000, 1500), (6500, 1000)])
        result = server.estimate_bandwidth(samples)
        assert result["verdict"] == "wideband"
        assert result["high_band_ratio"] >= 0.015

    def test_sparse_fricatives_still_read_wideband(self, server):
        # Mostly vowels, one brief burst of high-frequency energy — the
        # per-frame peak ratio must catch it even when the aggregate is low.
        vowels = make_tones([(300, 5000), (1200, 3000)], duration_sec=2.0)
        burst = make_tones([(5500, 2500), (300, 500)], duration_sec=0.15)
        samples = vowels + burst
        result = server.estimate_bandwidth(samples)
        assert result["verdict"] == "wideband"
        assert result["peak_frame_high_ratio"] >= 0.08

    def test_silence_is_unknown(self, server):
        result = server.estimate_bandwidth([0] * SAMPLE_RATE)
        assert result["verdict"] == "unknown"
        assert result["reason"] == "not_enough_speech"

    def test_too_short_is_unknown(self, server):
        result = server.estimate_bandwidth([1000] * 100)
        assert result["verdict"] == "unknown"
        assert result["reason"] == "too_short"

    def test_quiet_noise_below_floor_is_unknown(self, server):
        # Amplitude well under the speech RMS floor
        samples = make_tones([(1000, 30)])
        result = server.estimate_bandwidth(samples)
        assert result["verdict"] == "unknown"

    def test_accepts_tuple_input(self, server):
        # /debug/test-pipeline passes struct.unpack output (a tuple)
        samples = tuple(make_tones([(500, 3000)], duration_sec=0.5))
        result = server.estimate_bandwidth(samples)
        assert result["verdict"] == "narrowband"
