#!/usr/bin/env python3
"""Static host for the harness bundle, plus a fake Stash GraphQL endpoint.

Threading, not the plain handler: the `slow` sceneUpdate mode sleeps while
holding the request, and a single-threaded server would block the page's
other fetches behind it.
"""
import base64
import json
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

OUT_DIR = sys.argv[1]
PORT = int(sys.argv[2])

# Behaviour flipped by POST /mode.
#   save / sceneAddPlay  "fail"  → the write returns a GraphQL error
#   resume               number  → resume_time the per-open findScene reports
#   findSceneState       "fail"  → that per-open read errors
#   oSeed                number  → o-counter start, also clearing the call log
MODE = {
    "sceneUpdate": "ok", "findScenes": "ok", "markerCreate": "ok", "recentTags": "ok",
    "save": "ok", "sceneAddPlay": "ok", "sceneResetActivity": "ok",
    # sceneAddO: "slow-first" holds the first reply 1.2 s after the increment,
    # so two rapid presses answer out of order (stale 1 last).
    "sceneAddO": "ok",
    # findPerformer: "sparse" empties optional fields; "length-only" clears the
    # career bounds but keeps career_length; "slow"/"fail" delay.
    "performerDetail": "ok", "resume": 0, "oSeed": 0,
    # performerUpdate: "slow" exposes the optimistic value; "fail" is rollback.
    "performerUpdate": "ok",
    # findImage: "slow" keeps the loading state on screen; "fail" is its error.
    "imageInfo": "ok",
    # Gallery-filtered findImages: "empty" (the default) serves no rows, so
    # "still filtered" is visible to S6; "populate" serves the gallery's own
    # short set for the slideshow.
    "galleryImages": "empty",
    # stopJob: "slow" holds the button in flight, "fail" is transport error,
    # "false" is the server refusing (StopJob returns Boolean!).
    "stopJob": "ok",
    # "ok" serves playable bytes at /scene/{n}/preview; "missing" 404s them, as
    # the real server does for scenes whose previews were never generated.
    "preview": "ok",
    # sceneStreams: "ok" advertises the eight real endpoints, "empty" is
    # transcoding switched off (the player must fail visibly, not spin), "slow"
    # leaves src null while the user can press play.
    "streams": "ok",
    # markers: "paged" serves a 100-row listing; the default is the Markers
    # tab's two rows (see findSceneMarkers).
    "markers": "ok",
    # stats / serverStatus: "slow" and "fail" expose the loading and error
    # states; "migrated" gives the status panel a different answer on Refresh.
    "stats": "ok", "serverStatus": "ok",
    # sceneMarkers: "empty" strips the detail page's marker row.
    "sceneMarkers": "ok",
}
LOCK = threading.Lock()

# Screenshot support: Firefox's --screenshot captures on the load event, so the
# index carries a hidden /hold.png that blocks until the driver says the screen
# is ready. The timeout lets a crashed driver's shot through rather than hang.
SHOT_READY = threading.Event()
# A 1x1 transparent PNG — the hold image is display:none; only its load matters.
_BLANK_PNG = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    b"YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

# Every findScenes call, in order — `/requests`. The paging contract is which
# pages were asked for with what; a row count cannot tell "page 2 twice".
REQUESTS = []

# First request time for each /hang/ source, in epoch ms — `/hanghits`. The 4 s
# stall watchdog is measured from the request, not from a driver's remount.
HANG_HITS = []

# Every GraphQL operation by name, in order — `/graphqlcalls`. Separate from
# REQUESTS: it answers "did anything get asked at all" for the first-run gate,
# without enumerating operations (the forgotten one would be the one that fired).
GRAPHQL_CALLS = []
OP_RE = re.compile(r"\b(?:query|mutation)\s+(\w+)")

# Every sceneSaveActivity call — `{id, resume_time}`. The one write that can
# corrupt the library, so the contract is which scene got which position.
SAVES = []

# The saved-filter store, one list per FilterMode, plus every write. It starts
# empty so D-pad-only drivers see an empty dropdown. `object_filter` is echoed
# verbatim, because normalising would hide the corruption the check catches.
SAVED_FILTERS = {}
FILTER_WRITES = []


# Every sceneAddPlay call — `{id, times}`. The contract is a count of requests:
# firing on every buffer stall, resume or 30 s save still leaves a plausible
# play_count, so only the log tells exactly-once from once-per-event.
PLAY_ADDS = []

# Every sceneResetActivity call — `{id, reset_resume, reset_duration}`.
# "Clear progress" must reset the resume point and only that: sending
# `reset_duration: true` would erase watch time while looking identical.
ACTIVITY_RESETS = []

# Ids whose resume point a successful reset erased. The detail query reads this,
# as Stash would: the page refetches after App patches the card it came from, and
# an answer that still says 1800 un-mutes the button the user just pressed.
CLEARED_RESUME = set()

# ── The o-counter ────────────────────────────────────────────
#
# It has to remember: a tally (0 → 1 → 2) is distinguishable from a toggle only
# by the sequence. `oSeed` gives a starting value and lets the server disagree
# with the page, keeping "the number on screen came from the response" visible.
O_COUNT = [0]

# Every o-counter call — `{op, id, count}`. A toggle and a tally look identical
# at zero; only the log shows add+delete versus two adds.
O_CALLS = []

# Every /scene/{id}/preview request. The cost story is which scenes are asked
# for: probing on focus logs one per card crossed, memoised failures once.
PREVIEW_FETCHES = []

# Every sceneStreams call — the scene id. The fallback is cheap only if the
# ordinary path never asks, and that absence is only visible here.
STREAMS_FETCHES = []

# Every transcoded media URL requested — the full path, so the format shows.
# Firefox cannot play HLS in a <video>, so request order is the only evidence:
# an HLS playlist before any MP4 bytes means HLS was chosen first.
STREAM_FETCHES = []

# Every sceneMarkerCreate call — the verbatim `input`. The contract is the
# payload: which scene, second and tag, and the title fallback for no label.
MARKER_CREATES = []

# The fake scene. rating100 is 70 while SCENE.rating in the driver is "5.0", so
# the card's painted value and the server value are distinguishable.
SCENE = {
    "id": "4242",
    "title": "VERIFY — detail page harness",
    "code": "HARNESS-1",
    "details": "A details block, present so the clamp has something to clamp.",
    "date": "2024-03-09",
    "rating100": 70,
    "organized": False,
    # Starts at 0 so the add direction comes first; the counter toggles, so a
    # non-zero start would silently test the opposite branch.
    "o_counter": 0,
    "play_count": 2,
    "play_duration": 4510,
    # Non-zero so "Clear progress" is enabled, as for a half-watched scene. The
    # card prop says 0, so any resume bar proves the detail fetch won.
    "resume_time": 1800,
    "last_played_at": "2024-05-01T10:00:00Z",
    "urls": ["https://example.invalid/a", "https://example.invalid/b"],
    "studio": {"id": "1", "name": "Harness Studio"},
    "tags": [{"id": str(i), "name": f"tag-{i}"} for i in range(10)],
    "performers": [{"id": "1", "name": "Performer One"}],
    # Two, so the chip row's focus walk has somewhere to go; no listing gallery
    # shares these ids, so the selected gallery is identifiable.
    "galleries": [
        {"id": "7001", "title": "VERIFY gallery one"},
        {"id": "7002", "title": "VERIFY gallery two"},
    ],
    "stash_ids": [{"endpoint": "https://stashdb.org/graphql", "stash_id": "abc"}],
    "files": [{
        "duration": 3725.5, "width": 1920, "height": 1080,
        "video_codec": "h264", "audio_codec": "aac",
        "frame_rate": 29.97, "bit_rate": 4200000, "size": 2000000000,
    }],
    "paths": {"screenshot": "/scene/4242/screenshot", "stream": "/scene/4242/stream"},
    # Deliberately out of order (1905, 125, 640): the normalizer must sort. Titles
    # and tags differ, so the chip's label choice is observable.
    "scene_markers": [
        {"id": "901", "seconds": 1905, "end_seconds": 1935,
         "title": "VERIFY marker three", "primary_tag": {"name": "VERIFY tag three"}},
        {"id": "902", "seconds": 125, "end_seconds": 155,
         "title": "VERIFY marker one", "primary_tag": {"name": "VERIFY tag one"}},
        {"id": "903", "seconds": 640, "end_seconds": 670,
         "title": "VERIFY marker two", "primary_tag": {"name": "VERIFY tag two"}},
    ],
}

# /toneNNN.wav, with an optional ?apikey=… that the app appends. Group 1 is
# the query string, restored on the rewrite.
TONE_RE = re.compile(r"/tone\d*\.wav(\?[^#]*)?")

# /scene/{id}/preview, with the ?apikey=… the app appends.
PREVIEW_RE = re.compile(r"/scene/(\d+)/preview(\?[^#]*)?")
# /scene/{id}/thumb.png — the parent scene's screenshot.
THUMB_RE = re.compile(r"/scene/(\d+)/thumb\.png(\?[^#]*)?")
# Section artwork: tag/studio/gallery/image PNGs, plus performer portraits,
# which the search results draw with the performer card. One route because
# they differ only in tint (see do_GET); anchored on the section name so it
# cannot swallow the scene thumbnail.
ENTITY_IMG_RE = re.compile(
    r"/(tag|studio|gallery|image|performer)/(\d+)/(?:image|cover|thumb|full)\.png(\?[^#]*)?")
