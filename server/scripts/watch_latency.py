"""Read live latency traces for one authenticated test account."""

import argparse
from collections import defaultdict
import json
from pathlib import Path
import time


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    lower = int(index)
    return round(values[lower] + (values[min(lower + 1, len(values) - 1)] - values[lower]) * (index - lower), 1)


def watch(root, username, duration):
    offsets, owners, stats = {}, {}, defaultdict(lambda: defaultdict(list))
    began = time.monotonic()
    print(json.dumps({"event": "watching", "username": username, "startedAtUnixMs": time.time() * 1000}), flush=True)
    while not duration or time.monotonic() - began < duration:
        for path in sorted((root / "latency-runs").glob("*.jsonl")):
            with path.open() as source:
                source.seek(offsets.get(path, 0))
                while True:
                    position = source.tell()
                    line = source.readline()
                    if not line or not line.endswith("\n"):
                        offsets[path] = position
                        break
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("kind") == "session_start":
                        owners[path] = event.get("username")
                    if owners.get(path) != username:
                        continue
                    record = {"username": username, "sessionId": path.stem, "event": event["kind"],
                              "serverUnixMs": event.get("serverUnixMs")}
                    values = stats[path]
                    if event["kind"] == "model_window":
                        values["inference"].append(event["inferenceMs"])
                        record.update(windowId=event["windowId"], inferenceMs=event["inferenceMs"],
                                      computeToAudioRatio=event["serverTiming"]["computeToAudioRatio"],
                                      recognized=[note["note"] for note in event["events"]])
                    elif event["kind"] == "browser_window":
                        for field in ["analysisLagMs", "rttMs", "lastDecisionLatencyMs"]:
                            if isinstance(event.get(field), (int, float)):
                                values[field].append(event[field])
                                record[field] = round(event[field], 1)
                        record.update(windowId=event.get("windowId"), browserBufferedBytes=event.get("browserBufferedBytes"))
                    elif event["kind"] == "session_end":
                        record.update(status=event["status"], audioSeconds=event["audioSeconds"],
                                      receivedPackets=event["receivedPackets"], droppedLogEntries=event.get("droppedLogEntries"))
                        record["summary"] = {name: {"samples": len(samples), "p50Ms": percentile(samples, .5),
                                                    "p95Ms": percentile(samples, .95), "maxMs": round(max(samples), 1)}
                                             for name, samples in values.items() if samples}
                    elif event["kind"] == "pcm_receive":
                        record.update(sequence=event["sequence"], audioSeconds=event["audioSeconds"])
                    elif event["kind"] == "session_start":
                        record.update(recordingKind=event["recordingKind"], stepMs=event["stepMs"], rightContextMs=event["rightContextMs"])
                    else:
                        continue
                    print(json.dumps(record, ensure_ascii=False), flush=True)
        time.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/var/lib/pianoval"))
    parser.add_argument("--username", required=True)
    parser.add_argument("--duration", type=int, default=0, help="Seconds; 0 keeps watching")
    arguments = parser.parse_args()
    watch(arguments.root, arguments.username, arguments.duration)
