"""Adapter for the unmodified, pinned O&V model; no mock/FFT fallback."""

import hashlib
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

from .config import ROOT, Settings

sys.path.insert(0, str(ROOT / "vendor"))
from ov_piano.inference import OnsetVelocityNmsDecoder  # noqa: E402
from ov_piano.models.ov import OnsetsAndVelocities  # noqa: E402
from ov_piano.utils import TorchWavToLogmel  # noqa: E402

SAMPLE_RATE = 16000
HOP = 384
CHECKPOINT_SHA256 = "90901ff8c7cb15c76a4da2f4aca643a10295c834ac9e549ee16097d4bbce642d"


def midi_name(midi: int) -> str:
    return ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")[midi % 12] + str(midi // 12 - 1)


class PianoModel:
    def __init__(self, settings: Settings, checkpoint_path=None, expected_sha256=None, version="base"):
        self.settings = settings
        self.device = torch.device(settings.device)
        path = checkpoint_path or settings.model_path
        self.version = version
        if not path.is_file():
            raise FileNotFoundError("Model missing. Run: uv run python scripts/download_model.py")
        self.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        if self.sha256 != (expected_sha256 or CHECKPOINT_SHA256):
            raise ValueError("O&V checkpoint checksum mismatch")
        self.model = OnsetsAndVelocities(
            2, 229, 88, bn_momentum=0, dropout_drop_p=0, init_fn=None,
        )
        self.model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
        self.model.to(self.device).eval()
        self.frontend = TorchWavToLogmel(SAMPLE_RATE, 2048, HOP, 229).to(self.device).eval()
        self.decoder = OnsetVelocityNmsDecoder(
            88, nms_pool_ksize=3, gauss_conv_stddev=1, gauss_conv_ksize=11,
            vel_pad_left=1, vel_pad_right=1,
        ).to(self.device).eval()

    def metadata(self) -> dict:
        settings = self.settings
        return {
            "name": "onsets-and-velocities", "device": str(self.device),
            "version": self.version,
            "sampleRate": SAMPLE_RATE, "midiRange": [21, 108],
            "threshold": settings.threshold, "melOffsetDb": settings.mel_offset_db,
            "inferenceProfile": "piano-stream-v2" if (settings.threshold, settings.mel_offset_db, settings.left_frames, settings.step_frames, settings.right_frames) == (.74, -22, 100, 8, 12) else "custom",
            "validationScope": "Local synthetic sampled-piano tests; production microphone accuracy unverified",
            "stepSeconds": settings.step_frames * HOP / SAMPLE_RATE,
            "rightContextSeconds": settings.right_frames * HOP / SAMPLE_RATE,
            "windowSeconds": (settings.left_frames + settings.step_frames + settings.right_frames) * HOP / SAMPLE_RATE,
            "outputs": ["pitch", "onset", "velocity", "onsetProbability"],
            "limitations": ["No note-off/pedal prediction", "No score following or grading", "Room-recording accuracy not yet evaluated"],
            "checkpointSha256": self.sha256,
            "source": "https://github.com/andres-fr/iamusica_training",
        }

    @torch.inference_mode()
    def infer(self, audio: np.ndarray, first_frame: int, frame_count: int) -> tuple[list[dict], float]:
        """Decode only a window's central interval, keeping both context margins."""
        began = time.perf_counter()
        mel = self.frontend(torch.from_numpy(audio).to(self.device))
        mel = mel + self.settings.mel_offset_db
        stages, velocities = self.model(mel.unsqueeze(0))
        probabilities = F.pad(torch.sigmoid(stages[-1]), (1, 0))
        velocities = F.pad(torch.sigmoid(velocities), (1, 0))
        decoded = self.decoder(probabilities, velocities, pthresh=self.settings.threshold)
        begin = self.settings.left_frames
        events = []
        for row in decoded.itertuples(index=False):
            if begin <= row.t_idx < begin + frame_count:
                frame = first_frame + int(row.t_idx) - begin
                midi = int(row.key) + 21
                events.append({
                    "midi": midi, "note": midi_name(midi),
                    "onsetSeconds": round(max(0.0, frame * HOP / SAMPLE_RATE - 0.01), 6),
                    "velocity": max(1, min(127, round(float(row.vel) * 127))),
                    "onsetProbability": round(float(row.prob), 6),
                })
        events.sort(key=lambda event: (event["onsetSeconds"], event["midi"]))
        return events, (time.perf_counter() - began) * 1000
