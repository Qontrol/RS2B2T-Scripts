/**
 * Phils Miner — bank the best pickaxe (Mining + Attack), then mine at Al Kharid,
 * the Mining Guild, Falador scorpion enterance, or Dwarven mine enterance
 * (Barbarian Village / Ice Mountain). Powermine, bank, or sell.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 *
 * Versioning: start at 1.0; each update bumps 1.1, 1.2, 1.3, …
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('Phils Miner: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(`Phils Miner: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`);
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Npcs,
    Locs,
    GroundItems,
    Inventory,
    Equipment,
    Bank,
    Banking,
    Shop,
    Traversal,
    Tile,
    Skills,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'Phils Miner';
const SCRIPT_VERSION = '1.6';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

function welcomeHost() {
    return globalThis.rs2b0t ?? null;
}

function isWelcomeModalOpen() {
    const host = welcomeHost();
    if (!host?.reader) {
        return false;
    }
    const { reader } = host;
    const main = typeof reader.modals === 'function' ? reader.modals().main : -1;
    if (main === -1) {
        return false;
    }
    if (main === WELCOME_SCREEN_ID) {
        return true;
    }
    if (typeof reader.mainModalTexts !== 'function') {
        return false;
    }
    const texts = reader.mainModalTexts();
    return texts.some(
        t =>
            /welcome to runescape/i.test(t) ||
            /unread messages?/i.test(t) ||
            /jagex staff will never email/i.test(t)
    );
}

/**
 * Always dismiss "Welcome to RuneScape" by clicking Close Window (top-right).
 * @returns {Promise<boolean>} true if we acted on / closed it
 */
async function dismissWelcomeScreen() {
    if (!isWelcomeModalOpen()) {
        return false;
    }
    const host = welcomeHost();
    if (!host?.reader || !host?.actions) {
        return false;
    }
    const { reader, actions } = host;

    for (let attempt = 0; attempt < 8 && isWelcomeModalOpen(); attempt++) {
        const main = reader.modals().main;
        if (main === -1) {
            break;
        }

        let clicked = typeof actions.closeModal === 'function' && actions.closeModal();

        if (!clicked && typeof reader.closeButtonComId === 'function' && typeof actions.ifButton === 'function') {
            const closeId = reader.closeButtonComId(main);
            if (closeId !== -1) {
                clicked = !!actions.ifButton(closeId);
            }
        }

        if (!clicked && typeof reader.buttonByText === 'function' && typeof actions.ifButton === 'function') {
            for (const label of ['Close Window', 'Close']) {
                const btn = reader.buttonByText(main, label);
                if (btn !== -1 && actions.ifButton(btn)) {
                    clicked = true;
                    break;
                }
            }
        }

        if (!clicked && typeof actions.closeMainModal === 'function') {
            actions.closeMainModal(main);
        }

        await Execution.delay(250);
    }

    return !isWelcomeModalOpen();
}

/* ── Settings labels ── */

const LOC_ALKHARID = 'Al Kharid mine';
const LOC_GUILD = 'Mining Guild';
/** East Falador stairs into the dwarven mine (scorpion / top area). */
const LOC_FALADOR_SCORPION = 'Falador scorpion enterance';
/** Ice Mountain ladder, west of Barbarian Village. */
const LOC_DWARVEN_BV = 'Dwarven mine enterance';
const LOC_OPTIONS = [LOC_ALKHARID, LOC_GUILD, LOC_FALADOR_SCORPION, LOC_DWARVEN_BV];

const ORE_HIGHEST = 'Highest available';
const ORE_ALL = 'All ores';

const HANDLE_POWERMINE = 'Powermine (drop)';
const HANDLE_BANK = 'Bank';
const HANDLE_SELL = 'Sell at store';
const HANDLE_OPTIONS = [HANDLE_POWERMINE, HANDLE_BANK, HANDLE_SELL];

/** Drogo's Mining Emporium (buys ore) — west of the Falador stairs landing. */
const DROGO_STAND = new Tile(3038, 9756, 0);
const DROGO_KEEPERS = ['Drogo', 'Shop keeper', 'Shop assistant'];

/** Nurmof's Pickaxe Shop — south-west in the dwarven mine. */
const NURMOF_STAND = new Tile(2998, 9812, 0);
const NURMOF_NAME = 'Nurmof';

/* ── Pickaxes: Mining to use, Attack to wield. Highest first. ── */

const PICKAXES = [
    { name: 'Dragon pickaxe', aliases: ['Dragon pickaxe'], mining: 61, attack: 60 },
    { name: 'Rune pickaxe', aliases: ['Rune pickaxe', 'Runite pickaxe'], mining: 41, attack: 40, nurmofPrice: 32_000 },
    { name: 'Adamant pickaxe', aliases: ['Adamant pickaxe', 'Adamantite pickaxe'], mining: 31, attack: 30, nurmofPrice: 3_200 },
    { name: 'Mithril pickaxe', aliases: ['Mithril pickaxe'], mining: 21, attack: 20, nurmofPrice: 1_300 },
    { name: 'Black pickaxe', aliases: ['Black pickaxe'], mining: 11, attack: 10 },
    { name: 'Steel pickaxe', aliases: ['Steel pickaxe'], mining: 6, attack: 5, nurmofPrice: 500 },
    { name: 'Iron pickaxe', aliases: ['Iron pickaxe'], mining: 1, attack: 1, nurmofPrice: 140 },
    { name: 'Bronze pickaxe', aliases: ['Bronze pickaxe'], mining: 1, attack: 1, nurmofPrice: 1 }
];

/** Re-check bank for a better pick when Mining hits these. */
const PICKAXE_UNLOCKS = new Set([6, 11, 21, 31, 41, 61]);

/* ── Ores ── */

const ORE_COPPER = {
    id: 'copper',
    label: 'Copper',
    level: 1,
    itemNames: ['Copper ore'],
    matches: ['copper']
};
const ORE_TIN = {
    id: 'tin',
    label: 'Tin',
    level: 1,
    itemNames: ['Tin ore'],
    matches: ['tin']
};
const ORE_IRON = {
    id: 'iron',
    label: 'Iron',
    level: 15,
    itemNames: ['Iron ore'],
    matches: ['iron']
};
const ORE_SILVER = {
    id: 'silver',
    label: 'Silver',
    level: 20,
    itemNames: ['Silver ore'],
    matches: ['silver']
};
const ORE_COAL = {
    id: 'coal',
    label: 'Coal',
    level: 30,
    itemNames: ['Coal'],
    matches: ['coal']
};
const ORE_GOLD = {
    id: 'gold',
    label: 'Gold',
    level: 40,
    itemNames: ['Gold ore'],
    matches: ['gold']
};
const ORE_MITHRIL = {
    id: 'mithril',
    label: 'Mithril',
    level: 55,
    itemNames: ['Mithril ore'],
    matches: ['mithril']
};
const ORE_ADAMANT = {
    id: 'adamantite',
    label: 'Adamantite',
    level: 70,
    itemNames: ['Adamantite ore', 'Adamant ore'],
    matches: ['adamant']
};

const ALL_ORES = [
    ORE_COPPER,
    ORE_TIN,
    ORE_IRON,
    ORE_SILVER,
    ORE_COAL,
    ORE_GOLD,
    ORE_MITHRIL,
    ORE_ADAMANT
];

const ALKHARID_ORES = [
    ORE_COPPER,
    ORE_TIN,
    ORE_IRON,
    ORE_SILVER,
    ORE_COAL,
    ORE_GOLD,
    ORE_MITHRIL,
    ORE_ADAMANT
];
const GUILD_ORES = [ORE_COAL, ORE_MITHRIL];
const DWARVEN_ORES = [ORE_COPPER, ORE_TIN, ORE_IRON, ORE_COAL, ORE_GOLD, ORE_MITHRIL];

