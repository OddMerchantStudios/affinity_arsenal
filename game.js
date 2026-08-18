'use strict';

/* ======================= CONFIG ======================= */

const GRID_COLS = 14;
const GRID_DEPTH = 4;    // buildable rows per player (depth 0 = nearest the neutral zone, depth GRID_DEPTH-1 = nearest the Core)
const NEUTRAL_ROWS = 8;  // decorative rows between the two players' territory
const TILE_UNLOCK_COST = 35; // energy to permanently unlock one locked tile (the row next to the Core starts unlocked)

// Icons below are deliberately drawn from pre-2017 emoji (confirmed to render everywhere) -
// several newer additions (wood log, mirror) turned out to render as blank boxes on real
// Windows browsers, not just the test sandbox, so this game avoids anything past ~Unicode 9.
// HP bumped up across the board so walls are a real obstacle rather than something regular
// turret fire chews through in a few seconds - see also the bullet nerf below.
const WALL_TIERS = [
  { key: 'wood', label: 'Wood Wall', icon: '\u{1F333}', cost: 20, buildTime: 2.0, hp: 150 },
  { key: 'stone', label: 'Stone Wall', icon: '\u{26F0}\u{FE0F}', cost: 30, buildTime: 3.0, hp: 320, requiresTech: ['armor1'] },
  { key: 'metal', label: 'Metal Wall', icon: '\u{2699}\u{FE0F}', cost: 55, buildTime: 4.0, hp: 560, requiresTech: ['armor2'] },
  { key: 'mirror', label: 'Mirror Wall', icon: '\u{1F52E}', cost: 90, buildTime: 5.0, hp: 480, requiresTech: ['armor3'], reflectsLaser: true },
];

// Fraction of a shot's base damage that actually lands, by [weapon kind][wall material].
const DAMAGE_MULTIPLIERS = {
  bullet: { wood: 0.5, stone: 0.06, metal: 0.03, mirror: 0.03 },
  rocket: { wood: 1.0, stone: 0.85, metal: 0.7, mirror: 0.7 },
  laser: { wood: 1.1, stone: 1.1, metal: 1.1, mirror: 1.1 },
  shotgun: { wood: 0.6, stone: 0.2, metal: 0.1, mirror: 0.1 },
  missile: { wood: 1.0, stone: 0.5, metal: 0.35, mirror: 0.35 },
  howitzer: { wood: 1.0, stone: 0.9, metal: 0.85, mirror: 0.85 },
  ionCannon: { wood: 1.3, stone: 1.3, metal: 1.3, mirror: 1.3 },
};
// The `mirror` entries above only apply when a Mirror Wall ISN'T actively reflecting (still
// under construction, or the defender can't afford the reflect - see MIRROR_REFLECT_* below and
// applyLaserDamageTick) - at those times it just takes damage like any other wall material.

// A Mirror Wall only reflects a FRACTION of an incoming laser/Ion Cannon tick back at the
// shooter - the rest lands on the wall itself (at the `mirror` multiplier above) - and the
// DEFENDER (not the attacker) pays energy to power each reflect, proportional to the damage
// reflected. If the defender can't afford it, the reflect doesn't happen that tick and the wall
// just eats the hit normally instead.
const MIRROR_REFLECT_FRACTION = 0.5; // 50% of incoming damage bounces back; the other 50% hits the wall
const MIRROR_REFLECT_ENERGY_PER_DAMAGE = 0.75; // defender energy spent per point of damage reflected

// Amplifier Mirrors add this much of a damage multiplier PER active mirror touching an Ion
// Cannon's tile - orthogonally or diagonally, so up to 8 around one cannon (1 mirror = +20%,
// a full 8-mirror ring = 1 + 8*0.2 = 2.6x).
const AMPLIFIER_BONUS_PER_MIRROR = 0.2;

// Chance a rocket gets shot down before impact, keyed by the intercepting bullet turret's tier.
// Only the highest-tier active, non-held bullet turret anywhere in the target column is checked.
const ROCKET_INTERCEPT_CHANCE = { 1: 0.30, 2: 0.45, 3: 0.60 };

const TURRET_KINDS = {
  bullet: {
    label: 'Bullet Turret',
    icon: '\u{1F52B}',
    // Deliberately weak - cheap, fast, useful for chipping unarmored targets and shooting down
    // rockets, but nowhere near enough to bring down a real wall on its own (see
    // DAMAGE_MULTIPLIERS.bullet). Tiers do NOT increase per-shot damage - only fire rate. Kept
    // cheap to fire even at higher tiers - it's meant to be spammable, not a real energy sink.
    tiers: [
      { cost: 40, buildTime: 3.0, damage: 6, fireInterval: 1.2, energyPerShot: 3 },
      { cost: 65, buildTime: 3.5, damage: 6, fireInterval: 0.8, energyPerShot: 3, requiresTech: ['firepower1'] },
      { cost: 100, buildTime: 4.0, damage: 6, fireInterval: 0.5, energyPerShot: 4, requiresTech: ['firepower2'] },
    ],
  },
  rocket: {
    label: 'Rocket Turret',
    icon: '\u{1F680}',
    tiers: [
      { cost: 70, buildTime: 4.0, damage: 35, fireInterval: 2.2, energyPerShot: 14 },
      { cost: 110, buildTime: 4.5, damage: 35, fireInterval: 1.6, energyPerShot: 16, requiresTech: ['firepower1'] },
      { cost: 160, buildTime: 5.0, damage: 35, fireInterval: 1.1, energyPerShot: 20, requiresTech: ['firepower2'] },
    ],
  },
  laser: {
    label: 'Laser Turret',
    icon: '\u{1F526}',
    // Lasers don't fire instantly: they charge, then channel a sustained beam that deals `dps`
    // for `beamDuration` seconds (draining `energyPerSecond` the whole time), then need
    // `cooldownAfter` before charging again. Tiers shorten the charge/cooldown, not the damage.
    tiers: [
      { cost: 90, buildTime: 4.5, dps: 22, chargeTime: 0.9, beamDuration: 2.0, cooldownAfter: 1.0, energyPerSecond: 9 },
      { cost: 140, buildTime: 5.0, dps: 22, chargeTime: 0.6, beamDuration: 2.0, cooldownAfter: 0.7, energyPerSecond: 9, requiresTech: ['firepower1'] },
      { cost: 200, buildTime: 5.5, dps: 22, chargeTime: 0.4, beamDuration: 2.2, cooldownAfter: 0.4, energyPerSecond: 9, requiresTech: ['firepower2'] },
    ],
  },

  // The Firepower branch's capstone weapon (see TECH_TREE.firepower3). Unlike the base Laser,
  // an Ion Cannon has no `beamDuration`/`cooldownAfter` - once charged, it just keeps firing
  // every tick for as long as it's toggled on (via the same Hold Fire button every other turret
  // uses, just inverted: it's built already "held" and the player has to actively release it to
  // fire). Running out of energy mid-beam doesn't turn it off, it just starves it for a tick -
  // same as any other turret waiting on energy - so it silently resumes the instant energy is
  // available again unless the player explicitly stops it. See tickIonCannon.
  ionCannon: {
    label: 'Ion Cannon',
    icon: '\u{2604}\u{FE0F}',
    tiers: [
      { cost: 260, buildTime: 7.0, dps: 26, chargeTime: 1.2, energyPerSecond: 14, requiresTech: ['firepower3'] },
    ],
  },

  // --- Tech Tree unlocks (see TECH_TREE, ordnance branch) - each of these needs its BASE tier
  // unlocked by researching the matching ordnance node, on top of a wall like any other turret.
  // Tier 2/3 additionally need the matching firepower node, same as bullet/rocket/laser above -
  // rushing ordnance without ever touching firepower gets you the weapon, just not a fast one.
  // `spread` + `falloff` make these hit multiple COLUMNS at once instead of a single lane -
  // the 2D-board equivalent of Forts' shotgun/swarm-missile/howitzer area weapons. falloff[n] is
  // the damage fraction dealt at n columns away from the target column (falloff[0] = the
  // targeted column itself). Tiers still only touch fire rate/cost, never per-hit damage.
  shotgun: {
    label: 'Shotgun Turret',
    icon: '\u{1F4A5}',
    spread: 1,
    falloff: [1, 1], // flat - full damage on the target column AND its immediate neighbors
    tiers: [
      { cost: 85, buildTime: 4.0, damage: 12, fireInterval: 1.8, energyPerShot: 18, requiresTech: ['ordnance1'] },
      { cost: 130, buildTime: 4.5, damage: 12, fireInterval: 1.3, energyPerShot: 22, requiresTech: ['ordnance1', 'firepower1'] },
      { cost: 190, buildTime: 5.0, damage: 12, fireInterval: 0.9, energyPerShot: 28, requiresTech: ['ordnance1', 'firepower2'] },
    ],
  },
  missile: {
    label: 'Missile Turret',
    icon: '\u{1F386}',
    spread: 2,
    falloff: [1, 1, 1], // a wide, flat swarm volley across 5 lanes
    slowProjectile: true, // missiles fly at ROCKET_FLIGHT_MS, not bullet speed
    tiers: [
      { cost: 150, buildTime: 5.5, damage: 18, fireInterval: 3.0, energyPerShot: 45, requiresTech: ['ordnance2'] },
      { cost: 210, buildTime: 6.0, damage: 18, fireInterval: 2.2, energyPerShot: 52, requiresTech: ['ordnance2', 'firepower1'] },
      { cost: 280, buildTime: 6.5, damage: 18, fireInterval: 1.6, energyPerShot: 60, requiresTech: ['ordnance2', 'firepower2'] },
    ],
  },
  howitzer: {
    label: 'Howitzer',
    icon: '\u{1F4A3}',
    spread: 2,
    falloff: [1, 0.5, 0.25], // heavy hit on the target column, real but shrinking splash beside it
    projectileClass: 'bullet kind-rocket', // reuse the big rocket projectile visual - this is the heaviest gun in the game
    slowProjectile: true, // travels at ROCKET_FLIGHT_MS instead of the faster BULLET_FLIGHT_MS
    // Deliberately >150⚡ per shot on every tier - the base energy cap (BASE_MAX_ENERGY) tops out
    // at 150, so firing a Howitzer even once is IMPOSSIBLE without an Energy Storage building.
    // This is the dedicated wall-cracker: high multipliers against every wall material above.
    tiers: [
      { cost: 260, buildTime: 8.0, damage: 270, fireInterval: 10.0, energyPerShot: 170, requiresTech: ['ordnance3'] },
      { cost: 340, buildTime: 8.5, damage: 270, fireInterval: 8.5, energyPerShot: 185, requiresTech: ['ordnance3', 'firepower1'] },
      { cost: 430, buildTime: 9.0, damage: 270, fireInterval: 7.0, energyPerShot: 200, requiresTech: ['ordnance3', 'firepower2'] },
    ],
  },
};

const TILE_TYPES = {
  wall: {
    label: 'Wall',
    icon: WALL_TIERS[0].icon,
    tiers: WALL_TIERS,
  },
  generator: {
    label: 'Generator',
    icon: '\u{26A1}',
    // Output kept deliberately low - energy should stay scarce enough that most of it gets
    // spent as it comes in rather than piling up into an easy surplus.
    tiers: [
      { cost: 50, buildTime: 3.0, energyRate: 2, hp: 60 },
      { cost: 85, buildTime: 4.0, energyRate: 4, hp: 90, requiresTech: ['logistics1'] },
      { cost: 130, buildTime: 5.0, energyRate: 6, hp: 130, requiresTech: ['logistics2'] },
    ],
  },
  storage: {
    label: 'Energy Storage',
    icon: '\u{1F50B}',
    tiers: [
      { cost: 60, buildTime: 3.5, capacityBonus: 80, hp: 70 },
      { cost: 100, buildTime: 4.5, capacityBonus: 150, hp: 100, requiresTech: ['logistics1'] },
      { cost: 150, buildTime: 5.5, capacityBonus: 250, hp: 140, requiresTech: ['logistics2'] },
    ],
  },
  // A single Research Lab building replaces the old separate Research/Weapons Lab tiles - see
  // TECH_TREE below. Its tier doesn't auto-grant anything by itself; it only (a) raises
  // `researchRate`, which is summed across every active lab a player owns to advance whichever
  // tech node they've selected, and (b) raises the max `labTier` a tech node may require to
  // even be startable. The actual unlocks all come from completing tree nodes.
  // Unlike every other building, a Research Lab's tier is NEVER manually upgraded for a cost -
  // it only rises when the matching Logistics node completes (see grantsLabTier in TECH_TREE
  // and the research-completion handling in tickPlayer, which bumps every active Lab a player
  // owns straight to the new tier for free). `labTierRank` here only gates building a NEW Lab
  // directly at that tier from the sidebar - see unlockedFor.
  researchLab: {
    label: 'Research Lab',
    icon: '\u{1F52C}',
    tiers: [
      { cost: 90, buildTime: 5.0, hp: 100, researchRate: 1.0 },
      { cost: 150, buildTime: 6.0, hp: 140, researchRate: 1.6, labTierRank: 2 },
      { cost: 220, buildTime: 7.0, hp: 180, researchRate: 2.2, labTierRank: 3 },
    ],
  },
  // Purely supportive - no energy, no HP-tanking role beyond its own HP. Its only job is sitting
  // next to an Ion Cannon: see AMPLIFIER_BONUS_PER_MIRROR / amplifierMultiplier.
  amplifier: {
    label: 'Amplifier Mirror',
    icon: '\u{1F48E}',
    tiers: [
      { cost: 45, buildTime: 3.0, hp: 90, requiresTech: ['firepower3'] },
    ],
  },
};

// ======================= TECH TREE =======================
// A branching tree, researched one node at a time. Building/upgrading a Research Lab never
// unlocks anything by itself - it only supplies research rate (ticked in tickPlayer) toward
// whichever single node the player has selected as their active project. Committing to a node
// means giving up progress on any other node for as long as it takes (`time` seconds, scaled by
// total active lab research rate) - so picking a path early, then having to decide whether to
// keep pushing it or pivot when the opponent's build reveals itself, IS the strategic layer this
// is meant to create. `requires` chains nodes within a branch into a straight line; `labTier` is
// the minimum active Research Lab tier needed to start a node at all (independent of `requires`).
const TECH_BRANCHES = [
  { key: 'armor', label: 'Armor', icon: '\u{1F6E1}\u{FE0F}' },
  { key: 'firepower', label: 'Firepower', icon: '\u{1F525}' },
  { key: 'ordnance', label: 'Ordnance', icon: '\u{1F4A3}' },
  { key: 'logistics', label: 'Logistics', icon: '\u{1F50B}' },
];

// `desc` is an array of short bullet points (rendered as a <ul> in both the sidebar node box and
// the tech tree overlay) rather than a paragraph - easier to scan at a glance.
const TECH_TREE = {
  armor1: { id: 'armor1', branch: 'armor', label: 'T1', desc: ['Unlocks Stone Wall', '320 HP · 30⚡ to build'], time: 25, energyPerSecond: 5, labTier: 1, requires: null },
  armor2: { id: 'armor2', branch: 'armor', label: 'T2', desc: ['Unlocks Metal Wall', '560 HP · 55⚡ to build'], time: 40, energyPerSecond: 6, labTier: 2, requires: 'armor1' },
  armor3: { id: 'armor3', branch: 'armor', label: 'T3', desc: [
    'Unlocks Mirror Wall (480 HP · 90⚡)',
    `Reflects ${Math.round(MIRROR_REFLECT_FRACTION * 100)}% of laser/Ion Cannon dmg back at the attacker`,
    `Costs you ${MIRROR_REFLECT_ENERGY_PER_DAMAGE}⚡ per point reflected`,
    `Other ${Math.round((1 - MIRROR_REFLECT_FRACTION) * 100)}% hits the wall normally`,
  ], time: 55, energyPerSecond: 8, labTier: 3, requires: 'armor2' },

  firepower1: { id: 'firepower1', branch: 'firepower', label: 'T1', desc: ['Unlocks Bullet/Rocket/Laser Tier 2', 'Faster fire rate, same damage per hit'], time: 30, energyPerSecond: 5, labTier: 1, requires: null },
  firepower2: { id: 'firepower2', branch: 'firepower', label: 'T2', desc: ['Unlocks Bullet/Rocket/Laser Tier 3', 'Faster fire rate, same damage per hit'], time: 45, energyPerSecond: 6, labTier: 2, requires: 'firepower1' },
  firepower3: { id: 'firepower3', branch: 'firepower', label: 'T3', desc: [
    'Unlocks Ion Cannon turret (continuous-fire beam)',
    'Unlocks Amplifier Mirror blocks',
    `Each Amplifier adds +${Math.round(AMPLIFIER_BONUS_PER_MIRROR * 100)}% Ion Cannon damage, stacking`,
  ], time: 60, energyPerSecond: 8, labTier: 3, requires: 'firepower2' },

  ordnance1: { id: 'ordnance1', branch: 'ordnance', label: 'T1', desc: ['Unlocks Shotgun Turret', 'Hits target lane + 1 lane each side'], time: 30, energyPerSecond: 5, labTier: 1, requires: null },
  ordnance2: { id: 'ordnance2', branch: 'ordnance', label: 'T2', desc: ['Unlocks Missile Turret', 'Hits target lane + 2 lanes each side'], time: 45, energyPerSecond: 6, labTier: 2, requires: 'ordnance1' },
  ordnance3: { id: 'ordnance3', branch: 'ordnance', label: 'T3', desc: ['Unlocks Howitzer', 'Heavy single-target hit, splash into 2 lanes each side'], time: 60, energyPerSecond: 8, labTier: 3, requires: 'ordnance2' },

  logistics1: { id: 'logistics1', branch: 'logistics', label: 'T1', desc: ['Unlocks Generator/Storage Tier 2', 'Auto-upgrades every active Research Lab to Tier 2'], time: 25, energyPerSecond: 5, labTier: 1, requires: null, grantsLabTier: 2 },
  logistics2: { id: 'logistics2', branch: 'logistics', label: 'T2', desc: ['Unlocks Generator/Storage Tier 3', 'Auto-upgrades every active Research Lab to Tier 3'], time: 40, energyPerSecond: 6, labTier: 2, requires: 'logistics1', grantsLabTier: 3 },
};

function techPrereqMet(player, node) { return !node.requires || player.completedResearch.has(node.requires); }
function techLabTierMet(player, node) { return player.labMaxTier >= node.labTier; }

// Node titles are deliberately bare ("T1"/"T2"/"T3") inside their own branch column, where the
// column header already gives the branch - but referenced anywhere OUTSIDE that context (toasts,
// status flags, the overlay's active-project box) they need the branch name to be unambiguous.
function techNodeDisplayName(node) {
  const branch = TECH_BRANCHES.find((b) => b.key === node.branch);
  return `${branch ? branch.label : node.branch} ${node.label}`;
}

const CORE_MAX_HP = 1000;
const CORE_ENERGY_RATE = 2;   // passive energy/sec from core alone - kept deliberately small
const BASE_MAX_ENERGY = 150;  // before any Energy Storage facilities
const START_ENERGY = 80;

const REPAIR_COST_PER_HP = 0.6;
const AUTO_REPAIR_RATE = 12; // hp/sec budget, shared across all damaged structures
const AUTO_REPAIR_COST_PER_HP = 0.75;

const DECON_TIME = 2.0;
const TURRET_DECON_TIME = 1.5;
const DECON_REFUND = 0.75;

const BULLET_FLIGHT_MS = 1500; // deliberately slow - sells the sense that shots are crossing a long battlefield
const ROCKET_FLIGHT_MS = 3500; // rockets travel noticeably slower than bullets
const BURST_TIER = 3;         // bullet turret tier that fires a cosmetic double-tracer burst
const BURST_STAGGER_MS = 70;

/* ======================= STATE ======================= */

function makeEmptyCell(unlocked) {
  return {
    type: 'empty', // 'empty' | 'wall' | 'generator' | 'storage' | 'researchLab'
    tier: 0,
    hp: 0,
    maxHp: 0,
    status: 'empty', // 'constructing' | 'active' | 'deconstructing'
    progress: 0,
    totalTime: 0,
    investedCost: 0,
    turret: null, // { kind, tier, status, progress, totalTime, investedCost, cooldown, holdFire, beamPhase, beamTimer, beamEl, upgrading }
    upgrading: null, // { targetTier, progress, totalTime, cost } while an in-place tier upgrade is timing out
    unlocked: !!unlocked,
  };
}

function makePlayer(key) {
  const grid = [];
  for (let d = 0; d < GRID_DEPTH; d++) {
    const rowStartsUnlocked = d === GRID_DEPTH - 1; // only the row adjacent to the Core starts unlocked
    const row = [];
    for (let c = 0; c < GRID_COLS; c++) row.push(makeEmptyCell(rowStartsUnlocked));
    grid.push(row);
  }
  return {
    key,
    energy: START_ENERGY,
    maxEnergy: BASE_MAX_ENERGY,
    core: { hp: CORE_MAX_HP, maxHp: CORE_MAX_HP },
    autoRepair: false,
    globalHoldFire: false,
    labMaxTier: 0,
    labUnlockedTier: 1, // highest Research Lab tier research has granted - see TECH_TREE grantsLabTier
    completedResearch: new Set(),
    activeResearchNode: null,
    researchProgress: 0,
    grid,
  };
}

const state = {
  players: { p1: makePlayer('p1'), p2: makePlayer('p2') },
  armed: null, // { player, kind, tier }
  selected: null, // { player, col, depth }
  expandedCategory: { p1: null, p2: null }, // which sidebar category (if any) is open per player
  techTreeOpen: null, // playerKey whose Tech Tree overlay is currently open, or null
  paused: false,
  started: false,
  speed: 1,
  lastTime: null,
  gameOver: false,
  vsCpu: false,          // single-player mode - state.cpuPlayer is driven by runCpuTurn instead of clicks
  cpuPlayer: 'p2',
  cpuDifficulty: 'normal',
  aiTimer: 0,
};

function otherKey(key) { return key === 'p1' ? 'p2' : 'p1'; }
function isTurretKind(kind) { return Object.prototype.hasOwnProperty.call(TURRET_KINDS, kind); }

