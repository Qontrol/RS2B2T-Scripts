/**
 * CatherbyBaitFisher — bait-rod sardine/herring at Catherby (Net+Bait spots only).
 * Withdraws Fishing rod + all Fishing bait from bank. Optional cook on bank-house Range,
 * optional sell catch to Harry instead of banking, then return to shore.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('CatherbyBaitFisher: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `CatherbyBaitFisher: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
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
    Bank,
    Banking,
    Shop,
    Traversal,
    Tile,
    Skills,
    ChatDialog,
    withdrawOp
} = abi;

const SCRIPT_NAME = 'CatherbyBaitFisher';

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
 * Retries until the modal is gone.
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

        // Prefer real Close Window (top-right BUTTON_CLOSE).
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

/** Catherby shore stand (pathable). */
const ANCHOR = new Tile(2845, 3431, 0);
const LEASH = 35;
const STAND_RADIUS = 8;

/** Catherby bank. */
const BANK_STAND = new Tile(2809, 3441, 0);

/** Harry's Fishing Shop stand. */
const HARRY_STAND = new Tile(2833, 3443, 0);
const HARRY_NAME = 'Harry';

/** Bank-house Range — between pier and bank. */
const RANGE_STAND = new Tile(2817, 3443, 0);
const RANGE_LOC = new Tile(2817, 3444, 0);
const RANGE_LEASH = 8;

const ROD_NAME = 'Fishing rod';
const BAIT_NAME = 'Fishing bait';
const SPOT_NAME = 'Fishing spot';
/** Cap for bait purchased from Harry when the bank is empty. */
const BAIT_BUY_MAX = 500;
/** Harry's Fishing bait baseline cost (gp each). */
const BAIT_COST = 3;

/** Raw names Harry buys that we catch (bait on Net+Bait). */
const HARRY_BUY_RAW = new Set(['raw sardine', 'raw herring']);

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
        /* private mode */
    }
    return null;
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

const PAINT_FONT_ID = 'benzyme-catherby-bait-font-v1';
const PAINT_FONT = '13px Exo, "Bebas Neue", "Bitcount Ink", sans-serif';

function ensurePaintFont() {
    if (typeof document === 'undefined') {
        return;
    }
    if (document.getElementById(PAINT_FONT_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = PAINT_FONT_ID;
    style.textContent =
        "@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Bitcount+Ink:wght@100..900&family=Exo:ital,wght@0,100..900;1,100..900&display=swap');";
    document.head.appendChild(style);
}

function isKeepGear(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    return n === 'fishing rod' || n === 'fishing bait';
}

function isRawBaitFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    if (!n.startsWith('raw ')) {
        return false;
    }
    return n.includes('sardine') || n.includes('herring');
}

function isCookedBaitFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase().trim();
    if (n.startsWith('raw ') || n.startsWith('burnt ')) {
        return false;
    }
    return n === 'sardine' || n === 'herring';
}

function isBurntFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    return n.startsWith('burnt ') || n === 'burnt fish';
}

function isBankableFish(name) {
    return isRawBaitFish(name) || isCookedBaitFish(name) || isBurntFish(name);
}

function isHarrySellable(name) {
    if (!name) {
        return false;
    }
    return HARRY_BUY_RAW.has(name.toLowerCase());
}

/**
 * Cooking level to cook each raw (not fishing level).
 * Sardine: Cooking 1. Herring: Cooking 5. Fishing: sardine 5 / herring 10.
 */
const COOK_LEVEL = {
    sardine: 1,
    herring: 5
};

function fishKind(name) {
    const n = (name ?? '').toLowerCase();
    if (n.includes('herring')) {
        return 'herring';
    }
    if (n.includes('sardine')) {
        return 'sardine';
    }
    return null;
}

function rawFishKind(name) {
    const n = (name ?? '').toLowerCase();
    if (!n.startsWith('raw ')) {
        return null;
    }
    return fishKind(n);
}

function canCookRaw(name) {
    const kind = rawFishKind(name);
    if (!kind) {
        return false;
    }
    return Skills.level('cooking') >= COOK_LEVEL[kind];
}

