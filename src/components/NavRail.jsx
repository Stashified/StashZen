/**
 * NavRail — the left navigation rail.
 *
 * Zone: 'grid'. That is load-bearing, not incidental. useKeyHandler excludes
 * cross-zone candidates for Left/Right (the `isHorizontal` guard in
 * findBestCandidate), which the nav hook's own notes state as "crossing zones
 * happens via Up/Down only" — correct for a horizontal tab strip, and exactly
 * backwards for a vertical rail. A rail in a zone of its own would be a trap:
 * Right would find no candidate at all and the content would be unreachable
 * from it. Joining the zone the cards already use (VideoCard via its legacy
 * `group` alias, MarkerCard and PerformerCard directly) makes Right walk into
 * the nearest card in the facing row and Left walk back, with no change to the
 * nav algorithm.
 *
 * Every row except the active one is also `verticalOnly` (see useFocusable),
 * so Left out of the content column can only ever land on the tab you are
 * already on. That is the user's "Left goes to the Home row" — stated as the
 * tab you are on, since that is the row the sliding indicator is under and the
 * one whose content is on screen. Rows stay reachable by Up/Down, which the
 * flag does not touch.
 */

import { useState, useEffect, useRef } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './NavRail.module.css';

// `next` is the row below, and it is declared rather than left to the layout.
// Settings sits at the *bottom* of the rail with a flexible spacer between it
// and the tabs, so how far below the tabs it lands is a function of the
// viewport height — and past a certain height the nearest grid card, which is
// only a couple of hundred pixels away diagonally, scores better than a
// destination hundreds of pixels straight down. With Settings also
// unreachable sideways (it is `verticalOnly`) that left it unreachable by
// remote at all. Reported from the TV, 2026-10-16:
//
//   "home row -> scrolling down doesnt reach settings -> couldnt think of way
//    to get there at all"
//
// Declaring the chain also says what the rail *is*: an ordered column, whose
// order is the order it is rendered in. The geometry is a rendering detail of
// that, and this is the one place where the difference shows.
// Eight tab rows as of 0.15.0; Settings is the ninth rail row. The chain is
// what makes each row reachable by Down, and every entry has to name its own
// successor — an entry added without a `next` is a row Down cannot leave,
// which on the TV reads as a dead remote. Settings names the other end
// (`prev`, at its call site) because it sits on the far side of the spacer and
// is the one row geometry cannot find.
//
// Scenes was split out of Home in 0.15.0: Home is now the showroom, and the
// scene listing it used to be lives one row below it.
const ITEMS = [
  { id: 'home',       label: 'Home',       Icon: IconHome,       next: 'scenes' },
  { id: 'scenes',     label: 'Scenes',     Icon: IconScenes,     next: 'performers' },
  { id: 'performers', label: 'Performers', Icon: IconPerformers, next: 'markers' },
  { id: 'markers',    label: 'Markers',    Icon: IconMarkers,    next: 'tags' },
  { id: 'tags',       label: 'Tags',       Icon: IconTags,       next: 'studios' },
  { id: 'studios',    label: 'Studios',    Icon: IconStudios,    next: 'galleries' },
  { id: 'galleries',  label: 'Galleries',  Icon: IconGalleries,  next: 'images' },
  { id: 'images',     label: 'Images',     Icon: IconImages,     next: 'settings' },
];

// ── Icons ────────────────────────────────────────────────
// Stroke-only and `currentColor`, so the focused/active rules below colour
// them by setting `color` and nothing else. 20px box, 1.8 stroke, round caps
// — the same idiom the app menu's hamburger already used.