/* ======================= ONLINE MULTIPLAYER ======================= */
// Host runs the real simulation (tick/tickPlayer) exactly like local hotseat play always has -
// the only difference online is that P2's clicks arrive over a WebRTC data channel (PeerJS)
// instead of the mouse, and the resulting state gets snapshotted back to the guest to render.
// The guest's browser never calls tick() itself - true peer-to-peer simulation would need the
// sim to be bit-for-bit deterministic (seeded RNG, fixed timestep) to keep both screens agreeing
// on who's winning, which this codebase isn't built for (plain Math.random(), wall-clock dt).
// Known MVP gap: projectile/beam animations are fired as one-off DOM effects from inside the
// simulation itself (see fireTurret et al.), not derived from persisted state, so they don't
// currently reach the guest - the guest still sees every HP/energy/build outcome update live,
// just without the flying-bullet/laser flourish while it happens.
const net = {
  active: false,      // true once this game is being played over a connection (host or guest)
  role: null,          // 'host' | 'guest'
  myPlayerKey: null,   // which side THIS browser controls - 'p1' for host, 'p2' for guest
  peer: null,          // PeerJS Peer instance
  conn: null,          // PeerJS DataConnection
  connected: false,
};

const NET_SNAPSHOT_INTERVAL = 1 / 20; // host -> guest state sync rate
let netSnapshotAccum = 0;

function netSend(msg) {
  if (net.conn && net.connected) net.conn.send(msg);
}

// One-off ambient VFX (the "+2⚡" that pops off a generator, "+0.4🔬" off a lab, "+6❤" off
// auto-repair) are fired as pure DOM side effects from inside tickPlayer, which only ever runs
// on the host - so without this, the guest would just see the numbers tick up with no visible
// heartbeat. These fire at most once per second per tile, so it's cheap to mirror as its own
// small message rather than folding it into the state snapshot.
function netFx(playerKey, d, c, text, cssClass, pulseClass) {
  if (net.active && net.role === 'host' && net.connected) {
    netSend({ t: 'fx', playerKey, d, c, text, cssClass, pulseClass });
  }
}

// --- snapshot (host's authoritative gameplay state -> guest's mirror) ---
// Deliberately hand-rolled rather than JSON.stringify(state.players) - a turret mid-beam holds a
// live DOM node (cell.turret.beamEl, see makeEmptyCell's comment) which isn't serializable, and
// this also lets the wire format skip the local-only UI fields (armed/selected/expandedCategory).
function serializeCell(cell) {
  return {
    type: cell.type, tier: cell.tier, hp: cell.hp, maxHp: cell.maxHp, status: cell.status,
    progress: cell.progress, totalTime: cell.totalTime, investedCost: cell.investedCost,
    unlocked: cell.unlocked,
    upgrading: cell.upgrading ? { ...cell.upgrading } : null,
    turret: cell.turret ? {
      kind: cell.turret.kind, tier: cell.turret.tier, status: cell.turret.status,
      progress: cell.turret.progress, totalTime: cell.turret.totalTime, investedCost: cell.turret.investedCost,
      cooldown: cell.turret.cooldown, holdFire: cell.turret.holdFire,
      beamPhase: cell.turret.beamPhase, beamTimer: cell.turret.beamTimer,
      upgrading: cell.turret.upgrading ? { ...cell.turret.upgrading } : null,
    } : null,
  };
}

function serializePlayerForNet(p) {
  return {
    energy: p.energy, maxEnergy: p.maxEnergy, core: { ...p.core },
    autoRepair: p.autoRepair, globalHoldFire: p.globalHoldFire,
    labMaxTier: p.labMaxTier, labUnlockedTier: p.labUnlockedTier,
    completedResearch: Array.from(p.completedResearch),
    activeResearchNode: p.activeResearchNode, researchProgress: p.researchProgress,
    grid: p.grid.map((row) => row.map(serializeCell)),
  };
}

function buildSnapshot() {
  return {
    t: 'snap',
    players: { p1: serializePlayerForNet(state.players.p1), p2: serializePlayerForNet(state.players.p2) },
    gameOver: state.gameOver, paused: state.paused, started: state.started, speed: state.speed,
  };
}

function applySnapshot(msg) {
  ['p1', 'p2'].forEach((k) => {
    const src = msg.players[k];
    const dst = state.players[k];
    dst.energy = src.energy; dst.maxEnergy = src.maxEnergy;
    dst.core.hp = src.core.hp; dst.core.maxHp = src.core.maxHp;
    dst.autoRepair = src.autoRepair; dst.globalHoldFire = src.globalHoldFire;
    dst.labMaxTier = src.labMaxTier; dst.labUnlockedTier = src.labUnlockedTier;
    dst.completedResearch = new Set(src.completedResearch);
    dst.activeResearchNode = src.activeResearchNode; dst.researchProgress = src.researchProgress;
    for (let d = 0; d < GRID_DEPTH; d++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const sc = src.grid[d][c];
        const dc = dst.grid[d][c];
        const keepBeamEl = (dc.turret && sc.turret && dc.turret.kind === sc.turret.kind) ? dc.turret.beamEl : null;
        if (dc.turret && dc.turret.beamEl && !keepBeamEl) dc.turret.beamEl.remove();
        Object.assign(dc, sc);
        dc.turret = sc.turret ? { ...sc.turret, beamEl: keepBeamEl } : null;
      }
    }
  });
  const justEnded = msg.gameOver && !state.gameOver;
  state.gameOver = msg.gameOver; state.paused = msg.paused; state.started = msg.started; state.speed = msg.speed;
  if (justEnded) {
    const p1Dead = state.players.p1.core.hp <= 0;
    const p2Dead = state.players.p2.core.hp <= 0;
    let title;
    if (p1Dead && p2Dead) title = 'Draw!';
    else if (p1Dead) title = 'P2 Wins!';
    else title = 'P1 Wins!';
    $('game-over-title').textContent = title;
    $('game-over-overlay').classList.remove('hidden');
    $('pause-btn').textContent = 'Resume';
  }
}

// --- actions (guest's own-side clicks -> host's authoritative mutation) ---
// Every gameplay mutation a click can trigger is registered here by name, taking the acting
// player's key plus a small serializable payload. Offline/hotseat/CPU play and the host's own
// clicks call runAction() and it executes immediately, same as before this existed; a guest's
// clicks on their own side get sent to the host instead of applied locally, and the host runs
// the exact same ACTIONS entry when the message arrives.
function cellAt(playerKey, depth, col) { return state.players[playerKey].grid[depth][col]; }

const ACTIONS = {
  unlockTile: (playerKey, { depth, col }) => tryUnlockTile(playerKey, depth, col),
  place: (playerKey, { depth, col, kind, tier }) => tryPlace(playerKey, depth, col, kind, tier),
  toggleAutoRepair: (playerKey) => { state.players[playerKey].autoRepair = !state.players[playerKey].autoRepair; },
  toggleGlobalHoldFire: (playerKey) => { state.players[playerKey].globalHoldFire = !state.players[playerKey].globalHoldFire; },
  cancelConstruction: (playerKey, { depth, col }) => cancelConstruction(state.players[playerKey], cellAt(playerKey, depth, col)),
  cancelDeconstruct: (playerKey, { depth, col }) => cancelDeconstruct(cellAt(playerKey, depth, col)),
  startUpgradeBase: (playerKey, { depth, col }) => startUpgradeBase(state.players[playerKey], cellAt(playerKey, depth, col)),
  cancelUpgradeBase: (playerKey, { depth, col }) => cancelUpgradeBase(state.players[playerKey], cellAt(playerKey, depth, col)),
  repairBase: (playerKey, { depth, col }) => repairBase(state.players[playerKey], cellAt(playerKey, depth, col)),
  cancelTurretConstruction: (playerKey, { depth, col }) => cancelTurretConstruction(state.players[playerKey], cellAt(playerKey, depth, col)),
  cancelTurretDeconstruct: (playerKey, { depth, col }) => cancelTurretDeconstruct(cellAt(playerKey, depth, col)),
  toggleHoldFire: (playerKey, { depth, col }) => toggleHoldFire(cellAt(playerKey, depth, col)),
  cancelUpgradeTurret: (playerKey, { depth, col }) => cancelUpgradeTurret(state.players[playerKey], cellAt(playerKey, depth, col)),
  startUpgradeTurret: (playerKey, { depth, col }) => startUpgradeTurret(state.players[playerKey], cellAt(playerKey, depth, col)),
  startTurretDeconstruct: (playerKey, { depth, col }) => startTurretDeconstruct(cellAt(playerKey, depth, col)),
  startDeconstruct: (playerKey, { depth, col }) => startDeconstruct(cellAt(playerKey, depth, col)),
  selectResearchNode: (playerKey, { nodeId }) => {
    const player = state.players[playerKey];
    const node = TECH_TREE[nodeId];
    if (player.completedResearch.has(nodeId) || player.activeResearchNode === nodeId) return;
    if (!techPrereqMet(player, node)) return;
    if (!techLabTierMet(player, node)) return;
    player.activeResearchNode = nodeId;
    player.researchProgress = 0;
  },
  cancelResearch: (playerKey) => {
    const player = state.players[playerKey];
    player.activeResearchNode = null;
    player.researchProgress = 0;
  },
};

function runAction(name, playerKey, payload) {
  if (net.active && net.role === 'guest') {
    if (playerKey !== net.myPlayerKey) return;
    netSend({ t: 'action', name, playerKey, payload: payload || {} });
    return;
  }
  ACTIONS[name](playerKey, payload || {});
}

function handleNetMessage(msg) {
  if (net.role === 'host') {
    if (msg.t === 'action') {
      const fn = ACTIONS[msg.name];
      if (fn) { fn(msg.playerKey, msg.payload || {}); renderAll(); }
    } else if (msg.t === 'requestStart') {
      // guest can't start; ignored - kept only so a stray message doesn't throw
    }
  } else if (net.role === 'guest') {
    if (msg.t === 'snap') {
      applySnapshot(msg);
      renderLive();
    } else if (msg.t === 'start') {
      applyLockVisuals();
      beginCountdown();
    } else if (msg.t === 'reset') {
      resetGame();
    } else if (msg.t === 'fx') {
      const row = cellEls[msg.playerKey] && cellEls[msg.playerKey][msg.d];
      const cellEl = row && row[msg.c] && row[msg.c].root;
      if (cellEl) {
        spawnFloatText(cellEl, msg.text, msg.cssClass);
        pulseCell(cellEl, msg.pulseClass);
      }
    }
  }
}

function setConnectionHandlers(conn) {
  net.conn = conn;
  conn.on('open', () => {
    net.connected = true;
    updateOnlineUI();
  });
  conn.on('data', (msg) => { try { handleNetMessage(msg); } catch (e) { console.error('[online] bad message', e); } });
  conn.on('close', () => {
    net.connected = false;
    showToast('Connection to your friend was lost.');
    updateOnlineUI();
  });
  conn.on('error', (err) => {
    console.error('[online]', err);
  });
}

function startHosting() {
  net.role = 'host';
  net.myPlayerKey = 'p1';
  net.active = true;
  const peer = new Peer();
  net.peer = peer;
  peer.on('open', (id) => {
    const link = `${location.origin}${location.pathname}?join=${id}`;
    const input = $('online-link-input');
    if (input) input.value = link;
    setOnlineStatus('online-status', `Waiting for a connection… (room code: ${id})`, '');
  });
  peer.on('connection', (conn) => {
    if (net.conn) { conn.close(); return; } // MVP: one guest at a time
    setConnectionHandlers(conn);
  });
  peer.on('error', (err) => {
    console.error('[online]', err);
    setOnlineStatus('online-status', `Connection error: ${err.type || err.message || err}`, 'error');
  });
}

function extractPeerId(raw) {
  const text = (raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    const fromQuery = url.searchParams.get('join');
    if (fromQuery) return fromQuery;
  } catch (e) { /* not a URL - treat as a raw code */ }
  return text;
}

function startJoining(rawIdOrLink) {
  const hostId = extractPeerId(rawIdOrLink);
  if (!hostId) { setOnlineStatus('online-join-status', 'Paste a valid link or code first.', 'error'); return; }
  net.role = 'guest';
  net.myPlayerKey = 'p2';
  net.active = true;
  buildBoard(true); // guest always sees their own side (p2) at the bottom, like chess.com
  fitBoard();
  setOnlineStatus('online-join-status', 'Connecting…', '');
  const peer = new Peer();
  net.peer = peer;
  peer.on('open', () => {
    const conn = peer.connect(hostId, { reliable: true });
    conn.on('open', () => setOnlineStatus('online-join-status', 'Connected! Waiting for host to start…', 'connected'));
    setConnectionHandlers(conn);
  });
  peer.on('error', (err) => {
    console.error('[online]', err);
    setOnlineStatus('online-join-status', `Connection error: ${err.type || err.message || err}`, 'error');
  });
}

function teardownNetworking() {
  const wasFlipped = net.myPlayerKey === 'p2';
  if (net.conn) { try { net.conn.close(); } catch (e) { /* ignore */ } }
  if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
  net.active = false; net.role = null; net.myPlayerKey = null; net.peer = null; net.conn = null; net.connected = false;
  document.body.dataset.lockedSide = '';
  if (wasFlipped) { buildBoard(false); fitBoard(); }
}

function setOnlineStatus(elId, text, cls) {
  const el = $(elId);
  if (!el) return;
  el.textContent = text;
  el.className = 'online-hint' + (cls ? ' ' + cls : '');
}

// Keeps the start screen in sync with the online panel's state - which of Host/Join is chosen,
// whether a connection is up yet, and who (if anyone) is allowed to press Start Game.
function updateOnlineUI() {
  const panel = $('online-panel');
  if (!panel) return;
  const onlineMode = selectedMode === 'online';
  panel.classList.toggle('hidden', !onlineMode);

  const startBtn = $('start-btn');
  if (startBtn) {
    if (!onlineMode) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
    } else if (net.role === 'host') {
      startBtn.classList.remove('hidden');
      startBtn.disabled = !net.connected;
    } else {
      startBtn.classList.add('hidden'); // guest, or haven't picked Host/Join yet
    }
  }

  if (net.role === 'host' && net.connected) {
    setOnlineStatus('online-status', "Connected! Click Start Game whenever you're ready.", 'connected');
  }

  const guestActive = net.active && net.role === 'guest';
  ['pause-btn', 'reset-btn'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = guestActive;
  });
  updateSpeedLock();
}

// Speed is a pre-game choice, not something to nudge mid-match - a PVP opponent (local or
// online) shouldn't be able to speed the game up or down on you once it's underway. CPU
// practice games are exempt since there's no opponent to affect.
function updateSpeedLock() {
  const el = $('speed-select');
  if (!el) return;
  const guestActive = net.active && net.role === 'guest';
  const lockedByMatch = state.started && !state.vsCpu;
  el.disabled = guestActive || lockedByMatch;
}

/* ======================= DOM REFS ======================= */

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const toolbars = { p1: $('toolbar-p1'), p2: $('toolbar-p2') };
const energyFill = { p1: $('p1-energy-fill'), p2: $('p2-energy-fill') };
const energyText = { p1: $('p1-energy-text'), p2: $('p2-energy-text') };
const researchFlag = { p1: $('p1-research-flag'), p2: $('p2-research-flag') };
const inspectorBody = $('inspector-body');
const toastLayer = $('toast-layer');

// cellEls[playerKey][depth][col] = { root, icon, statusBadge, chevrons, tierBadge, progressBar, progressFill, hpBar, hpFill }
const cellEls = { p1: [], p2: [] };
// coreCellEls[playerKey] = array of 14 { root } elements (left-to-right)
const coreCellEls = { p1: [], p2: [] };
const coreLabelEls = { p1: null, p2: null };
let bulletLayer = null;
let boardTotalRows = 0;

const BOARD_PADDING = 8; // must match .board padding in style.css
const BOARD_GAP = 3;     // must match .board gap in style.css
const CELL_MAX = 54;
const CELL_MIN = 24;

// The board has a fixed row/column count but the viewport doesn't - this keeps every cell
// square and shrinks them to whatever fits so the game never needs to scroll. #board-wrap is
// content-sized (not flex-stretched) so the sidebar and inspector sit right up against the
// board instead of floating off at the edges of a wide viewport - which means we can't read
// the available width off board-wrap itself; it has to come from what's left of #main-layout
// after the two fixed-width side panels and gaps are subtracted.
function fitBoard() {
  const wrap = $('board-wrap');
  const mainLayout = $('main-layout');
  const sidebar = $('left-sidebar');
  const inspector = $('inspector');
  if (!wrap || !mainLayout || !sidebar || !inspector || !boardEl || !boardTotalRows) return;
  const layoutStyle = getComputedStyle(mainLayout);
  const paddingX = parseFloat(layoutStyle.paddingLeft) + parseFloat(layoutStyle.paddingRight);
  const gapPx = parseFloat(layoutStyle.columnGap) || 0;
  const availH = wrap.clientHeight - BOARD_PADDING * 2;
  const availW = mainLayout.clientWidth - paddingX - sidebar.offsetWidth - inspector.offsetWidth - gapPx * 2 - BOARD_PADDING * 2;
  const cellH = (availH - BOARD_GAP * (boardTotalRows - 1)) / boardTotalRows;
  const cellW = (availW - BOARD_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(Math.min(cellH, cellW))));
  boardEl.style.setProperty('--cell', cell + 'px');
}

/* ======================= BUILD STATIC DOM ======================= */

// Sidebar build options are grouped into categories, each an accordion section: click the
// header to expand/collapse it (only one open per player at a time). Every group within a
// category lists ALL of its tiers as separate buttons - not just the next upgrade - so once
// research unlocks a higher tier it can be built directly from scratch. Direct-tier buttons
// are pre-built for every tier up front and just hidden/shown per render (see
// renderCategoryPanel) rather than rebuilt each frame.
const CATEGORY_DEFS = [
  { key: 'walls', label: 'Walls', icon: '\u{1F6E1}\u{FE0F}', groups: [
    { kind: 'wall', def: TILE_TYPES.wall },
  ] },
  { key: 'turrets', label: 'Turrets', icon: '\u{1F52B}', groups: [
    { kind: 'bullet', def: TURRET_KINDS.bullet, extra: ' (needs wall)' },
    { kind: 'rocket', def: TURRET_KINDS.rocket, extra: ' (needs wall)' },
    { kind: 'laser', def: TURRET_KINDS.laser, extra: ' (needs wall)' },
    { kind: 'shotgun', def: TURRET_KINDS.shotgun, extra: ' (needs wall)' },
    { kind: 'missile', def: TURRET_KINDS.missile, extra: ' (needs wall)' },
    { kind: 'howitzer', def: TURRET_KINDS.howitzer, extra: ' (needs wall)' },
  ] },
  { key: 'energy', label: 'Energy', icon: '\u{26A1}', groups: [
    { kind: 'generator', def: TILE_TYPES.generator },
    { kind: 'storage', def: TILE_TYPES.storage },
  ] },
  { key: 'utility', label: 'Utility', icon: '\u{1F52C}', groups: [
    { kind: 'researchLab', def: TILE_TYPES.researchLab },
  ] },
  { key: 'advanced', label: 'Advanced', icon: '\u{2604}\u{FE0F}', groups: [
    { kind: 'ionCannon', def: TURRET_KINDS.ionCannon, extra: ' (needs wall)' },
    { kind: 'amplifier', def: TILE_TYPES.amplifier },
  ] },
];

function tiersArrayFor(kind) {
  return isTurretKind(kind) ? TURRET_KINDS[kind].tiers : TILE_TYPES[kind].tiers;
}

// Cost/time to build `kind` directly at `targetTier` from an empty tile - the sum of every
// tier's cost/time up to and including the target, since that's what step-by-step upgrading
// would have cost/taken in total. Direct-build spends the same energy but takes longer overall
// (upgrades apply instantly once placed, so the only thing direct-build trades away is time -
// what it buys back is not having to click through each intermediate tier).
function cumulativeStats(kind, targetTier) {
  const tiers = tiersArrayFor(kind);
  let cost = 0, time = 0;
  for (let i = 0; i < targetTier; i++) { cost += tiers[i].cost; time += tiers[i].buildTime; }
  return { cost, time };
}

// categoryEls[playerKey][catKey] = { catEl, header, body, groups: [{ kind, def, extra, tierButtons: [{ tier, tierCfg, btn }] }] }
const categoryEls = { p1: {}, p2: {} };

function buildCategoryPanel(playerKey) {
  const container = toolbars[playerKey];
  container.innerHTML = '';
  categoryEls[playerKey] = {};

  CATEGORY_DEFS.forEach((cat) => {
    const catEl = document.createElement('div');
    catEl.className = 'category';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'category-header';
    header.innerHTML = `<span class="cat-icon">${cat.icon}</span><span class="cat-label">${cat.label}</span><span class="chev">▸</span>`;
    header.addEventListener('click', () => {
      const cur = state.expandedCategory[playerKey];
      state.expandedCategory[playerKey] = cur === cat.key ? null : cat.key;
      renderAll();
    });
    catEl.appendChild(header);

    const body = document.createElement('div');
    body.className = 'category-body';

    const groups = cat.groups.map((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'option-group';
      const groupLabel = document.createElement('div');
      groupLabel.className = 'option-group-label';
      groupLabel.textContent = group.def.label;
      groupEl.appendChild(groupLabel);

      const buttonsWrap = document.createElement('div');
      buttonsWrap.className = 'tier-options';

      const tierButtons = group.def.tiers.map((tierCfg, idx) => {
        const tier = idx + 1;
        const btn = document.createElement('button');
        btn.className = 'tool-btn tier-option';
        btn.dataset.kind = group.kind;
        btn.dataset.tier = String(tier);
        btn.addEventListener('click', () => armTool(playerKey, group.kind, tier));
        buttonsWrap.appendChild(btn);
        return { tier, tierCfg, btn };
      });

      groupEl.appendChild(buttonsWrap);
      body.appendChild(groupEl);
      return { kind: group.kind, def: group.def, extra: group.extra, tierButtons };
    });

    catEl.appendChild(body);
    container.appendChild(catEl);
    categoryEls[playerKey][cat.key] = { catEl, header, body, groups };
  });
}

