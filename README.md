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

*Tested on Tizen 9 (S95H) only.* Earlier Tizen releases ship browser engines that cannot render this
layout (flex `gap` needs Chromium 84, `aspect-ratio` needs 88), so the package declares Tizen 6.5,
the first release on Chromium 94. Other 6.5+ models are untested: if StashZen misbehaves on yours,
please open an issue with the model and Tizen version.

## Install on the TV

Sideloading is the intended route. Download the `.wgt` from **Releases**, not the zip from an
Actions run: a workflow artifact is a zip *containing* the `.wgt`, and installers fail on it without
saying why.

1. **Enable Developer Mode.** Open **Apps**, press **1 2 3 4 5** on the remote, turn on
   *Developer mode*, enter the IP of the computer you will install from, and restart the TV.
2. **Install the file** with [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) or a
   similar tool: select the `.wgt` and let it do the rest. Tizen Studio's `tizen install` also
   works, but needs a package signed with a Samsung distributor certificate that lists your TV (see
   [Building your own package](#building-your-own-package)).
3. StashZen appears in the TV's Apps grid.

## First run

A fresh install has no server saved, so it opens on **Connect to Stash**:

- **Server address**: include `http://` and the port, e.g. `http://192.168.1.20:9999` (`9999` is
  Stash's default).
- **API key**: in Stash, under **Settings → Security → API Key**.
- **Test connection** checks the address and key without saving. **Connect** runs the same check and
  saves only if it passes. **Skip — use sample data** saves nothing, not even what you typed, and
  runs in Test mode so you can look around first.

The app then offers an optional **4-digit PIN**, asked for on the *next* launch. To change any of
this later, use **Settings → Connection setup → Run setup again**.

> **Typing:** text fields select first and edit on OK. Moving onto a field does not raise the
> keyboard. Press **OK** to start typing, and **OK** again (or the keyboard's Done) to finish.

## Remote controls

**Everywhere**

| Key | Action |
|---|---|
| D-pad | Move focus. |
| OK / Enter | Open the focused item or activate the control. On a card, opens its detail page. |
| Long press OK | Open the card's menu: **Play**, **Play all**, **Play from here** for a scene (a marker's Play starts at its timestamp); slideshows for an image or gallery; **Info** / **Details** where there is a page to open. |
| Back / Esc | Close the topmost thing: dropdown, page, player. On the main screen and on the PIN screen it asks to exit. |

**Navigating**

| Key | Action |
|---|---|
| ← from a card | Return to the left rail's current tab. |
| ↑ from the top card row | On a listing tab, jump to the controls bar (filter, sort, view mode, search). On Home, go back to the rail. |
| ↑ / ↓ on the rail | Walk the rail, including Settings at the bottom. |
| OK on the rail's current row | Reload that tab in place, so scenes added or removed on the server appear without relaunching. |
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
  Scenes. **See all** opens a listing with that shelf's sort and filter.
- **Seven sections**: Scenes, Performers, Markers, Tags, Studios, Galleries and Images, each with
  search, sort and filters in a Classic grid, Carousel or List (Scenes also offer Coverflow). View
  mode and columns are remembered per tab; sort, filter and search reset on arrival.
  Gallery cards show the studio or the folder; tag and studio carousels carry Stash's description
  and aliases. A marker plays its scene at that timestamp.
- **Filter builder**: build a filter on the TV or load a saved one; saved filters round-trip to
  Stash.
- **Focus previews**: the focused scene card plays its Stash preview, muted by default. Settings
  has an On/Off switch, and the listing tabs' controls bar has a mute toggle.

**Details**
- **Scene detail**: metadata and rating; resume, play from a marker, clear progress or mark played;
  a **Galleries** row when the scene belongs to one.
- **Performer pages**: the full profile plus scene, image and gallery counts, with **Rating** and
  **Favourite** editable and written back to Stash.
- **Image viewer**: full size, stepped with ←/→, with a six-second slideshow. **Info** shows what
  Stash holds for the image; an image with no title shows its file name.

**Playback**
- **Player**: resumes where you stopped, queues the whole listing, seeks 15 s at a time, and writes
  progress back to Stash. HLS keeps the timeline seekable. A chip says **Direct play** or
  **Transcoded**, and **Playback info** shows the live stream details.
- **Browser first, TV player when needed**: scenes play in the browser player, which seeks more
  reliably. A file the browser cannot take is handed to Tizen's own hardware player (AVPlay), which
  decodes formats the browser lacks, including HEVC, AV1 and VP9. **Settings → Playback engine**:
  - **Auto**: the behaviour above.
  - **TV player**: AVPlay first, for comparing on the same file.
  - **Browser**: compatibility mode, the previous player exactly.

  **Playback info** names the engine in use and, when it is not the browser's first choice, why.
- **Mute in the player**: uses the TV's audio control or AVPlay's volume, whichever the panel
  offers. If it has neither, the Mute button is disabled and Playback info says why.

**System**
- **Library stats and server jobs**: counts, storage and watch time; running jobs with progress and
  a two-press **Stop**; start a library scan from the TV.
- **Theme**: Standard or OLED (true black on OLED panels).
- **Unsaved-changes guard**: leaving Settings without pressing **Save** asks whether to save,
  discard, or keep editing, instead of silently throwing the edits away.
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

**It won't connect, or the screen is black.** Open Settings → Test connection. Check that the
address includes `http://` and the port, that the TV can reach the server, and that the API key is
current.

**A scene won't play.** Open **Playback info** first: it shows which engine is playing and why.
- The file's codec may need transcoding. Enable **transcoding on the Stash server**.
- The player starts in the browser and hands the file to the TV's own pipeline (AVPlay) when the
  browser refuses it or fails to start it. AVPlay decodes more containers than the browser.
- If the TV pipeline is the problem, set **Settings → Playback engine → Browser** to reproduce the
  previous player. **TV player** puts AVPlay first, which helps when comparing the two.
- If the spinner never resolves, check Stash's logs.

**A transcoded scene won't seek.** Stash's MP4 transcode is a linear stream, so StashZen uses HLS
instead. If you see this, HLS output is disabled or unavailable on your server.

**Progress doesn't sync.** The player shows an indicator when a save fails. Usually it is the API
key: saving activity is a mutation and needs it, unlike plain playback. Rating and favourite writes
on the performer page use the same key and report a failure in place.

**An image's Info panel is sparse.** It shows only what Stash holds for that image and hides empty
fields, so a picture with no studio, tags or performers is short. That is the data, not a failed
fetch.

**"Something went wrong".** This is the last-resort error boundary. **Try again** re-renders;
**Restart** relaunches the widget. If it recurs, note what you were doing and open an issue. The
message on the screen helps.

## Security notes

- **The API key is stored unencrypted on the TV**, in the app's local storage. The optional PIN
  deters someone holding the remote; it is not encryption. Anyone who can read the installed app's
  storage can read the key regardless of the PIN. Create a dedicated Stash API key for the TV, and
  revoke it if the set leaves your control.
- **Media URLs carry the key in their query string.** `<img>`, `<video>`, sprite sheets and VTT
  files cannot send the `ApiKey` header, so StashZen appends `?apikey=…` to those requests. The key
  therefore appears in Stash's and any reverse proxy's access logs, and over plain HTTP it is
  readable on the network. Beyond a trusted LAN, put Stash behind HTTPS: the URL still carries the
  key, but the connection does not expose it in transit.
- **Release packages carry no credentials.** CI sets no `VITE_*` variables and refuses to package a
  bundle containing a key, so a fresh install starts on the Setup screen. A locally built package
  can contain your key; see [Building your own package](#building-your-own-package).

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

`scripts/harness/` runs the real components in headless Firefox against a fake GraphQL endpoint. It
catches navigation and layout regressions before a package is built, and `shoot.sh` captures the
README screenshots from the same Test-mode app. The harness says nothing about the TV's media
pipeline or on-screen keyboard; only the TV can. The UI has no fixed stage and lays out at whatever
viewport it is given, so resizing the harness window invalidates its geometry-based expectations.

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
2. In **Tools → Certificate Manager**, create a **Samsung** profile: an author certificate (you) and
   a distributor certificate (Samsung-issued). Add your TV's DUID, shown in the TV's Developer Mode
   dialog.
3. Confirm the profile is active (`O` in the Active column):

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

   The stamp step writes `package.json`'s version into the staged manifest, so a local package
   claims the version it actually is. To install over sdb as well:

   ```bash
   sdb connect <tv-ip>:26101
   tizen install -n dist/StashZen.wgt -t <tv-sdb-name>
   ```

The result is `dist/StashZen.wgt` (CI adds the version to the artifact name), signed with your
distributor certificate. Tizen's own installer expects the target TV's device ID to be listed in
that certificate.

**Apps2Samsung is not limited by that.** A release signed with a certificate whose device ID belongs
to no real TV installed and ran on a TV the certificate does not name (verified 2026-10-18).
Apps2Samsung also manages certificates per TV and may add the target TV itself. So a shared build
works there too; for wider sharing, TizenBrew or the Samsung Seller Office are the routes to use.

**Credential guard.** `npm run build` ends with `scripts/check-bundle.mjs`. If `.env.production`
supplied an API key, the build **fails** rather than producing a package that contains it. To bake
the key in deliberately for your own TV:

```bash
ALLOW_BAKED_KEY=1 npm run build
```

Never share a `.wgt` built that way: it hands the key to whoever installs it.

### Releases (GitHub Actions)

`.github/workflows/build-wgt.yml` builds and signs a `.wgt` in CI. Run it by hand from
**Actions → Build Tizen .wgt → Run workflow**, or push a tag to create a GitHub Release with the
package attached:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Add these four secrets to the GitHub **environment named `StashZen`**, the one the workflow declares
in its `environment:` line (a job only sees environment secrets when it names one):

| Secret | Value |
|---|---|
| `TIZEN_AUTHOR_P12` / `TIZEN_AUTHOR_PASSWORD` | base64 of your author `.p12`, and its password |
| `TIZEN_DISTRIBUTOR_P12` / `TIZEN_DISTRIBUTOR_PASSWORD` | base64 of your Samsung distributor `.p12`, and its password |

```bash
openssl base64 -in author.p12 | tr -d '\n'
```

Release packages carry **no credentials**: the workflow sets no `VITE_*` variables and aborts if one
was inlined, so a fresh install always starts on the Setup screen.

## License & credits

MIT, see [`LICENSE`](LICENSE). StashZen started from
[`thelastgrim/stash-tizen`](https://github.com/thelastgrim/stash-tizen) and has since been largely
rewritten; thanks to its author.
