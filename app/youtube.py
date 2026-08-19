"""เครื่องมือฝั่ง YouTube: แยกลิงก์, ตรวจว่าฝังได้ไหม, ค้นหาด้วยชื่อ, อ่าน playlist

ทั้งหมดทำได้โดยไม่ต้องใช้ API key — ตรวจการฝังผ่าน oEmbed (คลิปที่ปิดการฝัง
จะตอบ 401/403) ค้นหาและอ่าน playlist จาก JSON ที่ฝังมาในหน้าเว็บของ YouTube
ถ้าอยากได้ผลที่แม่นกว่านี้ ต้องใช้ YouTube Data API (ดูหัวข้อต่อยอดใน README)
"""
from __future__ import annotations

import asyncio
import html as html_module
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Safari/537.36")

PLAYLIST_LIMIT = 100          # หน้าเว็บ playlist ส่งมาหน้าแรก 100 เพลง
PROBE_WORKERS = 8             # ตรวจหลายคลิปพร้อมกันเท่านี้
SEARCH_LIMIT = 12             # ผลค้นหาที่ส่งกลับหน้าเว็บ
SEARCH_TTL = 300              # เก็บผลค้นหาไว้ใช้ซ้ำกี่วินาที
SEARCH_CACHE_MAX = 60

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_PLAYLIST_ID = re.compile(r"^(?:PL|UU|LL|FL|OLAK)[A-Za-z0-9_-]{10,}$")
_VIDEO_PATTERNS = [
    re.compile(r"(?:youtube\.com|youtube-nocookie\.com)/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"youtube\.com/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})"),
]


# ---------------- แยกลิงก์ ----------------
def parse_target(raw: str) -> dict | None:
    """คืน {"kind": "video"|"playlist", "id": ...}

    ลิงก์ที่มีทั้ง v= และ list= ถือว่าผู้ใช้ต้องการคลิปนั้นคลิปเดียว
    ต้องเป็น /playlist?list=... หรือมีแต่ list= เท่านั้นจึงนับเป็น playlist ทั้งชุด
    """
    text = (raw or "").strip()
    if not text:
        return None

    if _VIDEO_ID.match(text):
        return {"kind": "video", "id": text}
    if _PLAYLIST_ID.match(text):
        return {"kind": "playlist", "id": text}

    for pattern in _VIDEO_PATTERNS:
        found = pattern.search(text)
        if found:
            return {"kind": "video", "id": found.group(1)}

    found = re.search(r"[?&]list=([A-Za-z0-9_-]+)", text)
    if found and _PLAYLIST_ID.match(found.group(1)):
        return {"kind": "playlist", "id": found.group(1)}
    return None


# ---------------- ตรวจคลิปหนึ่งคลิป ----------------
def _probe_sync(video_id: str) -> dict:
    url = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
        {"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"}
    )
    try:
        with urllib.request.urlopen(url, timeout=6) as resp:
            title = json.loads(resp.read().decode("utf-8")).get("title")
        return {"ok": True, "title": title or f"YouTube · {video_id}"}
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return {"ok": False, "reason": "embed"}
        if exc.code in (400, 404):
            return {"ok": False, "reason": "missing"}
        # รหัสอื่น (429, 5xx) ถือว่าตรวจไม่ได้ ไม่ใช่ความผิดของคลิป
        return {"ok": True, "title": f"YouTube · {video_id}", "unverified": True}
    except Exception:
        return {"ok": True, "title": f"YouTube · {video_id}", "unverified": True}


async def probe_video(video_id: str) -> dict:
    """ตรวจว่าคลิปนี้ฝังเล่นได้ไหม พร้อมดึงชื่อคลิปมาในคราวเดียว

    reason "embed"   = เจ้าของปิดการเล่นแบบฝัง
    reason "missing" = ไม่พบคลิป / ถูกลบ / เป็นส่วนตัว
    unverified       = ตรวจไม่สำเร็จ (เน็ตหรือ YouTube ขัดข้อง) แต่ให้ผ่านไปก่อน
    """
    return await asyncio.to_thread(_probe_sync, video_id)


async def probe_many(video_ids: list[str]) -> list[dict]:
    """ตรวจหลายคลิปพร้อมกันแบบจำกัดจำนวนคำขอ ผลลัพธ์เรียงตามลำดับที่ส่งเข้ามา"""
    gate = asyncio.Semaphore(PROBE_WORKERS)

    async def one(video_id: str) -> dict:
        async with gate:
            result = await probe_video(video_id)
        return {"videoId": video_id, **result}

    return await asyncio.gather(*(one(v) for v in video_ids))


# ---------------- ค้นหาด้วยชื่อเพลง ----------------
_search_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _take_object(text: str, start: int) -> str | None:
    """ตัด JSON object ที่วงเล็บสมดุลออกมาจากตำแหน่ง start (ต้องชี้ที่ '{')"""
    depth, in_string, escaped = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _runs_text(node: dict[str, Any]) -> str:
    if not isinstance(node, dict):
        return ""
    if "simpleText" in node:
        return str(node["simpleText"])
    return "".join(str(r.get("text", "")) for r in node.get("runs", []))