function oreOptionList(ores) {
    return [ORE_HIGHEST, ORE_ALL, ...ores.map(o => o.label)];
}

const ALKHARID_ORE_OPTIONS = oreOptionList(ALKHARID_ORES);
const GUILD_ORE_OPTIONS = oreOptionList(GUILD_ORES);
const DWARVEN_ORE_OPTIONS = oreOptionList(DWARVEN_ORES);

/* ── Sites ── */

const SITES = {
    [LOC_ALKHARID]: {
        id: 'alkharid',
        label: LOC_ALKHARID,
        /** North Al Kharid scorpion mine — most F2P ore types. */
        anchor: new Tile(3298, 3310, 0),
        leash: 18,
        underground: false,
        minMining: 1,
        bankStand: new Tile(3269, 3167, 0),
        bankName: 'Al Kharid',
        shopStand: new Tile(3316, 3178, 0),
        shopKeepers: ['Shop keeper', 'Shop assistant'],
        shopUnderground: false,
        ores: ALKHARID_ORES
    },
    [LOC_GUILD]: {
        id: 'guild',
        label: LOC_GUILD,
        /** Underground coal / mithril camp. */
        anchor: new Tile(3040, 9736, 0),
        /** South Falador guild door. */
        surfaceEnter: new Tile(3016, 3338, 0),
        climbStand: new Tile(3019, 3338, 0),
        /** Guild ladder (underground). Always exit here when banking. */
        undergroundExit: new Tile(3019, 9738, 0),
        leash: 22,
        underground: true,
        minMining: 60,
        bankStand: new Tile(3013, 3355, 0),
        bankName: 'Falador',
        shopStand: new Tile(2958, 3388, 0),
        shopKeepers: ['Shop keeper', 'Shop assistant'],
        shopUnderground: false,
        ores: GUILD_ORES
    },
    [LOC_FALADOR_SCORPION]: {
        id: 'falador-scorpion',
        label: LOC_FALADOR_SCORPION,
        /** Top of the mine, just inside the east-Falador stairs. */
        anchor: new Tile(3042, 9766, 0),
        /** East Falador staircase building — always enter/exit here. */
        surfaceEnter: new Tile(3058, 3376, 0),
        undergroundExit: new Tile(3058, 9776, 0),
        leash: 16,
        underground: true,
        minMining: 1,
        bankStand: new Tile(3013, 3355, 0),
        bankName: 'Falador',
        /** Drogo's ore shop — left/west of the Falador stairs landing. */
        shopStand: new Tile(3038, 9756, 0),
        shopKeepers: ['Drogo', 'Shop keeper', 'Shop assistant'],
        shopUnderground: true,
        ores: DWARVEN_ORES,
        /** Stand tile for "Phils copper spot" — rocks are adjacent, not on this square. */
        preferRocks: {
            copper: new Tile(3026, 9802, 0)
        }
    },
    [LOC_DWARVEN_BV]: {
        id: 'dwarven-bv',
        label: LOC_DWARVEN_BV,
        /** North dwarven mine, just inside the Ice Mountain / Barbarian Village ladder. */
        anchor: new Tile(3033, 9825, 0),
        /** Ladder west of Barbarian Village (south of Ice Mountain) — always enter/exit here. */
        surfaceEnter: new Tile(3019, 3450, 0),
        undergroundExit: new Tile(3019, 9850, 0),
        leash: 18,
        underground: true,
        minMining: 1,
        /** Closest bank on this route: Edgeville, via the BV ladder (never Falador stairs). */
        bankStand: new Tile(3094, 3492, 0),
        bankName: 'Edgeville',
        shopStand: new Tile(3038, 9756, 0),
        shopKeepers: ['Drogo', 'Shop keeper', 'Shop assistant'],
        shopUnderground: true,
        ores: DWARVEN_ORES,
        /** Stand tile for "Phils copper spot" — rocks are adjacent, not on this square. */
        preferRocks: {
            copper: new Tile(3026, 9802, 0)
        }
    }
};

/* ── Prefs / formatting ── */

function fmtXph(n) {
    if (n >= 100_000) {
        return `${(n / 1000).toFixed(0)}k`;
    }
    if (n >= 10_000) {
        return `${(n / 1000).toFixed(1)}k`;
    }
    return String(Math.round(n));
}

function fmtElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

function prefStorageKey(key) {
    const box =
        typeof location !== 'undefined'
            ? new URLSearchParams(location.search).get('box')
            : null;
    const suffix = `set:${SCRIPT_NAME}:${key}`;
    return box ? `rs2b0t:${box}:${suffix}` : `rs2b0t:${suffix}`;
}

function readPrefRaw(key) {
    const k = prefStorageKey(key);
    try {
        if (typeof sessionStorage !== 'undefined') {
            const v = sessionStorage.getItem(k);
            if (v !== null) {
                return v;
            }
        }
        if (typeof localStorage !== 'undefined') {
            return localStorage.getItem(k);
        }
    } catch {
        /* private mode / blocked storage */
    }
    return null;
}

function readPrefStr(key, fallback) {
    const raw = readPrefRaw(key);
    return raw !== null ? raw.trim() : fallback;
}

function readPrefBool(key, fallback) {
    const raw = readPrefRaw(key);
    if (raw === null) {
        return fallback;
    }
    const n = raw.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes';
}

function isPanelPaused() {
    return !!document.querySelector('.rs2b0t-value.rs2b0t-state-paused');
}

function unlockPausedPrefsUi() {
    if (!isPanelPaused()) {
        return;
    }
    for (const btn of document.querySelectorAll('button.rs2b0t-param-edit')) {
        if ((btn.textContent || '').includes('Edit parameters')) {
            btn.disabled = false;
            btn.title = 'Editable while paused — applies on the next loop / Resume';
        }
    }
    for (const backdrop of document.querySelectorAll('.rs2b0t-modal-backdrop')) {
        if (backdrop.style.display !== 'flex') {
            continue;
        }
        for (const el of backdrop.querySelectorAll('input, select, textarea')) {
            el.disabled = false;
        }
    }
}

function pickFrom(options, raw, fallback) {
    const s = String(raw ?? '').trim();
    const hit = options.find(o => o.toLowerCase() === s.toLowerCase());
    return hit ?? fallback;
}

/* ── Pickaxe helpers ── */

function normName(name) {
    return (name ?? '').toLowerCase().trim();
}

function pickDefByName(name) {
    const n = normName(name);
    if (!n || !n.includes('pickaxe')) {
        return null;
    }
    return PICKAXES.find(p => p.aliases.some(a => a.toLowerCase() === n) || n.includes(p.name.toLowerCase().replace(' pickaxe', ''))) ?? null;
}

function isPickaxeName(name) {
    const n = normName(name);
    return n.includes('pickaxe') || n === 'pick axe';
}

function canUsePick(def, mining) {
    return !!def && mining >= def.mining;
}

function canWieldPick(def, attack) {
    return !!def && attack >= def.attack;
}

function heldPickCount(name) {
    const n = name.toLowerCase();
    let c = 0;
    c += Inventory.items().filter(i => normName(i.name) === n).reduce((s, i) => s + Math.max(1, i.count), 0);
    if (typeof Equipment.contains === 'function' && Equipment.contains(name)) {
        c += 1;
    } else if (typeof Equipment.items === 'function') {
        c += Equipment.items().filter(i => normName(i.name) === n).length;
    }
    return c;
}

function heldPickCountDef(def) {
    return def.aliases.reduce((n, a) => n + heldPickCount(a), 0);
}

function bankPickCountDef(def) {
    if (!Bank.isOpen()) {
        return 0;
    }
    return def.aliases.reduce((n, a) => n + (Bank.count(a) || 0), 0);
}

function bestUsablePickDef(mining, hasFn) {
    for (const def of PICKAXES) {
        if (mining >= def.mining && hasFn(def)) {
            return def;
        }
    }
    return null;
}

