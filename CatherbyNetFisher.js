/**
 * CatherbyNetFisher — small-net shrimp at Catherby (Net+Bait spots only).
 * Optional cook on the bank-house Range on the way to the bank, then bank + return.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('CatherbyNetFisher: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `CatherbyNetFisher: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    Traversal,
    Tile,
    Skills,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'CatherbyNetFisher';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/**
 * Dismiss "Welcome to RuneScape" / message-centre modal via Close Window.
 * Uses host reader/actions when available (rs2b0t load-local).
 * @returns {Promise<boolean>} true if we closed it
 */
async function dismissWelcomeScreen() {
    const host = globalThis.rs2b0t;
    if (!host?.reader || !host?.actions) {
        return false;
    }
    const { reader, actions } = host;
    const main = typeof reader.modals === 'function' ? reader.modals().main : -1;
    if (main === -1) {
        return false;
    }
    let isWelcome = main === WELCOME_SCREEN_ID;
    if (!isWelcome && typeof reader.mainModalTexts === 'function') {
        const texts = reader.mainModalTexts();
        isWelcome = texts.some(
            t =>
                /welcome to runescape/i.test(t) ||
                /unread messages/i.test(t) ||
                /jagex staff will never email/i.test(t)
        );
    }
    if (!isWelcome) {
        return false;
    }
    // Prefer real Close Window click (BUTTON_CLOSE → CLOSE_MODAL).
    if (typeof actions.closeModal === 'function' && actions.closeModal()) {
        await Execution.delay(250);
        return true;
    }
    if (typeof actions.closeMainModal === 'function' && actions.closeMainModal(main)) {
        await Execution.delay(250);
        return true;
    }
    if (typeof reader.buttonByText === 'function' && typeof actions.ifButton === 'function') {
        let btn = reader.buttonByText(main, 'Close Window');
        if (btn === -1) {
            btn = reader.buttonByText(main, 'Close');
        }
        if (btn !== -1 && actions.ifButton(btn)) {
            await Execution.delay(250);
            return true;
        }
    }
    return false;
}

/** Catherby shore stand (pathable). */
const ANCHOR = new Tile(2845, 3431, 0);
const LEASH = 35;
const STAND_RADIUS = 8;

/** Catherby bank. */
const BANK_STAND = new Tile(2809, 3441, 0);

/** Bank-house Range — between pier and bank. */
const RANGE_STAND = new Tile(2817, 3443, 0);
const RANGE_LOC = new Tile(2817, 3444, 0);
const RANGE_LEASH = 8;

const NET_NAME = 'Small fishing net';
const SPOT_NAME = 'Fishing spot';

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

const PAINT_FONT_ID = 'benzyme-catherby-font-v3';
const PAINT_FONT = '13px Exo, "Bebas Neue", "Bitcount Ink", sans-serif';

/** Load Exo (+ Bebas Neue / Bitcount Ink) from Google Fonts onto the bot page (once). */
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

function isKeepTool(name) {
    if (!name) {
        return false;
    }
    return (name ?? '').toLowerCase().includes('fishing net');
}

function isRawShrimpFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    if (!n.startsWith('raw ')) {
        return false;
    }
    return n.includes('shrimp') || n.includes('anchov');
}

function isCookedShrimpFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase().trim();
    if (n.startsWith('raw ') || n.startsWith('burnt ')) {
        return false;
    }
    return n === 'shrimps' || n === 'shrimp' || n === 'anchovies' || n === 'anchovy';
}

function isBurntFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    return n.startsWith('burnt ') || n === 'burnt fish';
}

function isBankableFish(name) {
    return isRawShrimpFish(name) || isCookedShrimpFish(name) || isBurntFish(name);
}

/**
 * Cooking level to cook each raw (not fishing level).
 * Anchovies: Fishing 15 to catch, Cooking 1 to cook. Shrimp: Fishing 1 / Cooking 1.
 */
const COOK_LEVEL = {
    shrimp: 1,
    anchovy: 1
};

function fishKind(name) {
    const n = (name ?? '').toLowerCase();
    if (n.includes('anchov')) {
        return 'anchovy';
    }
    if (n.includes('shrimp')) {
        return 'shrimp';
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
    return countMatching(isRawShrimpFish);
}

/** Raw shrimp/anchovies the player is high enough Cooking to cook. */
function cookableCount() {
    return countMatching(n => isRawShrimpFish(n) && canCookRaw(n));
}

function cookedFishCount() {
    return countMatching(isCookedShrimpFish);
}

function burntCount() {
    return countMatching(isBurntFish);
}

function lastCookableRaw() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        const name = items[i].name;
        if (isRawShrimpFish(name) && canCookRaw(name)) {
            return items[i];
        }
    }
    return null;
}