# /scene/{id}/stream.mp4 — one of the transcoded endpoints sceneStreams
# advertises. See do_GET.
STREAM_MP4_RE = re.compile(r"/scene/\d+/stream\.mp4(\?[^#]*)?")
# HLS playlist and segments. Both are served: a 404 would make the fallback
# depend on a server fault when the fact under test is the engine's refusal
# (Firefox parses this, then cannot play it). Group 2 is the segment index.
STREAM_HLS_RE = re.compile(r"/scene/(\d+)/stream\.m3u8(?:/(\d+)\.ts)?(\?[^#]*)?")
# /hang/{anything} — accepted, then never answered. See do_GET.
HANG_RE = re.compile(r"/hang/[^?#]*(\?[^#]*)?")
# A marker's *own* frame: /scene/{sceneId}/scene_marker/{markerId}/screenshot.png.
MARKER_SHOT_RE = re.compile(r"/scene/\d+/scene_marker/\d+/(?:screenshot|preview)(\?[^#]*)?")
# The marker's generated stream, which the card no longer asks for.
MARKER_STREAM_RE = re.compile(r"/scene/\d+/scene_marker/\d+/stream(\?[^#]*)?")


def _hls_playlist(scene_id, segments=3, seconds=10.0):
    """A minimal but well-formed VOD playlist.

    Shaped like the real one in the ways that matter and cut down in the way
    that does not: Stash's answer for the scene this bug was reported against
    was 914 segments over 1827 s, and what the player reads off it is the
    duration and the `ENDLIST`. Three is enough for both.
    """
    head = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{int(seconds)}",
        "#EXT-X-PLAYLIST-TYPE:VOD",
    ]
    body = []
    for n in range(segments):
        body.append(f"#EXTINF:{seconds:.4f},")
        body.append(f"/scene/{scene_id}/stream.m3u8/{n}.ts")
    return "\n".join(head + body + ["#EXT-X-ENDLIST", ""]).encode()


def _png(rgb, width=8, height=8):
    """A solid-colour PNG, 8x8 unless a caller needs a picture with size."""
    import struct, zlib

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


# Every marker's own screenshot is one identical image: a 200 "Pending Generate"
# placeholder, exactly what the real server returns. The pair is one placeholder
# plus a real per-scene frame.
PLACEHOLDER_PNG = _png((0x18, 0x20, 0x26))

# ── Tags, for the marker form ────────────────────────────────
# The library's most-used tag is C, the scene's is A: the form must open on A,
# so the marker is not filed under a tag this scene never used.
TAG_A = {"id": "9001", "name": "Harness Tag A"}
TAG_B = {"id": "9002", "name": "Harness Tag B"}
TAG_C = {"id": "9003", "name": "Harness Tag C"}

# Library order, most used first. C leads.
TAG_LISTING = [
    {**TAG_C, "scene_marker_count": 268},
    {**TAG_A, "scene_marker_count": 40},
    {**TAG_B, "scene_marker_count": 12},
]

# Recently used, newest first — an order no slice of TAG_LISTING produces, so a
# recent row that was really the library list fails rather than coinciding.
RECENT_TAGS = [TAG_C, TAG_B]

# Echoed on create so the confirmation carries the tag the user picked.
TAG_NAMES = {t["id"]: t["name"] for t in (TAG_A, TAG_B, TAG_C)}

# ── A deterministic listing, for the pagination harness ──────
# 100 rows at page size 40: pages 1–2 full, page 3 short, page 4 never asked
# for. The short page makes "stops once it holds every row" observable.
SCENE_COUNT = 100


def listing_scene(n):
    """One row of the fake listing. Ids are 1-based and distinct, because the
    dedupe-by-id append is one of the things under test — duplicate ids would
    make an incorrect append look correct."""
    return {
        "id": str(n),
        "title": f"VERIFY scene {n}",
        "date": "2024-03-09",
        "rating100": 50,
        "details": None,
        "play_count": 0,
        "resume_time": 0,
        # h264/mp4/aac — what 94% of the real library is, and what the direct
        # stream is for. Unplayable-codec cases are built in codec-entry.jsx.
        "files": [{
            "duration": 120.0, "width": 1920, "height": 1080,
            "video_codec": "h264", "audio_codec": "aac", "format": "mp4",
        }],
        # A real playable file (run.sh's silent WAV) so the player harness has
        # `ended` and a moving currentTime.
        # Media URLs are per scene though the bytes are shared: React only rewrites
        # a changed attribute, so a shared URL would leave the element on the
        # previous scene and hide the resume-save bug. `preview` likewise;
        # `screenshot` is served because the bug is a cover behind it.
        "paths": {
            "screenshot": f"/scene/{n}/thumb.png",
            "stream": f"/tone{n}.wav",
            "sprite": None,
            "vtt": None,
            "preview": f"/scene/{n}/preview",
        },
        "studio": {"id": "1", "name": "Harness Studio"},
        "tags": [],
        "performers": [],
    }


# ── The same listing shape for the two grids ──
# MarkerGrid and PerformerGrid had no fixture, so both fell through to the
# unhandled-query error and never rendered. Same 100 rows and page size.
MARKER_COUNT = 100
PERFORMER_COUNT = 100


def listing_marker(n):
    """One row of the marker listing.

    `screenshot` is a per-marker URL for the same reason `listing_scene`'s is a
    per-scene one: React rewrites an attribute only when its value changes, so
    a shared URL would leave the previous card's image in place and any check
    written against it would pass on stale state.

    The parent scene is carried in full because a marker plays *its scene*,
    seeking to `seconds` — a fixture whose markers had no scene would leave the
    one thing a marker card does unreachable.

    `seconds` stays inside the 60 s tone every scene streams: a marker at 61 s
    seeks past the end, where the element clamps to its duration and "started
    at the marker" becomes indistinguishable from "started at zero". The value
    still varies per row so a queue built from the wrong marker is visible.
    """
    return {
        "id": str(n),
        "title": f"VERIFY marker {n}",
        "seconds": 5 + (n % 50),
        "end_seconds": None,
        "screenshot": f"/marker/{n}/thumb.png",
        "scene": {
            "id": str(n),
            "title": f"VERIFY scene {n}",
            "paths": {
                "stream": f"/tone{n}.wav",
                "screenshot": f"/scene/{n}/thumb.png",
                "sprite": None,
                "vtt": None,
            },
            "files": [{"video_codec": "h264", "audio_codec": "aac", "format": "mp4"}],
            "performers": [],
        },
        # Cycled across twelve tags rather than constant, so a check that the
        # card shows *this* marker's tag can tell that from "shows any tag".
        "primary_tag": {"name": f"VERIFY tag {((n - 1) % 12) + 1}"},
        "tags": [],
    }


# Every findPerformer call — `{id, query}`. The query text shows the fetch
# stays narrow: profile fields present, card fields absent.
PERFORMER_FETCHES = []

# Every performerUpdate mutation — `{input}`: which performer, which field moved.
PERFORMER_UPDATES = []

# Every FindImageInfo query — `{id, query}`. The text proves the client asked
# for `visual_files`; `files` is invalid on Image, but the fake answers either.
IMAGE_INFO_FETCHES = []

# Every stopJob mutation — `{job_id, query}` — and the ids stopped. `/clear`
# resets both, so each phase starts from the full fixture.
STOP_FETCHES = []
STOPPED_JOB_IDS = set()

# Deliberately adversarial: the card says FEMALE, this says NON_BINARY; the
# career bounds are real while career_length is nonsense ("99 years"); the URL
# has a scheme and path. The enrichment adds two URLs on one host out of four
# (so chip-per-URL repeats a label and the 3-chip cap + "+1" shows), distinct
# VERIFY-prefixed free text, non-zero differing counts, and rating/favourite
# that disagree with the card's 0/unliked. Every string carries VERIFY, so no
# check passes on incidental text.
PERFORMER_DETAIL = {
    "id": "8701",
    "gender": "NON_BINARY",
    "alias_list": ["VERIFY profile alias one", "VERIFY profile alias two"],
    "career_start": "1999-04-01",
    "career_end": "2011-09-30",
    "career_length": "99 years",
    "tattoos": "VERIFY tattoo: anchor on left forearm",
    "measurements": "VERIFY 34-24-35",
    "ethnicity": "VERIFY ethnicity",
    "hair_color": "VERIFY hair",
    "eye_color": "VERIFY eyes",
    "weight": 61,
    "piercings": "VERIFY piercings",
    "fake_tits": "VERIFY fake",
    "death_date": None,
    "o_counter": 7,
    "image_count": 11,
    "gallery_count": 2,
    "urls": [
        "https://profile-8701.verify.invalid/about",
        "https://profile-8701.verify.invalid/gallery",
        "https://second-8701.verify.invalid/",
        "https://third-8701.verify.invalid/",
        "https://fourth-8701.verify.invalid/",
    ],
    "tags": [
        {"id": "t1", "name": "VERIFY performer tag one"},
        {"id": "t2", "name": "VERIFY performer tag two"},
    ],
    "rating100": 75,
    "favorite": True,
}