function bestHeldPickDef() {
    return bestUsablePickDef(Skills.level('mining'), d => heldPickCountDef(d) > 0);
}

function hasUsablePick() {
    return bestHeldPickDef() !== null;
}

function pickRank(def) {
    if (!def) {
        return 999;
    }
    const i = PICKAXES.indexOf(def);
    return i < 0 ? 999 : i;
}

function coinCount() {
    return Inventory.items()
        .filter(i => normName(i.name) === 'coins')
        .reduce((n, i) => n + Math.max(0, i.count), 0);
}

/**
 * Nurmof upgrades we can use (Mining) and afford, better than the current pick.
 * Best first (Rune → … → Iron).
 */
function nurmofUpgradesAffordable(mining, gp, currentDef) {
    const currentRank = pickRank(currentDef);
    return PICKAXES.filter(
        d =>
            typeof d.nurmofPrice === 'number' &&
            mining >= d.mining &&
            gp >= d.nurmofPrice &&
            pickRank(d) < currentRank
    );
}

function shopStockCount(def) {
    if (typeof Shop.stock !== 'function' || !Shop.isOpen()) {
        return -1;
    }
    const rows = Shop.stock() ?? [];
    const names = new Set(def.aliases.map(a => a.toLowerCase()));
    let n = 0;
    for (const row of rows) {
        if (names.has(normName(row.name))) {
            n += Math.max(0, row.count ?? 0);
        }
    }
    return n;
}

function isBestPickName(name, bestDef) {
    if (!bestDef || !name) {
        return false;
    }
    const n = normName(name);
    return bestDef.aliases.some(a => a.toLowerCase() === n);
}

function equippedPickName() {
    if (typeof Equipment.items !== 'function') {
        return null;
    }
    const hit = Equipment.items().find(i => isPickaxeName(i.name));
    return hit?.name ?? null;
}

async function gearWaitBankLoaded() {
    if (typeof Bank.loaded === 'function') {
        await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
    }
    await Execution.delayTicks(1);
}

/* ── Ore / loc helpers ── */

function isUnderground(tile) {
    if (!tile) {
        return false;
    }
    return Tile.from(tile).z >= 6400;
}

function locActionList(loc) {
    if (!loc) {
        return [];
    }
    try {
        if (typeof loc.actions === 'function') {
            return loc.actions() ?? [];
        }
    } catch {
        /* some loc wrappers throw */
    }
    return [];
}

function mineOp(actions) {
    return (actions ?? []).find(a => /^mine/i.test(String(a))) ?? null;
}

function locMineOp(loc) {
    return mineOp(locActionList(loc));
}

function locTile(loc) {
    if (!loc) {
        return null;
    }
    try {
        const t = typeof loc.tile === 'function' ? loc.tile() : loc.tile;
        if (!t) {
            return null;
        }
        return Tile.from(t);
    } catch {
        return null;
    }
}

function tileCheb(a, b) {
    if (!a || !b) {
        return 999;
    }
    const p = Tile.from(a);
    const q = Tile.from(b);
    const pz = p.z ?? p.y ?? 0;
    const qz = q.z ?? q.y ?? 0;
    return Math.max(Math.abs(p.x - q.x), Math.abs(pz - qz));
}

function climbOp(actions, dir) {
    const list = actions ?? [];
    const down = dir === 'down';
    const hit = list.find(a => (down ? /climb.*down/i.test(a) : /climb.*up/i.test(a)));
    if (hit) {
        return hit;
    }
    if (down) {
        const enter = list.find(a => /^enter/i.test(a));
        if (enter) {
            return enter;
        }
    }
    return list.find(a => /^climb/i.test(a)) ?? null;
}

function isClimbLoc(loc) {
    const n = normName(loc.name);
    return (
        n.includes('stair') ||
        n.includes('ladder') ||
        n.includes('cave') ||
        n.includes('dungeon') ||
        n.includes('entrance') ||
        n.includes('enterance')
    );
}

function isShutDoor(loc) {
    const name = normName(loc.name);
    if (!name.includes('door') && !name.includes('gate')) {
        return false;
    }
    return loc.actions().some(a => /^open/i.test(a));
}

function openDoorOp(loc) {
    return loc.actions().find(a => /^open/i.test(a)) ?? null;
}

function locMatchesOre(loc, ore) {
    const name = normName(loc.name);
    if (!name) {
        return false;
    }
    return ore.matches.some(m => name.includes(m));
}

function isGenericRockName(name) {
    const n = normName(name);
    return n === 'rocks' || n === 'rock' || n === 'ore rocks';
}

function isOreItemName(name) {
    const n = normName(name);
    if (!n) {
        return false;
    }
    return ALL_ORES.some(o => o.itemNames.some(x => x.toLowerCase() === n) || o.matches.some(m => n === m || n === `${m} ore`));
}