function buildCardActions(playerKey) {
  const container = $(`card-actions-${playerKey}`);
  container.innerHTML = '';

  // Auto-Repair and Hold All Fire are both per-player TOGGLES that affect existing structures,
  // not buildable things - they live here, styled identically, rather than in the categorized
  // build list above.
  const repairToggle = document.createElement('button');
  repairToggle.className = 'tool-btn toggle';
  repairToggle.id = `autorepair-${playerKey}`;
  repairToggle.innerHTML = `<span class="tname"></span>`;
  repairToggle.addEventListener('click', () => {
    runAction('toggleAutoRepair', playerKey);
    renderAll();
  });
  container.appendChild(repairToggle);

  const holdAllBtn = document.createElement('button');
  holdAllBtn.className = 'tool-btn toggle holdall-btn';
  holdAllBtn.id = `holdall-${playerKey}`;
  holdAllBtn.innerHTML = `<span class="tname"></span>`;
  holdAllBtn.addEventListener('click', () => {
    runAction('toggleGlobalHoldFire', playerKey);
    renderAll();
  });
  container.appendChild(holdAllBtn);
}

function armTool(playerKey, kind, tier = 1) {
  if (state.armed && state.armed.player === playerKey && state.armed.kind === kind && state.armed.tier === tier) {
    state.armed = null;
  } else {
    state.armed = { player: playerKey, kind, tier };
  }
  renderAll();
}

function makeCellDom(extraClass) {
  const el = document.createElement('div');
  el.className = extraClass ? `cell ${extraClass}` : 'cell';
  el.innerHTML = `
    <span class="icon"></span>
    <span class="status-badge"></span>
    <span class="chevrons"></span>
    <span class="tier-badge"></span>
    <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    <div class="hp-bar"><div class="hp-bar-fill"></div></div>
  `;
  return el;
}

// `flip` mirrors the whole board (both row order and column order) so whoever's sitting at
// THIS browser always sees their own side at the bottom, nearest their own player card - like
// chess.com always showing your own pieces at the bottom regardless of color. Only ever true
// for an online guest (who controls p2, normally drawn at the top) - host, hotseat and CPU play
// keep the original P2-top/P1-bottom layout untouched. Every cell keeps its logical
// (playerKey, depth, col) identity and cellEls[] lookup either way - flip only changes which
// physical grid-row/grid-column a cell's DOM element is placed at.
function buildBoard(flip) {
  boardEl.innerHTML = '';
  cellEls.p1 = Array.from({ length: GRID_DEPTH }, () => new Array(GRID_COLS));
  cellEls.p2 = Array.from({ length: GRID_DEPTH }, () => new Array(GRID_COLS));
  coreCellEls.p1 = [];
  coreCellEls.p2 = [];

  const TOTAL_ROWS = 2 * GRID_DEPTH + NEUTRAL_ROWS + 2;
  const rowLine = (logicalRow) => (flip ? TOTAL_ROWS - logicalRow + 1 : logicalRow);
  const colLine = (col) => (flip ? GRID_COLS - col : col + 1);

  // Every cell gets an EXPLICIT grid-row/grid-column. Mixing explicit placement (the core
  // labels, which span the full row width) with implicit auto-placement (plain cells with no
  // grid-row/column set) is a CSS Grid footgun: the spec resolves all explicitly-positioned
  // items first, so auto-placed cells skip around whatever row the labels reserved, and
  // everything after it silently shifts down by a row. Explicit placement for every cell
  // sidesteps that entirely.
  let gridRow = 1; // logical row, 1-indexed - see rowLine() for the actual CSS grid-row

  const placeCell = (el, col) => {
    el.style.gridRow = String(rowLine(gridRow));
    el.style.gridColumn = String(colLine(col));
    boardEl.appendChild(el);
  };

  const appendRow = (rowBuilder) => {
    for (let col = 0; col < GRID_COLS; col++) {
      const alt = (gridRow + col) % 2 === 1;
      placeCell(rowBuilder(col, alt), col);
    }
    gridRow++;
  };

  // P2 core row
  appendRow((col, alt) => {
    const el = makeCellDom(`core-cell${alt ? ' alt' : ''}`);
    el.addEventListener('click', () => onCoreClick('p2'));
    coreCellEls.p2.push({ root: el });
    return el;
  });

  // P2 buildable rows, deepest (depth 2) first so depth 0 ends up adjacent to the neutral zone
  for (let depth = GRID_DEPTH - 1; depth >= 0; depth--) {
    appendRow((col, alt) => {
      const el = makeCellDom(alt ? 'alt' : '');
      el.dataset.player = 'p2';
      el.dataset.depth = String(depth);
      el.dataset.col = String(col);
      el.addEventListener('click', () => onCellClick('p2', depth, col));
      cellEls.p2[depth][col] = wrapRefs(el);
      return el;
    });
  }

  const neutralStartRow = gridRow;
  for (let n = 0; n < NEUTRAL_ROWS; n++) {
    appendRow((col, alt) => makeCellDom(`neutral${alt ? ' alt' : ''}`));
  }
  const neutralEndRow = gridRow - 1;

  // P1 buildable rows, depth 0 first (adjacent to the neutral zone)
  for (let depth = 0; depth < GRID_DEPTH; depth++) {
    appendRow((col, alt) => {
      const el = makeCellDom(alt ? 'alt' : '');
      el.dataset.player = 'p1';
      el.dataset.depth = String(depth);
      el.dataset.col = String(col);
      el.addEventListener('click', () => onCellClick('p1', depth, col));
      cellEls.p1[depth][col] = wrapRefs(el);
      return el;
    });
  }

  // P1 core row
  appendRow((col, alt) => {
    const el = makeCellDom(`core-cell${alt ? ' alt' : ''}`);
    el.addEventListener('click', () => onCoreClick('p1'));
    coreCellEls.p1.push({ root: el });
    return el;
  });

  const totalRows = gridRow - 1;
  boardTotalRows = totalRows;
  boardEl.style.gridTemplateRows = `repeat(${totalRows}, var(--cell, 54px))`;

  // Core HP labels, explicitly grid-placed to span the full width of their row
  coreLabelEls.p2 = document.createElement('div');
  coreLabelEls.p2.className = 'core-label';
  coreLabelEls.p2.style.gridRow = String(rowLine(1));
  coreLabelEls.p2.style.gridColumn = `1 / -1`;
  boardEl.appendChild(coreLabelEls.p2);

  coreLabelEls.p1 = document.createElement('div');
  coreLabelEls.p1.className = 'core-label';
  coreLabelEls.p1.style.gridRow = String(rowLine(totalRows));
  coreLabelEls.p1.style.gridColumn = `1 / -1`;
  boardEl.appendChild(coreLabelEls.p1);

  // Neutral zone label, spanning all of its rows - flip reverses which logical row maps to the
  // top, so the span's start/end swap too (see rowLine()'s comment on buildBoard).
  const neutralLabel = document.createElement('div');
  neutralLabel.className = 'neutral-label';
  neutralLabel.textContent = 'NEUTRAL ZONE';
  neutralLabel.style.gridRow = flip
    ? `${rowLine(neutralEndRow)} / ${rowLine(neutralStartRow) + 1}`
    : `${neutralStartRow} / ${neutralEndRow + 1}`;
  neutralLabel.style.gridColumn = `1 / -1`;
  boardEl.appendChild(neutralLabel);

  // Bullet overlay, covers the whole board
  bulletLayer = document.createElement('div');
  bulletLayer.id = 'bullet-layer';
  boardEl.appendChild(bulletLayer);
}

function wrapRefs(el) {
  return {
    root: el,
    icon: el.querySelector('.icon'),
    statusBadge: el.querySelector('.status-badge'),
    chevrons: el.querySelector('.chevrons'),
    tierBadge: el.querySelector('.tier-badge'),
    progressBar: el.querySelector('.progress-bar'),
    progressFill: el.querySelector('.progress-bar-fill'),
    hpBar: el.querySelector('.hp-bar'),
    hpFill: el.querySelector('.hp-bar-fill'),
  };
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.armed = null;
    state.selected = null;
    state.expandedCategory = { p1: null, p2: null };
    if (state.techTreeOpen) { state.techTreeOpen = null; techTreeSig = null; }
    renderAll();
  }
});

// Clicking anywhere outside every category (both players', any header or flyout body) closes
// whatever's open - lets players dismiss a flyout by clicking the board tile they meant to
// build on, or just clicking away, without having to re-click the header. A click that lands
// on SOME category (even a different one, even the other player's) is left alone here - that
// category's own header handles opening/closing itself, and shouldn't blow away an unrelated
// flyout that happens to be open at the same time.
document.addEventListener('click', (e) => {
  const insideSomeCategory = ['p1', 'p2'].some((playerKey) =>
    Object.values(categoryEls[playerKey] || {}).some((refs) => refs.catEl.contains(e.target))
  );
  if (insideSomeCategory) return;

  let changed = false;
  ['p1', 'p2'].forEach((playerKey) => {
    if (state.expandedCategory[playerKey]) { state.expandedCategory[playerKey] = null; changed = true; }
  });
  if (changed) renderAll();
});

/* ======================= ACTIONS ======================= */

function unlockedFor(player, tierCfg) {
  if (tierCfg.labTierRank && player.labUnlockedTier < tierCfg.labTierRank) return false;
  if (!tierCfg.requiresTech) return true;
  return tierCfg.requiresTech.every((id) => player.completedResearch.has(id));
}

function missingTechLabel(player, tierCfg) {
  const parts = [];
  if (tierCfg.labTierRank && player.labUnlockedTier < tierCfg.labTierRank) {
    parts.push(`Research Lab reaching Tier ${tierCfg.labTierRank} (via research)`);
  }
  if (tierCfg.requiresTech) {
    parts.push(...tierCfg.requiresTech.filter((id) => !player.completedResearch.has(id)).map((id) => techNodeDisplayName(TECH_TREE[id])));
  }
  return parts.join(' & ');
}

function flashInvalid(cellEl) {
  if (!cellEl) return;
  cellEl.style.outline = '2px solid #e0574a';
  setTimeout(() => { cellEl.style.outline = ''; }, 250);
}

let toastTimer = null;
function showToast(message) {
  toastLayer.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, 2600);
}

function explainPlacementFailure(playerKey, depth, col, kind, tier = 1) {
  const player = state.players[playerKey];
  const cell = player.grid[depth][col];

  if (isTurretKind(kind)) {
    if (cell.type !== 'wall') return 'Turrets can only be built on top of a wall.';
    if (cell.status !== 'active') return "That wall isn't finished building yet.";
    if (cell.turret) return 'That wall already has a turret on it.';
    const tierCfg = TURRET_KINDS[kind].tiers[tier - 1];
    if (!unlockedFor(player, tierCfg)) return `Locked — research ${missingTechLabel(player, tierCfg)} first.`;
    const { cost } = cumulativeStats(kind, tier);
    if (player.energy < cost) return `Not enough energy — need ${cost}⚡, have ${Math.floor(player.energy)}⚡.`;
    return "Can't place that there.";
  }

  const def = TILE_TYPES[kind];
  const tierCfg = def.tiers[tier - 1];
  if (cell.type !== 'empty') return 'That tile is already occupied.';
  if (!unlockedFor(player, tierCfg)) return `Locked — research ${missingTechLabel(player, tierCfg)} first.`;
  const { cost } = cumulativeStats(kind, tier);
  if (player.energy < cost) return `Not enough energy — need ${cost}⚡, have ${Math.floor(player.energy)}⚡.`;
  return "Can't place that there.";
}

function onCellClick(playerKey, depth, col) {
  const player = state.players[playerKey];
  const cell = player.grid[depth][col];
  const cellEl = cellEls[playerKey][depth][col].root;

  if (!cell.unlocked) {
    runAction('unlockTile', playerKey, { depth, col });
    renderAll();
    return;
  }

  if (state.armed && state.armed.player === playerKey) {
    const kind = state.armed.kind;
    const tier = state.armed.tier || 1;
    const canAttemptHere = isTurretKind(kind)
      ? (cell.type === 'wall' && cell.status === 'active' && !cell.turret)
      : cell.type === 'empty';

    if (canAttemptHere) {
      if (net.active && net.role === 'guest') {
        runAction('place', playerKey, { depth, col, kind, tier });
      } else {
        const ok = tryPlace(playerKey, depth, col, kind, tier);
        if (!ok) {
          flashInvalid(cellEl);
          showToast(explainPlacementFailure(playerKey, depth, col, kind, tier));
        }
      }
      renderAll();
      return;
    }
    // Tile isn't a valid placement target for the armed tool (e.g. it's already occupied) -
    // fall through and just inspect it instead of failing silently.
  }

  if (cell.type === 'empty') {
    state.selected = null;
  } else {
    state.selected = { player: playerKey, depth, col };
  }
  renderAll();
}

function onCoreClick(playerKey) {
  state.selected = { player: playerKey, core: true };
  renderAll();
}

function tryUnlockTile(playerKey, depth, col) {
  const player = state.players[playerKey];
  const cell = player.grid[depth][col];
  if (cell.unlocked) return;
  if (player.energy < TILE_UNLOCK_COST) {
    showToast(`Not enough energy to unlock this tile — need ${TILE_UNLOCK_COST}⚡, have ${Math.floor(player.energy)}⚡.`);
    return;
  }
  player.energy -= TILE_UNLOCK_COST;
  cell.unlocked = true;
}

function tryPlace(playerKey, depth, col, kind, targetTier = 1) {
  const player = state.players[playerKey];
  const cell = player.grid[depth][col];
  if (!cell.unlocked) return false;

  if (isTurretKind(kind)) {
    const tierCfg = TURRET_KINDS[kind].tiers[targetTier - 1];
    if (!tierCfg) return false;
    if (cell.type !== 'wall' || cell.status !== 'active' || cell.turret) return false;
    if (!unlockedFor(player, tierCfg)) return false;
    const { cost, time } = cumulativeStats(kind, targetTier);
    if (player.energy < cost) return false;
    player.energy -= cost;
    cell.turret = {
      kind,
      tier: targetTier,
      status: 'constructing',
      progress: time,
      totalTime: time,
      investedCost: cost,
      cooldown: 0,
      // An Ion Cannon is built "held" - it stays off until the player explicitly starts it via
      // the same Hold Fire toggle every other turret uses, since it just keeps firing (and
      // draining energy) once released rather than settling into a fire-then-cooldown cycle.
      holdFire: kind === 'ionCannon',
      beamPhase: 'idle',
      beamTimer: 0,
      beamEl: null,
      upgrading: null,
    };
    return true;
  }

  const def = TILE_TYPES[kind];
  const tierCfg = def.tiers[targetTier - 1];
  if (!tierCfg) return false;
  if (cell.type !== 'empty') return false;
  if (!unlockedFor(player, tierCfg)) return false;
  const { cost, time } = cumulativeStats(kind, targetTier);
  if (player.energy < cost) return false;

  player.energy -= cost;
  cell.type = kind;
  cell.tier = targetTier;
  cell.hp = 0; // ramps up to maxHp as construction progresses - see tickPlayer - so a half-built
  cell.maxHp = tierCfg.hp; // tile is genuinely fragile, not already at full defensive strength
  cell.status = 'constructing';
  cell.progress = time;
  cell.totalTime = time;
  cell.investedCost = cost;
  return true;
}

function cancelConstruction(player, cell) {
  if (cell.status !== 'constructing') return;
  player.energy = Math.min(player.maxEnergy, player.energy + cell.investedCost);
  Object.assign(cell, makeEmptyCell(cell.unlocked));
}

function cancelTurretConstruction(player, cell) {
  if (!cell.turret || cell.turret.status !== 'constructing') return;
  player.energy = Math.min(player.maxEnergy, player.energy + cell.turret.investedCost);
  cell.turret = null;
}

function startDeconstruct(cell) {
  if (cell.status !== 'active') return;
  cell.status = 'deconstructing';
  cell.progress = DECON_TIME;
  cell.totalTime = DECON_TIME;
}

function cancelDeconstruct(cell) {
  if (cell.status !== 'deconstructing') return;
  cell.status = 'active';
  cell.progress = 0;
}

function startTurretDeconstruct(cell) {
  if (!cell.turret || cell.turret.status !== 'active') return;
  cell.turret.status = 'deconstructing';
  cell.turret.progress = TURRET_DECON_TIME;
  cell.turret.totalTime = TURRET_DECON_TIME;
}

function cancelTurretDeconstruct(cell) {
  if (!cell.turret || cell.turret.status !== 'deconstructing') return;
  cell.turret.status = 'active';
  cell.turret.progress = 0;
}

// Upgrading isn't instant: cost is paid up front (same as construction) but the tier only
// actually changes once `cell.upgrading`'s timer runs out in tickPlayer - see finishUpgradeBase.
// The tile keeps operating at its CURRENT tier the whole time (no downtime), so this is purely a
// time cost, not a functionality gap - but it does mean a destroyed tile mid-upgrade loses
// whatever was invested, same as a destroyed construction-in-progress would.
function startUpgradeBase(player, cell) {
  if (cell.type === 'researchLab') return false; // tier only rises via grantLabTier - see there
  if (cell.status !== 'active' || cell.upgrading) return false;
  const def = TILE_TYPES[cell.type];
  if (cell.tier >= def.tiers.length) return false;
  const nextCfg = def.tiers[cell.tier]; // tier index = cell.tier (0-based next)
  if (!unlockedFor(player, nextCfg)) return false;
  if (player.energy < nextCfg.cost) return false;
  player.energy -= nextCfg.cost;
  cell.upgrading = { targetTier: cell.tier + 1, progress: nextCfg.buildTime, totalTime: nextCfg.buildTime, cost: nextCfg.cost };
  return true;
}

function finishUpgradeBase(cell) {
  const def = TILE_TYPES[cell.type];
  const targetTier = cell.upgrading.targetTier;
  const nextCfg = def.tiers[targetTier - 1];
  const hpDelta = nextCfg.hp - def.tiers[cell.tier - 1].hp;
  cell.tier = targetTier;
  cell.maxHp = nextCfg.hp;
  cell.hp = Math.min(cell.maxHp, cell.hp + hpDelta);
  cell.investedCost += cell.upgrading.cost;
  cell.upgrading = null;
}

function cancelUpgradeBase(player, cell) {
  if (!cell.upgrading) return;
  player.energy = Math.min(player.maxEnergy, player.energy + cell.upgrading.cost);
  cell.upgrading = null;
}

function startUpgradeTurret(player, cell) {
  if (!cell.turret || cell.turret.status !== 'active' || cell.turret.upgrading) return false;
  const kindDef = TURRET_KINDS[cell.turret.kind];
  if (cell.turret.tier >= kindDef.tiers.length) return false;
  const nextCfg = kindDef.tiers[cell.turret.tier];
  if (!unlockedFor(player, nextCfg)) return false;
  if (player.energy < nextCfg.cost) return false;
  player.energy -= nextCfg.cost;
  cell.turret.upgrading = { targetTier: cell.turret.tier + 1, progress: nextCfg.buildTime, totalTime: nextCfg.buildTime, cost: nextCfg.cost };
  return true;
}

function finishUpgradeTurret(cell) {
  const turret = cell.turret;
  turret.tier = turret.upgrading.targetTier;
  turret.investedCost += turret.upgrading.cost;
  turret.upgrading = null;
}

function cancelUpgradeTurret(player, cell) {
  if (!cell.turret || !cell.turret.upgrading) return;
  player.energy = Math.min(player.maxEnergy, player.energy + cell.turret.upgrading.cost);
  cell.turret.upgrading = null;
}

function repairBase(player, cell) {
  // Deliberately active-only: a constructing tile's "missing" HP is just unfinished build
  // progress, not damage, so paying to fill it would let players buy past the fragility window.
  if (cell.status !== 'active') return;
  const missing = cell.maxHp - cell.hp;
  if (missing <= 0) return;
  const cost = Math.ceil(missing * REPAIR_COST_PER_HP);
  if (player.energy < cost) return;
  player.energy -= cost;
  cell.hp = cell.maxHp;
}

function toggleHoldFire(cell) {
  if (!cell.turret) return;
  cell.turret.holdFire = !cell.turret.holdFire;
}

/* ======================= SIMULATION TICK ======================= */

function findLabMaxTier(player) {
  let max = 0;
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'researchLab' && cell.status === 'active') {
        max = Math.max(max, cell.tier);
      }
    }
  }
  return max;
}

function sumLabResearchRate(player) {
  let rate = 0;
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'researchLab' && cell.status === 'active') {
        rate += TILE_TYPES.researchLab.tiers[cell.tier - 1].researchRate;
      }
    }
  }
  return rate;
}

// Seconds of research progress lost per point of research-rate destroyed with the currently
// active lab - the mechanic that makes a Research Lab a real target, not just a stat stick.
// Progress is clawed back, not reset outright: a T1 lab (rate 1.0) costs a real but survivable
// setback, while losing a T3 lab mid-project stings a lot more.
const LAB_DESTROY_PENALTY_PER_RATE = 8;

function dealDamageToCell(cell, dmg, ownerPlayer) {
  cell.hp -= dmg;
  if (cell.hp <= 0) {
    if (cell.turret && cell.turret.beamEl) cell.turret.beamEl.remove();
    if (ownerPlayer && cell.type === 'researchLab' && ownerPlayer.activeResearchNode) {
      const rate = TILE_TYPES.researchLab.tiers[cell.tier - 1].researchRate;
      const lost = Math.min(ownerPlayer.researchProgress, rate * LAB_DESTROY_PENALTY_PER_RATE);
      if (lost > 0) {
        ownerPlayer.researchProgress -= lost;
        showToast(`${ownerPlayer.key.toUpperCase()} Research Lab destroyed — lost ${lost.toFixed(0)}s of research progress!`);
      }
    }
    Object.assign(cell, makeEmptyCell(cell.unlocked));
    return true; // destroyed
  }
  return false;
}

// First non-empty tile in a column, nearest the neutral zone - i.e. whatever an incoming shot
// would reach first. Returns { depth: null, cell: null } if the whole column is clear to the Core.
function resolveDefender(target, col) {
  for (let d = 0; d < GRID_DEPTH; d++) {
    const c = target.grid[d][col];
    if (c.type !== 'empty') return { depth: d, cell: c };
  }
  return { depth: null, cell: null };
}