# Every LibraryStats / ServerStatus call with its query text, so a check can
# prove the stats selection stays narrow and status carries all three roots.
STATS_FETCHES = []
STATUS_FETCHES = []
# Every metadataScan mutation with its variables. W2c needs them: the client
# must copy the instance's saved scan defaults into `input`, not generate
# nothing.
SCAN_FETCHES = []
# Every read of the saved scan options (`configuration.ui` and the legacy
# `configuration.defaults.scan`), so a check can prove one read per press.
SCAN_DEFAULTS_FETCHES = []

# Two blocks, as on a real 0.31.1 server: SCAN_DEFAULTS is the legacy
# configuration.defaults.scan, SCAN_UI_DEFAULTS what Stash's own scan-page
# checkboxes save under configuration.ui.taskDefaults.scan. They differ in every
# field, so sending the system values while the UI shows the user's fails W2c.
# Each set is mixed so `{}`, a hardcoded set or a dropped field is visible; the
# "alt" variants prove the values are read at press time.
SCAN_DEFAULTS = {
    "rescan": False,
    "scanGenerateCovers": True,
    "scanGeneratePreviews": True,
    "scanGenerateImagePreviews": False,
    "scanGenerateSprites": True,
    "scanGeneratePhashes": True,
    "scanGenerateImagePhashes": False,
    "scanGenerateThumbnails": False,
    "scanGenerateClipPreviews": False,
}
SCAN_UI_DEFAULTS = {
    "rescan": True,
    "scanGenerateCovers": False,
    "scanGeneratePreviews": False,
    "scanGenerateImagePreviews": True,
    "scanGenerateSprites": False,
    "scanGeneratePhashes": False,
    "scanGenerateImagePhashes": True,
    "scanGenerateThumbnails": True,
    "scanGenerateClipPreviews": False,
}
SCAN_DEFAULTS_ALT = {
    "rescan": True,
    "scanGenerateCovers": False,
    "scanGeneratePreviews": False,
    "scanGenerateImagePreviews": True,
    "scanGenerateSprites": False,
    "scanGeneratePhashes": False,
    "scanGenerateImagePhashes": True,
    "scanGenerateThumbnails": True,
    "scanGenerateClipPreviews": True,
}
SCAN_UI_DEFAULTS_ALT = {
    "rescan": False,
    "scanGenerateCovers": True,
    "scanGeneratePreviews": False,
    "scanGenerateImagePreviews": False,
    "scanGenerateSprites": True,
    "scanGeneratePhashes": False,
    "scanGenerateImagePhashes": False,
    "scanGenerateThumbnails": False,
    "scanGenerateClipPreviews": True,
}

# Every FindSceneDetail query with its text: the page must read markers from
# the detail query without widening it to carry artwork it does not draw.
DETAIL_FETCHES = []

# Numbers chosen so a formatting mistake is visible: 1,234 / 98,765 / 4,321
# prove comma grouping; 1.5 GiB + 1 GiB = 2.5 GiB makes one-size summing wrong;
# 4,501,800 s and 9,001,800 s are 1,250.5 h and 2,500.5 h (floor 1,250/2,500,
# round 1,251/2,501).
LIBRARY_STATS = {
    "scene_count": 1234,
    "scenes_size": 1610612736,      # 1.5 GiB
    "scenes_duration": 4501800,     # 1,250.5 h
    "image_count": 98765,
    "images_size": 1073741824,      # 1 GiB
    "gallery_count": 4321,
    "performer_count": 1892,
    "studio_count": 321,
    "tag_count": 2048,
    "total_o_count": 777,
    "total_play_duration": 9001800, # 2,500.5 h
    "total_play_count": 54321,
    "scenes_played": 3456,
}

# NEEDS_MIGRATION with a schema gap and a finished job the panel must filter
# out. `migrated` is the "changed after Refresh" answer: healthy, no jobs.
SERVER_STATUS = {
    "version": {"version": "0.31.1-harness"},
    "systemStatus": {"status": "NEEDS_MIGRATION", "appSchema": 31, "databaseSchema": 30},
    "jobQueue": [
        # Four subtasks but three shown, so the fourth's absence is asserted.
        {
            "id": "job-1", "status": "RUNNING", "description": "VERIFY scan running",
            "progress": 0.42,
            "subTasks": [
                "VERIFY subtask one", "VERIFY subtask two",
                "VERIFY subtask three", "VERIFY subtask four",
            ],
            "error": None,
            "startTime": "2024-05-01T09:30:00Z",
        },
        {"id": "job-2", "status": "FINISHED", "description": "VERIFY finished job",
         "progress": 1.0, "subTasks": [], "error": None, "startTime": None},
        # Failed jobs are shown but not stoppable; the error line identifies it.
        {
            "id": "job-3", "status": "FAILED", "description": "VERIFY failed job",
            "progress": 0.18, "subTasks": [],
            "error": "VERIFY failure reason: the media folder is not mounted",
            "startTime": "2024-05-01T09:05:00Z",
        },
    ],
}


# The viewer's info panel. Every relational list is longer than the panel's
# cap on purpose: 8 tags → "6 +2", 7 performers → "6 +1", 6 galleries → "4 +2".
# File facts arrive under `visual_files` because Image has no `files` field.
IMAGE_INFO = {
    "id": "1",
    "title": "VERIFY image info title",
    "date": "2024-03-09",
    "details": "VERIFY image details. " * 20,
    "code": "VERIFY-CODE",
    "rating100": 75,
    "o_counter": 3,
    "studio": {"id": "1", "name": "VERIFY image studio"},
    "photographer": "VERIFY photographer",
    "tags": [{"id": f"t{i}", "name": f"VERIFY info tag {i}"} for i in range(1, 9)],
    "performers": [
        {"id": f"p{i}", "name": f"VERIFY info performer {i}"} for i in range(1, 8)],
    "galleries": [
        {"id": f"g{i}", "title": f"VERIFY info gallery {i}"} for i in range(1, 7)],
    "visual_files": [{"size": 5 * 1024 * 1024, "width": 4000, "height": 3000}],
    "paths": {
        "thumbnail": "/image/1/thumb.png",
        "image": "/image/1/full.png",
        "preview": None,
    },
}


def listing_performer(n):
    """One row of the performer listing.

    `image_path` is null on every even row on purpose: the card has a monogram
    fallback for a performer with no image, and a fixture where every row had
    one would leave that branch unreachable from here.
    """
    return {
        "id": str(n),
        "name": f"VERIFY performer {n}",
        "disambiguation": None,
        "gender": "FEMALE",
        "favorite": n % 5 == 0,
        "image_path": None if n % 2 == 0 else f"/performer/{n}/image.png",
        "scene_count": n % 7,
        "rating100": 50,
        "country": "US",
        "birthdate": "1990-01-01",
        "details": None,
        "height_cm": 170,
    }


# ── Tags, Studios, Galleries, Images ─────────────────────────
# Same 100 rows and page size as the three listings above, so one driver and
# one `pagesOf()` describe all seven. 100 keeps pages 1–2 full and page 3 short;
# mirroring the real counts (533 / 27 / 792 / 31,251) would put Studios on one
# short page and hide the paging path. The fixtures do carry the sections'
# structural differences the descriptor papers over:
#
#   Tag      no `rating100` at all, so a card that wrongly reads one fails.
#   Studio   rated and favourited; count sorts singular (`tag_count`) where
#            Tag's are plural (`performers_count`).
#   Gallery  `paths.cover`, renamed to `image_path` by the service.
#   Image    both `paths.thumbnail` (card) and `paths.image` (viewer).
TAG_COUNT = 100
STUDIO_COUNT = 100
GALLERY_COUNT = 100
IMAGE_COUNT = 100


def listing_tag(n):
    """One row of the tag listing.

    `image_path` is always a URL, never null — that is what the real library
    looks like (533 of 533), and it is why the card's monogram fallback is
    reached by a failed load rather than a missing field. Every seventh row
    gets a URL the fake does not serve, so both branches are reachable.
    """
    return {
        "id": str(n),
        "name": f"VERIFY tag {n}",
        "image_path": None if n % 7 == 0 else f"/tag/{n}/image.png",
        "favorite": n % 4 == 0,
        # `scene_count` is the bare count the card prints; the rest are the
        # sortable ones, and they are plural here — matching Stash, which uses
        # `performers_count` on Tag and `performer_count` on Image.
        "scene_count": n,
        "scene_marker_count": (n * 3) % 97,
        "image_count": (n * 5) % 89,
        "gallery_count": n % 13,
        "performer_count": n % 17,
        "studio_count": n % 6,
        # Roughly half the rows have a description and aliases, so focus reaches
        # both populated and empty blurbs. Row 4's description is overlong for
        # the hero's two-line clamp, and sits in the first page of five.
        "description": (
            "VERIFY long tag description. " * 40 if n == 4
            else f"VERIFY tag description {n}" if n % 2 == 0 else None
        ),
        "aliases": [f"VERIFY alias {n}a", f"VERIFY alias {n}b"] if n % 3 == 0 else [],
    }


