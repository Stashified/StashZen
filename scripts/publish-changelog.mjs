#!/usr/bin/env node
/**
 * publish-changelog.mjs: turn the release-notes draft into changelog.json.
 *
 * One source of truth: the app reads this file, and a tag build renders the
 * GitHub Release body from the same entry, so the two cannot drift.
 *
 * Usage:
 *   node scripts/publish-changelog.mjs publish [--version X.Y.Z] [--date YYYY-MM-DD]
 *                                              [--draft FILE] [--replace] [--dry-run]
 *   node scripts/publish-changelog.mjs validate [--file changelog.json]
 *   node scripts/publish-changelog.mjs body     --version X.Y.Z [--file changelog.json]
 *                                              [--out FILE]
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/utils/updateCheck.js';
import { validateChangelogPayload } from '../src/utils/changelog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(ROOT, 'changelog.json');
const DRAFT = join(ROOT, 'RELEASE_NOTES_DRAFT.md');
// eslint-disable-next-line no-control-regex -- rejecting them is the point
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Draft prose into sections. `## Title` starts a section, `- item` appends.
 * Bullets before the first heading land under "Changes".
 *
 * @returns {Array<{ title: string, items: string[] }>}
 */
export function parseDraft(text) {
  const sections = [];
  let current = null;
  // Index of the item a following plain line continues, or null. Drafts are
  // written wrapped at about 80 columns, and a parser that dropped the second
  // line published half a sentence.
  let openItem = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = { title: normalizeText(heading[1]), items: [] };
      sections.push(current);
      openItem = null;
      continue;
    }
    // A list marker with nothing after it closes the item, so the prose below
    // is not swallowed as a continuation.
    if (/^\s*[-*+]\s*$/.test(line)) {
      openItem = null;
      continue;
    }
    const bullet = /^\s*-\s+(.+)$/.exec(line);
    if (bullet) {
      const item = normalizeText(bullet[1]);
      if (!item || CONTROL_RE.test(item)) {
        openItem = null;
        continue;
      }
      if (!current) {
        current = { title: 'Changes', items: [] };
        sections.push(current);
      }
      current.items.push(item);
      openItem = current.items.length - 1;
      continue;
    }
    // A blank line or the start of other prose ends the wrapped item.
    if (openItem === null || !line.trim()) {
      openItem = null;
      continue;
    }
    current.items[openItem] = normalizeText(`${current.items[openItem]} ${line}`);
  }
  return sections.filter(s => s.title && s.items.length > 0);
}

/** Insert or replace one release, newest first. */
export function addRelease(payload, release, { replace = false } = {}) {
  const releases = Array.isArray(payload?.releases) ? payload.releases.slice() : [];
  const index = releases.findIndex(
    r => compareVersions(r.version, release.version) === 0,
  );
  if (index >= 0) {
    if (!replace) {
      return {
        ok: false,
        errors: [`${release.version} is already in changelog.json (use --replace).`],
      };
    }
    releases[index] = release;
  } else {
    releases.push(release);
  }
  releases.sort((a, b) => compareVersions(b.version, a.version) ?? 0);
  return { ok: true, errors: [], payload: { schemaVersion: 1, releases } };
}

/** Markdown body for one release, the same text the app renders. */
export function renderReleaseBody(release) {
  return `${release.sections
    .map(section => `## ${section.title}\n\n${section.items.map(item => `- ${item}`).join('\n')}`)
    .join('\n\n')}\n`;
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist.`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`, { cause: e });
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--replace' || arg === '--dry-run') {
      args[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value.`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exitCode = 1;
}

function publish(args) {
  const pkg = readJson(join(ROOT, 'package.json'));
  const version = args.version || pkg.version;
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) {
    fail([`x Version "${version}" is not numeric (1.2.3 or 1.2.3.4).`]);
    return;
  }
  const date = args.date || new Date().toISOString().slice(0, 10);
  const draftPath = args.draft ? join(ROOT, args.draft) : DRAFT;
  if (!existsSync(draftPath)) {
    fail([`x ${draftPath} does not exist.`]);
    return;
  }

  const sections = parseDraft(readFileSync(draftPath, 'utf8'));
  if (sections.length === 0) {
    fail([`x ${draftPath} has no "## Heading" and "- item" entries to publish.`]);
    return;
  }

  const existing = existsSync(CHANGELOG) ? readJson(CHANGELOG) : { schemaVersion: 1, releases: [] };
  const added = addRelease(existing, { version, date, sections }, { replace: args.replace });
  if (!added.ok) {
    fail(added.errors.map(e => `x ${e}`));
    return;
  }

  const checked = validateChangelogPayload(added.payload);
  if (!checked.ok) {
    fail(['x changelog.json would be invalid:', ...checked.errors.map(e => `  ${e}`)]);
    return;
  }

  const text = `${JSON.stringify(
    { schemaVersion: 1, releases: checked.releases },
    null,
    2,
  )}\n`;
  if (args['dry-run']) {
    console.log(text);
    return;
  }
  const temp = `${CHANGELOG}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, CHANGELOG);
  console.log(`Published ${version} (${date}) to changelog.json.`);
}

function validate(args) {
  const path = args.file ? join(ROOT, args.file) : CHANGELOG;
  const body = readJson(path);
  const checked = validateChangelogPayload(body);
  if (!checked.ok) {
    fail([`x ${path} is invalid:`, ...checked.errors.map(e => `  ${e}`)]);
    return;
  }
  console.log(`ok ${path}: ${checked.releases.length} release(s).`);
}

function body(args) {
  if (!args.version) {
    fail(['x body needs --version X.Y.Z.']);
    return;
  }
  const path = args.file ? join(ROOT, args.file) : CHANGELOG;
  const payload = readJson(path);
  const checked = validateChangelogPayload(payload);
  if (!checked.ok) {
    fail([`x ${path} is invalid:`, ...checked.errors.map(e => `  ${e}`)]);
    return;
  }
  // Compare the way the app does: 0.44 and 0.44.0 are one version.
  const release = checked.releases.find(r => compareVersions(r.version, args.version) === 0);
  if (!release) {
    fail([`x changelog.json has no entry for ${args.version}. Run publish first.`]);
    return;
  }
  const text = renderReleaseBody(release);
  if (args.out) {
    writeFileSync(args.out, text);
    console.log(`Wrote ${args.out}.`);
  } else {
    process.stdout.write(text);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail([`x ${e.message}`]);
    return;
  }
  const command = args._[0];
  if (command === 'publish') publish(args);
  else if (command === 'validate') validate(args);
  else if (command === 'body') body(args);
  else {
    fail(['x Usage: publish-changelog.mjs publish|validate|body [options]']);
  }
}

// Only run when invoked directly; the tests import the helpers above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
