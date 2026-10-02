"""Nemotron Speech Streaming (cache-aware RNNT) on onnxruntime + numpy.

Decodes a whole utterance by running the streaming encoder chunk by chunk,
the way it would run live, and greedy-decoding the RNNT after each chunk.
Pure numpy + onnxruntime — no sherpa_onnx, no torch — so on Termux it needs
only `pkg install python-numpy python-onnxruntime`, like parakeet_onnx.py.

Model: the sherpa-onnx export of nvidia/nemotron-speech-streaming-en-0.6b
(encoder/decoder/joiner .int8.onnx + tokens.txt). Encoder inputs are
audio_signal [1,128,T], length, and three caches (cache_last_channel,
cache_last_time, cache_last_channel_len) that come back updated and must be
fed to the next chunk. The decoder is a 2-layer LSTM prediction network; the
joiner returns one logit per token plus the blank (the last id).

The 128-mel features are the same kaldi-style fbank Parakeet uses, so they
are imported from parakeet_onnx rather than copied.
"""

import numpy as np
import onnxruntime as ort

from parakeet_onnx import SAMPLE_RATE, compute_fbank, mel_filterbank

# Chunk geometry of the 160ms export, used when the model's metadata does not
# say otherwise: each encoder call sees `window` feature frames and the next
# call starts `shift` frames later.
DEFAULT_WINDOW = 25
DEFAULT_SHIFT = 16

# Cache shapes of the 0.6B export (batch dimension added at run time), used
# when the metadata lacks them.
DEFAULT_CACHE_CHANNEL = (24, 70, 1024)
DEFAULT_CACHE_TIME = (24, 1024, 8)

# A joiner that keeps answering "not blank" must not stall the decode; at most
# this many tokens are taken from one encoder frame.
MAX_SYMBOLS_PER_FRAME = 10

# Silence appended so the last words clear the encoder's look-ahead.
TAIL_PADDING_SECONDS = 0.4


def _meta_int(meta, key, default):
    try:
        return int(meta[key])
    except (KeyError, ValueError):
        return default


class NemotronRecognizer:
    """Cache-aware streaming RNNT with greedy decoding, via raw onnxruntime."""

    def __init__(self, model_dir, num_threads=4):
        def make_session(name, threads):
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = threads
            return ort.InferenceSession(
                f"{model_dir}/{name}.int8.onnx", sess_options=opts, providers=["CPUExecutionProvider"]
            )

        self.encoder = make_session("encoder", num_threads)
        # decoder/joiner run on single frames — threading overhead not worth it
        self.decoder = make_session("decoder", 1)
        self.joiner = make_session("joiner", 1)

        meta = self.encoder.get_modelmeta().custom_metadata_map
        self.window = _meta_int(meta, "window_size", DEFAULT_WINDOW)
        self.shift = _meta_int(meta, "chunk_shift", DEFAULT_SHIFT)
        self._channel_shape = tuple(
            _meta_int(meta, f"cache_last_channel_dim{i + 1}", DEFAULT_CACHE_CHANNEL[i]) for i in range(3)
        )
        self._time_shape = tuple(
            _meta_int(meta, f"cache_last_time_dim{i + 1}", DEFAULT_CACHE_TIME[i]) for i in range(3)
        )
        self.pred_rnn_layers = _meta_int(meta, "pred_rnn_layers", 2)
        self.pred_hidden = _meta_int(meta, "pred_hidden", 640)

        self.id2token = {}
        with open(f"{model_dir}/tokens.txt", encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").rsplit(" ", 1)
                if len(parts) == 2:
                    self.id2token[int(parts[1])] = parts[0]
        self.blank = len(self.id2token) - 1  # "<blk>" is the last id (1024)

        self.mel_weights = mel_filterbank()

        self._enc_in = [i.name for i in self.encoder.get_inputs()]
        self._enc_out = [o.name for o in self.encoder.get_outputs()]
        self._dec_in = [i.name for i in self.decoder.get_inputs()]
        self._dec_out = [o.name for o in self.decoder.get_outputs()]
        self._joi_in = [i.name for i in self.joiner.get_inputs()]
        self._joi_out = [o.name for o in self.joiner.get_outputs()]

    # --- inference ---

    def _run_decoder(self, token, state0, state1):
        decoder_out, _, state0_next, state1_next = self.decoder.run(
            self._dec_out,
            {
                self._dec_in[0]: np.array([[token]], dtype=np.int32),
                self._dec_in[1]: np.array([1], dtype=np.int32),
                self._dec_in[2]: state0,
                self._dec_in[3]: state1,
            },
        )
        return decoder_out, state0_next, state1_next

    def transcribe(self, audio, sample_rate=SAMPLE_RATE):
        """Decode one whole utterance (float32 mono in [-1, 1]) to text."""
        if sample_rate != SAMPLE_RATE:
            raise RuntimeError(f"Expected {SAMPLE_RATE}Hz audio, got {sample_rate}Hz")

        audio = np.asarray(audio, dtype=np.float32)
        audio = np.concatenate([audio, np.zeros(int(SAMPLE_RATE * TAIL_PADDING_SECONDS), dtype=np.float32)])
        features = compute_fbank(audio, self.mel_weights)  # (frames, 128)
        if features.shape[0] == 0:
            return ""
        features = features.T  # encoder wants [n_mels, T]
        total = features.shape[1]

        cache_channel = np.zeros((1, *self._channel_shape), dtype=np.float32)
        cache_time = np.zeros((1, *self._time_shape), dtype=np.float32)
        cache_len = np.zeros(1, dtype=np.int64)

        state0 = np.zeros((self.pred_rnn_layers, 1, self.pred_hidden), dtype=np.float32)
        state1 = np.zeros((self.pred_rnn_layers, 1, self.pred_hidden), dtype=np.float32)
        decoder_out, state0_next, state1_next = self._run_decoder(self.blank, state0, state1)
        tokens = []

        length = np.array([self.window], dtype=np.int64)
        for start in range(0, total, self.shift):
            chunk = features[:, start : start + self.window]
            if chunk.shape[1] < self.window:  # pad the last chunk with zeros
                chunk = np.pad(chunk, ((0, 0), (0, self.window - chunk.shape[1])))

            encoder_out, encoded_len, cache_channel, cache_time, cache_len = self.encoder.run(
                self._enc_out,
                {
                    self._enc_in[0]: chunk[None].astype(np.float32),
                    self._enc_in[1]: length,
                    self._enc_in[2]: cache_channel,
                    self._enc_in[3]: cache_time,
                    self._enc_in[4]: cache_len,
                },
            )

            for t in range(min(encoder_out.shape[2], int(encoded_len[0]))):
                frame = encoder_out[:, :, t : t + 1]
                for _ in range(MAX_SYMBOLS_PER_FRAME):
                    logits = self.joiner.run(
                        self._joi_out,
                        {self._joi_in[0]: frame, self._joi_in[1]: decoder_out},
                    )[0].reshape(-1)
                    token = int(np.argmax(logits))
                    if token == self.blank:
                        break
                    tokens.append(token)
                    state0, state1 = state0_next, state1_next
                    decoder_out, state0_next, state1_next = self._run_decoder(token, state0, state1)

        text = "".join(self.id2token[i] for i in tokens)
        return text.replace("▁", " ").strip()