def listing_studio(n):
    """One row of the studio listing. Rated and favourited, unlike Tag."""
    return {
        "id": str(n),
        "name": f"VERIFY studio {n}",
        # Every fifth row has no artwork, for the same reason as the tags.
        "image_path": None if n % 5 == 0 else f"/studio/{n}/image.png",
        "favorite": n % 3 == 0,
        # The service divides this by ten; varied so "★ 5.0" everywhere cannot
        # pass on a card that never divided at all.
        "rating100": (n * 7) % 101,
        "scene_count": n,
        "image_count": (n * 3) % 71,
        "gallery_count": n % 11,
        "tag_count": n % 19,
        "child_count": n % 4,
        "organized": n % 2 == 0,
        # Each on a different residue so all/some/none are reachable by walking a
        # few cards. Row 5's details are overlong for the blurb's two-line clamp.
        "parent_studio": (
            {"id": str(n - 1), "name": f"VERIFY studio {n - 1}"}
            if n % 4 == 0 and n > 1 else None
        ),
        "aliases": [f"VERIFY studio alias {n}"] if n % 3 == 0 else [],
        "details": (
            "VERIFY long studio details. " * 40 if n == 5
            else f"VERIFY studio details {n}" if n % 5 == 0 else None
        ),
    }


def listing_gallery(n):
    """One row of the gallery listing.

    The cover arrives as `paths.cover` and the service renames it to
    `image_path` on the way through. Nothing else in the response carries a
    URL, so a service that forgot the rename shows up as a wall of monograms
    rather than as a subtle wrong image.
    """
    return {
        "id": str(n),
        "title": f"VERIFY gallery {n}",
        "paths": {
            "cover": None if n % 6 == 0 else f"/gallery/{n}/cover.png",
        },
        "image_count": n * 4,
        "file_count": n * 2,
        "performer_count": n % 9,
        "tag_count": n % 23,
        "rating100": (n * 11) % 101,
        "organized": n % 2 == 0,
        "date": "2024-03-09",
        # Studio on a third of rows, photographer on a quarter, folder always,
        # so the subtitle's fallback order shows by walking three cards.
        "studio": (
            {"id": str(n), "name": f"VERIFY gallery studio {n}"}
            if n % 3 != 0 else None
        ),
        "photographer": f"VERIFY photographer {n}" if n % 4 == 0 else None,
        "folder": {"basename": f"VERIFY folder {n}"},
    }


# Small on purpose: the slideshow advances on a 6 s timer and the checks want
# to watch it move then run out; 40 rows would make that a 4-minute test.
GALLERY_IMAGE_COUNT = 5


def listing_gallery_image(gallery_id, n):
    """One picture *of a gallery*, for the slideshow opened from a card.

    Served only under `/mode galleryImages=populate`. The default answer for a
    gallery-filtered image listing is empty, because that is what makes
    Sections S6's "still filtered" observable; this fixture exists for the
    opposite assertion, that the gallery menu's slideshow fetches the gallery's
    own pictures and steps through them.

    The id and the image URLs are keyed on the gallery as well as the row, so
    a viewer that fetched some *other* gallery's pictures (or the unfiltered
    listing) shows up as the wrong title rather than as a plausible one.
    """
    base = 6000 + (int(gallery_id) % 1000) * 10 + n
    return {
        "id": str(base),
        "title": f"VERIFY gallery {gallery_id} image {n}",
        "paths": {
            "thumbnail": f"/image/{base}/thumb.png",
            "image": f"/image/{base}/full.png",
        },
        "rating100": (base * 13) % 101,
        "o_counter": n % 5,
        "organized": n % 2 == 0,
        "date": "2024-03-09",
        "file_count": 1,
    }


