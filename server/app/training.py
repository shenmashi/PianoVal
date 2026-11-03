"""Isolated fine-tuning worker. Never mutates a running inference model."""

import argparse
from dataclasses import fields
import hashlib
import math
from pathlib import Path
import random
import time

import numpy as np
import torch
import torch.nn.functional as F

from .config import Settings
from .dataset import atomic_json, onset_metrics, read_json
from .model import HOP, SAMPLE_RATE, PianoModel
from .session import AudioSession


def transcribe_audio(model: PianoModel, audio: np.ndarray) -> list[dict]:
    session = AudioSession(SAMPLE_RATE, model.settings)
    session._append_resampled(audio)
    session.finish()
    result = []
    while (window := session.pop_window()) is not None:
        events, _ = model.infer(*window)
        result.extend(session.unique_events(events))
    return result


def evaluate(model, records, root):
    totals = {"tp": 0, "fp": 0, "fn": 0}
    details = []
    for record in records:
        audio = np.load(root / "recordings" / record["id"] / "audio.npy", allow_pickle=False)
        predicted = transcribe_audio(model, audio)
        metrics = onset_metrics(record["notes"], predicted)
        details.append({"recordId": record["id"], "title": record["title"], **metrics})
        for key in totals:
            totals[key] += metrics[key]
    tp, fp, fn = (totals[key] for key in ("tp", "fp", "fn"))
    return {**totals, "precision": tp / (tp + fp) if tp + fp else 0.0,
            "recall": tp / (tp + fn) if tp + fn else 0.0,
            "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.0,
            "toleranceSeconds": 0.05, "recordings": details}


def target_roll(notes, first_frame, settings):
    """Upstream floor quantization, three positive frames, then remove diff frame."""
    length = settings.left_frames + settings.step_frames + settings.right_frames + 1
    target = torch.zeros((88, length))
    start = first_frame - settings.left_frames
    for note in notes:
        frame = math.floor(note["onsetSeconds"] * SAMPLE_RATE / HOP) - start
        for index in range(max(0, frame), min(length, frame + 3)):
            target[note["midi"] - 21, index] = 1
    return target[:, 1:]


def training_window(audio, first_frame, settings):
    start = (first_frame - settings.left_frames) * HOP
    stop = (first_frame + settings.step_frames + settings.right_frames) * HOP
    window = audio[max(0, start):min(len(audio), stop)]
    return np.pad(window, (max(0, -start), max(0, stop - len(audio)))).astype(np.float32)


def run(config_path: Path):
    config = read_json(config_path)
    output = config_path.parent
    root = Path(config["root"])
    parameters = config["parameters"]
    settings_data = config["settings"]
    settings_data["model_path"] = Path(settings_data["model_path"])
    settings_data["studio_dir"] = root
    settings = Settings(**{field.name: settings_data[field.name] for field in fields(Settings)})
    torch.set_num_threads(2)
    torch.manual_seed(parameters["seed"])
    rng = random.Random(parameters["seed"])
    model = PianoModel(settings)
    training = [record for record in config["records"] if record["split"] == "train"]
    validation = [record for record in config["records"] if record["split"] == "validation"]
    began = time.time()
    history = []

    def report(phase, step=0, **extra):
        atomic_json(output / "progress.json", {
            "phase": phase, "step": step, "steps": parameters["steps"],
            "history": history, "elapsedSeconds": round(time.time() - began, 1), **extra,
        })

    report("baseline")
    before = evaluate(model, validation, root)
    report("preparing", baseline=before)
    # Frozen backbone + first two onset stages; fine-tune last onset stage only.
    # eval() freezes BN statistics/dropout for small datasets, without disabling gradients.
    for parameter in model.model.parameters():
        parameter.requires_grad_(False)
    for parameter in model.model.onset_stages[-1].parameters():
        parameter.requires_grad_(True)
    trainable = [parameter for parameter in model.model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=parameters["learningRate"], weight_decay=1e-4)
    # Cache up to 128 deterministic windows for bounded memory on a local CPU.
    examples = []
    choices = []
    for record in training:
        count = math.ceil(record["duration"] * SAMPLE_RATE / HOP)
        choices.extend((record, frame) for frame in range(0, count, settings.step_frames))
    rng.shuffle(choices)
    cache_audio = {}
    for record, frame in choices[:128]:
        if record["id"] not in cache_audio:
            cache_audio[record["id"]] = np.load(root / "recordings" / record["id"] / "audio.npy", allow_pickle=False)
        audio = training_window(cache_audio[record["id"]], frame, settings)
        with torch.no_grad():
            mel = model.frontend(torch.from_numpy(audio).to(model.device)) + settings.mel_offset_db
        examples.append((mel.unsqueeze(0), target_roll(record["notes"], frame, settings).unsqueeze(0).to(model.device),
                         min(settings.step_frames, math.ceil(record["duration"] * SAMPLE_RATE / HOP) - frame)))
    del cache_audio
    report("training", baseline=before, cachedWindows=len(examples), trainableParameters=sum(p.numel() for p in trainable))
    # Last stage has gradients; earlier stages remain frozen. Only the central valid
    # interval contributes to loss, matching streaming inference context and EOF handling.
    for step in range(1, parameters["steps"] + 1):
        mel, target, valid = rng.choice(examples)
        optimizer.zero_grad(set_to_none=True)
        stages, _ = model.model.forward_onsets(mel)
        # forward_onsets removes frame zero for the time difference.
        start = settings.left_frames - 1
        logits = stages[-1][..., start:start + valid]
        truth = target[..., start:start + valid]
        loss = F.binary_cross_entropy_with_logits(logits, truth, pos_weight=torch.tensor(8.0, device=model.device))
        if not torch.isfinite(loss):
            raise ValueError("训练损失出现非有限数值，未生成候选模型")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        optimizer.step()
        history.append({"step": step, "loss": round(loss.item(), 7)})
        report("training", step, baseline=before, cachedWindows=len(examples), trainableParameters=sum(p.numel() for p in trainable))
    report("validation", parameters["steps"], baseline=before)
    after = evaluate(model, validation, root)
    checkpoint = output / "candidate.torch"
    torch.save({key: value.detach().cpu() for key, value in model.model.state_dict().items()}, checkpoint)
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    demonstration = any(record.get("provenance", "").startswith("synthetic") for record in config["records"])
    eligible = not demonstration and after["f1"] > before["f1"] and after["precision"] >= before["precision"]
    result = {
        "baseline": before, "candidate": after, "deltaF1": after["f1"] - before["f1"],
        "eligible": eligible, "checkpointSha256": digest, "baseCheckpointSha256": model.sha256,
        "demonstration": demonstration,
        "history": history, "elapsedSeconds": round(time.time() - began, 2),
        "trainableParameters": sum(parameter.numel() for parameter in trainable),
        "cachedWindows": len(examples), "validationRecordings": len(validation),
        "validationSeconds": sum(record["duration"] for record in validation),
        "strategy": "last onset stage; frozen backbone and BN; BCE pos_weight=8; no velocity fine-tuning",
        "interpretation": "Independent local validation only; not a student accuracy or generalization guarantee",
    }
    atomic_json(output / "result.json", result)
    report("complete", parameters["steps"], **result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        run(args.config)
    except Exception as error:
        atomic_json(args.config.parent / "worker-error.json", {"message": str(error)})
        raise