// Timers for shots currently in flight, so a reset can cancel them instead of letting a stale
// shot land on the next game and deal phantom damage.
let pendingImpactTimers = [];
function scheduleImpact(fn, delayMs) {
  const id = setTimeout(() => {
    pendingImpactTimers = pendingImpactTimers.filter((t) => t !== id);
    if (state.paused || state.gameOver) return;
    fn();
  }, delayMs);
  pendingImpactTimers.push(id);
}

// The best (highest-tier) active, non-held bullet turret in the target column that could shoot
// down an incoming rocket - returns its position too, so the interception can be drawn as an
// actual bullet traveling from THAT turret to meet the rocket, not just an anonymous burst.
function findInterceptor(target, col) {
  let best = null;
  for (let d = 0; d < GRID_DEPTH; d++) {
    const c = target.grid[d][col];
    if (c.status === 'active' && c.type === 'wall' && c.turret && c.turret.kind === 'bullet'
      && c.turret.status === 'active' && !c.turret.holdFire) {
      const chance = ROCKET_INTERCEPT_CHANCE[c.turret.tier] || 0;
      if (!best || chance > best.chance) best = { depth: d, tier: c.turret.tier, chance };
    }
  }
  return best;
}

// Bullet & rocket: the shot is committed (energy spent, cooldown started) the instant the turret
// fires, but damage only lands once the projectile visually reaches its target - see scheduleImpact.
// Since flight now takes a couple of seconds, the target's defenses are re-resolved fresh at impact
// time rather than reusing what was there at launch, so a wall destroyed mid-flight doesn't still
// "eat" a shot that would now sail past it to the Core (or vice versa).
function fireTurret(shooterKey, shooterDepth, col, turret, tierCfg) {
  const kind = turret.kind;
  const targetKey = otherKey(shooterKey);
  const target = state.players[targetKey];
  const fromEl = cellEls[shooterKey][shooterDepth][col].root;
  const flightMs = kind === 'rocket' ? ROCKET_FLIGHT_MS : BULLET_FLIGHT_MS;

  if (kind === 'rocket') {
    const interceptor = findInterceptor(target, col);
    if (interceptor && Math.random() < interceptor.chance) {
      const { depth: aimDepth } = resolveDefender(target, col);
      const aimEl = aimDepth === null ? coreCellEls[targetKey][col].root : cellEls[targetKey][aimDepth][col].root;
      flashFiring(fromEl);
      const meetMs = flightMs * 0.55;
      const { endX, endY } = projectileEndpoint(fromEl, aimEl, 0.55);
      // The rocket travels to the meeting point and bursts on arrival; the intercepting bullet
      // travels from the turret that actually shot it down to that SAME point, timed to land at
      // the same moment - both projectiles visibly vanish together instead of the rocket just
      // disappearing on its own.
      flyProjectileTo(fromEl, endX, endY, 'bullet kind-rocket', meetMs, true);
      const interceptorEl = cellEls[targetKey][interceptor.depth][col].root;
      flashFiring(interceptorEl);
      flyProjectileTo(interceptorEl, endX, endY, `bullet tier-${interceptor.tier}`, meetMs, false);
      return;
    }
  }

  const { depth: aimDepth } = resolveDefender(target, col);
  const toEl = aimDepth === null ? coreCellEls[targetKey][col].root : cellEls[targetKey][aimDepth][col].root;

  flashFiring(fromEl);
  if (kind === 'rocket') {
    flyProjectile(fromEl, toEl, 'bullet kind-rocket', 1, flightMs);
  } else {
    const cssClass = `bullet tier-${turret.tier}`;
    flyProjectile(fromEl, toEl, cssClass, 1, flightMs);
    if (turret.tier >= BURST_TIER) {
      setTimeout(() => flyProjectile(fromEl, toEl, cssClass, 1, flightMs), BURST_STAGGER_MS);
    }
  }

  scheduleImpact(() => {
    const { depth: hitDepth, cell: targetCell } = resolveDefender(target, col);
    let dmg = tierCfg.damage;
    if (hitDepth === null) {
      target.core.hp = Math.max(0, target.core.hp - dmg);
    } else {
      if (targetCell.type === 'wall') {
        const material = WALL_TIERS[targetCell.tier - 1].key;
        const mult = DAMAGE_MULTIPLIERS[kind][material];
        dmg *= (mult == null ? 1 : mult);
      }
      dealDamageToCell(targetCell, dmg, target);
    }
  }, flightMs);
}

// Shotgun/Missile/Howitzer: unlike fireTurret (one shot, one lane), these hit a whole band of
// COLUMNS at once - kindDef.spread is how many columns out on each side get hit, and
// kindDef.falloff[n] is the damage fraction landing n columns from the targeted one (index 0 =
// the targeted column itself). Each column resolves its own defender independently and fully
// fresh at impact time, exactly like fireTurret does for a single lane, so a wall destroyed
// mid-flight in one lane doesn't affect whether the shot still lands in its neighbor.
function fireSpreadTurret(shooterKey, shooterDepth, col, turret, tierCfg, kindDef) {
  const kind = turret.kind;
  const targetKey = otherKey(shooterKey);
  const target = state.players[targetKey];
  const fromEl = cellEls[shooterKey][shooterDepth][col].root;
  const flightMs = kindDef.slowProjectile ? ROCKET_FLIGHT_MS : BULLET_FLIGHT_MS;
  const cssClass = kindDef.projectileClass || `bullet tier-${turret.tier}`;

  flashFiring(fromEl);

  for (let offset = -kindDef.spread; offset <= kindDef.spread; offset++) {
    const falloffMult = kindDef.falloff[Math.abs(offset)];
    if (!falloffMult) continue;
    const targetCol = col + offset;
    if (targetCol < 0 || targetCol >= GRID_COLS) continue;

    const { depth: aimDepth } = resolveDefender(target, targetCol);
    const toEl = aimDepth === null ? coreCellEls[targetKey][targetCol].root : cellEls[targetKey][aimDepth][targetCol].root;
    flyProjectile(fromEl, toEl, cssClass, 1, flightMs);

    scheduleImpact(() => {
      const { depth: hitDepth, cell: targetCell } = resolveDefender(target, targetCol);
      let dmg = tierCfg.damage * falloffMult;
      if (hitDepth === null) {
        target.core.hp = Math.max(0, target.core.hp - dmg);
      } else {
        if (targetCell.type === 'wall') {
          const material = WALL_TIERS[targetCell.tier - 1].key;
          const mult = DAMAGE_MULTIPLIERS[kind][material];
          dmg *= (mult == null ? 1 : mult);
        }
        dealDamageToCell(targetCell, dmg, target);
      }
    }, flightMs);
  }
}

// Beam damage-per-tick, shared by the Laser (charge -> sustained beam -> cooldown, see
// tickLaserTurret) and the Ion Cannon (charge -> fires until stopped, see tickIonCannon) - both
// reflect off a Mirror Wall and look up their own entry in DAMAGE_MULTIPLIERS by turret.kind.
function applyLaserDamageTick(shooterKey, shooterDepth, col, dmgPerTick, turret) {
  const targetKey = otherKey(shooterKey);
  const target = state.players[targetKey];
  const fromEl = cellEls[shooterKey][shooterDepth][col].root;

  const { depth: hitDepth, cell: targetCell } = resolveDefender(target, col);

  // A Mirror Wall only reflects while ACTIVE (not mid-construction) and only if the DEFENDER can
  // afford to power the reflect (MIRROR_REFLECT_ENERGY_PER_DAMAGE per point reflected) - if
  // either isn't true, it falls through to the normal damage path below and just gets hit like
  // any other wall material (DAMAGE_MULTIPLIERS[kind].mirror).
  if (hitDepth !== null && targetCell.type === 'wall' && targetCell.status === 'active' && WALL_TIERS[targetCell.tier - 1].reflectsLaser) {
    const reflectCost = dmgPerTick * MIRROR_REFLECT_ENERGY_PER_DAMAGE;
    if (target.energy >= reflectCost) {
      target.energy -= reflectCost;
      const reflected = dmgPerTick * MIRROR_REFLECT_FRACTION;
      const residual = dmgPerTick - reflected;
      const mirrorEl = cellEls[targetKey][hitDepth][col].root;
      const shooterCell = state.players[shooterKey].grid[shooterDepth][col];
      dealDamageToCell(shooterCell, reflected, state.players[shooterKey]);
      const mult = DAMAGE_MULTIPLIERS[turret.kind].mirror;
      dealDamageToCell(targetCell, residual * (mult == null ? 1 : mult), target);
      flashFiring(mirrorEl);
      updateOrCreateBeam(turret, fromEl, mirrorEl, true);
      return;
    }
  }

  let dmg = dmgPerTick;
  let toEl;
  if (hitDepth === null) {
    target.core.hp = Math.max(0, target.core.hp - dmg);
    toEl = coreCellEls[targetKey][col].root;
  } else {
    if (targetCell.type === 'wall') {
      const material = WALL_TIERS[targetCell.tier - 1].key;
      const mult = DAMAGE_MULTIPLIERS[turret.kind][material];
      dmg *= (mult == null ? 1 : mult);
    }
    dealDamageToCell(targetCell, dmg, target);
    toEl = cellEls[targetKey][hitDepth][col].root;
  }
  updateOrCreateBeam(turret, fromEl, toEl, false);
}

function flashFiring(cellEl) {
  cellEl.classList.remove('firing');
  void cellEl.offsetWidth; // force reflow so the animation restarts if still running
  cellEl.classList.add('firing');
  setTimeout(() => cellEl.classList.remove('firing'), 220);
}

// Board-relative pixel position of an element's center.
function elCenter(el) {
  const boardRect = boardEl.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - boardRect.left, y: rect.top + rect.height / 2 - boardRect.top };
}

// The point `stopFraction` of the way from fromEl to toEl, in board-relative pixels - used both
// to animate a projectile that stops short (an intercepted rocket) and to aim a SEPARATE
// projectile (the intercepting bullet) at that exact same point, so the two visibly meet.
function projectileEndpoint(fromEl, toEl, stopFraction) {
  const start = elCenter(fromEl);
  const full = elCenter(toEl);
  return { startX: start.x, startY: start.y, endX: start.x + (full.x - start.x) * stopFraction, endY: start.y + (full.y - start.y) * stopFraction };
}

// Low-level: animate a projectile from fromEl's center to an explicit board-relative point.
function flyProjectileTo(fromEl, endX, endY, cssClass, durationMs, burstOnArrival) {
  if (!boardEl || !bulletLayer) return;
  const { x: startX, y: startY } = elCenter(fromEl);

  const bullet = document.createElement('div');
  bullet.className = cssClass;
  bullet.style.left = startX + 'px';
  bullet.style.top = startY + 'px';
  bulletLayer.appendChild(bullet);

  requestAnimationFrame(() => {
    bullet.style.transition = `left ${durationMs}ms linear, top ${durationMs}ms linear`;
    bullet.style.left = endX + 'px';
    bullet.style.top = endY + 'px';
  });
  setTimeout(() => {
    bullet.remove();
    if (burstOnArrival) spawnBurst(endX, endY);
  }, durationMs + 40);
}

function flyProjectile(fromEl, toEl, cssClass, stopFraction = 1, baseDurationMs = BULLET_FLIGHT_MS) {
  const { endX, endY } = projectileEndpoint(fromEl, toEl, stopFraction);
  flyProjectileTo(fromEl, endX, endY, cssClass, baseDurationMs * stopFraction, stopFraction < 1);
}

function spawnBurst(x, y) {
  if (!bulletLayer) return;
  const b = document.createElement('div');
  b.className = 'intercept-burst';
  b.style.left = x + 'px';
  b.style.top = y + 'px';
  bulletLayer.appendChild(b);
  setTimeout(() => b.remove(), 320);
}

// Every "producing" structure (generator, research lab, auto-repair) ticks silently in the
// simulation - these two helpers are the only thing that makes that tick VISIBLE on the board,
// which is the whole point: the player should be able to read what a tile is doing without
// opening its inspector, the same way a chess piece's move is legible just by looking at it.
function spawnFloatText(cellEl, text, cssClass) {
  if (!boardEl || !bulletLayer || !cellEl) return;
  const { x, y } = elCenter(cellEl);
  const el = document.createElement('div');
  el.className = `float-fx ${cssClass || ''}`;
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  bulletLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('rise'));
  setTimeout(() => el.remove(), 950);
}

function pulseCell(cellEl, cssClass, ms = 550) {
  if (!cellEl) return;
  cellEl.classList.remove(cssClass);
  void cellEl.offsetWidth; // force reflow so the animation restarts if it's still running
  cellEl.classList.add(cssClass);
  setTimeout(() => cellEl.classList.remove(cssClass), ms);
}

function positionBeamEl(beamEl, fromEl, toEl) {
  const boardRect = boardEl.getBoundingClientRect();
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();
  const x1 = fromRect.left + fromRect.width / 2 - boardRect.left;
  const y1 = fromRect.top + fromRect.height / 2 - boardRect.top;
  const x2 = toRect.left + toRect.width / 2 - boardRect.left;
  const y2 = toRect.top + toRect.height / 2 - boardRect.top;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  beamEl.style.left = x1 + 'px';
  beamEl.style.top = y1 + 'px';
  beamEl.style.width = dist + 'px';
  beamEl.style.transform = `rotate(${angle}deg)`;
}

function updateOrCreateBeam(turret, fromEl, toEl, reflected) {
  if (!bulletLayer) return;
  if (!turret.beamEl) {
    const beam = document.createElement('div');
    beam.className = 'laser-beam sustained';
    bulletLayer.appendChild(beam);
    turret.beamEl = beam;
  }
  turret.beamEl.classList.toggle('reflected', !!reflected);
  positionBeamEl(turret.beamEl, fromEl, toEl);
}

function endBeam(turret) {
  if (turret.beamEl) {
    turret.beamEl.remove();
    turret.beamEl = null;
  }
}

// Holding fire pauses the ENERGY-SPENDING part of a laser (the sustained beam) but not the
// free part (charging up) - a held turret keeps progressing idle->charging->charged so that
// releasing the hold fires (almost) instantly instead of making the player wait out a full
// charge cycle after every resume.
function tickLaserTurret(playerKey, d, c, cell, dt) {
  const player = state.players[playerKey];
  const turret = cell.turret;
  const tierCfg = TURRET_KINDS.laser.tiers[turret.tier - 1];
  const held = turret.holdFire || player.globalHoldFire;

  if (turret.beamPhase === 'idle') {
    turret.cooldown -= dt;
    if (turret.cooldown < 0) turret.cooldown = 0;
    if (turret.cooldown <= 0) {
      turret.beamPhase = 'charging';
      turret.beamTimer = tierCfg.chargeTime;
    }
  } else if (turret.beamPhase === 'charging') {
    turret.beamTimer -= dt;
    if (turret.beamTimer < 0) turret.beamTimer = 0;
    if (turret.beamTimer <= 0) {
      turret.beamPhase = 'charged'; // fully charged, waiting for a green light to actually fire
    }
  } else if (turret.beamPhase === 'charged') {
    if (!held) {
      turret.beamPhase = 'firing';
      turret.beamTimer = tierCfg.beamDuration;
    }
  } else if (turret.beamPhase === 'firing') {
    if (held) {
      endBeam(turret);
      turret.beamPhase = 'idle';
      turret.cooldown = tierCfg.cooldownAfter;
      return;
    }
    const costThisTick = tierCfg.energyPerSecond * dt;
    if (player.energy < costThisTick) {
      endBeam(turret);
      turret.beamPhase = 'idle';
      turret.cooldown = tierCfg.cooldownAfter;
      return;
    }
    player.energy -= costThisTick;
    applyLaserDamageTick(playerKey, d, c, tierCfg.dps * dt, turret);
    turret.beamTimer -= dt;
    if (turret.beamTimer <= 0) {
      endBeam(turret);
      turret.beamPhase = 'idle';
      turret.cooldown = tierCfg.cooldownAfter;
    }
  }
}

// Counts active Amplifier Mirror tiles touching (depth, col) - all 8 neighbors, orthogonal and
// diagonal - and converts that into a damage multiplier for the Ion Cannon sitting there.
function amplifierMultiplier(player, depth, col) {
  let count = 0;
  for (let dd = -1; dd <= 1; dd++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dd === 0 && dc === 0) continue;
      const nd = depth + dd;
      const nc = col + dc;
      if (nd < 0 || nd >= GRID_DEPTH || nc < 0 || nc >= GRID_COLS) continue;
      const neighbor = player.grid[nd][nc];
      if (neighbor.type === 'amplifier' && neighbor.status === 'active') count++;
    }
  }
  return 1 + count * AMPLIFIER_BONUS_PER_MIRROR;
}

// Charges once, then just keeps beaming every tick for as long as it's not held and there's
// energy for it - no beamDuration/cooldownAfter cutoff like the base Laser. Running dry doesn't
// flip it off, it just skips ticks (mirroring how every other turret waits out an energy
// shortfall) - so it silently resumes on its own the moment energy is available again, and only
// an explicit Hold Fire actually ends the beam.
function tickIonCannon(playerKey, d, c, cell, dt) {
  const player = state.players[playerKey];
  const turret = cell.turret;
  const tierCfg = TURRET_KINDS.ionCannon.tiers[turret.tier - 1];
  const held = turret.holdFire || player.globalHoldFire;

  if (held) {
    if (turret.beamPhase !== 'idle') endBeam(turret);
    turret.beamPhase = 'idle';
    turret.beamTimer = 0;
    return;
  }

  if (turret.beamPhase === 'idle') {
    turret.beamPhase = 'charging';
    turret.beamTimer = tierCfg.chargeTime;
  } else if (turret.beamPhase === 'charging') {
    turret.beamTimer -= dt;
    if (turret.beamTimer <= 0) {
      turret.beamTimer = 0;
      turret.beamPhase = 'firing';
    }
  } else if (turret.beamPhase === 'firing') {
    const costThisTick = tierCfg.energyPerSecond * dt;
    if (player.energy < costThisTick) {
      if (turret.beamEl) endBeam(turret); // starved for energy - pause the visual, stay "firing"
      return;
    }
    player.energy -= costThisTick;
    const mult = amplifierMultiplier(player, d, c);
    applyLaserDamageTick(playerKey, d, c, tierCfg.dps * dt * mult, turret);
  }
}

