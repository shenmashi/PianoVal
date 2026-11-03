"""Real-time WebSocket load and deterministic artificial network-delay benchmark.

Artificial propagation delay is included in timings, not claimed as a WAN test.
"""
import argparse
import asyncio
import json
from pathlib import Path
import random
import struct
import sys
import time

import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import ROOT
from app.dataset import onset_metrics


def summary(values):
    return {"count": len(values), "p50Ms": float(np.percentile(values, 50)) if values else None,
            "p95Ms": float(np.percentile(values, 95)) if values else None, "maxMs": max(values) if values else None}


async def connection(args, index, audio, groups, notes):
    rng = random.Random(31415 + index)
    async with websockets.connect(args.url, max_size=1024 * 1024, ping_interval=None) as socket:
        await socket.send(json.dumps({"type": "start", "sampleRate": 16000, "token": args.token}))
        ready = json.loads(await socket.recv())
        if ready["type"] != "ready":
            raise RuntimeError(ready)
        began = time.perf_counter()
        observed, decisions, inferred, queued, pings = [], {}, [], [], []
        packet_samples = 640

        async def send():
            count = 0
            ping_tasks = []
            async def ping(sent_at):
                await asyncio.sleep(args.one_way_ms / 1000 + rng.uniform(0, args.jitter_ms / 1000))
                await socket.send(json.dumps({"type": "ping", "clientSentAt": sent_at}))
            for offset in range(0, len(audio), packet_samples):
                chunk = audio[offset:offset + packet_samples]
                deadline = began + (offset + len(chunk)) / 16000 + args.one_way_ms / 1000 + rng.uniform(0, args.jitter_ms / 1000)
                await asyncio.sleep(max(0, deadline - time.perf_counter()))
                await socket.send(struct.pack("<IQ", count, offset) + chunk.tobytes())
                count += 1
                if count % 50 == 0:
                    ping_tasks.append(asyncio.create_task(ping(time.perf_counter())))
            await asyncio.gather(*ping_tasks)
            await socket.send(json.dumps({"type": "stop", "packets": count, "samples": len(audio)}))

        async def receive():
            async for raw in socket:
                message = json.loads(raw)
                # Deliberately hold the downlink result as if crossing a network.
                await asyncio.sleep(args.one_way_ms / 1000 + rng.uniform(0, args.jitter_ms / 1000))
                now = time.perf_counter()
                if message["type"] == "error":
                    raise RuntimeError(message)
                if message["type"] == "pong":
                    pings.append((now - message["clientSentAt"]) * 1000)
                if message["type"] == "notes":
                    observed.extend(message["events"])
                    inferred.append(message["inferenceMs"])
                    queued.append(message["queueAndInferenceMs"])
                    if not message["tailPadded"]:
                        for i, group in enumerate(groups):
                            if i not in decisions and group["onsetSeconds"] + .12 <= message["processedThroughSeconds"]:
                                decisions[i] = (now - began - group["onsetSeconds"]) * 1000
                if message["type"] == "complete":
                    return message

        sender = asyncio.create_task(send())
        try:
            complete = await asyncio.wait_for(receive(), timeout=len(audio) / 16000 + 30)
            await sender
        finally:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
        correct = sum(sorted(group["pitches"]) == sorted({event["midi"] for event in observed if abs(event["onsetSeconds"] - group["onsetSeconds"]) <= .12}) for group in groups)
        return {"connection": index, "model": ready["model"], "audioSeconds": complete["audioSeconds"],
                "groups": len(groups), "correctGroups": correct, "groupAccuracy": correct / len(groups),
                "metrics": onset_metrics(notes, observed), "decisionLatency": summary(list(decisions.values())),
                "inference": summary(inferred), "queueAndInference": summary(queued), "simulatedRtt": summary(pings)}


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://localhost:8765/ws/transcribe")
    parser.add_argument("--token", default="")
    parser.add_argument("--connections", type=int, default=2)
    parser.add_argument("--one-way-ms", type=float, default=40)
    parser.add_argument("--jitter-ms", type=float, default=10)
    parser.add_argument("--record-id", default="6a3a7d2157d24200b85ac4d6dd7c011d")
    parser.add_argument("--seconds", type=float, default=12)
    parser.add_argument("--output", type=Path, default=ROOT / "test-evidence/stream-load.json")
    args = parser.parse_args()
    if args.connections < 1 or min(args.one_way_ms, args.jitter_ms) < 0:
        parser.error("positive connections and non-negative simulated delays required")
    path = ROOT / "data/studio/recordings" / args.record_id
    record = json.loads((path / "record.json").read_text())
    audio = np.load(path / "audio.npy", allow_pickle=False)[:round(args.seconds * 16000)]
    notes = [note for note in record["notes"] if note["onsetSeconds"] < len(audio) / 16000 - 1]
    groups = []
    for note in notes:
        if not groups or note["onsetSeconds"] - groups[-1]["onsetSeconds"] > .002:
            groups.append({"onsetSeconds": note["onsetSeconds"], "pitches": []})
        groups[-1]["pitches"].append(note["midi"])
    # Leave a trailing silent interval so EOF is not necessary for the last decision.
    audio[round((notes[-1]["onsetSeconds"] + .8) * 16000):] = 0
    pcm = np.round(audio * 32767).astype("<i2")
    results = await asyncio.gather(*(connection(args, index, pcm, groups, notes) for index in range(args.connections)))
    report = {"method": "Actual real-time PCM/WebSocket inference, with artificial uplink/downlink propagation and seeded jitter; not an actual production WAN measurement",
              "concurrentConnections": args.connections, "simulatedOneWayMs": args.one_way_ms,
              "simulatedJitterMs": args.jitter_ms, "sessions": results,
              "acceptance": {"accuracyAtLeast95EachSession": all(r["groupAccuracy"] >= .95 for r in results),
                             "decisionP95Under1000MsEachSession": all(r["decisionLatency"]["p95Ms"] < 1000 for r in results)}}
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)
    if not all(report["acceptance"].values()):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
