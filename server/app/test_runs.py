"""Keep test reports and raw stream evidence separate from model training."""

from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .dataset import atomic_json, read_json


class TestRunReport(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    status: Literal["completed", "cancelled", "failed"]
    final: bool
    settings: dict
    analysis: dict
    recordingId: str | None = None


def report_path(store, identifier):
    return store.root / "test-runs" / (UUID(identifier).hex + ".json")


def save_report(store, body):
    report = body.model_dump()
    if len(json.dumps(report, allow_nan=False).encode()) > 8 * 1024 * 1024:
        raise ValueError("测试报告超过 8MB 上限")
    record = store.get_record(body.recordingId) if body.recordingId else None
    rows = report["analysis"].get("rows", [])
    microphone = (report.get("source") or {}).get("kind") == "microphone"
    report["scope"] = "microphone-unreviewed" if microphone else "synthetic-piano-direct-pcm"
    reviewed = [decision for decision in report.get("decisions", []) if decision.get("teacherReview")]
    report["teacherReview"] = {"count": len(reviewed), "falseBlocks": sum(d["action"] == "wait" and d["teacherReview"] == "should-advance" for d in reviewed),
                               "falsePasses": sum(d["action"] == "advance" and d["teacherReview"] == "should-wait" for d in reviewed)}
    review = report["teacherReview"]
    review["correctDecisions"] = review["count"] - review["falseBlocks"] - review["falsePasses"]
    review["accuracy"] = review["correctDecisions"] / review["count"] if review["count"] else None
    review["totalDecisions"] = len(report.get("decisions", []))
    if microphone:
        report["analysis"]["accuracy"] = None  # Score progress cannot establish microphone accuracy.
    report["serverRecordedAt"] = datetime.now(timezone.utc).isoformat()
    report["audioSha256"] = record["audioSha256"] if record else None
    report["diagnostics"] = {
        "octaveExtraGroups": sum(any(abs(extra - pitch) == 12 for extra in row.get("extra", [])
                                     for pitch in row.get("pitches", [])) for row in rows),
        "missingGroups": sum(bool(row.get("missing")) for row in rows),
        "nearThresholdExtraGroups": sum(any(event["midi"] in row.get("extra", []) and event.get("onsetProbability", 1) <= .8
                                            for event in row.get("modelEvents", [])) for row in rows),
        "hasReplayAudio": record is not None,
        "interpretation": "Candidate causes from model output; not a verified acoustic cause or real-student accuracy",
    }
    identity = {"audioSha256": report["audioSha256"], "model": report.get("model"), "settings": body.settings}
    report["replayComparisonKey"] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest() if record else None
    with store.lock:
        atomic_json(report_path(store, body.id), report)
    return report


def load_report(store, identifier, include_latency=True):
    path = report_path(store, identifier)
    if not path.is_file():
        report = read_json(store.root / "stream-runs" / (UUID(identifier).hex + ".json"))
    else:
        report = read_json(path)
    if path.is_file() and report.get("sessionId"):
        stream_path = store.root / "stream-runs" / (UUID(report["sessionId"]).hex + ".json")
        if stream_path.is_file():
            report["stream"] = read_json(stream_path)
            report["recordingId"] = report.get("recordingId") or report["stream"].get("recordingId")
    if include_latency and report.get("sessionId"):
        trace = store.root / "latency-runs" / (UUID(report["sessionId"]).hex + ".jsonl")
        if trace.is_file():
            report["latencyLog"] = [json.loads(line) for line in trace.read_text().splitlines() if line.strip()]
    return report


def summaries(store):
    paths = sorted((store.root / "test-runs").glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)[:50]
    reports = [load_report(store, path.stem, include_latency=False) for path in paths]
    result = [{key: report.get(key) for key in ("id", "score", "settings", "status", "serverRecordedAt", "recordingId", "diagnostics", "scope", "teacherReview")}
            | {"accuracy": report["analysis"].get("accuracy"), "performance": report.get("performance")}
            for report in reports]
    known = {report["id"] for report in reports}
    known_sessions = {report.get("sessionId") for report in reports}
    for path in sorted((store.root / "stream-runs").glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)[:50]:
        run = read_json(path)
        if run.get("testId") in known or run["sessionId"] in known_sessions:
            continue
        result.append({"id": run["sessionId"], "settings": run["context"], "status": run["status"],
                       "serverRecordedAt": datetime.fromtimestamp(run["startedAt"], timezone.utc).isoformat(),
                       "recordingId": run.get("recordingId"), "scope": run["recordingKind"], "accuracy": None,
                       "diagnostics": {"hasReplayAudio": bool(run.get("recordingId")), "octaveExtraGroups": None, "missingGroups": None}})
    return sorted(result, key=lambda report: report["serverRecordedAt"], reverse=True)[:50]