function countMatching(pred) {
    return Inventory.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function rawFishCount() {
    return countMatching(isRawBaitFish);
}

function cookableCount() {
    return countMatching(n => isRawBaitFish(n) && canCookRaw(n));
}

function cookedFishCount() {
    return countMatching(isCookedBaitFish);
}

function burntCount() {
    return countMatching(isBurntFish);
}

function harrySellCount() {
    return countMatching(isHarrySellable);
}

function fishForDisposeCount() {
    return rawFishCount() + cookedFishCount() + burntCount();
}

function lastCookableRaw() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        const name = items[i].name;
        if (isRawBaitFish(name) && canCookRaw(name)) {
            return items[i];
        }
    }
    return null;
}

function countCookableNamed(fragment) {
    const want = fragment.toLowerCase();
    return countMatching(
        n => isRawBaitFish(n) && canCookRaw(n) && (n ?? '').toLowerCase().includes(want)
    );
}

function matchCookProduct(products, preferName) {
    if (!products || products.length === 0) {
        return null;
    }
    const prefer = (preferName ?? '').toLowerCase();
    if (prefer) {
        const hit = products.find(p => (p ?? '').toLowerCase() === prefer);
        if (hit) {
            return hit;
        }
        const soft = products.find(p =>
            (p ?? '').toLowerCase().includes(prefer.replace(/^raw\s+/, ''))
        );
        if (soft) {
            return soft;
        }
    }
    for (const frag of ['herring', 'sardine']) {
        if (countCookableNamed(frag) <= 0) {
            continue;
        }
        const hit = products.find(p => (p ?? '').toLowerCase().includes(frag));
        if (hit) {
            return hit;
        }
    }
    return products[0] ?? null;
}

function hasRod() {
    return Inventory.items().some(i => (i.name ?? '').toLowerCase() === 'fishing rod');
}

function baitCount() {
    return countMatching(n => (n ?? '').toLowerCase() === 'fishing bait');
}

function hasBait() {
    return baitCount() > 0;
}

function needsGear() {
    return !hasRod() || !hasBait();
}

function isCoins(name) {
    return (name ?? '').toLowerCase() === 'coins';
}

function coinCount() {
    return countMatching(isCoins);
}

/** How many bait to buy from Harry to reach BAIT_BUY_MAX (never above 500). */
function baitBuyWant() {
    return Math.max(0, BAIT_BUY_MAX - baitCount());
}

function netOp(actions) {
    return actions.find(a => /^net$/i.test(a)) ?? null;
}

function baitOp(actions) {
    return actions.find(a => /^bait$/i.test(a)) ?? null;
}

/** Sardine/herring hops — Net + Bait (never Net + Harpoon / Lure + Bait). */
function isNetBaitSpot(actions) {
    return netOp(actions) !== null && baitOp(actions) !== null;
}

function isShutDoor(loc) {
    const name = (loc.name ?? '').toLowerCase();
    if (!name.includes('door') && !name.includes('gate')) {
        return false;
    }
    return loc.actions().some(a => /^open/i.test(a));
}

function openDoorOp(loc) {
    return loc.actions().find(a => /^open/i.test(a)) ?? null;
}

function isRodGroundName(name) {
    if (!name) {
        return false;
    }
    return name.toLowerCase() === 'fishing rod';
}

