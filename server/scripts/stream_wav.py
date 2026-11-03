"""Exercise the real WebSocket API with a mono PCM16 WAV, optionally in real time."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import struct
import time
import wave

from websockets.asyncio.client import connect


async def stream(args) -> None:
    with wave.open(str(args.wav), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("WAV must be mono PCM16; convert with ffmpeg -ac 1 -c:a pcm_s16le")
        rate = source.getframerate()
        pcm = source.readframes(source.getnframes())
    events, timings, completed = [], [], None
    async with connect(args.url, max_size=1024 * 1024) as socket:
        await socket.send(json.dumps({
            "type": "start", "version": 1, "sampleRate": rate,
            "channels": 1, "format": "pcm_s16le", "token": os.getenv("PIANOVAL_TOKEN", ""),
        }))
        ready = json.loads(await socket.recv())
        if ready.get("type") != "ready":
            raise RuntimeError(ready)

        async def receive():
            nonlocal completed
            async for data in socket:
                message = json.loads(data)
                if message["type"] == "notes":
                    events.extend(message["events"])
                    timings.append(message["inferenceMs"])
                elif message["type"] == "error":
                    raise RuntimeError(message)
                elif message["type"] == "complete":
                    completed = message
                    return

        receiver = asyncio.create_task(receive())
        sequence, samples = 0, 0
        count = round(rate * 0.04)
        began = time.perf_counter()
        for offset in range(0, len(pcm), count * 2):
            chunk = pcm[offset:offset + count * 2]
            await socket.send(struct.pack("<IQ", sequence, samples) + chunk)
            sequence += 1
            samples += len(chunk) // 2
            if args.realtime:
                await asyncio.sleep(max(0.0, samples / rate - (time.perf_counter() - began)))
        await socket.send(json.dumps({"type": "stop", "packets": sequence, "samples": samples}))
        try:
            await asyncio.wait_for(receiver, timeout=args.timeout)
        finally:
            if not receiver.done():
                receiver.cancel()
        if completed is None:
            raise RuntimeError("Connection closed before completion")
    report = {
        "model": ready["model"], "complete": completed, "events": events,
        "windowInferenceMs": timings, "wallSeconds": round(time.perf_counter() - began, 3),
        "realtimeInput": args.realtime,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"complete": completed, "firstEvents": events[:12], "windowInferenceMs": timings}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--url", default="ws://127.0.0.1:8765/ws/transcribe")
    parser.add_argument("--realtime", action="store_true")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--output", type=Path)
    asyncio.run(stream(parser.parse_args()))
