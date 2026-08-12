/**
 * SeersBowstringSpinner — withdraw Flax at Seers' Village bank, spin Bow string
 * upstairs at the spinning-wheel house south of the bank, deposit, repeat.
 * Requires Crafting 10+. Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('SeersBowstringSpinner: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `SeersBowstringSpinner: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Locs,
    Inventory,
    Bank,
    Banking,
    Traversal,
    Tile,
    Skills,
    ChatDialog,
    withdrawOp
} = abi;

const SCRIPT_NAME = 'SeersBowstringSpinner';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/** Crafting level required to spin Bow string. */
const BOWSTRING_LEVEL = 10;

/** Seers' Village bank (center of booths). */
const BANK_STAND = new Tile(2727, 3493, 0);

/**
 * Spinning-wheel house — south of the bank.
 * Door/stand outside, ladder on ground floor, wheel upstairs (level 1).
 * Ladder (2715,3470) dumps adjacent to the wheel — never path upstairs.
 */
const HOUSE_STAND = new Tile(2716, 3472, 0);
const LADDER_TILE = new Tile(2715, 3470, 0);
/** Clear tile east of the house — leave via here before banking (avoids door stall). */
const HOUSE_EXIT = new Tile(2721, 3475, 0);
const WHEEL_LOC = new Tile(2715, 3471, 1);
const HOUSE_LEASH = 10;

/**
 * True idle ticks (~0.6s each) with no flax/string progress and no anim
 * before we treat the spin as stalled. Spinning has long gaps between items.
 */
const SPIN_IDLE_TICKS = 60;

const FLAX_NAME = 'Flax';
const BOWSTRING_NAMES = ['Bow string', 'Bowstring'];

/**
 * Spin menu ("What would you like to spin?") shows Wool | Flax.
 * Right-click Flax → Make-X → 28 (full inventory).
 */
const SPIN_MENU_FLAX = 'Flax';
const SPIN_MAKE_X = 28;

function welcomeHost() {
    return globalThis.rs2b0t ?? null;
}

/** Ask the host runner to stop this script (same as the Stop button). */
function stopScript() {
    const host = welcomeHost();
    if (typeof host?.stopScript === 'function') {
        host.stopScript();
        return;
    }
    if (typeof host?.runner?.stop === 'function') {
        host.runner.stop();
    }
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

function isFlax(name) {
    return (name ?? '').toLowerCase() === 'flax';
}

function isBowstring(name) {
    const n = (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    return n === 'bow string' || n === 'bowstring';
}

function countMatching(pred) {
    return Inventory.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count ?? 1), 0);
}

function flaxCount() {
    return countMatching(isFlax);
}

function bowstringCount() {
    return countMatching(isBowstring);
}

function lastFlax() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        if (isFlax(items[i].name)) {
            return items[i];
        }
    }
    return null;
}

function playerFloor() {
    const t = Game.tile();
    return t ? (t.level ?? 0) : 0;
}

function nearHouseGround(tile) {
    if (!tile) {
        return false;
    }
    const t = Tile.from(tile);
    if ((t.level ?? 0) !== 0) {
        return false;
    }
    return t.distanceTo(HOUSE_STAND) <= HOUSE_LEASH || t.distanceTo(LADDER_TILE) <= HOUSE_LEASH;
}