function oreCount() {
    return Inventory.items()
        .filter(i => isOreItemName(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function oreNamesHeld() {
    const seen = new Set();
    const out = [];
    for (const i of Inventory.items()) {
        if (!isOreItemName(i.name)) {
            continue;
        }
        const key = i.name;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(key);
    }
    return out;
}

function countByExactName(name) {
    return Inventory.items()
        .filter(i => i.name === name)
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function isKeepTool(name) {
    if (!name) {
        return false;
    }
    const n = normName(name);
    if (n === 'coins') {
        return true;
    }
    return isPickaxeName(name);
}

function wantedOres(site, choice, mining) {
    const available = site.ores.filter(o => mining >= o.level);
    if (available.length === 0) {
        return [];
    }
    if (choice === ORE_ALL) {
        return available;
    }
    if (choice === ORE_HIGHEST) {
        return available.slice().sort((a, b) => b.level - a.level);
    }
    const specific = site.ores.find(o => o.label.toLowerCase() === choice.toLowerCase());
    if (!specific) {
        return available.slice().sort((a, b) => b.level - a.level);
    }
    if (mining < specific.level) {
        return available.slice().sort((a, b) => b.level - a.level);
    }
    return [specific];
}

/** 3026,9802 copper pin — only when Phils copper spot is ticked. */
function preferredRockTile(site, { philsCopperSpot } = {}) {
    if (!philsCopperSpot) {
        return null;
    }
    return site?.preferRocks?.copper ?? null;
}

function closestLocTo(locs, tile) {
    if (!locs || locs.length === 0 || !tile) {
        return null;
    }
    const pin = Tile.from(tile);
    let best = locs[0];
    let bestD = Tile.from(best.tile()).distanceTo(pin);
    for (let i = 1; i < locs.length; i++) {
        const d = Tile.from(locs[i].tile()).distanceTo(pin);
        if (d < bestD) {
            best = locs[i];
            bestD = d;
        }
    }
    return best;
}

/* ── Bot ── */

class PhilsMiner extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    mineXpAtStart = 0;
    mined = 0;
    bankTrips = 0;
    sellTrips = 0;
    lastOreSeen = 0;
    gearReady = false;
    loggedRockNames = false;
    location = LOC_ALKHARID;
    oreChoice = ORE_HIGHEST;
    handling = HANDLE_BANK;
    sellAndUpgrade = false;
    philsCopperSpot = false;
    pickUpgrades = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    site() {
        return SITES[this.location] ?? SITES[LOC_ALKHARID];
    }

    /** Stand on 3026,9802 when Phils copper spot is ticked (rocks are adjacent). */
    camp() {
        const site = this.site();
        return preferredRockTile(site, { philsCopperSpot: this.philsCopperSpot }) ?? site.anchor;
    }

    /** Map saved "Dwarven mine" (1.0) onto the Falador stairs location. */
    readLocation() {
        const raw = readPrefStr('location', this.settings.str('location', LOC_ALKHARID));
        if (/^dwarven mine$/i.test(String(raw).trim())) {
            return LOC_FALADOR_SCORPION;
        }
        return pickFrom(LOC_OPTIONS, raw, LOC_ALKHARID);
    }

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();

        this.syncPrefs({ silent: true });
        this.startedAt = Date.now();
        this.mineXpAtStart = Skills.xp('mining');
        this.mined = 0;
        this.bankTrips = 0;
        this.sellTrips = 0;
        this.pickUpgrades = 0;
        this.lastOreSeen = oreCount();
        this.gearReady = false;
        this.loggedRockNames = false;

        this.on('skill.level', e => {
            if (e.name === 'mining') {
                this.log(`mining ${e.previous} → ${e.level}`);
                if (PICKAXE_UNLOCKS.has(e.level)) {
                    this.gearReady = false;
                    this.log('mining unlock — will recheck bank for a better pickaxe');
                }
            }
            if (e.name === 'attack') {
                this.log(`attack ${e.previous} → ${e.level}`);
            }
        });

        const site = this.site();
        this.log(
            `Phils Miner ${SCRIPT_VERSION} — ${this.location} / ${this.oreChoice} / ` +
                `${this.sellAndUpgrade ? 'sell+upgrade' : this.handling} — ` +
                `Mining ${Skills.level('mining')} Attack ${Skills.level('attack')}`
        );
        if (Skills.level('mining') < site.minMining) {
            this.log(`WARNING: ${this.location} needs Mining ${site.minMining}+ (you have ${Skills.level('mining')})`);
        }
        this.status = 'ready';
    }

    startPausedPrefUnlock() {
        unlockPausedPrefsUi();
        this.unlockTimer = setInterval(() => unlockPausedPrefsUi(), 400);
    }

    onStop() {
        if (this.unlockTimer != null) {
            clearInterval(this.unlockTimer);
            this.unlockTimer = null;
        }
        this.log(
            `stopped — mined ~${this.mined}, bank trips ${this.bankTrips}, ` +
                `sell trips ${this.sellTrips}, upgrades ${this.pickUpgrades} (${this.status})`
        );
    }

    syncPrefs({ silent = false } = {}) {
        const prevLoc = this.location;
        const prevOre = this.oreChoice;
        const prevHandle = this.handling;
        const prevUpgrade = this.sellAndUpgrade;
        const prevCopperSpot = this.philsCopperSpot;

        this.location = this.readLocation();

        const oreKey =
            this.location === LOC_GUILD
                ? 'oreGuild'
                : this.location === LOC_FALADOR_SCORPION || this.location === LOC_DWARVEN_BV
                  ? 'oreDwarven'
                  : 'oreAlKharid';
        const oreOpts =
            this.location === LOC_GUILD
                ? GUILD_ORE_OPTIONS
                : this.location === LOC_FALADOR_SCORPION || this.location === LOC_DWARVEN_BV
                  ? DWARVEN_ORE_OPTIONS
                  : ALKHARID_ORE_OPTIONS;
        this.oreChoice = pickFrom(
            oreOpts,
            readPrefStr(oreKey, this.settings.str(oreKey, ORE_HIGHEST)),
            ORE_HIGHEST
        );

        this.handling = pickFrom(
            HANDLE_OPTIONS,
            readPrefStr('handling', this.settings.str('handling', HANDLE_BANK)),
            HANDLE_BANK
        );

        this.sellAndUpgrade = readPrefBool(
            'sellAndUpgrade',
            this.settings.bool('sellAndUpgrade', false)
        );

        this.philsCopperSpot = readPrefBool(
            'philsCopperSpot',
            this.settings.bool('philsCopperSpot', false)
        );

        if (!silent) {
            if (prevLoc !== this.location) {
                this.log(`prefs: location → ${this.location}`);
                this.loggedRockNames = false;
            }
            if (prevOre !== this.oreChoice) {
                this.log(`prefs: ore → ${this.oreChoice}`);
            }
            if (prevHandle !== this.handling) {
                this.log(`prefs: handling → ${this.handling}`);
            }
            if (prevUpgrade !== this.sellAndUpgrade) {
                this.log(`prefs: sell+upgrade → ${this.sellAndUpgrade ? 'on' : 'off'}`);
            }
            if (prevCopperSpot !== this.philsCopperSpot) {
                this.log(`prefs: Phils copper spot → ${this.philsCopperSpot ? 'on' : 'off'}`);
            }
        }
    }

    noteOres() {
        const now = oreCount();
        if (now > this.lastOreSeen) {
            this.mined += now - this.lastOreSeen;
        }
        this.lastOreSeen = now;
    }

    async loop() {
        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }
        if (await dismissWelcomeScreen()) {
            this.status = 'close welcome';
            return;
        }

        this.syncPrefs({ silent: true });
        unlockPausedPrefsUi();
        this.noteOres();

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (await this.prepPickaxe()) {
            return;
        }

        if (Shop.isOpen()) {
            if ((this.sellAndUpgrade || this.handling === HANDLE_SELL) && oreCount() > 0) {
                await this.sellOpenShop();
                return;
            }
            await Shop.close();
            return;
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        if (!hasUsablePick()) {
            this.gearReady = false;
            if (await this.lootPickFromGround({ wide: true })) {
                this.log('looted pickaxe from ground — continuing');
                return;
            }
            this.status = 'need pickaxe';
            this.log('no usable pickaxe — banking for one');
            await this.prepPickaxe({ force: true });
            return;
        }

        await this.maybeWieldPick();

        if (Inventory.isFull() && oreCount() > 0) {
            await this.handleFullPack();
            return;
        }

        const site = this.site();
        if (Skills.level('mining') < site.minMining) {
            this.status = `need Mining ${site.minMining}+`;
            this.log(
                `${site.label} requires Mining ${site.minMining} (you have ${Skills.level('mining')}) — waiting`
            );
            await Execution.delayTicks(8);
            return;
        }

        if (!(await this.ensureAtSite())) {
            return;
        }

        const inCombat = typeof Game.inCombat === 'function' && Game.inCombat();
        if (Game.animating() && !inCombat && !Inventory.isFull()) {
            this.status = 'mining';
            await Execution.delayTicks(1);
            this.noteOres();
            return;
        }

        const found = this.findRock();
        if (!found) {
            this.status = 'waiting for rock';
            if (!this.loggedRockNames) {
                this.logNearbyMineLocs();
                this.loggedRockNames = true;
            }
            await Traversal.walkTo(this.camp(), {
                radius: this.philsCopperSpot ? 0 : 2,
                timeoutMs: 8_000
            });
            await Execution.delayTicks(2);
            return;
        }

        await this.mineRock(found);
    }

    /**
     * Bank for the highest pickaxe this account can use (Mining) and wield (Attack).
     * @returns {Promise<boolean>} true if this loop was spent on gear
     */
    async prepPickaxe({ force = false } = {}) {
        if (this.gearReady && !force && hasUsablePick()) {
            return false;
        }

        this.status = 'gear: pickaxe';

        if (Shop.isOpen()) {
            await Shop.close();
            return true;
        }

        if (hasUsablePick() && !force) {
            await this.maybeWieldPick();
            this.gearReady = true;
            const held = bestHeldPickDef();
            this.log(`gear: ready — ${held?.name ?? 'pickaxe'}`);
            return true;
        }

        if (await this.lootPickFromGround({ wide: false })) {
            await this.maybeWieldPick();
            if (hasUsablePick()) {
                this.gearReady = true;
                return true;
            }
        }

        const here = Game.tile();
        if (here && isUnderground(here)) {
            this.log('gear: climbing to surface to bank for a pickaxe');
            await this.climbToSurface();
        }

        if (!Bank.isOpen()) {
            this.log('gear: opening nearest bank for best pickaxe');
            if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                this.log('gear: could not open bank — retrying');
                await Execution.delayTicks(3);
                return true;
            }
        }

        await gearWaitBankLoaded();

        this.log('gear: depositing all except pickaxes / coins');
        await Bank.depositAllMatching(name => !isKeepTool(name));
        await Execution.delayTicks(1);

        const mining = Skills.level('mining');
        const best = bestUsablePickDef(
            mining,
            d => heldPickCountDef(d) > 0 || bankPickCountDef(d) > 0
        );

        if (!best) {
            this.log(`gear: no usable pickaxe in bank/pack for Mining ${mining} — waiting`);
            await Bank.close();
            await Execution.delayTicks(8);
            return true;
        }

        if (heldPickCountDef(best) === 0 && bankPickCountDef(best) > 0) {
            const alias = best.aliases.find(a => (Bank.count(a) || 0) > 0) ?? best.name;
            this.log(`gear: withdrawing ${alias} (Mining ${best.mining}+ / Attack ${best.attack}+ to wield)`);
            if (!(await Bank.withdrawX(alias, 1))) {
                this.log(`gear: withdraw failed for ${alias}`);
                await Execution.delayTicks(2);
                return true;
            }
            await Execution.delayTicks(1);
        }

        // Deposit worse / extra pickaxes — keep one of the best.
        const keepName = best.aliases.find(a => heldPickCount(a) > 0) ?? best.name;
        await Bank.depositAllMatching(name => {
            if (!isPickaxeName(name)) {
                return false;
            }
            return normName(name) !== normName(keepName);
        });
        await Execution.delayTicks(1);

        await Bank.close();
        await Execution.delayTicks(1);

        await this.maybeWieldPick();

        if (!hasUsablePick()) {
            this.log('gear: still missing pickaxe after bank');
            await Execution.delayTicks(5);
            return true;
        }

        this.gearReady = true;
        const held = bestHeldPickDef();
        const atk = Skills.level('attack');
        const wieldOk = held && canWieldPick(held, atk);
        this.log(
            `gear: ready — ${held?.name ?? 'pickaxe'}` +
                (wieldOk ? ' (wielded)' : ' (in pack — Attack too low to wield)')
        );
        return true;
    }

    async maybeWieldPick() {
        const held = bestHeldPickDef();
        if (!held) {
            return;
        }
        const atk = Skills.level('attack');
        if (!canWieldPick(held, atk)) {
            return;
        }
        const worn = equippedPickName();
        if (worn && held.aliases.some(a => a.toLowerCase() === normName(worn))) {
            return;
        }
        const invName =
            held.aliases.find(a => Inventory.items().some(i => normName(i.name) === a.toLowerCase())) ??
            held.name;
        this.status = `gear: wield ${invName}`;
        this.log(`gear: wielding ${invName} (Attack ${atk} ≥ ${held.attack})`);
        if (typeof Equipment.equip === 'function') {
            await Equipment.equip(invName);
            await Execution.delayTicks(1);
        }
    }

    async lootPickFromGround({ wide = false } = {}) {
        if (hasUsablePick()) {
            return true;
        }
        const within = wide ? 18 : 10;
        const mining = Skills.level('mining');
        const ground = GroundItems.query()
            .where(g => {
                const def = pickDefByName(g.name);
                return def ? canUsePick(def, mining) : isPickaxeName(g.name);
            })
            .within(within)
            .nearest();
        if (!ground) {
            return false;
        }
        const before = Inventory.used();
        this.log(`taking ${ground.name} from ground`);
        await ground.interact('Take');
        const got = await Execution.delayUntil(() => hasUsablePick() || Inventory.used() > before, 6000);
        return got && hasUsablePick();
    }

    async handleFullPack() {
        if (this.sellAndUpgrade) {
            await this.sellAndUpgradeCycle();
            return;
        }
        if (this.handling === HANDLE_POWERMINE) {
            await this.dropOres();
            return;
        }
        if (this.handling === HANDLE_SELL) {
            await this.sellOresAndReturn();
            return;
        }
        await this.bankOresAndReturn();
    }

    async dropOres() {
        this.status = 'powermining — dropping';
        this.log(`inventory full — dropping ${oreCount()} ore`);
        for (let guard = 0; guard < 28; guard++) {
            const item = Inventory.items().find(i => isOreItemName(i.name));
            if (!item) {
                break;
            }
            const before = Inventory.used();
            await item.interact('Drop');
            await Execution.delayUntil(() => Inventory.used() < before, 3000);
            await Execution.delay(80 + Math.floor(Math.random() * 140));
        }
        this.lastOreSeen = oreCount();
    }

    async bankOresAndReturn() {
        const n = oreCount();
        const site = this.site();
        this.status = 'banking';
        this.log(`banking ${n} ore via ${site.bankName} (${site.label} route)`);

        if (Game.tile() && isUnderground(Game.tile())) {
            this.log(`climbing out ${site.label} — ${site.bankName} bank route`);
            await this.climbToSurface();
        }

        await this.walkToSiteBank();

        if (!Bank.isOpen()) {
            if (
                !(await Banking.open({
                    stand: site.bankStand,
                    log: m => this.log(`  ${m}`)
                }))
            ) {
                this.log('could not open bank — retrying');
                await Execution.delayTicks(3);
                return;
            }
        }

        await gearWaitBankLoaded();

        this.log('depositing ore (keep pickaxe / coins)');
        await Bank.depositAllMatching(name => {
            if (isKeepTool(name)) {
                return false;
            }
            return isOreItemName(name);
        });
        await Execution.delayTicks(1);
        await this.withdrawBestPickFromOpenBank();
        await Bank.close();
        await Execution.delayTicks(1);

        this.bankTrips++;
        this.lastOreSeen = oreCount();
        this.status = 'returning to rocks';
    }

    async walkToSiteBank() {
        const site = this.site();
        const here = Game.tile();
        if (here && Tile.from(here).distanceTo(site.bankStand) <= 2) {
            return;
        }
        this.status = `walking to ${site.bankName} bank`;
        this.log(`${site.label} bank route → ${site.bankName} ${site.bankStand.x},${site.bankStand.z}`);
        await Traversal.walkResilient(site.bankStand, {
            radius: 2,
            log: m => this.log(`  ${m}`)
        });
        await this.openNearbyDoor();
    }

    async withdrawBestPickFromOpenBank() {
        if (hasUsablePick()) {
            return;
        }
        const mining = Skills.level('mining');
        const best = bestUsablePickDef(mining, d => bankPickCountDef(d) > 0);
        if (!best) {
            this.log(`gear: WARNING — no usable pickaxe in bank for Mining ${mining}`);
            return;
        }
        const alias = best.aliases.find(a => (Bank.count(a) || 0) > 0) ?? best.name;
        this.log(`gear: withdrawing ${alias}`);
        await Bank.withdrawX(alias, 1);
        await Execution.delayTicks(1);
    }

    async sellOresAndReturn() {
        const n = oreCount();
        const site = this.site();
        this.status = 'walking to shop';
        this.log(`selling ${n} ore at ${site.shopKeepers[0]}`);

        if (site.shopUnderground) {
            if (Game.tile() && !isUnderground(Game.tile())) {
                await this.ensureAtSite();
            }
        } else if (Game.tile() && isUnderground(Game.tile())) {
            await this.climbToSurface();
        }

        const here = Game.tile();
        if (!here || Tile.from(here).distanceTo(site.shopStand) > 2) {
            await Traversal.walkResilient(site.shopStand, {
                radius: 2,
                log: m => this.log(`  ${m}`)
            });
        }
        await this.openNearbyDoor();

        this.status = `opening ${site.shopKeepers[0]}`;
        let opened = false;
        for (const keeper of site.shopKeepers) {
            if (await Shop.open(keeper)) {
                opened = true;
                break;
            }
        }
        if (!opened) {
            const npc = Npcs.query()
                .where(n => site.shopKeepers.some(k => normName(n.name) === k.toLowerCase()))
                .nearest();
            if (npc) {
                opened = await Shop.open(npc.name);
            }
        }
        if (!opened || !Shop.isOpen()) {
            this.log('could not open shop — retrying next loop');
            await Execution.delayTicks(3);
            return;
        }

        await this.sellOpenShop();
        this.sellTrips++;
        this.lastOreSeen = oreCount();
        this.status = 'returning to rocks';
    }

    async sellOpenShop() {
        this.status = 'selling ore';
        let sold = 0;
        for (let guard = 0; guard < 60 && oreCount() > 0 && Shop.isOpen(); guard++) {
            const names = oreNamesHeld();
            if (names.length === 0) {
                break;
            }
            for (const name of names) {
                const have = countByExactName(name);
                if (have <= 0) {
                    continue;
                }
                const n = await Shop.sell(name, have);
                if (n > 0) {
                    sold += n;
                    this.log(`sold ${n}× ${name}`);
                }
                await Execution.delayTicks(1);
            }
            if (oreCount() > 0) {
                await Execution.delayTicks(1);
            }
        }
        if (Shop.isOpen()) {
            await Shop.close();
        }
        if (oreCount() > 0) {
            this.log(`WARNING: still holding ${oreCount()} ore after sell — will retry`);
        } else {
            this.log(`sold ${sold} ore`);
        }
    }

    /**
     * Sell ore to Drogo, buy the best Nurmof pickaxe we can use and afford,
     * then bank the old pickaxe via this location's bank route.
     */
    async sellAndUpgradeCycle() {
        const n = oreCount();
        this.status = 'sell+upgrade';
        this.log(`sell+upgrade: selling ${n} ore at Drogo`);

        if (!(await this.ensureDwarvenShops())) {
            return;
        }

        if (!(await this.walkOpenKeeper(DROGO_STAND, DROGO_KEEPERS, 'Drogo'))) {
            return;
        }
        await this.sellOpenShop();
        this.sellTrips++;
        this.lastOreSeen = oreCount();

        if (oreCount() > 0) {
            return;
        }

        const bought = await this.tryUpgradeAtNurmof();
        if (bought) {
            await this.bankOldPickaxesAfterUpgrade();
        }
        this.status = 'returning to rocks';
    }

    /** Get underground in the dwarven mine so Drogo / Nurmof are reachable. */
    async ensureDwarvenShops() {
        const here = Game.tile();
        if (here && isUnderground(here)) {
            return true;
        }
        const site = this.site();
        if (site.underground) {
            return await this.ensureAtSite();
        }
        const falador = SITES[LOC_FALADOR_SCORPION];
        this.status = 'sell+upgrade: Falador stairs';
        this.log('sell+upgrade: walking to Falador scorpion enterance for Drogo');
        await Traversal.walkResilient(falador.surfaceEnter, {
            radius: 1,
            log: m => this.log(`  ${m}`)
        });
        await this.openNearbyDoor();
        if (!(await this.climb('down', falador.surfaceEnter))) {
            this.log('sell+upgrade: could not climb down Falador stairs');
            await Execution.delayTicks(3);
            return false;
        }
        return isUnderground(Game.tile());
    }

    async walkOpenKeeper(stand, keepers, label) {
        const here = Game.tile();
        if (!here || Tile.from(here).distanceTo(stand) > 2) {
            this.status = `walking to ${label}`;
            await Traversal.walkResilient(stand, {
                radius: 2,
                log: m => this.log(`  ${m}`)
            });
        }
        await this.openNearbyDoor();
        this.status = `opening ${label}`;
        for (const keeper of keepers) {
            if (await Shop.open(keeper)) {
                return true;
            }
        }
        const npc = Npcs.query()
            .where(n => keepers.some(k => normName(n.name) === k.toLowerCase()))
            .nearest();
        if (npc && (await Shop.open(npc.name))) {
            return true;
        }
        this.log(`could not open ${label} — retrying next loop`);
        await Execution.delayTicks(3);
        return false;
    }

    /**
     * Buy the best Nurmof pickaxe we can mine with and afford.
     * @returns {Promise<boolean>} true if a new pickaxe was bought
     */
    async tryUpgradeAtNurmof() {
        const mining = Skills.level('mining');
        const gp = coinCount();
        const current = bestHeldPickDef();
        const options = nurmofUpgradesAffordable(mining, gp, current);
        if (options.length === 0) {
            this.log(
                `sell+upgrade: ${gp}gp, ${current?.name ?? 'no pick'} — no Nurmof upgrade yet`
            );
            return false;
        }

        if (!(await this.walkOpenKeeper(NURMOF_STAND, [NURMOF_NAME], NURMOF_NAME))) {
            return false;
        }

        for (const def of options) {
            const stock = shopStockCount(def);
            if (stock === 0) {
                this.log(`sell+upgrade: ${def.name} out of stock`);
                continue;
            }
            if (coinCount() < def.nurmofPrice) {
                continue;
            }
            const before = heldPickCountDef(def);
            this.status = `buying ${def.name}`;
            this.log(`sell+upgrade: buying ${def.name} for ${def.nurmofPrice}gp (have ${coinCount()}gp)`);
            let got = false;
            for (const alias of def.aliases) {
                const bought = await Shop.buy(alias, 1);
                if (bought > 0 || heldPickCountDef(def) > before) {
                    got = true;
                    break;
                }
            }
            if (got) {
                this.log(`sell+upgrade: bought ${def.name}`);
                this.pickUpgrades++;
                if (Shop.isOpen()) {
                    await Shop.close();
                }
                await Execution.delayTicks(1);
                await this.maybeWieldPick();
                return true;
            }
            this.log(`sell+upgrade: ${def.name} buy failed — trying next`);
        }

        if (Shop.isOpen()) {
            await Shop.close();
        }
        this.log('sell+upgrade: no pickaxe bought (stock / coins)');
        return false;
    }

    async bankOldPickaxesAfterUpgrade() {
        const best = bestHeldPickDef();
        if (!best) {
            return;
        }

        const worn = equippedPickName();
        if (worn && !isBestPickName(worn, best) && typeof Equipment.unequip === 'function') {
            this.log(`sell+upgrade: unequipping old ${worn}`);
            await Equipment.unequip(worn);
            await Execution.delayTicks(1);
        }

        const extras = Inventory.items().filter(
            i => isPickaxeName(i.name) && !isBestPickName(i.name, best)
        );
        if (extras.length === 0) {
            await this.maybeWieldPick();
            return;
        }

        this.status = 'banking old pickaxe';
        this.log(`sell+upgrade: banking old pickaxe(s), keeping ${best.name}`);

        if (Game.tile() && isUnderground(Game.tile())) {
            await this.climbToSurface();
        }
        await this.walkToSiteBank();

        if (!Bank.isOpen()) {
            if (
                !(await Banking.open({
                    stand: this.site().bankStand,
                    log: m => this.log(`  ${m}`)
                }))
            ) {
                this.log('sell+upgrade: could not open bank for old pickaxe');
                await Execution.delayTicks(3);
                return;
            }
        }

        await gearWaitBankLoaded();
        await Bank.depositAllMatching(name => {
            if (normName(name) === 'coins') {
                return false;
            }
            if (isBestPickName(name, best)) {
                return false;
            }
            return isPickaxeName(name) || isOreItemName(name);
        });
        await Execution.delayTicks(1);
        await Bank.close();
        await Execution.delayTicks(1);
        this.bankTrips++;
        await this.maybeWieldPick();
    }

    /**
     * Walk / climb to the selected mine camp.
     * @returns {Promise<boolean>} true when standing inside the leash
     */
    async ensureAtSite() {
        const site = this.site();
        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return false;
        }

        if (site.underground) {
            if (!isUnderground(here)) {
                this.status = `walking to ${site.label} entrance`;
                const enter = site.surfaceEnter ?? site.anchor;
                if (Tile.from(here).distanceTo(enter) > 2) {
                    this.log(`walking to ${site.label} entrance ${enter.x},${enter.z}`);
                    await Traversal.walkResilient(enter, {
                        radius: 1,
                        log: m => this.log(`  ${m}`)
                    });
                }
                await this.openNearbyDoor();
                if (site.climbStand) {
                    const now = Game.tile();
                    if (now && Tile.from(now).distanceTo(site.climbStand) > 2) {
                        await Traversal.walkTo(site.climbStand, { radius: 1, timeoutMs: 8_000 });
                    }
                    await this.openNearbyDoor();
                }
                if (!(await this.climb('down', site.climbStand ?? site.surfaceEnter))) {
                    this.log(`could not climb down at ${site.label} — retrying`);
                    await Execution.delayTicks(3);
                    return false;
                }
            }
            const under = Game.tile();
            if (!under) {
                return false;
            }
            const camp = this.camp();
            const prefer = preferredRockTile(site, { philsCopperSpot: this.philsCopperSpot });
            const stay = prefer ? 0 : site.leash;
            if (Tile.from(under).distanceTo(camp) > stay) {
                this.status = `walking to ${site.label} rocks`;
                this.log(
                    `walking to ${site.label} stand ${camp.x},${camp.z}` +
                        (prefer ? ' (Phils copper spot — rocks are adjacent)' : '')
                );
                await Traversal.walkResilient(camp, {
                    radius: prefer ? 0 : 3,
                    log: m => this.log(`  ${m}`)
                });
            }
            const at = Game.tile();
            const arrived = prefer ? 1 : site.leash;
            return !!at && isUnderground(at) && Tile.from(at).distanceTo(camp) <= arrived;
        }

        if (isUnderground(here)) {
            await this.climbToSurface();
        }
        const surface = Game.tile();
        if (!surface) {
            return false;
        }
        if (Tile.from(surface).distanceTo(site.anchor) > site.leash) {
            this.status = `walking to ${site.label}`;
            this.log(`walking to ${site.label} ${site.anchor.x},${site.anchor.z}`);
            await Traversal.walkResilient(site.anchor, {
                radius: 3,
                log: m => this.log(`  ${m}`)
            });
        }
        const at = Game.tile();
        return !!at && Tile.from(at).distanceTo(site.anchor) <= site.leash;
    }

    async climbToSurface() {
        const here = Game.tile();
        if (!here || !isUnderground(here)) {
            return true;
        }
        const site = this.site();
        const exit = site.undergroundExit;
        if (exit && Tile.from(here).distanceTo(exit) > 2) {
            this.status = `walking to ${site.label} exit`;
            this.log(`${site.label} bank route: walk to exit ${exit.x},${exit.z}`);
            await Traversal.walkResilient(exit, {
                radius: 1,
                log: m => this.log(`  ${m}`)
            });
        } else if (!exit) {
            const stairs = this.findClimb('up');
            if (stairs && stairs.distance() > 4) {
                this.status = 'walking to stairs';
                await Traversal.walkTo(stairs.tile(), { radius: 1, timeoutMs: 12_000 });
            } else if (!stairs && site.anchor) {
                await Traversal.walkResilient(site.anchor, {
                    radius: 4,
                    log: m => this.log(`  ${m}`)
                });
            }
        }
        if (!(await this.climb('up', exit ?? null))) {
            this.log('could not climb up — retrying');
            await Execution.delayTicks(3);
            return false;
        }
        return true;
    }

    findClimb(dir, nearTile = null) {
        const opMatch = loc => climbOp(loc.actions(), dir) !== null;
        const locs =
            Locs.query()
                .where(l => isClimbLoc(l))
                .where(opMatch)
                .results() ?? [];
        const extra =
            locs.length > 0
                ? []
                : (Locs.query()
                      .where(opMatch)
                      .where(l => {
                          const n = normName(l.name);
                          return (
                              n.includes('stair') ||
                              n.includes('ladder') ||
                              n.includes('cave') ||
                              n.includes('climb')
                          );
                      })
                      .results() ?? []);
        const pool = locs.length > 0 ? locs : extra;
        if (!pool || pool.length === 0) {
            return null;
        }
        if (nearTile) {
            const pin = Tile.from(nearTile);
            let best = null;
            let bestD = 99;
            for (const loc of pool) {
                const d = Tile.from(loc.tile()).distanceTo(pin);
                if (d < bestD) {
                    best = loc;
                    bestD = d;
                }
            }
            if (best && bestD <= 10) {
                return best;
            }
        }
        let nearest = pool[0];
        let nd = nearest.distance();
        for (let i = 1; i < pool.length; i++) {
            const d = pool[i].distance();
            if (d < nd) {
                nearest = pool[i];
                nd = d;
            }
        }
        return nearest;
    }

    async climb(dir, nearTile = null) {
        const before = Game.tile();
        if (!before) {
            return false;
        }
        if (dir === 'down' && isUnderground(before)) {
            return true;
        }
        if (dir === 'up' && !isUnderground(before)) {
            return true;
        }

        const loc = this.findClimb(dir, nearTile);
        if (!loc) {
            this.log(`no ${dir} stairs/ladder in scene`);
            return false;
        }
        const op = climbOp(loc.actions(), dir);
        if (!op) {
            return false;
        }
        this.status = `${op} ${loc.name ?? 'stairs'}`;
        this.log(`${op} ${loc.name ?? 'stairs'} @ ${loc.tile().x},${loc.tile().z}`);
        await loc.interact(op);
        const moved = await Execution.delayUntil(() => {
            const t = Game.tile();
            if (!t) {
                return false;
            }
            if (dir === 'down') {
                return isUnderground(t);
            }
            return !isUnderground(t);
        }, 8000);
        if (!moved) {
            await this.openNearbyDoor();
        }
        const now = Game.tile();
        return dir === 'down' ? isUnderground(now) : !isUnderground(now);
    }

    async openNearbyDoor() {
        const door = Locs.query()
            .where(l => isShutDoor(l))
            .where(l => l.distance() <= 4)
            .nearest();
        if (!door) {
            return false;
        }
        const op = openDoorOp(door);
        if (!op) {
            return false;
        }
        this.log(`opening ${door.name}`);
        await door.interact(op);
        await Execution.delayTicks(2);
        return true;
    }

    findRock() {
        const site = this.site();
        const mining = Skills.level('mining');
        const wanted = wantedOres(site, this.oreChoice, mining);
        if (wanted.length === 0) {
            return null;
        }

        const camp = this.camp();
        const prefer = preferredRockTile(site, { philsCopperSpot: this.philsCopperSpot });
        const copper = wanted.find(o => o.id === 'copper') ?? ORE_COPPER;
        const inLeash = l => {
            const t = locTile(l);
            return t != null && tileCheb(t, camp) <= site.leash;
        };

        // Stand on 3026,9802; mine rocks on the adjacent squares (not on the stand tile).
        if (prefer) {
            const adjacent = Locs.query()
                .where(l => locMineOp(l) !== null)
                .where(l => {
                    const t = locTile(l);
                    if (!t) {
                        return false;
                    }
                    const d = tileCheb(t, prefer);
                    return d >= 1 && d <= 2;
                })
                .nearest();
            if (adjacent) {
                return { rock: adjacent, ore: copper };
            }
        }

        for (const ore of wanted) {
            const named = Locs.query()
                .where(l => locMineOp(l) !== null)
                .where(l => locMatchesOre(l, ore))
                .where(inLeash)
                .nearest();
            if (named) {
                return { rock: named, ore };
            }
        }

        const generic = Locs.query()
            .where(l => locMineOp(l) !== null)
            .where(l => isGenericRockName(l.name) || /rock/i.test(l.name ?? ''))
            .where(l => {
                const t = locTile(l);
                if (!t) {
                    return false;
                }
                if (prefer) {
                    const d = tileCheb(t, prefer);
                    return d >= 1 && d <= 2;
                }
                return tileCheb(t, camp) <= site.leash;
            })
            .nearest();
        if (generic) {
            return { rock: generic, ore: wanted[0] };
        }

        return null;
    }

    logNearbyMineLocs() {
        const camp = this.camp();
        const nearest = Locs.query()
            .where(l => locMineOp(l) !== null)
            .nearest();
        if (!nearest) {
            this.log(
                `no ${this.oreChoice} rock at ${camp.x},${camp.z} — no Mine locs in scene`
            );
            return;
        }
        const t = locTile(nearest);
        this.log(
            `no ${this.oreChoice} rock at ${camp.x},${camp.z} — nearest Mine loc: ` +
                `${nearest.name ?? '?'} @ ${t?.x ?? '?'},${t?.z ?? '?'} ` +
                `actions=[${locActionList(nearest).join(', ')}] dist=${nearest.distance()}t`
        );
    }

    async mineRock({ rock, ore }) {
        const op = locMineOp(rock);
        if (!op) {
            await Execution.delayTicks(1);
            return;
        }
        const before = oreCount();
        const beforeXp = Skills.xp('mining');
        const st = rock.tile();
        this.status = `mining ${ore.label} (${st.x},${st.z})`;
        this.log(`Mine ${rock.name ?? ore.label} @ ${st.x},${st.z}`);
        await rock.interact(op);

        await Execution.delayUntil(
            () =>
                oreCount() > before ||
                Skills.xp('mining') > beforeXp ||
                Game.animating() ||
                ChatDialog.canContinue() ||
                Inventory.isFull(),
            8000
        );
        this.noteOres();

        if (Game.animating() && !(typeof Game.inCombat === 'function' && Game.inCombat())) {
            await Execution.delayUntil(
                () =>
                    oreCount() > before ||
                    Skills.xp('mining') > beforeXp ||
                    !Game.animating() ||
                    ChatDialog.canContinue() ||
                    Inventory.isFull(),
                20_000
            );
            this.noteOres();
        }
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const xp = Skills.xp('mining') - this.mineXpAtStart;
        const xph = hrs > 0.008 ? xp / hrs : 0;
        const orePh = hrs > 0.008 ? this.mined / hrs : 0;
        const held = bestHeldPickDef();
        const pick = held?.name?.replace(/ pickaxe/i, '') ?? 'none';

        const lines = [
            `Phils Miner ${SCRIPT_VERSION}  Mine ${Skills.level('mining')}  Atk ${Skills.level('attack')}  ${pick}`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.location}  ·  ${this.status}`,
            `${this.oreChoice}` +
                (this.philsCopperSpot ? '  ·  Phils copper spot' : '') +
                `  ·  ${this.sellAndUpgrade ? 'sell+upgrade' : this.handling}  ·  inv ${oreCount()}`,
            `mined ${this.mined} (${fmtXph(orePh)}/hr)  trips ${this.bankTrips}` +
                (this.sellTrips ? `  sells ${this.sellTrips}` : '') +
                (this.pickUpgrades ? `  upgrades ${this.pickUpgrades}` : '') +
                `  XP ${fmtXph(xph)}/hr`
        ];

        ctx.font = '12px monospace';
        let maxW = 0;
        for (const line of lines) {
            maxW = Math.max(maxW, ctx.measureText(line).width);
        }
        const pad = 6;
        const lineH = 16;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, 6, maxW + pad * 2, pad * 2 + lines.length * lineH);
        ctx.fillStyle = '#c4a35a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: SCRIPT_VERSION,
    category: 'Mining',
    tags: [
        'mining',
        'pickaxe',
        'al-kharid',
        'mining-guild',
        'dwarven-mine',
        'falador',
        'barbarian-village',
        'powermine',
        'bank',
        'ore'
    ],
    description:
        "Phils Miner — best pickaxe (Mining / Attack), then Al Kharid, Mining Guild (60+), Falador scorpion enterance (east Falador stairs), or Dwarven mine enterance (Barbarian Village / Ice Mountain). Bank trips always use that site's own entrance.",
    settingsSchema: {
        location: {
            type: 'string',
            default: LOC_ALKHARID,
            options: LOC_OPTIONS,
            label: 'Location',
            group: 'Mine',
            help:
                'Al Kharid mine: north of town by the scorpions. ' +
                'Mining Guild: south Falador, Mining 60+, coal and mithril — bank Falador east via the guild ladder. ' +
                'Falador scorpion enterance: east Falador stairs, top of the dwarven mine — bank Falador east via those stairs. ' +
                'Dwarven mine enterance: Ice Mountain ladder west of Barbarian Village — bank Edgeville via that ladder.'
        },
        oreAlKharid: {
            type: 'string',
            default: ORE_HIGHEST,
            options: ALKHARID_ORE_OPTIONS,
            label: 'Ore',
            group: 'Mine',
            showIf: { key: 'location', anyOf: [LOC_ALKHARID] },
            help:
                'Ores at the Al Kharid scorpion mine. Highest available picks the best rock your Mining level allows. All ores clicks any of those rocks.'
        },
        oreGuild: {
            type: 'string',
            default: ORE_HIGHEST,
            options: GUILD_ORE_OPTIONS,
            label: 'Ore',
            group: 'Mine',
            showIf: { key: 'location', anyOf: [LOC_GUILD] },
            help: 'Mining Guild rocks (Mining 60 to enter): Coal (30), Mithril (55).'
        },
        oreDwarven: {
            type: 'string',
            default: ORE_HIGHEST,
            options: DWARVEN_ORE_OPTIONS,
            label: 'Ore',
            group: 'Mine',
            showIf: { key: 'location', anyOf: [LOC_FALADOR_SCORPION, LOC_DWARVEN_BV] },
            help:
                'Falador scorpion enterance (east stairs) and Dwarven mine enterance (Barbarian Village ladder): Copper, Tin, Iron, Coal, Gold, Mithril.'
        },
        philsCopperSpot: {
            type: 'boolean',
            default: false,
            label: 'Phils copper spot',
            group: 'Mine',
            showIf: { key: 'location', anyOf: [LOC_FALADOR_SCORPION, LOC_DWARVEN_BV] },
            help:
                'When ticked: stand on 3026,9802 and mine the copper rocks on the tiles next to it (not on that square). When off: Copper uses the normal dwarven camp — no forced stand tile.'
        },
        handling: {
            type: 'string',
            default: HANDLE_BANK,
            options: HANDLE_OPTIONS,
            label: 'When inventory is full',
            group: 'Handling',
            showIf: { key: 'sellAndUpgrade', anyOf: ['false'] },
            help:
                'Powermine drops ore on the spot. Bank always uses that location\'s own route: Al Kharid bank, Falador east via guild/Falador stairs, or Edgeville via the Barbarian Village ladder. ' +
                'Sell at store uses Drogo (inside the dwarven mine) or the town general store.'
        },
        sellAndUpgrade: {
            type: 'boolean',
            default: false,
            label: 'Sell and upgrade mode',
            group: 'Handling',
            help:
                'When on: full inventories are sold to Drogo (ore shop in the dwarven mine). ' +
                'Coins stay in the pack. When you can afford a better pickaxe you can use (Mining level) at Nurmof — Iron 140gp, Steel 500gp, Mithril 1,300gp, Adamant 3,200gp, Rune 32,000gp — it buys that pickaxe and banks the old one on this location\'s bank route. ' +
                'If Nurmof is out of stock it keeps mining and tries again next trip. Overrides Powermine / Bank / Sell at store.'
        }
    },
    create: () => new PhilsMiner()
});