function tickPlayer(playerKey, dt) {
  const player = state.players[playerKey];

  // 1. energy income + capacity (generators & storage)
  let income = CORE_ENERGY_RATE;
  let capacity = BASE_MAX_ENERGY;
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.status !== 'active') continue;
      if (cell.type === 'generator') {
        const genCfg = TILE_TYPES.generator.tiers[cell.tier - 1];
        income += genCfg.energyRate;

        // Heartbeat: once per in-game second, pop a "+N⚡" off the generator and give the tile
        // a soft pulse - the energy was already flowing continuously into the bar, this just
        // makes that flow readable at a glance instead of a silently ticking number.
        cell._prodFxT = (cell._prodFxT || 0) + dt;
        if (cell._prodFxT >= 1) {
          cell._prodFxT -= 1;
          const cellEl = cellEls[playerKey][d][c].root;
          spawnFloatText(cellEl, `+${genCfg.energyRate}⚡`, 'fx-energy');
          pulseCell(cellEl, 'pulse-energy');
          netFx(playerKey, d, c, `+${genCfg.energyRate}⚡`, 'fx-energy', 'pulse-energy');
        }
      } else if (cell.type === 'storage') {
        capacity += TILE_TYPES.storage.tiers[cell.tier - 1].capacityBonus;
      }
    }
  }
  player.maxEnergy = capacity;
  player.energy = Math.min(player.maxEnergy, player.energy + income * dt);

  // 2. per-cell construction/deconstruction/turret firing
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'empty') continue;

      if (cell.status === 'constructing') {
        cell.progress -= dt;
        // HP rises with build progress instead of starting at full - a half-built tile is
        // genuinely fragile and can be destroyed (losing the invested cost) before it finishes.
        cell.hp = cell.totalTime ? cell.maxHp * (1 - Math.max(0, cell.progress) / cell.totalTime) : cell.maxHp;
        if (cell.progress <= 0) { cell.status = 'active'; cell.progress = 0; cell.hp = cell.maxHp; }
      } else if (cell.status === 'deconstructing') {
        cell.progress -= dt;
        if (cell.progress <= 0) {
          let refund = cell.investedCost * DECON_REFUND;
          if (cell.turret) {
            refund += cell.turret.investedCost * DECON_REFUND;
            if (cell.turret.beamEl) cell.turret.beamEl.remove();
          }
          player.energy = Math.min(player.maxEnergy, player.energy + refund);
          Object.assign(cell, makeEmptyCell(cell.unlocked));
          if (state.selected && state.selected.player === playerKey && state.selected.depth === d && state.selected.col === c) {
            state.selected = null;
          }
          continue;
        }
      } else if (cell.status === 'active' && cell.upgrading) {
        cell.upgrading.progress -= dt;
        if (cell.upgrading.progress <= 0) finishUpgradeBase(cell);
      }

      // Same heartbeat idea as generators: an active Lab that's actually contributing to the
      // player's research (a project is selected) pops its rate once per in-game second. A Lab
      // with nothing selected already flags itself red via needs-attention in the render pass,
      // so this only fires on the "working" half of that state.
      if (cell.type === 'researchLab' && cell.status === 'active' && player.activeResearchNode) {
        const labCfg = TILE_TYPES.researchLab.tiers[cell.tier - 1];
        cell._prodFxT = (cell._prodFxT || 0) + dt;
        if (cell._prodFxT >= 1) {
          cell._prodFxT -= 1;
          const cellEl = cellEls[playerKey][d][c].root;
          spawnFloatText(cellEl, `+${labCfg.researchRate.toFixed(1)}🔬`, 'fx-research');
          pulseCell(cellEl, 'pulse-research');
          netFx(playerKey, d, c, `+${labCfg.researchRate.toFixed(1)}🔬`, 'fx-research', 'pulse-research');
        }
      }

      if (cell.type === 'wall' && cell.turret) {
        const turret = cell.turret;
        if (turret.status === 'constructing') {
          turret.progress -= dt;
          if (turret.progress <= 0) { turret.status = 'active'; turret.progress = 0; }
        } else if (turret.status === 'deconstructing') {
          turret.progress -= dt;
          if (turret.progress <= 0) {
            const refund = turret.investedCost * DECON_REFUND;
            player.energy = Math.min(player.maxEnergy, player.energy + refund);
            if (turret.beamEl) turret.beamEl.remove();
            cell.turret = null;
          }
        } else if (turret.status === 'active' && cell.status === 'active') {
          if (turret.upgrading) {
            turret.upgrading.progress -= dt;
            if (turret.upgrading.progress <= 0) finishUpgradeTurret(cell);
          }
          if (turret.kind === 'laser') {
            tickLaserTurret(playerKey, d, c, cell, dt);
          } else if (turret.kind === 'ionCannon') {
            tickIonCannon(playerKey, d, c, cell, dt);
          } else {
            // Cooldown ticks down (i.e. the turret "charges up") even while fire is held - only
            // the actual shot (spending energy, launching a projectile) is gated on hold, so
            // releasing hold with a charged-up turret fires it right away.
            turret.cooldown -= dt;
            if (turret.cooldown < 0) turret.cooldown = 0;
            if (turret.cooldown <= 0 && !turret.holdFire && !player.globalHoldFire) {
              const kindDef = TURRET_KINDS[turret.kind];
              const tierCfg = kindDef.tiers[turret.tier - 1];
              if (player.energy >= tierCfg.energyPerShot) {
                player.energy -= tierCfg.energyPerShot;
                turret.cooldown = tierCfg.fireInterval;
                if (kindDef.spread) {
                  fireSpreadTurret(playerKey, d, c, turret, tierCfg, kindDef);
                } else {
                  fireTurret(playerKey, d, c, turret, tierCfg);
                }
              } // else: wait for energy, retry next tick (cooldown stays clamped at 0)
            }
          }
        }
      }
    }
  }

  // 3. auto repair
  if (player.autoRepair) {
    let budget = AUTO_REPAIR_RATE * dt;
    for (let d = 0; d < GRID_DEPTH && budget > 0; d++) {
      for (let c = 0; c < GRID_COLS && budget > 0; c++) {
        const cell = player.grid[d][c];
        if (cell.type === 'empty') continue;
        if (cell.status === 'active' && cell.hp < cell.maxHp) {
          const missing = cell.maxHp - cell.hp;
          let amt = Math.min(missing, budget);
          let cost = amt * AUTO_REPAIR_COST_PER_HP;
          if (cost > player.energy) {
            amt = player.energy / AUTO_REPAIR_COST_PER_HP;
            cost = player.energy;
          }
          if (amt > 0) {
            cell.hp += amt;
            player.energy -= cost;
            budget -= amt;

            // Same once-per-second heartbeat, but the amount is batched: auto-repair can touch
            // a tile every single frame while it's damaged, and popping a number every frame
            // would just be noise rather than a readable "it's healing" signal.
            cell._repairAcc = (cell._repairAcc || 0) + amt;
            cell._repairFxT = (cell._repairFxT || 0) + dt;
            if (cell._repairFxT >= 1) {
              cell._repairFxT -= 1;
              const cellEl = cellEls[playerKey][d][c].root;
              const repairText = `+${Math.round(cell._repairAcc)}❤`;
              spawnFloatText(cellEl, repairText, 'fx-repair');
              pulseCell(cellEl, 'pulse-repair');
              netFx(playerKey, d, c, repairText, 'fx-repair', 'pulse-repair');
              cell._repairAcc = 0;
            }
          }
        }
      }
    }
  }

  // 4. research tick - the sum of every active Research Lab's rate advances progress on the
  // player's single active tech node; the energy cost scales with that same rate, so twice the
  // labs means twice the progress AND twice the drain, not free acceleration. Energy is clamped
  // to what's actually available (same pattern as auto-repair below), so a starved player still
  // makes partial progress instead of the tick silently doing nothing.
  player.labMaxTier = findLabMaxTier(player);
  if (player.activeResearchNode) {
    const node = TECH_TREE[player.activeResearchNode];
    const rate = sumLabResearchRate(player);
    if (rate > 0) {
      let progressDelta = rate * dt;
      const energyNeeded = node.energyPerSecond * progressDelta;
      if (energyNeeded > player.energy) {
        progressDelta *= player.energy / energyNeeded;
        player.energy = 0;
      } else {
        player.energy -= energyNeeded;
      }
      player.researchProgress += progressDelta;
      if (player.researchProgress >= node.time) {
        player.completedResearch.add(node.id);
        player.activeResearchNode = null;
        player.researchProgress = 0;
        showToast(`${playerKey.toUpperCase()} completed research: ${techNodeDisplayName(node)}!`);
        if (node.grantsLabTier) grantLabTier(player, node.grantsLabTier);
      }
    }
  }
}

// A Research Lab's tier is never bought/upgraded manually - completing the matching Logistics
// node instantly bumps every currently-active Lab a player owns straight to the new tier, for
// free (the research itself already paid the cost). A Lab that's still under construction, or a
// fresh one built later, isn't touched here - see labTierRank on TILE_TYPES.researchLab.
function grantLabTier(player, tier) {
  player.labUnlockedTier = Math.max(player.labUnlockedTier, tier);
  const targetCfg = TILE_TYPES.researchLab.tiers[tier - 1];
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'researchLab' && cell.status === 'active' && cell.tier < tier) {
        const hpDelta = targetCfg.hp - TILE_TYPES.researchLab.tiers[cell.tier - 1].hp;
        cell.tier = tier;
        cell.maxHp = targetCfg.hp;
        cell.hp = Math.min(cell.maxHp, cell.hp + hpDelta);
      }
    }
  }
}

function tick(dt) {
  tickPlayer('p1', dt);
  tickPlayer('p2', dt);

  if (state.vsCpu) {
    state.aiTimer += dt;
    const diffCfg = CPU_DIFFICULTY[state.cpuDifficulty] || CPU_DIFFICULTY.normal;
    while (state.aiTimer >= diffCfg.interval) {
      state.aiTimer -= diffCfg.interval;
      runCpuTurn(state.cpuPlayer, diffCfg);
    }
  }

  if (!state.gameOver) {
    const p1Dead = state.players.p1.core.hp <= 0;
    const p2Dead = state.players.p2.core.hp <= 0;
    if (p1Dead || p2Dead) {
      state.gameOver = true;
      state.paused = true;
      let title;
      if (p1Dead && p2Dead) title = "Draw!";
      else if (p1Dead) title = "P2 Wins!";
      else title = "P1 Wins!";
      $('game-over-title').textContent = title;
      $('game-over-overlay').classList.remove('hidden');
      $('pause-btn').textContent = 'Resume';
    }
  }
}

/* ======================= CPU AI ======================= */
// Single-player practice opponent. Combat itself (aiming, firing, hold-fire) is already fully
// automatic in tickPlayer - turrets fire on their own the instant they're built - so the only
// thing a CPU player actually needs to do is make the same build/research/unlock decisions a
// human makes by clicking. runCpuTurn is called on a fixed cadence (not every frame) and does
// AT MOST one action per call, through the same tryPlace/tryUnlockTile/startUpgrade* functions
// the click handlers use - so nothing about how it plays is a special case, it just replaces
// mouse clicks with a priority list.

// Difficulty controls two different things: how OFTEN the CPU acts (interval) and how BIG a
// base it's willing to commit to before it's satisfied (the min/max targets + upkeepFraction) -
// reaction speed alone barely matters here since combat is fully automatic, so Normal and Hard
// need genuinely different targets or they end up building the same small base at slightly
// different speeds and the difficulty picker doesn't feel like it does anything.
// minGenerators/minWalls/minLabs/minStorages are hard floors the CPU saves up for one at a time
// before touching anything else (see the blocking milestones in runCpuTurn); maxWalls caps how
// far it keeps tiling the wall line once free-building afterward; upkeepFraction is how much of
// its own income it's willing to commit to standing turret upkeep (see step 1) - Hard runs its
// economy close to the edge, Easy leaves a big cushion.
// minGenerators in particular needs to be generous, not just "enough to cover turret upkeep":
// research runs at the SIMULATION-TICK level (tickPlayer), not on the AI's decision cadence, and
// it greedily spends whatever energy is left after turrets fire every single tick, throttling
// down rather than ever going negative - so as long as a research node is active (which is
// almost always, once the first Lab is up) it silently eats 100% of whatever thin margin is left
// over from turret upkeep, and priorities 5-7 below (storage, more turrets, upgrades) never see
// a surplus to spend even though they're checked every AI turn. The only real fix is more income
// than turrets+research can jointly absorb - hence generator floors well above what step 1's
// upkeepFraction alone would require.
const CPU_TECH_ORDER = ['armor1', 'logistics1', 'firepower1', 'ordnance1', 'armor2', 'logistics2', 'firepower2', 'ordnance2', 'armor3', 'firepower3', 'ordnance3'];
const CPU_DIFFICULTY = {
  easy: {
    interval: 2.8, techOrder: CPU_TECH_ORDER.slice(0, 4), randomTurret: true,
    minGenerators: 3, minWalls: 4, maxWalls: 6, minLabs: 1, minStorages: 1, upkeepFraction: 0.55,
  },
  normal: {
    interval: 1.3, techOrder: CPU_TECH_ORDER, randomTurret: true,
    minGenerators: 6, minWalls: 8, maxWalls: 11, minLabs: 2, minStorages: 2, upkeepFraction: 0.75,
  },
  hard: {
    interval: 0.5, techOrder: CPU_TECH_ORDER, randomTurret: false,
    minGenerators: 9, minWalls: 12, maxWalls: GRID_COLS, minLabs: 3, minStorages: 3, upkeepFraction: 0.9,
  },
};
const CPU_TURRET_KIND_PRIORITY = ['rocket', 'bullet', 'shotgun', 'missile', 'howitzer', 'laser', 'ionCannon'];
const CPU_MIN_BULLETS_BEFORE_VARIETY = 2; // arm this many cheap Bullet Turrets for early defense, then stop defaulting to it

// Highest tier of `kind` the CPU could build/mount RIGHT NOW (unlocked and affordable), 0 if none.
function cpuBestAffordableTier(player, kind) {
  const tiers = tiersArrayFor(kind);
  for (let t = tiers.length; t >= 1; t--) {
    if (!unlockedFor(player, tiers[t - 1])) continue;
    if (player.energy >= cumulativeStats(kind, t).cost) return t;
  }
  return 0;
}

// Bullet Turret is unlocked and cheap from the very first second of the game, so a plain
// "whatever's affordable right now" pick locks EVERY wall into it forever - by the time the
// economy can afford a Rocket/Shotgun/Laser, every wall is already occupied by an armed Bullet
// Turret, since step 1 arms a bare wall the instant anything at all is affordable for it. Once
// a small baseline of bullets exists, prefer any OTHER unlocked kind - falling back to bullet
// only when nothing pricier is reachable yet - so research actually shows up on the board.
//
// Even restricted to that pool, picking "whatever's affordable RIGHT NOW" every AI turn has the
// same problem one rung up: Rocket (70⚡) crosses its own affordability threshold long before
// Shotgun/Laser (85-90⚡) or Missile/Howitzer/Ion Cannon (150-260⚡) do, and since step 1 re-rolls
// every single turn, it grabs Rocket the instant energy passes 70 almost every time - energy
// essentially never lingers long enough for the pricier options to become reachable. The fix is
// to COMMIT to one aspirational kind per bare wall and keep saving specifically toward IT across
// turns (stored on the player, cleared once built) rather than re-evaluating "cheapest available"
// from scratch every turn.
//
// The roll itself only screens out kinds that could NEVER be sustained on TOTAL current income
// alone (a loose bar - ignores what's already committed elsewhere) - it deliberately does NOT
// also require the pick to fit the CURRENT leftover headroom, or the roll pool would shrink to
// "whatever's cheap enough to fit what's left over right now" and land back on Rocket almost
// every time, the same bias one level up. The tight "does this actually fit alongside every
// turret already running" check only happens below, every turn, while patiently waiting.
function cpuPickTurret(player, diffCfg) {
  const bulletsBuilt = cpuCountTurretKind(player, 'bullet');
  const unlocked = CPU_TURRET_KIND_PRIORITY.filter((k) => unlockedFor(player, TURRET_KINDS[k].tiers[0]));
  const pool = bulletsBuilt >= CPU_MIN_BULLETS_BEFORE_VARIETY ? unlocked.filter((k) => k !== 'bullet') : unlocked;
  const candidateKinds = pool.length ? pool : unlocked;
  if (!candidateKinds.length) return null;

  const income = cpuEnergyIncomeRate(player);
  const viableInPrinciple = (kind) => cpuTurretUpkeepFor(kind, 1) <= income * diffCfg.upkeepFraction;

  if (!player._aiTurretAspiration || !candidateKinds.includes(player._aiTurretAspiration) || !viableInPrinciple(player._aiTurretAspiration)) {
    const viable = candidateKinds.filter(viableInPrinciple);
    const rollPool = viable.length ? viable : candidateKinds;
    player._aiTurretAspiration = diffCfg.randomTurret
      ? rollPool[Math.floor(Math.random() * rollPool.length)]
      : rollPool[0];
  }

  const kind = player._aiTurretAspiration;
  const tier = cpuBestAffordableTier(player, kind);
  if (tier <= 0) return null; // still saving up the build cost
  const currentUpkeep = cpuTurretUpkeepRate(player);
  if (currentUpkeep + cpuTurretUpkeepFor(kind, tier) > income * diffCfg.upkeepFraction) return null; // doesn't fit alongside what's already running yet - keep waiting
  player._aiTurretAspiration = null; // consumed - the next bare wall rolls a fresh aspiration
  return { kind, tier };
}

function cpuPickNextResearch(player, diffCfg) {
  for (const id of diffCfg.techOrder) {
    if (player.completedResearch.has(id) || player.activeResearchNode === id) continue;
    const node = TECH_TREE[id];
    if (!techPrereqMet(player, node) || !techLabTierMet(player, node)) continue;
    return id;
  }
  return null;
}

function cpuCountType(player, type) {
  let n = 0;
  for (let d = 0; d < GRID_DEPTH; d++) for (let c = 0; c < GRID_COLS; c++) if (player.grid[d][c].type === type) n++;
  return n;
}

function cpuCountTurretKind(player, kind) {
  let n = 0;
  for (let d = 0; d < GRID_DEPTH; d++) for (let c = 0; c < GRID_COLS; c++) if (player.grid[d][c].turret?.kind === kind) n++;
  return n;
}

function cpuFindWallNeedingTurret(player) {
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'wall' && cell.status === 'active' && !cell.turret) return { d, c };
    }
  }
  return null;
}

// Steady-state energy/sec a player has coming in from the core + every active generator.
function cpuEnergyIncomeRate(player) {
  let rate = CORE_ENERGY_RATE;
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'generator' && cell.status === 'active') rate += TILE_TYPES.generator.tiers[cell.tier - 1].energyRate;
    }
  }
  return rate;
}

// Steady-state energy/sec every currently-mounted, non-held turret is burning through firing on
// its own (turrets fire automatically the instant they're built - see tickPlayer). Laser/Ion
// Cannon already track cost as energyPerSecond; everything else fires energyPerShot every
// fireInterval seconds, so its average rate is the quotient of the two.
function cpuTurretUpkeepRate(player) {
  let rate = 0;
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const t = player.grid[d][c].turret;
      if (!t || t.status !== 'active' || t.holdFire) continue;
      const tierCfg = TURRET_KINDS[t.kind].tiers[t.tier - 1];
      rate += tierCfg.energyPerSecond != null ? tierCfg.energyPerSecond : tierCfg.energyPerShot / tierCfg.fireInterval;
    }
  }
  return rate;
}

// Only the row adjacent to the Core (depth GRID_DEPTH-1) starts unlocked - depth 0 (nearest the
// neutral zone, the "real" front line) has to be bought open a tile at a time - see makePlayer.
// resolveDefender resolves per column, shallowest-non-empty-cell-first: whatever sits at the
// LOWEST depth in a column is the only thing that column's incoming fire ever hits, and it
// protects everything behind it in the SAME column. A generic "first open tile" spot-finder is
// blind to that - it'll happily park a Research Lab in the very first empty slot even when
// that slot is the exposed front of an otherwise-empty column, and just as happily stack a
// second wall behind a column that's already covered while a different column's Lab sits
// undefended. The two finders below are column-aware instead: cpuFindWallSpot always tries to
// give a bare column its first wall before reinforcing one that already has coverage;
// cpuFindProtectedSpot only ever places a vulnerable building (generator/lab/storage) somewhere
// that's already shielded by a wall at a shallower depth in the same column.
function cpuFindEmptySpot(player) {
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.unlocked && cell.type === 'empty') return { d, c };
    }
  }
  return null;
}

function cpuColumnHasWall(player, col) {
  for (let d = 0; d < GRID_DEPTH; d++) if (player.grid[d][col].type === 'wall') return true;
  return false;
}

function cpuColumnHasAnything(player, col) {
  for (let d = 0; d < GRID_DEPTH; d++) if (player.grid[d][col].type !== 'empty') return true;
  return false;
}

function cpuFirstOpenDepthInColumn(player, col) {
  for (let d = 0; d < GRID_DEPTH; d++) {
    if (player.grid[d][col].unlocked && player.grid[d][col].type === 'empty') return d;
  }
  return null;
}

// A column with a built (non-wall) structure in it but no wall anywhere is an exposed
// investment - e.g. a Lab sitting with nothing in front of it. Returns the first open depth to
// wall it off at, or null if either no column is exposed or every exposed column's remaining
// depths are all still locked (see cpuTryUnlockForExposedColumn for that case).
function cpuFindExposedColumnSpot(player) {
  for (let c = 0; c < GRID_COLS; c++) {
    if (cpuColumnHasWall(player, c) || !cpuColumnHasAnything(player, c)) continue;
    const d = cpuFirstOpenDepthInColumn(player, c);
    if (d !== null) return { d, c };
  }
  return null;
}

// If an exposed column's remaining depths are all locked (so cpuFindExposedColumnSpot can't
// place a wall there yet), unlock one of them specifically - rather than leaving that column
// exposed indefinitely while cpuTryUnlockOne's generic fallback opens up tiles elsewhere instead.
function cpuTryUnlockForExposedColumn(playerKey, player) {
  if (player.energy < TILE_UNLOCK_COST) return false;
  for (let c = 0; c < GRID_COLS; c++) {
    if (cpuColumnHasWall(player, c) || !cpuColumnHasAnything(player, c)) continue;
    for (let d = 0; d < GRID_DEPTH; d++) {
      if (!player.grid[d][c].unlocked) { tryUnlockTile(playerKey, d, c); return true; }
    }
  }
  return false;
}

// Where to build a new wall: most urgently, an exposed column (see cpuFindExposedColumnSpot).
// Next, any column with no wall at all. Only once every column already has at least one wall
// does this fall back to reinforcing/expanding normally.
function cpuFindWallSpot(player) {
  const exposedSpot = cpuFindExposedColumnSpot(player);
  if (exposedSpot) return exposedSpot;
  for (let c = 0; c < GRID_COLS; c++) {
    if (cpuColumnHasWall(player, c)) continue;
    const d = cpuFirstOpenDepthInColumn(player, c);
    if (d !== null) return { d, c };
  }
  return cpuFindEmptySpot(player);
}

// Where to build a vulnerable (non-wall) structure: only in a column that already has an active
// wall at a shallower depth shielding it, preferring the deepest such slot (furthest behind the
// wall). Falls back to the deepest empty slot anywhere if no protected column has room -
// unprotected-but-built still beats not building it at all.
function cpuFindProtectedSpot(player) {
  for (let d = GRID_DEPTH - 1; d >= 0; d--) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (!cell.unlocked || cell.type !== 'empty') continue;
      let shielded = false;
      for (let dd = 0; dd < d; dd++) {
        const front = player.grid[dd][c];
        if (front.type === 'wall' && front.status !== 'deconstructing') { shielded = true; break; }
      }
      if (shielded) return { d, c };
    }
  }
  // No shielded slot anywhere yet - fall back to an unshielded one, but NEVER depth 0. Depth 0
  // is the frontmost possible position in a column - nothing can ever be built shallower than
  // it in the SAME column, so a wall could never actually cover it later either (that's the
  // "useless wall behind an exposed building" case: step 1b would find the only open depth left
  // in that column is deeper than the exposed structure, and a wall placed there protects
  // nothing). Depth 1-3 can still be walled off later even if it's exposed for now.
  for (let d = GRID_DEPTH - 1; d >= 1; d--) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.unlocked && cell.type === 'empty') return { d, c };
    }
  }
  return null;
}

function cpuSpotFor(player, kind) {
  return kind === 'wall' ? cpuFindWallSpot(player) : cpuFindProtectedSpot(player);
}

// Looks for any active, non-upgrading base tile or turret one tier below its cap that the CPU
// can currently afford to upgrade - first match wins (scan order = front-to-back, left-to-right).
function cpuFindUpgradeCandidate(player) {
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = player.grid[d][c];
      if (cell.type === 'empty') continue;
      if (cell.type !== 'researchLab' && cell.status === 'active' && !cell.upgrading) {
        const nextCfg = TILE_TYPES[cell.type].tiers[cell.tier];
        if (nextCfg && unlockedFor(player, nextCfg) && player.energy >= nextCfg.cost) return { kind: 'base', d, c };
      }
      if (cell.turret && cell.turret.status === 'active' && !cell.turret.upgrading) {
        const nextCfg = TURRET_KINDS[cell.turret.kind].tiers[cell.turret.tier];
        if (nextCfg && unlockedFor(player, nextCfg) && player.energy >= nextCfg.cost) return { kind: 'turret', d, c };
      }
    }
  }
  return null;
}

// How much energy/sec mounting `kind` at `tier` would add to the player's standing turret
// upkeep - same math as cpuTurretUpkeepRate, for one hypothetical turret.
function cpuTurretUpkeepFor(kind, tier) {
  const tierCfg = TURRET_KINDS[kind].tiers[tier - 1];
  return tierCfg.energyPerSecond != null ? tierCfg.energyPerSecond : tierCfg.energyPerShot / tierCfg.fireInterval;
}

function cpuTryUnlockOne(playerKey, player) {
  if (player.energy < TILE_UNLOCK_COST) return false;
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!player.grid[d][c].unlocked) { tryUnlockTile(playerKey, d, c); return true; }
    }
  }
  return false;
}

