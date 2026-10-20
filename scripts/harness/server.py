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

# behaviour, flipped by the driver via POST /mode.
#   save / sceneAddPlay  "fail"  → the write comes back as a GraphQL error
#   resume               number  → the resume_time the per-open findScene reports
#   findSceneState       "fail"  → that per-open read comes back as an error
#   oSeed                number  → the o-counter's starting value, and it also
#                                  clears the call log (see the /mode handler)
MODE = {
    "sceneUpdate": "ok", "findScenes": "ok", "markerCreate": "ok", "recentTags": "ok",
    "save": "ok", "sceneAddPlay": "ok", "sceneResetActivity": "ok",
    # sceneAddO: "slow-first" holds the first reply back for 1.2 s after the
    # increment, so two rapid presses answer out of order — the stale 1 arriving
    # after the fresh 2. Only the reply is delayed; see the handler.
    "sceneAddO": "ok",
    # findPerformer (the detail page's profile fields): "sparse" answers with
    # every optional field empty; "length-only" clears the career bounds but
    # keeps career_length; "slow" and "fail" delay, so the card-first paint and
    # the failure path are both observable.
    "performerDetail": "ok", "resume": 0, "oSeed": 0,
    # performerUpdate: "slow" holds the answer long enough to see the
    # optimistic value with the request still in flight; "fail" is the rollback
    # path.
    "performerUpdate": "ok",
    # findImage (the viewer's info panel): "slow" keeps the loading state on
    # screen; "fail" is the panel's error state.
    "imageInfo": "ok",
    # findImages filtered by a gallery (the gallery slideshow): "empty" is the
    # long-standing behaviour every Images check depends on — a filtered
    # listing has no rows, so "still filtered" is visible. "populate" serves a
    # small set of images belonging to the requested gallery, which is the only
    # way a slideshow opened from a gallery card has anything to advance
    # through. Opt-in rather than default, because Sections S6 is exactly the
    # assertion the empty answer exists to make.
    "galleryImages": "empty",
    # stopJob: "slow" holds the button in flight; "fail" is a transport error;
    # "false" is the server refusing (StopJob returns Boolean!), which the app
    # must treat as a failure rather than a stop.
    "stopJob": "ok",
    # "ok" serves real playable bytes at /scene/{n}/preview; "missing" 404s
    # them, which is what this server actually does for every scene nobody has
    # run Stash's Generate > Previews on.
    "preview": "ok",
    # sceneStreams: "ok" advertises the eight endpoints Stash does, pointing at
    # playable bytes; "empty" is a server with transcoding switched off, which
    # is the case where the player must fail *visibly* rather than spin;
    # "slow" delays the answer so the player's src is still null while the
    # user can press play — the window in which a play() on a source-less
    # element answers NotSupportedError.
    "streams": "ok",
    # markers: "paged" serves a 100-row paginated marker listing; the default
    # (anything else) serves the Markers tab's two deliberate rows. See the
    # findSceneMarkers handler for why both are needed.
    "markers": "ok",
    # stats / serverStatus: the two read-only Settings panels. "slow" and
    # "fail" make their loading and error states observable. "migrated" gives
    # the status panel a *different* answer on a Refresh press.
    "stats": "ok", "serverStatus": "ok",
    # sceneMarkers: "empty" strips the detail page's marker row, so the
    # no-markers render path is reachable without a second scene fixture.
    "sceneMarkers": "ok",
}
LOCK = threading.Lock()

# Screenshot support. Firefox's `--headless --screenshot` captures on the load
# event, so the index page carries a hidden <img src="/hold.png"> while the
# driver navigates. This route blocks until the driver says the screen is
# ready. The timeout is a safety net: a driver that crashes still lets the
# shot through (and the screenshot then shows whatever was on screen, which is
# diagnosable) instead of hanging the capture forever.
SHOT_READY = threading.Event()
# A 1x1 transparent PNG — the hold image is display:none; only its pending
# load matters.
_BLANK_PNG = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    b"YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

# Every findScenes call this run, in order. The list harness reads this back
# at /requests: the paging logic's observable contract is *which pages get
# asked for, with what*, and a rendered row count alone cannot distinguish
# "fetched page 2" from "fetched page 2 twice".
REQUESTS = []

# Every GraphQL operation this run, in order, by name — `/graphqlcalls`.
#
# Separate from REQUESTS above, which is only findScenes and carries its filter
# for the paging assertions. This one answers a different and blunter question:
# *did anything get asked at all*. It exists for the first-run gate, where the
# contract is that with setup unanswered the app is not mounted and therefore
# issues no request of any kind — a claim about every operation, not about one.
# Asserting it against a per-operation log would mean enumerating the operations
# to check for, and the one that got forgotten would be the one that fired.
GRAPHQL_CALLS = []
OP_RE = re.compile(r"\b(?:query|mutation)\s+(\w+)")

# Every sceneSaveActivity call this run, in order — `{id, resume_time}`.
#
# The player's saves are the one thing in this app that can quietly write
# *wrong data* to the user's library rather than merely misdraw a screen, so
# they are worth asserting on directly: what matters is which scene got which
# position, and in particular that advancing the queue does not report 0 for
# the scene that just finished.
SAVES = []

# The saved-filter store: `{id, name, find_filter, object_filter}`, one list per
# FilterMode, plus a log of every write that touched it.
#
# Until the filter builder existed there was nothing in the app that could
# create a saved filter, so this returned a hardcoded `[]` and every driver
# mounted App with an empty dropdown — which was the right answer then and is
# still the right *default*. The store starts empty on every run, so the
# drivers that only care about the D-pad walk are unaffected; only a driver
# that deliberately saves something sees a dropdown with anything in it.
#
# `object_filter` is echoed back verbatim rather than round-tripped through any
# parsing. That is deliberate: the one thing this store must be able to prove
# is that what the builder wrote is what comes back, and a fake that
# normalised the shape on the way through would hide exactly the corruption
# the check exists to catch. The probe against the *real* server
# (scripts/probe-filter-write.mjs) is what settles whether Stash itself
# preserves it.
SAVED_FILTERS = {}
FILTER_WRITES = []


# Every sceneAddPlay call this run, in order — `{id, times}`.
#
# The play count is the one write whose contract is a *count of requests* as much
# as their content. A version that fired on every buffer stall, on every resume
# from a pause, or on every 30s save would still leave a plausible play_count on
# the server; only the request log can tell exactly-once from
# once-per-something-that-happens-a-lot. Hence this list, and the check that
# reads its length.
PLAY_ADDS = []

