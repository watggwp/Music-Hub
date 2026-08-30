"""สถานะห้องฟังเพลง — เซิร์ฟเวอร์เป็นเจ้าของ 'ความจริง' ของตำแหน่งเพลงทั้งหมด

คิวเพลงไหลจากหัวแถว: queue[0] คือเพลงที่กำลังเล่น เล่นจบหรือกดข้ามแล้วเพลงนั้น
จะถูกเอาออกจากคิวไปเลย ไม่มีตัวชี้ index ให้สับสน
"""
from __future__ import annotations

import asyncio
import random
import secrets
import time
from typing import Any


class Room:
    def __init__(self, code: str) -> None:
        self.code = code
        self.queue: list[dict[str, Any]] = []   # queue[0] = กำลังเล่น
        self.history: list[dict[str, Any]] = [] # ประวัติเพลงที่เล่นจบไปแล้ว
        self.repeat_mode = "off"          # "off", "all", "one"
        self.playing = False
        self.open_control = True          # True = ทุกคนคุมได้, False = เฉพาะโฮสต์
        self.auto_dj = False               # True = ดึงเพลงต่ออัตโนมัติเมื่อคิวหมด
        self.dj_stats: dict[str, dict[str, Any]] = {} # name -> {"songs": count, "duration": seconds}
        self.total_played = 0
        self.volume = 20                  # ระดับเสียงของลำโพง (เครื่องโฮสต์) ทุกคนปรับได้
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

    def set_position(self, pos: Any, playing: bool | None = None) -> None:
        try:
            self._pos = max(0.0, float(pos))
            self._mark = time.monotonic()
        except (TypeError, ValueError):
            pass
        if playing is not None:
            self.playing = playing

    def set_volume(self, value: Any) -> None:
        try:
            self.volume = max(0, min(100, int(float(value))))
        except (TypeError, ValueError):
            return
        self.volume_seq += 1

    def set_auto_dj(self, value: Any) -> None:
        self.auto_dj = bool(value)

    # ---------- คิวเพลง ----------
    def current(self) -> dict[str, Any] | None:
        return self.queue[0] if self.queue else None

    def _find(self, track_id: str) -> int | None:
        return next((i for i, t in enumerate(self.queue) if t["id"] == track_id), None)

    def _add_history(self, track: dict[str, Any]) -> None:
        self.total_played += 1
        by = track.get("addedBy", "นิรนาม")
        dur = float(track.get("duration") or 0.0)
        if by in self.dj_stats:
            self.dj_stats[by]["duration"] = round(self.dj_stats[by].get("duration", 0.0) + dur, 1)

        if not self.history or self.history[0].get("videoId") != track.get("videoId"):
            item = dict(track)
            item["id"] = secrets.token_hex(4)
            self.history.insert(0, item)
            if len(self.history) > 20:
                self.history.pop()

    def add(self, track: dict[str, Any]) -> None:
        was_empty = not self.queue
        by = track.get("addedBy", "นิรนาม")
        if by not in self.dj_stats:
            self.dj_stats[by] = {"songs": 0, "duration": 0.0}
        self.dj_stats[by]["songs"] += 1

        self.queue.append(track)
        if was_empty:
            self.set_position(0.0, playing=True)

    def drop_current(self) -> None:
        """เล่นจบ / กดข้าม / เล่นไม่ได้ -> เอาเพลงหัวแถวออกแล้วเริ่มเพลงถัดไป"""
        if not self.queue:
            self.set_position(0.0, playing=False)
            return

        current_track = self.queue[0]
        self._add_history(current_track)

        if self.repeat_mode == "one":
            self.set_position(0.0, playing=True)
            return
        elif self.repeat_mode == "all":
            finished = self.queue.pop(0)
            self.queue.append(finished)
            self.set_position(0.0, playing=True)
            return
        else:
            self.queue.pop(0)
            self.set_position(0.0, playing=bool(self.queue))

    def remove(self, track_id: str) -> None:
        pos = self._find(track_id)
        if pos is None:
            return
        track = self.queue.pop(pos)
        if pos == 0:
            self._add_history(track)
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

    def clear_queue(self) -> None:
        """ล้างคิวเพลงทั้งหมดในห้อง"""
        if self.queue:
            self._add_history(self.queue[0])
        self.queue.clear()
        self.set_position(0.0, playing=False)

    def set_repeat_mode(self, mode: Any) -> None:
        if mode in {"off", "all", "one"}:
            self.repeat_mode = str(mode)

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
            "history": self.history[:15],
            "repeatMode": self.repeat_mode,
            "playing": self.playing,
            "position": round(self.position(), 3),
            "openControl": self.open_control,
            "autoDj": self.auto_dj,
            "djStats": self.dj_stats,
            "totalPlayed": self.total_played,
            "volume": self.volume,
            "volumeSeq": self.volume_seq,
            "hostId": self.host_id,
            "listeners": [
                {"id": cid, "name": self.names.get(cid, "ผู้ฟัง"), "host": cid == self.host_id}
                for cid in self.clients
            ],
        }
