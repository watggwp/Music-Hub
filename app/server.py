"""SynTech Music — ระบบเปิดเพลงพร้อมกัน เสียงออกที่เครื่องโฮสต์ เครื่องอื่นเป็นรีโมท"""
from __future__ import annotations

import asyncio
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .room import Room
from .youtube import (fetch_spotify_tracks, find_auto_dj_track,
                      find_playable_alternatives, parse_target, playlist_video_ids,
                      probe_many, probe_video, search_videos, watch_title)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

def _quiet_connection_reset(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    """กลืน ConnectionResetError ที่ asyncio บน Windows พ่นออกมาเป็น traceback

    เกิดเมื่อไคลเอนต์ตัดการเชื่อมต่อแบบห้วน ๆ (ปิดแท็บ, มือถือดับหน้าจอ, Wi-Fi หลุด)
    แล้ว proactor transport สั่ง shutdown() บน socket ที่ถูกรีเซ็ตไปแล้ว
    ไม่กระทบการทำงาน แต่รบกวนสายตาจน error จริงกลืนหายไปในกอง
    """
    if isinstance(context.get("exception"), ConnectionResetError):
        return
    loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_: FastAPI):
    asyncio.get_running_loop().set_exception_handler(_quiet_connection_reset)
    yield


app = FastAPI(title="SynTech Music", lifespan=lifespan)
rooms: dict[str, Room] = {}
rooms_lock = asyncio.Lock()

CONTROL_ACTIONS = {"play", "pause", "seek", "next", "add", "remove", "move",
                   "shuffle", "setVolume", "clearQueue", "setRepeatMode", "setAutoDj"}


def now_ms() -> int:
    return int(time.time() * 1000)


def new_room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(5))


async def get_room(code: str) -> Room:
    code = code.upper()
    async with rooms_lock:
        room = rooms.get(code)
        if room is None:
            room = Room(code)
            rooms[code] = room
        return room


async def broadcast(room: Room) -> None:
    payload = {"type": "state", "ts": now_ms(), "room": room.snapshot()}
    dead: list[str] = []
    for client_id, socket in list(room.clients.items()):
        try:
            await socket.send_json(payload)
        except Exception:
            dead.append(client_id)
    for client_id in dead:
        room.clients.pop(client_id, None)
        room.names.pop(client_id, None)


async def push_all(room: Room, payload: dict[str, Any]) -> None:
    for socket in list(room.clients.values()):
        try:
            await socket.send_json(payload)
        except Exception:
            pass


async def notify(room: Room, message: str) -> None:
    """บอกทุกเครื่องในห้องว่าเกิดอะไรขึ้น (เช่น ข้ามเพลงที่เล่นไม่ได้)"""
    await push_all(room, {"type": "notice", "message": message})


async def offer_alternatives(room: Room, title: str, video_id: str,
                             socket: WebSocket | None = None) -> None:
    """คลิปนี้ฝังไม่ได้ -> หาเวอร์ชันอื่นของเพลงเดียวกันที่เล่นได้มาเสนอ"""
    alternatives, query = await find_playable_alternatives(title, video_id)
    if not alternatives:
        return
    payload = {"type": "altResults", "query": query, "blockedTitle": title,
               "results": alternatives}
    if socket is not None:
        await socket.send_json(payload)
    else:
        await push_all(room, payload)


# ---------------- HTTP ----------------
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/new-room")
async def api_new_room() -> JSONResponse:
    async with rooms_lock:
        code = new_room_code()
        while code in rooms:
            code = new_room_code()
        rooms[code] = Room(code)
    return JSONResponse({"code": code})


@app.get("/api/rooms")
async def api_rooms() -> JSONResponse:
    items = []
    async with rooms_lock:
        room_list = list(rooms.values())
    for room in room_list:
        async with room.lock:
            if not room.clients and not room.queue:
                continue  # ห้องที่เพิ่งสร้างแต่ยังไม่มีใครเข้า ไม่ต้องโชว์
            track = room.current()
            items.append(
                {
                    "code": room.code,
                    "listeners": len(room.clients),
                    "queueLength": len(room.queue),
                    "playing": room.playing,
                    "nowPlaying": track["title"] if track else None,
                    "hostName": room.names.get(room.host_id) if room.host_id else None,
                }
            )
    items.sort(key=lambda r: (-r["listeners"], r["code"]))
    return JSONResponse({"rooms": items})


