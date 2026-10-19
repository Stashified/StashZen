/**
 * serverService.js — A snapshot of the Stash server's version, health and
 * running jobs, plus the one action Settings offers against it: starting a
 * library scan.
 *
 * The status query is one request: `version`, `systemStatus` and `jobQueue`
 * are all zero-argument roots. Deliberately no polling — on a D-pad a
 * snapshot with a visible Refresh action is predictable, while a section that
 * re-renders on a timer moves under the cursor and spends requests while
 * Settings is open.
 *
 * `metadataScan` takes a `ScanMetadataInput` and returns the new job's `ID`.
 * The input is the instance's own saved scan options, read at press time at
 * the same two places Stash's own UI reads them (see
 * `normalizeScanDefaults`). Sending an empty input instead is Stash's "walk
 * the paths, generate nothing" behaviour, and that is what the app shipped
 * until 0.22.0: a scan started from the TV found the new scenes but skipped
 * every generation step the user had configured in Stash, so new covers and
 * previews were missing until someone opened the server UI.
 *
 * The options are read at press time rather than cached: they can change on
 * the server while the app is open, and the whole point of the button is to
 * do what Stash would have done.
 *
 * **Where the UI's toggles actually live (0.22.1).** The checkboxes on
 * Stash's scan page are saved into `configuration.ui.taskDefaults.scan` —
 * Stash's UI calls `saveUI({ taskDefaults: ... })` on every toggle. The
 * `configuration.defaults.scan` block is the older, system-level default and
 * the UI does not write it. 0.22.0 read only `defaults.scan`, so a user who
 * turned every generation option off in Stash still got covers, previews and
 * phashes: the TV was faithfully copying a block that never changed. Read
 * `ui.taskDefaults.scan` first, `defaults.scan` as the fallback — the same
 * preference order as Stash's own `LibraryTasks.tsx`.
 *
 * `ScanMetadataOptions` (the result type under `configuration.defaults.scan`)
 * and `ScanMetadataInput` (the mutation's input) carry the same boolean
 * fields; the result type only lacks `paths` and `filter`, which this app
 * deliberately does not send — it scans the configured paths, it does not
 * choose them.
 *
 * `latestVersion` is not a Query field on 0.31.1; do not add it.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';

const SERVER_STATUS_QUERY = `
  query ServerStatus {
    version { version }
    systemStatus { status appSchema databaseSchema }
    jobQueue { id status description progress }
  }
`;

// The generation switches Stash exposes on both sides of this hand-off. The
// query is built from this list so the selection and the input cannot drift:
// a field added here but not to `ScanMetadataInput` fails on a real server,
// and one sent in the mutation but never read back is missing from the
// defaults.
const SCAN_OPTION_FIELDS = [
  'rescan',
  'scanGenerateCovers',
  'scanGeneratePreviews',
  'scanGenerateImagePreviews',
  'scanGenerateSprites',
  'scanGeneratePhashes',
  'scanGenerateImagePhashes',
  'scanGenerateThumbnails',
  'scanGenerateClipPreviews',
];

// `ui` is a JSON scalar on `ConfigResult`, so it is selected whole: GraphQL
// cannot reach into `ui.taskDefaults.scan` itself. It is also where Stash's
// scan page stores the toggles, which is why reading only `defaults.scan`
// missed the user's changes (see the header).
const SCAN_DEFAULTS_QUERY = `
  query ScanDefaults {
    configuration {
      ui
      defaults {
        scan { ${SCAN_OPTION_FIELDS.join(' ')} }
      }
    }
  }
`;

// The field is `metadataScan(input: ScanMetadataInput!)`, so the variable is
// the honest shape. Its value comes from `normalizeScanDefaults` below.
const LIBRARY_SCAN_MUTATION = `
  mutation LibraryScan($input: ScanMetadataInput!) {
    metadataScan(input: $input)
  }
`;

// The queue also carries FINISHED and CANCELLED jobs, which are history, not
// status. READY is a queued job and STOPPING is still doing work, so both
// belong; FAILED does too, because that is exactly what a user needs to see.
const ACTIVE_JOB_STATES = new Set(['RUNNING', 'READY', 'STOPPING', 'FAILED']);
const MAX_JOBS = 3;

export function normalizeServerStatus(raw) {
  if (!raw) return null;
  return {
    version: raw.version?.version || null,
    status: raw.systemStatus?.status || null,
    appSchema: raw.systemStatus?.appSchema ?? null,
    databaseSchema: raw.systemStatus?.databaseSchema ?? null,
    jobs: (raw.jobQueue || [])
      .filter(job => ACTIVE_JOB_STATES.has(job?.status))
      .slice(0, MAX_JOBS)
      .map(job => ({
        id: job.id,
        status: job.status,
        description: job.description || job.id,
        // Stash reports progress as 0–1. `null` means "not measurable yet".
        progress: Number.isFinite(job.progress) ? job.progress : null,
      })),
  };
}

/**
 * The UI store (`configuration.ui`) arrives as a parsed JSON object over the
 * normal transport, but it is a scalar, so a server that serialised it as a
 * string is answered the same rather than crashing the scan. Unreadable is
 * the same as absent: the system defaults still apply.
 */
