/**
 * serverService.js — a snapshot of the Stash server's version, health and
 * running jobs, plus starting a library scan and stopping a queued job.
 *
 * The status query is one request: `version`, `systemStatus` and `jobQueue` are
 * all zero-argument roots. Deliberately no polling — on a D-pad a snapshot with
 * a visible Refresh is predictable, whereas a timer re-renders under the cursor
 * and spends requests.
 *
 * `metadataScan` takes a `ScanMetadataInput` and returns the new job's id. Send
 * the instance's own saved scan options, read at press time: an empty input is
 * Stash's "walk the paths, generate nothing", so a TV-started scan finds new
 * scenes but skips every configured generation step. Read at press time because
 * the options can change while the app is open, and the button's point is to do
 * what Stash would have done.
 *
 * **Where the UI's toggles live.** Stash's scan-page checkboxes are saved into
 * `configuration.ui.taskDefaults.scan` (its UI calls `saveUI({ taskDefaults })`
 * on every toggle); `configuration.defaults.scan` is the older system-level
 * default the UI does not write. Read `ui.taskDefaults.scan` first, then
 * `defaults.scan`, matching Stash's `LibraryTasks.tsx` — otherwise a user who
 * turned generation options off still gets covers, previews and phashes.
 *
 * `ScanMetadataOptions` and `ScanMetadataInput` share the boolean fields; the
 * former lacks `paths` and `filter`, which this app deliberately never sends.
 *
 * `latestVersion` is not a Query field; do not add it.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';

const SERVER_STATUS_QUERY = `
  query ServerStatus {
    version { version }
    systemStatus { status appSchema databaseSchema }
    jobQueue { id status description progress subTasks error startTime }
  }
`;

// The generation switches on both sides of this hand-off. The query is built
// from this list so selection and input cannot drift: a field not on
// `ScanMetadataInput` fails on a real server, and one never read back is
// missing from the defaults.
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

// `ui` is a JSON scalar on `ConfigResult`, so it must be selected whole —
// GraphQL cannot reach into `ui.taskDefaults.scan`. It is where Stash's scan
// page stores the toggles (see the header).
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

// `stopJob(job_id: ID!): Boolean!` (verified by introspection). True means the
// stop was requested, not that the job has finished stopping.
const STOP_JOB_MUTATION = `
  mutation StopJob($jobId: ID!) {
    stopJob(job_id: $jobId)
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
        // Task descriptions, already user-facing prose. Non-strings are
        // dropped rather than rendered: the row joins them blindly.
        subTasks: Array.isArray(job.subTasks)
          ? job.subTasks.filter(task => typeof task === 'string' && task)
          : [],
        // The failure reason for a FAILED job. Empty on healthy jobs.
        error: job.error || null,
        // A Time scalar, serialised as an ISO string.
        startTime: job.startTime || null,
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
 * The saved scan options, in the shape `ScanMetadataInput` takes.
 *
 * `defaults.scan` is applied first, then `ui.taskDefaults.scan` overrides it
 * key by key (the UI block is what a user adjusting the checkboxes changed).
 * Merging rather than replacing means a partial UI object cannot drop a step;
 * `{}` is the honest answer when neither exists.
 *
 * Only booleans are copied. A `null` field is omitted rather than coerced to
 * `false`: omission lets Stash apply its default, while `false` actively turns
 * that generation step off.
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

// Test mode has no server to stop a job on: a stopped id disappears from the
// next snapshot, and starting a scan brings the sample back. Module-level, not
// component state, because the snapshot is rebuilt on every Refresh.
const mockStoppedJobs = new Set();

export function mockServerStatus() {
  return {
    version: '0.31.1',
    status: 'OK',
    appSchema: 31,
    databaseSchema: 31,
    jobs: [
      {
        id: 'mock-scan',
        status: 'RUNNING',
        description: 'Scanning metadata',
        progress: 0.42,
        subTasks: ['Scanning 1,234 of 4,567 files', 'Generating previews'],
        error: null,
        startTime: '2024-01-01T09:30:00Z',
      },
      {
        id: 'mock-generate',
        status: 'READY',
        description: 'Generate gallery covers',
        progress: null,
        subTasks: [],
        error: null,
        startTime: null,
      },
      {
        id: 'mock-failed',
        status: 'FAILED',
        description: 'Scanning thumbnails',
        progress: 0.18,
        subTasks: [],
        error: 'Could not read the media folder — check that it is mounted.',
        startTime: '2024-01-01T09:05:00Z',
      },
    ].filter(job => !mockStoppedJobs.has(job.id)),
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
 * Ask Stash to scan with its own saved scan defaults. Resolves to the job id;
 * throws on a transport or GraphQL error so the panel can show the message.
 *
 * A mutation without an id is a failure, not a success: the caller next reads
 * `jobQueue`, and an unqueued scan would read as "started" with no progress.
 *
 * A failed defaults read is a failure too, not a reason to send an empty input
 * — that fallback is the bug this exists to fix: the scan succeeds, the app
 * says so, and the configured artwork is silently never generated.
 */
export async function startLibraryScan() {
  if (getSettings().useMock) {
    // Starting a scan brings back the sample job Stop removes, so both
    // controls stay usable in either order.
    mockStoppedJobs.delete('mock-scan');
    return 'mock-scan';
  }
  const defaults = await runQuery(SCAN_DEFAULTS_QUERY);
  const data = await runQuery(LIBRARY_SCAN_MUTATION, {
    input: normalizeScanDefaults(defaults),
  });
  if (!data?.metadataScan) throw new Error('The server did not start a scan.');
  return data.metadataScan;
}

/**
 * Ask Stash to stop one job. Resolves when the stop has been *requested* — the
 * job may still report RUNNING or STOPPING, so the caller refreshes the
 * snapshot rather than removing the row itself.
 *
 * A `false` answer is a refusal, not a success: the job is still working.
 * Thrown rather than returned so one `catch` in the panel covers every failure.
 *
 * Test mode records the id for the next snapshot and delays briefly so the
 * button's in-flight label is reachable there too.
 */
export async function stopJob(jobId) {
  if (getSettings().useMock) {
    await new Promise(resolve => setTimeout(resolve, 250));
    mockStoppedJobs.add(String(jobId));
    return true;
  }
  const data = await runQuery(STOP_JOB_MUTATION, { jobId: String(jobId) });
  if (data?.stopJob !== true) throw new Error('the server did not stop the job');
  return true;
}
