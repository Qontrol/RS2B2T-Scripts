/**
 * SeersFlaxPicker — pick Flax at the Seers' Village field, bank at Catherby via beehives.
 * Start: empty inventory + unequip everything. Route flax ↔ bank through the apiary;
 * open/keep the beehive gate open. Each bank trip deposits the entire inventory + unequips.
 * Optional Mule mode: pick/bank until flax threshold, trade noted to Zorpix, resume picking.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('SeersFlaxPicker: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `SeersFlaxPicker: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Locs,
    Players,
    Inventory,
    Equipment,
    Bank,
    Banking,
    Traversal,
    Tile,
    ChatDialog,
    Trade,
    withdrawOp
} = abi;

const SCRIPT_NAME = 'SeersFlaxPicker';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/** Mule partner — receive noted flax and stop. */
const MULE_NAME = 'Zorpix';
const MULE_TRADE_RANGE = 2;
const MULE_TRADE_REQUEST_MS = 5_000;
/** Pause before first Accept on each trade screen (offer + confirm). */
const MULE_ACCEPT_WAIT_MIN_MS = 5_000;
const MULE_ACCEPT_WAIT_MAX_MS = 10_000;
/** While waiting on a partner, re-click Accept this often if the button is still up. */
const MULE_ACCEPT_RETRY_MS = 3_000;

function muleAcceptDelayMs() {
    return (
        MULE_ACCEPT_WAIT_MIN_MS +
        Math.floor(Math.random() * (MULE_ACCEPT_WAIT_MAX_MS - MULE_ACCEPT_WAIT_MIN_MS + 1))
    );
}

function welcomeHost() {
    return globalThis.rs2b0t ?? null;
}

function isPanelPaused() {
    return !!document.querySelector('.rs2b0t-value.rs2b0t-state-paused');
}

/**
 * Host disables Edit parameters while running *or* paused. Re-enable while
 * paused so Mule / threshold can be changed without stopping the script.
 */
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

/** Seers' Village flax field (west of beehives). */
const ANCHOR = new Tile(2739, 3444, 0);
const LEASH = 22;
const STAND_RADIUS = 8;

/** Beehives / apiary — forced waypoint between flax and Catherby. */
const BEEHIVES = new Tile(2759, 3442, 0);

/** Apiary gate (bucket spawn beside it) — open and keep open. */
const BEEHIVE_GATE = new Tile(2761, 3443, 0);
const GATE_RADIUS = 8;

/** Catherby bank. */
const BANK_STAND = new Tile(2809, 3441, 0);

const FLAX_NAME = 'Flax';

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

/** Try ObjType.certtemplate when the client exposes it (true = bank note). */
function certIsNote(id) {
    try {
        const OT =
            globalThis.ObjType ??
            globalThis.__rs2b0t?.ObjType ??
            globalThis.__client?.ObjType ??
            null;
        if (!OT || typeof OT.list !== 'function') {
            return null;
        }
        const t = OT.list(id);
        if (!t) {
            return null;
        }
        return typeof t.certtemplate === 'number' && t.certtemplate !== -1;
    } catch {
        return null;
    }
}

/**
 * Noted flax detection: certtemplate when available; else stack count > 1
 * (raw flax is non-stackable, so notes are the only stacked flax).
 */
function isNotedFlaxItem(item) {
    if (!item || !isFlax(item.name)) {
        return false;
    }
    const cert = certIsNote(item.id);
    if (cert === true) {
        return true;
    }
    if (cert === false) {
        return false;
    }
    return Math.max(1, item.count) > 1;
}

function isUnnotedFlaxItem(item) {
    return !!item && isFlax(item.name) && !isNotedFlaxItem(item);
}

/** depositAllMatching predicate: unnoted flax only (never notes). */
function isUnnotedFlaxDeposit(name, id) {
    if (!isFlax(name)) {
        return false;
    }
    const cert = certIsNote(id);
    if (cert === true) {
        return false;
    }
    if (cert === false) {
        return true;
    }
    const inv = Inventory.items().filter(i => i.id === id && isFlax(i.name));
    if (inv.some(i => Math.max(1, i.count) > 1)) {
        return false;
    }
    return inv.length > 0;
}

