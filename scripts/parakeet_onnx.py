"""Self-contained Parakeet TDT inference on onnxruntime + numpy.

Backend for platforms where the sherpa-onnx Python package cannot be
pip-installed (notably Termux, where pip builds fail against Android's
libc but `pkg install python-onnxruntime python-numpy` provides prebuilt
binaries). Mirrors the reference implementation in sherpa-onnx
scripts/nemo/parakeet-tdt-0.6b-v2/test_onnx.py.

Exposes the same duck-typed API surface as sherpa_onnx.OfflineRecognizer
(create_stream / accept_waveform / decode_stream / stream.result.text) so
the server code is backend-agnostic.
"""

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 16000

# Fbank parameters — must match the kaldi-native-fbank config used when the
# model was exported (25ms/10ms frames, 128 librosa-style mel bins, hann
# window, preemphasis 0.97, no dither, no DC removal).
FRAME_LENGTH = 400  # 25ms @ 16kHz
FRAME_SHIFT = 160   # 10ms @ 16kHz
N_FFT = 512         # frame length rounded up to a power of two
N_MELS = 128
PREEMPH = 0.97
TAIL_PADDING_SECONDS = 2.0


def _hz_to_mel(freq):
    """librosa/Slaney mel scale (htk=False)."""
    freq = np.asarray(freq, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = freq / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    log_region = freq >= min_log_hz
    mels = np.where(log_region, min_log_mel + np.log(np.maximum(freq, 1e-10) / min_log_hz) / logstep, mels)
    return mels


def _mel_to_hz(mels):
    mels = np.asarray(mels, dtype=np.float64)
    f_sp = 200.0 / 3
    freqs = mels * f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    log_region = mels >= min_log_mel
    freqs = np.where(log_region, min_log_hz * np.exp(logstep * (mels - min_log_mel)), freqs)
    return freqs


def mel_filterbank(sample_rate=SAMPLE_RATE, n_fft=N_FFT, n_mels=N_MELS, fmin=0.0, fmax=None):
    """librosa-compatible (Slaney-normalized) mel filterbank matrix.

    Returns (n_mels, n_fft//2 + 1).
    """
    if fmax is None:
        fmax = sample_rate / 2.0
    fft_freqs = np.linspace(0, sample_rate / 2.0, 1 + n_fft // 2)
    mel_points = _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2))

    fdiff = np.diff(mel_points)
    ramps = mel_points[:, None] - fft_freqs[None, :]
    lower = -ramps[:-2] / fdiff[:-1, None]
    upper = ramps[2:] / fdiff[1:, None]
    weights = np.maximum(0.0, np.minimum(lower, upper))

    # Slaney-style normalization
    enorm = 2.0 / (mel_points[2 : n_mels + 2] - mel_points[:n_mels])
    weights *= enorm[:, None]
    return weights.astype(np.float32)


def compute_fbank(audio, mel_weights=None):
    """Compute log-mel filterbank features (kaldi-native-fbank compatible).

    audio: float32 1-D array in [-1, 1] at 16kHz.
    Returns (num_frames, N_MELS) float32.
    """
    audio = np.asarray(audio, dtype=np.float32)
    if len(audio) < FRAME_LENGTH:
        return np.zeros((0, N_MELS), dtype=np.float32)
    if mel_weights is None:
        mel_weights = mel_filterbank()

    num_frames = 1 + (len(audio) - FRAME_LENGTH) // FRAME_SHIFT
    indices = np.arange(FRAME_LENGTH)[None, :] + FRAME_SHIFT * np.arange(num_frames)[:, None]
    frames = audio[indices].astype(np.float32)

    # Preemphasis (kaldi convention: first sample uses itself as predecessor)
    pre = np.empty_like(frames)
    pre[:, 1:] = frames[:, 1:] - PREEMPH * frames[:, :-1]
    pre[:, 0] = frames[:, 0] - PREEMPH * frames[:, 0]

    # Periodic hann window (kaldi-native-fbank convention: 2*pi/N)
    window = (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(FRAME_LENGTH) / FRAME_LENGTH)).astype(np.float32)
    pre *= window

    spectrum = np.fft.rfft(pre, n=N_FFT)
    power = (spectrum.real ** 2 + spectrum.imag ** 2).astype(np.float32)

    mel = power @ mel_weights.T
    return np.log(np.maximum(mel, np.finfo(np.float32).eps)).astype(np.float32)


class _Stream:
    """Mimics sherpa_onnx OfflineStream."""

    def __init__(self):
        self.audio = None
        self.sample_rate = None
        self.result = type("Result", (), {"text": ""})()

    def accept_waveform(self, sample_rate, samples):
        self.sample_rate = sample_rate
        self.audio = np.asarray(samples, dtype=np.float32)


