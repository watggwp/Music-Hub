"""เครื่องมือฝั่ง YouTube: แยกลิงก์, ตรวจว่าฝังได้ไหม, ค้นหาด้วยชื่อ, อ่าน playlist

ทั้งหมดทำได้โดยไม่ต้องใช้ API key — ตรวจการฝังผ่าน oEmbed (คลิปที่ปิดการฝัง
จะตอบ 401/403) ค้นหาและอ่าน playlist จาก JSON ที่ฝังมาในหน้าเว็บของ YouTube
ถ้าอยากได้ผลที่แม่นกว่านี้ ต้องใช้ YouTube Data API (ดูหัวข้อต่อยอดใน README)
"""
from __future__ import annotations

import asyncio
import html as html_module
import json
import logging
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

log = logging.getLogger("uvicorn.error")

# เหตุผลที่อ่าน playlist ล่าสุดไม่สำเร็จ — เอาไปบอกผู้ใช้และดูใน log ได้ว่า YouTube ตอบอะไรกลับมา
last_playlist_error = ""

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Safari/537.36")

PLAYLIST_LIMIT = 100          # หน้าเว็บ playlist ส่งมาหน้าแรก 100 เพลง
PROBE_WORKERS = 8             # ตรวจหลายคลิปพร้อมกันเท่านี้
SEARCH_LIMIT = 12             # ผลค้นหาที่ส่งกลับหน้าเว็บ
SEARCH_TTL = 300              # เก็บผลค้นหาไว้ใช้ซ้ำกี่วินาที
SEARCH_CACHE_MAX = 60
PLAYLIST_TTL = 1800           # เก็บรายการเพลงใน playlist ไว้ใช้ซ้ำกี่วินาที (Auto DJ อ่าน playlist เดิมบ่อย)
PLAYLIST_CACHE_MAX = 120
AUTO_DJ_PLAYLISTS = 6         # Auto DJ อ่านเพลย์ลิสต์สาธารณะกี่ชุดต่อการหาเพลงหนึ่งครั้ง

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_PLAYLIST_ID = re.compile(r"^(?:PL|RD|OLAK|UU|LL|FL|TL|VL|CL)[A-Za-z0-9_-]{8,}$")
# ลิงก์ที่แชร์จากแอปในไทยมักมี /intl-th/ คั่นอยู่
_SPOTIFY_PATTERN = re.compile(
    r"open\.spotify\.com/(?:intl-[A-Za-z-]+/)?(track|playlist|album)/([A-Za-z0-9]+)"
)
_VIDEO_PATTERNS = [
    re.compile(r"(?:youtube\.com|youtube-nocookie\.com)/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"youtube\.com/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})"),
]


# ---------------- แยกลิงก์ ----------------
def parse_target(raw: str) -> dict | None:
    """คืน {"kind": "video"|"playlist"|"spotify", ...}

    หากลิงก์มีพารามิเตอร์ list=... (รวมถึง YouTube Radio/Mix list=RD...) จะดึงเพลงทั้งชุดให้ทันที
    หากเป็นลิงก์ Spotify จะคืน kind: spotify พร้อม type: track/playlist/album
    """
    text = (raw or "").strip()
    if not text:
        return None

    # ตรวจสอบลิงก์ Spotify
    sm = _SPOTIFY_PATTERN.search(text)
    if sm:
        return {"kind": "spotify", "type": sm.group(1), "id": sm.group(2), "url": text}

    # หากมีพารามิเตอร์ list= ให้ดึงทั้ง playlist / radio mix เป็นอันดับแรก
    found_list = re.search(r"[?&]list=([A-Za-z0-9_-]+)", text)
    if found_list and _PLAYLIST_ID.match(found_list.group(1)):
        return {"kind": "playlist", "id": found_list.group(1)}

    # ต้องเช็ค videoId ก่อน — id 11 ตัวที่บังเอิญขึ้นต้นด้วย PL/RD/UU ฯลฯ จะได้ไม่ถูกเหมาเป็น playlist
    if _VIDEO_ID.match(text):
        return {"kind": "video", "id": text}

    if _PLAYLIST_ID.match(text):
        return {"kind": "playlist", "id": text}

    for pattern in _VIDEO_PATTERNS:
        m = pattern.search(text)
        if m:
            return {"kind": "video", "id": m.group(1)}

    return None