// Used by the blocking milestones below: build `kind` at the best spot for that kind (see
// cpuSpotFor - walls seek out undefended columns, everything else seeks cover behind a wall).
// Only falls back to unlocking more board when the milestone IS affordable but there's simply
// nowhere left to put it (depth 3, or wherever's currently unlocked, is full) - so it doesn't
// block forever with no path forward. If it's not affordable yet, do nothing and let energy
// accumulate untouched; unlocking isn't the bottleneck when there's already room to spare.
function cpuBuildTowardMilestone(playerKey, player, kind, tier) {
  if (tier <= 0) return;
  const spot = cpuSpotFor(player, kind);
  if (spot) { tryPlace(playerKey, spot.d, spot.c, kind, tier); return; }
  cpuTryUnlockOne(playerKey, player);
}

// Milestones below (steps 2-5) `return` immediately whether or not they could actually afford
// their target this turn, rather than falling through to whatever's cheapest - a wall is always
// cheaper than a Research Lab, so without this a lab never actually gets saved up for; something
// affordable always wins the turn first. Blocking means energy just accumulates, untouched,
// until the current milestone's target is reachable.
function runCpuTurn(playerKey, diffCfg) {
  const player = state.players[playerKey];
  if (!player.autoRepair) player.autoRepair = true; // set-and-forget, same as a sensible human would

  // 0. energy triage: step 1's sustainability check only stops NEW turrets from outrunning
  // income - it doesn't notice if the opponent later destroys a generator out from under an
  // already-committed set of turrets. When that happens, upkeep can end up permanently exceeding
  // income, and since a turret spends the instant there's enough energy for one shot, energy
  // never accumulates enough for anything else ever again - every priority below just silently
  // starves forever. Recognizing that and holding fire across the board until the economy
  // actually recovers is what keeps a bad fight from being a permanent, invisible deadlock.
  const incomeNow = cpuEnergyIncomeRate(player);
  const upkeepNow = cpuTurretUpkeepRate(player);
  if (upkeepNow > incomeNow) {
    player.globalHoldFire = true;
  } else if (player.globalHoldFire && upkeepNow <= incomeNow * 0.7) {
    player.globalHoldFire = false;
  }

  const generators = cpuCountType(player, 'generator');
  const storages = cpuCountType(player, 'storage');
  const labs = cpuCountType(player, 'researchLab');
  const walls = cpuCountType(player, 'wall');

  // 1. arm any wall that's standing bare - undefended firepower is wasted energy sitting idle.
  // cpuPickTurret already restricts its candidates to ones that keep standing turret upkeep
  // within diffCfg.upkeepFraction of current income - without that, the CPU could mount turrets
  // whose combined upkeep exceeds what it earns, pinning its own energy at ~0 forever and
  // permanently blocking every priority below. If nothing sustainable is available yet, leave
  // the wall bare for now and grow the economy instead.
  const bareWall = cpuFindWallNeedingTurret(player);
  if (bareWall) {
    const pick = cpuPickTurret(player, diffCfg);
    if (pick) {
      tryPlace(playerKey, bareWall.d, bareWall.c, pick.kind, pick.tier);
      // An Ion Cannon is built pre-held (see tryPlace) - a human has to explicitly release it
      // since it just keeps draining energy once started, but the CPU built it BECAUSE it
      // decided this was worth firing, so leaving it held would waste the energy just spent.
      if (pick.kind === 'ionCannon') player.grid[bareWall.d][bareWall.c].turret.holdFire = false;
      return;
    }
  }

  // 1b. cover any column that already has a built (non-wall) structure but no wall yet - an
  // exposed Lab/Generator/Storage is money already spent sitting completely undefended, which is
  // strictly worse than a gap in the raw wall-COUNT target below (step 3 only fires while
  // walls < diffCfg.minWalls - once that's satisfied via OTHER columns, nothing would otherwise
  // ever go back and cover one that's still exposed). Not a strict block: if a wall isn't
  // affordable yet, or the column's remaining depths are all still locked, fall through and keep
  // growing the economy instead of freezing on it.
  const exposedSpot = cpuFindExposedColumnSpot(player);
  if (exposedSpot) {
    const tier = cpuBestAffordableTier(player, 'wall');
    if (tier > 0) { tryPlace(playerKey, exposedSpot.d, exposedSpot.c, 'wall', tier); return; }
  } else if (cpuTryUnlockForExposedColumn(playerKey, player)) {
    return;
  }

  // 2. keep a minimum viable energy economy before committing to anything pricier - see
  // diffCfg.minGenerators (bigger on higher difficulties, so income comfortably outpaces what a
  // larger standing turret line burns through once it's up - see step 1).
  if (generators < diffCfg.minGenerators) {
    cpuBuildTowardMilestone(playerKey, player, 'generator', cpuBestAffordableTier(player, 'generator'));
    return;
  }

  // 3. get a real wall line up before worrying about research/storage
  if (walls < diffCfg.minWalls) {
    cpuBuildTowardMilestone(playerKey, player, 'wall', cpuBestAffordableTier(player, 'wall'));
    return;
  }

  // 4. research - get enough labs up (research rate stacks across every active Lab a player
  // owns), then keep a project active at all times
  if (labs < diffCfg.minLabs) {
    cpuBuildTowardMilestone(playerKey, player, 'researchLab', cpuBestAffordableTier(player, 'researchLab'));
    return;
  }
  if (!player.activeResearchNode) {
    const nodeId = cpuPickNextResearch(player, diffCfg);
    if (nodeId) { player.activeResearchNode = nodeId; player.researchProgress = 0; return; }
    // Nothing currently researchable (tree exhausted, or waiting on a Lab tier that only arrives
    // by completing a DIFFERENT node) - fall through instead of blocking every turn forever.
  }

  // 5. energy storage once there's an economy worth protecting from capping out
  if (storages < diffCfg.minStorages) {
    cpuBuildTowardMilestone(playerKey, player, 'storage', cpuBestAffordableTier(player, 'storage'));
    return;
  }

  // 6. every milestone above is met - spend spare energy upgrading whatever's already built
  const upgradeCandidate = cpuFindUpgradeCandidate(player);
  if (upgradeCandidate) {
    const cell = player.grid[upgradeCandidate.d][upgradeCandidate.c];
    const ok = upgradeCandidate.kind === 'base' ? startUpgradeBase(player, cell) : startUpgradeTurret(player, cell);
    if (ok) return;
  }

  // 7. still got room and energy to spare - keep expanding, capping walls at diffCfg.maxWalls so
  // the rotation doesn't just tile the whole row in walls once nothing else is left to do. Pick
  // the kind FIRST, then find where it belongs (see cpuSpotFor) - not the other way around,
  // otherwise a spot found for one kind (e.g. an exposed front tile, fine for a wall) gets used
  // for whatever kind the dice happened to land on instead.
  const pool = walls < diffCfg.maxWalls ? ['wall', 'generator', 'researchLab', 'storage'] : ['generator', 'researchLab', 'storage'];
  const kind = pool[Math.floor(Math.random() * pool.length)];
  const tier = cpuBestAffordableTier(player, kind);
  if (tier > 0) {
    const spot = cpuSpotFor(player, kind);
    if (spot) { tryPlace(playerKey, spot.d, spot.c, kind, tier); return; }
  }

  // 8. nothing left to build - expand the board instead of sitting on spare energy
  if (player.energy >= TILE_UNLOCK_COST * 1.5) cpuTryUnlockOne(playerKey, player);
}

/* ======================= RENDER ======================= */

// The flyout is `position: fixed`, so it isn't clipped by #left-sidebar's overflow:auto and
// doesn't need to live inside the sidebar's stacking/flow at all - we just point it at its
// header's current screen position. Called every render tick while open (cheap - a couple of
// getBoundingClientRect() calls) so it also self-corrects if the window is resized.
// Opens to the LEFT of the sidebar (away from the board) rather than over the playfield -
// falls back to hugging the viewport's left edge if the window is too narrow for it to fit.
function positionFlyout(playerKey, catKey) {
  const refs = categoryEls[playerKey][catKey];
  const bodyEl = refs.body;
  const headerRect = refs.header.getBoundingClientRect();
  const sidebarRect = $('left-sidebar').getBoundingClientRect();
  bodyEl.style.left = Math.max(8, sidebarRect.left - 8 - bodyEl.offsetWidth) + 'px';
  bodyEl.style.top = headerRect.top + 'px';
  const maxTop = window.innerHeight - bodyEl.offsetHeight - 8;
  if (headerRect.top > maxTop) bodyEl.style.top = Math.max(8, maxTop) + 'px';
}

function renderCategoryPanel(playerKey) {
  const player = state.players[playerKey];
  const expanded = state.expandedCategory[playerKey];

  CATEGORY_DEFS.forEach((cat) => {
    const refs = categoryEls[playerKey][cat.key];
    const isOpen = expanded === cat.key;
    if (refs.catEl.classList.contains('expanded') !== isOpen) {
      refs.catEl.classList.toggle('expanded', isOpen);
      refs.header.querySelector('.chev').textContent = isOpen ? '▾' : '▸';
    }
    if (isOpen) positionFlyout(playerKey, cat.key);

    refs.groups.forEach((group) => {
      group.tierButtons.forEach((entry) => {
        const { tier, tierCfg, btn } = entry;
        // Locked tiers stay VISIBLE (not hidden) so a new player can see what a weapon/building
        // actually does and decide whether it's worth researching, before they've unlocked it -
        // they just render grayed out. Clicking still arms it (see toolInfoHtml for the full
        // stat preview); only actually PLACING it on the board is blocked, same as always.
        const unlocked = unlockedFor(player, tierCfg);
        const { cost, time } = cumulativeStats(group.kind, tier);
        const armed = !!(state.armed && state.armed.player === playerKey && state.armed.kind === group.kind && state.armed.tier === tier);
        const disabled = !unlocked || player.energy < cost;

        // Rebuilding a button's innerHTML every one of ~60 renders/sec (even when nothing about
        // it changed) forces needless style/layout work on every tier-option button, every
        // frame, for as long as a flyout is open. Skip the DOM write entirely when the signature
        // is unchanged from last render - a plain class/display toggle still updates instantly.
        const sig = `${cost}|${time}|${armed}|${disabled}|${unlocked}`;
        if (entry.lastSig !== sig) {
          entry.lastSig = sig;
          const icon = tierCfg.icon || group.def.icon;
          const label = tierCfg.label || `${group.def.label} T${tier}`;
          const directNote = tier > 1 ? ` • builds in ${time}s` : '';
          const lockNote = unlocked ? '' : ` • 🔒 needs ${missingTechLabel(player, tierCfg)}`;
          btn.innerHTML = `<span class="tname">${icon} ${label}</span><span class="tcost">${cost}⚡${directNote}${group.extra || ''}${lockNote}</span>`;
          btn.classList.toggle('armed', armed);
          btn.classList.toggle('disabled', disabled);
          btn.classList.toggle('locked', !unlocked);
        }
      });
    });
  });
}

// Compact preview card shown while a build option is armed, before it's actually placed on the
// board - kept to one stat row (a handful of the most decision-relevant numbers) since the
// sidebar has no spare vertical room to give it: growing a card here has nowhere to push its
// neighbor except off the bottom of the screen.
function toolInfoHtml(kind, tier, playerKey) {
  const player = state.players[playerKey];
  const tierCfg = isTurretKind(kind) ? TURRET_KINDS[kind].tiers[tier - 1] : TILE_TYPES[kind].tiers[tier - 1];
  const unlocked = unlockedFor(player, tierCfg);
  const lockBanner = unlocked ? '' : `<div class="insp-explainer" style="border-left-color:var(--hp-bad);margin-bottom:8px;">🔒 Locked — needs ${missingTechLabel(player, tierCfg)}. Stats shown for preview only.</div>`;

  const { cost, time } = cumulativeStats(kind, tier);
  const tierNote = tier > 1 ? [{ label: 'Build time', value: `${time}s` }] : [];

  if (isTurretKind(kind)) {
    const kindDef = TURRET_KINDS[kind];
    const tc = kindDef.tiers[tier - 1];
    const picked = turretStatsFor(kind, tc)
      .filter((s) => s.label.startsWith('DPS') || s.label === 'Energy / shot' || ((kind === 'laser' || kind === 'ionCannon') && s.label === 'Energy / sec') || s.label === 'Spread')
      .map((s) => ({ ...s, label: s.label.startsWith('DPS') ? 'DPS' : s.label }));
    return lockBanner + `<div class="insp-title">${kindDef.icon} ${kindDef.label} T${tier}</div>`
      + renderStatGrid([{ label: 'Cost', value: `${cost}⚡` }, ...picked, ...tierNote]);
  }

  const def = TILE_TYPES[kind];
  const tc = def.tiers[tier - 1];
  const stats = [{ label: 'Cost', value: `${cost}⚡` }];
  if (kind === 'generator') stats.push({ label: 'Output', value: `+${tc.energyRate}⚡/s` });
  else if (kind === 'storage') stats.push({ label: 'Capacity', value: `+${tc.capacityBonus}⚡` });
  else if (kind === 'researchLab') stats.push({ label: 'Research Rate', value: `${tc.researchRate.toFixed(1)}/s` });
  else if (tc.hp) stats.push({ label: 'HP', value: tc.hp });
  stats.push(...tierNote);

  return lockBanner + `<div class="insp-title">${tc.icon || def.icon} ${tc.label || def.label}</div>`
    + renderStatGrid(stats);
}

function renderToolInfo() {
  ['p1', 'p2'].forEach((playerKey) => {
    const el = $(`toolinfo-${playerKey}`);
    if (!el) return;
    const armed = state.armed && state.armed.player === playerKey ? state.armed : null;
    el.innerHTML = armed ? toolInfoHtml(armed.kind, armed.tier || 1, playerKey) : '';
  });
}

function renderCardActions(playerKey) {
  const player = state.players[playerKey];

  const repairBtn = $(`autorepair-${playerKey}`);
  repairBtn.classList.toggle('on', player.autoRepair);
  repairBtn.querySelector('.tname').textContent = player.autoRepair ? '\u{1F527} Auto-Repair: On' : '\u{1F527} Auto-Repair: Off';

  const holdAllBtn = $(`holdall-${playerKey}`);
  holdAllBtn.classList.toggle('on', player.globalHoldFire);
  holdAllBtn.querySelector('.tname').textContent = player.globalHoldFire ? '▶ Resume All Fire' : '\u{1F6D1} Hold All Fire';
}

function statusLabel(cell) {
  if (cell.status === 'constructing') return `Building ${Math.ceil(cell.progress)}s`;
  if (cell.status === 'deconstructing') return `Removing ${Math.ceil(cell.progress)}s`;
  if (cell.upgrading) return `Upgrading ${Math.ceil(cell.upgrading.progress)}s`;
  return '';
}

// Plain-English summary of what a base-tile upgrade actually changes, shown next to its cost so
// "Upgrade" buttons stop being a leap of faith.
function describeBaseUpgrade(type, cell, nextCfg) {
  const curCfg = TILE_TYPES[type].tiers[cell.tier - 1];
  if (type === 'generator') return `Output +${curCfg.energyRate}⚡/s → +${nextCfg.energyRate}⚡/s`;
  if (type === 'storage') return `Capacity +${curCfg.capacityBonus}⚡ → +${nextCfg.capacityBonus}⚡`;
  if (type === 'researchLab') return `Research Rate ${curCfg.researchRate.toFixed(1)}/s → ${nextCfg.researchRate.toFixed(1)}/s`;
  if (type === 'wall') return `HP ${curCfg.hp} → ${nextCfg.hp}, becomes ${nextCfg.label}`;
  return `HP ${curCfg.hp} → ${nextCfg.hp}`;
}

function renderCellEl(playerKey, depth, col) {
  const player = state.players[playerKey];
  const cell = player.grid[depth][col];
  const refs = cellEls[playerKey][depth][col];
  const el = refs.root;

  const locked = !cell.unlocked;
  el.classList.toggle('locked-tile', locked);
  if (locked) {
    el.classList.remove('deconstructing', 'wall-wood', 'wall-stone', 'wall-metal', 'wall-mirror', 'selected', 'charging');
    refs.icon.textContent = '\u{1F512}';
    refs.statusBadge.textContent = '';
    refs.chevrons.textContent = '';
    refs.tierBadge.textContent = `${TILE_UNLOCK_COST}⚡`;
    refs.progressBar.style.display = 'none';
    refs.hpBar.style.display = 'none';
    el.title = `Locked — click to unlock this tile for ${TILE_UNLOCK_COST}⚡.`;
    return;
  }

  el.classList.remove('wall-wood', 'wall-stone', 'wall-metal', 'wall-mirror');
  el.classList.toggle('charging', !!(cell.turret && (
    cell.turret.beamPhase === 'charging' || cell.turret.beamPhase === 'charged'
    || (cell.turret.kind === 'ionCannon' && cell.turret.beamPhase === 'firing')
  )));
  el.classList.toggle('needs-attention', cell.type === 'researchLab' && cell.status === 'active' && !player.activeResearchNode);

  const iconEl = refs.icon;
  const statusBadgeEl = refs.statusBadge;
  const chevronsEl = refs.chevrons;
  const tierBadge = refs.tierBadge;
  const progressFill = refs.progressFill;
  const progressBar = refs.progressBar;
  const hpFill = refs.hpFill;
  const hpBar = refs.hpBar;

  if (cell.type === 'empty') {
    iconEl.textContent = '';
    statusBadgeEl.textContent = '';
    chevronsEl.textContent = '';
    tierBadge.textContent = '';
    progressBar.style.display = 'none';
    hpBar.style.display = 'none';
    el.title = '';
    el.classList.remove('deconstructing');
  } else {
    const def = TILE_TYPES[cell.type];
    const tierCfgNow = def.tiers[cell.tier - 1];
    tierBadge.textContent = 'T' + cell.tier;

    if (cell.type === 'wall' && tierCfgNow.key) {
      el.classList.add(`wall-${tierCfgNow.key}`);
    }

    if (cell.turret) {
      const kindDef = TURRET_KINDS[cell.turret.kind];
      iconEl.textContent = kindDef.icon;
      statusBadgeEl.textContent = cell.turret.holdFire ? '⏸' : '';
      const chevronCount = cell.turret.tier - 1;
      chevronsEl.textContent = chevronCount > 0 ? '▲'.repeat(chevronCount) : '';
    } else {
      iconEl.textContent = tierCfgNow.icon || def.icon;
      statusBadgeEl.textContent = '';
      chevronsEl.textContent = '';
    }

    hpBar.style.display = 'block';
    const hpPct = cell.maxHp ? Math.max(0, cell.hp / cell.maxHp) : 0;
    hpFill.style.width = (hpPct * 100) + '%';
    hpFill.style.background = hpPct > 0.6 ? 'var(--hp-good)' : hpPct > 0.3 ? 'var(--hp-mid)' : 'var(--hp-bad)';

    // Progress bar reflects whichever is going on right now, in priority order: base tile
    // construction/deconstruction, a turret being built/removed on top of it, an in-place tier
    // upgrade (base or turret), or - for an active Research Lab - live progress on the player's
    // current tech node. Each gets its own fill color (see .upgrading-visual/.researching-visual)
    // so the kind of bar is legible from the board without opening the inspector.
    let progressActive = false;
    let progressPct = 0;
    let deconVisual = false;
    let upgradeVisual = false;
    let researchVisual = false;
    if (cell.status === 'constructing' || cell.status === 'deconstructing') {
      progressActive = true;
      progressPct = cell.totalTime ? (1 - cell.progress / cell.totalTime) : 1;
      deconVisual = cell.status === 'deconstructing';
    } else if (cell.turret && (cell.turret.status === 'constructing' || cell.turret.status === 'deconstructing')) {
      progressActive = true;
      progressPct = cell.turret.totalTime ? (1 - cell.turret.progress / cell.turret.totalTime) : 1;
      deconVisual = cell.turret.status === 'deconstructing';
    } else if (cell.upgrading) {
      progressActive = true;
      progressPct = cell.upgrading.totalTime ? (1 - cell.upgrading.progress / cell.upgrading.totalTime) : 1;
      upgradeVisual = true;
    } else if (cell.turret && cell.turret.upgrading) {
      progressActive = true;
      progressPct = cell.turret.upgrading.totalTime ? (1 - cell.turret.upgrading.progress / cell.turret.upgrading.totalTime) : 1;
      upgradeVisual = true;
    } else if (cell.type === 'researchLab' && player.activeResearchNode) {
      const node = TECH_TREE[player.activeResearchNode];
      progressActive = true;
      progressPct = node.time ? (player.researchProgress / node.time) : 0;
      researchVisual = true;
    }
    progressBar.style.display = progressActive ? 'block' : 'none';
    if (progressActive) progressFill.style.width = (Math.min(1, Math.max(0, progressPct)) * 100) + '%';
    el.classList.toggle('deconstructing', deconVisual);
    el.classList.toggle('upgrading-visual', upgradeVisual);
    el.classList.toggle('researching-visual', researchVisual);

    let title = `${tierCfgNow.label || def.label} — ${Math.ceil(cell.hp)}/${cell.maxHp} HP ${statusLabel(cell)}`;
    if (cell.turret) {
      const kindDef = TURRET_KINDS[cell.turret.kind];
      const tc = kindDef.tiers[cell.turret.tier - 1];
      if (cell.turret.kind === 'laser') {
        title += ` | ${kindDef.label} T${cell.turret.tier}: ${tc.dps} dps, charges ${tc.chargeTime}s then beams ${tc.beamDuration}s`;
      } else {
        title += ` | ${kindDef.label} T${cell.turret.tier}: ${tc.damage} dmg every ${tc.fireInterval}s`;
      }
      if (cell.turret.holdFire) title += ' (holding fire)';
    }
    el.title = title;
  }

  el.classList.toggle('selected', !!(state.selected && state.selected.player === playerKey && state.selected.depth === depth && state.selected.col === col));
}

function renderGrid(playerKey) {
  for (let d = 0; d < GRID_DEPTH; d++) {
    for (let c = 0; c < GRID_COLS; c++) renderCellEl(playerKey, d, c);
  }
}