/** Chebyshev distance on x/z only (ignore level mismatches from Tile helpers). */
function chebXZ(a, b) {
    if (!a || !b) {
        return 99;
    }
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/** Upstairs: ladder and wheel share a tiny room — interactable if within a few tiles. */
function upstairsNearWheel(tile) {
    if (!tile || (tile.level ?? 0) !== 1) {
        return false;
    }
    return chebXZ(tile, WHEEL_LOC) <= 4 || chebXZ(tile, LADDER_TILE) <= 4;
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

function climbUpOp(loc) {
    return (
        loc.actions().find(a => /^climb-up/i.test(a)) ??
        loc.actions().find(a => /^climb up/i.test(a)) ??
        loc.actions().find(a => /^climb$/i.test(a)) ??
        null
    );
}

function climbDownOp(loc) {
    return (
        loc.actions().find(a => /^climb-down/i.test(a)) ??
        loc.actions().find(a => /^climb down/i.test(a)) ??
        loc.actions().find(a => /^climb$/i.test(a)) ??
        null
    );
}

function spinOp(loc) {
    return (
        loc.actions().find(a => /^spin/i.test(a)) ??
        loc.actions().find(a => /spin/i.test(a)) ??
        null
    );
}

/** Match the green Flax option on the spinning-wheel make menu (not Wool). */
function matchFlaxSpinProduct(products) {
    if (!products || products.length === 0) {
        return null;
    }
    const exact = products.find(p => (p ?? '').trim().toLowerCase() === 'flax');
    if (exact) {
        return exact;
    }
    return products.find(p => /\bflax\b/i.test(p ?? '')) ?? null;
}

function bankItemCount(pred) {
    if (typeof Bank.items !== 'function') {
        return 0;
    }
    return Bank.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count ?? 1), 0);
}

function bankFlaxCount() {
    if (typeof Bank.count === 'function') {
        const n = Bank.count(FLAX_NAME);
        if (n > 0) {
            return n;
        }
    }
    return bankItemCount(isFlax);
}

function bankFindFlax() {
    if (typeof Bank.count === 'function' && (Bank.count(FLAX_NAME) || 0) > 0) {
        return FLAX_NAME;
    }
    const hit = (typeof Bank.items === 'function' ? Bank.items() : []).find(i => isFlax(i.name));
    return hit?.name ?? null;
}

async function waitBankLoaded() {
    if (typeof Bank.loaded === 'function') {
        await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
    }
    await Execution.delayTicks(1);
}

/**
 * Withdraw flax from an open bank.
 * Tries withdrawX, then Bank.withdraw with Withdraw-All / Withdraw-1.
 */
async function withdrawFlaxFromOpenBank(qty) {
    if (qty <= 0 || !Bank.isOpen()) {
        return false;
    }
    const name = bankFindFlax();
    if (!name) {
        return false;
    }
    const bankItem =
        (typeof Bank.items === 'function'
            ? Bank.items().find(i => isFlax(i.name))
            : null) ?? null;

    if (typeof Bank.withdrawX === 'function') {
        if (await Bank.withdrawX(name, qty)) {
            return true;
        }
    }

    if (typeof Bank.withdraw === 'function') {
        const wantAll = qty >= 5 || (bankItem && Math.max(1, bankItem.count) <= qty);
        const hint = wantAll ? 'all' : '1';
        const op =
            (typeof withdrawOp === 'function' && bankItem?.ops
                ? withdrawOp(bankItem.ops, hint)
                : null) ?? (wantAll ? 'Withdraw-All' : 'Withdraw-1');
        if (await Bank.withdraw(name, op)) {
            return true;
        }
        if (await Bank.withdraw(name)) {
            return true;
        }
    }

    return false;
}