# ---------------- ตรวจคลิปหนึ่งคลิป ----------------
def _probe_sync(video_id: str) -> dict:
    url = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
        {"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"}
    )
    try:
        with urllib.request.urlopen(url, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {"ok": True, "title": data.get("title") or f"YouTube · {video_id}",
                "author": str(data.get("author_name") or "")}
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return {"ok": False, "reason": "embed"}
        if exc.code in (400, 404):
            return {"ok": False, "reason": "missing"}
        # รหัสอื่น (429, 5xx) ถือว่าตรวจไม่ได้ ไม่ใช่ความผิดของคลิป
        return {"ok": True, "title": f"YouTube · {video_id}", "unverified": True}
    except Exception:
        return {"ok": True, "title": f"YouTube · {video_id}", "unverified": True}


_probe_cache: dict[str, tuple[float, dict]] = {}
PROBE_TTL = 3600
PROBE_CACHE_MAX = 500


async def probe_video(video_id: str) -> dict:
    """ตรวจว่าคลิปนี้ฝังเล่นได้ไหม พร้อมดึงชื่อคลิปและชื่อช่องมาในคราวเดียว

    reason "embed"   = เจ้าของปิดการเล่นแบบฝัง
    reason "missing" = ไม่พบคลิป / ถูกลบ / เป็นส่วนตัว
    unverified       = ตรวจไม่สำเร็จ (เน็ตหรือ YouTube ขัดข้อง) แต่ให้ผ่านไปก่อน — ไม่แคชผลแบบนี้

    Auto DJ ถามคลิปเดิมซ้ำบ่อย (seed, เพลงก่อนหน้า, คลิปในเพลย์ลิสต์เดิม) จึงจำผลไว้หนึ่งชั่วโมง
    """
    cached = _probe_cache.get(video_id)
    if cached and time.monotonic() - cached[0] < PROBE_TTL:
        return dict(cached[1])
    result = await asyncio.to_thread(_probe_sync, video_id)
    if not result.get("unverified"):
        if len(_probe_cache) >= PROBE_CACHE_MAX:
            _probe_cache.clear()
        _probe_cache[video_id] = (time.monotonic(), dict(result))
    return result


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


def _search_playlists_sync(query: str, limit: int) -> list[dict[str, Any]]:
    """ค้นหาเฉพาะ 'เพลย์ลิสต์' สาธารณะ (sp=EgIQAw== คือตัวกรองชนิด playlist ของหน้าค้นหา)

    หน้าค้นหารุ่นใหม่ใช้ lockupViewModel รุ่นเก่าใช้ playlistRenderer อ่านทั้งสองแบบ
    """
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode(
        {"search_query": query, "sp": "EgIQAw==", "hl": "th"}
    )
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Language": "th,en;q=0.9"}
    )
    with urllib.request.urlopen(request, timeout=15) as resp:
        html = resp.read().decode("utf-8", "replace")

    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for marker in ('"lockupViewModel":{', '"playlistRenderer":{'):
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
            playlist_id = str(item.get("contentId") or item.get("playlistId") or "")
            if not playlist_id.startswith("PL") or playlist_id in seen:
                continue
            meta = item.get("metadata", {}).get("lockupMetadataViewModel", {})
            title = str(meta.get("title", {}).get("content") or "") or _runs_text(item.get("title", {}))
            seen.add(playlist_id)
            found.append({"playlistId": playlist_id, "title": title})
    return found


async def search_playlists(query: str, limit: int = SEARCH_LIMIT) -> list[dict[str, Any]]:
    key = f"pl:{limit}:{query.strip().lower()}"
    cached = _search_cache.get(key)
    if cached and time.monotonic() - cached[0] < SEARCH_TTL:
        return cached[1]
    try:
        results = await asyncio.to_thread(_search_playlists_sync, query, limit)
    except Exception:
        return []
    if len(_search_cache) >= SEARCH_CACHE_MAX:
        _search_cache.clear()
    _search_cache[key] = (time.monotonic(), results)
    return results


async def search_videos(query: str, limit: int = SEARCH_LIMIT) -> list[dict[str, Any]]:
    key = f"{limit}:{query.strip().lower()}"   # แยกตาม limit ไม่งั้นผลชุดเล็กจะไปค้างแทนชุดใหญ่
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
def _page_reason(final_url: str, html: str) -> str:
    """สรุปสั้น ๆ ว่าหน้าที่ YouTube ส่งกลับมาคืออะไร เมื่อหาเพลงในนั้นไม่เจอ"""
    host = urllib.parse.urlparse(final_url).netloc
    lower = html[:200_000].lower()
    if "consent.youtube.com" in host or "consent.google" in host:
        return f"ถูกส่งไปหน้า consent ({host})"
    if "/sorry/" in final_url or "unusual traffic" in lower or "captcha" in lower:
        return "YouTube ขอยืนยันว่าไม่ใช่บอท"
    if "confirm you" in lower and "not a bot" in lower:
        return "YouTube ขอให้ล็อกอินเพื่อยืนยันว่าไม่ใช่บอท"
    title = ""
    start = lower.find("<title>")
    if start >= 0:
        end = lower.find("</title>", start)
        title = html[start + 7:end][:60] if end > start else ""
    return f"หน้าไม่มีรายการเพลง (host={host}, {len(html)} ตัวอักษร, title={title!r})"


def _playlist_ids_sync(playlist_id: str) -> list[str]:
    global last_playlist_error
    seed = playlist_id[2:] if playlist_id.startswith("RD") and len(playlist_id) > 2 and _VIDEO_ID.match(playlist_id[2:]) else ""
    urls = []
    if seed:
        urls.append(f"https://www.youtube.com/watch?v={seed}&list={urllib.parse.quote(playlist_id)}")
    urls.append(f"https://www.youtube.com/playlist?list={urllib.parse.quote(playlist_id)}")

    reasons: list[str] = []
    for url in urls:
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": UA, "Accept-Language": "th,en-US;q=0.9,en;q=0.8"},
            )
            with urllib.request.urlopen(request, timeout=12) as resp:
                html = resp.read().decode("utf-8", "replace")
                final_url = resp.geturl()

            found = re.findall(r'"videoId":"([A-Za-z0-9_-]{11})"', html)
            if not found:
                found = re.findall(r'"contentId":"([A-Za-z0-9_-]{11})"', html)
            if not found:
                found = re.findall(r'"playlistVideoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"', html)
            if not found:
                found = re.findall(r'/watch\?v=([A-Za-z0-9_-]{11})', html)

            vids = list(dict.fromkeys(found))
            if vids:
                last_playlist_error = ""
                return vids[:PLAYLIST_LIMIT]
            reasons.append(_page_reason(final_url, html))
        except urllib.error.HTTPError as e:
            reasons.append(f"HTTP {e.code}")
        except Exception as e:
            reasons.append(f"{type(e).__name__}: {e}"[:80])

    # ไม่กลืนเงียบ ๆ — Auto DJ พึ่ง Mix เป็นหลัก ถ้าอ่านไม่ได้ต้องเห็นใน log ว่าเพราะอะไร
    last_playlist_error = " / ".join(reasons)
    log.warning("อ่าน playlist %s ไม่ได้: %s", playlist_id, last_playlist_error)
    return []


