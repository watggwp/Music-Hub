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
        self.auto_dj_busy = False          # กำลังหาเพลงอยู่ กันสั่งซ้อนจนได้เพลงเดียวกันสองรอบ
        self.idle_since: float | None = time.monotonic()  # เวลาที่ห้องเริ่มว่าง (None = มีคนอยู่)
        self.dj_stats: dict[str, dict[str, Any]] = {} # name -> {"songs": count, "duration": seconds}
        self.total_played = 0
        self.volume = 20                  # ระดับเสียงของลำโพง (เครื่องโฮสต์) ทุกคนปรับได้
        self.volume_seq = 0               # นับทุกครั้งที่มีคนสั่งเปลี่ยนเสียง
        self.announcement: dict[str, Any] | None = None  # ประกาศที่กำลังออกอยู่ (None = ไม่มี)
        self.host_id: str | None = None
        self.speaker_mode = "single"      # "single" = ลำโพงเครื่องเดียว, "all" = ทุกเครื่อง, "selected" = บางเครื่อง
        self.speakers: set[str] = set()   # เครื่องที่ถูกเลือกเป็นลำโพง ใช้เฉพาะโหมด "selected"
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

    def drop_current(self, reason: str = "ended") -> None:
        """เล่นจบ / กดข้าม / เล่นไม่ได้ -> เอาเพลงหัวแถวออกแล้วเริ่มเพลงถัดไป

        reason "ended" = เล่นจบเอง ทำตามโหมดวนซ้ำ
        reason "skip"  = กดข้าม โหมดวนเพลงเดียวต้องไม่เริ่มเพลงเดิมซ้ำ ไม่งั้นปุ่มข้ามจะใช้ไม่ได้
        reason "error" = เล่นไม่ได้ เอาออกจากคิวเสมอ ไม่งั้นโหมดวนซ้ำจะพาเพลงเสียวนกลับมาไม่จบ
        """
        if not self.queue:
            self.set_position(0.0, playing=False)
            return

        mode = self.repeat_mode
        if reason == "error" or (reason == "skip" and mode == "one"):
            mode = "off"

        current_track = self.queue[0]
        if reason != "error":
            self._add_history(current_track)   # เพลงที่เล่นไม่ได้ ไม่นับเป็นประวัติ

        if mode == "one":
            self.set_position(0.0, playing=True)
            return
        elif mode == "all":
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

    # ---------- ประกาศ ----------
    def set_announcement(self, ann: dict[str, Any] | None) -> None:
        """ประกาศเก็บไว้ใน state ของห้อง ไม่ใช่ส่งเป็น event ครั้งเดียวจบ

        เพราะเครื่องที่เพิ่งเข้าห้อง หรือเครื่องที่เพิ่งรับช่วงเป็นโฮสต์กลางคัน
        ต้องรู้ว่าตอนนี้กำลังมีประกาศอยู่ ไม่งั้นเพลงจะดังทับเสียงประกาศ
        """
        self.announcement = ann

    def clear_announcement(self, ann_id: str) -> bool:
        """ล้างเฉพาะประกาศตัวที่ระบุ — กันตัวจับเวลาของประกาศเก่าไปล้างประกาศใหม่ทิ้ง"""
        if self.announcement and self.announcement.get("id") == ann_id:
            self.announcement = None
            return True
        return False

    # ---------- ลำโพง ----------
    def speaker_ids(self) -> list[str]:
        """เครื่องที่ต้องเปิดเสียงเพลงตอนนี้ ตามโหมดของห้อง"""
        if self.speaker_mode == "all":
            return list(self.clients)
        if self.speaker_mode == "selected":
            return [cid for cid in self.clients if cid in self.speakers]
        return [self.host_id] if self.host_id in self.clients else []

    def leader_id(self) -> str | None:
        """ลำโพงหลัก — เครื่องเดียวที่มีสิทธิ์รายงานว่าเพลงจบ/เล่นไม่ได้/ยาวเท่าไร

        ถ้าลำโพงทุกเครื่องรายงานกันเอง เพลงจะถูกข้ามซ้อนกันหลายรอบ
        """
        ids = self.speaker_ids()
        if self.host_id in ids:
            return self.host_id
        return ids[0] if ids else None

    def set_speaker_mode(self, mode: Any) -> None:
        if mode not in {"single", "all", "selected"} or mode == self.speaker_mode:
            return
        if mode == "selected":
            # เริ่มจากเครื่องที่เป็นลำโพงอยู่แล้ว เสียงจะได้ไม่หายกะทันหันตอนสลับโหมด
            self.speakers = set(self.speaker_ids())
        self.speaker_mode = str(mode)

    def set_speaker(self, client_id: str, value: Any) -> None:
        if self.speaker_mode != "selected" or client_id not in self.clients:
            return
        if value:
            self.speakers.add(client_id)
        else:
            self.speakers.discard(client_id)

    # ---------- สิทธิ์ ----------
    def may_control(self, client_id: str) -> bool:
        return self.open_control or client_id == self.host_id

    def snapshot(self) -> dict[str, Any]:
        speakers = self.speaker_ids()
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
            "announcement": self.announcement,
            "hostId": self.host_id,
            "speakerMode": self.speaker_mode,
            "speakers": speakers,
            "leaderId": self.leader_id(),
            "listeners": [
                {"id": cid, "name": self.names.get(cid, "ผู้ฟัง"), "host": cid == self.host_id,
                 "speaker": cid in speakers}
                for cid in self.clients
            ],
        }
