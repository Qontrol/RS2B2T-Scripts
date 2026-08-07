/**
 * ArdougneThiever — pickpocket Warrior women / Guards in East Ardougne.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('ArdougneThiever: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `ArdougneThiever: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Npcs,
    Locs,
    Inventory,
    Equipment,
    Bank,
    Banking,
    Traversal,
    Tile,
    Skills,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'ArdougneThiever';

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
const PICKPOCKET_OP = 'Pickpocket';
const STUN_RE = /been stunned|fail to pick/i;
const STUN_TICKS = 9;

/** East Ardougne bank. */
const BANK_STAND = new Tile(2655, 3286, 0);

const TARGETS = {
    'Warrior woman': {
        name: 'Warrior woman',
        /** Classic / RS2B cache id. */
        npcId: 15,
        thieving: 25,
        anchor: new Tile(2630, 3297, 0),
        leash: 16
    },
    Guard: {
        name: 'Guard',
        npcId: null,
        thieving: 40,
        anchor: new Tile(2661, 3306, 0),
        leash: 19
    }
};

const TARGET_OPTIONS = Object.keys(TARGETS);

/**
 * Exact in-game names. Cake toggle uses: Slice of cake → 2/3 cake → Cake.
 * Chocolate slice is a separate toggle.
 */
const FOOD_SLICE = 'Slice of cake';
const FOOD_TWO_THIRDS = '2/3 cake';
const FOOD_CAKE = 'Cake';
const FOOD_CHOC = 'Chocolate slice';

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

function readPrefBool(key, fallback) {
    const raw = readPrefRaw(key);
    if (raw === null) {
        return fallback;
    }
    const n = raw.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes';
}