function unnotedFlaxCount() {
    return Inventory.items()
        .filter(isUnnotedFlaxItem)
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function notedFlaxCount() {
    return Inventory.items()
        .filter(isNotedFlaxItem)
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function flaxCount() {
    return Inventory.items()
        .filter(i => isFlax(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function nothingEquipped() {
    return Equipment.items().every(i => !i.name);
}

function inventoryEmpty() {
    return Inventory.used() <= 0;
}

/** Ready to pick: empty pack, nothing worn. */
function startClean() {
    return inventoryEmpty() && nothingEquipped();
}

function pickOp(actions) {
    return actions.find(a => /^pick$/i.test(a)) ?? null;
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

function isShutGate(loc) {
    const name = (loc.name ?? '').toLowerCase();
    if (!name.includes('gate')) {
        return false;
    }
    return loc.actions().some(a => /^open/i.test(a));
}

function stileOp(loc) {
    return (
        loc.actions().find(a => /climb-over/i.test(a)) ??
        loc.actions().find(a => /climb/i.test(a)) ??
        null
    );
}

function isStile(loc) {
    const name = (loc.name ?? '').toLowerCase();
    return name.includes('stile') && stileOp(loc) !== null;
}

/** True when a flax↔Catherby trip should pass the apiary. */
function crossesBeehives(from, dest) {
    if (!from || !dest) {
        return false;
    }
    const lo = Math.min(from.x, dest.x);
    const hi = Math.max(from.x, dest.x);
    return lo < BEEHIVES.x && hi > BEEHIVES.x;
}

class SeersFlaxPicker extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    picked = 0;
    bankTrips = 0;
    lastFlaxSeen = 0;
    /** False until empty pack + nothing equipped, then at flax. */
    startReady = false;
    /** Mule: mid handoff (withdraw noted → trade Zorpix). */
    muleHandoffActive = false;
    /** Mule: noted flax withdrawn and ready to trade to Zorpix. */
    muleReadyToTrade = false;
    /** Mule: already printed the handoff plan line. */
    muleAnnounced = false;
    /**
     * Mule: cleared the apiary leg (stood at beehives / already east of them)
     * with the gate open — must happen before banking.
     */
    muleViaBeehivesDone = false;
    /** Earliest wall-clock time we may call Trade.request again. */
    nextMuleTradeRequestAtMs = 0;
    /** Last known bank flax count (for paint / threshold). */
    lastBankFlax = 0;
    /** Interval that re-enables Edit parameters while the panel is paused. */
    unlockTimer = null;

    muleWanted() {
        return this.settings?.bool('mule', false) ?? false;
    }

    /** Flax that must be in the bank before a Zorpix handoff (1–10000). */
    muleThreshold() {
        const n = this.settings?.num('muleThreshold', 1000) ?? 1000;
        return Math.max(1, Math.min(10_000, Math.floor(n)));
    }

    beginMuleHandoff({ alreadyAtBank = false } = {}) {
        this.muleHandoffActive = true;
        this.muleReadyToTrade = false;
        this.muleViaBeehivesDone = alreadyAtBank;
        this.muleAnnounced = false;
        this.nextMuleTradeRequestAtMs = 0;
        this.log(
            `mule: handoff to ${MULE_NAME} (threshold ${this.muleThreshold()})` +
                (alreadyAtBank ? ' — already at bank' : '')
        );
        this.status = 'mule: start handoff';
    }

    /** After a finished trade (or aborted handoff): clear flags and return to flax. */
    async resumePickingAfterMule(reason) {
        this.muleHandoffActive = false;
        this.muleReadyToTrade = false;
        this.muleViaBeehivesDone = false;
        this.muleAnnounced = false;
        this.lastBankFlax = 0;
        this.startReady = true;
        this.lastFlaxSeen = flaxCount();
        this.log(`mule: ${reason} — resuming flax pick`);
        this.status = 'returning to flax';
        await this.walkViaBeehives(ANCHOR, { radius: 4 });
    }

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.startedAt = Date.now();
        this.picked = 0;
        this.bankTrips = 0;
        this.lastFlaxSeen = flaxCount();
        this.startReady = false;
        this.muleHandoffActive = false;
        this.muleReadyToTrade = false;
        this.muleAnnounced = false;
        this.muleViaBeehivesDone = false;
        this.nextMuleTradeRequestAtMs = 0;
        this.lastBankFlax = 0;

        this.log(
            `SeersFlaxPicker @ ${ANCHOR.x},${ANCHOR.z} — via beehives ${BEEHIVES.x},${BEEHIVES.z}` +
                ` (gate ${BEEHIVE_GATE.x},${BEEHIVE_GATE.z}), bank Catherby ${BANK_STAND.x},${BANK_STAND.z}`
        );
        if (this.muleWanted()) {
            this.log(
                `mule on — pick/bank until ${this.muleThreshold()} flax in bank, then trade to ${MULE_NAME}, repeat`
            );
        } else if (startClean()) {
            this.log('already empty + unequipped — will walk to flax via beehives');
        } else {
            this.log('start: will empty inventory + unequip everything at Catherby bank');
        }
        this.log('tip: Pause → Edit parameters to change mule prefs without stopping');
        this.status = 'start';
        this.startPausedPrefUnlock();
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
            `stopped — picked ${this.picked}, bank trips ${this.bankTrips} (${this.status})`
        );
    }

    notePicks() {
        const now = flaxCount();
        if (now > this.lastFlaxSeen) {
            this.picked += now - this.lastFlaxSeen;
        }
        this.lastFlaxSeen = now;
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

        this.notePicks();
        unlockPausedPrefsUi();

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        // Mule handoff only when threshold was reached (otherwise keep picking).
        if (this.muleWanted() && this.muleHandoffActive) {
            await this.muleTick();
            return;
        }

        if (!this.startReady) {
            await this.ensureStartReady();
            return;
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        if (Inventory.isFull()) {
            await this.bankAndReturn();
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        // Keep apiary gate open whenever we're near it.
        if (Tile.from(here).distanceTo(BEEHIVE_GATE) <= GATE_RADIUS + 4) {
            await this.ensureBeehiveGateOpen();
        }

        if (Tile.from(here).distanceTo(ANCHOR) > LEASH) {
            this.status = 'returning to flax';
            this.log('walking back to flax via beehives');
            await this.walkViaBeehives(ANCHOR, { radius: 4 });
            return;
        }

        if (Game.animating()) {
            this.status = 'picking';
            await Execution.delayTicks(1);
            return;
        }

        const plant = this.findFlax();
        if (!plant) {
            this.status = 'waiting for flax';
            if (Tile.from(here).distanceTo(ANCHOR) > STAND_RADIUS) {
                await Traversal.walkTo(ANCHOR, { radius: 3, timeoutMs: 12_000 });
            }
            await Execution.delayTicks(2);
            return;
        }

        await this.pickFlax(plant);
    }

    /**
     * Before picking: empty pack + unequip all at Catherby (via beehives), then to flax.
     */
    async ensureStartReady() {
        if (!startClean()) {
            await this.prepStartEmpty();
            return;
        }

        const here = Game.tile();
        if (here && Tile.from(here).distanceTo(ANCHOR) > LEASH) {
            this.status = 'start: to flax';
            this.log('start clean — walking to flax via beehives');
            await this.walkViaBeehives(ANCHOR, { radius: 4 });
            return;
        }

        this.startReady = true;
        this.lastFlaxSeen = flaxCount();
        this.log('start ready — empty pack, nothing equipped');
        this.status = 'ready';
    }

    /**
     * Open Catherby bank via beehives → deposit all → unequip all → deposit again.
     * Leaves inventory empty and nothing equipped.
     */
    async prepStartEmpty() {
        this.status = 'start: bank';
        this.log('start: Catherby bank — deposit all, unequip all, leave empty');

        const here = Game.tile();
        if (!here || Tile.from(here).distanceTo(BANK_STAND) > 6) {
            await this.walkViaBeehives(BANK_STAND, { radius: 2 });
        }

        if (!Bank.isOpen()) {
            this.log('opening Catherby bank');
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

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
        }
        await Execution.delayTicks(1);

        await this.depositEverything();

        if (!(await this.unequipAll())) {
            await this.depositEverything();
            await this.unequipAll();
        }
        await this.depositEverything();

        if (!startClean()) {
            this.log('WARNING: start still holding/wearing items — retrying');
            await Execution.delayTicks(2);
            return;
        }

        const banked = this.bankFlaxCount();
        this.lastBankFlax = banked;
        this.bankTrips++;
        this.lastFlaxSeen = 0;

        if (this.muleWanted()) {
            const need = this.muleThreshold();
            this.log(`mule: bank flax ${banked}/${need}`);
            if (banked >= need) {
                this.startReady = true;
                this.beginMuleHandoff({ alreadyAtBank: true });
                return;
            }
        }

        if (Bank.isOpen()) {
            await Bank.close();
        }

        this.status = 'start: to flax';
        this.log('start bank done — walking to flax via beehives');
        await this.walkViaBeehives(ANCHOR, { radius: 4 });
    }

    findFlax() {
        return Locs.query()
            .name(FLAX_NAME)
            .where(l => pickOp(l.actions()) !== null)
            .where(l => Tile.from(l.tile()).distanceTo(ANCHOR) <= LEASH)
            .nearest();
    }

    async pickFlax(plant) {
        const op = pickOp(plant.actions());
        if (!op) {
            this.log(`Flax has no Pick action: [${plant.actions().join(', ')}]`);
            await Execution.delayTicks(2);
            return;
        }

        const before = flaxCount();
        const st = plant.tile();
        this.status = `picking (${plant.distance()}t)`;
        this.log(`Pick Flax @ ${st.x},${st.z}`);
        await plant.interact(op);

        await Execution.delayUntil(
            () =>
                flaxCount() > before ||
                Game.animating() ||
                ChatDialog.canContinue() ||
                Inventory.isFull(),
            5000
        );
        this.notePicks();

        // Flax is click-to-pick — wait briefly if an anim started so we don't spam.
        if (Game.animating()) {
            await Execution.delayUntil(
                () =>
                    flaxCount() > before ||
                    !Game.animating() ||
                    ChatDialog.canContinue() ||
                    Inventory.isFull(),
                4000
            );
            this.notePicks();
        }
    }

    findShutBeehiveGate() {
        const atPin =
            Locs.query()
                .where(l => isShutGate(l) || isShutDoor(l))
                .where(l => Tile.from(l.tile()).distanceTo(BEEHIVE_GATE) <= GATE_RADIUS)
                .nearest() ?? null;
        if (atPin) {
            return atPin;
        }

        return (
            Locs.query()
                .where(l => isShutGate(l))
                .where(l => Tile.from(l.tile()).distanceTo(BEEHIVES) <= 12)
                .nearest() ?? null
        );
    }

    /**
     * Open the apiary gate if shut. Never closes it.
     * @returns {Promise<boolean>} true if we interacted / it was already open nearby
     */
    async ensureBeehiveGateOpen() {
        const shut = this.findShutBeehiveGate();
        if (!shut) {
            return false;
        }
        const op = openDoorOp(shut);
        if (!op) {
            return false;
        }
        const st = shut.tile();
        this.status = 'opening beehive gate';
        this.log(`opening ${shut.name ?? 'gate'} @ ${st.x},${st.z} — keeping open`);
        await shut.interact(op);
        await Execution.delayTicks(2);
        return true;
    }

    /**
     * Walk flax ↔ Catherby through the beehives; open/keep the apiary gate.
     */
    async walkViaBeehives(dest, { radius = 3 } = {}) {
        const here = Game.tile();
        if (!here) {
            return false;
        }

        if (crossesBeehives(here, dest) && Tile.from(here).distanceTo(BEEHIVES) > 4) {
            this.status = 'via beehives';
            this.log(`via beehives ${BEEHIVES.x},${BEEHIVES.z}`);
            await Traversal.walkResilient(BEEHIVES, {
                radius: 3,
                log: m => this.log(`  ${m}`)
            });
            await this.ensureBeehiveGateOpen();
        }

        const mid = Game.tile() ?? here;
        if (Tile.from(mid).distanceTo(BEEHIVE_GATE) <= GATE_RADIUS + 6) {
            await this.ensureBeehiveGateOpen();
        }

        await Traversal.walkResilient(dest, {
            radius,
            log: m => this.log(`  ${m}`)
        });

        // Passing the gate again on arrival — keep it open.
        const after = Game.tile();
        if (after && Tile.from(after).distanceTo(BEEHIVE_GATE) <= GATE_RADIUS + 6) {
            await this.ensureBeehiveGateOpen();
        } else {
            await this.openNearbyBarrier();
        }
        return true;
    }

    async openNearbyBarrier() {
        // Prefer the apiary gate first.
        if (await this.ensureBeehiveGateOpen()) {
            return true;
        }

        const door = Locs.query()
            .where(l => isShutDoor(l))
            .where(l => l.distance() <= 3)
            .nearest();
        if (door) {
            const op = openDoorOp(door);
            if (op) {
                this.log(`opening ${door.name}`);
                await door.interact(op);
                await Execution.delayTicks(2);
                return true;
            }
        }

        const stile = Locs.query()
            .where(l => isStile(l))
            .where(l => l.distance() <= 3)
            .nearest();
        if (stile) {
            const op = stileOp(stile);
            if (op) {
                this.log(`climbing ${stile.name}`);
                await stile.interact(op);
                await Execution.delayTicks(2);
                return true;
            }
        }

        return false;
    }

    /** Deposit every inventory slot (no keep list). */
    async depositEverything() {
        if (Inventory.used() <= 0) {
            return;
        }
        this.log('depositing inventory');
        if (typeof Bank.depositInventory === 'function') {
            await Bank.depositInventory();
        } else {
            await Bank.depositAllMatching(() => true);
        }
        await Execution.delayTicks(1);
    }

    /**
     * Unequip all worn items into the pack.
     * Needs free inventory slots — call after a deposit when the pack was full.
     * @returns {Promise<boolean>} true if nothing remains equipped
     */
    async unequipAll() {
        for (let guard = 0; guard < 16; guard++) {
            const worn = Equipment.items().filter(i => i.name);
            if (worn.length === 0) {
                return true;
            }
            if (Inventory.isFull()) {
                return false;
            }
            const name = worn[0].name;
            this.log(`unequipping ${name}`);
            if (!(await Equipment.unequip(name))) {
                this.log(`could not unequip ${name}`);
                await Execution.delayTicks(1);
                return false;
            }
            await Execution.delayTicks(1);
        }
        return nothingEquipped();
    }

    findZorpix() {
        if (typeof Players?.query !== 'function') {
            return null;
        }
        return Players.query().name(MULE_NAME).nearest() ?? null;
    }

    bankFlaxCount() {
        if (typeof Bank.count === 'function') {
            return Bank.count(FLAX_NAME) || 0;
        }
        return (Bank.items?.() ?? [])
            .filter(i => isFlax(i.name))
            .reduce((n, i) => n + Math.max(1, i.count), 0);
    }

    /**
     * Mule handoff beat: beehives + gate → bank noted flax → trade to Zorpix → resume pick.
     */
    async muleTick() {
        if (!this.muleReadyToTrade) {
            await this.muleBankNotedFlax();
            return;
        }

        if (typeof Trade !== 'undefined' && Trade.active()) {
            await this.driveMuleTrade();
            return;
        }

        if (flaxCount() <= 0) {
            await this.resumePickingAfterMule('no flax in pack after withdraw');
            return;
        }
        await this.requestMuleTrade();
    }

    /**
     * True when we're already east of the apiary (or standing on the bank),
     * so the forced beehive waypoint can be skipped.
     */
    muleAlreadyPastBeehives(here) {
        if (!here) {
            return false;
        }
        if (Tile.from(here).distanceTo(BANK_STAND) <= 6) {
            return true;
        }
        // East of the apiary stand — already through toward Catherby.
        return here.x > BEEHIVES.x + 2;
    }

    /**
     * First mule priority: walk the apiary, open/keep the beehive gate, then bank.
     * @returns {Promise<boolean>} true if still handling the beehive leg (caller should return)
     */
    async muleEnsureBeehivesThenBank() {
        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return true;
        }

        if (this.muleViaBeehivesDone) {
            return false;
        }

        if (this.muleAlreadyPastBeehives(here)) {
            this.muleViaBeehivesDone = true;
            return false;
        }

        // Walk onto the apiary first.
        if (Tile.from(here).distanceTo(BEEHIVES) > 4) {
            if (this.status !== 'mule: via beehives') {
                this.log(`mule: through beehives ${BEEHIVES.x},${BEEHIVES.z} before bank`);
            }
            this.status = 'mule: via beehives';
            await Traversal.walkResilient(BEEHIVES, {
                radius: 3,
                log: m => this.log(`  ${m}`)
            });
            return true;
        }

        // At the apiary — open the gate and do not leave until it's clear.
        if (this.findShutBeehiveGate()) {
            if (this.status !== 'mule: opening beehive gate') {
                this.log('mule: opening beehive gate — must be open before bank');
            }
            this.status = 'mule: opening beehive gate';
            await this.ensureBeehiveGateOpen();
            return true;
        }

        // Near the pin: poke open once more if a shut gate is in range.
        if (Tile.from(here).distanceTo(BEEHIVE_GATE) <= GATE_RADIUS + 6) {
            await this.ensureBeehiveGateOpen();
            if (this.findShutBeehiveGate()) {
                return true;
            }
        }

        this.muleViaBeehivesDone = true;
        this.log('mule: beehive gate clear — walking to Catherby bank');
        return false;
    }

    /**
     * Catherby bank: deposit all flax, Withdraw-as-Note all banked flax.
     * Always routes through the beehives with the gate open first.
     */
    async muleBankNotedFlax() {
        this.status = 'mule: banking';
        if (!this.muleAnnounced) {
            this.muleAnnounced = true;
            this.log(
                `mule: beehives → open gate → withdraw noted → trade to ${MULE_NAME} → resume pick`
            );
        }

        // Priority 1: apiary + gate before any bank UI.
        if (await this.muleEnsureBeehivesThenBank()) {
            return;
        }

        const here = Game.tile();
        if (!here || Tile.from(here).distanceTo(BANK_STAND) > 6) {
            this.status = 'mule: to bank';
            // Keep using the beehive-aware walker; re-open gate if we brush it.
            await this.walkViaBeehives(BANK_STAND, { radius: 2 });
            return;
        }

        if (!Bank.isOpen()) {
            this.log('mule: opening Catherby bank');
            if (
                !(await Banking.open({
                    stand: BANK_STAND,
                    log: m => this.log(`  ${m}`)
                }))
            ) {
                this.log('mule: could not open bank — retrying');
                await Execution.delayTicks(3);
                return;
            }
        }

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
        }
        await Execution.delayTicks(1);

        // Already holding notes and nothing left to pull — do not re-deposit notes.
        const notedHeld = notedFlaxCount();
        const unnotedHeld = unnotedFlaxCount();
        let banked = this.bankFlaxCount();
        if (notedHeld > 0 && unnotedHeld <= 0 && banked <= 0) {
            if (Bank.isOpen()) {
                await Bank.close();
            }
            this.muleReadyToTrade = true;
            this.lastFlaxSeen = notedHeld;
            this.log(`mule: already holding ${notedHeld} noted flax — looking for ${MULE_NAME}`);
            this.status = 'mule: find partner';
            return;
        }

        // Deposit unnoted flax only — never put notes back in the bank.
        if (unnotedHeld > 0) {
            this.log(`mule: depositing ${unnotedHeld} unnoted flax (keeping notes in pack)`);
            if (typeof Bank.depositAllMatching === 'function') {
                await Bank.depositAllMatching((name, id) => isUnnotedFlaxDeposit(name, id));
            } else if (typeof Bank.deposit === 'function') {
                // Fallback deposits by name — only safe when we hold no notes.
                if (notedFlaxCount() <= 0) {
                    await Bank.deposit(FLAX_NAME, 'Deposit-All');
                } else {
                    for (const item of Inventory.items().filter(isUnnotedFlaxItem)) {
                        await Bank.deposit(FLAX_NAME, 'Deposit-1');
                        await Execution.delayTicks(1);
                    }
                }
            }
            await Execution.delayTicks(1);
            banked = this.bankFlaxCount();
        }

        // Free a slot for noted withdraw without depositing existing notes.
        if (Inventory.free() <= 0 && this.bankFlaxCount() > 0) {
            this.log('mule: clearing non-note junk for noted withdraw');
            if (typeof Bank.depositAllMatching === 'function') {
                await Bank.depositAllMatching((name, id) => {
                    if (!isFlax(name)) {
                        return true;
                    }
                    return isUnnotedFlaxDeposit(name, id);
                });
            } else if (notedFlaxCount() <= 0) {
                await this.depositEverything();
            }
            await Execution.delayTicks(1);
            banked = this.bankFlaxCount();
        }

        banked = this.bankFlaxCount();
        this.lastBankFlax = banked;
        if (banked <= 0 && flaxCount() <= 0) {
            this.log('mule: no flax in bank or pack — aborting handoff');
            if (Bank.isOpen()) {
                await Bank.close();
            }
            await this.resumePickingAfterMule('nothing to mule');
            return;
        }

        if (banked > 0) {
            this.log(`mule: withdrawing ${banked} flax as notes`);
            if (typeof Bank.setNoteMode === 'function') {
                await Bank.setNoteMode(true);
                await Execution.delayTicks(1);
            }

            const flaxItem =
                (Bank.items?.() ?? []).find(i => isFlax(i.name)) ?? null;
            const op =
                (typeof withdrawOp === 'function' && flaxItem
                    ? withdrawOp(flaxItem.ops, 'all')
                    : null) ?? 'Withdraw-All';

            let ok = false;
            if (typeof Bank.withdraw === 'function') {
                ok = !!(await Bank.withdraw(FLAX_NAME, op));
            }
            if (!ok && typeof Bank.withdrawX === 'function') {
                ok = !!(await Bank.withdrawX(FLAX_NAME, banked));
            }
            await Execution.delayTicks(1);

            // If we somehow got unnoted, put it back and retry note mode.
            if (unnotedFlaxCount() > 0 && notedFlaxCount() <= 0) {
                this.log('mule: withdraw came out unnoted — re-depositing and retrying note mode');
                if (typeof Bank.depositAllMatching === 'function') {
                    await Bank.depositAllMatching((name, id) => isUnnotedFlaxDeposit(name, id));
                }
                await Execution.delayTicks(2);
                return;
            }

            if (flaxCount() <= 0) {
                this.log('mule: withdraw did not land flax — retrying');
                await Execution.delayTicks(2);
                return;
            }
        }

        // Leave note mode off for next open; never deposit the notes we hold.
        if (typeof Bank.setNoteMode === 'function') {
            await Bank.setNoteMode(false);
        }
        if (Bank.isOpen()) {
            await Bank.close();
        }

        this.muleReadyToTrade = true;
        this.lastFlaxSeen = flaxCount();
        this.log(
            `mule: holding ${notedFlaxCount() || flaxCount()} noted flax — looking for ${MULE_NAME}`
        );
        this.status = 'mule: find partner';
    }

    async requestMuleTrade() {
        const partner = this.findZorpix();
        if (!partner) {
            this.status = `mule: waiting for ${MULE_NAME}`;
            await Execution.delayTicks(3);
            return;
        }

        if (partner.distance() > MULE_TRADE_RANGE) {
            this.status = `mule: walking to ${MULE_NAME}`;
            this.log(`mule: ${MULE_NAME} ${partner.distance()}t away — walking closer`);
            const pt = partner.tile?.() ?? null;
            if (pt) {
                await Traversal.walkTo(pt, {
                    radius: MULE_TRADE_RANGE,
                    timeoutMs: 30_000,
                    log: m => this.log(`  ${m}`)
                });
            } else {
                await Execution.delayTicks(2);
            }
            return;
        }

        if (Date.now() < this.nextMuleTradeRequestAtMs) {
            this.status = `mule: waiting to re-request ${MULE_NAME}`;
            await Execution.delayTicks(1);
            return;
        }

        this.status = `mule: trading ${MULE_NAME}`;
        this.log(`mule: Trade with ${MULE_NAME}`);
        this.nextMuleTradeRequestAtMs = Date.now() + MULE_TRADE_REQUEST_MS;
        await Trade.request(MULE_NAME);
        await Execution.delayUntil(() => Trade.active(), MULE_TRADE_REQUEST_MS);
    }

    /**
     * Wait 5–10s, then Accept. On the confirm screen, keep clicking Accept
     * until the trade fully closes — never bail after the first confirm click.
     * @param {'offer'|'confirm'} screen
     */
    async muleWaitAndAcceptScreen(screen) {
        const onOffer = () => Trade.onOfferScreen() && !Trade.onConfirmScreen();
        const onConfirm = () => Trade.onConfirmScreen();
        const isHere = screen === 'confirm' ? onConfirm : onOffer;

        if (!Trade.active() || !isHere()) {
            return;
        }

        const waitMs = muleAcceptDelayMs();
        const label =
            screen === 'confirm'
                ? 'confirm (double-check)'
                : 'offer (trade goods)';
        this.status = `mule: waiting on ${screen}`;
        this.log(`mule: ${label} — waiting ~${Math.round(waitMs / 1000)}s before accept`);

        const readyAt = Date.now() + waitMs;
        while (Date.now() < readyAt && Trade.active() && isHere()) {
            await Execution.delayTicks(1);
        }

        if (!Trade.active()) {
            return;
        }

        this.status = `mule: accepting ${screen}`;
        this.log(`mule: accepting ${label}`);
        await Trade.accept();

        if (screen === 'offer') {
            // Offer screen: re-Accept until confirm appears or trade ends.
            while (Trade.active() && onOffer()) {
                await Execution.delayUntil(
                    () => !Trade.active() || onConfirm() || !onOffer(),
                    MULE_ACCEPT_RETRY_MS
                );
                if (!Trade.active() || onConfirm() || !onOffer()) {
                    break;
                }
                this.log('mule: re-accepting offer (still open)');
                await Trade.accept();
            }
            return;
        }

        // Confirm screen: keep Accepting until the trade is actually over.
        this.log('mule: confirm accepted — keeping Accept until trade closes');
        while (Trade.active()) {
            if (onConfirm() || onOffer()) {
                this.status = 'mule: accepting until trade ends';
                await Trade.accept();
            }
            await Execution.delayTicks(2);
        }
        this.log('mule: trade interface closed');
    }

    /**
     * Screen 1: offer goods → Accept.
     * Screen 2: confirm / double-check → keep Accepting until trade ends.
     * Only stops the script after the trade is fully over.
     */
    async driveMuleTrade() {
        const before = flaxCount();

        while (typeof Trade !== 'undefined' && Trade.active()) {
            // —— Screen 2: confirm / double-check ——
            if (Trade.onConfirmScreen()) {
                await this.muleWaitAndAcceptScreen('confirm');
                // Confirm helper blocks until Trade.active() is false.
                break;
            }

            // —— Screen 1: trade goods ——
            if (!Trade.onOfferScreen()) {
                await Execution.delayTicks(1);
                continue;
            }

            const who = Trade.partner();
            if (who != null && who.trim().toLowerCase() !== MULE_NAME.toLowerCase()) {
                this.log(`mule: declining trade with ${who} (want ${MULE_NAME})`);
                await Trade.decline();
                return;
            }
            if (who == null) {
                this.status = 'mule: reading trade partner';
                await Execution.delayTicks(1);
                continue;
            }

            const offered = Trade.myOffer().some(i => isFlax(i.name));
            if (!offered) {
                if (this.status !== 'mule: offering flax') {
                    this.log('mule: Offer-All Flax (noted)');
                }
                this.status = 'mule: offering flax';
                const offerNoted = i => {
                    const cert = certIsNote(i.id);
                    if (cert === true) {
                        return true;
                    }
                    if (cert === false) {
                        return false;
                    }
                    return Math.max(1, i.count) > 1;
                };
                let offeredOk = false;
                if (typeof Trade.offerAll === 'function') {
                    offeredOk = !!(await Trade.offerAll(FLAX_NAME, offerNoted));
                    if (!offeredOk) {
                        offeredOk = !!(await Trade.offerAll(FLAX_NAME));
                    }
                }
                if (!offeredOk) {
                    this.log('mule: offerAll Flax failed — declining');
                    await Trade.decline();
                    return;
                }
                await Execution.delayUntil(
                    () =>
                        Trade.myOffer().some(i => isFlax(i.name)) ||
                        Trade.onConfirmScreen() ||
                        !Trade.active(),
                    MULE_TRADE_REQUEST_MS
                );
                continue;
            }

            await this.muleWaitAndAcceptScreen('offer');
        }

        // Trade must be fully closed before we resume picking.
        if (Trade.active()) {
            this.status = 'mule: finishing trade';
            this.log('mule: trade still open — keeping Accept until it closes');
            while (Trade.active()) {
                if (Trade.onConfirmScreen() || Trade.onOfferScreen()) {
                    await Trade.accept();
                }
                await Execution.delayTicks(2);
            }
        }

        // Brief settle so a flicker doesn't look like "done" mid-confirm.
        await Execution.delayTicks(3);
        if (Trade.active()) {
            this.log('mule: trade reopened — continuing Accepts');
            return;
        }

        const gone = before - flaxCount();
        if (gone > 0 || flaxCount() <= 0) {
            this.lastBankFlax = 0;
            await this.resumePickingAfterMule(
                `trade over — delivered ${gone > 0 ? gone : 'all'} flax to ${MULE_NAME}`
            );
            return;
        }
        this.log('mule: trade over but flax still held — will re-request');
        this.nextMuleTradeRequestAtMs = Date.now() + MULE_TRADE_REQUEST_MS;
    }

    /**
     * Walk via beehives to Catherby bank, deposit pack, strip all gear, deposit again,
     * return empty via beehives (gate kept open).
     */
    async bankAndReturn() {
        const held = flaxCount();
        this.status = 'banking';
        this.log(
            `banking all at Catherby (flax ${held}) — via beehives, unequip, deposit`
        );

        this.lastFlaxSeen = 0;

        const here = Game.tile();
        if (!here || Tile.from(here).distanceTo(BANK_STAND) > 6) {
            this.status = 'walking to bank';
            await this.walkViaBeehives(BANK_STAND, { radius: 2 });
        }

        if (!Bank.isOpen()) {
            this.log('opening Catherby bank');
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

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
        }
        await Execution.delayTicks(1);

        // Free pack space first so unequips can land in inventory.
        await this.depositEverything();

        if (!(await this.unequipAll())) {
            await this.depositEverything();
            await this.unequipAll();
        }
        await this.depositEverything();

        if (Equipment.items().some(i => i.name)) {
            this.log('WARNING: still wearing gear after bank — will retry next trip');
        }
        if (Inventory.used() > 0) {
            this.log(`WARNING: still holding ${Inventory.used()} after deposit — retrying deposit`);
            await this.depositEverything();
        }

        const banked = this.bankFlaxCount();
        this.lastBankFlax = banked;
        this.bankTrips++;
        this.lastFlaxSeen = flaxCount();

        if (this.muleWanted()) {
            const need = this.muleThreshold();
            this.log(`mule: bank flax ${banked}/${need}`);
            if (banked >= need) {
                if (Bank.isOpen()) {
                    // Keep bank open for noted withdraw.
                } else {
                    // reopen happens in muleBankNotedFlax
                }
                this.beginMuleHandoff({ alreadyAtBank: true });
                return;
            }
        }

        if (Bank.isOpen()) {
            await Bank.close();
        }

        this.status = 'returning to flax';
        await this.walkViaBeehives(ANCHOR, { radius: 4 });
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const pickPh = hrs > 0.008 ? this.picked / hrs : 0;

        const lines = [
            `Seers Flax Picker`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `picked ${this.picked} (${fmtXph(pickPh)}/hr)  inv ${flaxCount()}`,
            `bank trips ${this.bankTrips}  ·  Catherby via beehives` +
                (this.startReady ? '' : '  ·  start prep')
        ];
        if (this.muleWanted()) {
            const need = this.muleThreshold();
            const have = this.lastBankFlax;
            lines.push(
                this.muleHandoffActive
                    ? `mule handoff → ${MULE_NAME}`
                    : `mule ${have}/${need} flax → ${MULE_NAME}`
            );
        }
        lines.push('ALL HAIL ZORPIX');

        ctx.font = '12px monospace';
        let maxW = 0;
        for (const line of lines) {
            maxW = Math.max(maxW, ctx.measureText(line).width);
        }
        const pad = 6;
        const lineH = 16;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, 6, maxW + pad * 2, pad * 2 + lines.length * lineH);
        ctx.fillStyle = '#c4b07a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.3.0',
    category: 'Gathering',
    tags: ['flax', 'seers', 'catherby', 'beehives', 'bank', 'crafting', 'fletching', 'mule'],
    description:
        "Picks Flax at Seers' Village. Banks at Catherby via the beehives. Optional mule: keep picking until bank flax hits the threshold, trade noted flax to Zorpix, then resume picking.",
    settingsSchema: {
        mule: {
            type: 'boolean',
            default: false,
            label: 'Mule',
            group: 'Mule',
            help:
                'When on, keep picking and banking. Once banked flax reaches the threshold, withdraw as notes, trade to Zorpix (both screens), then resume picking. Safe to leave on.'
        },
        muleThreshold: {
            type: 'number',
            default: 1000,
            min: 1,
            max: 10_000,
            label: 'Flax before mule',
            group: 'Mule',
            help:
                'How much flax must be in the bank before muling to Zorpix (1–10000). After each successful trade, picking continues until this amount is banked again.'
        }
    },
    create: () => new SeersFlaxPicker()
});