@app.get("/api/search")
async def api_search(q: str = "") -> JSONResponse:
    """ค้นหาเพลงด้วยชื่อ — อ่านผลจากหน้าค้นหาของ YouTube ไม่ต้องใช้ API key"""
    query = q.strip()
    if len(query) < 2:
        return JSONResponse({"results": [], "message": "พิมพ์ชื่อเพลงอย่างน้อย 2 ตัวอักษร"})
    results = await search_videos(query)
    message = "" if results else "ไม่พบผลค้นหา (หรือ YouTube ไม่ตอบ ลองอีกครั้ง)"
    return JSONResponse({"results": results, "message": message})


# ---------------- WebSocket ----------------
@app.websocket("/ws/{code}")
async def websocket_endpoint(socket: WebSocket, code: str) -> None:
    await socket.accept()
    room = await get_room(code)
    client_id = secrets.token_hex(6)

    async with room.lock:
        room.clients[client_id] = socket
        room.names[client_id] = "ผู้ฟัง"
        if room.host_id is None or room.host_id not in room.clients:
            room.host_id = client_id

    await socket.send_json({"type": "welcome", "clientId": client_id, "ts": now_ms()})
    await broadcast(room)

    try:
        while True:
            message = await socket.receive_json()
            await handle(room, client_id, message, socket)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with room.lock:
            room.clients.pop(client_id, None)
            room.names.pop(client_id, None)
            if room.host_id == client_id:
                room.host_id = next(iter(room.clients), None)
        if room.clients:
            await broadcast(room)
        else:
            async with rooms_lock:
                # ห้องว่างแล้ว แต่เก็บคิวไว้ให้กลับเข้ามาต่อได้ ถ้าไม่มีเพลงก็ลบทิ้ง
                if not room.queue:
                    rooms.pop(room.code, None)


def make_track(video_id: str, title: str, added_by: str) -> dict[str, Any]:
    return {
        "id": secrets.token_hex(4),
        "videoId": video_id,
        "title": title,
        "addedBy": added_by,
        "duration": None,
    }


async def maybe_trigger_auto_dj(room: Room) -> None:
    """เมื่อ Auto DJ เปิดอยู่ และคิวเหลือ <= 1 เพลง จะหาเพลงถัดไปมาต่อคิวให้อัตโนมัติ"""
    if not room.auto_dj:
        return
    if len(room.queue) > 1:
        return

    seed_vid = ""
    seed_title = ""
    if room.queue:
        seed_vid = room.queue[-1].get("videoId", "")
        seed_title = room.queue[-1].get("title", "")
    elif room.history:
        seed_vid = room.history[0].get("videoId", "")
        seed_title = room.history[0].get("title", "")

    if not seed_title and not seed_vid:
        return

    exclude_ids = {t["videoId"] for t in room.queue} | {
        t.get("videoId") for t in room.history if t.get("videoId")
    }
    next_track = await find_auto_dj_track(seed_vid, seed_title, exclude_ids)
    if next_track:
        async with room.lock:
            if len(room.queue) <= 1:
                room.add(make_track(next_track["videoId"], next_track["title"], "🤖 Auto DJ"))
        await broadcast(room)
        await notify(room, f"🤖 Auto DJ เล่นต่อ: “{next_track['title']}”")