_playlist_cache: dict[str, tuple[float, list[str]]] = {}


async def playlist_video_ids(playlist_id: str) -> list[str]:
    cached = _playlist_cache.get(playlist_id)
    if cached and time.monotonic() - cached[0] < PLAYLIST_TTL:
        return cached[1]
    try:
        vids = await asyncio.to_thread(_playlist_ids_sync, playlist_id)
    except Exception:
        return []
    if vids:
        if len(_playlist_cache) >= PLAYLIST_CACHE_MAX:
            _playlist_cache.clear()
        _playlist_cache[playlist_id] = (time.monotonic(), vids)
    return vids


# ---------------- Spotify Track & Playlist Extraction ----------------
def _fetch_spotify_sync(spot_type: str, spot_id: str) -> list[str]:
    """ดึงรายชื่อเพลงและศิลปินจาก Spotify embed page โดยไม่ต้องใช้ API key"""
    url = f"https://open.spotify.com/embed/{spot_type}/{spot_id}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept-Language": "th,en-US;q=0.9,en;q=0.8"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            html = res.read().decode("utf-8", "replace")
    except Exception:
        return []

    queries: list[str] = []
    m = re.search(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', html)
    if m:
        try:
            js = json.loads(m.group(1))
            entity = js.get("props", {}).get("pageProps", {}).get("state", {}).get("data", {}).get("entity", {})
            if spot_type == "track":
                title = entity.get("title") or entity.get("name") or ""
                artists = [a.get("name", "") for a in entity.get("artists", [])]
                artist_str = " ".join(filter(None, artists))
                if title:
                    queries.append(f"{title} {artist_str}".strip())
            else:
                # playlist or album
                track_list = entity.get("trackList", [])
                for t in track_list[:PLAYLIST_LIMIT]:
                    title = t.get("title") or ""
                    subtitle = t.get("subtitle") or ""
                    if title:
                        queries.append(f"{title} {subtitle}".strip())
        except Exception:
            pass

    return queries


async def fetch_spotify_tracks(spot_type: str, spot_id: str) -> list[str]:
    try:
        return await asyncio.to_thread(_fetch_spotify_sync, spot_type, spot_id)
    except Exception:
        return []


# \u0e04\u0e33\u0e17\u0e35\u0e48\u0e1a\u0e2d\u0e01\u0e41\u0e04\u0e48 "\u0e23\u0e39\u0e1b\u0e41\u0e1a\u0e1a\u0e04\u0e25\u0e34\u0e1b" \u0e44\u0e21\u0e48\u0e43\u0e0a\u0e48\u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e1e\u0e25\u0e07/\u0e28\u0e34\u0e25\u0e1b\u0e34\u0e19 \u2014 \u0e15\u0e31\u0e14\u0e17\u0e34\u0e49\u0e07\u0e01\u0e48\u0e2d\u0e19\u0e40\u0e17\u0e35\u0e22\u0e1a
_TITLE_NOISE = re.compile(
    r"official|music|video|lyrics?|audio|visuali[sz]er|karaoke|cover|remix|version|ver\.?|"
    r"sped up|slowed|reverb|live|full|topic|prod\.?|feat\.?|ft\.?|\bmv\b|m/v|\bhq\b|\bhd\b|\b4k\b|"
    r"\u0e40\u0e19\u0e37\u0e49\u0e2d\u0e40\u0e1e\u0e25\u0e07|\u0e04\u0e32\u0e23\u0e32\u0e42\u0e2d\u0e40\u0e01\u0e30|\u0e04\u0e2d\u0e23\u0e4c\u0e14", re.I)
# \u0e04\u0e33\u0e17\u0e35\u0e48\u0e1a\u0e2d\u0e01\u0e27\u0e48\u0e32\u0e40\u0e1b\u0e47\u0e19 "\u0e2d\u0e35\u0e01\u0e40\u0e27\u0e2d\u0e23\u0e4c\u0e0a\u0e31\u0e19\u0e02\u0e2d\u0e07\u0e40\u0e1e\u0e25\u0e07\u0e40\u0e14\u0e34\u0e21" \u2014 \u0e40\u0e08\u0e2d\u0e41\u0e25\u0e49\u0e27\u0e41\u0e04\u0e48\u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e1e\u0e25\u0e07\u0e15\u0e23\u0e07\u0e01\u0e31\u0e19\u0e01\u0e47\u0e16\u0e37\u0e2d\u0e40\u0e1b\u0e47\u0e19\u0e40\u0e1e\u0e25\u0e07\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e19
_VERSION_HINT = re.compile(r"cover|remix|karaoke|sped up|slowed|live|acoustic|remaster|version|instrumental|nightcore|lofi|8d|\u0e04\u0e32\u0e23\u0e32\u0e42\u0e2d\u0e40\u0e01\u0e30|\u0e40\u0e27\u0e2d\u0e23\u0e4c\u0e0a\u0e31\u0e19", re.I)
_BRACKET = re.compile(r"[(\[\u3010\uff08\u300c]([^)\]\u3011\uff09\u300d]*)[)\]\u3011\uff09\u300d]")
_SEPARATOR = re.compile(r"\s+[-\u2013\u2014]\s*|\s*[-\u2013\u2014]\s+|[|\uff5c/:,&+]|\s+x\s+|\s+(?:feat|ft)\.?\s+", re.I)


def _title_parts(title: str) -> set[str]:
    """\u0e41\u0e22\u0e01\u0e0a\u0e37\u0e48\u0e2d\u0e04\u0e25\u0e34\u0e1b\u0e40\u0e1b\u0e47\u0e19\u0e2a\u0e48\u0e27\u0e19 \u0e46 (\u0e28\u0e34\u0e25\u0e1b\u0e34\u0e19 / \u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e1e\u0e25\u0e07 / \u0e0a\u0e37\u0e48\u0e2d\u0e43\u0e19\u0e27\u0e07\u0e40\u0e25\u0e47\u0e1a) \u0e17\u0e35\u0e48\u0e15\u0e31\u0e14\u0e04\u0e33\u0e1f\u0e38\u0e48\u0e21\u0e40\u0e1f\u0e37\u0e2d\u0e22\u0e41\u0e25\u0e30\u0e0a\u0e48\u0e2d\u0e07\u0e27\u0e48\u0e32\u0e07\u0e2d\u0e2d\u0e01\u0e41\u0e25\u0e49\u0e27

    \u0e15\u0e31\u0e14\u0e0a\u0e48\u0e2d\u0e07\u0e27\u0e48\u0e32\u0e07\u0e17\u0e34\u0e49\u0e07\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14 \u0e40\u0e1e\u0e23\u0e32\u0e30\u0e40\u0e1e\u0e25\u0e07\u0e44\u0e17\u0e22\u0e40\u0e02\u0e35\u0e22\u0e19\u0e40\u0e27\u0e49\u0e19\u0e27\u0e23\u0e23\u0e04\u0e44\u0e21\u0e48\u0e15\u0e23\u0e07\u0e01\u0e31\u0e19 ("\u0e40\u0e02\u0e35\u0e22\u0e27\u0e40\u0e2b\u0e25\u0e37\u0e2d\u0e07\u0e41\u0e14\u0e07" \u0e01\u0e31\u0e1a "\u0e40\u0e02\u0e35\u0e22\u0e27 \u0e40\u0e2b\u0e25\u0e37\u0e2d\u0e07 \u0e41\u0e14\u0e07")
    \u0e40\u0e01\u0e47\u0e1a\u0e0a\u0e37\u0e48\u0e2d\u0e43\u0e19\u0e27\u0e07\u0e40\u0e25\u0e47\u0e1a\u0e44\u0e27\u0e49\u0e14\u0e49\u0e27\u0e22 \u0e40\u0e1e\u0e23\u0e32\u0e30\u0e21\u0e31\u0e01\u0e40\u0e1b\u0e47\u0e19\u0e0a\u0e37\u0e48\u0e2d\u0e20\u0e32\u0e29\u0e32\u0e2d\u0e31\u0e07\u0e01\u0e24\u0e29\u0e02\u0e2d\u0e07\u0e40\u0e1e\u0e25\u0e07\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e19 \u0e40\u0e0a\u0e48\u0e19 (Get high)
    """
    text = title.lower()
    chunks = _BRACKET.findall(text) + [_BRACKET.sub(" ", text)]
    parts: set[str] = set()
    for chunk in chunks:
        for piece in _SEPARATOR.split(chunk):
            piece = _TITLE_NOISE.sub(" ", piece)
            piece = re.sub(r"[^a-z0-9\u0e00-\u0e7f]+", "", piece)
            if len(piece) >= 2:
                parts.add(piece)
    return parts


def _part_match(part: str, others: set[str]) -> bool:
    return any(part == o or (min(len(part), len(o)) >= 3 and (part in o or o in part))
               for o in others)


def is_too_similar(title_a: str, title_b: str) -> bool:
    """\u0e2a\u0e2d\u0e07\u0e04\u0e25\u0e34\u0e1b\u0e19\u0e35\u0e49\u0e19\u0e48\u0e32\u0e08\u0e30\u0e40\u0e1b\u0e47\u0e19\u0e40\u0e1e\u0e25\u0e07\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e19\u0e44\u0e2b\u0e21 (\u0e04\u0e19\u0e25\u0e30\u0e04\u0e19\u0e2d\u0e31\u0e1b / \u0e04\u0e19\u0e25\u0e30\u0e40\u0e27\u0e2d\u0e23\u0e4c\u0e0a\u0e31\u0e19)

    \u0e16\u0e37\u0e2d\u0e27\u0e48\u0e32\u0e40\u0e1e\u0e25\u0e07\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e19\u0e40\u0e21\u0e37\u0e48\u0e2d\u0e17\u0e38\u0e01\u0e2a\u0e48\u0e27\u0e19\u0e02\u0e2d\u0e07\u0e0a\u0e37\u0e48\u0e2d\u0e1d\u0e31\u0e48\u0e07\u0e2b\u0e19\u0e36\u0e48\u0e07\u0e44\u0e1b\u0e40\u0e08\u0e2d\u0e43\u0e19\u0e2d\u0e35\u0e01\u0e1d\u0e31\u0e48\u0e07
    \u0e40\u0e0a\u0e48\u0e19 "PUN, THE TOYS - \u0e40\u0e02\u0e35\u0e22\u0e27 \u0e40\u0e2b\u0e25\u0e37\u0e2d\u0e07 \u0e41\u0e14\u0e07" \u0e01\u0e31\u0e1a "\u0e40\u0e02\u0e35\u0e22\u0e27\u0e40\u0e2b\u0e25\u0e37\u0e2d\u0e07\u0e41\u0e14\u0e07 (Get high) - PUN"
    \u0e2a\u0e48\u0e27\u0e19\u0e40\u0e1e\u0e25\u0e07\u0e2d\u0e37\u0e48\u0e19\u0e02\u0e2d\u0e07\u0e28\u0e34\u0e25\u0e1b\u0e34\u0e19\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e19 ("PUN - \u0e44\u0e21\u0e48\u0e40\u0e04\u0e22") \u0e08\u0e30\u0e21\u0e35\u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e1e\u0e25\u0e07\u0e17\u0e35\u0e48\u0e44\u0e21\u0e48\u0e15\u0e23\u0e07 \u0e08\u0e36\u0e07\u0e22\u0e31\u0e07\u0e1c\u0e48\u0e32\u0e19\u0e44\u0e14\u0e49
    """
    pa, pb = _title_parts(title_a), _title_parts(title_b)
    if not pa or not pb:
        return False
    if all(_part_match(p, pb) for p in pa) or all(_part_match(p, pa) for p in pb):
        return True
    # cover / remix / live \u0e02\u0e2d\u0e07\u0e40\u0e1e\u0e25\u0e07\u0e40\u0e14\u0e34\u0e21 \u2014 \u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e1e\u0e25\u0e07\u0e15\u0e23\u0e07\u0e01\u0e31\u0e19\u0e2a\u0e48\u0e27\u0e19\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e47\u0e1e\u0e2d
    if _VERSION_HINT.search(title_a) or _VERSION_HINT.search(title_b):
        return any(len(p) >= 4 and _part_match(p, pb) for p in pa)
    return False


_NON_MUSIC_KEYWORDS = {"audiobook", "trailer", "teaser", "interview", "behind the scene", "reaction", "vlog", "podcast",
                       "tutorial", "how to", "review", "unboxing", "gameplay", "ep.", "episode",
                       "(skit)", "skit", "(intro)", "(outro)", "interlude",
                       "รีวิว", "สอน", "ตอนที่", "ข่าว", "นิทาน", "การ์ตูน", "ละคร", "หนัง", "ตัวอย่าง", "เกม",
                       "พิพิธภัณฑ์", "ท่องเที่ยว", "เที่ยว", "ทำอาหาร", "สัมภาษณ์", "เบื้องหลัง", "ไลฟ์สด", "ถ่ายทอดสด",
                       # คลิปรวมเพลงยาว ๆ — Auto DJ ต้องการเพลงเดียว ไม่ใช่เพลย์ลิสต์ในคลิปเดียว
                       "รวมเพลง", "รวมฮิต", "รวมบทเพลง", "playlist", "longplay", "long play", "nonstop", "non-stop",
                       "non stop", "ต่อเนื่อง", "ฟังยาว", "ชุดที่", "full album", "อัลบั้มเต็ม", "medley", "เมดเล่ย์",
                       "ฟังเพลิน", "ฟังสบาย", "เพลงเพราะๆ", "เพลงเพราะ ๆ", "best of", "the best", "very best",
                       "greatest hits", "ชุดพิเศษ", "ชุดเต็ม", "hits collection", "all songs", "ทุกเพลง",
                       # บันทึกการแสดงสด เสียงไม่เหมาะเปิดในออฟฟิศ และมักยาวหลายเพลง
                       "live at", "live in", "concert", "คอนเสิร์ต", "แสดงสด"}

# คลิปเพลงส่วนใหญ่ตั้งชื่อแบบ "ศิลปิน - ชื่อเพลง" หรือมีคำพวก Official / MV / Lyric
# ใช้คัดคลิปที่โผล่ในเพลย์ลิสต์แค่ชุดเดียว (ไม่มีหลักฐานอื่นว่าเป็นเพลง) กันของมั่ว ๆ ในเพลย์ลิสต์ส่วนตัว
_SONG_HINT = re.compile(r" - |–|—|\||:|feat|ft\.|official|mv|m/v|lyric|audio|เพลง|cover|remix|"
                        r"acoustic|live|【|「|『|\[", re.I)


def looks_like_song(title: str) -> bool:
    return bool(_SONG_HINT.search(title or ""))

# ---------------- Auto DJ (ค้นหาเพลงถัดไปอัตโนมัติ) ----------------
_AUTHOR_NOISE = re.compile(r"official|channel|vevo|music|records?|entertainment|- topic|\btopic\b|\s+", re.I)


def _norm_author(name: str) -> str:
    return _AUTHOR_NOISE.sub("", (name or "").lower())


_AUTHOR_SUFFIX = re.compile(r"official|vevo|- topic|topic|channel", re.I)


def author_query(name: str) -> str:
    """ชื่อช่องที่เอาไปค้นหาได้ — "PUNVEVO" / "LABANOON OFFICIAL" / "PUN - Topic" ล้วนควรค้นว่า PUN"""
    return " ".join(_AUTHOR_SUFFIX.sub(" ", name or "").split())


def same_author(a: str, b: str) -> bool:
    """ช่องเดียวกันไหม — ตัดคำว่า Official / VEVO / Topic ออกก่อนเทียบ (PUN OFFICIAL กับ PUN - Topic = คนเดียวกัน)"""
    na, nb = _norm_author(a), _norm_author(b)
    if not na or not nb:
        return False
    return na == nb or (min(len(na), len(nb)) >= 3 and (na in nb or nb in na))


def shares_artist_part(title_a: str, title_b: str) -> bool:
    """ชื่อคลิปสองอันมี 'ส่วน' ร่วมกันไหม (ศิลปิน / วง) — ใช้แทนชื่อช่อง เพราะค่ายไทยอัปหลายศิลปินในช่องเดียว
    และศิลปินเดียวกันกระจายอยู่หลายช่อง (GMM GRAMMY / genie records / ช่องศิลปิน / Topic)

    เพลงเดียวกันถูกกรองด้วย is_too_similar ไปก่อนแล้ว ส่วนที่เหลือร่วมกันจึงมักเป็นชื่อศิลปิน
    """
    pa = {x for x in _title_parts(title_a) if len(x) >= 3}
    pb = {x for x in _title_parts(title_b) if len(x) >= 3}
    return any(_part_match(x, pb) for x in pa)


def artist_parts_of(titles: list[str], seed_author: str = "") -> set[str]:
    """ส่วนของชื่อที่โผล่ในหลายคลิป = ชื่อศิลปิน/วง (ชื่อเพลงโผล่ครั้งเดียว) รวมชื่อช่องของเพลงล่าสุดด้วย"""
    seen: dict[str, int] = {}
    for t in titles:
        for x in _title_parts(t):
            seen[x] = seen.get(x, 0) + 1
    parts = {x for x, n in seen.items() if n >= 2}
    if seed_author:
        a = _norm_author(seed_author)
        if len(a) >= 3:
            parts.add(a)
    return parts


def is_same_song_as_recent(cand_title: str, cand_author: str, avoid_titles: list[str],
                           artist_parts: set[str]) -> bool:
    """คลิปนี้คือเพลงที่เพิ่งเล่น/อยู่ในคิว ที่คนอื่นอัปซ้ำมาในชื่ออื่นไหม

    is_too_similar จับได้เมื่อชื่อ 'ทั้งชุด' ตรงกัน แต่ "อะไรก็ผิด - (Official Audio) | MP Studio" กับ
    "อะไรก็ผิด - ลาบานูน" ตรงกันแค่ส่วนเดียว ส่วนที่ตรงจะเป็นได้ทั้งชื่อเพลงหรือชื่อศิลปิน —
    ถือเป็นศิลปินก็ต่อเมื่อส่วนนั้นเป็นชื่อที่โผล่หลายคลิป หรือตรงกับชื่อช่องของคลิปนั้นเอง ไม่งั้นคือเพลงเดิม
    """
    cand_parts = {x for x in _title_parts(cand_title) if len(x) >= 3}
    if not cand_parts:
        return False
    author = _norm_author(cand_author)
    recent: set[str] = set()
    for t in avoid_titles:
        recent |= _title_parts(t)
    for x in cand_parts:
        if not _part_match(x, recent):
            continue
        if _part_match(x, artist_parts) or (len(author) >= 3 and (x in author or author in x)):
            continue                      # ส่วนนี้คือชื่อศิลปิน ไม่ใช่ชื่อเพลง
        return True
    return False


async def _cooccurrence_candidates(query: str, seed_video_id: str) -> dict[str, int]:
    """เพลงที่คนเอาไปใส่เพลย์ลิสต์ร่วมกับเพลงนี้ นับว่าโผล่กี่เพลย์ลิสต์ (ยิ่งมากยิ่งน่าจะแนวเดียวกัน)

    ใช้แทน YouTube Mix บนเซิร์ฟเวอร์ที่ถูก YouTube บล็อกหน้า watch — หน้าค้นหาและหน้า playlist ยังอ่านได้
    เพลย์ลิสต์เล็กมาก ๆ มักเป็นของส่วนตัวที่ใส่มั่ว ๆ จึงข้ามไป
    """
    playlists = await search_playlists(query, limit=AUTO_DJ_PLAYLISTS * 2)
    if not playlists:
        return {}
    reads = await asyncio.gather(*(playlist_video_ids(p["playlistId"])
                                   for p in playlists[:AUTO_DJ_PLAYLISTS]))
    counts: dict[str, int] = {}
    for vids in reads:
        if len(vids) < 10:
            continue
        for vid in set(vids):
            if vid != seed_video_id:
                counts[vid] = counts.get(vid, 0) + 1
    return counts


def _weighted_order(counts: dict[str, int]) -> list[str]:
    """เพลงที่โผล่หลายเพลย์ลิสต์มาก่อน (น่าเชื่อกว่าว่าเป็นเพลงแนวนี้จริง) ที่เท่ากันสุ่มลำดับ"""
    return sorted(counts, key=lambda v: (-counts[v], random.random()))


async def find_auto_dj_track(seed_video_id: str, current_title: str, exclude_ids: set[str],
                             avoid_titles: list[str] | None = None,
                             mode: str = "genre",
                             fallback_seeds: list[tuple[str, str]] | None = None) -> dict | None:
    """หาเพลงถัดไปให้ Auto DJ — ลองจากเพลงล่าสุดก่อน ถ้าหาไม่ได้ (เพลงหายาก) ถอยไปใช้เพลงก่อนหน้าเป็น seed"""
    seeds = [(seed_video_id, current_title)] + [s for s in (fallback_seeds or [])
                                                 if s[0] != seed_video_id]
    # ศิลปินเดิมโผล่ใน 2 เพลงก่อนหน้า รอบนี้ (โหมดแนวเดียวกัน) ต้องเป็นศิลปินอื่น ไม่งั้นกลายเป็นโหมดศิลปินเดิมไปโดยปริยาย
    prev: list[tuple[str, str]] = []
    if mode != "artist":
        for prev_vid, prev_title in (fallback_seeds or [])[:2]:
            if prev_vid and prev_vid != seed_video_id:
                prev.append((str((await probe_video(prev_vid)).get("author") or ""), prev_title))
    # ชื่อคลิปที่ไม่มีชื่อศิลปิน ("ใจ... กลางเมือง") ค้นเพลย์ลิสต์แล้วได้ของมั่ว ใช้ชื่อเพลงก่อนหน้าที่มีศิลปินค้นแทน
    query_title = next((t for _, t in seeds if len(_title_parts(clean_title(t) or t)) >= 2), current_title)
    # ศิลปินเดิมมา 2 เพลงแล้ว (โหมดแนวเดียวกัน) — เพลย์ลิสต์ของศิลปินนี้มีแต่เพลงเขาเอง
    # ให้ไปค้นจากเพลงก่อนหน้าที่เป็นศิลปินอื่นแทน จะได้กระโดดไปวงอื่นในแนวเดียวกัน
    seed_author = str((await probe_video(seed_video_id)).get("author") or "") if seed_video_id else ""
    if mode != "artist" and any(same_author(a, seed_author) or shares_artist_part(t, current_title) for a, t in prev):
        for _, t in seeds[1:]:
            if not shares_artist_part(t, current_title) and len(_title_parts(clean_title(t) or t)) >= 2:
                query_title = t
                break
    for vid, title in seeds[:3]:
        found = await _find_from_seed(vid, title, exclude_ids, avoid_titles, mode, prev,
                                      query_title if vid == seed_video_id else title)
        if found:
            return found
    return None


async def _find_from_seed(seed_video_id: str, current_title: str, exclude_ids: set[str],
                          avoid_titles: list[str] | None, mode: str,
                          prev: list[tuple[str, str]] | None = None,
                          query_title: str = "") -> dict | None:
    """หาเพลงถัดไปจาก seed หนึ่งเพลง

    mode "genre"  = แนวเดียวกัน: YouTube Mix ของเพลงล่าสุดถ้าอ่านได้ ไม่งั้นใช้เพลย์ลิสต์สาธารณะที่มีเพลงนี้อยู่
                    และพยายามเลี่ยงศิลปินเดิมเพื่อให้หลากหลาย
    mode "artist" = ศิลปินเดิม: เพลย์ลิสต์สาธารณะของศิลปิน แล้วเลือกเฉพาะคลิปจากช่องเดียวกับเพลงล่าสุด

    avoid_titles = ชื่อเพลงที่กำลังเล่น อยู่ในคิว และเพิ่งเล่นไป ต้องไม่ได้เพลงเดียวกันที่คนอื่นอัปซ้ำมา
    เทียบด้วยชื่อ เพราะผลค้นหามักมีเพลงเดิมหลายคลิป (คนละช่อง videoId ไม่ซ้ำกัน)
    ไม่มีการค้นหาด้วยชื่อเพลงตัวเองอีกแล้ว — วิธีนั้นได้แต่เพลงเดิมคนละคลิปกลับมา
    """
    all_exclude = set(exclude_ids)
    if seed_video_id:
        all_exclude.add(seed_video_id)
    avoid = [t for t in [current_title, *(avoid_titles or [])] if t]
    seed_author = ""
    if seed_video_id:
        seed_probe = await probe_video(seed_video_id)
        seed_author = str(seed_probe.get("author") or "")
    artist_parts = artist_parts_of(avoid, seed_author)

    def usable(title: str, trusted: bool = True, author: str = "") -> bool:
        lower = title.lower()
        if any(bad in lower for bad in _NON_MUSIC_KEYWORDS):
            return False
        if not trusted and (not looks_like_song(title) or _VERSION_HINT.search(title)):
            return False   # คลิปที่ไม่มีหลักฐานอื่นว่าเป็นเพลงแนวนี้ ไม่เอา cover / remix / karaoke มาเสี่ยง
        if any(is_too_similar(title, used) for used in avoid):
            return False
        return not is_same_song_as_recent(title, author, avoid, artist_parts)

    def pick(p: dict) -> dict:
        return {"videoId": p["videoId"], "title": p.get("title", "")}

    # ---- แนวเดียวกัน: YouTube Mix ก่อน (ใช้ได้เมื่อรันในวง LAN/บ้าน) ----
    if mode != "artist" and seed_video_id:
        mix_vids = await playlist_video_ids(f"RD{seed_video_id}")
        candidates = [vid for vid in mix_vids if vid not in all_exclude]
        if candidates:
            # หัวแถวของ Mix มักเป็นเพลงเดิมเวอร์ชันอื่น จึงตรวจกว้างหน่อยกันหมดตัวเลือก
            probes = await probe_many(candidates[:20])
            for p in probes:
                if p.get("ok") and usable(p.get("title", ""), author=p.get("author", "")):
                    return pick(p)

    # ---- เพลย์ลิสต์สาธารณะ: หาเพลงที่คนจัดไว้ร่วมกับเพลงนี้ / ของศิลปินนี้ ----
    # ค้นด้วยชื่อคลิป (ชื่อเพลง + ศิลปิน) ทั้งสองโหมด — ชื่อช่องเชื่อไม่ได้ เพราะคลิปที่เล่นอาจเป็นของคนอัปซ้ำ
    # ("แฟนเก่า : ลาบานูน" จากช่อง "ไดโนเศร้า") หรือเป็นค่าย (GMM GRAMMY) ซึ่งอัปหลายศิลปินหลายแนว
    # ชื่อคลิปที่มีแต่ชื่อเพลงล้วน ๆ อย่าง "วันที่พบเธอ" มีหลายศิลปินใช้ ค่อยเติมชื่อช่องช่วยเฉพาะกรณีนั้น
    base = query_title or current_title
    query = clean_title(base) or base
    if seed_author and len(_title_parts(query)) < 2:
        query = f"{query} {author_query(seed_author)}".strip()
    if not query:
        return None
    counts = await _cooccurrence_candidates(query, seed_video_id)
    if not counts and mode == "artist" and seed_author:
        counts = await _cooccurrence_candidates(author_query(seed_author), seed_video_id)
    order = [v for v in _weighted_order(counts) if v not in all_exclude][:40]

    # ชื่อคลิปที่มีชื่อศิลปินอยู่แล้ว ให้ยึดชื่อนั้น — ชื่อช่องเชื่อไม่ได้เมื่อเป็นคลิปอัปซ้ำหรือช่องค่าย
    title_has_artist = len(_title_parts(clean_title(current_title) or current_title)) >= 2

    def same_artist(p: dict) -> bool:
        if shares_artist_part(p.get("title", ""), current_title):
            return True
        if mode == "artist":
            return not title_has_artist and same_author(p.get("author", ""), seed_author)
        return same_author(p.get("author", ""), seed_author)   # แนวเดียวกัน: ช่องเดียวกันก็นับว่าศิลปินเดิม

    # ศิลปินของเพลงนี้เพิ่งเล่นไปใน 2 เพลงก่อนหน้าด้วย -> รอบนี้ต้องเป็นศิลปินอื่น จะได้ไม่วนอยู่กับคนเดียว
    force_other = any(same_author(a, seed_author) or shares_artist_part(t, current_title) for a, t in (prev or []))

    for start in range(0, len(order), 20):
        probes = await probe_many(order[start:start + 20])
        ok = [p for p in probes
              if p.get("ok") and usable(p.get("title", ""), trusted=counts.get(p["videoId"], 0) >= 2,
                                        author=p.get("author", ""))]
        if mode == "artist":
            # ศิลปินเดิม = ช่องเดียวกัน หรือชื่อคลิปมีชื่อศิลปินเดียวกับเพลงที่เพิ่งเล่น
            same = [p for p in ok if same_artist(p)]
            if same:
                return pick(same[0])
            continue
        # แนวเดียวกัน — ลำดับความน่าเชื่อ:
        #   1. ศิลปินอื่นที่โผล่หลายเพลย์ลิสต์ (แนวเดียวกันแน่ และได้ความหลากหลาย)
        #   2. ศิลปินเดิมที่โผล่หลายเพลย์ลิสต์ เว้นแต่เพิ่งเล่นศิลปินเดิมติดกันมาแล้ว
        #   3. ศิลปินอื่นที่โผล่เพลย์ลิสต์เดียว (ผ่านตัวกรองชื่อแบบเพลงแล้ว)
        #   4. ศิลปินเดิมที่เหลือ
        same = [p for p in ok if same_artist(p)]
        other = [p for p in ok if p not in same]
        other_strong = [p for p in other if counts.get(p["videoId"], 0) >= 2]
        same_strong = [p for p in same if counts.get(p["videoId"], 0) >= 2]
        for group in (other_strong, [] if force_other else same_strong, other, [] if force_other else same):
            if group:
                return pick(group[0])
        if force_other and same:
            # ไม่มีศิลปินอื่นเลยในชุดนี้ ดูชุดถัดไปก่อน ถ้าหมดจริง ๆ ค่อยยอมศิลปินเดิม
            if start + 20 >= len(order):
                return pick(same[0])
    return None