# Every sceneResetActivity call this run, in order — `{id, reset_resume,
# reset_duration}`.
#
# The two flags are the whole contract. "Clear progress" must reset the resume
# point and *only* the resume point: watch time is history, and a request that
# sent `reset_duration: true` would erase it while looking identical on screen.
# Only the log can tell the two apart, hence the flags are recorded verbatim.
ACTIVITY_RESETS = []

# ── The o-counter ────────────────────────────────────────────
#
# The one handler here that has to *remember*. The o-counter is a tally, and
# what separates "each press adds one" from "each press toggles" is the sequence
# 0 → 1 → 2 — a handler that returned a constant could not tell the two apart,
# whatever the client did with the answer.
#
# `oSeed` therefore exists for two jobs: to give the checks a starting value,
# and to let the server *disagree* with what the page is showing. That second
# one is what keeps "the number on screen came from the response" observable,
# which the old fixed-3 handler proved by being unguessable.
O_COUNT = [0]

# Every o-counter call this run, in order — `{op, id, count}`.
#
# A toggle and a tally produce the *same screen* for a press made at zero. Only
# the log separates them: a toggle shows one add followed by a delete, a tally
# shows two adds and no delete.
O_CALLS = []

# Every /scene/{id}/preview request this run, in order.
#
# The preview's whole cost story is *which* scenes get asked for. A card that
# probed on focus alone would log one entry per card the D-pad crossed; one
# that memorises its failures logs each scene at most once per run. Neither is
# visible in what the DOM ends up showing, so the log is the only place the
# difference exists.
PREVIEW_FETCHES = []

# Every sceneStreams call this run, in order — the scene id.
#
# The codec fallback is only cheap if the *ordinary* play path never asks: a
# scene the TV can decode should go straight to its own file, with no round
# trip and no server-side ffmpeg. That is a claim about a request that must
# not happen, which nothing in the DOM can show, so it is logged here.
STREAMS_FETCHES = []

# Every request for a *transcoded* media URL this run, in order — the full
# path, so the format is visible in the entry.
#
# This log exists because of the one claim about transcoding the DOM cannot
# settle. Headless Firefox has no HLS support in a `<video>`, so whichever
# source the player ends up on, the element's final `src` cannot say whether
# HLS was *preferred* and lost, or never tried. The order of the requests can:
# an HLS playlist fetched before any MP4 bytes is the player choosing HLS
# first, observed rather than argued from a pure function's return value.
STREAM_FETCHES = []

# Every sceneMarkerCreate call this run, in order — the `input` object verbatim.
#
# The marker form's whole contract is the payload: which scene, which second,
# which tag, and what the title falls back to when the label is left empty. A
# rendered "marker added" would be equally consistent with writing the wrong
# tag or the wrong second, so the assertion has to be on what was sent.
MARKER_CREATES = []

