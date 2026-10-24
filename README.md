# StashZen

**Private media, made simple.**

A [Stash](https://github.com/stashapp/stash) client for Samsung Tizen TVs, built to be driven
entirely with the remote. It is a web app packaged as a Tizen widget (`.wgt`).

[Project page](https://stashified.github.io/StashZen/) ·
[Releases](https://github.com/Stashified/StashZen/releases) ·
[Issues](https://github.com/Stashified/StashZen/issues)

<p align="center">
  <img src="docs/screenshots/home.png" alt="Home shelves" width="49%">
  <img src="docs/screenshots/scene-detail.png" alt="Scene detail with markers and play actions" width="49%">
</p>

---

## Contents

[Requirements](#requirements) · [Install](#install-on-the-tv) · [First run](#first-run) ·
[Remote controls](#remote-controls) · [Features](#features) · [Screenshots](#screenshots) ·
[Troubleshooting](#troubleshooting) · [Security](#security-notes) ·
[Developer notes](#developer-notes)

## Requirements

| | |
|---|---|
| **TV** | Samsung, **Tizen 6.5 or newer** (most sets from 2022 on). |
| **Server** | A reachable **Stash** server on the same network. Built and tested against Stash **0.31.1**. |
| **Package** | The latest `.wgt` from [Releases](https://github.com/Stashified/StashZen/releases). |

*Tested on Tizen 9 (S95H). The package declares 6.5 — the first Tizen on Chromium 94, which is
what this layout needs (flex `gap` needs 84, `aspect-ratio` 88). Other 6.5+ models are untested;
if StashZen misbehaves on yours, open an issue with the model and Tizen version.*

## Install on the TV

Sideloading is the intended route. Download the `.wgt` from **Releases**, not an Actions artifact:
an artifact is a zip *containing* the `.wgt`, and installers fail on it without saying why.

1. **Developer mode.** Open **Apps**, press **1 2 3 4 5** on the remote, turn on *Developer mode*,
   enter the IP of the computer you will install from, and restart the TV.
2. **Install the file** with [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) or a
   similar tool. Tizen Studio's `tizen install` also works, but needs a distributor certificate
   that lists your TV (see [Building your own package](#building-your-own-package)).
3. StashZen appears in the TV's Apps grid.

## First run

A fresh install opens on **Connect to Stash**:

- **Server address**: include `http://` and the port, e.g. `http://192.168.1.20:9999`.
- **API key**: in Stash under **Settings → Security → API Key**.
- **Test connection** checks the address and key without saving. **Connect** saves only if the
  check passes. **Skip — use sample data** saves nothing and runs in Test mode.

The app then offers an optional **4-digit PIN**, asked on the *next* launch. Change any of this
under **Settings → Connection setup → Run setup again**.

> **Typing:** fields select first and edit on OK; moving onto one does not raise the keyboard.
> Press **OK** to type, and **OK** again (or Done) to finish.

## Remote controls

**Everywhere**

| Key | Action |
|---|---|
| D-pad | Move focus. |
| OK / Enter | Open the focused item or activate the control. On a card, opens its detail page. |
| Long press OK | The card's menu: **Play**, **Play all**, **Play from here** (a marker's Play starts at its timestamp), slideshows for an image or gallery, **Info** / **Details**. |
| Back / Esc | Close the topmost thing: dropdown, page, player. On the home screen and on the PIN screen it asks to exit. |

**Navigating**

| Key | Action |
|---|---|
| ← from a card | Return to the left rail's current tab. |
| ↑ from the top card row | On a listing, the controls bar (filter, sort, view mode, search); on Home, the rail. |
| ↑ / ↓ on the rail | Walk the rail, including Settings at the bottom. |
| OK on the rail's current row | Reload that tab in place, so server changes appear without relaunching. |
| OK on a gallery chip | In a scene detail's **Galleries** row, open that gallery in the Galleries tab. |

**Player**

| Key | Action |
|---|---|
| ← / → | Seek 15 seconds. |
| ↓ | From the buttons, steps to the next scene. From the seek bar, returns to the buttons first; **↓** again steps. With the controls hidden, steps directly. |
| ↑ | From the buttons, goes to the seek bar (where ← / → skim) without changing the scene; **↑** again steps to the previous scene. With the controls hidden, steps directly. |
| Back | With the controls on screen, the first press hides them and the second closes the player. |

**Image viewer**

| Key | Action |
|---|---|
| ← / → | Previous or next image. An open info panel stays open and reloads for the new image. |
| ↑ | Reach the **Info** button; **OK** opens that image's metadata panel. |
| Back | Close an open info panel first, then the viewer. |

## Features

**Browse**
- **Home**: Stash's shelves, five cards each, with **Continue Watching** under Recently Added
  Scenes. **See all** opens that shelf's listing.
- **Seven sections**: Scenes, Performers, Markers, Tags, Studios, Galleries and Images, each with
  search, sort, filters and a view mode (grid, carousel or list; Scenes also coverflow) that is
  remembered per tab. Sort, filter and search reset on arrival. Gallery cards show the studio or
  folder; tag and studio carousels carry descriptions and aliases.
- **Filter builder**: build one on the TV or load a saved one; saved filters round-trip to Stash.
- **Focus previews**: the focused scene card plays its Stash preview, muted by default. Toggle it
  in Settings or on the listing's controls bar.

**Details**
- **Scene detail**: metadata and rating; resume, play from a marker, clear progress or mark played;
  a **Galleries** row when the scene belongs to one.
- **Performer pages**: the full profile, scene/image/gallery counts, and **Rating** / **Favourite**
  editable and written back to Stash.
- **Image viewer**: full size, stepped with ←/→, with a six-second slideshow. **Info** shows what
  Stash holds for the image; an untitled image shows its file name.

**Playback**
- **Player**: resumes where you stopped, queues the whole listing, seeks 15 s at a time, and writes
  progress back to Stash. HLS keeps the timeline seekable. A chip says **Direct play** or
  **Transcoded**; **Playback info** shows the live stream details.
- **Browser first, TV player when needed**: scenes play in the browser player, which seeks more
  reliably; a file it cannot take goes to Tizen's hardware player (AVPlay), which adds HEVC, AV1
  and VP9. **Settings → Playback engine** offers **Auto**, **TV player** and **Browser**, and
  **Playback info** names the engine and the fallback reason.
- **Mute** uses the TV's audio control or AVPlay's volume, whichever the panel offers; if it has
  neither the button is disabled and **Playback info** says why.

**System**
- **Library stats and server jobs**: counts, storage and watch time; running jobs with progress and
  a two-press **Stop**; start a library scan from the TV.
- **Theme**: Standard or OLED (true black on OLED panels).
- **Unsaved-changes guard**: leaving Settings without pressing **Save** asks whether to save,
  discard, or keep editing.
- **PIN lock**: optional four-digit code at launch.
- **Test mode**: every screen on sample data, no server required.

## Screenshots

<p align="center">
  <img src="docs/screenshots/home.png" alt="Home shelves" width="49%">
  <img src="docs/screenshots/scene-detail.png" alt="Scene detail with markers and play actions" width="49%">
</p>
<p align="center">
  <img src="docs/screenshots/performers.png" alt="Performers listing" width="49%">
  <img src="docs/screenshots/performer-detail.png" alt="Performer page with rating and favourite" width="49%">
</p>
<p align="center">
  <img src="docs/screenshots/galleries.png" alt="Galleries listing with image counts and folders" width="49%">
  <img src="docs/screenshots/image-viewer.png" alt="Image viewer with its info panel open" width="49%">
</p>
<p align="center">
  <img src="docs/screenshots/settings-stats.png" alt="Settings — library stats" width="49%">
  <img src="docs/screenshots/settings-server.png" alt="Settings — server jobs and scan progress" width="49%">
</p>

<sub>Captured from the app's built-in Test mode, which runs on sample data and needs no server.</sub>

## Troubleshooting

**It won't connect, or the screen is black.** Check **Settings → Test connection**: the address
needs `http://` and the port, the TV must reach the server, and the API key must be current.

**A scene won't play.** Open **Playback info** first; it shows the engine and why.
- The codec may need transcoding — enable **transcoding on the Stash server**.
- The browser hands files it refuses to AVPlay, which decodes more containers. If AVPlay is the
  problem, set **Settings → Playback engine → Browser** to reproduce the previous player.
- If the spinner never resolves, check Stash's logs.

**A transcoded scene won't seek.** Stash's MP4 transcode is a linear stream, so StashZen uses HLS
instead. If you see this, HLS output is disabled on your server.

**Progress doesn't sync.** The player shows an indicator when a save fails; usually it is the API
key, since saving activity is a mutation. Rating and favourite writes report failures in place.

**An image's Info panel is sparse.** It shows only what Stash holds and hides empty fields, so an
image with no studio, tags or performers is short. That is the data, not a failed fetch.

**"Something went wrong".** The last-resort error boundary. **Try again** re-renders; **Restart**
relaunches the widget. Note what you were doing and open an issue if it recurs.

## Security notes

- **The API key is stored unencrypted on the TV**, in the app's local storage. The optional PIN is
  a deterrent, not encryption: anyone who can read the app's storage can read the key regardless.
  Use a dedicated Stash API key for the TV and revoke it if the set leaves your control.
- **Media URLs carry the key in their query string.** Images, video, sprites and VTT files cannot
  send the `ApiKey` header, so StashZen appends `?apikey=…`. The key therefore appears in Stash's
  and any reverse proxy's logs, and over plain HTTP it is readable on the network. Beyond a
  trusted LAN, put Stash behind HTTPS.
- **Release packages carry no credentials.** CI sets no `VITE_*` variables and refuses to package
  a bundle containing a key, so a fresh install starts on the Setup screen. A locally built
  package can contain your key; see [Building your own package](#building-your-own-package).

---

## Developer notes

### Run it locally

Requires Node.js 20+ (CI uses 22).

```bash
git clone https://github.com/Stashified/StashZen
cd StashZen
npm install
npm run dev            # http://localhost:5173
```

The dev server starts in **Live mode** against `http://localhost:9999`. Point it elsewhere in
Settings, or set these in `.env` (`.env.production` is separate and is what `npm run build` reads):

| Variable | Effect |
|---|---|
| `VITE_STASH_URL` | Address the app starts with. |
| `VITE_STASH_API_KEY` | API key the app starts with. |
| `VITE_USE_MOCK` | `true` starts in Test mode with sample art. |
| `VITE_FORCE_BROWSER` | `true` builds with the browser player only: the rollback lever if a TV's AVPlay misbehaves. Settings then shows the engine in use instead of a switch. |

**Scripts**

| Command | What it does |
|---|---|
| `npm run lint` · `build` · `preview` | Standard Vite workflow. |
| `npm test` | The unit suites. |
| `npm run check:compat` | The Tizen 6.5 API and CSS checks (CI runs these too). |
| `npm run test:filters` · `verify:criteria` · `verify:art` | Offline checks for the data layer. |

`scripts/harness/` runs the real components in headless Firefox against a fake GraphQL endpoint,
catching navigation and layout regressions before a package is built. `shoot.sh` captures the
README screenshots from the same Test-mode app. It says nothing about the TV's media pipeline or
on-screen keyboard — only the TV can. The UI has no fixed stage and lays out at whatever viewport
it is given, so resizing the harness window invalidates its geometry-based expectations.

### Where things are

```
src/App.jsx             the shell: rail, controls bar, overlays, player composition
src/app/                tab config, listing and detail hooks, Back handling
src/components/         cards, grids, carousel, image viewer, rail, settings, filter builder
src/components/player/  transport, keys, overlays, media and progress hooks;
                        engine/ holds the media facade and the browser and AVPlay backends
src/pages/              Showroom (Home), Scenes, Performers, Markers, entity pages, and the
                        performer and scene detail pages with their subdirectories
src/hooks/              D-pad focus and keys, paging, playback source, play queue, editable fields
src/utils/              Stash services, settings store, filters, playback rules, mock art
tizen/                  manifest and icons
scripts/                offline checks, art generation, headless harness, screenshot capture
```

Read these first: `src/hooks/useKeyHandler.js` (spatial navigation), `src/utils/settings.js`
(runtime config and Test mode), and `src/components/VideoPlayer.jsx` with its hooks under
`src/components/player/` (keys, queue, writes back to Stash).

### Building your own package

A `.wgt` is a signed zip of `dist/` plus `tizen/config.xml`.

1. Install [Tizen Studio](https://download.tizen.org/sdk/Installer/) (the CLI tools are enough).
2. In **Tools → Certificate Manager**, create a **Samsung** profile: an author certificate (you)
   and a distributor certificate (Samsung-issued) that lists your TV's DUID, shown in the TV's
   Developer Mode dialog.
3. Confirm it is active (`O` in the Active column):

   ```bash
   tizen security-profiles list
   ```

4. Build, stage and sign with your profile name:

   ```bash
   npm run build
   cp tizen/config.xml tizen/icon.png tizen/icon-black.png dist/
   node scripts/stamp-manifest.mjs
   tizen package -t wgt -s <profile-name> -- ./dist
   ```

   The stamp step writes `package.json`'s version into the manifest, so the package claims the
   version it actually is. To install over sdb as well:

   ```bash
   sdb connect <tv-ip>:26101
   tizen install -n dist/StashZen.wgt -t <tv-sdb-name>
   ```

The result is `dist/StashZen.wgt` (CI adds the version), signed with your distributor certificate.
`tizen install` expects your TV's device ID in that certificate; **Apps2Samsung does not** — it
installs packages whose certificate names no real TV, including one carrying only Tizen's bundled
test certificate, so a shared build works there. For wider sharing, use TizenBrew or the Samsung
Seller Office.

**Credential guard.** `npm run build` ends with `scripts/check-bundle.mjs`, which **fails** the
build if the bundle contains a JWT-shaped key or the exact `VITE_STASH_API_KEY` from
`.env.production`. A private-network address only warns. It catches the mistake that actually
happens — inlining `.env.production` — not an encoded key. To bake the key in deliberately for
your own TV:

```bash
ALLOW_BAKED_KEY=1 npm run build
```

Never share a `.wgt` built that way.

### Releases (GitHub Actions)

`.github/workflows/build-wgt.yml` builds and signs a `.wgt` in CI. Run it by hand from
**Actions → Build Tizen .wgt → Run workflow**, or push a tag to create a GitHub Release with the
package attached:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Add four secrets to the GitHub **environment named `StashZen`** (the workflow's `environment:`
line — without it the secrets resolve empty):

| Secret | Value |
|---|---|
| `TIZEN_AUTHOR_P12` / `TIZEN_AUTHOR_PASSWORD` | base64 of your author `.p12`, and its password |
| `TIZEN_DISTRIBUTOR_P12` / `TIZEN_DISTRIBUTOR_PASSWORD` | base64 of your Samsung distributor `.p12`, and its password |

A **tag** build needs all four and never falls back to Tizen's test distributor. A **manual run**
may set `signing: test` — Tizen's bundled test distributor, no distributor secrets — to exercise
the pipeline; treat the result as an experiment, never as something to publish. The author pair
is required either way.

```bash
openssl base64 -in author.p12 | tr -d '\n'
```

Release packages carry **no credentials**: the workflow sets no `VITE_*` variables and aborts if
one was inlined, so a fresh install always starts on the Setup screen.

## License & credits

MIT, see [`LICENSE`](LICENSE). StashZen started from
[`thelastgrim/stash-tizen`](https://github.com/thelastgrim/stash-tizen) and has since been largely
rewritten; thanks to its author.