function Svg({ children }) {
  return (
    <svg
      className={styles.icon}
      width="20" height="20" viewBox="0 0 20 20"
      fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IconHome() {
  return <Svg><path d="M3 9.3 10 3.2l7 6.1V16a1.2 1.2 0 0 1-1.2 1.2h-3.3v-4.6H8.5v4.6H4.2A1.2 1.2 0 0 1 3 16z" /></Svg>;
}

// A film frame with a play mark: Scenes is the flat listing, and the play
// triangle distinguishes it from the Images/Galleries frames below.
function IconScenes() {
  return (
    <Svg>
      <rect x="2.8" y="4.6" width="14.4" height="10.8" rx="1.4" />
      <path d="M8.4 7.9 12 10l-3.6 2.1z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

function IconPerformers() {
  return (
    <Svg>
      <circle cx="10" cy="6.6" r="3.1" />
      <path d="M4.2 17c0-3 2.6-4.8 5.8-4.8s5.8 1.8 5.8 4.8" />
    </Svg>
  );
}

function IconMarkers() {
  return <Svg><path d="M5.4 3.2h9.2a1 1 0 0 1 1 1v12.4l-5.6-3.4-5.6 3.4V4.2a1 1 0 0 1 1-1z" /></Svg>;
}

function IconTags() {
  return (
    <Svg>
      <path d="M3.2 9.6V4.6a1.4 1.4 0 0 1 1.4-1.4h5l7.2 7.2a1.4 1.4 0 0 1 0 2l-5 5a1.4 1.4 0 0 1-2 0z" />
      <circle cx="7.1" cy="7.1" r="1.25" />
    </Svg>
  );
}

function IconStudios() {
  return (
    <Svg>
      <path d="M3.2 17V7.4l1.5-3.5 9.9 1.7-.6 1.7" />
      <rect x="3.2" y="7.6" width="13.6" height="9.4" rx="1.3" />
      <path d="M3.2 11.4h13.6" />
    </Svg>
  );
}

function IconGalleries() {
  return (
    <Svg>
      <rect x="3" y="6.6" width="11" height="10.2" rx="1.3" />
      <path d="M6.4 4.2h8.2a1.4 1.4 0 0 1 1.4 1.4v8.2" />
    </Svg>
  );
}

function IconImages() {
  return (
    <Svg>
      <rect x="3" y="4.6" width="14" height="10.8" rx="1.4" />
      <circle cx="7.2" cy="8.3" r="1.25" />
      <path d="M3.5 13.4 7.4 10l2.6 2.3 2.7-2.4 3.3 3.1" />
    </Svg>
  );
}

function IconSettings() {
  return (
    <Svg>
      <path d="M3 6.4h13.6M3 13.6h13.6" />
      <circle cx="7.6" cy="6.4" r="1.9" />
      <circle cx="12.4" cy="13.6" r="1.9" />
    </Svg>
  );
}

// ── A rail row ───────────────────────────────────────────

function RailItem({ id, label, Icon, active, onSelect, autoFocus, registerRef, next, prev }) {
  // The rail's own order, which the spatial search cannot recover across the
  // spacer above Settings. See ITEMS. Declared one edge at a time so a row can
  // name the neighbour it has: the three tabs name the row below, Settings
  // names the row above. An undeclared direction is absent from the map and
  // falls through to the geometry, which is the old behaviour.
  const chain = {};
  if (next) chain.down = `nav-${next}`;
  if (prev) chain.up = `nav-${prev}`;

  const { ref, focused } = useFocusable({
    id: `nav-${id}`,
    zone: 'grid',
    nextId: chain,
    // Left returns you to the nav at the tab you are already on — that is what
    // `!active` buys. Every other row is unreachable by a Left/Right press, so
    // pressing Left from a card lands on the active row rather than on
    // whichever row happens to sit beside the card. Before this, Left from a
    // card in the lower rows went to Settings (it is the row nearest those
    // cards' vertical centre) and opened a modal on a sideways press.
    //
    // The cost is symmetrical and intended: Left from a card can never move
    // *between* rail rows. Up/Down do that, and they are unguarded.
    verticalOnly: !active,
    // And Down out of the content may not land here: while a listing's next
    // page is loading there is nothing below the last loaded row, and this
    // rail row was the only candidate — so a Down press during the load
    // dropped the cursor into the sidebar. See useKeyHandler's `skipRailRows`.
    // Declared on every row, so entering the rail from the *content* is the
    // only thing the flag changes; rail-internal Down is the declared chain.
    railRow: true,
    onEnter: onSelect,
    autoFocus,
    // The rail is where focus rests only until a tab's content claims it:
    // the first card may replace this boot-time focus, but never a focus the
    // user placed. See useFocusable's `autoFocusFallback`.
    autoFocusFallback: autoFocus,
  });

  // Merge the focusable ref with the registration callback so the rail can
  // measure this row for the sliding indicator. The parent owns the element
  // out of the ref, so keep it in step with whatever useFocusable holds.
  const setRef = (el) => {
    ref.current = el;
    registerRef(id, el);
  };

  return (
    <button
      ref={setRef}
      className={`${styles.item} ${active ? styles.active : ''} ${focused ? styles.focused : ''}`}
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
    >
      <Icon />
      <span className={styles.label}>{label}</span>
    </button>
  );
}

export default function NavRail({ activeTab, onTabChange, onOpenSettings }) {
  const itemRefs = useRef({});
  const [indicatorStyle, setIndicatorStyle] = useState({ top: 0, height: 0, opacity: 0 });

  const registerItemRef = (id, el) => {
    if (el) itemRefs.current[id] = el;
  };

  useEffect(() => {
    const el = itemRefs.current[activeTab];
    // No row for this tab — hide rather than leave the bar parked on whatever
    // row it was last on. Reachable only if a tab is ever added without a rail
    // entry, since Settings is not one.
    if (!el) {
      setIndicatorStyle((s) => ({ ...s, opacity: 0 }));
      return;
    }
    // Inset vertically so the bar sits inside the row's rounded corner rather
    // than running its full height. `opacity: 1` is what starts the fade-in:
    // the initial state is 0 so the bar does not slide up from the top on
    // first mount, and the CSS transitions top/height/opacity together.
    //
    // This was two effects once, and the second one — same [activeTab] deps,
    // no `opacity` — ran last and replaced this state object, dropping the
    // property so the fade never happened. Keep it in one place.
    setIndicatorStyle({
      top: el.offsetTop + 7,
      height: el.offsetHeight - 14,
      opacity: 1,
    });
  }, [activeTab]);

  const handleSettings = () => {
    onOpenSettings?.();
  };

  return (
    <nav className={styles.rail} aria-label="Main navigation">
      <span className={styles.slidingIndicator} style={indicatorStyle} />

      {ITEMS.map((item, i) => (
        <RailItem
          key={item.id}
          id={item.id}
          label={item.label}
          Icon={item.Icon}
          active={activeTab === item.id}
          onSelect={() => onTabChange(item.id)}
          autoFocus={i === 0}
          registerRef={registerItemRef}
          next={item.next}
        />
      ))}

      <div className={styles.spacer} />

      <RailItem
        id="settings"
        label="Settings"
        Icon={IconSettings}
        active={false}
        onSelect={handleSettings}
        // The other end of the same edge. Down into Settings is declared in
        // ITEMS; without this, Up out of it fell back to the geometry and
        // landed in the middle of the grid — the rail would be a column going
        // down and a scatter going up. Up is the only way back, since
        // Settings is `verticalOnly` and Left/Right cannot leave it.
        prev="images"
        // Down *from* Settings is declared as itself. A forced edge that
        // resolves to the element already focused is how a direction is
        // blocked (see useKeyHandler): Down stays put, and Right — the
        // sideways move into the content — is the only way out of the rail.
        // Without it the geometry found a grid card and Down left the rail
        // from its last row. Reported from the TV, 2026-10-17.
        next="settings"
        registerRef={registerItemRef}
      />
    </nav>
  );
}