function harrySellNamesHeld() {
    const names = [];
    const seen = new Set();
    for (const item of Inventory.items()) {
        const name = item.name;
        if (!name || !isHarrySellable(name)) {
            continue;
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(name);
    }
    return names;
}

function countByExactName(name) {
    const want = (name ?? '').toLowerCase();
    return countMatching(n => (n ?? '').toLowerCase() === want);
}

class CatherbyBaitFisher extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    fishXpAtStart = 0;
    cookXpAtStart = 0;
    /** Total raw fish caught this session. */
    caught = 0;
    /** Total successfully cooked fish this session (not burnt). */
    cooked = 0;
    /** Units sold to Harry this session. */
    sold = 0;
    bankTrips = 0;
    sellTrips = 0;
    /** Preference: cook on Range before banking / selling. */
    cookOnWay = true;
    /** Preference: sell catch to Harry instead of banking. */
    sellToHarry = false;
    cookingLoad = false;
    lastRawSeen = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();
        ensurePaintFont();

        this.syncPrefs({ silent: true });
        this.startedAt = Date.now();
        this.fishXpAtStart = Skills.xp('fishing');
        this.cookXpAtStart = Skills.xp('cooking');
        this.caught = 0;
        this.cooked = 0;
        this.sold = 0;
        this.bankTrips = 0;
        this.sellTrips = 0;
        this.cookingLoad = false;
        this.lastRawSeen = rawFishCount();

        this.on('skill.level', e => {
            if (e.name === 'fishing' || e.name === 'cooking') {
                this.log(`${e.name} ${e.previous} → ${e.level}`);
            }
        });

        this.log(
            `CatherbyBaitFisher @ ${ANCHOR.x},${ANCHOR.z} — Bait on Net+Bait only; ` +
                `cook on way: ${this.cookOnWay ? 'on' : 'off'}; ` +
                `sell to Harry: ${this.sellToHarry ? 'on' : 'off'}`
        );
        if (!hasRod()) {
            this.log('WARNING: no Fishing rod — will withdraw from bank');
        }
        if (!hasBait()) {
            this.log('WARNING: no Fishing bait — will withdraw all from bank');
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
            `stopped — caught ${this.caught}, cooked ${this.cooked}, sold ${this.sold}, ` +
                `bank ${this.bankTrips}, sell trips ${this.sellTrips} (${this.status})`
        );
    }

    syncPrefs({ silent = false } = {}) {
        const prevCook = this.cookOnWay;
        const prevSell = this.sellToHarry;
        this.cookOnWay = readPrefBool(
            'cookOnWay',
            this.settings.bool('cookOnWay', true)
        );
        this.sellToHarry = readPrefBool(
            'sellToHarry',
            this.settings.bool('sellToHarry', false)
        );
        if (!silent && prevCook !== this.cookOnWay) {
            this.log(`prefs: cook on way → ${this.cookOnWay ? 'on' : 'off'}`);
        }
        if (!silent && prevSell !== this.sellToHarry) {
            this.log(`prefs: sell to Harry → ${this.sellToHarry ? 'on' : 'off'}`);
        }
    }

    noteCatches() {
        const now = rawFishCount();
        if (now > this.lastRawSeen) {
            this.caught += now - this.lastRawSeen;
        }
        this.lastRawSeen = now;
    }

    noteCooked(beforeCooked) {
        const now = cookedFishCount();
        if (now > beforeCooked) {
            const gained = now - beforeCooked;
            this.cooked += gained;
            return gained;
        }
        return 0;
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
        this.noteCatches();

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (Shop.isOpen()) {
            await this.sellOpenHarry();
            return;
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
            if (cookableCount() === 0 && fishForDisposeCount() > 0) {
                if (burntCount() > 0) {
                    await this.dropBurnt();
                }
                this.cookingLoad = false;
                await this.disposeCatchAndReturn();
            }
            return;
        }

        if (needsGear()) {
            if (!hasRod() && (await this.lootRodFromGround())) {
                this.log('looted Fishing rod');
                return;
            }
            this.status = 'need gear';
            this.log('missing rod/bait — banking for Fishing rod + all Fishing bait');
            await this.bankRestockAndReturn();
            return;
        }

        if (this.cookingLoad && cookableCount() > 0) {
            await this.cookLoad();
            return;
        }

        if (this.cookingLoad && cookableCount() === 0) {
            if (burntCount() > 0) {
                await this.dropBurnt();
            }
            this.cookingLoad = false;
            if (fishForDisposeCount() > 0) {
                await this.disposeCatchAndReturn();
            }
            return;
        }

        if (Inventory.isFull()) {
            if (this.cookOnWay && cookableCount() > 0) {
                this.cookingLoad = true;
                this.log(
                    `full inv (${cookableCount()} cookable / ${rawFishCount()} raw) — cooking on way`
                );
                await this.cookLoad();
                return;
            }
            if (fishForDisposeCount() > 0) {
                await this.disposeCatchAndReturn();
                return;
            }
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(ANCHOR) > LEASH) {
            this.status = 'returning to shore';
            await Traversal.walkResilient(ANCHOR, {
                radius: 3,
                log: m => this.log(`  ${m}`)
            });
            return;
        }

        if (Game.animating()) {
            this.status = 'fishing';
            await Execution.delayTicks(1);
            return;
        }

        const spot = this.findBaitSpot();
        if (!spot) {
            this.status = 'waiting for Net+Bait spot';
            if (Tile.from(here).distanceTo(ANCHOR) > STAND_RADIUS) {
                await Traversal.walkTo(ANCHOR, { radius: 2, timeoutMs: 12_000 });
            }
            await Execution.delayTicks(3);
            return;
        }

        await this.baitSpot(spot);
    }

    /** After cook (or raw full): sell to Harry or bank, then return to shore. */
    async disposeCatchAndReturn() {
        if (this.sellToHarry && (harrySellCount() > 0 || cookedFishCount() > 0)) {
            await this.sellToHarryAndReturn();
            return;
        }
        await this.bankRestockAndReturn();
    }

    findBaitSpot() {
        return Npcs.query()
            .name(SPOT_NAME)
            .where(n => isNetBaitSpot(n.actions()))
            .where(n => Tile.from(n.tile()).distanceTo(ANCHOR) <= LEASH)
            .nearest();
    }

    async baitSpot(spot) {
        const op = baitOp(spot.actions());
        if (!op) {
            await Execution.delayTicks(2);
            return;
        }

        const before = rawFishCount();
        const beforeBait = baitCount();
        const st = spot.tile();
        this.status = `baiting (${spot.distance()}t)`;
        this.log(`Bait sardine/herring spot @ ${st.x},${st.z}`);
        await spot.interact(op);

        await Execution.delayUntil(
            () =>
                rawFishCount() > before ||
                baitCount() < beforeBait ||
                Game.animating() ||
                ChatDialog.canContinue() ||
                !this.findBaitSpot(),
            8000
        );
        this.noteCatches();
    }

    async lootRodFromGround() {
        if (hasRod()) {
            return true;
        }
        const ground =
            GroundItems.query().name(ROD_NAME).within(12).nearest() ??
            GroundItems.query()
                .where(g => isRodGroundName(g.name))
                .within(12)
                .nearest();
        if (!ground) {
            return false;
        }
        const before = Inventory.used();
        await ground.interact('Take');
        return (
            (await Execution.delayUntil(() => hasRod() || Inventory.used() > before, 6000)) &&
            hasRod()
        );
    }

    findRange() {
        return (
            Locs.query()
                .name('Range', 'Cooking range', 'Fire', 'Fireplace')
                .where(l => Tile.from(l.tile()).distanceTo(RANGE_LOC) <= RANGE_LEASH)
                .nearest() ??
            Locs.query().name('Range', 'Cooking range').nearest()
        );
    }

    async openNearbyDoor() {
        const door = Locs.query()
            .where(l => isShutDoor(l))
            .where(l => l.distance() <= 3)
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

    async walkToRange() {
        this.status = 'walking to range';
        this.log(`walking to Range ${RANGE_STAND.x},${RANGE_STAND.z} (on way to bank/Harry)`);
        await Traversal.walkResilient(RANGE_STAND, {
            radius: 1,
            log: m => this.log(`  ${m}`)
        });
        await this.openNearbyDoor();
        const here = Game.tile();
        if (here && Tile.from(here).distanceTo(RANGE_STAND) > 2) {
            await Traversal.walkTo(RANGE_STAND, { radius: 1, timeoutMs: 12_000 });
        }
        if (!this.findRange()) {
            await Traversal.walkTo(RANGE_LOC, { radius: 1, timeoutMs: 8_000 });
            await this.openNearbyDoor();
        }
    }

    async chooseCookProduct() {
        const products = ChatDialog.makeProducts();
        const raw = lastCookableRaw();
        const hint = matchCookProduct(products, raw?.name);
        const kind = fishKind(hint) || fishKind(raw?.name);
        const frag = kind === 'herring' ? 'herring' : kind === 'sardine' ? 'sardine' : null;
        const batch = frag
            ? Math.max(1, Math.min(countCookableNamed(frag), 28))
            : Math.max(1, Math.min(cookableCount(), 28));
        this.status = 'cook make-menu';
        this.log(
            `cook menu: [${products.join(', ')}] pick=${hint ?? 'none'} x${batch}` +
                ` (cook ${Skills.level('cooking')})`
        );

        let picked = false;
        if (hint && typeof ChatDialog.makeX === 'function') {
            picked = await ChatDialog.makeX(hint, batch);
        }
        if (!picked && hint) {
            picked = await ChatDialog.make(hint);
        }
        if (!picked) {
            picked = await ChatDialog.make();
        }
        if (!picked) {
            this.log('could not pick cook product');
            await Execution.delayTicks(1);
            return;
        }

        const stillThisType = () =>
            frag ? countCookableNamed(frag) > 0 : cookableCount() > 0;

        await Execution.delayUntil(
            () => !ChatDialog.isMakeMenu() && (Game.animating() || !stillThisType()),
            5000
        );

        let cookedMark = cookedFishCount();
        let idle = 0;
        for (let guard = 0; guard < 400 && stillThisType(); guard++) {
            if (ChatDialog.canContinue() || ChatDialog.isMakeMenu()) {
                this.noteCooked(cookedMark);
                return;
            }
            await Execution.delayTicks(1);
            if (this.noteCooked(cookedMark) > 0) {
                cookedMark = cookedFishCount();
                idle = 0;
            } else if (!Game.animating() && ++idle >= 14) {
                break;
            } else if (Game.animating()) {
                idle = 0;
            }
        }
        this.noteCooked(cookedMark);
    }

    async cookLoad() {
        if (cookableCount() === 0) {
            this.cookingLoad = false;
            return;
        }

        const here = Game.tile();
        let oven = this.findRange();
        if (!here || Tile.from(here).distanceTo(RANGE_STAND) > 2 || !oven) {
            await this.walkToRange();
            oven = this.findRange();
        }
        if (!oven) {
            this.log('WARNING: no Range near bank house — disposing raw instead');
            this.cookingLoad = false;
            await this.disposeCatchAndReturn();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
            if (cookableCount() === 0) {
                if (burntCount() > 0) {
                    await this.dropBurnt();
                }
                this.cookingLoad = false;
                await this.disposeCatchAndReturn();
            }
            return;
        }

        const raw = lastCookableRaw();
        if (!raw) {
            this.cookingLoad = false;
            return;
        }

        const beforeCookable = cookableCount();
        let cookedMark = cookedFishCount();
        const beforeXp = Skills.xp('cooking');
        this.status = `cooking ${raw.name}`;
        this.log(
            `use ${raw.name} on ${oven.name ?? 'Range'} ` +
                `(${beforeCookable} cookable, cook lvl ${Skills.level('cooking')})`
        );

        if (!(await raw.useOn(oven))) {
            await this.openNearbyDoor();
            await Execution.delayTicks(2);
            return;
        }

        const started = await Execution.delayUntil(
            () =>
                cookableCount() < beforeCookable ||
                Skills.xp('cooking') > beforeXp ||
                ChatDialog.isMakeMenu() ||
                ChatDialog.canContinue(),
            4000
        );

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
            if (cookableCount() === 0) {
                if (burntCount() > 0) {
                    await this.dropBurnt();
                }
                this.cookingLoad = false;
                await this.disposeCatchAndReturn();
            }
            return;
        }

        if (!started && cookableCount() >= beforeCookable) {
            this.log('cook did not start — re-pathing to range');
            await this.walkToRange();
            return;
        }

        let mark = cookableCount();
        let idle = 0;
        for (let guard = 0; guard < 400 && cookableCount() > 0; guard++) {
            if (ChatDialog.canContinue() || ChatDialog.isMakeMenu()) {
                this.noteCooked(cookedMark);
                return;
            }
            await Execution.delayTicks(1);
            if (this.noteCooked(cookedMark) > 0) {
                cookedMark = cookedFishCount();
            }
            const now = cookableCount();
            if (now < mark) {
                mark = now;
                idle = 0;
            } else if (!Game.animating() && ++idle >= 14) {
                break;
            } else if (Game.animating()) {
                idle = 0;
            }
        }

        this.noteCooked(cookedMark);

        if (cookableCount() === 0) {
            if (burntCount() > 0) {
                await this.dropBurnt();
            }
            this.cookingLoad = false;
            await this.disposeCatchAndReturn();
        }
    }

    async dropBurnt() {
        this.status = 'dropping burnt';
        for (let guard = 0; guard < 28; guard++) {
            const item = Inventory.items().find(i => isBurntFish(i.name));
            if (!item) {
                break;
            }
            const before = Inventory.used();
            await item.interact('Drop');
            await Execution.delayUntil(() => Inventory.used() < before, 3000);
            await Execution.delay(80 + Math.floor(Math.random() * 140));
        }
    }

    async sellToHarryAndReturn() {
        const rawSell = harrySellCount();
        const cooked = cookedFishCount();
        this.status = 'walking to Harry';
        this.log(
            `selling to Harry` +
                (rawSell ? ` ${rawSell} raw` : '') +
                (cooked ? ` (${cooked} cooked → bank after)` : '')
        );

        this.lastRawSeen = 0;

        await Traversal.walkResilient(HARRY_STAND, {
            radius: 2,
            log: m => this.log(`  ${m}`)
        });
        await this.openNearbyDoor();

        this.status = 'opening Harry';
        if (!(await Shop.open(HARRY_NAME))) {
            this.log('could not open Harry — retrying next loop');
            await Execution.delayTicks(3);
            return;
        }

        await this.sellOpenHarry();
    }

    async sellOpenHarry() {
        this.status = 'selling to Harry';
        let sold = 0;
        for (let guard = 0; guard < 60 && harrySellCount() > 0 && Shop.isOpen(); guard++) {
            const names = harrySellNamesHeld();
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
                    this.log(`sold ${n}× ${name} to Harry`);
                }
                await Execution.delayTicks(1);
            }
            if (harrySellCount() > 0) {
                await Execution.delayTicks(1);
            }
        }

        if (Shop.isOpen()) {
            await Shop.close();
        }

        this.sold += sold;
        this.sellTrips++;
        this.cookingLoad = false;

        if (harrySellCount() > 0) {
            this.log(`WARNING: still holding ${harrySellCount()} sellable raw — will retry`);
            await Execution.delayTicks(3);
            return;
        }

        // Cooked leftovers Harry won't buy — bank them + restock bait/rod.
        if (cookedFishCount() > 0 || burntCount() > 0 || needsGear()) {
            await this.bankRestockAndReturn();
            return;
        }

        this.lastRawSeen = rawFishCount();
        this.status = 'returning to shore';
        await Traversal.walkResilient(ANCHOR, {
            radius: 3,
            log: m => this.log(`  ${m}`)
        });
    }

    /**
     * Bank fish, withdraw Fishing rod (if needed) + Withdraw-All Fishing bait, return to shore.
     */
    async bankRestockAndReturn() {
        const raw = rawFishCount();
        const cooked = cookedFishCount();
        this.status = 'banking';
        this.log(
            `banking` +
                (raw ? ` ${raw} raw` : '') +
                (cooked ? ` ${cooked} cooked` : '') +
                (burntCount() ? ` ${burntCount()} burnt` : '') +
                ` — restock rod + all bait`
        );

        this.lastRawSeen = 0;

        await Banking.bankNearest({
            destination: { name: 'Catherby', tile: BANK_STAND },
            deposit: name => {
                if (isKeepGear(name)) {
                    return false;
                }
                return isBankableFish(name);
            },
            afterDeposit: async () => await this.withdrawGearFromOpenBank(),
            returnTo: ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.cookingLoad = false;
        this.lastRawSeen = rawFishCount();
        this.status = 'returning to shore';

        if (!hasRod()) {
            this.log('WARNING: still no Fishing rod after bank');
        }
        if (!hasBait()) {
            this.log('WARNING: still no Fishing bait after bank — stock the bank');
        } else {
            this.log(`gear ready — rod + ${baitCount()} bait`);
        }
    }

    async withdrawGearFromOpenBank() {
        if (!Bank.isOpen()) {
            return;
        }
        await Execution.delayUntil(() => Bank.loaded() || !Bank.isOpen(), 3000);
        if (!Bank.isOpen()) {
            return;
        }

        if (!hasRod()) {
            const rodBank = Bank.items().find(
                i => (i.name ?? '').toLowerCase() === 'fishing rod'
            );
            if (rodBank) {
                const op =
                    (typeof withdrawOp === 'function'
                        ? withdrawOp(rodBank.ops, '1')
                        : null) ?? 'Withdraw-1';
                this.log('withdrawing Fishing rod');
                await Bank.withdraw(ROD_NAME, op);
                await Execution.delayTicks(1);
            } else {
                this.log('WARNING: no Fishing rod in bank');
            }
        }

        const baitBank = Bank.items().find(
            i => (i.name ?? '').toLowerCase() === 'fishing bait'
        );
        if (baitBank && (baitBank.count ?? 0) > 0) {
            const allOp =
                (typeof withdrawOp === 'function'
                    ? withdrawOp(baitBank.ops, 'all')
                    : null) ?? 'Withdraw-All';
            const before = baitCount();
            this.log(`withdrawing all Fishing bait (bank has ${baitBank.count})`);
            await Bank.withdraw(BAIT_NAME, allOp);
            await Execution.delayUntil(() => baitCount() > before || !Bank.isOpen(), 4000);
        } else if (!hasBait()) {
            this.log('WARNING: no Fishing bait in bank');
        }
    }

    onPaint(ctx) {
        ensurePaintFont();
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const fishXp = Skills.xp('fishing') - this.fishXpAtStart;
        const cookXp = Skills.xp('cooking') - this.cookXpAtStart;
        const fishXph = hrs > 0.008 ? fishXp / hrs : 0;
        const cookXph = hrs > 0.008 ? cookXp / hrs : 0;
        const caughtPh = hrs > 0.008 ? this.caught / hrs : 0;
        const cookedPh = hrs > 0.008 ? this.cooked / hrs : 0;
        const soldPh = hrs > 0.008 ? this.sold / hrs : 0;

        const mode = this.sellToHarry
            ? this.cookOnWay
                ? 'cook→Harry'
                : 'sell→Harry'
            : this.cookOnWay
              ? 'cook→bank'
              : 'bank raw';

        const lines = [
            `Benzyme's Catherby Bait  Fish ${Skills.level('fishing')}  Cook ${Skills.level('cooking')}`,
            `time ${fmtElapsed(elapsed)}  ·  ${mode}  ·  ${this.status}`,
            `caught ${this.caught} (${fmtXph(caughtPh)}/hr)  cooked ${this.cooked} (${fmtXph(cookedPh)}/hr)` +
                (this.sellToHarry || this.sold > 0
                    ? `  sold ${this.sold} (${fmtXph(soldPh)}/hr)`
                    : ''),
            `bait ${baitCount()}  bank ${this.bankTrips}` +
                (this.sellToHarry || this.sellTrips > 0 ? `  sells ${this.sellTrips}` : '') +
                `  Fish XP ${fmtXph(fishXph)}/hr` +
                (this.cookOnWay || cookXp > 0 ? `  Cook XP ${fmtXph(cookXph)}/hr` : '')
        ];

        ctx.font = PAINT_FONT;
        let maxW = 0;
        for (const line of lines) {
            maxW = Math.max(maxW, ctx.measureText(line).width);
        }
        const pad = 6;
        const lineH = 18;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, 6, maxW + pad * 2, pad * 2 + lines.length * lineH);
        ctx.fillStyle = '#9bc47a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Fishing',
    tags: ['fishing', 'catherby', 'bait', 'sardine', 'herring', 'bank', 'cook', 'harry'],
    description:
        "Benzyme's Catherby Bait Fisher — bait sardine/herring on Net+Bait spots only. Withdraws rod + all bait from bank. Optional cook on way; optional sell to Harry instead of banking.",
    settingsSchema: {
        cookOnWay: {
            type: 'boolean',
            default: true,
            label: 'Cook on way to bank',
            group: 'Cooking',
            help:
                'When the pack is full, cook Raw sardine/herring on the Catherby bank-house Range, drop burnt, then bank or sell to Harry'
        },
        sellToHarry: {
            type: 'boolean',
            default: false,
            label: 'Sell to Harry',
            group: 'Sell',
            help:
                'Sell Raw sardine/herring to Harry at the Catherby fishing shop instead of banking, then return to bait fishing. Cooked leftovers (if cook-on-way is on) still bank. Restocks rod + all bait from bank when needed.'
        }
    },
    create: () => new CatherbyBaitFisher()
});