class SeersBowstringSpinner extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    craftXpAtStart = 0;
    spun = 0;
    bankTrips = 0;
    done = false;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        if (typeof Banking?.preload === 'function') {
            Banking.preload();
        }

        this.startedAt = Date.now();
        this.craftXpAtStart = Skills.xp('crafting');
        this.spun = 0;
        this.bankTrips = 0;
        this.done = false;

        this.on('skill.level', e => {
            if (e.name === 'crafting') {
                this.log(`crafting ${e.previous} → ${e.level}`);
            }
        });

        const craft = Skills.level('crafting');
        this.log(
            `SeersBowstringSpinner — Crafting ${craft}; bank @ ${BANK_STAND.x},${BANK_STAND.z} ` +
                `→ wheel upstairs @ ${WHEEL_LOC.x},${WHEEL_LOC.z},1`
        );

        if (craft < BOWSTRING_LEVEL) {
            this.finishDone(
                `need Crafting ${BOWSTRING_LEVEL}+ to spin Bow string (you have ${craft})`
            );
            return;
        }

        this.status = 'ready';
    }

    finishDone(reason) {
        this.done = true;
        this.status = 'done';
        this.log(reason);
        stopScript();
    }

    noteSpun(beforeStrings) {
        const now = bowstringCount();
        if (now > beforeStrings) {
            const gained = now - beforeStrings;
            this.spun += gained;
            return gained;
        }
        return 0;
    }

    onStop() {
        this.log(
            `stopped — spun ~${this.spun}, bank trips ${this.bankTrips} (${this.status})`
        );
    }

    async loop() {
        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }
        if (this.done) {
            await Execution.delayTicks(5);
            return;
        }
        if (await dismissWelcomeScreen()) {
            this.status = 'close welcome';
            return;
        }

        if (Bank.isOpen() && flaxCount() > 0 && bowstringCount() === 0) {
            await Bank.close();
            return;
        }

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseSpinProduct();
            return;
        }

        // Still have flax → spin.
        if (flaxCount() > 0) {
            await this.spinLoad();
            return;
        }

        // Done spinning this load (or empty) — bank bowstrings / withdraw flax.
        await this.bankCycle();
    }

    findWheel() {
        return (
            Locs.query()
                .name('Spinning wheel', 'Spinning Wheel')
                .where(l => {
                    const t = l.tile();
                    return (t.level ?? 0) === 1 && Tile.from(t).distanceTo(WHEEL_LOC) <= HOUSE_LEASH;
                })
                .nearest() ??
            Locs.query()
                .name('Spinning wheel', 'Spinning Wheel')
                .where(l => (l.tile().level ?? 0) === 1)
                .nearest() ??
            Locs.query().name('Spinning wheel', 'Spinning Wheel').nearest()
        );
    }

    findLadder(wantFloor) {
        return (
            Locs.query()
                .name('Ladder')
                .where(l => {
                    const t = l.tile();
                    if ((t.level ?? 0) !== wantFloor) {
                        return false;
                    }
                    return chebXZ(t, LADDER_TILE) <= HOUSE_LEASH;
                })
                .nearest() ??
            Locs.query()
                .name('Ladder')
                .where(l => (l.tile().level ?? 0) === wantFloor)
                .where(l => l.distance() <= 12)
                .nearest()
        );
    }

    async openNearbyDoor() {
        const door =
            Locs.query()
                .where(l => isShutDoor(l))
                .where(l => {
                    const t = l.tile();
                    return (
                        (t.level ?? 0) === 0 &&
                        Tile.from(t).distanceTo(HOUSE_STAND) <= HOUSE_LEASH
                    );
                })
                .nearest() ??
            Locs.query()
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

    async climbUp() {
        const before = playerFloor();
        if (before >= 1) {
            return true;
        }
        let ladder = this.findLadder(0);
        if (!ladder) {
            await Traversal.walkTo(LADDER_TILE, { radius: 1, timeoutMs: 10_000 });
            await this.openNearbyDoor();
            ladder = this.findLadder(0);
        }
        if (!ladder) {
            this.log('WARNING: no Ladder on ground floor');
            return false;
        }
        const op = climbUpOp(ladder);
        if (!op) {
            this.log(`Ladder has no Climb-up: [${ladder.actions().join(', ')}]`);
            return false;
        }
        this.status = 'climbing up';
        this.log(`Climb-up Ladder @ ${ladder.tile().x},${ladder.tile().z}`);
        await ladder.interact(op);
        const ok = await Execution.delayUntil(() => playerFloor() > before, 8000);
        if (!ok) {
            this.log('climb up did not finish — retrying');
            return false;
        }
        // Let upstairs locs load — wheel is adjacent to the ladder, no walk.
        await Execution.delayTicks(1);
        return playerFloor() >= 1;
    }

    async climbDown() {
        const before = playerFloor();
        if (before <= 0) {
            return true;
        }
        // Never path upstairs — ladder is where we came up.
        const ladder = this.findLadder(1);
        if (!ladder) {
            this.log('WARNING: no Ladder upstairs');
            return false;
        }
        const op = climbDownOp(ladder);
        if (!op) {
            this.log(`Ladder has no Climb-down: [${ladder.actions().join(', ')}]`);
            return false;
        }
        this.status = 'climbing down';
        this.log(`Climb-down Ladder @ ${ladder.tile().x},${ladder.tile().z}`);
        await ladder.interact(op);
        const ok = await Execution.delayUntil(() => playerFloor() < before, 8000);
        if (!ok) {
            this.log('climb down did not finish — retrying');
        }
        return playerFloor() === 0;
    }

    async walkToHouse() {
        this.status = 'walking to house';
        this.log(`walking to spinning-wheel house ${HOUSE_STAND.x},${HOUSE_STAND.z}`);
        await Traversal.walkResilient(HOUSE_STAND, {
            radius: 1,
            log: m => this.log(`  ${m}`)
        });
        await this.openNearbyDoor();
        const here = Game.tile();
        if (here && Tile.from(here).distanceTo(LADDER_TILE) > 2) {
            await Traversal.walkTo(LADDER_TILE, { radius: 1, timeoutMs: 10_000 });
            await this.openNearbyDoor();
        }
    }

    /**
     * Get upstairs next to the wheel. Once on floor 1, never call Traversal —
     * the ladder dumps adjacent to the spinning wheel.
     */
    async ensureAtWheel() {
        if (playerFloor() >= 1) {
            const here = Game.tile();
            if (this.findWheel() || upstairsNearWheel(here)) {
                return true;
            }
            // Still upstairs but wheel not queried yet — wait one tick, no walk.
            await Execution.delayTicks(1);
            return !!this.findWheel() || upstairsNearWheel(Game.tile());
        }

        const here = Game.tile();
        if (!here || !nearHouseGround(here)) {
            await this.walkToHouse();
        } else {
            await this.openNearbyDoor();
        }

        if (!(await this.climbUp())) {
            await this.walkToHouse();
            if (!(await this.climbUp())) {
                return false;
            }
        }

        // Floor 1: ready. No upstairs walkTo.
        return playerFloor() >= 1 && (!!this.findWheel() || upstairsNearWheel(Game.tile()));
    }

    async ensureOnGround() {
        if (playerFloor() <= 0) {
            return true;
        }
        return await this.climbDown();
    }

    /** Right-click Flax → Make-X → 28. Does not wait for the batch to finish. */
    async pickFlaxMakeX() {
        const products = ChatDialog.makeProducts();
        const hint = matchFlaxSpinProduct(products) ?? SPIN_MENU_FLAX;
        const batch = SPIN_MAKE_X;
        this.status = 'spin make-menu';
        this.log(
            `spin menu: [${products.join(', ')}] → right-click '${hint}' Make-X ${batch}` +
                ` (craft ${Skills.level('crafting')}, flax ${flaxCount()})`
        );

        let picked = false;
        if (typeof ChatDialog.makeX === 'function') {
            picked = await ChatDialog.makeX(hint, batch);
        }
        if (!picked && typeof ChatDialog.makeX === 'function' && hint !== SPIN_MENU_FLAX) {
            picked = await ChatDialog.makeX(SPIN_MENU_FLAX, batch);
        }
        if (!picked) {
            this.log(`could not right-click '${hint}' Make-X ${batch} — retrying`);
            return false;
        }
        await Execution.delayUntil(() => !ChatDialog.isMakeMenu(), 4000);
        return true;
    }

    /**
     * Stay put upstairs until flax is gone. Do not re-click the wheel or walk.
     * If the make menu is open, always pick Flax Make-X immediately (never stall on it).
     */
    async waitSpinningDone() {
        this.status = 'spinning flax';
        let stringMark = bowstringCount();
        let flaxMark = flaxCount();
        let idle = 0;

        for (let guard = 0; guard < 900 && flaxCount() > 0; guard++) {
            if (ChatDialog.canContinue()) {
                await ChatDialog.continue();
                idle = 0;
                continue;
            }

            // Menu open = must pick Flax Make-X now (do not wait for idle — that deadlocks).
            if (ChatDialog.isMakeMenu()) {
                if (!(await this.pickFlaxMakeX())) {
                    await Execution.delayTicks(2);
                }
                idle = 0;
                flaxMark = flaxCount();
                continue;
            }

            await Execution.delayTicks(1);

            const spunGain = this.noteSpun(stringMark);
            if (spunGain > 0) {
                stringMark = bowstringCount();
            }
            const nowFlax = flaxCount();
            if (nowFlax < flaxMark || spunGain > 0 || Game.animating()) {
                flaxMark = nowFlax;
                idle = 0;
                continue;
            }

            if (++idle >= SPIN_IDLE_TICKS) {
                this.log(`spin idle ${SPIN_IDLE_TICKS}t with ${nowFlax} flax left — will re-click wheel`);
                break;
            }
        }
        this.noteSpun(stringMark);
    }

    async chooseSpinProduct() {
        if (!(await this.pickFlaxMakeX())) {
            await Execution.delayTicks(1);
            return;
        }
        await this.waitSpinningDone();
    }

    async spinLoad() {
        if (flaxCount() === 0) {
            return;
        }

        // Make menu already up — pick Flax Make-X 28 immediately.
        if (ChatDialog.isMakeMenu()) {
            await this.chooseSpinProduct();
            return;
        }
        // Mid-batch: keep waiting (menu may still pop; waitSpinningDone handles it).
        if (Game.animating() && playerFloor() >= 1 && flaxCount() > 0) {
            await this.waitSpinningDone();
            return;
        }

        if (!(await this.ensureAtWheel())) {
            this.log('could not reach spinning wheel — retrying');
            await Execution.delayTicks(2);
            return;
        }

        const wheel = this.findWheel();
        if (!wheel) {
            // Upstairs but wheel query missed a tick — click after a beat, no walk.
            await Execution.delayTicks(1);
            const again = this.findWheel();
            if (!again) {
                this.log('WARNING: Spinning wheel not found upstairs');
                await Execution.delayTicks(2);
                return;
            }
            return await this.clickWheelAndSpin(again);
        }

        await this.clickWheelAndSpin(wheel);
    }

    async clickWheelAndSpin(wheel) {
        const flax = lastFlax();
        if (!flax) {
            return;
        }

        const beforeFlax = flaxCount();
        const beforeXp = Skills.xp('crafting');
        this.status = 'spinning flax';
        this.log(
            `spin ${beforeFlax} Flax on ${wheel.name ?? 'Spinning wheel'} ` +
                `(craft ${Skills.level('crafting')})`
        );

        const op = spinOp(wheel);
        let startedClick = false;
        if (op) {
            startedClick = await wheel.interact(op);
        }
        if (!startedClick) {
            if (!(await flax.useOn(wheel))) {
                await Execution.delayTicks(2);
                return;
            }
        }

        // Wait for the Wool/Flax make menu — do NOT treat walk/click anim as "started".
        const menuUp = await Execution.delayUntil(
            () =>
                ChatDialog.isMakeMenu() ||
                flaxCount() < beforeFlax ||
                Skills.xp('crafting') > beforeXp ||
                ChatDialog.canContinue(),
            8000
        );

        if (ChatDialog.isMakeMenu()) {
            await this.chooseSpinProduct();
            return;
        }

        if (flaxCount() < beforeFlax || Skills.xp('crafting') > beforeXp) {
            await this.waitSpinningDone();
            return;
        }

        if (!menuUp) {
            this.log('spin menu did not open — will re-click wheel (no walk)');
            await Execution.delayTicks(2);
            return;
        }

        await this.waitSpinningDone();
    }

    /**
     * Climb down if needed, leave the house via a clear tile, then bank.
     * Stops when the bank has no flax left.
     */
    async bankCycle() {
        if (!(await this.ensureOnGround())) {
            this.log('still upstairs — cannot bank yet');
            await Execution.delayTicks(2);
            return;
        }

        // Step clear of the doorway before banking — avoids door/ladder stall recoveries.
        const here = Game.tile();
        if (here && nearHouseGround(here) && Tile.from(here).distanceTo(HOUSE_EXIT) > 2) {
            this.status = 'leaving house';
            this.log(`leaving house via ${HOUSE_EXIT.x},${HOUSE_EXIT.z}`);
            await Traversal.walkTo(HOUSE_EXIT, { radius: 1, timeoutMs: 10_000 });
        }

        this.status = 'banking';
        const heldStrings = bowstringCount();
        const heldFlax = flaxCount();

        if (!Bank.isOpen()) {
            this.log(
                `opening Seers bank` +
                    (heldStrings ? ` (deposit ${heldStrings} Bow string)` : '') +
                    (heldFlax ? ` + ${heldFlax} Flax` : '')
            );
            if (
                !(await Banking.open({
                    stand: BANK_STAND,
                    log: m => this.log(`  ${m}`)
                }))
            ) {
                this.log('could not open bank — retrying');
                await Execution.delayTicks(3);
                return;
            }
        }

        await waitBankLoaded();

        if (Inventory.used() > 0) {
            this.log('depositing inventory');
            if (typeof Bank.depositInventory === 'function') {
                await Bank.depositInventory();
            } else if (typeof Bank.depositAllMatching === 'function') {
                await Bank.depositAllMatching(() => true);
            } else {
                for (const name of BOWSTRING_NAMES) {
                    if (typeof Bank.deposit === 'function') {
                        await Bank.deposit(name, 'Deposit-All');
                    }
                }
                if (typeof Bank.deposit === 'function') {
                    await Bank.deposit(FLAX_NAME, 'Deposit-All');
                }
            }
            await Execution.delayTicks(1);
        }

        this.bankTrips++;

        const free = typeof Inventory.free === 'function' ? Inventory.free() : 28;
        if (free <= 0) {
            this.log('inventory still full after deposit — retrying');
            await Execution.delayTicks(2);
            return;
        }

        const inBank = bankFlaxCount();
        if (inBank <= 0) {
            await Bank.close();
            this.finishDone('done — no Flax left in Seers bank');
            return;
        }

        const take = Math.min(free, inBank);
        this.log(`withdrawing ${take}× Flax (bank has ${inBank})`);
        if (!(await withdrawFlaxFromOpenBank(take))) {
            await Bank.close();
            this.finishDone('done — could not withdraw Flax from bank');
            return;
        }
        await Execution.delayTicks(1);

        // Fill remaining free slots if withdraw took a partial stack.
        const stillFree =
            typeof Inventory.free === 'function' ? Inventory.free() : Math.max(0, 28 - Inventory.used());
        const stillBank = bankFlaxCount();
        if (stillFree > 0 && stillBank > 0 && flaxCount() < take) {
            await withdrawFlaxFromOpenBank(Math.min(stillFree, stillBank));
            await Execution.delayTicks(1);
        }

        await Bank.close();

        if (flaxCount() <= 0) {
            this.finishDone('done — withdraw reported ok but no Flax in inventory');
            return;
        }

        this.status = 'walking to house';
        this.log(`withdrew ${flaxCount()} Flax — heading to spinning wheel`);
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const craftXp = Skills.xp('crafting') - this.craftXpAtStart;
        const craftXph = hrs > 0.008 ? craftXp / hrs : 0;
        const spunPh = hrs > 0.008 ? this.spun / hrs : 0;

        const lines = [
            `Benzyme's Seers Spinner  Craft ${Skills.level('crafting')}`,
            `time ${fmtElapsed(elapsed)}  ·  floor ${playerFloor()}  ·  ${this.status}`,
            `spun ${this.spun} (${fmtXph(spunPh)}/hr)  trips ${this.bankTrips}`,
            `flax ${flaxCount()}  strings ${bowstringCount()}  Craft XP ${fmtXph(craftXph)}/hr`
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
    version: '1.1.1',
    category: 'Crafting',
    tags: ['crafting', 'flax', 'bowstring', 'spinning', 'seers', 'bank'],
    description:
        "Benzyme's Seers Bowstring Spinner — withdraws Flax from Seers' Village bank, climbs upstairs in the house south of the bank, spins Bow string on the spinning wheel, banks, and repeats. Needs Crafting 10+.",
    create: () => new SeersBowstringSpinner()
});