function renderCoreRow(playerKey) {
  const player = state.players[playerKey];
  const missingPct = 1 - Math.max(0, player.core.hp / player.core.maxHp);
  const damagedSegments = Math.round(missingPct * GRID_COLS);
  const cells = coreCellEls[playerKey];
  const isSelected = !!(state.selected && state.selected.core && state.selected.player === playerKey);
  for (let i = 0; i < cells.length; i++) {
    cells[i].root.classList.toggle('damaged', i < damagedSegments);
    cells[i].root.classList.toggle('selected', isSelected);
  }
  coreLabelEls[playerKey].textContent = `${playerKey.toUpperCase()} CORE ${Math.ceil(player.core.hp)}/${player.core.maxHp}`;
}

function renderTopStats(playerKey) {
  const player = state.players[playerKey];
  const pct = (player.energy / player.maxEnergy) * 100;
  energyFill[playerKey].style.width = pct + '%';
  energyText[playerKey].textContent = `${Math.floor(player.energy)}/${player.maxEnergy}`;

  const flag = researchFlag[playerKey];
  flag.classList.remove('unlocked1', 'unlocked2');
  const completedCount = player.completedResearch.size;
  const totalCount = Object.keys(TECH_TREE).length;
  if (player.activeResearchNode) {
    const node = TECH_TREE[player.activeResearchNode];
    flag.textContent = `Researching: ${techNodeDisplayName(node)} (${Math.floor(player.researchProgress)}/${node.time}s)`;
    flag.classList.add('unlocked1');
  } else if (completedCount > 0) {
    flag.textContent = `Research: ${completedCount}/${totalCount} unlocked`;
    flag.classList.add(completedCount >= totalCount ? 'unlocked2' : 'unlocked1');
  } else {
    flag.textContent = 'Research: none';
  }

  renderCoreRow(playerKey);
}

function renderTierDots(current, max) {
  let dots = '';
  for (let i = 1; i <= max; i++) dots += `<span class="dot ${i <= current ? 'filled' : ''}"></span>`;
  return `<div class="tier-dots">${dots}</div>`;
}

function renderStatGrid(stats) {
  return `<div class="insp-stat-grid">${stats.map((s) => `<div class="insp-stat"><div class="label">${s.label}</div><div class="value">${s.value}</div></div>`).join('')}</div>`;
}

function turretStatsFor(kind, tierCfg) {
  if (kind === 'laser') {
    return [
      { label: 'DPS (while firing)', value: tierCfg.dps },
      { label: 'Charge time', value: `${tierCfg.chargeTime}s` },
      { label: 'Beam duration', value: `${tierCfg.beamDuration}s` },
      { label: 'Energy / sec', value: `${tierCfg.energyPerSecond}⚡/s` },
    ];
  }
  if (kind === 'ionCannon') {
    return [
      { label: 'DPS (while firing)', value: tierCfg.dps },
      { label: 'Charge time', value: `${tierCfg.chargeTime}s` },
      { label: 'Duration', value: 'Until stopped' },
      { label: 'Energy / sec', value: `${tierCfg.energyPerSecond}⚡/s` },
    ];
  }
  const kindDef = TURRET_KINDS[kind];
  const dps = (tierCfg.damage / tierCfg.fireInterval).toFixed(1);
  const epsCost = (tierCfg.energyPerShot / tierCfg.fireInterval).toFixed(1);
  const stats = [
    { label: kindDef.spread ? 'Damage / lane' : 'Damage / shot', value: tierCfg.damage },
    { label: 'Fire rate', value: `${(1 / tierCfg.fireInterval).toFixed(2)}/s` },
    { label: 'DPS', value: dps },
    { label: 'Energy / shot', value: `${tierCfg.energyPerShot}⚡` },
    { label: 'Energy / sec', value: `${epsCost}⚡/s` },
  ];
  if (kindDef.spread) stats.push({ label: 'Spread', value: `${kindDef.spread * 2 + 1} lanes` });
  return stats;
}

function turretUpgradeSubtext(kind, nextCfg, prevCfg) {
  if (kind === 'laser') {
    return `${nextCfg.cost}⚡ • charges in ${nextCfg.chargeTime}s, recharges in ${nextCfg.cooldownAfter}s (was ${prevCfg.chargeTime}s / ${prevCfg.cooldownAfter}s) — same DPS, more uptime`;
  }
  return `${nextCfg.cost}⚡ • fires every ${nextCfg.fireInterval}s (was ${prevCfg.fireInterval}s) — same damage, faster & flashier`;
}

function turretStatusText(turret, globalHold) {
  if (turret.status !== 'active') {
    return turret.status === 'constructing' ? `Building ${Math.ceil(turret.progress)}s` : `Removing ${Math.ceil(turret.progress)}s`;
  }
  if (turret.kind === 'laser') {
    if (turret.beamPhase === 'charging') return 'Charging…';
    if (turret.beamPhase === 'charged') return (turret.holdFire || globalHold) ? 'Charged — holding' : 'Charged!';
    if (turret.beamPhase === 'firing') return 'Firing!';
  }
  if (turret.kind === 'ionCannon') {
    if (turret.holdFire || globalHold) return 'Stopped';
    if (turret.beamPhase === 'charging') return 'Charging…';
    if (turret.beamPhase === 'firing') return 'Firing continuously!';
  }
  if (turret.holdFire) return 'Holding fire';
  if (globalHold) return 'Holding fire (all)';
  if (turret.kind === 'laser' && turret.cooldown > 0) return `Recharging ${Math.ceil(turret.cooldown)}s`;
  return 'Active';
}

// The inspector panel only rebuilds its innerHTML (destroying and recreating every button) when
// the STRUCTURE of what's selected actually changes - different tile, different tier/status, a
// turret added/removed/tiered-up. Anything that changes continuously (energy, HP, countdowns) is
// patched in place via `inspectorUpdaters`, closures registered at rebuild time that update
// existing nodes by reference. This is what makes clicking reliable: a rebuild tied to a fixed
// timer (even throttled) creates a window where a click can land on a node mid-replacement and
// silently do nothing. Rebuilding only on genuine structural change - which itself only happens
// as a direct result of a user action - removes that race entirely.
let inspectorSig = null;
let inspectorUpdaters = [];

// The tech tree section of a Research Lab's inspector panel: the active project (if any, with a
// live progress bar + an abandon button) followed by every node grouped by branch. A node button
// is completed/active/locked/available - locked ones stay clickable so the click can explain
// *why* (missing prereq vs. lab tier too low) via a toast, same pattern as other locked actions
// in this file, rather than just doing nothing.
// ======================= TECH TREE OVERLAY =======================
// The Tech Tree lives in its own big side panel (like the help/game-over overlays), not stuffed
// into the 250px inspector - four branch columns, each a real vertical chain of connected nodes
// (a .tt-connector between every parent/child pair, lit up once the parent's done) so the
// commitment path down a branch actually reads as a tree instead of a flat list. Same rebuild-
// only-on-structural-change pattern as the inspector (see inspectorSig) - techTreeSig/
// techTreeUpdaters - so a click can't land mid-rebuild and silently miss.
let techTreeSig = null;
let techTreeUpdaters = [];

function techNodeMeta(player, node, done, isActive, available) {
  if (done) return 'Researched';
  if (isActive) return 'In progress…';
  if (available) return `${node.time}s • ${node.energyPerSecond}⚡/s`;
  if (!techPrereqMet(player, node)) return `Needs ${TECH_TREE[node.requires].label}`;
  return `Needs Lab Tier ${node.labTier}`;
}

function techNodeBoxHtml(player, id) {
  const node = TECH_TREE[id];
  const done = player.completedResearch.has(id);
  const isActive = player.activeResearchNode === id;
  const available = !done && !isActive && techPrereqMet(player, node) && techLabTierMet(player, node);

  let cls = 'tech-node';
  if (done) cls += ' completed';
  else if (isActive) cls += ' active';
  else if (!available) cls += ' locked';

  const descList = node.desc.map((line) => `<li>${line}</li>`).join('');
  return `<button class="${cls}" id="tech-${id}">
    <span class="tech-node-name">${done ? '✓ ' : ''}${node.label}</span>
    <ul class="tech-node-desc">${descList}</ul>
    <span class="tech-node-meta">${techNodeMeta(player, node, done, isActive, available)}</span>
  </button>`;
}

function closeTechTree() {
  state.techTreeOpen = null;
  techTreeSig = null;
  renderTechTreeOverlay();
}

function renderTechTreeOverlay() {
  const overlayEl = $('tech-tree-overlay');
  if (!overlayEl) return;
  if (!state.techTreeOpen) {
    overlayEl.classList.add('hidden');
    return;
  }
  overlayEl.classList.remove('hidden');

  const playerKey = state.techTreeOpen;
  const player = state.players[playerKey];

  const sig = [playerKey, player.completedResearch.size, player.activeResearchNode || '', player.labMaxTier].join('|');
  if (sig === techTreeSig) {
    techTreeUpdaters.forEach((fn) => fn());
    return;
  }
  techTreeSig = sig;
  techTreeUpdaters = [];

  let html = `<div class="tt-header"><h2>${playerKey.toUpperCase()} Tech Tree</h2><button class="ctrl-btn" id="tech-tree-close">Close ✕</button></div>`;

  if (player.activeResearchNode) {
    const node = TECH_TREE[player.activeResearchNode];
    const pct = Math.min(100, (player.researchProgress / node.time) * 100);
    html += `<div class="tt-active">
      <div class="tech-active-label">Researching: ${techNodeDisplayName(node)}</div>
      <div class="insp-hpbar"><div class="insp-hpbar-fill" id="tt-fill" style="width:${pct}%;background:var(--research-color);"></div><span class="insp-hpbar-text" id="tt-text"></span></div>
      <button class="insp-action-btn danger" id="tt-cancel-research">Abandon Research<span class="sub">Loses all progress on ${techNodeDisplayName(node)}</span></button>
    </div>`;
  } else {
    html += `<div class="insp-explainer" style="margin-top:0;">No active project — pick a node below (only one project runs at a time).</div>`;
  }

  html += '<div class="tt-columns">';
  TECH_BRANCHES.forEach((branch) => {
    const nodeIds = Object.keys(TECH_TREE).filter((id) => TECH_TREE[id].branch === branch.key);
    html += `<div class="tt-branch-col"><div class="tt-branch-title">${branch.icon} ${branch.label}</div>`;
    nodeIds.forEach((id, idx) => {
      if (idx > 0) {
        const parentDone = player.completedResearch.has(nodeIds[idx - 1]);
        html += `<div class="tt-connector${parentDone ? ' done' : ''}"></div>`;
      }
      html += techNodeBoxHtml(player, id);
    });
    html += '</div>';
  });
  html += '</div>';

  const panelEl = $('tech-tree-panel');
  panelEl.innerHTML = html;

  const fillEl = $('tt-fill');
  const textEl = $('tt-text');
  if (fillEl && player.activeResearchNode) {
    const activeNode = TECH_TREE[player.activeResearchNode];
    techTreeUpdaters.push(() => {
      const pct = Math.min(100, (player.researchProgress / activeNode.time) * 100);
      fillEl.style.width = pct + '%';
      textEl.textContent = `${Math.floor(player.researchProgress)}s / ${activeNode.time}s`;
    });
  }

  const closeBtn = $('tech-tree-close');
  if (closeBtn) closeBtn.addEventListener('click', closeTechTree);

  const cancelBtn = $('tt-cancel-research');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      runAction('cancelResearch', playerKey, {});
      renderAll();
    });
  }

  Object.keys(TECH_TREE).forEach((id) => {
    const btn = $(`tech-${id}`);
    if (!btn) return;
    const node = TECH_TREE[id];
    btn.addEventListener('click', () => {
      if (player.completedResearch.has(id) || player.activeResearchNode === id) return;
      if (!techPrereqMet(player, node)) { showToast(`Locked — research ${techNodeDisplayName(TECH_TREE[node.requires])} first.`); return; }
      if (!techLabTierMet(player, node)) { showToast(`Locked — needs a Research Lab at Tier ${node.labTier}.`); return; }
      runAction('selectResearchNode', playerKey, { nodeId: id });
      renderAll();
    });
  });

  techTreeUpdaters.forEach((fn) => fn());
}

