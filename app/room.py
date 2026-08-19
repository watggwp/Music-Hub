"""สถานะห้องฟังเพลง — เซิร์ฟเวอร์เป็นเจ้าของ 'ความจริง' ของตำแหน่งเพลงทั้งหมด

คิวเพลงไหลจากหัวแถว: queue[0] คือเพลงที่กำลังเล่น เล่นจบหรือกดข้ามแล้วเพลงนั้น
จะถูกเอาออกจากคิวไปเลย ไม่มีตัวชี้ index ให้สับสน
"""
from __future__ import annotations

import asyncio
import random
import time
from typing import Any


class Room:
    def __init__(self, code: str) -> None:
        self.code = code
        self.queue: list[dict[str, Any]] = []   # queue[0] = กำลังเล่น
        self.playing = False
        self.open_control = True          # True = ทุกคนคุมได้, False = เฉพาะโฮสต์
        self.volume = 70                  # ระดับเสียงของลำโพง (เครื่องโฮสต์) ทุกคนปรับได้
        self.volume_seq = 0               # นับทุกครั้งที่มีคนสั่งเปลี่ยนเสียง
        self.host_id: str | None = None
        self.clients: dict[str, Any] = {}  # client_id -> WebSocket
        self.names: dict[str, str] = {}
        self.lock = asyncio.Lock()
        self._pos = 0.0                    # ตำแหน่งเพลง (วินาที) ณ เวลา _mark
        self._mark = time.monotonic()

    # ---------- ตำแหน่งเพลง ----------
    def position(self) -> float:
        if self.playing:
            return self._pos + (time.monotonic() - self._mark)
        return self._pos

    def set_position(self, pos: float, playing: bool | None = None) -> None:
        self._pos = max(0.0, float(pos))
        self._mark = time.monotonic()
        if playing is not None:
            self.playing = playing

    def set_volume(self, value: Any) -> None:
        try:
            self.volume = max(0, min(100, int(float(value))))
        except (TypeError, ValueError):
            return
        self.volume_seq += 1

    # ---------- คิวเพลง ----------
    def current(self) -> dict[str, Any] | None:
        return self.queue[0] if self.queue else None

    def _find(self, track_id: str) -> int | None:
        return next((i for i, t in enumerate(self.queue) if t["id"] == track_id), None)

    def add(self, track: dict[str, Any]) -> None:
        was_empty = not self.queue
        self.queue.append(track)
        if was_empty:
            self.set_position(0.0, playing=True)

    def drop_current(self) -> None:
        """เล่นจบ / กดข้าม / เล่นไม่ได้ -> เอาเพลงหัวแถวออกแล้วเริ่มเพลงถัดไป"""
        if self.queue:
            self.queue.pop(0)
        self.set_position(0.0, playing=bool(self.queue))

    def remove(self, track_id: str) -> None:
        pos = self._find(track_id)
        if pos is None:
            return
        self.queue.pop(pos)
        if pos == 0:
            self.set_position(0.0, playing=bool(self.queue))

    def move(self, track_id: str, to: Any) -> None:
        """ย้ายเพลงไปตำแหน่งที่ต้องการ — to=0 คือเล่นเลย, to=1 คือเล่นเป็นเพลงถัดไป"""
        pos = self._find(track_id)
        if pos is None or not self.queue:
            return
        try:
            target = max(0, min(len(self.queue) - 1, int(to)))
        except (TypeError, ValueError):
            return
        if target == pos:
            return
        self.queue.insert(target, self.queue.pop(pos))
        if 0 in (pos, target):
            # เพลงที่กำลังเล่นเปลี่ยนตัว ต้องเริ่มนับเวลาใหม่
            self.set_position(0.0, playing=True)

    def shuffle_rest(self) -> None:
        """สุ่มเฉพาะเพลงที่ยังไม่ได้เล่น ไม่แตะเพลงที่กำลังเล่นอยู่"""
        rest = self.queue[1:]
        random.shuffle(rest)
        self.queue[1:] = rest

    def set_duration(self, video_id: str, seconds: Any) -> None:
        """โฮสต์รายงานความยาวเพลง เพราะเครื่องรีโมทไม่มี player ของตัวเอง"""
        track = self.current()
        if not track or track["videoId"] != video_id:
            return
        try:
            value = float(seconds)
        except (TypeError, ValueError):
            return
        if value > 0:
            track["duration"] = round(value, 1)

    # ---------- สิทธิ์ ----------
    def may_control(self, client_id: str) -> bool:
        return self.open_control or client_id == self.host_id

    def snapshot(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "queue": self.queue,
            "playing": self.playing,
            "position": round(self.position(), 3),
            "openControl": self.open_control,
            "volume": self.volume,
            "volumeSeq": self.volume_seq,
            "hostId": self.host_id,
            "listeners": [
                {"id": cid, "name": self.names.get(cid, "ผู้ฟัง"), "host": cid == self.host_id}
                for cid in self.clients
            ],
        }