# The fake scene. rating100 is 70 while SCENE.rating in the driver is "5.0",
# so the page's painting of the card value is distinguishable from the
# server value.
SCENE = {
    "id": "4242",
    "title": "VERIFY — detail page harness",
    "code": "HARNESS-1",
    "details": "A details block, present so the clamp has something to clamp.",
    "date": "2024-03-09",
    "rating100": 70,
    "organized": False,
    # Starts at 0 so the driver can exercise the *add* direction first. The
    # counter is a toggle — a scene that already has likes un-likes on press
    # — so starting non-zero would silently test the opposite branch.
    "o_counter": 0,
    "play_count": 2,
    "play_duration": 4510,
    # Non-zero so the page offers "Clear progress" enabled, exactly as it
    # would for a scene the user stopped half way. The card prop the driver
    # hands the page says 0, so the resume bar appearing at all is evidence
    # the detail fetch replaced the card's guess.
    "resume_time": 1800,
    "last_played_at": "2024-05-01T10:00:00Z",
    "urls": ["https://example.invalid/a", "https://example.invalid/b"],
    "studio": {"id": "1", "name": "Harness Studio"},
    "tags": [{"id": str(i), "name": f"tag-{i}"} for i in range(10)],
    "performers": [{"id": "1", "name": "Performer One"}],
    # Two, so the chip row's focus walk has somewhere to go; none of the
    # listing's galleries share these ids, so "selected the scene's gallery"
    # and "selected some gallery off a different tab" are distinguishable.
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
    # Deliberately out of order (1905, 125, 640): the normalizer sorts them,
    # and a fixture already in order would let a missing sort pass. Titles and
    # tags differ, so the chip's label choice is observable too.
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
# The four browse-only sections' artwork: /tag/{n}/image.png,
# /studio/{n}/image.png, /gallery/{n}/cover.png and /image/{n}/{thumb,full}.png.
# One route rather than four because the four differ only in the tint the
# handler paints — see do_GET. Anchored on the section name rather than on the
# filename so it cannot swallow the scene thumbnail above.
ENTITY_IMG_RE = re.compile(
    r"/(tag|studio|gallery|image)/(\d+)/(?:image|cover|thumb|full)\.png(\?[^#]*)?")
# /scene/{id}/stream.mp4 — one of the transcoded endpoints sceneStreams
# advertises. See do_GET.
STREAM_MP4_RE = re.compile(r"/scene/\d+/stream\.mp4(\?[^#]*)?")
# /scene/{id}/stream.m3u8 — the playlist — and /scene/{id}/stream.m3u8/{n}.ts,
# its segments. Both shapes are served, because a 404 on the playlist would
# make the fallback test depend on a *server fault* when the fact under test
# is the *engine's* refusal: Firefox fetches and parses this happily and then
# cannot play it, which is the situation a TV that dislikes HLS would also be
# in — and the situation the MP4 candidate exists for. Group 1 is the scene
# id, group 2 the segment index (absent for the playlist itself).
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


def _png(rgb):
    """A solid-colour 8x8 PNG."""
    import struct, zlib

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    raw = b"".join(b"\x00" + bytes(rgb) * 8 for _ in range(8))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


# Every marker's own screenshot, as one image.
#
# Not a stylistic choice — it is the whole reason the marker grid had a bug. The
# live server answers 200 for an ungenerated marker screenshot with a built-in
# "Pending Generate" placeholder, and all 332 markers returned the same 1199
# bytes. A fake that served per-marker images would make the buggy build (marker
# frame preferred) and the fixed build (parent scene frame preferred) render
# *differently*, which is what a check needs — but it would be modelling a
# server that does not exist. What the fake has to reproduce is the pair: one
# identical placeholder for every marker, and a real per-scene frame behind it.
PLACEHOLDER_PNG = _png((0x18, 0x20, 0x26))

# ── Tags, for the marker form ────────────────────────────────
# The library's most-used tag is C, while the *scene's* most-used is A. The
# form must open on A. If it opened on C, the marker would be filed under a tag
# this scene has never used, and a check that only asserted "something is
# selected" would not notice — so the two have to differ.
TAG_A = {"id": "9001", "name": "Harness Tag A"}
TAG_B = {"id": "9002", "name": "Harness Tag B"}
TAG_C = {"id": "9003", "name": "Harness Tag C"}

# Library order, most used first. C leads.
TAG_LISTING = [
    {**TAG_C, "scene_marker_count": 268},
    {**TAG_A, "scene_marker_count": 40},
    {**TAG_B, "scene_marker_count": 12},
]

# What the "recently used" row reports, newest first. Deliberately (C, B) —
# an order that no slice of TAG_LISTING produces, so a recent row that was
# really just the library list would fail the order assertion rather than
# coincidentally matching it.
RECENT_TAGS = [TAG_C, TAG_B]

# Echoed back on create, so the confirmation the player shows carries the tag
# the user actually picked rather than whatever the server felt like saying.
TAG_NAMES = {t["id"]: t["name"] for t in (TAG_A, TAG_B, TAG_C)}

# ── A deterministic listing, for the pagination harness ──────
# 100 rows against a page size of 40: page 1 and page 2 are full, page 3 is
# short, and page 4 must never be asked for. That short page is what makes
# "stops once it holds every row" observable rather than assumed.
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
        # stream is right for. A listing whose files carried no codec at all
        # would leave every harness check on the *transcode* path, and the
        # ordinary path would go untested by everything that uses this server.
        # The unplayable-codec cases are built by hand in codec-entry.jsx.
        "files": [{
            "duration": 120.0, "width": 1920, "height": 1080,
            "video_codec": "h264", "audio_codec": "aac", "format": "mp4",
        }],
        # A real, playable file rather than null: the player harness needs
        # `ended` and a moving currentTime to exist at all. It is a silent
        # WAV generated by run.sh — see the note there.
        #
        # The URL is *per scene* even though the bytes are shared, and that
        # is load-bearing rather than cosmetic. React only rewrites an
        # attribute whose value changed, so a single shared URL would leave
        # the media element sitting on the scene it already had: no load, no
        # reset of currentTime, and the resume-save bug this harness exists to
        # catch would be *invisible* rather than absent. See do_GET.
        # `preview` is a per-scene URL for the same reason `stream` is: React
        # rewrites an attribute only when its value changes, so a shared URL
        # would leave the previous scene's element in place and the check
        # "this card previewed *its own* scene" would pass on stale state.
        #
        # `screenshot` is served too, unlike the stream rows above: the bug
        # class under test is the *cover* being hidden behind a preview that
        # never loads, and a card with no cover at all cannot show that.
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


# ── The same listing shape for the two grids nothing covered ──
# MarkerGrid and PerformerGrid carried hand-rolled copies of the pagination
# usePagedList now owns, and the harness could not see either of them: with no
# fixture here both operations fell through to the unhandled-query error, so no
# driver had ever rendered these two components at all. Found while migrating
# them, which is what made "verify by differential diff" an instruction with
# nothing behind it. Same 100 rows at the same page size as the scenes above,
# so one driver and one `pagesOf()` describe all three listings.
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


# Every findPerformer (singular) call this run, in order — `{id, query}`.
# The query text is kept because the point of the detail fetch is also that it
# stays *narrow*: the check is the presence of the profile fields and the
# absence of the ones the card already carries.
PERFORMER_FETCHES = []

# Every performerUpdate mutation this run, `{input}`. The input is the whole
# contract: which performer, and which field moved to which value.
PERFORMER_UPDATES = []

# Every FindImageInfo query this run, `{id, query}`. The query text is kept so
# a check can prove the client asked for `visual_files` — asking for `files`
# is invalid on Image and the fake would happily answer either.
IMAGE_INFO_FETCHES = []

# Every stopJob mutation this run, `{job_id, query}`, and the ids a successful
# stop removed from the fake queue. `/clear` resets both, so each phase starts
# from the full fixture.
STOP_FETCHES = []
STOPPED_JOB_IDS = set()

# Deliberately adversarial against the two mistakes the page could make:
#   • the card says FEMALE and this says NON_BINARY, so "shows the card's
#     gender" and "adopted the server's" are distinguishable on screen;
#   • career_length is nonsense ("99 years") while the bounds are real, so a
#     formatter that ignores the bounds prints a value visible from the fixture
#     rather than from a coincidence;
#   • the URL has a scheme and a path, so a host-only chip is provably not the
#     raw string.
# Every string contains VERIFY, so no check can pass on incidental page text.
#
# The enrichment in 0.29.0 adds a second set of adversarial values:
#   • `urls` has two entries on ONE host and four distinct hosts in total, so a
#     chip-per-URL (the naive fix) repeats a label and is visible, and the
#     3-chip cap plus "+1" is visible too;
#   • every free-text field is distinct and VERIFY-prefixed, so a fact row that
#     printed the wrong field cannot pass;
#   • the counts are non-zero and different from each other;
#   • rating/favourite are the values the write path must adopt, and they
#     disagree with the card (which the driver passes in as 0/unliked).
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

# Every LibraryStats / ServerStatus call, with the query text. Keeping the
# text lets a check prove the stats selection stays narrow and that the status
# query carries all three roots (the version arm below would happily answer a
# version-only subset).
STATS_FETCHES = []
STATUS_FETCHES = []
# Every metadataScan mutation, with its variables. The variables are the whole
# point of W2c: the client must copy the instance's saved scan defaults into
# `input`, so a scan from the TV generates the artwork Stash is configured to
# generate instead of silently generating nothing.
SCAN_FETCHES = []
# Every read of the saved scan options (`configuration.ui` and the legacy
# `configuration.defaults.scan`). Counted separately so a check can prove the
# options are read once per press, at press time.
SCAN_DEFAULTS_FETCHES = []

# Two blocks, as on a real 0.31.1 server:
#
#   SCAN_DEFAULTS       configuration.defaults.scan — the legacy system block.
#   SCAN_UI_DEFAULTS    configuration.ui.taskDefaults.scan — what Stash's own
#                       scan-page checkboxes save, and therefore what a user
#                       who changed an option actually changed.
#
# The two differ in every field on purpose. 0.22.0 read only the first and
# sent the system values while the UI showed the user's; W2c fails if that
# comes back. Each set is mixed rather than all-true/all-false so a client
# that sends `{}`, hardcodes a set, or drops a field is visible in the input.
# The "alt" variants prove the values are read, not memorised at build time.
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

# Every FindSceneDetail query this run, with its text. The marker checks need
# to distinguish "the page reads markers from the detail query" from "the
# detail query widened to carry artwork it does not draw".
DETAIL_FETCHES = []

# Numbers chosen so a formatting mistake is visible on screen:
#   1,234 / 98,765 / 4,321 prove comma grouping;
#   1.5 GiB + 1 GiB = 2.5 GiB, so summing only one size is wrong by a visible
#   amount;
#   4,501,800 s and 9,001,800 s are 1,250.5 h and 2,500.5 h, so flooring shows
#   1,250 / 2,500 and rounding shows 1,251 / 2,501.
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

# NEEDS_MIGRATION with a schema gap, plus a finished job that the panel must
# filter out. `migrated` (selected via /mode) is the "changed after Refresh"
# answer: healthy schema, same version, no jobs.
SERVER_STATUS = {
    "version": {"version": "0.31.1-harness"},
    "systemStatus": {"status": "NEEDS_MIGRATION", "appSchema": 31, "databaseSchema": 30},
    "jobQueue": [
        # Four subtasks: the row shows three, so the fourth's absence is a real
        # assertion rather than a coincidence of the fixture.
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
        # Failed jobs are shown but not stoppable; the error line is the only
        # thing on screen that can identify this row.
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
# Same 100 rows at the same page size as the three listings above, so one
# driver and one `pagesOf()` describe all seven.
#
# The real library's counts (533 / 27 / 792 / 31,251) are deliberately not
# mirrored. What the harness is for here is paging, and 31,251 images would be
# 782 pages of it for no extra coverage; 100 keeps page 1 and 2 full and page 3
# short, which is the shape that makes "stops once it holds every row"
# observable. A fixture that mirrored the real *ratios* would put Studios on a
# single short page and hide the paging path for exactly the section most
# likely to get it wrong.
#
# What the fixtures do carry is the four sections' structural differences,
# because those are what the descriptor exists to paper over and none of them
# would be visible in a homogeneous fixture:
#
#   Tag      has no `rating100` at all. A fixture with a rating would let a
#            card that wrongly reads one pass — the field is absent, not null.
#   Studio   rated *and* favourite-flagged, and its count sorts are singular
#            (`tag_count`) where Tag's are plural (`performers_count`). See the
#            sort-group notes in App.jsx; the fake does not validate sorts, so
#            this distinction is documented rather than enforced here.
#   Gallery  has `paths.cover` rather than `image_path`, and that is the whole
#            of the difference its service normalises.
#   Image    has both `paths.thumbnail` and `paths.image` — a card shows the
#            first and the viewer opens the second, so a fixture where they
#            were the same URL could not tell a viewer that had quietly been
#            wired to the thumbnail.
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
        # The carousel hero's description and aliases. Roughly half the rows
        # have each, so moving the focus reaches both the populated and the
        # empty blurb without a mode switch. Row 4 carries an overlong
        # description on purpose: the hero's two-line clamp can only be
        # measured on text that would otherwise overflow, and it has to sit in
        # the carousel's *first page* (five rows) or the driver cannot focus
        # it until the strip pages in more.
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
        # The service divides this by ten, so the card prints one decimal place
        # and a fixture of 50 everywhere would make every studio read "★ 5.0" —
        # which passes on a card that never divided at all. Varied on purpose.
        "rating100": (n * 7) % 101,
        "scene_count": n,
        "image_count": (n * 3) % 71,
        "gallery_count": n % 11,
        "tag_count": n % 19,
        "child_count": n % 4,
        "organized": n % 2 == 0,
        # The hero's parent/aliases/details. Each appears on a different
        # residue so all four combinations (all, some, none) are reachable by
        # walking a few cards. Row 5's details are overlong so the blurb's
        # two-line clamp is measurable; see the note on the tag fixture.
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
        # The card's second line and the hero's meta. Studio is on a third of
        # the rows, photographer on a quarter, the folder always — so the
        # subtitle's fallback order is observable by walking three cards.
        "studio": (
            {"id": str(n), "name": f"VERIFY gallery studio {n}"}
            if n % 3 != 0 else None
        ),
        "photographer": f"VERIFY photographer {n}" if n % 4 == 0 else None,
        "folder": {"basename": f"VERIFY folder {n}"},
    }


# How many pictures the populated-gallery fixture holds. Small on purpose: the
# slideshow advances on a 6 s timer, and the checks want to watch it move and
# then run out, which a 40-row page would make a 4-minute test.
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
            # for. run.sh reads the file: releasing a *failed* screen's hold
            # would still produce a valid-looking PNG of whatever was up.
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
                # A seed is a test setup, so it resets the tally *and* the log:
                # reading 0 → 1 → 2 has to start from a known state, and a log
                # with an earlier test's presses still in it would count them.
                if "oSeed" in payload:
                    O_COUNT[0] = int(payload["oSeed"])
                    O_CALLS.clear()
            return self._json(MODE)

        if self.path == "/clear":
            with LOCK:
                REQUESTS.clear()
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
                # The saved-filter store goes too. A driver that reaches for
                # /clear between phases is starting a new test, and a filter
                # left over from the last one would show up in the dropdown as
                # an entry that test never created.
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
        # The preview route. Logged before the mode is consulted, so that a
        # check can tell "did not ask" from "asked and was refused" — the
        # failure this harness is built around is a card that asks for a
        # preview it has already learned does not exist.
        m = PREVIEW_RE.fullmatch(self.path)
        if m:
            with LOCK:
                PREVIEW_FETCHES.append(m.group(1))
            if MODE.get("preview") == "ok":
                # Real, decodable bytes rather than a 200 with an empty body:
                # the guard under test keys off the element's own `playing`
                # event, and a file that cannot produce one would make the
                # success path and the failure path identical.
                self.path = "/tone.wav" + (m.group(2) or "")
                return super().do_GET()
            # Same shape as Stash's real answer for an ungenerated preview.
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"404 page not found")
            return
        # A transcoded endpoint, answered with the same silent WAV the direct
        # streams use. That is enough for what is being asserted: *which* URL
        # the element was pointed at, and that the bytes behind it load — the
        # element cannot tell an mp4 from a wav, and neither can this harness.
        # What it must not be is a 404, or "the fallback worked" would be
        # indistinguishable from "the fallback was never needed".
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
                # Both of the headers that make HLS *seekable* on the real
                # server, and the pair the MP4 endpoint does not send. Present
                # here so the fixture is not accidentally modelling the broken
                # endpoint it exists to contrast with.
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                self.wfile.write(blob)
                return
            # A segment. Same silent WAV as everything else — the point of the
            # route is that it exists and is fetchable, since "the segment was
            # missing" is a server fault and not the engine refusal under test.
            self.path = "/tone.wav"
            return super().do_GET()

        # A source that accepts the connection and then says nothing at all.
        # This is the failure the codec list cannot see: an engine that does
        # not reject the file, merely never decodes it. The player's stall
        # watchdog is the only thing that can notice, so there has to be a URL
        # that hangs to notice it on.
        if HANG_RE.fullmatch(self.path):
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
            # Coloured from the section *and* the id, so that the same row
            # number in two sections is two different pictures. A fake that
            # keyed on the id alone would let a card that asked for the wrong
            # section's image pass any check that only asked "did an image
            # load" — and two of these four sections genuinely do share a
            # numeric id space in the fixture.
            kind = m.group(1)
            n = int(m.group(2))
            tint = {"tag": 0x00, "studio": 0x40, "gallery": 0x80, "image": 0xC0}[kind]
            # `/image/{n}/full.png` is a *different* colour from the thumbnail
            # of the same row, which is what makes "the viewer opened the full
            # image rather than the thumbnail" a checkable claim.
            full = 0x30 if m.group(0).endswith("full.png") else 0x00
            return self._png_response(
                _png(((0x30 + tint + (n * 37) % 160) & 0xFF, 0x50 + full, 0x60)))
        m = THUMB_RE.fullmatch(self.path)
        if m:
            # Coloured from the scene id, so that two scenes' screenshots are
            # distinguishable bytes rather than one image behind many URLs. A
            # fake serving a single image everywhere would let a build that
            # rendered every tile from the same source pass any check that only
            # asked "did an image load".
            n = int(m.group(1))
            return self._png_response(_png((0x30 + (n * 37) % 200, 0x50, 0x60)))
        # One file, many URLs: /tone7.wav serves the same silent WAV as
        # /tone.wav. See listing_scene for why the URL has to differ per scene.
        m = TONE_RE.fullmatch(self.path)
        if m:
            self.path = "/tone.wav" + (m.group(1) or "")
        return super().do_GET()

    def _graphql(self, payload):
        query = payload.get("query") or ""
        variables = payload.get("variables") or {}

        # Logged before dispatch, so an operation the fake does not recognise
        # still shows up. That is the whole point of the log: it is for proving
        # absence, and an unhandled query is exactly the kind that would slip
        # past a log written inside the handlers.
        m = OP_RE.search(query)
        with LOCK:
            GRAPHQL_CALLS.append(m.group(1) if m else query.strip()[:40])

        # The two Settings panels. Both must sit *above* the anonymous
        # connection-test arm below: the ServerStatus query contains
        # `version { version }`, so that arm would otherwise answer the combined
        # query with the version alone — the panel would show a version and
        # nothing else, and no error. This ordering is load-bearing.
        if "LibraryStats" in query:
            with LOCK:
                STATS_FETCHES.append(query)
                mode = MODE.get("stats", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated stats failure"}]})
            return self._json({"data": {"stats": dict(LIBRARY_STATS)}})

        # The saved scan options the Scan button must copy into its mutation.
        # Answered as the real 0.31.1 shape: the user's saved toggles live in
        # the `configuration.ui` JSON scalar (`ui.taskDefaults.scan`), and the
        # legacy system block sits beside it under `defaults.scan`. Both are
        # returned on every read so the client's preference order is testable:
        # "ok" and "alt" give it a UI block, "system" gives it none and must
        # fall back to `defaults.scan`.
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

        # Starting a scan. The real resolver returns the new job's `ID` — a
        # bare scalar, not an object — so the fake answers a bare scalar too;
        # a fake that agreed with a client guessing a shape would let an
        # invalid selection set pass here and fail only on the TV.
        if "LibraryScan" in query or "metadataScan" in query:
            with LOCK:
                SCAN_FETCHES.append({"query": query, "variables": variables})
                mode = MODE.get("scan", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated scan failure"}]})
            return self._json({"data": {"metadataScan": "job-scan-1"}})

        # Stopping a job. `stopJob(job_id: ID!): Boolean!` — the answer is the
        # whole result, and `false` is a refusal the app must not read as a
        # stop. A successful stop removes the row from subsequent snapshots,
        # which is what makes the focus-before-refresh rule observable: the
        # row the D-pad was on genuinely goes away.
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

        # The connection test. The setup screen's Test and Connect buttons both
        # go through testStashConnection, which asks for nothing but the
        # version — and without this it fell through to the unhandled-query
        # error below, so the one screen whose whole job is establishing that a
        # server is reachable could not be driven past its own first button.
        #
        # Matched on the operation body rather than a name because the query is
        # anonymous: `{ version { version } }`.
        if "version {" in query or "version{" in query:
            # `slow` holds the answer long enough for the setup screen to be
            # asked twice: the first-run race is Connect still in flight when
            # Skip is pressed, and the late answer must not undo the Skip.
            if MODE.get("connection") == "slow":
                time.sleep(1.5)
            return self._json({"data": {"version": {"version": "0.31.1-harness"}}})

        # The filter builder's folder picker (a gallery's `parent_folder`
        # criterion names a folder id). Real paths, because the label is the
        # path's tail: the fixture must make the "last three segments" rule
        # visible rather than being satisfiable by a basename alone.
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
            # The id is echoed rather than left at the fixture's 4242: the
            # showroom driver opens scene 41 and then clears its progress, and
            # the app prunes *that* id from the shelf. A fake that answered
            # 4242 would make the write land on a scene the shelf never drew.
            scene = {**SCENE, "id": str(variables.get("id"))}
            # The per-open value the player fetches is MODE["resume"]; this is
            # the *detail page's* answer, kept separate so the two can
            # disagree. That disagreement is the stale-shelf case: the card a
            # listing is still holding says 0, the fresh detail fetch knows
            # the scene was resumed at 22, and Play must carry the latter.
            if MODE.get("detailResume") is not None:
                scene["resume_time"] = MODE["detailResume"]
            if MODE.get("sceneFile") == "rounding":
                # 3599.6 s is the formatter's trap: rounding only the seconds
                # remainder prints "59m 60s" instead of rolling over to 1h 0m.
                scene["files"] = [{**SCENE["files"][0], "duration": 3599.6}]
            with LOCK:
                DETAIL_FETCHES.append(query)
                if MODE.get("sceneMarkers") == "empty":
                    scene["scene_markers"] = []
                elif MODE.get("sceneMarkers") == "early":
                    # The per-scene markers the player tests jump to are at
                    # 20/40/55 s of a 60 s tone, but the *detail* fixture's
                    # markers are at 125/640/1905 s — beyond the media, so a
                    # seek to one clamps to the end and cannot distinguish
                    # "the chip seeked" from "the chip did nothing". This mode
                    # swaps in one marker that is inside it.
                    scene["scene_markers"] = [{
                        "id": "905", "seconds": 12, "end_seconds": 20,
                        "title": "VERIFY early marker",
                        "primary_tag": {"name": "VERIFY early tag"},
                    }]
            return self._json({"data": {"findScene": scene}})

        # The transcoder's menu, in the real order and with the real trap in
        # it. Copied from a live answer on 2026-10-16 (14 endpoints; the two
        # DASH entry points and the 480p tiers are dropped as noise). The
        # first two entries are *not* transcodes — `Direct stream` is the
        # scene's own file under another name and `MKV` is a remux of the same
        # codecs — and both are labelled `video/mp4` with no resolution
        # parameter, which is exactly why picking one by mime type hands the
        # element back the bytes it just refused.
        #
        # They are kept in the fixture because that is what makes the I2
        # assertion mean something: a resolver that chose either of them
        # produces a URL that does not contain `/stream.mp4`, and the check
        # written against the element's real src goes red.
        #
        # `empty` is not the shape of a scene without transcodes, it is the
        # shape of a server with the feature off.
        if "SceneStreams" in query:
            sid = str(variables.get("id"))
            with LOCK:
                STREAMS_FETCHES.append(sid)
                mode = MODE.get("streams")
            if mode == "empty":
                return self._json({"data": {"sceneStreams": []}})
            # The transport keys are live while this is in flight: the element
            # has no src yet, so it is the case a raw play() reports as
            # NotSupportedError. See the "streams" MODE comment.
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

        # Ordered before the rest because the detail query above is a
        # *different* operation ("FindScene", singular) — matching on the
        # plural would never fire for it, but matching lazily would let a
        # future single-scene query answer with a listing.
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
            # `slow-page-2` delays only the second page. The stale-response
            # test needs one request in flight while the list moves on, and
            # the *replacement* list must come back first — otherwise the
            # reset's own reply lands last and overwrites the bad append,
            # which makes the bug invisible rather than absent.
            if mode == "slow" or (mode == "slow-page-2" and entry["page"] == 2):
                time.sleep(1.0)
            # `fail-page-2` is the load-more failure the retry-loop check
            # needs: every page 2 answers with a GraphQL error. Page 1 stays
            # healthy so the list has rows on screen — the failure was
            # invisible precisely when rows existed.
            if mode == "fail-page-2" and entry["page"] == 2:
                return self._json({"errors": [{"message": "VERIFY page 2 refused"}]})
            # `empty-page-2` is the no-progress page: the count still says rows
            # exist, but page 2 adds none. The listing must stop there rather
            # than advance into page 3 — the harness proves it by scrolling to
            # the bottom and checking no page-3 request was made.
            if mode == "empty-page-2" and entry["page"] == 2:
                return self._json({
                    "data": {"findScenes": {"count": SCENE_COUNT, "scenes": []}}
                })
            # `short` is a listing that has ended: one full first row and a
            # second row holding one card. The rail driver's R11 needs that
            # last lone card, because it is the state in which the content
            # has *nothing* below the cursor and the only Down candidate left
            # is the Settings row fixed at the foot of the screen. That is
            # the reported drop into the sidebar, made deterministic.
            if mode == "short":
                rows = [listing_scene(n) for n in range(1, 6)]
                return self._json({"data": {"findScenes": {"count": 5, "scenes": rows}}})
            # A `title` criterion is honoured, for the filter-builder driver and
            # for nothing else. Every other fake handler ignores its filter and
            # returns the whole listing, which is fine when the question is
            # "which page arrived" — but it makes the *applied filter* invisible
            # in the DOM, and the applied filter is exactly what P2 has to
            # prove. Honouring one field is the smallest change that lets a
            # driver see a filter take effect in the rendered listing rather
            # than only in the request log.
            #
            # Titles are "VERIFY scene N", so a criterion value that matches
            # none of them is the useful case: it gives count 0. A driver
            # filtering on a word that appears in the title would pass on a
            # filter that did nothing.
            # A `tags` criterion is honoured for the same reason `title` is —
            # and unlike `title` it is the *only* way the tag-activation flow
            # can be checked at all. S5/S7 assert that Home is still filtered
            # after the tab switch, and neither the request log nor the rows can
            # show it otherwise: the unfiltered refetch that a dropped filter
            # triggers is page 1 of a listing `listCache` already holds from
            # mount, so no second request goes out and the log is identical
            # either way. Measured, not reasoned — with `workingFilterFor`
            # deleted from the activation, the log-based form of S5 stayed
            # green.
            #
            # No scene in this fixture carries a tag, so "filtered" means an
            # empty listing. That is the useful answer rather than a limitation:
            # a build that dropped the filter returns 40 rows, and 40 rows is
            # not something this branch can produce by accident.
            if ((entry["scene_filter"] or {}).get("tags") or {}).get("value"):
                return self._json({"data": {"findScenes": {"count": 0, "scenes": []}}})

            # The Continue Watching shelf's criterion, honoured for the same
            # reason as `title` and `tags` above: without it, a build that
            # asked for `last_played_at` while forgetting the filter would draw
            # five perfectly healthy cards and only the request log could tell.
            # Every fixture row has resume_time 0, so `GREATER_THAN 0` is a
            # criterion whose correct answer is a small subset. Ids 41–45 are
            # deliberately *not* 1–5, so the shelf cannot be mistaken for the
            # Recently Added shelf for fetching the same rows by accident.
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
                    # The criterion is a *threshold*, not a flag: `GREATER_THAN
                    # 0` means "resume_time > 0", so the fixture rows (60 s
                    # each) are the answer for any threshold below 60, and an
                    # empty row for one at or above it. 60 is also inside the
                    # player's usable-resume window for a 120 s fixture scene
                    # (above the 10 s floor, below duration − 30), which is
                    # what makes a *stale card* raise a resume prompt at all —
                    # see H22 in showroom-entry.jsx.
                    rows = [dict(listing_scene(n), resume_time=60)
                            for n in range(41, 46) if 60 > threshold]
                    return self._json({"data": {"findScenes": {"count": len(rows), "scenes": rows}}})

            title = (entry["scene_filter"] or {}).get("title") or {}
            needle = title.get("value")
            if needle:
                # `includes` is the modifier the builder produces for text;
                # anything else is treated as an exact match so an unexpected
                # modifier shows up as an empty listing rather than a full one
                # — a wrong answer, where the other way round is a passing test.
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

            # Free-text search, honoured so the listing driver's focus checks
            # have rows that actually change. A search that left all forty
            # rows in place would let a *stolen* focus pass as "the user's
            # element is still focused", because the card under the ring is
            # also still there.
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

        # ── The performer listing, which had no handler at all ──
        # PerformerGrid carried its own copy of the pagination `usePagedList`
        # owns, and nothing here answered `findPerformers` — so every fetch it
        # made fell through to the unhandled-query error at the bottom of this
        # method. rail-entry.jsx does reach the page (R9 focuses `nav-performers`
        # and presses Enter), which means that check has been switching to a tab
        # whose data fetch was erroring, and passing anyway: R9 asserts the tab
        # changed, and the tab changes whether or not its listing loads. A check
        # that passes for the wrong reason is worse than a missing one; adding
        # the handler is what lets it start meaning what it says.
        #
        # The migration also needs a diffable baseline, and there was none.
        # Same 100 rows at the same page size as the scenes above, logged into
        # the same REQUESTS list in the same entry shape, so the driver's
        # `pagesOf()` and its assertions describe both.
        #
        # Markers are *not* handled here: MarkerGrid shares the migration, but
        # `findSceneMarkers` already had a handler further down (the Markers-tab
        # fixture, whose two-row reply encodes the scene-screenshot vs
        # marker-screenshot distinction the markerfix checks turn on). That one
        # grows a `/mode` arm for the paginated listing instead of gaining a
        # second handler here — a duplicate placed early in the chain would
        # shadow it silently, which is exactly what happened when this block was
        # first written.
        # Singular, and matched on the full operation name: `"FindPerformer" in
        # query` would also swallow the 40-row listing below and silently make
        # every performer grid a one-row detail answer.
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

        # The image viewer's info panel. Placed above the four-section loop
        # because that loop matches `FindImages` — which is not a substring of
        # this operation's name, but the two are one letter apart and ordering
        # them deliberately is cheaper than re-learning that the hard way.
        if "FindImageInfo" in query:
            iid = str(variables.get("id"))
            with LOCK:
                IMAGE_INFO_FETCHES.append({"id": iid, "query": query})
                mode = MODE.get("imageInfo", "ok")
            if mode in ("slow", "fail"):
                time.sleep(1.2)
            if mode == "fail":
                return self._json({"errors": [{"message": "simulated image info failure"}]})
            # The studio name carries the requested id. Every other field is
            # identical across images, so a stale answer displayed under the
            # *next* image would otherwise be indistinguishable from the right
            # one — and that is precisely the race the driver's slow-mode
            # step-with-the-panel-open check exists to catch.
            return self._json({"data": {"findImage": {
                **IMAGE_INFO,
                "id": iid,
                "studio": {"id": "1", "name": f"VERIFY image studio {iid}"},
            }}})

        # ── The four browse-only sections ──
        # One handler each, in the same shape as the performer listing above:
        # log the request in the shared entry format, slice the same 100-row
        # fixture. Four sections that all page through `usePagedList` want four
        # identical handlers, and the thing being proved is that each one sends
        # the right operation with the right filter argument — which the shared
        # REQUESTS log answers, because the entry records the filter variable
        # the query used (`tag_filter`, `image_filter`, …).
        #
        # `FindTags` is the one that needs care. The marker form's tag picker
        # sends a query of the same *name* further down this method, and a
        # bare `"FindTags" in query` here would shadow it — the picker would
        # start receiving a paginated listing of `VERIFY tag N` rows and every
        # marker-form check would fail on a fixture change rather than a bug.
        # The two are told apart by what the picker does not have: it declares
        # `$filter` alone, while this listing always declares `$tag_filter`, so
        # the name is not enough and the discriminator is the variable.
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
            # One shelf's failure, for the showroom's error-row check: the
            # whole listing can otherwise only fail together, and "one row
            # vanished" was the bug — a hidden shelf looked like a shelf that
            # was never meant to be there.
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

            # Images honours the one criterion S6 depends on, for the same
            # reason the scene listing honours `tags`: "Images is still filtered
            # to the gallery it arrived with" is invisible in the request log,
            # because the refetch a *dropped* filter triggers is a page 1 the
            # cache already holds. By default no image in the fixture is in a
            # gallery, so "filtered" is an empty listing and "unfiltered" is
            # forty rows — two states a broken build cannot swap by accident.
            # `/mode galleryImages=populate` serves the gallery's own short set
            # instead, for the slideshow; that mode is off unless a driver asks
            # for it, so S6 still sees the empty answer it is written against.
            #
            # The set of criteria this fake honours is therefore exactly "the
            # ones some check has to see take effect" — `title` on scenes,
            # `tags` on scenes, `galleries` on images — and not "the criteria
            # Stash supports". A new check that needs another should add it here
            # rather than infer it works from the ones that do.
            #
            # Placed *below* the append above and not above it, which is where
            # it was first written: returning early there skipped the log entry,
            # so the fake answered the check correctly while the request it was
            # answering never appeared in `/requests`. The check went red on a
            # server that was doing the right thing — the append-before-dispatch
            # rule at the top of this method exists for exactly this.
            gallery_criteria = (variables.get(var) or {}).get("galleries") or {}
            if section == "Images" and gallery_criteria:
                with LOCK:
                    populate = MODE.get("galleryImages") == "populate"
                if not populate:
                    return self._json({"data": {"findImages": {"count": 0, "images": []}}})
                # The gallery slideshow's fixture. One short page, so the
                # viewer's background paging stops after the first fetch and
                # the check can wait for the slides to run out.
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

        # `FindScene` singular — the player's per-open resume refresh. Ordered
        # after the two plural/detail checks above because the operation name
        # is a prefix of both.
        if "FindScene(" in query:
            with LOCK:
                resume = MODE.get("resume", 0)
                fail_state = MODE.get("findSceneState") == "fail"
            if fail_state:
                # The per-open state read. A failure here means the resume
                # point, play count and markers are *unknown*, not absent —
                # which is why it has to be visible rather than looking like a
                # scene nobody has watched.
                return self._json({"errors": [{"message": "simulated state read failure"}]})
            return self._json({"data": {"findScene": {
                "id": variables.get("id"),
                # Driven by /mode so the resume prompt can be exercised from
                # *both* directions: the grid prop seeds the decision, and this
                # is the per-open refresh that must be able to disagree with it
                # (a scene played to the end elsewhere reports 0 here while the
                # card still carries the old position).
                "resume_time": resume,
                "play_count": 0,
                "play_duration": 0,
                "files": [{"duration": 120.0}],
                # Three markers, two of them on TAG_A. Which matters: the
                # modal's default tag is *this scene's* most-used primary tag,
                # and a scene whose markers all shared one tag could not tell
                # that rule apart from "whatever the library lists first".
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
                # Recorded *before* failing, so the check can tell a save that
                # was attempted-and-rejected from one that was never attempted
                # at all. Without that distinction "the chip says Sync failed"
                # would also pass on a build that had stopped saving entirely.
                return self._json({"errors": [{"message": "simulated save failure"}]})
            if mode in ("slow", "slowlong"):
                # Held *after* recording: the log shows the request the moment
                # it arrives, so a driver can tell a second save queued in the
                # client from two requests sent in parallel. The server is
                # threaded, so other requests are unaffected.
                #
                # `slowlong` exists for the late-response check: the incoming
                # scene needs to accrue clearly more watch time than the
                # outgoing one owes, so a success that wrongly drains the new
                # scene is visible rather than clamped away.
                time.sleep(1.2 if mode == "slow" else 4.0)
            return self._json({"data": {"sceneSaveActivity": True}})

        # The play counter. Appends a row per call, so the *length* of
        # PLAY_ADDS is the thing under test — see the note on that list.
        if "SceneAddPlay" in query:
            entry = {
                "id": str(variables.get("id")),
                "times": variables.get("times"),
            }
            with LOCK:
                PLAY_ADDS.append(entry)
                mode = MODE.get("sceneAddPlay")
            if mode == "fail":
                # Delayed for the same reason as sceneUpdate/sceneResetActivity:
                # the optimistic count must be readable before the failure
                # lands, or "optimistic then rollback" is unobservable.
                time.sleep(1.2)
                return self._json({"errors": [{"message": "simulated play-count failure"}]})
            if mode == "slow":
                time.sleep(1.2)
            # `count` is the length *including* this call, which is what the
            # real resolver returns — and deliberately not derived from
            # PLAY_ADDS, so the check compares two independent numbers. It is
            # 7 rather than the fixture's play_count + 1 (3) so a page that
            # displays its own optimistic guess instead of the server's answer
            # is distinguishable: 3 is both.
            return self._json({"data": {"sceneAddPlay": {"count": 7}}})

        # "Clear progress". The fake applies nothing it is not asked to:
        # `reset_resume` and `reset_duration` are logged as sent, and the
        # return value is the bare Boolean the schema declares (there is no
        # selection set to validate, so a `{ count }` body would silently
        # parse here and 400 against the real server).
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
                # Delayed before failing, like sceneUpdate: an instant failure
                # leaves the optimistic state unobservable, so "optimistic then
                # rollback" cannot be told from "never changed".
                time.sleep(1.2)
                return self._json({"errors": [{"message": "simulated reset failure"}]})
            return self._json({"data": {"sceneResetActivity": True}})

        # The driver mounts the whole App, which asks for saved filters on
        # every tab. The store is empty unless this run put something in it —
        # the drivers that are about the queue rather than about filters still
        # get `[]`, and a non-empty list would put a filter dropdown in the way
        # of the D-pad walk.
        if "FindSavedFilters" in query:
            mode = variables.get("mode")
            with LOCK:
                items = [dict(f) for f in SAVED_FILTERS.get(mode, [])]
            # A failing read for the *new* mode is how the stale-list bug is
            # observable: with the old rows kept, a scene filter stays on
            # screen as selectable under Performers after the switch fails.
            if MODE.get("savedFilters") == "fail":
                return self._json({"errors": [{"message": "simulated saved-filter failure"}]})
            return self._json({"data": {"findSavedFilters": items}})

        # The builder's two writes. Both are in-memory and both are logged, so
        # a driver can assert on what was sent as well as on what the UI then
        # shows — the mutation payload and the read-back are different claims
        # and only the second one proves the app can reopen what it saved.
        if "SaveFilter" in query:
            inp = variables.get("input") or {}
            mode = inp.get("mode")
            with LOCK:
                bucket = SAVED_FILTERS.setdefault(mode, [])
                entry = {
                    "id": str(inp.get("id") or (len(bucket) + 1)),
                    "name": inp.get("name") or "",
                    "find_filter": inp.get("find_filter"),
                    "object_filter": inp.get("object_filter"),
                    # Which mode the client filed it under, kept beside the
                    # entry so a driver can prove a scene filter was not filed
                    # as a marker one without depending on which bucket it
                    # happened to land in.
                    "mode": mode,
                }
                existing = next(
                    (i for i, f in enumerate(bucket) if f["id"] == entry["id"]), None,
                )
                if existing is None:
                    bucket.append(entry)
                else:
                    # An id means update. A fake that appended here would
                    # report success for a mutation that forked a duplicate,
                    # which is the failure the probe checks for on the real
                    # server.
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
            # Stash answers with a Boolean and `false` is a real failure, so
            # the fake has to be able to produce one: a driver that deletes a
            # nonexistent id is asserting on the app's handling of that.
            return self._json({"data": {"destroySavedFilter": hit}})

        if "SceneUpdate" in query:
            with LOCK:
                mode = MODE["sceneUpdate"]
            if mode == "fail":
                # Delayed *before* failing, deliberately. A failure that
                # returns instantly makes the optimistic value unobservable —
                # the rollback lands inside the same tick the test reads in,
                # so the test can no longer tell "optimistic then rollback"
                # from "never changed at all".
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

        # The marker form's tag picker. Takes precedence over the general
        # findSceneMarkers below by name, not by order of these two checks —
        # every finder here is matched on its operation name for that reason.
        #
        # `tag_filter` is excluded because the Tags *section* sends a query with
        # the same name, and that one is handled near the performer listing
        # above. This check is reached only if that one did not match, so the
        # exclusion is belt-and-braces — but a bare name match here is what
        # would silently answer the section with three `Harness Tag` rows, and
        # the cost of saying so is one clause.
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

        # The Markers tab. Two markers on two *different* scenes, and the two
        # fields deliberately point at different places:
        #
        #   scene.paths.screenshot → /scene/{n}/thumb.png   (a real frame)
        #   marker.screenshot      → the placeholder above  (what Stash really
        #                                                     returns, always)
        #
        # Which of the two the card renders is the entire content of the fix, so
        # a fake where they agreed would make the bug and the fix identical.
        #
        # `/mode markers=paged` swaps the two rows for a 100-row paginated
        # listing, because the two asks are genuinely in tension: the checks
        # above need *few* rows pointing at *different* places, and the
        # usePagedList migration needs enough rows to cross a page boundary.
        # One handler, two shapes, chosen by mode — the same idiom as
        # findScenes' slow modes. The default stays two rows so every existing
        # markerfix check is unaffected.
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
                # A create has no prior state to roll back to, so the only
                # correct client response is to keep the form and say why. A
                # failure that returned success-shaped data would make the
                # "never silently does nothing" claim untestable.
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
            # The increment happens now; only the *reply* is held back. That is
            # what makes two presses answer out of order — the first carries
            # 1 and arrives last, and a client without an attempt token draws
            # it over the second press's 2. See /clear and oSeed for the log
            # reset that makes "first" mean this phase.
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
            # A bare `Int!`, not `{count}`. The fake has to be as strict as the
            # real resolver here: if it answered an object, a client asking for
            # `sceneResetO { count }` would pass this harness and fail on the TV
            # with a selection-set validation error.
            return self._json({"data": {"sceneResetO": 0}})

        return self._json({"errors": [{"message": f"unhandled query: {query[:60]}"}]})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