def _search_sync(query: str, limit: int) -> list[dict[str, Any]]:
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode(
        {"search_query": query, "hl": "th"}
    )
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Language": "th,en;q=0.9"}
    )
    with urllib.request.urlopen(request, timeout=15) as resp:
        html = resp.read().decode("utf-8", "replace")

    marker = '"videoRenderer":{'
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    pos = 0
    while len(found) < limit:
        pos = html.find(marker, pos)
        if pos < 0:
            break
        blob = _take_object(html, pos + len(marker) - 1)
        pos += len(marker)
        if not blob:
            continue
        try:
            item = json.loads(blob)
        except ValueError:
            continue
        video_id = item.get("videoId")
        title = _runs_text(item.get("title", {}))
        length = _runs_text(item.get("lengthText", {}))
        if not video_id or not title or video_id in seen:
            continue
        if not length:
            continue  # ไม่มีความยาว = ถ่ายทอดสด หรือ Shorts ข้ามไป
        seen.add(video_id)
        found.append(
            {
                "videoId": video_id,
                "title": title,
                "length": length,
                "channel": _runs_text(item.get("ownerText", {})),
            }
        )
    return found


async def search_videos(query: str, limit: int = SEARCH_LIMIT) -> list[dict[str, Any]]:
    key = query.strip().lower()
    cached = _search_cache.get(key)
    if cached and time.monotonic() - cached[0] < SEARCH_TTL:
        return cached[1]
    try:
        results = await asyncio.to_thread(_search_sync, query, limit)
    except Exception:
        return []
    if len(_search_cache) >= SEARCH_CACHE_MAX:
        _search_cache.clear()
    _search_cache[key] = (time.monotonic(), results)
    return results


# ---------------- หาเวอร์ชันอื่นของเพลงเดียวกันที่เล่นได้ ----------------
def _cut_at(text: str, marker: str) -> str:
    """ตัดส่วนหลัง marker ออก แต่ไม่ตัดจนชื่อสั้นเกินไปจนค้นหาไม่เจอ"""
    idx = text.find(marker)
    return text[:idx] if idx > 8 else text


def clean_title(title: str) -> str:
    """เอาส่วนประกอบที่ไม่ใช่ชื่อเพลงออก เพื่อให้ค้นหาเจอเวอร์ชันอื่นได้กว้างขึ้น"""
    text = title
    for marker in ("(", "[", "|", "【", " feat.", " Feat.", " FEAT.", " ft.", " Ft.", " FT."):
        text = _cut_at(text, marker)
    return " ".join(text.split())[:80]


def _watch_title_sync(video_id: str) -> str | None:
    """ดึงชื่อคลิปจากหน้า watch — ใช้กับคลิปที่ปิดการฝัง ซึ่ง oEmbed ไม่ยอมบอกชื่อ"""
    request = urllib.request.Request(
        "https://www.youtube.com/watch?v=" + urllib.parse.quote(video_id),
        headers={"User-Agent": UA, "Accept-Language": "th,en;q=0.9"},
    )
    with urllib.request.urlopen(request, timeout=12) as resp:
        page = resp.read().decode("utf-8", "replace")

    marker = '<meta name="title" content="'
    start = page.find(marker)
    if start >= 0:
        start += len(marker)
        end = page.find('"', start)
        if end > start:
            return html_module.unescape(page[start:end])

    start = page.find("<title>")
    if start >= 0:
        end = page.find("</title>", start)
        if end > start:
            title = html_module.unescape(page[start + 7:end])
            return title[: -len(" - YouTube")] if title.endswith(" - YouTube") else title
    return None


async def watch_title(video_id: str) -> str | None:
    try:
        return await asyncio.to_thread(_watch_title_sync, video_id)
    except Exception:
        return None


async def find_playable_alternatives(
    title: str, exclude_id: str, limit: int = 5
) -> tuple[list[dict[str, Any]], str]:
    """ค้นหาชื่อเพลงเดียวกัน แล้วคัดเฉพาะคลิปที่ตรวจแล้วว่าเล่นได้"""
    query = clean_title(title)
    if len(query) < 2:
        return [], query
    results = await search_videos(query, limit=SEARCH_LIMIT)
    candidates = [r for r in results if r["videoId"] != exclude_id][:8]
    if not candidates:
        return [], query
    probes = await probe_many([r["videoId"] for r in candidates])
    playable = {p["videoId"] for p in probes if p["ok"]}
    return [r for r in candidates if r["videoId"] in playable][:limit], query


# ---------------- อ่าน playlist ----------------
def _playlist_ids_sync(playlist_id: str) -> list[str]:
    request = urllib.request.Request(
        "https://www.youtube.com/playlist?list=" + urllib.parse.quote(playlist_id),
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
    )
    with urllib.request.urlopen(request, timeout=15) as resp:
        html = resp.read().decode("utf-8", "replace")

    # หน้า playlist ปัจจุบันเก็บรายการเป็น lockupViewModel -> contentId
    found = re.findall(
        r'"contentId":"([A-Za-z0-9_-]{11})","contentType":"LOCKUP_CONTENT_TYPE_VIDEO"', html
    )
    if not found:  # เผื่อ YouTube เปลี่ยนโครงสร้างกลับไปใช้ตัวเดิม
        found = re.findall(r'"playlistVideoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"', html)
    return list(dict.fromkeys(found))[:PLAYLIST_LIMIT]


async def playlist_video_ids(playlist_id: str) -> list[str]:
    try:
        return await asyncio.to_thread(_playlist_ids_sync, playlist_id)
    except Exception:
        return []
