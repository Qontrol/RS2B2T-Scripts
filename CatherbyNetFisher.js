/**
 * CatherbyNetFisher — small-net shrimp/anchovies at Catherby shore, bank catch.
 * Optional: cook on the bank-house Range on the way back to the bank.
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

/** Catherby shore stand (pathable — not the water spot tile). */
const ANCHOR = new Tile(2845, 3431, 0);
/** Chase Net hops along the beach within this radius of ANCHOR. */
const LEASH = 35;
/** Soft stand radius — recenter if we drift far from camp. */
const STAND_RADIUS = 8;

/** Catherby bank. */
const BANK_STAND = new Tile(2809, 3441, 0);

/** Catherby bank-house Range — on the walk from pier → bank. */
const RANGE_STAND = new Tile(2817, 3443, 0);
const RANGE_LOC = new Tile(2817, 3444, 0);
const RANGE_LEASH = 8;

const NET_NAME = 'Small fishing net';
const SPOT_NAME = 'Fishing spot';
const DEATH_RE = /oh dear.*you are dead/i;
const COMBAT_WAIT_MS = 15_000;

function fmtXph(n) {
    if (n >= 100_000) {
        return `${(n / 1000).toFixed(0)}k`;
    }
    if (n >= 10_000) {
        return `${(n / 1000).toFixed(1)}k`;
    }
    return String(Math.round(n));
}

/** Elapsed session time as H:MM:SS or M:SS. */
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

function isKeepTool(name) {
    if (!name) {
        return false;
    }
    return (name ?? '').toLowerCase().includes('fishing net');
}

function isRawNetFish(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    if (!n.startsWith('raw ')) {
        return false;
    }
    return n.includes('shrimp') || n.includes('anchov');
}

function isCookedNetFish(name) {
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
    return isRawNetFish(name) || isCookedNetFish(name) || isBurntFish(name);
}

function countMatching(pred) {
    return Inventory.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function rawFishCount() {
    return countMatching(isRawNetFish);
}

function cookableCount() {
    return countMatching(isRawNetFish);
}

function cookedFishCount() {
    return countMatching(isCookedNetFish);
}

function burntCount() {
    return countMatching(isBurntFish);
}

function lastRawFish() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        if (isRawNetFish(items[i].name)) {
            return items[i];
        }
    }
    return null;
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