class ParakeetOnnxRecognizer:
    """Parakeet TDT transducer with greedy decoding, via raw onnxruntime."""

    def __init__(self, encoder, decoder, joiner, tokens, num_threads=4):
        def make_session(path, threads):
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = threads
            return ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])

        self.encoder = make_session(encoder, num_threads)
        # decoder/joiner run on single frames — threading overhead not worth it
        self.decoder = make_session(decoder, 1)
        self.joiner = make_session(joiner, 1)

        meta = self.encoder.get_modelmeta().custom_metadata_map
        self.normalize_type = meta.get("normalize_type", "")
        self.pred_rnn_layers = int(meta["pred_rnn_layers"])
        self.pred_hidden = int(meta["pred_hidden"])

        self.id2token = {}
        with open(tokens, encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2:
                    self.id2token[int(parts[1])] = parts[0]
        self.vocab_size = len(self.id2token)
        self.blank = self.vocab_size - 1

        self.mel_weights = mel_filterbank()

        self._encoder_inputs = [i.name for i in self.encoder.get_inputs()]
        self._encoder_outputs = [o.name for o in self.encoder.get_outputs()]
        self._decoder_inputs = [i.name for i in self.decoder.get_inputs()]
        self._decoder_outputs = [o.name for o in self.decoder.get_outputs()]
        self._joiner_inputs = [i.name for i in self.joiner.get_inputs()]
        self._joiner_outputs = [o.name for o in self.joiner.get_outputs()]

    # --- sherpa_onnx-compatible API ---

    def create_stream(self):
        return _Stream()

    def decode_stream(self, stream):
        if stream.audio is None:
            return
        if stream.sample_rate != SAMPLE_RATE:
            raise RuntimeError(f"Expected {SAMPLE_RATE}Hz audio, got {stream.sample_rate}Hz")
        stream.result.text = self._transcribe(stream.audio)

    # --- inference ---

    def _run_decoder(self, token, state0, state1):
        target = np.array([[token]], dtype=np.int32)
        target_len = np.array([1], dtype=np.int32)
        decoder_out, _, state0_next, state1_next = self.decoder.run(
            self._decoder_outputs,
            {
                self._decoder_inputs[0]: target,
                self._decoder_inputs[1]: target_len,
                self._decoder_inputs[2]: state0,
                self._decoder_inputs[3]: state1,
            },
        )
        return decoder_out, state0_next, state1_next

    def _transcribe(self, audio):
        audio = np.concatenate([audio, np.zeros(int(SAMPLE_RATE * TAIL_PADDING_SECONDS), dtype=np.float32)])
        features = compute_fbank(audio, self.mel_weights)
        if features.shape[0] == 0:
            return ""

        if self.normalize_type == "per_feature":
            mean = features.mean(axis=0, keepdims=True)
            # ddof=1: match torch.std (unbiased) used when the model was exported
            std = features.std(axis=0, keepdims=True, ddof=1) + 1e-5
            features = (features - mean) / std
        elif self.normalize_type:
            raise RuntimeError(f"Unsupported normalize_type: {self.normalize_type}")

        # encoder expects [1, n_mels, T]
        x = features.T[None, :, :].astype(np.float32)
        x_lens = np.array([x.shape[2]], dtype=np.int64)
        encoder_out, _ = self.encoder.run(
            self._encoder_outputs,
            {self._encoder_inputs[0]: x, self._encoder_inputs[1]: x_lens},
        )

        # TDT greedy search: the joiner predicts a token and how many encoder
        # frames to skip
        state0 = np.zeros((self.pred_rnn_layers, 1, self.pred_hidden), dtype=np.float32)
        state1 = np.zeros((self.pred_rnn_layers, 1, self.pred_hidden), dtype=np.float32)
        tokens = []
        decoder_out, state0_next, state1_next = self._run_decoder(self.blank, state0, state1)

        t = 0
        num_frames = encoder_out.shape[2]
        while t < num_frames:
            encoder_out_t = encoder_out[:, :, t : t + 1]
            logits = self.joiner.run(
                self._joiner_outputs,
                {self._joiner_inputs[0]: encoder_out_t, self._joiner_inputs[1]: decoder_out},
            )[0].reshape(-1)

            idx = int(np.argmax(logits[: self.vocab_size]))
            skip = int(np.argmax(logits[self.vocab_size :]))
            if skip == 0:
                skip = 1

            if idx != self.blank:
                tokens.append(idx)
                state0 = state0_next
                state1 = state1_next
                decoder_out, state0_next, state1_next = self._run_decoder(idx, state0, state1)
            t += skip

        text = "".join(self.id2token[i] for i in tokens)
        return text.replace("▁", " ").strip()