def listing_image(n):
    """One row of the image listing.

    `thumbnail` and `image` are *different* URLs — the card shows the first and
    the viewer opens the second, and a fixture where they agreed would let a
    viewer that had been wired to the thumbnail pass. Both are real routes on
    this server, so the viewer's own image really loads.

    Every row carries a `visual_files` basename, a union member the real server
    answers with the file's name. Every tenth row has no title, because that is
    the common case on the live library and the app's fallback is what makes
    the grid readable: the caption (and the viewer's header) must show
    `VERIFY_stem_10`, not an empty line. Rows 1 and 2 keep their titles —
    several checks name them.
    """
    return {
        "id": str(n),
        "title": "" if n % 10 == 0 else f"VERIFY image {n}",
        "paths": {
            "thumbnail": f"/image/{n}/thumb.png",
            "image": f"/image/{n}/full.png",
        },
        "visual_files": [{"basename": f"VERIFY_stem_{n}.JPG"}],
        "rating100": (n * 13) % 101,
        "o_counter": n % 5,
        "organized": n % 2 == 0,
        "date": "2024-03-09",
        "file_count": 1,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=OUT_DIR, **kw)

    def log_message(self, *a):
        pass

    def _png_response(self, blob):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if self.path == "/result":
            with open(f"{OUT_DIR}/../result.json", "wb") as f:
                f.write(raw)
            return self._json({"ok": True})

        if self.path.startswith("/shot-ready"):
            # `?ok=1` records that the driver reached the screen it was asked
            # for; releasing a *failed* screen's hold would still look valid.
            if "ok=1" in self.path:
                with open(f"{OUT_DIR}/../SHOT_OK", "w") as f:
                    f.write("ok")
            SHOT_READY.set()
            return self._json({"ok": True})

        if self.path == "/done":
            with open(f"{OUT_DIR}/../DONE", "w") as f:
                f.write("done")
            return self._json({"ok": True})

        if self.path == "/mode":
            payload = json.loads(raw or b"{}")
            with LOCK:
                MODE.update(payload)
                # A seed resets the tally *and* the log, so 0 → 1 → 2 starts
                # clean rather than counting an earlier test's presses.
                if "oSeed" in payload:
                    O_COUNT[0] = int(payload["oSeed"])
                    O_CALLS.clear()
            return self._json(MODE)

        if self.path == "/clear":
            with LOCK:
                REQUESTS.clear()
                HANG_HITS.clear()
                GRAPHQL_CALLS.clear()
                SAVES.clear()
                MARKER_CREATES.clear()
                PLAY_ADDS.clear()
                ACTIVITY_RESETS.clear()
                O_CALLS.clear()
                PREVIEW_FETCHES.clear()
                STREAMS_FETCHES.clear()
                STREAM_FETCHES.clear()
                PERFORMER_FETCHES.clear()
                PERFORMER_UPDATES.clear()
                IMAGE_INFO_FETCHES.clear()
                STOP_FETCHES.clear()
                STOPPED_JOB_IDS.clear()
                STATS_FETCHES.clear()
                STATUS_FETCHES.clear()
                SCAN_FETCHES.clear()
                SCAN_DEFAULTS_FETCHES.clear()
                DETAIL_FETCHES.clear()
                # A leftover filter would show in the dropdown as an entry the
                # new phase never created.
                SAVED_FILTERS.clear()
                FILTER_WRITES.clear()
            return self._json({"ok": True})

        if self.path == "/graphql":
            return self._graphql(json.loads(raw or b"{}"))

        return self._json({"error": "not found"}, 404)

    def do_GET(self):
        if self.path.startswith("/hold.png"):
            SHOT_READY.wait(timeout=30)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(_BLANK_PNG)))
            self.end_headers()
            self.wfile.write(_BLANK_PNG)
            return
        if self.path.startswith("/hanghits"):
            with LOCK:
                return self._json(list(HANG_HITS))
        if self.path.startswith("/requests"):
            with LOCK:
                return self._json(list(REQUESTS))
        if self.path.startswith("/graphqlcalls"):
            with LOCK:
                return self._json(list(GRAPHQL_CALLS))
        if self.path.startswith("/saves"):
            with LOCK:
                return self._json(list(SAVES))
        if self.path.startswith("/filterwrites"):
            with LOCK:
                return self._json(list(FILTER_WRITES))
        if self.path.startswith("/savedfilters"):
            with LOCK:
                return self._json({k: [dict(f) for f in v] for k, v in SAVED_FILTERS.items()})
        if self.path.startswith("/markercreates"):
            with LOCK:
                return self._json(list(MARKER_CREATES))
        if self.path.startswith("/playadds"):
            with LOCK:
                return self._json(list(PLAY_ADDS))
        if self.path.startswith("/resetcalls"):
            with LOCK:
                return self._json(list(ACTIVITY_RESETS))
        if self.path.startswith("/performerfetches"):
            with LOCK:
                return self._json(list(PERFORMER_FETCHES))
        if self.path.startswith("/performerupdates"):
            with LOCK:
                return self._json(list(PERFORMER_UPDATES))
        if self.path.startswith("/imageinfofetches"):
            with LOCK:
                return self._json(list(IMAGE_INFO_FETCHES))
        if self.path.startswith("/stopfetches"):
            with LOCK:
                return self._json(list(STOP_FETCHES))
        if self.path.startswith("/statsfetches"):
            with LOCK:
                return self._json(list(STATS_FETCHES))
        if self.path.startswith("/statusfetches"):
            with LOCK:
                return self._json(list(STATUS_FETCHES))
        if self.path.startswith("/scanfetches"):
            with LOCK:
                return self._json(list(SCAN_FETCHES))
        if self.path.startswith("/scandefaultsfetches"):
            with LOCK:
                return self._json(list(SCAN_DEFAULTS_FETCHES))
        if self.path.startswith("/detailfetches"):
            with LOCK:
                return self._json(list(DETAIL_FETCHES))
        if self.path.startswith("/ocalls"):
            with LOCK:
                return self._json(list(O_CALLS))
        if self.path.startswith("/previewfetches"):
            with LOCK:
                return self._json(list(PREVIEW_FETCHES))
        if self.path.startswith("/streamsfetches"):
            with LOCK:
                return self._json(list(STREAMS_FETCHES))
        if self.path.startswith("/streamfetches"):
            with LOCK:
                return self._json(list(STREAM_FETCHES))
        # The preview route, logged before the mode is consulted so a check can
        # tell "did not ask" from "asked and was refused".
        m = PREVIEW_RE.fullmatch(self.path)
        if m:
            with LOCK:
                PREVIEW_FETCHES.append(m.group(1))
            if MODE.get("preview") == "ok":
                # Decodable bytes, not a 200 with an empty body: the guard keys
                # off the element's `playing` event, so an empty file would make
                # success and failure identical.
                self.path = "/tone.wav" + (m.group(2) or "")
                return super().do_GET()
            # Same shape as Stash's real answer for an ungenerated preview.
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"404 page not found")
            return
        # A transcoded endpoint, answered with the same silent WAV the direct
        # streams use: the claim is *which* URL the element was pointed at and
        # that it loads. It must not 404, or fallback and no-fallback look alike.
        if STREAM_MP4_RE.fullmatch(self.path):
            with LOCK:
                STREAM_FETCHES.append(self.path)
            self.path = "/tone.wav"
            return super().do_GET()

        m = STREAM_HLS_RE.fullmatch(self.path)
        if m:
            with LOCK:
                STREAM_FETCHES.append(self.path)
            if m.group(2) is None:
                # The playlist itself, well-formed and complete.
                blob = _hls_playlist(m.group(1))
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(blob)))
                # The seekability headers the real server sends and the MP4
                # endpoint does not — the fixture must not model the broken one.
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                self.wfile.write(blob)
                return
            # A segment: fetchable is all that matters; a missing segment would
            # be a server fault rather than the engine refusal under test.
            self.path = "/tone.wav"
            return super().do_GET()

        # Accepts the connection, then says nothing: an engine that never decodes
        # rather than rejects. Only the player's stall watchdog can notice it.
        if HANG_RE.fullmatch(self.path):
            with LOCK:
                HANG_HITS.append(int(time.time() * 1000))
            time.sleep(120)
            self.send_response(404)
            self.end_headers()
            return

        if MARKER_SHOT_RE.fullmatch(self.path):
            return self._png_response(PLACEHOLDER_PNG)
        if MARKER_STREAM_RE.fullmatch(self.path):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"404 page not found")
            return
        m = ENTITY_IMG_RE.fullmatch(self.path)
        if m:
            # Tinted by section *and* id, so the same row number in two sections
            # differs; two of these four sections share an id space.
            kind = m.group(1)
            n = int(m.group(2))
            tint = {"tag": 0x00, "performer": 0x20, "studio": 0x40,
                    "gallery": 0x80, "image": 0xC0}[kind]
            # `full.png` is a different colour from the row's thumbnail, making
            # "the viewer opened the full image" checkable.
            # The keyed URL ends in `?apikey=...`, so test the path alone.
            full = 0x30 if m.group(0).split("?")[0].endswith("full.png") else 0x00
            # The viewer's picture must be larger than the stage or a 2x zoom
            # has nothing to pan. Cards crop whatever they are given, so only
            # this route needs dimensions.
            width, height = (1600, 1200) if kind == "image" and full else (8, 8)
            return self._png_response(
                _png(((0x30 + tint + (n * 37) % 160) & 0xFF, 0x50 + full, 0x60),
                     width, height))
        m = THUMB_RE.fullmatch(self.path)
        if m:
            # Tinted by scene id, so two scenes' screenshots are distinguishable
            # bytes rather than one image behind many URLs.
            n = int(m.group(1))
            return self._png_response(_png((0x30 + (n * 37) % 200, 0x50, 0x60)))
        # One file, many URLs — see listing_scene for why the URL differs.
        m = TONE_RE.fullmatch(self.path)
        if m:
            self.path = "/tone.wav" + (m.group(1) or "")
        return super().do_GET()

    def _graphql(self, payload):
        query = payload.get("query") or ""
        variables = payload.get("variables") or {}

        # Logged before dispatch, so an unrecognised operation still shows up —
        # proving absence is the point, and those slip past in-handler logging.
        m = OP_RE.search(query)
        with LOCK:
            GRAPHQL_CALLS.append(m.group(1) if m else query.strip()[:40])

        # The two Settings panels, above the anonymous connection-test arm below:
        # that arm would otherwise answer ServerStatus's `version` alone, with no
        # error. This ordering is load-bearing.
        if "LibraryStats" in query:
            with LOCK:
                STATS_FETCHES.append(query)
                mode = MODE.get("stats", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated stats failure"}]})
            return self._json({"data": {"stats": dict(LIBRARY_STATS)}})

        # Saved scan options, answered as the real 0.31.1 shape: the user's
        # toggles under `configuration.ui`, the legacy system block beside it
        # under `defaults.scan`. "system" omits the UI block, forcing the fallback.
        if "ScanDefaults" in query:
            with LOCK:
                SCAN_DEFAULTS_FETCHES.append(query)
                mode = MODE.get("scanDefaults", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated defaults failure"}]})
            scan = dict(SCAN_DEFAULTS_ALT if mode == "alt" else SCAN_DEFAULTS)
            ui = {} if mode == "system" else {
                "taskDefaults": {
                    "scan": dict(SCAN_UI_DEFAULTS_ALT if mode == "alt" else SCAN_UI_DEFAULTS),
                },
            }
            return self._json({"data": {
                "configuration": {"ui": ui, "defaults": {"scan": scan}},
            }})

        # Starting a scan: the real resolver returns a bare `ID` scalar, not an
        # object, so a client guessing a shape must fail here rather than on TV.
        if "LibraryScan" in query or "metadataScan" in query:
            with LOCK:
                SCAN_FETCHES.append({"query": query, "variables": variables})
                mode = MODE.get("scan", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated scan failure"}]})
            return self._json({"data": {"metadataScan": "job-scan-1"}})

        # Stopping a job. `stopJob(job_id: ID!): Boolean!`, and `false` is a
        # refusal, not a stop. A successful stop removes the row, so the
        # focus-before-refresh rule is observable: the D-pad row really goes.
        if "StopJob" in query or "stopJob" in query:
            job_id = str(variables.get("jobId") or variables.get("job_id") or "")
            with LOCK:
                STOP_FETCHES.append({"job_id": job_id, "query": query})
                mode = MODE.get("stopJob", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated stop failure"}]})
            if mode == "false":
                return self._json({"data": {"stopJob": False}})
            with LOCK:
                STOPPED_JOB_IDS.add(job_id)
            return self._json({"data": {"stopJob": True}})

        if "ServerStatus" in query:
            with LOCK:
                STATUS_FETCHES.append(query)
                mode = MODE.get("serverStatus", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated status failure"}]})
            if mode == "migrated":
                return self._json({"data": {
                    "version": dict(SERVER_STATUS["version"]),
                    "systemStatus": {"status": "OK", "appSchema": 31, "databaseSchema": 31},
                    "jobQueue": [],
                }})
            with LOCK:
                jobs = [
                    dict(j) for j in SERVER_STATUS["jobQueue"]
                    if j["id"] not in STOPPED_JOB_IDS
                ]
            return self._json({"data": {
                "version": dict(SERVER_STATUS["version"]),
                "systemStatus": dict(SERVER_STATUS["systemStatus"]),
                "jobQueue": jobs,
            }})

        # The connection test's anonymous query (`{ version { version } }`),
        # matched on body rather than name. Without it the setup screen fell
        # through to the unhandled-query error at its own first button.
        if "version {" in query or "version{" in query:
            # `slow` keeps Connect in flight long enough to race Skip; the late
            # answer must not undo the Skip.
            if MODE.get("connection") == "slow":
                time.sleep(1.5)
            return self._json({"data": {"version": {"version": "0.31.1-harness"}}})

        # The filter builder's folder picker. Real paths, because the label is
        # the path's tail and the "last three segments" rule must be visible.
        if "findFolders" in query:
            f = variables.get("filter") or {}
            needle = (f.get("q") or "").lower()
            folders = [
                {"id": "11", "basename": "2002",
                 "path": "/media/library/Studio Alpha/Photos/2002"},
                {"id": "12", "basename": "2003",
                 "path": "/media/library/Studio Alpha/Photos/2003"},
                {"id": "13", "basename": "Country House",
                 "path": "/media/library/Summer Shoot/Country House"},
            ]
            rows = [r for r in folders if not needle or needle in r["basename"].lower()]
            return self._json({"data": {"findFolders": {"count": len(rows), "folders": rows}}})

        if "FindSceneDetail" in query:
            # The id is echoed, not 4242: the showroom driver clears scene 41's
            # progress and the app prunes that id from the shelf.
            scene = {**SCENE, "id": str(variables.get("id"))}
            # The detail page's answer, separate from the player's per-open
            # MODE["resume"], so a stale card can disagree with the fresh fetch.
            if MODE.get("detailResume") is not None:
                scene["resume_time"] = MODE["detailResume"]
            with LOCK:
                if str(variables.get("id")) in CLEARED_RESUME:
                    scene["resume_time"] = 0
            if MODE.get("sceneFile") == "rounding":
                # 3599.6 s is the formatter's trap: rounding only the seconds
                # remainder prints "59m 60s" instead of rolling over to 1h 0m.
                scene["files"] = [{**SCENE["files"][0], "duration": 3599.6}]
            with LOCK:
                DETAIL_FETCHES.append(query)
                if MODE.get("sceneMarkers") == "empty":
                    scene["scene_markers"] = []
                elif MODE.get("sceneMarkers") == "early":
                    # The player's markers sit at 20/40/55 s of a 60 s tone, but
                    # the detail fixture's are past the media, so seeks clamp and
                    # prove nothing. Swap in one marker that is inside it.
                    scene["scene_markers"] = [{
                        "id": "905", "seconds": 12, "end_seconds": 20,
                        "title": "VERIFY early marker",
                        "primary_tag": {"name": "VERIFY early tag"},
                    }]
            return self._json({"data": {"findScene": scene}})

        # The transcoder's menu in real order, from a live answer (the DASH entry
        # points and 480p tiers dropped as noise). The first two entries are not
        # transcodes — `Direct stream` is the scene's own file and `MKV` a remux
        # — and both are labelled `video/mp4` with no resolution, which is why
        # picking by mime type returns the refused bytes. A resolver choosing
        # either yields a URL without `/stream.mp4`, which I2 catches.
        # `empty` is a server with the feature off, not a scene without transcodes.
        if "SceneStreams" in query:
            sid = str(variables.get("id"))
            with LOCK:
                STREAMS_FETCHES.append(sid)
                mode = MODE.get("streams")
            if mode == "empty":
                return self._json({"data": {"sceneStreams": []}})
            # The transport keys are live while this is in flight: the element
            # has no src yet, the case a raw play() reports as NotSupportedError.
            if mode == "slow":
                time.sleep(1.2)
            key = "apikey=harness"
            return self._json({"data": {"sceneStreams": [
                {"url": f"/scene/{sid}/stream?{key}",
                 "mime_type": "video/mp4", "label": "Direct stream"},
                {"url": f"/scene/{sid}/stream.mkv?{key}",
                 "mime_type": "video/mp4", "label": "MKV"},
                {"url": f"/scene/{sid}/stream.mp4?{key}&resolution=ORIGINAL",
                 "mime_type": "video/mp4", "label": "MP4"},
                {"url": f"/scene/{sid}/stream.mp4?{key}&resolution=STANDARD",
                 "mime_type": "video/mp4", "label": "MP4 Standard (480p)"},
                {"url": f"/scene/{sid}/stream.mp4?{key}&resolution=LOW",
                 "mime_type": "video/mp4", "label": "MP4 Low (240p)"},
                {"url": f"/scene/{sid}/stream.webm?{key}&resolution=ORIGINAL",
                 "mime_type": "video/webm", "label": "WEBM"},
                {"url": f"/scene/{sid}/stream.m3u8?{key}&resolution=ORIGINAL",
                 "mime_type": "application/vnd.apple.mpegurl", "label": "HLS"},
            ]}})

        # `FindScenes` plural. The detail query above is a different operation
        # ("FindScene"), and a lazy match would answer a future single-scene one.
        if "FindScenes" in query:
            f = variables.get("filter") or {}
            entry = {
                "page": int(f.get("page") or 1),
                "per_page": int(f.get("per_page") or 40),
                "sort": f.get("sort"),
                "direction": f.get("direction"),
                "q": f.get("q") or "",
                "scene_filter": variables.get("scene_filter"),
            }
            with LOCK:
                REQUESTS.append(entry)
                mode = MODE.get("findScenes")
            # `slow-page-2` delays only page 2: the stale-response test needs one
            # request in flight while the list moves on, and the replacement must
            # land first or the bad append is overwritten and the bug invisible.
            if mode == "slow" or (mode == "slow-page-2" and entry["page"] == 2):
                time.sleep(1.0)
            # `fail-page-2` is the load-more failure the retry loop needs; page 1
            # stays healthy, because the failure was invisible when rows existed.
            if mode == "fail-page-2" and entry["page"] == 2:
                return self._json({"errors": [{"message": "VERIFY page 2 refused"}]})
            # `empty-page-2` is the no-progress page: count says rows exist, page 2
            # adds none, and the listing must stop rather than ask for page 3.
            if mode == "empty-page-2" and entry["page"] == 2:
                return self._json({
                    "data": {"findScenes": {"count": SCENE_COUNT, "scenes": []}}
                })
            # `short` is a listing that has ended: one full row, then one lone card.
            # R11 needs that card — with nothing below the cursor, the only Down
            # candidate is the fixed Settings row (the sidebar-drop bug).
            if mode == "short":
                rows = [listing_scene(n) for n in range(1, 6)]
                return self._json({"data": {"findScenes": {"count": 5, "scenes": rows}}})
            # A `title` criterion is honoured for the filter-builder driver alone.
            # Other handlers ignore filters, which is fine for "which page
            # arrived" but hides the applied filter P2 must prove in the DOM.
            # Titles are "VERIFY scene N", so a non-matching value gives count 0.
            # `tags` likewise, and it is the only way the tag-activation flow can
            # be checked: a dropped filter refetches page 1 that `listCache`
            # already holds, so the log looks identical either way. Measured —
            # without `workingFilterFor`, the log-based S5 stayed green.
            #
            # No scene carries a tag, so "filtered" is an empty listing; a build
            # that dropped the filter returns 40 rows, which cannot happen here.
            if ((entry["scene_filter"] or {}).get("tags") or {}).get("value"):
                return self._json({"data": {"findScenes": {"count": 0, "scenes": []}}})

            # The Continue Watching criterion, likewise: without it a build asking
            # for `last_played_at` but dropping the filter draws five healthy cards
            # and only the log would tell. Ids 41–45 are not 1–5, so the shelf
            # cannot be mistaken for Recently Added.
            resume = (entry["scene_filter"] or {}).get("resume_time") or {}
            if resume and resume.get("modifier") == "GREATER_THAN":
                value = resume.get("value")
                if isinstance(value, dict):
                    value = value.get("value")
                try:
                    threshold = float(value)
                except (TypeError, ValueError):
                    threshold = None
                if threshold is not None:
                    # A *threshold*, not a flag: `GREATER_THAN 0` means resume_time
                    # > 0, so 60 s rows answer any threshold below 60. 60 is inside
                    # the player's usable window, so a stale card still prompts.
                    rows = [dict(listing_scene(n), resume_time=60)
                            for n in range(41, 46) if 60 > threshold]
                    return self._json({"data": {"findScenes": {"count": len(rows), "scenes": rows}}})

            title = (entry["scene_filter"] or {}).get("title") or {}
            needle = title.get("value")
            if needle:
                # `includes` is the builder's text modifier; anything else is an
                # exact match, so an unexpected modifier yields an empty listing.
                if title.get("modifier") == "INCLUDES":
                    keep = [n for n in range(1, SCENE_COUNT + 1)
                            if needle.lower() in listing_scene(n)["title"].lower()]
                else:
                    keep = [n for n in range(1, SCENE_COUNT + 1)
                            if listing_scene(n)["title"] == needle]
                start = (entry["page"] - 1) * entry["per_page"]
                window = keep[start:start + entry["per_page"]]
                rows = [listing_scene(n) for n in window]
                return self._json({"data": {"findScenes": {"count": len(keep), "scenes": rows}}})

            # Free-text search, honoured so focus checks have rows that change; a
            # search leaving all forty would let a stolen focus pass.
            q = (entry["q"] or "").strip().lower()
            if q:
                keep = [n for n in range(1, SCENE_COUNT + 1)
                        if q in listing_scene(n)["title"].lower()]
                start = (entry["page"] - 1) * entry["per_page"]
                window = keep[start:start + entry["per_page"]]
                rows = [listing_scene(n) for n in window]
                return self._json({"data": {"findScenes": {"count": len(keep), "scenes": rows}}})

            start = (entry["page"] - 1) * entry["per_page"]
            rows = [
                listing_scene(i + 1)
                for i in range(start, min(start + entry["per_page"], SCENE_COUNT))
            ]
            return self._json({"data": {"findScenes": {"count": SCENE_COUNT, "scenes": rows}}})

        # ── The performer listing ──
        # `FindPerformers` had no handler, so every PerformerGrid fetch fell
        # through to the unhandled-query error while R9 still passed (it only
        # asserts the tab changed). Same 100 rows, page size and REQUESTS entry
        # shape as the scenes above, so one `pagesOf()` describes both.
        # Markers are not handled here: `findSceneMarkers` has its own handler
        # further down, and a duplicate early in the chain would shadow it.
        # Singular, matched on the full name: `"FindPerformer" in query` would
        # also swallow the listing below and make every grid a one-row answer.
        if "FindPerformerDetail" in query:
            pid = str(variables.get("id"))
            with LOCK:
                PERFORMER_FETCHES.append({"id": pid, "query": query})
                mode = MODE.get("performerDetail", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated profile fetch failure"}]})
            row = {**PERFORMER_DETAIL, "id": pid}
            if mode == "sparse":
                row.update(
                    gender=None, alias_list=[], career_start=None, career_end=None,
                    career_length=None, tattoos=None, measurements=None,
                    ethnicity=None, hair_color=None, eye_color=None, weight=None,
                    piercings=None, fake_tits=None, death_date=None,
                    o_counter=0, image_count=0, gallery_count=0,
                    urls=[], tags=[], rating100=None, favorite=False,
                )
            elif mode == "length-only":
                row.update(career_start=None, career_end=None, career_length="12 years")
            return self._json({"data": {"findPerformer": row}})

        # The performer profile's two writes. Logged before the mode is
        # consulted so a rejected attempt is distinguishable from no attempt.
        if "PerformerUpdate" in query or "performerUpdate" in query:
            inp = dict(variables.get("input") or {})
            with LOCK:
                PERFORMER_UPDATES.append({"input": inp})
                mode = MODE.get("performerUpdate", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated performer write failure"}]})
            if "rating100" not in inp and "favorite" not in inp:
                return self._json({"errors": [{"message": "VERIFY empty update input"}]})
            return self._json({"data": {"performerUpdate": {
                "id": str(inp.get("id")),
                "rating100": inp.get("rating100"),
                "favorite": inp.get("favorite"),
            }}})

        if "FindPerformers" in query:
            f = variables.get("filter") or {}
            entry = {
                "page": int(f.get("page") or 1),
                "per_page": int(f.get("per_page") or 40),
                "sort": f.get("sort"),
                "direction": f.get("direction"),
                "q": f.get("q") or "",
                "performer_filter": variables.get("performer_filter"),
            }
            with LOCK:
                REQUESTS.append(entry)
            start = (entry["page"] - 1) * entry["per_page"]
            rows = [
                listing_performer(i + 1)
                for i in range(start, min(start + entry["per_page"], PERFORMER_COUNT))
            ]
            return self._json({"data": {"findPerformers": {
                "count": PERFORMER_COUNT, "performers": rows}}})

        # The image viewer's info panel, above the four-section loop: `FindImages`
        # is one letter away, so ordering is cheaper than relearning that.
        if "FindImageInfo" in query:
            iid = str(variables.get("id"))
            with LOCK:
                IMAGE_INFO_FETCHES.append({"id": iid, "query": query})
                mode = MODE.get("imageInfo", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated image info failure"}]})
            # The studio name carries the requested id; other fields are identical,
            # so a stale answer under the next image would otherwise look right.
            return self._json({"data": {"findImage": {
                **IMAGE_INFO,
                "id": iid,
                "studio": {"id": "1", "name": f"VERIFY image studio {iid}"},
            }}})

        # ── The four browse-only sections ──
        # One handler each: log in the shared entry shape, slice the same 100-row
        # fixture. The claim is that each sends the right operation with the right
        # filter variable (`tag_filter`, `image_filter`, …), which REQUESTS records.
        # `FindTags` needs care: the marker form's picker sends the same name
        # below, distinguished by declaring `$filter` alone where the listing
        # always declares `$tag_filter`. A bare name match would shadow it.
        for section, var, key, count, listing in (
            ("Tags",      "tag_filter",     "tags",      TAG_COUNT,     listing_tag),
            ("Studios",   "studio_filter",  "studios",   STUDIO_COUNT,  listing_studio),
            ("Galleries", "gallery_filter", "galleries", GALLERY_COUNT, listing_gallery),
            ("Images",    "image_filter",   "images",    IMAGE_COUNT,   listing_image),
        ):
            if f"Find{section}" not in query:
                continue
            if section == "Tags" and var not in query:
                continue
            # One shelf's failure for the showroom error row: otherwise the whole
            # listing can only fail together, and a hidden shelf looks intended.
            if section == "Studios" and MODE.get("findStudios") == "fail":
                return self._json({"errors": [{"message": "VERIFY studios refused"}]})
            f = variables.get("filter") or {}
            entry = {
                "page": int(f.get("page") or 1),
                "per_page": int(f.get("per_page") or 40),
                "sort": f.get("sort"),
                "direction": f.get("direction"),
                "q": f.get("q") or "",
                var: variables.get(var),
            }
            with LOCK:
                REQUESTS.append(entry)

            # Images honours the galleries criterion S6 depends on: "still
            # filtered" is invisible in the log, because a dropped filter's
            # refetch is page 1 the cache already holds. Default: no image is in
            # a gallery, so filtered is empty and unfiltered is forty rows.
            # `galleryImages=populate` serves the gallery's own short set for the
            # slideshow. The honoured set is exactly what some check must see
            # take effect (`title`, `tags`, `galleries`), not what Stash supports.
            # Placed below the append: an early return skipped the log entry and
            # failed a check on a server doing the right thing.
            gallery_criteria = (variables.get(var) or {}).get("galleries") or {}
            if section == "Images" and gallery_criteria:
                with LOCK:
                    populate = MODE.get("galleryImages") == "populate"
                if not populate:
                    return self._json({"data": {"findImages": {"count": 0, "images": []}}})
                # One short page: background paging stops after the first fetch
                # and the check can wait for the slides to run out.
                gid = str((gallery_criteria.get("value") or ["0"])[0])
                rows = [
                    listing_gallery_image(gid, k)
                    for k in range(1, GALLERY_IMAGE_COUNT + 1)
                ]
                start = (entry["page"] - 1) * entry["per_page"]
                return self._json({"data": {"findImages": {
                    "count": len(rows),
                    "images": rows[start:start + entry["per_page"]],
                }}})

            start = (entry["page"] - 1) * entry["per_page"]
            rows = [
                listing(i + 1)
                for i in range(start, min(start + entry["per_page"], count))
            ]
            return self._json({"data": {f"find{section}": {"count": count, key: rows}}})

        # `FindScene` singular — the player's per-open resume refresh. After the
        # plural/detail checks above, because the name is a prefix of both.
        if "FindScene(" in query:
            with LOCK:
                resume = MODE.get("resume", 0)
                fail_state = MODE.get("findSceneState") == "fail"
            if fail_state:
                # The per-open state read: a failure makes resume, play count and
                # markers *unknown*, not absent, so it must be visible.
                return self._json({"errors": [{"message": "simulated state read failure"}]})
            return self._json({"data": {"findScene": {
                "id": variables.get("id"),
                # Driven by /mode so the per-open refresh can disagree with the
                # grid prop: a scene finished elsewhere reports 0 here.
                "resume_time": resume,
                "play_count": 0,
                "play_duration": 0,
                "files": [{"duration": 120.0}],
                # Three markers, two on TAG_A: the modal defaults to this scene's
                # most-used primary tag, which all-one-tag markers could not show.
                "scene_markers": [
                    {"id": "501", "seconds": 20.0, "primary_tag": TAG_A},
                    {"id": "502", "seconds": 40.0, "primary_tag": TAG_B},
                    {"id": "503", "seconds": 55.0, "primary_tag": TAG_A},
                ],
            }}})

        if "SceneSaveActivity" in query:
            entry = {
                "id": str(variables.get("id")),
                "resume_time": variables.get("resume_time"),
                "playDuration": variables.get("playDuration"),
            }
            with LOCK:
                SAVES.append(entry)
                mode = MODE.get("save")
            if mode == "fail":
                # Recorded *before* failing, so attempted-and-rejected is
                # distinguishable from never attempted.
                return self._json({"errors": [{"message": "simulated save failure"}]})
            if mode in ("slow", "slowlong"):
                # Held *after* recording, so the log shows the request on arrival
                # and a client-side queue differs from parallel sends. `slowlong`
                # makes the incoming scene accrue more than the outgoing owes.
                time.sleep(1.2 if mode == "slow" else 4.0)
            return self._json({"data": {"sceneSaveActivity": True}})

        # Appends a row per call, so the length of PLAY_ADDS is under test.
        if "SceneAddPlay" in query:
            entry = {
                "id": str(variables.get("id")),
                "times": variables.get("times"),
            }
            with LOCK:
                PLAY_ADDS.append(entry)
                mode = MODE.get("sceneAddPlay")
            if mode == "fail":
                # Delayed like sceneUpdate: the optimistic count must be readable
                # before the failure lands.
                time.sleep(1.2)
                return self._json({"errors": [{"message": "simulated play-count failure"}]})
            if mode == "slow":
                time.sleep(1.2)
            # The length *including* this call, independent of PLAY_ADDS. 7, not
            # play_count + 1 (3), so an optimistic guess (3 both ways) differs
            # from the server's answer.
            return self._json({"data": {"sceneAddPlay": {"count": 7}}})

        # "Clear progress": `reset_resume` and `reset_duration` are logged as
        # sent, and the answer is the bare Boolean the schema declares — a
        # `{ count }` body would parse here and 400 against the real server.
        if "SceneResetActivity" in query:
            entry = {
                "id": str(variables.get("id")),
                "reset_resume": variables.get("reset_resume"),
                "reset_duration": variables.get("reset_duration"),
            }
            with LOCK:
                ACTIVITY_RESETS.append(entry)
                mode = MODE.get("sceneResetActivity")
            if mode == "fail":
                # Delayed before failing: an instant failure leaves the optimistic
                # state unobservable, so rollback looks like "never changed".
                time.sleep(1.2)
                return self._json({"errors": [{"message": "simulated reset failure"}]})
            if variables.get("reset_resume"):
                with LOCK:
                    CLEARED_RESUME.add(str(variables.get("id")))
            return self._json({"data": {"sceneResetActivity": True}})

        # The driver's App asks for saved filters on every tab. The store starts
        # empty so the D-pad walk is not blocked by a filter dropdown.
        if "FindSavedFilters" in query:
            mode = variables.get("mode")
            with LOCK:
                items = [dict(f) for f in SAVED_FILTERS.get(mode, [])]
            # A failing read for the *new* mode: with the old rows kept, a scene
            # filter stays selectable under Performers after the switch fails.
            if MODE.get("savedFilters") == "fail":
                return self._json({"errors": [{"message": "simulated saved-filter failure"}]})
            return self._json({"data": {"findSavedFilters": items}})

        # The builder's two writes, logged so a driver can assert on what was
        # sent and on the read-back that proves it can be reopened.
        if "SaveFilter" in query:
            inp = variables.get("input") or {}
            mode = inp.get("mode")
            with LOCK:
                slow = MODE.get("filterSave") == "slow"
            # Delayed before the reply, so the prompt's saving state is
            # observable long enough to press Back against it.
            if slow:
                time.sleep(1.5)
            with LOCK:
                bucket = SAVED_FILTERS.setdefault(mode, [])
                entry = {
                    "id": str(inp.get("id") or (len(bucket) + 1)),
                    "name": inp.get("name") or "",
                    "find_filter": inp.get("find_filter"),
                    "object_filter": inp.get("object_filter"),
                    # Which mode filed it, so a scene filter filed as a marker one
                    # cannot hide behind the bucket it landed in.
                    "mode": mode,
                }
                existing = next(
                    (i for i, f in enumerate(bucket) if f["id"] == entry["id"]), None,
                )
                if existing is None:
                    bucket.append(entry)
                else:
                    # An id means update; appending would report success for a
                    # mutation that forked a duplicate.
                    bucket[existing] = entry
                FILTER_WRITES.append({"op": "save", **entry})
            return self._json({"data": {"saveFilter": {
                "id": entry["id"], "name": entry["name"],
                "find_filter": entry["find_filter"],
                "object_filter": entry["object_filter"],
            }}})

        if "DestroySavedFilter" in query:
            fid = str((variables.get("input") or {}).get("id"))
            with LOCK:
                hit = False
                for bucket in SAVED_FILTERS.values():
                    for i, f in enumerate(bucket):
                        if f["id"] == fid:
                            bucket.pop(i)
                            hit = True
                            break
                FILTER_WRITES.append({"op": "destroy", "id": fid, "hit": hit})
            # `false` is a real failure and the fake must produce one: deleting a
            # nonexistent id asserts the app handles it.
            return self._json({"data": {"destroySavedFilter": hit}})

        if "SceneUpdate" in query:
            with LOCK:
                mode = MODE["sceneUpdate"]
            if mode == "fail":
                # Delayed before failing: an instant rollback lands in the same
                # tick, so it looks like "never changed".
                time.sleep(1.2)
                return self._json({"errors": [{"message": "simulated write failure"}]})
            if mode == "slow":
                time.sleep(1.2)
            inp = variables.get("input") or {}
            out = {
                "id": SCENE["id"],
                "rating100": inp.get("rating100", SCENE["rating100"]),
                "organized": inp.get("organized", SCENE["organized"]),
            }
            return self._json({"data": {"sceneUpdate": out}})

        # The marker form's tag picker, told apart from the Tags section's query
        # by the absence of `tag_filter` (that one is handled above). Name
        # matching is the rule here; the exclusion is belt-and-braces against
        # answering the section with three `Harness Tag` rows.
        if "FindTags" in query and "tag_filter" not in query:
            return self._json({"data": {"findTags": {
                "count": len(TAG_LISTING),
                "tags": TAG_LISTING,
            }}})

        if "RecentMarkerTags" in query:
            with LOCK:
                empty = MODE.get("recentTags") == "none"
            return self._json({"data": {"findSceneMarkers": {
                "scene_markers": [] if empty else [{"primary_tag": t} for t in RECENT_TAGS],
            }}})

        # The Markers tab: two markers on two different scenes, with the fields
        # deliberately apart — scene.paths.screenshot is a real frame, while
        # marker.screenshot is the always-returned placeholder above. Which one
        # the card renders is the whole fix. `/mode markers=paged` swaps in a
        # 100-row listing for the usePagedList migration; the default stays two
        # rows so every markerfix check is unaffected.
        if "FindSceneMarkers" in query:
            with LOCK:
                paged = MODE.get("markers") == "paged"
            if paged:
                f = variables.get("filter") or {}
                entry = {
                    "page": int(f.get("page") or 1),
                    "per_page": int(f.get("per_page") or 40),
                    "sort": f.get("sort"),
                    "direction": f.get("direction"),
                    "q": f.get("q") or "",
                    "scene_marker_filter": variables.get("scene_marker_filter"),
                }
                with LOCK:
                    REQUESTS.append(entry)
                start = (entry["page"] - 1) * entry["per_page"]
                rows = [
                    listing_marker(i + 1)
                    for i in range(start, min(start + entry["per_page"], MARKER_COUNT))
                ]
                return self._json({"data": {"findSceneMarkers": {
                    "count": MARKER_COUNT, "scene_markers": rows}}})

            def marker(mid, scene_id):
                return {
                    "id": mid,
                    "title": f"Marker {mid}",
                    "seconds": 12.0,
                    "end_seconds": None,
                    "screenshot": f"/scene/{scene_id}/scene_marker/{mid}/screenshot",
                    "scene": {
                        "id": str(scene_id),
                        "title": f"VERIFY scene {scene_id}",
                        "paths": {
                            "screenshot": f"/scene/{scene_id}/thumb.png",
                            "stream": f"/tone{scene_id}.wav",
                            "sprite": None,
                            "vtt": None,
                        },
                        "performers": [],
                    },
                    "primary_tag": TAG_A,
                    "tags": [],
                }
            rows = [marker(9001, 1), marker(9002, 2)]
            return self._json({"data": {"findSceneMarkers": {
                "count": len(rows), "scene_markers": rows,
            }}})

        if "SceneMarkerCreate" in query:
            inp = variables.get("input") or {}
            with LOCK:
                MARKER_CREATES.append(inp)
                mode = MODE.get("markerCreate")
            if mode == "fail":
                # A create has no prior state to roll back to, so the client must
                # keep the form and say why; success-shaped data would hide that.
                return self._json({"errors": [{"message": "simulated marker write failure"}]})
            tag_id = inp.get("primary_tag_id")
            return self._json({"data": {"sceneMarkerCreate": {
                "id": "7001",
                "seconds": inp.get("seconds"),
                "primary_tag": {"id": tag_id, "name": TAG_NAMES.get(tag_id, "?")},
            }}})

        if "SceneAddO" in query:
            with LOCK:
                O_COUNT[0] += 1
                count = O_COUNT[0]
                O_CALLS.append({"op": "add", "id": str(variables.get("id")), "count": count})
                o_mode = MODE.get("sceneAddO", "ok")
                first = len(O_CALLS) == 1
            # Only the *reply* is held, so two presses answer out of order: the
            # first carries 1 and arrives last, over the second press's 2.
            if o_mode == "slow-first" and first:
                time.sleep(1.2)
            return self._json({"data": {"sceneAddO": {"count": count}}})
        if "SceneDeleteO" in query:
            with LOCK:
                O_COUNT[0] = max(0, O_COUNT[0] - 1)
                count = O_COUNT[0]
                O_CALLS.append({"op": "delete", "id": str(variables.get("id")), "count": count})
            return self._json({"data": {"sceneDeleteO": {"count": count}}})
        if "SceneResetO" in query:
            with LOCK:
                O_COUNT[0] = 0
                O_CALLS.append({"op": "reset", "id": str(variables.get("id")), "count": 0})
            # A bare `Int!`, like the real resolver: an object would pass here and
            # fail on the TV with a selection-set validation error.
            return self._json({"data": {"sceneResetO": 0}})

        return self._json({"errors": [{"message": f"unhandled query: {query[:60]}"}]})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
