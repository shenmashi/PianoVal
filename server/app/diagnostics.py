"""Write bounded, structured timing traces without blocking PCM ingestion."""

import asyncio
import json
import logging
import time

logger = logging.getLogger("pianoval")


class SessionTrace:
    def __init__(self, root, session_id):
        self.path = root / "latency-runs" / (session_id.replace("-", "") + ".jsonl")
        self.queue = asyncio.Queue(maxsize=2048)
        self.dropped = 0
        self.error = None
        self.task = asyncio.create_task(self._write())

    def record(self, kind, **fields):
        try:
            self.queue.put_nowait({"kind": kind, "serverUnixMs": round(time.time() * 1000, 3), **fields})
        except asyncio.QueueFull:
            self.dropped += 1

    def _append(self, entries):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as output:
            for entry in entries:
                output.write(json.dumps(entry, allow_nan=False, ensure_ascii=False) + "\n")

    async def _write(self):
        while True:
            first = await self.queue.get()
            if first is None:
                return
            batch = [first]
            closing = False
            while not self.queue.empty() and len(batch) < 100:
                entry = self.queue.get_nowait()
                if entry is None:
                    closing = True
                    break
                batch.append(entry)
            try:
                await asyncio.to_thread(self._append, batch)
            except (OSError, ValueError) as error:
                if self.error is None:
                    logger.exception("Unable to write latency trace %s", self.path.name)
                self.error = str(error)
                self.dropped += len(batch)
            if closing:
                return

    async def close(self):
        if not self.task.done():
            await self.queue.put(None)
        await self.task


def client_timing(control):
    """Only accept numeric diagnostic fields; never persist arbitrary controls."""
    allowed = {"windowId", "receivedAtUnixMs", "audioAtReceiptSeconds", "analysisLagMs",
               "handlerMs", "rttMs", "rttSampleId", "sentPackets", "sentSamples",
               "browserBufferedBytes", "lastPacketSequence", "lastPacketSentAtUnixMs",
               "lastPacketAudioEndSeconds", "captureToSendMs", "lastDecisionLatencyMs",
               "renderScheduledMs", "decisionCount", "receivedAtPerformanceMs"}
    fields = {}
    for key in allowed:
        value = control.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) < 1e15:
            fields[key] = value
    return fields