function renderInspector() {
  if (!state.selected) {
    if (inspectorSig !== 'none') {
      inspectorBody.innerHTML = `<p class="hint">Click a build option, then click an empty tile on <em>your own, unlocked</em> side to place it. Click an existing tile to inspect, upgrade, repair or deconstruct it. Click a locked (🔒) tile to unlock it for ${TILE_UNLOCK_COST}⚡.</p>`;
      inspectorSig = 'none';
      inspectorUpdaters = [];
    }
    return;
  }

  if (state.selected.core) {
    const playerKey = state.selected.player;
    const player = state.players[playerKey];
    const sig = `core|${playerKey}`;
    if (sig !== inspectorSig) {
      inspectorSig = sig;
      inspectorUpdaters = [];
      let html = `<div class="insp-title">${playerKey.toUpperCase()} Core</div>`;
      html += `<div class="insp-hpbar"><div class="insp-hpbar-fill" id="insp-hp-fill" style="width:0%"></div><span class="insp-hpbar-text" id="insp-hp-text"></span></div>`;
      html += renderStatGrid([{ label: 'Passive Income', value: `+${CORE_ENERGY_RATE}⚡/s` }]);
      html += `<div class="insp-explainer">If this reaches 0 HP, ${playerKey.toUpperCase()} loses immediately. Cannot be repaired, upgraded or deconstructed.</div>`;
      inspectorBody.innerHTML = html;
      const hpFillEl = $('insp-hp-fill');
      const hpTextEl = $('insp-hp-text');
      inspectorUpdaters.push(() => {
        const pct = player.core.maxHp ? Math.max(0, player.core.hp / player.core.maxHp) * 100 : 0;
        hpFillEl.style.width = pct + '%';
        hpTextEl.textContent = `${Math.ceil(player.core.hp)} / ${player.core.maxHp} HP`;
      });
    }
    inspectorUpdaters.forEach((fn) => fn());
    return;
  }

  const { player: playerKey, depth, col } = state.selected;
  const player = state.players[playerKey];
  const cell = player.grid[depth][col];
  if (cell.type === 'empty') {
    state.selected = null;
    inspectorSig = null;
    renderInspector();
    return;
  }

  const sig = [
    playerKey, depth, col, cell.type, cell.tier, cell.status,
    cell.turret ? `${cell.turret.kind}-${cell.turret.tier}-${cell.turret.status}-${cell.turret.holdFire}-${cell.turret.beamPhase}` : 'x',
    cell.upgrading ? 'u' : 'x', cell.turret && cell.turret.upgrading ? 'tu' : 'tx',
    player.completedResearch.size, // an empty wall's turret-pick list changes as tech nodes complete
    player.activeResearchNode || '', // the compact research status block changes
  ].join('|');

  if (sig === inspectorSig) {
    inspectorUpdaters.forEach((fn) => fn());
    return;
  }
  inspectorSig = sig;
  inspectorUpdaters = [];

  const def = TILE_TYPES[cell.type];
  const tierCfgNow = def.tiers[cell.tier - 1];
  const icon = tierCfgNow.icon || def.icon;
  const label = tierCfgNow.label || def.label;

  let html = '';
  html += `<div class="insp-title">${icon} ${playerKey.toUpperCase()} ${label}</div>`;
  html += renderTierDots(cell.tier, def.tiers.length);
  html += `<div class="insp-sub" id="insp-status-sub">${statusLabel(cell) || 'Active'}</div>`;
  html += `<div class="insp-hpbar"><div class="insp-hpbar-fill" id="insp-hp-fill" style="width:0%"></div><span class="insp-hpbar-text" id="insp-hp-text"></span></div>`;

  if (cell.type === 'generator' && cell.status !== 'deconstructing') {
    const gc = TILE_TYPES.generator.tiers[cell.tier - 1];
    html += renderStatGrid([{ label: 'Energy Output', value: `+${gc.energyRate}⚡/s` }]);
  }
  if (cell.type === 'storage' && cell.status !== 'deconstructing') {
    const sc = TILE_TYPES.storage.tiers[cell.tier - 1];
    html += renderStatGrid([{ label: 'Capacity', value: `+${sc.capacityBonus}⚡` }]);
  }
  if (cell.type === 'researchLab' && cell.status !== 'deconstructing') {
    const rc = TILE_TYPES.researchLab.tiers[cell.tier - 1];
    const totalRate = sumLabResearchRate(player);
    html += `<div class="insp-explainer">Every active Lab's Research Rate adds together (this Lab: ${rc.researchRate.toFixed(1)}, your total: ${totalRate.toFixed(1)}) to advance your one active project at that many seconds of progress per second. Destroying an active Lab removes ${LAB_DESTROY_PENALTY_PER_RATE}s of progress per point of Research Rate it had.</div>`;
    html += renderStatGrid([{ label: 'Research Rate', value: `${rc.researchRate.toFixed(1)}/s` }, { label: 'Your Total Rate', value: `${totalRate.toFixed(1)}/s` }]);
    if (player.activeResearchNode) {
      const node = TECH_TREE[player.activeResearchNode];
      const pct = Math.min(100, (player.researchProgress / node.time) * 100);
      html += `<div class="insp-sub">Researching: ${techNodeDisplayName(node)}</div>`;
      html += `<div class="insp-hpbar"><div class="insp-hpbar-fill" id="insp-tech-fill" style="width:${pct}%;background:var(--research-color);"></div><span class="insp-hpbar-text" id="insp-tech-text"></span></div>`;
    } else {
      html += `<div class="insp-sub" style="color:var(--hp-bad);">⚠ No active research project!</div>`;
    }
    html += `<button class="insp-action-btn" id="act-open-tech-tree">🌳 Open Tech Tree</button>`;
  }
  if (cell.type === 'amplifier' && cell.status !== 'deconstructing') {
    html += `<div class="insp-explainer">Boosts an adjacent Ion Cannon's damage by +${Math.round(AMPLIFIER_BONUS_PER_MIRROR * 100)}% per Amplifier touching its tile - all 8 neighbors count, so a full ring is +${Math.round(AMPLIFIER_BONUS_PER_MIRROR * 8 * 100)}%.</div>`;
  }
  if (cell.type === 'wall' && tierCfgNow.reflectsLaser) {
    html += `<div class="insp-explainer">While active (not under construction), reflects ${Math.round(MIRROR_REFLECT_FRACTION * 100)}% of incoming laser/Ion Cannon damage back at the shooter, costing you ${MIRROR_REFLECT_ENERGY_PER_DAMAGE}⚡ per point reflected. The other ${Math.round((1 - MIRROR_REFLECT_FRACTION) * 100)}% hits this wall normally. If you can't afford the energy, it just takes the hit like any other wall instead.</div>`;
  }

  if (cell.status === 'constructing') {
    html += `<button class="insp-action-btn danger" id="act-cancel-construct">Cancel Construction<span class="sub">Full refund of ${cell.investedCost}⚡</span></button>`;
  } else if (cell.status === 'deconstructing') {
    html += `<button class="insp-action-btn" id="act-cancel-deconstruct">Cancel Deconstruct</button>`;
  } else if (cell.status === 'active') {
    if (cell.type === 'researchLab') {
      // No manual upgrade path at all - see grantLabTier. Tier rises for free the instant the
      // matching Logistics node completes, for every active Lab a player owns.
      if (cell.tier < def.tiers.length) {
        const nextRank = def.tiers[cell.tier].labTierRank;
        html += `<div class="insp-sub">Tier rises automatically when you research Logistics ${nextRank === 2 ? 'T1' : 'T2'} - no manual upgrade.</div>`;
      } else {
        html += `<div class="insp-sub">Max tier reached.</div>`;
      }
    } else if (cell.upgrading) {
      html += `<div class="insp-sub" id="insp-upgrade-status">Upgrading… ${Math.ceil(cell.upgrading.progress)}s</div>`;
      html += `<button class="insp-action-btn danger" id="act-cancel-upgrade">Cancel Upgrade<span class="sub">Full refund of ${cell.upgrading.cost}⚡</span></button>`;
    } else if (cell.tier < def.tiers.length) {
      const nextCfg = def.tiers[cell.tier];
      const nextLabel = nextCfg.label ? `Upgrade to ${nextCfg.label}` : `Upgrade to Tier ${cell.tier + 1}`;
      html += `<button class="insp-action-btn" id="act-upgrade">${nextLabel}<span class="sub" id="act-upgrade-sub"></span></button>`;
    } else {
      html += `<button class="insp-action-btn" disabled>Max Tier Reached</button>`;
    }

    html += `<button class="insp-action-btn" id="act-repair" style="display:none;">Repair Fully<span class="sub" id="act-repair-sub"></span></button>`;

    if (cell.type === 'wall') {
      if (!cell.turret) {
        html += `<div class="insp-sub" style="margin-top:10px;">Build a turret here:</div>`;
        html += `<div class="insp-stat-grid" style="grid-template-columns:1fr 1fr 1fr;">`;
        Object.keys(TURRET_KINDS).forEach((k) => {
          if (!unlockedFor(player, TURRET_KINDS[k].tiers[0])) return; // hide kinds Weapons Lab hasn't unlocked yet
          const kd = TURRET_KINDS[k];
          html += `<button class="insp-action-btn turret-pick" id="pick-${k}">${kd.icon}<span class="sub" id="pick-${k}-sub"></span></button>`;
        });
        html += `</div>`;
      } else {
        const turret = cell.turret;
        const kindDef = TURRET_KINDS[turret.kind];
        html += `<div class="insp-title" style="margin-top:14px;">${kindDef.icon} ${kindDef.label}</div>`;
        html += renderTierDots(turret.tier, kindDef.tiers.length);
        if (turret.kind === 'ionCannon') {
          html += `<div class="insp-explainer">No automatic cutoff - fires every tick while started, until you stop it or energy runs out. Each Amplifier Mirror on the 8 tiles touching this one adds +${Math.round(AMPLIFIER_BONUS_PER_MIRROR * 100)}% damage (current: +${Math.round((amplifierMultiplier(player, depth, col) - 1) * 100)}%).</div>`;
        }
        html += `<div class="insp-sub" id="insp-turret-status-sub"></div>`;
        html += `<div class="insp-stat-grid" id="insp-turret-stats"></div>`;

        if (turret.status === 'constructing') {
          html += `<button class="insp-action-btn danger" id="act-cancel-turret-construct">Cancel Construction<span class="sub">Full refund of ${turret.investedCost}⚡</span></button>`;
        } else if (turret.status === 'deconstructing') {
          html += `<button class="insp-action-btn" id="act-cancel-turret-deconstruct">Cancel Removal</button>`;
        } else {
          html += `<button class="insp-action-btn hold-fire" id="act-toggle-hold"></button>`;
          if (turret.upgrading) {
            html += `<div class="insp-sub" id="insp-turret-upgrade-status">Upgrading… ${Math.ceil(turret.upgrading.progress)}s</div>`;
            html += `<button class="insp-action-btn danger" id="act-cancel-upgrade-turret">Cancel Upgrade<span class="sub">Full refund of ${turret.upgrading.cost}⚡</span></button>`;
          } else if (turret.tier < kindDef.tiers.length) {
            html += `<button class="insp-action-btn" id="act-upgrade-turret">Upgrade Turret to Tier ${turret.tier + 1}<span class="sub" id="act-upgrade-turret-sub"></span></button>`;
          } else {
            html += `<button class="insp-action-btn" disabled>Turret Max Tier</button>`;
          }
          html += `<button class="insp-action-btn danger" id="act-remove-turret">Remove Turret<span class="sub">75% refund (${Math.floor(turret.investedCost * DECON_REFUND)}⚡), takes ${TURRET_DECON_TIME}s</span></button>`;
        }
      }
    }

    html += `<button class="insp-action-btn danger" id="act-deconstruct" style="margin-top:14px;">Deconstruct Tile<span class="sub">75% refund (${Math.floor(cell.investedCost * DECON_REFUND)}⚡), takes ${DECON_TIME}s</span></button>`;
  }

  inspectorBody.innerHTML = html;

  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  bind('act-cancel-construct', () => { runAction('cancelConstruction', playerKey, { depth, col }); state.selected = null; renderAll(); });
  bind('act-cancel-deconstruct', () => { runAction('cancelDeconstruct', playerKey, { depth, col }); renderAll(); });

  const hpFillEl = $('insp-hp-fill');
  const hpTextEl = $('insp-hp-text');
  if (hpFillEl) {
    inspectorUpdaters.push(() => {
      const pct = cell.maxHp ? Math.max(0, cell.hp / cell.maxHp) * 100 : 0;
      hpFillEl.style.width = pct + '%';
      hpTextEl.textContent = `${Math.ceil(cell.hp)} / ${cell.maxHp} HP`;
    });
  }

  const statusSubEl = $('insp-status-sub');
  if (statusSubEl) {
    inspectorUpdaters.push(() => { statusSubEl.textContent = statusLabel(cell) || 'Active'; });
  }

  const upgradeBtn = $('act-upgrade');
  if (upgradeBtn) {
    const subEl = $('act-upgrade-sub');
    inspectorUpdaters.push(() => {
      const nextCfg = def.tiers[cell.tier];
      const locked = !unlockedFor(player, nextCfg);
      const afford = player.energy >= nextCfg.cost;
      subEl.textContent = locked
        ? `Locked — research ${missingTechLabel(player, nextCfg)} first`
        : `${nextCfg.cost}⚡ • ${nextCfg.buildTime}s • ${describeBaseUpgrade(cell.type, cell, nextCfg)}`;
      upgradeBtn.classList.toggle('locked', locked || !afford);
    });
    upgradeBtn.addEventListener('click', () => {
      const nextCfg = def.tiers[cell.tier];
      if (!unlockedFor(player, nextCfg)) { showToast(`Locked — research ${missingTechLabel(player, nextCfg)} first.`); return; }
      if (player.energy < nextCfg.cost) { showToast(`Not enough energy — need ${nextCfg.cost}⚡, have ${Math.floor(player.energy)}⚡.`); return; }
      runAction('startUpgradeBase', playerKey, { depth, col });
      renderAll();
    });
  }

  const upgradeStatusEl = $('insp-upgrade-status');
  if (upgradeStatusEl) {
    inspectorUpdaters.push(() => {
      if (cell.upgrading) upgradeStatusEl.textContent = `Upgrading… ${Math.ceil(cell.upgrading.progress)}s`;
    });
  }
  bind('act-cancel-upgrade', () => { runAction('cancelUpgradeBase', playerKey, { depth, col }); renderAll(); });

  const repairBtn = $('act-repair');
  if (repairBtn) {
    const subEl = $('act-repair-sub');
    inspectorUpdaters.push(() => {
      const missing = cell.maxHp - cell.hp;
      if (missing <= 0) { repairBtn.style.display = 'none'; return; }
      repairBtn.style.display = '';
      const cost = Math.ceil(missing * REPAIR_COST_PER_HP);
      subEl.textContent = `${cost}⚡`;
      repairBtn.classList.toggle('locked', player.energy < cost);
    });
    repairBtn.addEventListener('click', () => {
      const missing = cell.maxHp - cell.hp;
      const cost = Math.ceil(missing * REPAIR_COST_PER_HP);
      if (player.energy < cost) { showToast(`Not enough energy to repair — need ${cost}⚡, have ${Math.floor(player.energy)}⚡.`); return; }
      runAction('repairBase', playerKey, { depth, col });
      renderAll();
    });
  }

  Object.keys(TURRET_KINDS).forEach((k) => {
    const btn = $(`pick-${k}`);
    if (!btn) return;
    const subEl = $(`pick-${k}-sub`);
    const tc = TURRET_KINDS[k].tiers[0];
    inspectorUpdaters.push(() => {
      subEl.textContent = `${tc.cost}⚡`;
      btn.classList.toggle('locked', player.energy < tc.cost);
    });
    btn.addEventListener('click', () => {
      if (player.energy < tc.cost) { showToast(`Not enough energy — need ${tc.cost}⚡, have ${Math.floor(player.energy)}⚡.`); return; }
      runAction('place', playerKey, { depth, col, kind: k, tier: 1 });
      renderAll();
    });
  });

  bind('act-cancel-turret-construct', () => { runAction('cancelTurretConstruction', playerKey, { depth, col }); renderAll(); });
  bind('act-cancel-turret-deconstruct', () => { runAction('cancelTurretDeconstruct', playerKey, { depth, col }); renderAll(); });

  const turretStatusEl = $('insp-turret-status-sub');
  const turretStatsEl = $('insp-turret-stats');
  if (turretStatusEl && cell.turret) {
    inspectorUpdaters.push(() => {
      const turret = cell.turret;
      if (turret.status !== 'active') {
        turretStatusEl.textContent = turret.status === 'constructing' ? `Building ${Math.ceil(turret.progress)}s` : `Removing ${Math.ceil(turret.progress)}s`;
        if (turretStatsEl) turretStatsEl.innerHTML = '';
        return;
      }
      turretStatusEl.textContent = turretStatusText(turret, player.globalHoldFire);
      const tc = TURRET_KINDS[turret.kind].tiers[turret.tier - 1];
      if (turretStatsEl) {
        turretStatsEl.innerHTML = turretStatsFor(turret.kind, tc)
          .map((s) => `<div class="insp-stat"><div class="label">${s.label}</div><div class="value">${s.value}</div></div>`).join('');
      }
    });
  }

  const holdBtn = $('act-toggle-hold');
  if (holdBtn && cell.turret) {
    inspectorUpdaters.push(() => {
      const held = cell.turret.holdFire;
      if (cell.turret.kind === 'ionCannon') {
        holdBtn.textContent = held ? '▶ Start Firing' : '⏹ Stop Firing';
      } else {
        holdBtn.textContent = held ? '▶ Resume Fire' : '⏸ Hold Fire';
      }
      holdBtn.classList.toggle('active', held);
    });
    holdBtn.addEventListener('click', () => { runAction('toggleHoldFire', playerKey, { depth, col }); renderAll(); });
  }

  const turretUpgradeStatusEl = $('insp-turret-upgrade-status');
  if (turretUpgradeStatusEl) {
    inspectorUpdaters.push(() => {
      if (cell.turret && cell.turret.upgrading) turretUpgradeStatusEl.textContent = `Upgrading… ${Math.ceil(cell.turret.upgrading.progress)}s`;
    });
  }
  bind('act-cancel-upgrade-turret', () => { runAction('cancelUpgradeTurret', playerKey, { depth, col }); renderAll(); });

  const upgradeTurretBtn = $('act-upgrade-turret');
  if (upgradeTurretBtn && cell.turret) {
    const subEl = $('act-upgrade-turret-sub');
    const kindDef = TURRET_KINDS[cell.turret.kind];
    inspectorUpdaters.push(() => {
      const turret = cell.turret;
      const nextCfg = kindDef.tiers[turret.tier];
      const locked = !unlockedFor(player, nextCfg);
      const afford = player.energy >= nextCfg.cost;
      subEl.textContent = locked
        ? `Locked — research ${missingTechLabel(player, nextCfg)} first`
        : turretUpgradeSubtext(turret.kind, nextCfg, kindDef.tiers[turret.tier - 1]);
      upgradeTurretBtn.classList.toggle('locked', locked || !afford);
    });
    upgradeTurretBtn.addEventListener('click', () => {
      const turret = cell.turret;
      const nextCfg = kindDef.tiers[turret.tier];
      if (!unlockedFor(player, nextCfg)) { showToast(`Locked — research ${missingTechLabel(player, nextCfg)} first.`); return; }
      if (player.energy < nextCfg.cost) { showToast(`Not enough energy — need ${nextCfg.cost}⚡, have ${Math.floor(player.energy)}⚡.`); return; }
      runAction('startUpgradeTurret', playerKey, { depth, col });
      renderAll();
    });
  }

  bind('act-remove-turret', () => { runAction('startTurretDeconstruct', playerKey, { depth, col }); renderAll(); });
  bind('act-deconstruct', () => { runAction('startDeconstruct', playerKey, { depth, col }); renderAll(); });

  if (cell.type === 'researchLab' && cell.status !== 'deconstructing') {
    const techFillEl = $('insp-tech-fill');
    const techTextEl = $('insp-tech-text');
    if (techFillEl && player.activeResearchNode) {
      const activeNode = TECH_TREE[player.activeResearchNode];
      inspectorUpdaters.push(() => {
        const pct = Math.min(100, (player.researchProgress / activeNode.time) * 100);
        techFillEl.style.width = pct + '%';
        techTextEl.textContent = `${Math.floor(player.researchProgress)}s / ${activeNode.time}s`;
      });
    }

    bind('act-open-tech-tree', () => {
      state.techTreeOpen = playerKey;
      techTreeSig = null;
      renderAll();
    });
  }

  // Populate real values immediately so the first paint isn't blank placeholders.
  inspectorUpdaters.forEach((fn) => fn());
}

function renderLive() {
  renderGrid('p1');
  renderGrid('p2');
  renderTopStats('p1');
  renderTopStats('p2');
  renderCategoryPanel('p1');
  renderCategoryPanel('p2');
  renderToolInfo();
  renderCardActions('p1');
  renderCardActions('p2');
  renderTechTreeOverlay();
}

function renderAll() {
  renderLive();
  renderInspector();
}

/* ======================= MAIN LOOP ======================= */

function frame(ts) {
  if (state.lastTime === null) state.lastTime = ts;
  let dt = (ts - state.lastTime) / 1000;
  state.lastTime = ts;
  dt = Math.min(dt, 0.25);

  const isGuest = net.active && net.role === 'guest';

  if (!isGuest && state.started && !state.paused && !state.gameOver) {
    tick(dt * state.speed);
  }

  if (net.active && net.role === 'host' && net.connected) {
    netSnapshotAccum += dt;
    if (netSnapshotAccum >= NET_SNAPSHOT_INTERVAL) {
      netSnapshotAccum = 0;
      netSend(buildSnapshot());
    }
  }

  renderLive();
  renderInspector();
  requestAnimationFrame(frame);
}

/* ======================= GLOBAL CONTROLS ======================= */

function resetGame() {
  state.players.p1 = makePlayer('p1');
  state.players.p2 = makePlayer('p2');
  state.armed = null;
  state.selected = null;
  state.expandedCategory = { p1: null, p2: null };
  state.techTreeOpen = null;
  state.paused = false;
  state.started = false;
  state.gameOver = false;
  inspectorSig = null;
  inspectorUpdaters = [];
  techTreeSig = null;
  techTreeUpdaters = [];
  pendingImpactTimers.forEach((id) => clearTimeout(id));
  pendingImpactTimers = [];
  bulletLayer.innerHTML = '';
  $('game-over-overlay').classList.add('hidden');
  $('tech-tree-overlay').classList.add('hidden');
  $('pause-btn').textContent = 'Pause';
  $('countdown-overlay').classList.add('hidden');
  $('start-overlay').classList.remove('hidden');
  renderAll();
  updateOnlineUI();
}

// Mode/difficulty picked on the start screen, applied to `state` once Start Game is actually
// pressed - kept as plain variables (not on `state`) so resetGame()/Play Again don't have to
// know about them, and the buttons' last-picked state just survives untouched across restarts.
let selectedMode = 'pvp';
let selectedDifficulty = 'normal';

document.querySelectorAll('#mode-select .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode !== 'online' && net.active) teardownNetworking();
    selectedMode = btn.dataset.mode;
    document.querySelectorAll('#mode-select .mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $('difficulty-select').classList.toggle('hidden', selectedMode !== 'cpu');
    updateOnlineUI();
  });
});

document.querySelectorAll('#difficulty-select .diff-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedDifficulty = btn.dataset.diff;
    document.querySelectorAll('#difficulty-select .diff-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

document.querySelectorAll('#online-choice .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#online-choice .mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const wantHost = btn.dataset.online === 'host';
    $('online-host-box').classList.toggle('hidden', !wantHost);
    $('online-join-box').classList.toggle('hidden', wantHost);
    if (wantHost && !net.peer) startHosting();
    updateOnlineUI();
  });
});

$('online-copy-btn').addEventListener('click', () => {
  const input = $('online-link-input');
  input.select();
  const btn = $('online-copy-btn');
  const revert = () => { btn.textContent = 'Copy'; };
  const copied = () => { btn.textContent = 'Copied!'; setTimeout(revert, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).then(copied).catch(() => document.execCommand('copy') && copied());
  } else {
    document.execCommand('copy');
    copied();
  }
});

$('online-join-btn').addEventListener('click', () => {
  startJoining($('online-join-input').value);
  updateOnlineUI();
});

// Greys out and locks the side someone else is driving (CPU, or your friend online) for click
// purposes - the automated/remote side still acts on it directly through the same game
// functions, this only stops a human from also poking at it. See the [data-locked-side] rules
// in style.css.
function applyLockVisuals() {
  const label = { p1: 'P1', p2: 'P2' };
  let locked = '';
  if (state.vsCpu) {
    locked = state.cpuPlayer;
    label[state.cpuPlayer] = `${state.cpuPlayer.toUpperCase()} (CPU)`;
  } else if (net.active) {
    locked = otherKey(net.myPlayerKey);
    label[net.myPlayerKey] = `${net.myPlayerKey.toUpperCase()} (You)`;
    label[locked] = `${locked.toUpperCase()} (Friend)`;
  }
  document.body.dataset.lockedSide = locked;
  Object.keys(label).forEach((k) => {
    const el = document.querySelector(`#card-${k} .player-label`);
    if (el) el.textContent = label[k];
  });
}

function beginCountdown() {
  state.vsCpu = selectedMode === 'cpu';
  state.cpuDifficulty = selectedDifficulty;
  state.aiTimer = 0;
  applyLockVisuals();

  $('start-overlay').classList.add('hidden');
  const countdownEl = $('countdown-overlay');
  const numberEl = $('countdown-number');
  countdownEl.classList.remove('hidden');

  const pulse = (text) => {
    numberEl.textContent = text;
    numberEl.classList.remove('pulse');
    void numberEl.offsetWidth;
    numberEl.classList.add('pulse');
  };

  let n = 3;
  pulse(n);
  const step = () => {
    n -= 1;
    if (n > 0) {
      pulse(n);
      setTimeout(step, 800);
    } else {
      pulse('GO!');
      setTimeout(() => {
        countdownEl.classList.add('hidden');
        state.started = true;
        state.lastTime = null;
        updateSpeedLock();
      }, 600);
    }
  };
  setTimeout(step, 800);
}

$('start-btn').addEventListener('click', () => {
  if (selectedMode === 'online') {
    if (net.role !== 'host' || !net.connected) return;
    netSend({ t: 'start' });
  }
  beginCountdown();
});

$('pause-btn').addEventListener('click', () => {
  if (net.active && net.role === 'guest') return; // host-only control online
  if (state.gameOver) return;
  state.paused = !state.paused;
  $('pause-btn').textContent = state.paused ? 'Resume' : 'Pause';
});

$('speed-select').addEventListener('change', (e) => {
  if ((net.active && net.role === 'guest') || (state.started && !state.vsCpu)) {
    e.target.value = String(state.speed); // shouldn't fire while disabled, but don't trust it blindly
    return;
  }
  state.speed = parseFloat(e.target.value);
});

$('reset-btn').addEventListener('click', () => {
  if (net.active && net.role === 'guest') return; // host-only control online
  if (confirm('Reset the game? All progress will be lost.')) {
    if (net.active) netSend({ t: 'reset' });
    resetGame();
  }
});

$('game-over-reset').addEventListener('click', () => {
  if (net.active && net.role === 'guest') return; // host-only control online
  if (net.active) netSend({ t: 'reset' });
  resetGame();
});

$('help-btn').addEventListener('click', () => $('help-overlay').classList.remove('hidden'));
$('help-close').addEventListener('click', () => $('help-overlay').classList.add('hidden'));

/* ======================= TUTORIAL ======================= */
// Deliberately short - five steps just covering the mechanics a first-time player needs to get
// moving (build, place, upgrade, research). Anything more detailed already lives in the Help (?)
// reference panel, which stays untouched for that job.
const TUTORIAL_STEPS = [
  {
    icon: '🎯',
    title: 'The Goal',
    html: `Two <b>Cores</b> face off across a neutral zone. Defend yours, destroy theirs.
      You only start with one buildable row next to your Core — click a locked (🔒) tile
      to unlock the rest, one at a time.`,
  },
  {
    icon: '🏗️',
    title: 'Building Types',
    html: `Your sidebar groups everything into categories: <b>Walls</b> (block and soak damage),
      <b>Turrets</b> (mount on a wall, fire automatically), <b>Energy</b> (Generators &amp; Storage),
      <b>Utility</b> (Research Lab, Auto-Repair) and <b>Advanced</b> (Ion Cannon, Amplifier Mirror).
      Everything costs energy, which your Core and Generators produce over time.`,
  },
  {
    icon: '📍',
    title: 'Placing a Tile',
    html: `Click a category to expand it, pick a build option, then click an empty, unlocked
      tile on <b>your own</b> side. It costs energy immediately and takes a few seconds to
      finish — an unfinished tile is fragile, so don't leave it exposed.`,
  },
  {
    icon: '⬆️',
    title: 'Upgrading &amp; Repairing',
    html: `Click any built tile to inspect it. <b>Upgrade</b> raises it a tier for more HP/damage —
      it costs energy and takes time, but the tile keeps working at its current tier the whole
      way through. <b>Repair</b> tops off lost HP, or flip on <b>Auto-Repair</b> to do it hands-free.`,
  },
  {
    icon: '🔬',
    title: 'The Tech Tree',
    html: `Build a <b>Research Lab</b>, then open its Tech Tree from the inspector and pick ONE
      project. Your labs' combined research rate advances it over time; finishing a node unlocks
      stronger walls, turrets and more.`,
  },
];

let tutorialStep = 0;

function renderTutorialStep() {
  const step = TUTORIAL_STEPS[tutorialStep];
  $('tutorial-step-label').textContent = `Step ${tutorialStep + 1} of ${TUTORIAL_STEPS.length}`;
  $('tutorial-icon').textContent = step.icon;
  $('tutorial-title').innerHTML = step.title;
  $('tutorial-text').innerHTML = step.html;
  $('tutorial-dots').innerHTML = TUTORIAL_STEPS
    .map((_, i) => `<span class="dot${i === tutorialStep ? ' active' : ''}"></span>`)
    .join('');
  $('tutorial-prev').disabled = tutorialStep === 0;
  $('tutorial-next').textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Got it!' : 'Next';
}

function openTutorial() {
  tutorialStep = 0;
  renderTutorialStep();
  $('tutorial-overlay').classList.remove('hidden');
}

$('tutorial-btn').addEventListener('click', openTutorial);
$('tutorial-close').addEventListener('click', () => $('tutorial-overlay').classList.add('hidden'));
$('tutorial-prev').addEventListener('click', () => {
  if (tutorialStep > 0) { tutorialStep -= 1; renderTutorialStep(); }
});
$('tutorial-next').addEventListener('click', () => {
  if (tutorialStep < TUTORIAL_STEPS.length - 1) { tutorialStep += 1; renderTutorialStep(); }
  else $('tutorial-overlay').classList.add('hidden');
});

// Clicking the dimmed backdrop (anywhere that isn't the panel itself) closes the Tech Tree,
// same convention as the category flyouts dismissing on an outside click.
$('tech-tree-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'tech-tree-overlay') closeTechTree();
});

/* ======================= INIT ======================= */

buildCategoryPanel('p1');
buildCategoryPanel('p2');
buildCardActions('p1');
buildCardActions('p2');
buildBoard();
fitBoard();
window.addEventListener('resize', fitBoard);
renderAll();

// A link shared by a host (see startHosting) lands here as ?join=<peerId> - jump straight to the
// Join flow with the code prefilled and already connecting, so the friend just has to open it.
(() => {
  const joinId = new URLSearchParams(location.search).get('join');
  if (!joinId) return;
  document.querySelectorAll('#mode-select .mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'online'));
  selectedMode = 'online';
  $('difficulty-select').classList.add('hidden');
  document.querySelectorAll('#online-choice .mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.online === 'join'));
  $('online-host-box').classList.add('hidden');
  $('online-join-box').classList.remove('hidden');
  $('online-join-input').value = joinId;
  startJoining(joinId);
  updateOnlineUI();
})();

requestAnimationFrame(frame);
