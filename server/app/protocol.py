"""Version 1: JSON controls and <uint32 sequence, uint64 sample offset, PCM16LE>."""

import struct
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

HEADER = struct.Struct("<IQ")
SUPPORTED_RATES = {16000, 22050, 24000, 32000, 44100, 48000}


class ProtocolError(ValueError):
    pass


class StartMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    type: Literal["start"]
    version: Literal[1] = 1
    sampleRate: int
    channels: Literal[1] = 1
    format: Literal["pcm_s16le"] = "pcm_s16le"
    token: str = Field(default="", max_length=4096)
    modelId: str = Field(default="active", max_length=32)
    saveRecording: bool = False
    recordingKind: Literal["microphone", "simulated"] = "microphone"
    testId: str = Field(default="", max_length=36)
    testContext: dict[str, str | int | float] = Field(default_factory=dict, max_length=12)


class PacketReader:
    def __init__(self, sample_rate: int, max_seconds: int):
        if sample_rate not in SUPPORTED_RATES:
            raise ProtocolError(f"Unsupported sampleRate; choose {sorted(SUPPORTED_RATES)}")
        self.sample_rate = sample_rate
        self.max_samples = sample_rate * max_seconds
        self.sequence = 0
        self.samples = 0

    def decode(self, packet: bytes) -> np.ndarray:
        if len(packet) <= HEADER.size or (len(packet) - HEADER.size) % 2:
            raise ProtocolError("Expected a 12-byte header followed by whole PCM16 samples")
        sequence, offset = HEADER.unpack_from(packet)
        count = (len(packet) - HEADER.size) // 2
        if count > self.sample_rate // 4:
            raise ProtocolError("Each packet must contain <= 250 ms of audio")
        if sequence != self.sequence or offset != self.samples:
            raise ProtocolError(
                f"Discontinuous audio: expected sequence={self.sequence}, sampleOffset={self.samples}"
            )
        if self.samples + count > self.max_samples:
            raise ProtocolError("Session audio duration limit exceeded")
        audio = np.frombuffer(packet, dtype="<i2", offset=HEADER.size).astype(np.float32)
        audio /= 32768.0
        self.sequence += 1
        self.samples += count
        return audio
