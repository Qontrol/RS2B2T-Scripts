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
const SCRIPT_VERSION = '1.2';

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

/* ── Pickaxes: Mining to use, Attack to wield. Highest first. ── */

const PICKAXES = [
    { name: 'Dragon pickaxe', aliases: ['Dragon pickaxe'], mining: 61, attack: 60 },
    { name: 'Rune pickaxe', aliases: ['Rune pickaxe', 'Runite pickaxe'], mining: 41, attack: 40 },
    { name: 'Adamant pickaxe', aliases: ['Adamant pickaxe', 'Adamantite pickaxe'], mining: 31, attack: 30 },
    { name: 'Mithril pickaxe', aliases: ['Mithril pickaxe'], mining: 21, attack: 20 },
    { name: 'Black pickaxe', aliases: ['Black pickaxe'], mining: 11, attack: 10 },
    { name: 'Steel pickaxe', aliases: ['Steel pickaxe'], mining: 6, attack: 5 },
    { name: 'Iron pickaxe', aliases: ['Iron pickaxe'], mining: 1, attack: 1 },
    { name: 'Bronze pickaxe', aliases: ['Bronze pickaxe'], mining: 1, attack: 1 }
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
        ores: DWARVEN_ORES
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
        /** When Copper is selected, camp on and mine this rock first. */
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

function mineOp(actions) {
    return (actions ?? []).find(a => /^mine$/i.test(a)) ?? null;
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

/** Preferred rock tile for this site + ore dropdown (e.g. dwarven copper at 3026,9802). */
function preferredRockTile(site, oreChoice) {
    const prefs = site?.preferRocks;
    if (!prefs || !oreChoice) {
        return null;
    }
    const key = String(oreChoice).toLowerCase();
    if (key === 'copper') {
        return prefs.copper ?? null;
    }
    return null;
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
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    site() {
        return SITES[this.location] ?? SITES[LOC_ALKHARID];
    }

    /** Stand / leash pin — copper at Dwarven mine enterance uses 3026,9802. */
    camp() {
        const site = this.site();
        return preferredRockTile(site, this.oreChoice) ?? site.anchor;
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
            `Phils Miner ${SCRIPT_VERSION} — ${this.location} / ${this.oreChoice} / ${this.handling} — ` +
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
                `sell trips ${this.sellTrips} (${this.status})`
        );
    }

    syncPrefs({ silent = false } = {}) {
        const prevLoc = this.location;
        const prevOre = this.oreChoice;
        const prevHandle = this.handling;

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
            if (this.handling === HANDLE_SELL && oreCount() > 0) {
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
            await Traversal.walkTo(this.camp(), { radius: 1, timeoutMs: 8_000 });
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
            const prefer = preferredRockTile(site, this.oreChoice);
            const stay = prefer ? 2 : site.leash;
            if (Tile.from(under).distanceTo(camp) > stay) {
                this.status = `walking to ${site.label} rocks`;
                this.log(
                    `walking to ${site.label} camp ${camp.x},${camp.z}` +
                        (prefer ? ' (preferred copper)' : '')
                );
                await Traversal.walkResilient(camp, {
                    radius: prefer ? 1 : 3,
                    log: m => this.log(`  ${m}`)
                });
            }
            const at = Game.tile();
            return !!at && isUnderground(at) && Tile.from(at).distanceTo(camp) <= site.leash;
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
        const prefer = preferredRockTile(site, this.oreChoice);
        const inLeash = l => Tile.from(l.tile()).distanceTo(camp) <= site.leash;

        for (const ore of wanted) {
            const orePin = prefer && ore.id === 'copper' ? prefer : null;
            const candidates =
                Locs.query()
                    .where(l => mineOp(l.actions()) !== null)
                    .where(l => locMatchesOre(l, ore))
                    .where(inLeash)
                    .results() ?? [];

            if (orePin && candidates.length > 0) {
                const pinned = candidates.filter(l => Tile.from(l.tile()).distanceTo(orePin) <= 1);
                const pick = closestLocTo(pinned.length > 0 ? pinned : candidates, orePin);
                if (pick) {
                    return { rock: pick, ore };
                }
            }

            const rock = closestLocTo(candidates, camp) ?? candidates[0] ?? null;
            if (rock) {
                return { rock, ore };
            }
        }

        const namedExists = Locs.query()
            .where(l => site.ores.some(o => locMatchesOre(l, o)))
            .where(inLeash)
            .nearest();

        if (!namedExists && (this.oreChoice === ORE_ALL || this.oreChoice === ORE_HIGHEST)) {
            const generic = Locs.query()
                .where(l => mineOp(l.actions()) !== null)
                .where(l => isGenericRockName(l.name) || /rock/i.test(l.name ?? ''))
                .where(inLeash)
                .nearest();
            if (generic) {
                return { rock: generic, ore: wanted[0] };
            }
        }

        return null;
    }

    logNearbyMineLocs() {
        const site = this.site();
        const locs = Locs.query()
            .where(l => mineOp(l.actions()) !== null)
            .where(l => Tile.from(l.tile()).distanceTo(this.camp()) <= site.leash + 6)
            .results();
        const names = [...new Set((locs ?? []).map(l => l.name ?? '?'))];
        this.log(
            `no ${this.oreChoice} rocks in leash at ${site.label} — Mine locs: [${names.join(', ') || 'none'}]`
        );
    }

    async mineRock({ rock, ore }) {
        const op = mineOp(rock.actions());
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
            `${this.oreChoice}  ·  ${this.handling}  ·  inv ${oreCount()}`,
            `mined ${this.mined} (${fmtXph(orePh)}/hr)  trips ${this.bankTrips}` +
                (this.sellTrips ? `  sells ${this.sellTrips}` : '') +
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
        handling: {
            type: 'string',
            default: HANDLE_BANK,
            options: HANDLE_OPTIONS,
            label: 'When inventory is full',
            group: 'Handling',
            help:
                'Powermine drops ore on the spot. Bank always uses that location\'s own route: Al Kharid bank, Falador east via guild/Falador stairs, or Edgeville via the Barbarian Village ladder. ' +
                'Sell at store uses Drogo (inside the dwarven mine) or the town general store.'
        }
    },
    create: () => new PhilsMiner()
});
