/**
 * ArdougneThiever — pickpocket Men / Warrior women / Guards / Knights in East Ardougne.
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
const PICKPOCKET_OP = 'Pickpocket';
const STUN_RE = /been stunned|fail to pick/i;
const STUN_TICKS = 9;

/** East Ardougne bank. */
const BANK_STAND = new Tile(2655, 3286, 0);

const TARGETS = {
    Man: {
        name: 'Man',
        npcId: null,
        thieving: 1,
        anchor: new Tile(2625, 3291, 0),
        leash: 14
    },
    'Warrior woman': {
        name: 'Warrior woman',
        /** Classic / RS2B cache id. */
        npcId: 15,
        thieving: 25,
        anchor: new Tile(2630, 3297, 0),
        leash: 16
    },
    'Ardougne guard': {
        /** In-game NPC name to match (no id filter). */
        name: 'Guard',
        npcId: null,
        thieving: 40,
        anchor: new Tile(2661, 3306, 0),
        leash: 19
    },
    'ardy knights': {
        /** In-game NPC name — East Ardougne market knights. */
        name: 'Knight of Ardougne',
        npcId: null,
        thieving: 55,
        anchor: new Tile(2662, 3305, 0),
        leash: 20
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

function fmtGp(n) {
    const v = Math.max(0, Math.round(n));
    if (v >= 1_000_000) {
        return `${(v / 1_000_000).toFixed(2)}m`;
    }
    if (v >= 100_000) {
        return `${(v / 1000).toFixed(0)}k`;
    }
    if (v >= 10_000) {
        return `${(v / 1000).toFixed(1)}k`;
    }
    return String(v);
}

function invCoins() {
    return Inventory.items()
        .filter(i => (i.name ?? '').toLowerCase() === 'coins')
        .reduce((n, i) => n + Math.max(0, i.count), 0);
}

function bankCoins() {
    return Bank.count('Coins') || 0;
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

/** Men thieving often needs house doors — Warrior/Guard/Knight are outdoors. */
function needsHouseDoors(cfg) {
    return (cfg?.name ?? '').toLowerCase() === 'man';
}

class ArdougneThiever extends LoopingBot {
    status = 'starting';
    targetKey = 'Warrior woman';
    /** Eat (with food) or wait for regen (waitForHp, no food) at/below this HP. */
    eatAtHp = 10;
    /** When food is off: pause pickpocketing until HP regenerates above eatAtHp. */
    waitForHp = false;
    useCake = true;
    useChocolate = true;
    /**
     * Which food family we currently withdraw/restock: 'cake' | 'choc'.
     * Flipped at the bank when the preferred food is gone but the other is available.
     */
    activeFood = 'cake';
    /** True after a mid-run cake↔choc swap so syncPrefs does not undo it. */
    foodFallbackLocked = false;
    /** How many of the primary food to withdraw when restocking. */
    foodWithdraw = 20;
    bankTrips = 0;
    /** False until start bank + food withdraw finishes. */
    startReady = false;

    steals = 0;
    fails = 0;
    eats = 0;
    /** Coins gained from successful pickpockets this session. */
    gpStolen = 0;
    /** Last known Coins stack in the bank (updated whenever bank is open). */
    bankGp = 0;
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

        this.foodFallbackLocked = false;
        this.syncPrefs({ silent: true });
        this.startedAt = Date.now();
        this.xpAtStart = Skills.xp('thieving');
        this.steals = 0;
        this.fails = 0;
        this.eats = 0;
        this.gpStolen = 0;
        this.bankGp = 0;
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
            `Benzyme's Ardougne Thiever — bank only if food < withdraw amount, then ` +
                `${cfg.name} @ ${cfg.anchor.x},${cfg.anchor.z}` +
                (cfg.npcId != null ? ` (id ${cfg.npcId})` : '') +
                `; HP ≤ ${this.eatAtHp}` +
                (this.foodEnabled()
                    ? ` eat; food ${this.describeFoodPrefs()} ×${this.foodWithdraw}`
                    : this.waitForHp
                      ? ' wait regen (no food)'
                      : `; food ${this.describeFoodPrefs()}`)
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
                `GP stolen ${fmtGp(this.gpStolen)}, bank ${fmtGp(this.bankGp)}gp, ` +
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
        this.waitForHp = readPrefBool('waitForHp', this.waitForHp);
        this.useCake = readPrefBool('useCake', this.useCake);
        this.useChocolate = readPrefBool('useChocolate', this.useChocolate);
        this.foodWithdraw = Math.max(
            1,
            Math.min(27, Math.round(readPrefNum('foodWithdraw', this.foodWithdraw)))
        );
        this.syncActiveFoodFromPrefs();

        if (!silent && prevTarget !== this.targetKey) {
            const cfg = this.targetCfg();
            this.log(`target → ${cfg.name} (need Thieving ${cfg.thieving})`);
        }
    }

    /** Prefer cake when Use Cake is on; otherwise chocolate. Skipped after a bank fallback swap. */
    syncActiveFoodFromPrefs() {
        if (this.foodFallbackLocked) {
            return;
        }
        if (this.useCake) {
            this.activeFood = 'cake';
        } else if (this.useChocolate) {
            this.activeFood = 'choc';
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
     * After a bank cake↔choc swap, stick to the active food family only.
     */
    foodPriorityNames() {
        if (!this.foodEnabled()) {
            return [];
        }
        if (this.foodFallbackLocked) {
            return this.activeFood === 'choc'
                ? [FOOD_CHOC]
                : [FOOD_SLICE, FOOD_TWO_THIRDS, FOOD_CAKE];
        }
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
        return this.useCake || this.useChocolate;
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

    /**
     * No-food mode: when waitForHp is on, pause thieving until HP regenerates above eatAtHp.
     * Ignored while cake/choc food is enabled (eating / banking handle HP instead).
     */
    needHpWait() {
        if (!this.waitForHp || this.foodEnabled()) {
            return false;
        }
        return Skills.effective('hitpoints') <= this.eatAtHp;
    }

    /** Primary bank item name for logs (current active food family). */
    withdrawFoodName() {
        if (!this.foodEnabled()) {
            return null;
        }
        return this.activeFood === 'choc' ? FOOD_CHOC : FOOD_CAKE;
    }

    /** Cake family withdraw order: whole Cake first, then leftovers. */
    cakeWithdrawNames() {
        return [FOOD_CAKE, FOOD_TWO_THIRDS, FOOD_SLICE];
    }

    /** Items to try withdrawing for the current active food family. */
    activeWithdrawNames() {
        if (!this.foodEnabled()) {
            return [];
        }
        return this.activeFood === 'choc' ? [FOOD_CHOC] : this.cakeWithdrawNames();
    }

    /** Items to try if the active family is empty in the bank. */
    alternateWithdrawNames() {
        return this.activeFood === 'choc' ? this.cakeWithdrawNames() : [FOOD_CHOC];
    }

    /**
     * Build a withdraw list filling up to `amount` from `names` in order (may mix cake leftovers).
     * @returns {{ name: string, take: number }[]}
     */
    buildWithdrawPlan(names, amount) {
        let need = Math.max(0, amount);
        let free = Inventory.free();
        const plan = [];
        for (const name of names) {
            if (need <= 0 || free <= 0) {
                break;
            }
            const inBank = Bank.count(name) || 0;
            if (inBank <= 0) {
                continue;
            }
            const take = Math.min(need, inBank, free);
            if (take <= 0) {
                continue;
            }
            plan.push({ name, take });
            need -= take;
            free -= take;
        }
        return plan;
    }

    /**
     * Bank open: prefer active food (Cake → 2/3 → Slice, or Chocolate), else swap families.
     * @returns {{ name: string, take: number }[] | null} plan, or null if no food in bank
     */
    resolveWithdrawPlan(amount) {
        if (!this.foodEnabled() || amount <= 0) {
            return null;
        }

        const primary = this.activeWithdrawNames();
        let plan = this.buildWithdrawPlan(primary, amount);
        if (plan.length > 0) {
            if (this.activeFood === 'cake' && plan[0].name !== FOOD_CAKE) {
                this.log(
                    `no ${FOOD_CAKE} in bank — withdrawing ${plan.map(p => `${p.take}× ${p.name}`).join(', ')}`
                );
            }
            return plan;
        }

        const alt = this.alternateWithdrawNames();
        plan = this.buildWithdrawPlan(alt, amount);
        if (plan.length > 0) {
            const next = this.activeFood === 'choc' ? 'cake' : 'choc';
            const label = plan.map(p => `${p.take}× ${p.name}`).join(', ');
            this.log(`no ${this.withdrawFoodName()} family in bank — swapping to ${label}`);
            this.activeFood = next;
            this.foodFallbackLocked = true;
            return plan;
        }

        return null;
    }

    /** Withdraw according to resolveWithdrawPlan. @returns {Promise<boolean>} */
    async withdrawResolvedFood(amount) {
        const plan = this.resolveWithdrawPlan(amount);
        if (!plan || plan.length === 0) {
            return false;
        }
        for (const { name, take } of plan) {
            this.log(`withdrawing ${take}× ${name}`);
            if (!(await Bank.withdrawX(name, take))) {
                this.log(`withdraw failed for ${name}`);
                return false;
            }
            await Execution.delayTicks(1);
        }
        return true;
    }

    /** Out of cake family and chocolate in bank — stop rather than sit waiting forever. */
    stopNoFood(context) {
        this.status = 'no food — stopped';
        this.log(
            `${context}: no Cake / 2/3 cake / Slice of cake / Chocolate slice in bank — stopping ` +
                '(restock food, then restart)'
        );
        stopScript();
    }

    needFoodBank() {
        return this.foodEnabled() && this.foodCount() === 0;
    }

    /** True when inventory already has at least foodWithdraw of enabled food. */
    hasEnoughStartFood() {
        return this.foodEnabled() && this.foodCount() >= this.foodWithdraw;
    }

    /** Snapshot bank Coins while the bank interface is open. */
    refreshBankGp() {
        if (!Bank.isOpen()) {
            return;
        }
        this.bankGp = bankCoins();
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

        if (this.needHpWait()) {
            const hp = Skills.effective('hitpoints');
            this.status = `HP ${hp} — regen above ${this.eatAtHp}`;
            await Execution.delayTicks(2);
            return;
        }

        if (this.stunned()) {
            this.status = 'stunned';
            await Execution.delayTicks(1);
            return;
        }

        // Not pickpocketing / not stunned — if trapped behind a shut door, open it and get outside.
        if (await this.escapeIfStuckBehindDoor()) {
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
            if (needsHouseDoors(cfg)) {
                await this.clearDoorsForMan(cfg.anchor);
            }
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
            // Door may have closed behind us while waiting — escape before wandering.
            if (await this.escapeIfStuckBehindDoor()) {
                return;
            }
            await Traversal.walkTo(cfg.anchor, { radius: 3, timeoutMs: 8_000 });
            if (needsHouseDoors(cfg)) {
                await this.clearDoorsForMan(cfg.anchor);
            } else {
                await this.openNearbyDoor();
            }
            await Execution.delayTicks(2);
            return;
        }

        if (needsHouseDoors(cfg)) {
            // Man may be inside a house — open doors before attempting pickpocket.
            await this.clearDoorsToward(npc.tile());
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
     * Script start: if inventory already has foodWithdraw of enabled food, skip bank.
     * With food off (wait-for-HP / no cakes), skip bank and walk to the target.
     * Otherwise unequip → deposit inventory → withdraw food → go thieve.
     */
    async prepStartBank() {
        if (!this.foodEnabled()) {
            this.startReady = true;
            const cfg = this.targetCfg();
            this.status = `walking to ${cfg.name}`;
            this.log(
                `start: food off` +
                    (this.waitForHp ? ` (wait HP ≤ ${this.eatAtHp})` : '') +
                    ` — skipping bank, walking to ${cfg.anchor.x},${cfg.anchor.z} for ${cfg.name}`
            );
            await Traversal.walkResilient(cfg.anchor, {
                radius: 3,
                log: m => this.log(`  ${m}`)
            });
            if (needsHouseDoors(cfg)) {
                await this.clearDoorsForMan(cfg.anchor);
            }
            return;
        }

        if (this.hasEnoughStartFood()) {
            this.startReady = true;
            const cfg = this.targetCfg();
            this.status = `walking to ${cfg.name}`;
            this.log(
                `start: already have ${this.foodCount()} food (≥ ${this.foodWithdraw}) — skipping bank, ` +
                    `walking to ${cfg.anchor.x},${cfg.anchor.z} for ${cfg.name}`
            );
            await Traversal.walkResilient(cfg.anchor, {
                radius: 3,
                log: m => this.log(`  ${m}`)
            });
            if (needsHouseDoors(cfg)) {
                await this.clearDoorsForMan(cfg.anchor);
            }
            return;
        }

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
        this.refreshBankGp();

        if (this.foodEnabled() && this.foodWithdraw > 0) {
            const need = Math.min(this.foodWithdraw, Inventory.free());
            if (!(await this.withdrawResolvedFood(need))) {
                await Bank.close();
                this.stopNoFood('start');
                return;
            }
        }

        this.refreshBankGp();
        await Bank.close();
        this.bankTrips++;
        this.startReady = true;

        const cfg = this.targetCfg();
        this.status = `walking to ${cfg.name}`;
        this.log(
            `start done — walking to ${cfg.anchor.x},${cfg.anchor.z}` +
                (cfg.npcId != null ? ` for ${cfg.name} (id ${cfg.npcId})` : ` for ${cfg.name}`) +
                ` (bank ${fmtGp(this.bankGp)}gp)`
        );
        await Traversal.walkResilient(cfg.anchor, {
            radius: 3,
            log: m => this.log(`  ${m}`)
        });
        if (needsHouseDoors(cfg)) {
            await this.clearDoorsForMan(cfg.anchor);
        }
    }

    async pickpocket(npc) {
        const beforeXp = Skills.xp('thieving');
        const coinsBefore = invCoins();
        const t = npc.tile();
        this.status = `pickpocket ${npc.name ?? 'NPC'} (${npc.distance()}t)`;
        this.log(`Pickpocket ${npc.name} @ ${t.x},${t.z}`);

        if (!(await npc.interact(PICKPOCKET_OP))) {
            if (needsHouseDoors(this.targetCfg())) {
                await this.clearDoorsToward(t);
            } else {
                await this.openNearbyDoor();
            }
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
            const gained = invCoins() - coinsBefore;
            if (gained > 0) {
                this.gpStolen += gained;
            }
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
     * Out of food → East Ardougne bank, deposit junk, withdraw foodWithdraw of cake family / chocolate.
     * Cake order: Cake → 2/3 cake → Slice of cake. If that family is empty, swap to the other;
     * if neither is in bank, stop the script.
     */
    async bankFoodRestock() {
        if (!this.foodEnabled()) {
            return;
        }

        this.status = 'banking food';
        const cfg = this.targetCfg();
        const prefer = this.withdrawFoodName();

        if (!Bank.isOpen()) {
            this.log(
                `out of food — banking, withdraw up to ${this.foodWithdraw}× ${prefer}` +
                    (this.activeFood === 'cake' ? ` / ${FOOD_TWO_THIRDS} / ${FOOD_SLICE}` : '') +
                    ` (fallback ${this.activeFood === 'cake' ? FOOD_CHOC : 'cake family'})`
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

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
        }
        await Execution.delayTicks(1);

        await Bank.depositAllMatching(name => !this.isKeepOnDeposit(name));
        await Execution.delayTicks(1);
        this.refreshBankGp();

        const have = this.foodCount();
        const need = Math.max(0, this.foodWithdraw - have);
        if (need > 0) {
            if (!(await this.withdrawResolvedFood(need))) {
                await Bank.close();
                this.stopNoFood('restock');
                return;
            }
        }

        this.refreshBankGp();
        await Bank.close();
        this.bankTrips++;
        this.status = `returning to ${cfg.name}`;
        this.log(
            `restocked food (${this.foodCount()}) — returning to ${cfg.name}` +
                ` (bank ${fmtGp(this.bankGp)}gp)`
        );
        await Traversal.walkResilient(cfg.anchor, {
            radius: 4,
            log: m => this.log(`  ${m}`)
        });
        if (needsHouseDoors(cfg)) {
            await this.clearDoorsForMan(cfg.anchor);
        }
    }

    /**
     * Open a shut door near the player, or near an optional tile (house doors by Men).
     * @param {{ within?: number, near?: { x: number, z: number } | null }} [opts]
     */
    async openNearbyDoor({ within = 6, near = null } = {}) {
        let q = Locs.query().where(l => isShutDoor(l));
        if (near) {
            const focus = Tile.from(near);
            q = q.where(l => Tile.from(l.tile()).distanceTo(focus) <= within);
        } else {
            q = q.within(within);
        }
        const door = q.nearest();
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

    /**
     * Shut door within a couple tiles of the player (typical "closed behind us" trap).
     */
    findAdjacentShutDoor(within = 2) {
        return (
            Locs.query()
                .where(l => isShutDoor(l))
                .within(within)
                .nearest() ?? null
        );
    }

    /**
     * True when a shut door is trapping us and we're not mid-pickpocket.
     * Skip while stunned / animating a steal, or when a thieve target is already in melee range.
     */
    isStuckBehindDoor() {
        if (this.stunned()) {
            return false;
        }
        if (typeof Game.animating === 'function' && Game.animating()) {
            return false;
        }
        const door = this.findAdjacentShutDoor(2);
        if (!door) {
            return false;
        }
        // Actively thieving someone next to us — don't treat as stuck.
        const npc = this.findTarget();
        if (npc && npc.distance() <= 1) {
            return false;
        }
        return true;
    }

    /**
     * Open shut doors around us and walk back to the outdoor thieving anchor.
     * @returns {Promise<boolean>} true if we acted on a trapping door
     */
    async escapeIfStuckBehindDoor() {
        if (!this.isStuckBehindDoor()) {
            return false;
        }

        const cfg = this.targetCfg();
        this.status = 'stuck behind door — escaping';

        for (let i = 0; i < 3; i++) {
            const door = this.findAdjacentShutDoor(2);
            if (!door) {
                break;
            }
            const op = openDoorOp(door);
            if (!op) {
                break;
            }
            const t = door.tile();
            this.log(
                `stuck behind ${door.name} @ ${t.x},${t.z} — opening to escape outside`
            );
            if (door.distance() > 1) {
                await Traversal.walkTo(t, { radius: 1, timeoutMs: 6_000 });
            }
            await door.interact(op);
            await Execution.delayUntil(
                () => {
                    const still = Locs.query()
                        .where(l => isShutDoor(l))
                        .where(l => {
                            const lt = l.tile();
                            return lt.x === t.x && lt.z === t.z;
                        })
                        .nearest();
                    return still === null;
                },
                4000
            );
            await Execution.delayTicks(1);
        }

        // Step back to the outdoor thieving spot.
        const here = Game.tile();
        if (here && Tile.from(here).distanceTo(cfg.anchor) > 3) {
            this.log(`escaping outside to ${cfg.name} @ ${cfg.anchor.x},${cfg.anchor.z}`);
            await Traversal.walkResilient(cfg.anchor, {
                radius: 4,
                log: m => this.log(`  ${m}`)
            });
        } else if (here) {
            // Nudge toward anchor even if already close (get off the doorway tile).
            await Traversal.walkTo(cfg.anchor, { radius: 3, timeoutMs: 8_000 });
        }

        return true;
    }

    /** Open shut doors around the Man anchor (houses near 2625,3291). */
    async clearDoorsForMan(anchor) {
        const focus = Tile.from(anchor);
        this.status = 'opening house doors';
        for (let i = 0; i < 4; i++) {
            const door = Locs.query()
                .where(l => isShutDoor(l))
                .where(l => Tile.from(l.tile()).distanceTo(focus) <= 10)
                .nearest();
            if (!door) {
                // No house door on anchor — still clear whatever is next to us.
                await this.openNearbyDoor({ within: 8 });
                break;
            }

            if (door.distance() > 2) {
                this.log(`walking to ${door.name} (${door.distance()}t)`);
                await Traversal.walkTo(door.tile(), { radius: 1, timeoutMs: 8_000 });
            }

            const op = openDoorOp(door);
            if (!op) {
                break;
            }
            this.log(`opening ${door.name} (Man house)`);
            const opened = await door.interact(op);
            await Execution.delayTicks(2);
            if (!opened && isShutDoor(door)) {
                // Stuck on this door — try a player-local one instead.
                if (!(await this.openNearbyDoor({ within: 8 }))) {
                    break;
                }
            }
        }
        await this.openNearbyDoor({ within: 8 });
    }

    /** Open doors near the player and near a Man NPC tile. */
    async clearDoorsToward(toward) {
        if (await this.openNearbyDoor({ within: 8 })) {
            return true;
        }
        if (!toward) {
            return false;
        }
        const door = Locs.query()
            .where(l => isShutDoor(l))
            .where(l => Tile.from(l.tile()).distanceTo(Tile.from(toward)) <= 5)
            .nearest();
        if (!door) {
            return false;
        }
        if (door.distance() > 2) {
            await Traversal.walkTo(door.tile(), { radius: 1, timeoutMs: 8_000 });
        }
        const op = openDoorOp(door);
        if (!op) {
            return false;
        }
        this.status = 'opening door';
        this.log(`opening ${door.name} (toward Man)`);
        await door.interact(op);
        await Execution.delayTicks(2);
        return true;
    }

    onPaint(ctx) {
        if (Bank.isOpen()) {
            this.refreshBankGp();
        }
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const xp = Skills.xp('thieving') - this.xpAtStart;
        const xph = hrs > 0.008 ? xp / hrs : 0;
        const cfg = this.targetCfg();
        const hp = Skills.effective('hitpoints');

        const hpMode = this.foodEnabled()
            ? `eat ≤ ${this.eatAtHp}  ·  food ${this.foodCount()}/${this.foodWithdraw}`
            : this.waitForHp
              ? `wait ≤ ${this.eatAtHp}  ·  food off`
              : `HP thresh ${this.eatAtHp}  ·  food off`;

        const lines = [
            `Benzyme's Ardougne Thiever`,
            `Time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `Target ${cfg.name}  ·  Thieving ${Skills.level('thieving')}`,
            `HP ${hp}/${Skills.level('hitpoints')}  ·  ${hpMode}`,
            `steals ${this.steals}  fails ${this.fails}  eats ${this.eats}  banks ${this.bankTrips}`,
            `GP stolen ${fmtGp(this.gpStolen)}  ·  bank ${fmtGp(this.bankGp)}gp`,
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
    version: '1.4.0',
    category: 'Thieving',
    tags: ['thieving', 'ardougne', 'pickpocket', 'man', 'guard', 'warrior', 'knight', 'cake'],
    description:
        "Benzyme's Ardougne Thiever — pickpocket Men, Warrior women, Ardougne guards, or ardy knights; cake/choc food or wait-for-HP regen with shared HP threshold slider",
    settingsSchema: {
        target: {
            type: 'string',
            default: 'Warrior woman',
            options: TARGET_OPTIONS,
            label: 'Pickpocket target',
            group: 'Thieving',
            help: 'Man at 2625,3291 (Thieving 1; opens house doors as needed), Warrior woman id 15 at 2630,3297 (Thieving 25), Ardougne guard by name Guard (Thieving 40), or ardy knights (Knight of Ardougne, Thieving 55) in the East Ardougne market'
        },
        eatAtHp: {
            type: 'number',
            default: 10,
            min: 1,
            max: 30,
            label: 'Hitpoints threshold',
            group: 'Food',
            help: 'With food on: eat at or below this HP. With Wait for HP regen on (and cake/choc off): pause thieving until HP regenerates above this (1–30)'
        },
        waitForHp: {
            type: 'boolean',
            default: false,
            label: 'Wait for HP regen (no food)',
            group: 'Food',
            help: 'For accounts with no cakes: when Cake and Chocolate are both off, pause pickpocketing at/below the Hitpoints threshold until HP regenerates. Ignored while food is enabled. PLEASE UNTICK USING CAKE AND CHOCOLATE SLICE OTHERWISE WE WILL SIT AT THE BANK WAITING FOR FOOD THAT WILL NEVER COME :('
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
            help: 'When out of food, bank and withdraw this many of the active food. Cake order: Cake → 2/3 cake → Slice of cake (can mix). If that family is empty, auto-swaps to Chocolate (or cake family); stops if neither is in the bank.'
        }
    },
    create: () => new ArdougneThiever()
});