/** True for shrimp/anchovy hops (Net + Bait), not big-net/harpoon hops (Net + Harpoon). */
function isSmallNetSpot(actions) {
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
    fishCaught = 0;
    cooked = 0;
    bankTrips = 0;
    cookShrimp = true;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;
    cookingLoad = false;
    /** Last seen raw count — used to tally catches across animating ticks. */
    lastRawSeen = 0;
    combatFlees = 0;
    deaths = 0;
    recovering = false;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();

        this.syncPrefs({ silent: true });
        this.startedAt = Date.now();
        this.fishXpAtStart = Skills.xp('fishing');
        this.cookXpAtStart = Skills.xp('cooking');
        this.fishCaught = 0;
        this.cooked = 0;
        this.bankTrips = 0;
        this.combatFlees = 0;
        this.deaths = 0;
        this.recovering = false;
        this.cookingLoad = false;
        this.lastRawSeen = rawFishCount();

        if (typeof Game.setAutoRetaliate === 'function') {
            Game.setAutoRetaliate(false);
        }

        this.on('skill.level', e => {
            if (e.name === 'fishing' || e.name === 'cooking') {
                this.log(`${e.name} ${e.previous} → ${e.level}`);
            }
        });

        this.on('chat.message', e => {
            if (DEATH_RE.test(e.text) && !this.recovering) {
                this.recovering = true;
                this.cookingLoad = false;
                this.deaths++;
                this.status = 'dead';
                this.log(
                    `died (#${this.deaths}) — will walk back to ${ANCHOR.x},${ANCHOR.z}, loot net, continue`
                );
            }
        });

        this.log(
            `CatherbyNetFisher @ ${ANCHOR.x},${ANCHOR.z} (leash ${LEASH}) — ` +
                `small-net shrimp/anchovies; cook: ${this.cookShrimp ? 'on (range→bank)' : 'off (bank raw)'}`
        );
        if (!hasNet()) {
            this.log('WARNING: no Small fishing net in inventory — will try ground loot if needed');
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
            `stopped — caught ~${this.fishCaught}, cooked ~${this.cooked}, ` +
                `bank trips ${this.bankTrips}, combat flees ${this.combatFlees}, deaths ${this.deaths} (${this.status})`
        );
    }

    async recoverFromDeath() {
        const ready = await Execution.delayUntil(
            () => Game.ingame() && Game.tile() !== null,
            30_000
        );
        if (!ready) {
            this.log('still waiting for respawn…');
            return;
        }
        await Execution.delayTicks(3);

        this.status = 'death — walking to fishing spot';
        this.log(`death recovery — walking to ${ANCHOR.x},${ANCHOR.z}`);
        const ok = await Traversal.walkResilient(ANCHOR, {
            radius: 3,
            log: m => this.log(`  ${m}`)
        });
        if (!ok) {
            this.log('could not reach fishing spot after death — will retry');
            return;
        }

        if (!hasNet()) {
            this.status = 'death — looting net';
            const looted = await this.lootNetFromGround({ wide: true });
            if (!looted) {
                this.log('net not on ground yet — waiting near death pile');
                await Execution.delayTicks(5);
                return;
            }
        }

        this.recovering = false;
        this.lastRawSeen = rawFishCount();
        this.status = 'fishing';
        this.log('death recovery done — net secured, continuing');
    }

    async lootNetFromGround({ wide = false } = {}) {
        if (hasNet()) {
            return true;
        }

        const within = wide ? 18 : 10;
        let ground =
            GroundItems.query()
                .name(NET_NAME)
                .within(within)
                .nearest() ??
            GroundItems.query()
                .where(g => isNetGroundName(g.name))
                .within(within)
                .nearest();

        if (!ground && wide) {
            await Traversal.walkTo(ANCHOR, { radius: 2, timeoutMs: 10_000 });
            ground =
                GroundItems.query()
                    .name(NET_NAME)
                    .within(12)
                    .nearest() ??
                GroundItems.query()
                    .where(g => isNetGroundName(g.name))
                    .within(12)
                    .nearest();
        }

        if (!ground) {
            return false;
        }

        const before = Inventory.used();
        this.log(`taking ${ground.name ?? NET_NAME} from ground`);
        await ground.interact('Take');
        const got = await Execution.delayUntil(() => hasNet() || Inventory.used() > before, 6000);
        return got && hasNet();
    }

    async fleeCombatToBank() {
        this.combatFlees++;
        this.cookingLoad = false;
        if (typeof Game.setAutoRetaliate === 'function') {
            Game.setAutoRetaliate(false);
        }

        this.status = 'combat — fleeing to bank';
        this.log(`in combat — running to Catherby bank (flee #${this.combatFlees})`);
        await Traversal.walkResilient(BANK_STAND, {
            radius: 2,
            log: m => this.log(`  ${m}`)
        });

        await Execution.delayUntil(() => !Game.inCombat(), 20_000);

        this.status = 'combat — waiting at bank';
        this.log(`at bank — waiting ${COMBAT_WAIT_MS / 1000}s before fishing again`);
        const until = Date.now() + COMBAT_WAIT_MS;
        while (Date.now() < until) {
            if (!Game.ingame()) {
                await Execution.delayTicks(5);
                continue;
            }
            if (Game.inCombat()) {
                await Traversal.walkTo(BANK_STAND, { radius: 1, timeoutMs: 8_000 });
                await Execution.delayUntil(() => !Game.inCombat(), 10_000);
            }
            const left = until - Date.now();
            if (left <= 0) {
                break;
            }
            this.status = `combat — wait ${Math.ceil(left / 1000)}s`;
            await Execution.delay(Math.min(1000, left));
        }

        this.log('wait done — returning to fishing camp');
        this.status = 'returning to spot';
        await Traversal.walkResilient(ANCHOR, {
            radius: 3,
            log: m => this.log(`  ${m}`)
        });
    }

    syncPrefs({ silent = false } = {}) {
        const prev = this.cookShrimp;
        this.cookShrimp = readPrefBool(
            'cookShrimp',
            this.settings.bool('cookShrimp', true)
        );
        if (!silent && prev !== this.cookShrimp) {
            this.log(`prefs: cook on way to bank → ${this.cookShrimp ? 'on' : 'off'}`);
        }
    }

    noteCatches() {
        const now = rawFishCount();
        if (now > this.lastRawSeen) {
            this.fishCaught += now - this.lastRawSeen;
        }
        this.lastRawSeen = now;
    }

    async loop() {
        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }

        this.syncPrefs({ silent: true });
        unlockPausedPrefsUi();
        this.noteCatches();

        if (this.recovering) {
            await this.recoverFromDeath();
            return;
        }

        if (Game.inCombat()) {
            await this.fleeCombatToBank();
            return;
        }

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
            return;
        }

        if (!hasNet()) {
            this.status = 'need net';
            if (await this.lootNetFromGround({ wide: true })) {
                this.log('looted Small fishing net — continuing');
                return;
            }
            this.log('no Small fishing net — loot death pile or withdraw one, then continue');
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
            if (this.cookShrimp && cookableCount() > 0) {
                this.cookingLoad = true;
                this.log(`inventory full (${cookableCount()} raw) — cooking at range then banking`);
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
            this.log(`outside leash — walking back to ${ANCHOR.x},${ANCHOR.z}`);
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

        const spot = this.findSpot();
        if (!spot) {
            this.status = 'waiting for Net spot';
            if (Tile.from(here).distanceTo(ANCHOR) > STAND_RADIUS) {
                await Traversal.walkTo(ANCHOR, { radius: 2, timeoutMs: 12_000 });
            }
            await Execution.delayTicks(3);
            return;
        }

        await this.netSpot(spot);
    }

    async netSpot(spot) {
        const op = netOp(spot.actions());
        if (!op) {
            this.log(`spot has no Net action: [${spot.actions().join(', ')}]`);
            await Execution.delayTicks(2);
            return;
        }

        const before = rawFishCount();
        const st = spot.tile();
        this.status = `netting (${spot.distance()}t)`;
        this.log(`Net Fishing spot @ ${st.x},${st.z}`);
        await spot.interact(op);

        await Execution.delayUntil(
            () =>
                rawFishCount() > before ||
                Game.animating() ||
                ChatDialog.canContinue() ||
                Game.inCombat() ||
                !this.findSpot(),
            8000
        );
        this.noteCatches();
    }

    /** Nearest shrimp/anchovy Net+Bait spot within the shore leash (never Net+Harpoon). */
    findSpot() {
        return Npcs.query()
            .name(SPOT_NAME)
            .where(n => isSmallNetSpot(n.actions()))
            .where(n => Tile.from(n.tile()).distanceTo(ANCHOR) <= LEASH)
            .nearest();
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
        this.log(`walking to Catherby Range ${RANGE_STAND.x},${RANGE_STAND.z} (on way to bank)`);
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
        const raw = lastRawFish();
        const hint = raw?.name;
        this.status = 'cook make-menu';
        this.log(`cook menu: [${products.join(', ')}] hint=${hint ?? 'none'}`);

        let picked = false;
        if (hint && typeof ChatDialog.makeX === 'function') {
            const n = Math.max(1, Math.min(cookableCount(), 28));
            picked = await ChatDialog.makeX(hint, n);
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
        await Execution.delayUntil(
            () => !ChatDialog.isMakeMenu() && (Game.animating() || cookableCount() === 0),
            5000
        );
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
            this.log('WARNING: no Range found near Catherby bank house — banking raw instead');
            this.cookingLoad = false;
            await this.bankAndReturn();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
            return;
        }

        const raw = lastRawFish();
        if (!raw) {
            this.cookingLoad = false;
            return;
        }

        const beforeRaw = cookableCount();
        const beforeCooked = cookedFishCount();
        const beforeXp = Skills.xp('cooking');
        this.status = `cooking ${raw.name}`;
        this.log(`use ${raw.name} on ${oven.name ?? 'Range'}`);

        if (!(await raw.useOn(oven))) {
            await this.openNearbyDoor();
            await Execution.delayTicks(2);
            return;
        }

        const started = await Execution.delayUntil(
            () =>
                cookableCount() < beforeRaw ||
                Skills.xp('cooking') > beforeXp ||
                ChatDialog.isMakeMenu() ||
                ChatDialog.canContinue(),
            4000
        );

        if (ChatDialog.isMakeMenu()) {
            await this.chooseCookProduct();
        }

        if (!started && cookableCount() >= beforeRaw) {
            this.log('cook did not start — re-pathing to range');
            await this.walkToRange();
            return;
        }

        let mark = cookableCount();
        let idle = 0;
        for (let guard = 0; guard < 400 && cookableCount() > 0; guard++) {
            if (Game.inCombat()) {
                this.log('combat while cooking — aborting to flee');
                return;
            }
            if (ChatDialog.canContinue() || ChatDialog.isMakeMenu()) {
                return;
            }
            await Execution.delayTicks(1);
            const now = cookableCount();
            if (now < mark) {
                this.cooked += mark - now;
                mark = now;
                idle = 0;
            } else if (!Game.animating() && ++idle >= 14) {
                break;
            } else if (Game.animating()) {
                idle = 0;
            }
        }

        const gainedCooked = cookedFishCount() - beforeCooked;
        if (gainedCooked > 0) {
            this.log(`cooked +${gainedCooked} (session ~${this.cooked})`);
        }

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
        this.status = 'returning to spot';
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const fishXp = Skills.xp('fishing') - this.fishXpAtStart;
        const cookXp = Skills.xp('cooking') - this.cookXpAtStart;
        const fishXph = hrs > 0.008 ? fishXp / hrs : 0;
        const cookXph = hrs > 0.008 ? cookXp / hrs : 0;
        const catchPh = hrs > 0.008 ? this.fishCaught / hrs : 0;

        const lines = [
            `Catherby Net  Fish ${Skills.level('fishing')}  Cook ${Skills.level('cooking')}`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.cookShrimp ? 'cook→bank' : 'bank raw'}  ·  ${this.status}`,
            `caught ${this.fishCaught} (${fmtXph(catchPh)}/hr)  cooked ~${this.cooked}  trips ${this.bankTrips}`,
            `Fish ${fmtXph(fishXph)}/hr` +
                (this.cookShrimp || cookXp > 0 ? `  Cook ${fmtXph(cookXph)}/hr` : '') +
                `  flees ${this.combatFlees}  deaths ${this.deaths}  raw ${rawFishCount()}`
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
        ctx.fillStyle = '#7eb8da';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Fishing',
    tags: ['fishing', 'catherby', 'net', 'shrimp', 'anchovies', 'bank', 'cook'],
    description:
        'Catherby small-net shrimp/anchovies at 2845,3431. Optional cook on bank-house Range on the way to bank, then bank and return.',
    settingsSchema: {
        cookShrimp: {
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