async def handle_add(room: Room, client_id: str, message: dict[str, Any],
                     socket: WebSocket) -> None:
    raw = str(message.get("url") or "")
    force = bool(message.get("force"))
    target = parse_target(raw)
    who = room.names.get(client_id, "ผู้ฟัง")

    if target is None:
        await socket.send_json({"type": "error", "message": "ลิงก์ YouTube หรือ Spotify ไม่ถูกต้อง"})
        return

    # ---------- นำเข้าจาก Spotify ----------
    if target["kind"] == "spotify":
        spot_type = target.get("type", "track")
        spot_id = target.get("id", "")
        queries = await fetch_spotify_tracks(spot_type, spot_id)
        if not queries:
            await socket.send_json(
                {"type": "error", "message": "อ่านข้อมูลจาก Spotify ไม่สำเร็จ (อาจเป็นเพลย์ลิสต์ส่วนตัว)"}
            )
            return

        if spot_type == "track":
            query = queries[0]
            results = await search_videos(query, limit=5)
            added_track = None
            for item in results:
                p = await probe_video(item["videoId"])
                if p.get("ok"):
                    added_track = item
                    break
            if not added_track:
                await socket.send_json(
                    {"type": "error", "message": f"ไม่พบเพลง “{query}” บน YouTube ที่เล่นแบบฝังได้"}
                )
                return
            async with room.lock:
                room.add(make_track(added_track["videoId"], added_track["title"], who))
            await broadcast(room)
            await notify(room, f"นำเข้าเพลง “{added_track['title']}” จาก Spotify แล้ว")
            return
        else:
            # playlist หรือ album
            await socket.send_json(
                {"type": "notice", "message": f"กำลังค้นหาและนำเข้า {len(queries)} เพลงจาก Spotify..."}
            )
            sem = asyncio.Semaphore(5)

            async def resolve_one(q: str):
                async with sem:
                    try:
                        res = await search_videos(q, limit=3)
                        for item in res:
                            p = await probe_video(item["videoId"])
                            if p.get("ok"):
                                return item
                    except Exception:
                        pass
                    return None

            tasks = [resolve_one(q) for q in queries]
            resolved = await asyncio.gather(*tasks)
            valid_tracks = [t for t in resolved if t is not None]

            if not valid_tracks:
                await socket.send_json(
                    {"type": "error", "message": "ไม่สามารถแปลงเพลงจาก Spotify เพลย์ลิสต์นี้ได้"}
                )
                return

            async with room.lock:
                for item in valid_tracks:
                    room.add(make_track(item["videoId"], item["title"], who))
            await broadcast(room)
            await notify(room, f"นำเข้า {len(valid_tracks)}/{len(queries)} เพลงจาก Spotify สำเร็จ")
            return

    # ---------- playlist ทั้งชุด ----------
    if target["kind"] == "playlist":
        video_ids = await playlist_video_ids(target["id"])
        if not video_ids:
            await socket.send_json(
                {"type": "error", "message": "อ่าน playlist นี้ไม่ได้ (อาจเป็นส่วนตัวหรือว่างเปล่า)"}
            )
            return
        results = await probe_many(video_ids)
        added = [r for r in results if r["ok"]]
        blocked = [r for r in results if not r["ok"] and r.get("reason") == "embed"]
        missing = [r for r in results if not r["ok"] and r.get("reason") == "missing"]

        async with room.lock:
            for item in added:
                room.add(make_track(item["videoId"], item["title"], who))

        parts = [f"เพิ่ม {len(added)} เพลงจาก playlist"]
        if blocked:
            parts.append(f"ข้าม {len(blocked)} เพลงที่เจ้าของปิดการฝัง")
        if missing:
            parts.append(f"ข้าม {len(missing)} เพลงที่หาไม่เจอ")
        if len(video_ids) >= 100:
            parts.append("(อ่านได้สูงสุด 100 เพลงแรก)")
        await broadcast(room)
        await notify(room, " · ".join(parts))
        return

    # ---------- คลิปเดียว ----------
    video_id = target["id"]
    result = {"ok": True, "title": f"YouTube · {video_id}"} if force else await probe_video(video_id)

    if not result["ok"]:
        if result.get("reason") == "embed":
            await socket.send_json(
                {
                    "type": "addRejected",
                    "url": raw,
                    "message": "เจ้าของคลิปนี้ปิดการเล่นแบบฝัง เล่นในเว็บนี้ไม่ได้ "
                               "— กำลังหาเวอร์ชันอื่นของเพลงเดียวกันที่เล่นได้…",
                }
            )
            blocked_title = await watch_title(video_id)
            if blocked_title:
                await offer_alternatives(room, blocked_title, video_id, socket)
        else:
            await socket.send_json(
                {"type": "error", "message": "ไม่พบคลิปนี้ (อาจถูกลบ เป็นส่วนตัว หรือลิงก์ผิด)"}
            )
        return

    async with room.lock:
        room.add(make_track(video_id, result["title"], who))
    await broadcast(room)
    if result.get("unverified"):
        await notify(room, "ตรวจคลิปนี้ล่วงหน้าไม่สำเร็จ ถ้าเล่นไม่ได้ระบบจะข้ามให้เอง")


