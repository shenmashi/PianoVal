"""Local, versioned recordings and explicit performance annotations."""

import hashlib
import io
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid

import mido
import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator
import soundfile as sf

from .model import SAMPLE_RATE


class NoteLabel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    midi: int = Field(ge=21, le=108, strict=True)
    onsetSeconds: float = Field(ge=0)
    velocity: int = Field(default=80, ge=1, le=127, strict=True)


class Annotation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    notes: list[NoteLabel] = Field(max_length=50000)
    reviewed: bool = False
    split: str = Field(default="unassigned", pattern="^(unassigned|train|validation)$")
    group: str = Field(min_length=1, max_length=120)

    @field_validator("group")
    @classmethod
    def clean_group(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("采集分组不能为空")
        return value


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def read_json(path: Path):
    return json.loads(path.read_text())


def safe_id(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("无效的记录编号")
    return value


def decode_audio(path: Path, max_seconds: int) -> np.ndarray:
    """Decode within a duration bound. Compressed audio uses a local ffmpeg."""
    try:
        with sf.SoundFile(path) as source:
            if source.frames / source.samplerate > max_seconds:
                raise ValueError(f"录音最长 {max_seconds} 秒")
            audio = source.read(dtype="float32", always_2d=True).mean(axis=1)
            rate = source.samplerate
        if rate != SAMPLE_RATE:
            import soxr
            audio = soxr.resample(audio, rate, SAMPLE_RATE).astype(np.float32)
    except sf.LibsndfileError:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise ValueError("此格式需要服务端安装 ffmpeg；也可上传 WAV / FLAC") from None
        try:
            result = subprocess.run([
                ffmpeg, "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
                "-i", str(path), "-t", str(max_seconds + 1), "-vn", "-ac", "1",
                "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
            ], capture_output=True, timeout=90, check=True)
        except (subprocess.SubprocessError, OSError):
            raise ValueError("音频解码失败，请检查录音格式") from None
        audio = np.frombuffer(result.stdout, dtype="<f4").copy()
    if not SAMPLE_RATE // 4 <= len(audio) <= SAMPLE_RATE * max_seconds:
        raise ValueError(f"请上传 0.25～{max_seconds} 秒的录音")
    if not np.isfinite(audio).all():
        raise ValueError("音频包含无效采样")
    return audio


def parse_midi(data: bytes, offset: float, duration: float) -> list[dict]:
    if not math.isfinite(offset) or abs(offset) > 600:
        raise ValueError("MIDI 时间偏移无效")
    try:
        midi = mido.MidiFile(file=io.BytesIO(data))
        if midi.type == 2:
            raise ValueError("不支持异步 MIDI Type 2")
        timestamp = 0.0
        notes = []
        for message in midi:
            timestamp += message.time
            if message.type == "note_on" and message.velocity > 0 and message.channel != 9:
                notes.append(NoteLabel(
                    midi=message.note, onsetSeconds=round(timestamp + offset, 6),
                    velocity=message.velocity,
                ).model_dump())
                if len(notes) > 50000:
                    raise ValueError("MIDI 音符过多")
    except (EOFError, OSError, KeyError, IndexError, TypeError):
        raise ValueError("无法读取 MIDI 文件") from None
    validate_notes(notes, duration)
    if not notes:
        raise ValueError("MIDI 中没有钢琴音符")
    return sorted(notes, key=lambda note: (note["onsetSeconds"], note["midi"]))


def validate_notes(notes: list[dict], duration: float):
    seen = set()
    for note in notes:
        if note["onsetSeconds"] >= duration:
            raise ValueError("标注超出录音时长，请检查 MIDI 与录音的时间偏移")
        key = (note["midi"], round(note["onsetSeconds"], 6))
        if key in seen:
            raise ValueError("同一时间存在重复音符标注")
        seen.add(key)


class StudioStore:
    def __init__(self, root: Path):
        self.root = root
        self.recordings = root / "recordings"
        self.jobs = root / "jobs"
        self.lock = threading.RLock()
        self.recordings.mkdir(parents=True, exist_ok=True)
        self.jobs.mkdir(parents=True, exist_ok=True)

    def directory(self, identifier: str) -> Path:
        path = self.recordings / safe_id(identifier)
        if not (path / "record.json").is_file():
            raise FileNotFoundError("录音不存在")
        return path

    def get_record(self, identifier: str):
        with self.lock:
            return read_json(self.directory(identifier) / "record.json")

    def create_record(self, title: str, audio: np.ndarray, provenance="uploaded"):
        identifier = uuid.uuid4().hex
        path = self.recordings / identifier
        path.mkdir()
        np.save(path / "audio.npy", audio, allow_pickle=False)
        sf.write(path / "audio.wav", audio, SAMPLE_RATE, subtype="PCM_16")
        digest = hashlib.sha256(audio.tobytes()).hexdigest()
        record = {
            "id": identifier, "title": title[:120], "createdAt": time.time(),
            "duration": len(audio) / SAMPLE_RATE, "sampleRate": SAMPLE_RATE,
            "audioSha256": digest, "revision": 1, "notes": [],
            "hasLabels": False, "reviewed": False, "split": "unassigned",
            "group": digest[:16], "labelSource": None,
            "provenance": provenance,
        }
        atomic_json(path / "record.json", record)
        return record

    def annotate(self, identifier: str, annotation: Annotation, source="manual"):
        with self.lock:
            record = self.get_record(identifier)
            notes = [note.model_dump() for note in annotation.notes]
            validate_notes(notes, record["duration"])
            record.update(annotation.model_dump())
            record.update(hasLabels=True, revision=record["revision"] + 1, labelSource=source)
            record["notes"].sort(key=lambda note: (note["onsetSeconds"], note["midi"]))
            atomic_json(self.directory(identifier) / "record.json", record)
            return record

    def list_records(self):
        with self.lock:
            records = []
            for path in sorted(self.recordings.glob("*/record.json")):
                record = read_json(path)
                records.append({**{key: value for key, value in record.items() if key != "notes"},
                                "noteCount": len(record["notes"])})
            return records

    def job_path(self, identifier: str):
        return self.jobs / safe_id(identifier)

    def get_job(self, identifier: str):
        return read_json(self.job_path(identifier) / "job.json")

    def update_job(self, identifier: str, **values):
        with self.lock:
            job = self.get_job(identifier)
            job.update(values, updatedAt=time.time())
            atomic_json(self.job_path(identifier) / "job.json", job)
            return job

    def new_job(self, kind: str, **values):
        identifier = uuid.uuid4().hex
        job = {"id": identifier, "kind": kind, "status": "queued", "progress": 0,
               "createdAt": time.time(), **values}
        atomic_json(self.job_path(identifier) / "job.json", job)
        return job

    def list_jobs(self):
        return sorted((read_json(path) for path in self.jobs.glob("*/job.json")),
                      key=lambda job: job["createdAt"], reverse=True)

    def snapshot(self):
        records = [self.get_record(record["id"]) for record in self.list_records()
                   if record["reviewed"] and record["hasLabels"]
                   and record["split"] in ("train", "validation")]
        train = [record for record in records if record["split"] == "train"]
        validation = [record for record in records if record["split"] == "validation"]
        if len({record.get("provenance", "uploaded").startswith("synthetic") for record in records}) > 1:
            raise ValueError("演示合成音与真实录音不能混合训练；请将演示录音移出数据集后再训练真实数据")
        if not train or not validation:
            raise ValueError("至少需要一条已确认标注的训练录音和一条独立验证录音")
        for field in ("group", "audioSha256"):
            if {str(record[field]).casefold() for record in train} & {str(record[field]).casefold() for record in validation}:
                raise ValueError("训练集与验证集不能包含同一分组或重复音频；同曲目、同一次录音请使用相同分组")
        if not any(record["notes"] for record in train) or not any(record["notes"] for record in validation):
            raise ValueError("训练集与验证集均须包含已标注音符")
        if sum(record["duration"] for record in records) > 3600:
            raise ValueError("本机训练工作台单次最多处理 60 分钟录音")
        return records


def onset_metrics(expected: list[dict], predicted: list[dict], tolerance=0.05):
    """Maximum one-to-one, same-pitch matching within 50 ms; extras count as FP."""
    matches = 0
    for pitch in range(21, 109):
        truth = sorted(note["onsetSeconds"] for note in expected if note["midi"] == pitch)
        actual = sorted(note["onsetSeconds"] for note in predicted if note["midi"] == pitch)
        i = j = 0
        while i < len(truth) and j < len(actual):
            if actual[j] < truth[i] - tolerance - 1e-9:
                j += 1
            elif truth[i] < actual[j] - tolerance - 1e-9:
                i += 1
            else:
                matches += 1
                i += 1
                j += 1
    fp, fn = len(predicted) - matches, len(expected) - matches
    precision = matches / (matches + fp) if matches + fp else 0.0
    recall = matches / (matches + fn) if matches + fn else 0.0
    return {"tp": matches, "fp": fp, "fn": fn, "precision": precision,
            "recall": recall, "f1": 2 * matches / (2 * matches + fp + fn) if 2 * matches + fp + fn else 0.0,
            "toleranceSeconds": tolerance}