function countCookableNamed(fragment) {
    const want = fragment.toLowerCase();
    return countMatching(
        n => isRawShrimpFish(n) && canCookRaw(n) && (n ?? '').toLowerCase().includes(want)
    );
}

/** Pick make-menu product for a raw we can cook (prefer the item just used on the range). */
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
        const soft = products.find(p => (p ?? '').toLowerCase().includes(prefer.replace(/^raw\s+/, '')));
        if (soft) {
            return soft;
        }
    }
    for (const frag of ['anchov', 'shrimp']) {
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

function hasNet() {
    return Inventory.items().some(i => isKeepTool(i.name));
}

function netOp(actions) {
    return actions.find(a => /^net$/i.test(a)) ?? null;
}

function baitOp(actions) {
    return actions.find(a => /^bait$/i.test(a)) ?? null;
}

/** Shrimp hops only — Net + Bait (never Net + Harpoon). */
function isShrimpNetSpot(actions) {
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

function isNetGroundName(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    return n.includes('fishing net') || n === 'small net';
}

class CatherbyNetFisher extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    fishXpAtStart = 0;
    cookXpAtStart = 0;
    /** Total raw fish caught this session. */
    caught = 0;
    /** Total successfully cooked fish this session (not burnt). */
    cooked = 0;
    bankTrips = 0;
    /** Preference: cook on Range before banking. */
    cookOnWay = true;
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
        this.bankTrips = 0;
        this.cookingLoad = false;
        this.lastRawSeen = rawFishCount();

        this.on('skill.level', e => {
            if (e.name === 'fishing' || e.name === 'cooking') {
                this.log(`${e.name} ${e.previous} → ${e.level}`);
            }
        });

        this.log(
            `CatherbyNetFisher @ ${ANCHOR.x},${ANCHOR.z} — Net+Bait shrimp only; ` +
                `cook on way to bank: ${this.cookOnWay ? 'on' : 'off'}`
        );
        if (!hasNet()) {
            this.log('WARNING: no Small fishing net in inventory');
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
            `stopped — caught ${this.caught}, cooked ${this.cooked}, bank trips ${this.bankTrips} (${this.status})`
        );
    }

    syncPrefs({ silent = false } = {}) {
        const prev = this.cookOnWay;
        this.cookOnWay = readPrefBool(
            'cookOnWay',
            this.settings.bool('cookOnWay', true)
        );
        if (!silent && prev !== this.cookOnWay) {
            this.log(`prefs: cook on way to bank → ${this.cookOnWay ? 'on' : 'off'}`);
        }
    }

    noteCatches() {
        const now = rawFishCount();
        if (now > this.lastRawSeen) {
            this.caught += now - this.lastRawSeen;
        }
        this.lastRawSeen = now;
    }

    /** Credit newly appearing cooked fish only. */
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

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
            if (cookableCount() === 0 && (cookedFishCount() > 0 || burntCount() > 0 || rawFishCount() > 0)) {
                if (burntCount() > 0) {
                    await this.dropBurnt();
                }
                this.cookingLoad = false;
                await this.bankAndReturn();
            }
            return;
        }

        if (!hasNet()) {
            this.status = 'need net';
            if (await this.lootNetFromGround()) {
                this.log('looted Small fishing net');
                return;
            }
            this.log('no Small fishing net — withdraw one, then continue');
            await Execution.delayTicks(8);
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
            if (cookedFishCount() > 0 || burntCount() > 0 || rawFishCount() > 0) {
                await this.bankAndReturn();
            }
            return;
        }

        if (Inventory.isFull()) {
            if (this.cookOnWay && cookableCount() > 0) {
                this.cookingLoad = true;
                this.log(
                    `full inv (${cookableCount()} cookable / ${rawFishCount()} raw) — cooking on way to bank`
                );
                await this.cookLoad();
                return;
            }
            if (rawFishCount() > 0 || cookedFishCount() > 0) {
                await this.bankAndReturn();
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

        const spot = this.findShrimpSpot();
        if (!spot) {
            this.status = 'waiting for Net+Bait spot';
            if (Tile.from(here).distanceTo(ANCHOR) > STAND_RADIUS) {
                await Traversal.walkTo(ANCHOR, { radius: 2, timeoutMs: 12_000 });
            }
            await Execution.delayTicks(3);
            return;
        }

        await this.netSpot(spot);
    }

    findShrimpSpot() {
        return Npcs.query()
            .name(SPOT_NAME)
            .where(n => isShrimpNetSpot(n.actions()))
            .where(n => Tile.from(n.tile()).distanceTo(ANCHOR) <= LEASH)
            .nearest();
    }

    async netSpot(spot) {
        const op = netOp(spot.actions());
        if (!op) {
            await Execution.delayTicks(2);
            return;
        }

        const before = rawFishCount();
        const st = spot.tile();
        this.status = `netting (${spot.distance()}t)`;
        this.log(`Net shrimp spot @ ${st.x},${st.z}`);
        await spot.interact(op);

        await Execution.delayUntil(
            () =>
                rawFishCount() > before ||
                Game.animating() ||
                ChatDialog.canContinue() ||
                !this.findShrimpSpot(),
            8000
        );
        this.noteCatches();
    }

    async lootNetFromGround() {
        if (hasNet()) {
            return true;
        }
        const ground =
            GroundItems.query().name(NET_NAME).within(12).nearest() ??
            GroundItems.query()
                .where(g => isNetGroundName(g.name))
                .within(12)
                .nearest();
        if (!ground) {
            return false;
        }
        const before = Inventory.used();
        await ground.interact('Take');
        return (
            (await Execution.delayUntil(() => hasNet() || Inventory.used() > before, 6000)) &&
            hasNet()
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
        this.log(`walking to Range ${RANGE_STAND.x},${RANGE_STAND.z} (on way to bank)`);
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
        const frag = kind === 'anchovy' ? 'anchov' : kind === 'shrimp' ? 'shrimp' : null;
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
            this.log('WARNING: no Range near bank house — banking raw instead');
            this.cookingLoad = false;
            await this.bankAndReturn();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
            if (cookableCount() === 0) {
                if (burntCount() > 0) {
                    await this.dropBurnt();
                }
                this.cookingLoad = false;
                await this.bankAndReturn();
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
                await this.bankAndReturn();
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
        // Finish current batch; if another cookable type remains (e.g. anchovies after shrimp), loop continues.
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
            await this.bankAndReturn();
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

    async bankAndReturn() {
        const raw = rawFishCount();
        const cooked = cookedFishCount();
        this.status = 'banking';
        this.log(
            `banking` +
                (raw ? ` ${raw} raw` : '') +
                (cooked ? ` ${cooked} cooked` : '') +
                (burntCount() ? ` ${burntCount()} burnt` : '')
        );

        // After banking raw, lastRawSeen must not credit re-withdraws as new catches.
        this.lastRawSeen = 0;

        await Banking.bankNearest({
            destination: { name: 'Catherby', tile: BANK_STAND },
            deposit: name => {
                if (isKeepTool(name)) {
                    return false;
                }
                return isBankableFish(name);
            },
            returnTo: ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.cookingLoad = false;
        this.lastRawSeen = rawFishCount();
        this.status = 'returning to shore';
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

        const lines = [
            `Benzyme's Catherby Fisher  Fish ${Skills.level('fishing')}  Cook ${Skills.level('cooking')}`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.cookOnWay ? 'cook→bank' : 'bank raw'}  ·  ${this.status}`,
            `caught ${this.caught} (${fmtXph(caughtPh)}/hr)  cooked ${this.cooked} (${fmtXph(cookedPh)}/hr)`,
            `trips ${this.bankTrips}  raw ${rawFishCount()}  Fish XP ${fmtXph(fishXph)}/hr` +
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
        ctx.fillStyle = '#7eb8da';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '2.0.0',
    category: 'Fishing',
    tags: ['fishing', 'catherby', 'net', 'shrimp', 'bank', 'cook'],
    description:
        "Benzyme's Catherby Fisher — small-net shrimp at Net+Bait spots only. Optional cook on bank-house Range on the way to bank. Shows total caught/cooked and per-hour rates.",
    settingsSchema: {
        cookOnWay: {
            type: 'boolean',
            default: true,
            label: 'Cook on way to bank',
            group: 'Cooking',
            help:
                'When the pack is full, cook Raw shrimps/anchovies on the Catherby bank-house Range, drop burnt, then bank and return to the shore'
        }
    },
    create: () => new CatherbyNetFisher()
});