async def handle(room: Room, client_id: str, message: dict[str, Any],
                 socket: WebSocket) -> None:
    kind = message.get("type")

    if kind == "ping":
        await socket.send_json({"type": "pong", "t0": message.get("t0"), "ts": now_ms()})
        return

    if kind == "hello":
        name = str(message.get("name") or "").strip()[:24]
        async with room.lock:
            room.names[client_id] = name or "ผู้ฟัง"
        await broadcast(room)
        return

    if kind == "claimHost":
        # ย้ายบทบาทลำโพงมาที่เครื่องนี้ (เครื่องเดิมจะกลายเป็นรีโมททันที)
        async with room.lock:
            room.host_id = client_id
        await broadcast(room)
        return

    # ---- ข้อความที่รับจากเครื่องโฮสต์เท่านั้น ----
    if kind in {"ended", "trackError", "duration"}:
        if client_id != room.host_id:
            return
        video_id = str(message.get("videoId") or "")

        if kind == "duration":
            async with room.lock:
                room.set_duration(video_id, message.get("seconds"))
            await broadcast(room)
            return

        # ended / trackError — เทียบ videoId กันสั่งข้ามซ้อนตอนเปลี่ยนเพลงพอดี
        async with room.lock:
            track = room.current()
            if not track or track["videoId"] != video_id:
                return
            title = track["title"]
            room.drop_current()
        await broadcast(room)
        if kind == "trackError":
            await notify(room, f"เล่น “{title}” ไม่ได้ (เจ้าของคลิปปิดการฝังหรือถูกจำกัด) — เอาออกจากคิวแล้ว")
            await offer_alternatives(room, title, video_id)
        if room.auto_dj and len(room.queue) <= 1:
            asyncio.create_task(maybe_trigger_auto_dj(room))
        return

    if kind == "setOpenControl":
        if client_id != room.host_id:
            return
        async with room.lock:
            room.open_control = bool(message.get("value"))
        await broadcast(room)
        return

    if kind not in CONTROL_ACTIONS:
        return

    if not room.may_control(client_id):
        await socket.send_json({"type": "error", "message": "ห้องนี้ให้เฉพาะโฮสต์ควบคุมอยู่"})
        return

    if kind == "add":
        await handle_add(room, client_id, message, socket)
        return

    async with room.lock:
        if kind == "play":
            if room.queue:
                room.set_position(room.position(), playing=True)
            elif room.auto_dj and room.history:
                asyncio.create_task(maybe_trigger_auto_dj(room))
        elif kind == "pause":
            room.set_position(room.position(), playing=False)
        elif kind == "seek":
            try:
                room.set_position(float(message.get("position", 0.0)))
            except (TypeError, ValueError):
                return
        elif kind == "next":
            room.drop_current()
        elif kind == "move":
            room.move(str(message.get("id") or ""), message.get("to"))
        elif kind == "remove":
            room.remove(str(message.get("id") or ""))
        elif kind == "setVolume":
            room.set_volume(message.get("value"))
        elif kind == "shuffle":
            room.shuffle_rest()
        elif kind == "setRepeatMode":
            room.set_repeat_mode(message.get("mode"))
        elif kind == "setAutoDj":
            room.set_auto_dj(message.get("value"))
        elif kind == "clearQueue":
            room.clear_queue()

    await broadcast(room)
    if kind in {"next", "remove", "setAutoDj"} and room.auto_dj and len(room.queue) <= 1:
        asyncio.create_task(maybe_trigger_auto_dj(room))

    if kind == "clearQueue":
        who = room.names.get(client_id, "ผู้ฟัง")
        await notify(room, f"“{who}” ได้ล้างคิวเพลงทั้งหมดแล้ว")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