function parseUiSettings(ui) {
  if (ui && typeof ui === 'object') return ui;
  if (typeof ui === 'string') {
    try { return JSON.parse(ui); } catch { return null; }
  }
  return null;
}

/**
 * The saved scan options, in the exact shape `ScanMetadataInput` takes.
 *
 * Two sources, in the order Stash's own UI uses them:
 *
 *   - `configuration.ui.taskDefaults.scan` — what the checkboxes on Stash's
 *     scan page save, on every toggle. This is the block a user who has
 *     adjusted the options actually changed.
 *   - `configuration.defaults.scan` — the older system-level default. Used
 *     when the UI has never saved scan options.
 *
 * The two are merged rather than replaced so a partial UI object (or one
 * written by an older Stash) cannot silently drop a step; the UI's values win
 * key by key. `{}` is the honest answer for a server that reports neither,
 * and it is also Stash's own empty-input behaviour.
 *
 * Only booleans are copied. A field the server answers `null` for is left out
 * rather than coerced to `false`: omitting it lets Stash apply its own
 * default, while sending `false` would actively turn that generation step
 * off.
 */
export function normalizeScanDefaults(raw) {
  const config = raw?.configuration;
  const ui = parseUiSettings(config?.ui);
  const input = {};
  for (const source of [config?.defaults?.scan, ui?.taskDefaults?.scan]) {
    if (!source || typeof source !== 'object') continue;
    for (const field of SCAN_OPTION_FIELDS) {
      if (typeof source[field] === 'boolean') input[field] = source[field];
    }
  }
  return input;
}

export function mockServerStatus() {
  return {
    version: '0.31.1',
    status: 'OK',
    appSchema: 31,
    databaseSchema: 31,
    jobs: [{
      id: 'mock-scan',
      status: 'RUNNING',
      description: 'Scanning metadata',
      progress: 0.42,
    }],
  };
}

/**
 * Throws on transport or GraphQL errors so the Settings panel can show the
 * message. Returns null when the server answers with nothing usable.
 */
export async function loadServerStatus() {
  if (getSettings().useMock) return mockServerStatus();
  const data = await runQuery(SERVER_STATUS_QUERY);
  return normalizeServerStatus(data);
}

/**
 * Ask Stash to scan its library with its own saved scan defaults. Resolves to
 * the job id; throws on a transport or GraphQL error so the panel can show
 * the message.
 *
 * A mutation that answers without an id is treated as a failure rather than a
 * success: the caller's next step is to read `jobQueue`, and a scan that was
 * not actually enqueued would otherwise read as "started" with no progress
 * ever appearing.
 *
 * A failed defaults read is a failure too, not a reason to fall back to an
 * empty input: the fallback is exactly the bug this exists to fix — the scan
 * succeeds, the app says so, and the artwork the user configured is silently
 * not generated.
 */
export async function startLibraryScan() {
  if (getSettings().useMock) return 'mock-scan';
  const defaults = await runQuery(SCAN_DEFAULTS_QUERY);
  const data = await runQuery(LIBRARY_SCAN_MUTATION, {
    input: normalizeScanDefaults(defaults),
  });
  if (!data?.metadataScan) throw new Error('The server did not start a scan.');
  return data.metadataScan;
}