function readPrefNum(key, fallback) {
    const raw = readPrefRaw(key);
    if (raw === null) {
        return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
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

function nameEq(a, b) {
    return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
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

class ArdougneThiever extends LoopingBot {
    status = 'starting';
    targetKey = 'Warrior woman';
    eatAtHp = 10;
    useCake = true;
    useChocolate = true;
    /** How many of the primary food to withdraw when restocking. */
    foodWithdraw = 20;
    bankTrips = 0;
    /** False until start bank + food withdraw finishes. */
    startReady = false;

    steals = 0;
    fails = 0;
    eats = 0;
    startedAt = 0;
    xpAtStart = 0;
    stunnedUntilTick = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    targetCfg() {
        return TARGETS[this.targetKey] ?? TARGETS['Warrior woman'];
    }

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();

        this.syncPrefs({ silent: true });
        this.startedAt = Date.now();
        this.xpAtStart = Skills.xp('thieving');
        this.steals = 0;
        this.fails = 0;
        this.eats = 0;
        this.bankTrips = 0;
        this.startReady = false;
        this.stunnedUntilTick = 0;

        this.on('chat.message', e => {
            if (STUN_RE.test(e.text)) {
                this.stunnedUntilTick = Game.tick() + STUN_TICKS;
                this.fails++;
            }
        });

        this.on('skill.level', e => {
            if (e.name === 'thieving') {
                this.log(`thieving ${e.previous} → ${e.level}`);
            }
        });

        const cfg = this.targetCfg();
        const need = cfg.thieving;
        const have = Skills.level('thieving');
        if (have < need) {
            this.log(
                `WARNING: ${cfg.name} needs Thieving ${need} (you have ${have}) — will keep trying`
            );
        }

        this.log(
            `Benzyme's Ardougne Thiever — first bank all (inv+equipped), withdraw food, ` +
                `then ${cfg.name} @ ${cfg.anchor.x},${cfg.anchor.z}` +
                (cfg.npcId != null ? ` (id ${cfg.npcId})` : '') +
                `; eat ≤ ${this.eatAtHp}; food ${this.describeFoodPrefs()}` +
                (this.foodEnabled() ? ` ×${this.foodWithdraw}` : '')
        );
        this.status = 'start: bank';
    }

    onPause() {
        unlockPausedPrefsUi();
    }

    onResume() {
        this.syncPrefs({ silent: false });
    }

    onStop() {
        this.stopPausedPrefUnlock();
        this.log(
            `stopped — ${this.steals} steals, ${this.fails} fails, ${this.eats} eats, ` +
                `${this.bankTrips} bank trips (${this.status})`
        );
    }

    startPausedPrefUnlock() {
        this.stopPausedPrefUnlock();
        this.unlockTimer = setInterval(() => unlockPausedPrefsUi(), 500);
    }

    stopPausedPrefUnlock() {
        if (this.unlockTimer !== null) {
            clearInterval(this.unlockTimer);
            this.unlockTimer = null;
        }
    }

    syncPrefs(opts = {}) {
        const silent = opts.silent === true;
        const prevTarget = this.targetKey;

        let target = readPrefStr('target', this.targetKey);
        if (!TARGETS[target]) {
            target = 'Warrior woman';
        }
        this.targetKey = target;

        this.eatAtHp = Math.max(1, Math.min(30, Math.round(readPrefNum('eatAtHp', this.eatAtHp))));
        this.useCake = readPrefBool('useCake', this.useCake);
        this.useChocolate = readPrefBool('useChocolate', this.useChocolate);
        this.foodWithdraw = Math.max(
            1,
            Math.min(27, Math.round(readPrefNum('foodWithdraw', this.foodWithdraw)))
        );

        if (!silent && prevTarget !== this.targetKey) {
            const cfg = this.targetCfg();
            this.log(`target → ${cfg.name} (need Thieving ${cfg.thieving})`);
        }
    }

    describeFoodPrefs() {
        const bits = [];
        if (this.useCake) {
            bits.push('cake');
        }
        if (this.useChocolate) {
            bits.push('choc');
        }
        return bits.length ? bits.join('+') : 'off';
    }

    /**
     * Cake-on: Slice → 2/3 → Cake. Chocolate is a separate toggle (after 2/3, before whole Cake).
     */
    foodPriorityNames() {
        if (this.useCake && this.useChocolate) {
            return [FOOD_SLICE, FOOD_TWO_THIRDS, FOOD_CHOC, FOOD_CAKE];
        }
        if (this.useCake) {
            return [FOOD_SLICE, FOOD_TWO_THIRDS, FOOD_CAKE];
        }
        if (this.useChocolate) {
            return [FOOD_CHOC];
        }
        return [];
    }

    foodEnabled() {
        return this.foodPriorityNames().length > 0;
    }

    findBestFood() {
        for (const name of this.foodPriorityNames()) {
            const item = Inventory.items().find(i => nameEq(i.name, name));
            if (item) {
                return item;
            }
        }
        return null;
    }

    foodCount() {
        const allowed = new Set(this.foodPriorityNames().map(n => n.toLowerCase()));
        return Inventory.items()
            .filter(i => allowed.has((i.name ?? '').toLowerCase()))
            .reduce((n, i) => n + Math.max(1, i.count), 0);
    }

    needEat() {
        if (!this.foodEnabled()) {
            return false;
        }
        if (!this.findBestFood()) {
            return false;
        }
        return Skills.effective('hitpoints') <= this.eatAtHp;
    }

    /** Primary bank item to withdraw for restock. */
    withdrawFoodName() {
        if (this.useCake) {
            return FOOD_CAKE;
        }
        if (this.useChocolate) {
            return FOOD_CHOC;
        }
        return null;
    }

    needFoodBank() {
        return this.foodEnabled() && this.foodCount() === 0;
    }

    isKeepOnDeposit(name) {
        const n = (name ?? '').toLowerCase();
        if (!n) {
            return false;
        }
        if (n === 'coins') {
            return true;
        }
        return this.foodPriorityNames().some(f => f.toLowerCase() === n);
    }

    stunned() {
        return Game.tick() <= this.stunnedUntilTick;
    }

    async loop() {
        this.syncPrefs({ silent: true });
        unlockPausedPrefsUi();

        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }
        if (await dismissWelcomeScreen()) {
            this.status = 'close welcome';
            return;
        }

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (!this.startReady) {
            await this.prepStartBank();
            return;
        }

        if (Bank.isOpen() && !this.needFoodBank()) {
            await Bank.close();
            return;
        }

        if (this.needEat()) {
            await this.eatFood();
            return;
        }

        if (this.needFoodBank()) {
            await this.bankFoodRestock();
            return;
        }

        if (this.stunned()) {
            this.status = 'stunned';
            await Execution.delayTicks(1);
            return;
        }

        const cfg = this.targetCfg();
        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(cfg.anchor) > cfg.leash) {
            this.status = `walking to ${cfg.name}`;
            await Traversal.walkResilient(cfg.anchor, {
                radius: 4,
                log: m => this.log(`  ${m}`)
            });
            return;
        }

        if (Game.inCombat()) {
            this.status = 'in combat — waiting';
            await Execution.delayTicks(2);
            return;
        }

        const npc = this.findTarget();
        if (!npc) {
            this.status = `waiting for ${cfg.name}`;
            await Traversal.walkTo(cfg.anchor, { radius: 3, timeoutMs: 8_000 });
            await this.openNearbyDoor();
            await Execution.delayTicks(2);
            return;
        }

        await this.pickpocket(npc);
    }

    findTarget() {
        const cfg = this.targetCfg();
        let q = Npcs.query()
            .name(cfg.name)
            .action(PICKPOCKET_OP)
            .within(cfg.leash + 4)
            .where(n => !n.inCombat);
        if (cfg.npcId != null) {
            q = q.where(n => n.id === cfg.npcId);
        }
        return q.nearest();
    }

    /**
     * Script start: unequip everything → deposit inventory → withdraw chosen food → go thieve.
     */
    async prepStartBank() {
        this.status = 'start: bank';

        for (const worn of Equipment.items()) {
            const name = worn.name;
            if (!name) {
                continue;
            }
            this.log(`start: unequipping ${name}`);
            if (!(await Equipment.unequip(name))) {
                this.log(`start: could not unequip ${name}`);
                await Execution.delayTicks(1);
                return;
            }
            await Execution.delayTicks(1);
        }

        if (!Bank.isOpen()) {
            this.log('start: opening bank — deposit all, then withdraw food');
            if (
                !(await Banking.open({
                    stand: BANK_STAND,
                    log: m => this.log(`  ${m}`)
                }))
            ) {
                this.log('start: could not open bank — retrying');
                await Execution.delayTicks(3);
                return;
            }
        }

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
        }
        await Execution.delayTicks(1);

        this.log('start: depositing inventory');
        if (typeof Bank.depositInventory === 'function') {
            await Bank.depositInventory();
        } else {
            await Bank.depositAllMatching(() => true);
        }
        await Execution.delayTicks(1);

        const want = this.withdrawFoodName();
        if (want && this.foodWithdraw > 0) {
            const inBank = Bank.count(want) || 0;
            if (inBank <= 0) {
                this.log(`WARNING: no ${want} in bank — add some, then restart / wait`);
                await Bank.close();
                await Execution.delayTicks(8);
                return;
            }
            const take = Math.min(this.foodWithdraw, inBank, Inventory.free());
            this.log(`start: withdrawing ${take}× ${want}`);
            if (!(await Bank.withdrawX(want, take))) {
                this.log(`start: withdraw failed for ${want}`);
                await Execution.delayTicks(2);
                return;
            }
            await Execution.delayTicks(1);
        }

        await Bank.close();
        this.bankTrips++;
        this.startReady = true;

        const cfg = this.targetCfg();
        this.status = `walking to ${cfg.name}`;
        this.log(
            `start done — walking to ${cfg.anchor.x},${cfg.anchor.z}` +
                (cfg.npcId != null ? ` for ${cfg.name} (id ${cfg.npcId})` : ` for ${cfg.name}`)
        );
        await Traversal.walkResilient(cfg.anchor, {
            radius: 3,
            log: m => this.log(`  ${m}`)
        });
    }

    async pickpocket(npc) {
        const beforeXp = Skills.xp('thieving');
        const t = npc.tile();
        this.status = `pickpocket ${npc.name ?? 'NPC'} (${npc.distance()}t)`;
        this.log(`Pickpocket ${npc.name} @ ${t.x},${t.z}`);

        if (!(await npc.interact(PICKPOCKET_OP))) {
            await this.openNearbyDoor();
            await Execution.delayTicks(1);
            return;
        }

        const ok = await Execution.delayUntil(
            () =>
                Skills.xp('thieving') > beforeXp ||
                this.stunned() ||
                Game.inCombat() ||
                ChatDialog.canContinue(),
            4000
        );

        if (Skills.xp('thieving') > beforeXp) {
            this.steals++;
            return;
        }

        if (!ok) {
            this.log('pickpocket did not resolve — retrying');
        }
    }

    async eatFood() {
        const food = this.findBestFood();
        if (!food) {
            return;
        }
        const before = Skills.effective('hitpoints');
        this.status = `eating ${food.name}`;
        this.log(`HP ${before} ≤ ${this.eatAtHp} — Eat ${food.name}`);
        if (!(await food.interact('Eat'))) {
            await Execution.delayTicks(1);
            return;
        }
        if (await Execution.delayUntil(() => Skills.effective('hitpoints') > before, 3000)) {
            this.eats++;
        }
    }

    /**
     * Out of food → East Ardougne bank, deposit junk, withdraw foodWithdraw of Cake / Chocolate slice.
     */
    async bankFoodRestock() {
        const want = this.withdrawFoodName();
        if (!want) {
            return;
        }

        this.status = 'banking food';
        const cfg = this.targetCfg();

        if (!Bank.isOpen()) {
            this.log(`out of food — banking, withdraw ${this.foodWithdraw}× ${want}`);
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

        await Bank.depositAllMatching(name => !this.isKeepOnDeposit(name));
        await Execution.delayTicks(1);

        const have = this.foodCount();
        const need = Math.max(0, this.foodWithdraw - have);
        if (need > 0) {
            const inBank = Bank.count(want) || 0;
            if (inBank <= 0) {
                this.log(`WARNING: no ${want} in bank — add some, then continue`);
                await Bank.close();
                await Execution.delayTicks(8);
                return;
            }
            const take = Math.min(need, inBank, Inventory.free());
            this.log(`withdrawing ${take}× ${want}`);
            if (!(await Bank.withdrawX(want, take))) {
                this.log(`withdraw failed for ${want}`);
                await Execution.delayTicks(2);
                return;
            }
            await Execution.delayTicks(1);
        }

        await Bank.close();
        this.bankTrips++;
        this.status = `returning to ${cfg.name}`;
        this.log(`restocked food (${this.foodCount()}) — returning to ${cfg.name}`);
        await Traversal.walkResilient(cfg.anchor, {
            radius: 4,
            log: m => this.log(`  ${m}`)
        });
    }

    async openNearbyDoor() {
        const door = Locs.query().where(l => isShutDoor(l)).within(6).nearest();
        if (!door) {
            return false;
        }
        const op = openDoorOp(door);
        if (!op) {
            return false;
        }
        this.status = 'opening door';
        this.log(`opening ${door.name}`);
        await door.interact(op);
        await Execution.delayTicks(2);
        return true;
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const xp = Skills.xp('thieving') - this.xpAtStart;
        const xph = hrs > 0.008 ? xp / hrs : 0;
        const cfg = this.targetCfg();
        const hp = Skills.effective('hitpoints');

        const lines = [
            `Benzyme's Ardougne Thiever`,
            `Time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `Target ${cfg.name}  ·  Thieving ${Skills.level('thieving')}`,
            `HP ${hp}/${Skills.level('hitpoints')}  ·  eat ≤ ${this.eatAtHp}  ·  food ${this.foodCount()}/${this.foodWithdraw}`,
            `steals ${this.steals}  fails ${this.fails}  eats ${this.eats}  banks ${this.bankTrips}`,
            `XP ${fmtXph(xph)}/hr  (+${Math.round(xp)} xp)`
        ];

        ctx.font = 'bold 13px monospace';
        let maxW = 0;
        for (const line of lines) {
            maxW = Math.max(maxW, ctx.measureText(line).width);
        }
        const pad = 6;
        const lineH = 17;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, 6, maxW + pad * 2, pad * 2 + lines.length * lineH);
        ctx.fillStyle = '#c9a227';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Thieving',
    tags: ['thieving', 'ardougne', 'pickpocket', 'guard', 'warrior', 'cake'],
    description:
        "Benzyme's Ardougne Thiever — pickpocket Warrior women or Guards; optional cake/choc food with HP eat slider",
    settingsSchema: {
        target: {
            type: 'string',
            default: 'Warrior woman',
            options: TARGET_OPTIONS,
            label: 'Pickpocket target',
            group: 'Thieving',
            help: 'Warrior woman id 15 at 2630,3297 (Thieving 25) or Guard in East Ardougne (Thieving 40)'
        },
        eatAtHp: {
            type: 'number',
            default: 10,
            min: 1,
            max: 30,
            label: 'Eat at hitpoints',
            group: 'Food',
            help: 'Eat enabled food when current HP is at or below this value (1–30)'
        },
        useCake: {
            type: 'boolean',
            default: true,
            label: 'Use Cake',
            group: 'Food',
            help: 'Eat Slice of cake → 2/3 cake → Cake (leftovers before another whole cake)'
        },
        useChocolate: {
            type: 'boolean',
            default: true,
            label: 'Use Chocolate slice',
            group: 'Food',
            help: 'Separate food option; eaten after cake slices / 2/3 when Cake is also on'
        },
        foodWithdraw: {
            type: 'number',
            default: 20,
            min: 1,
            max: 27,
            label: 'Amount to withdraw',
            group: 'Food',
            help: 'When out of food, bank and withdraw this many Cake (or Chocolate slice if Cake is off)'
        }
    },
    create: () => new ArdougneThiever()
});
