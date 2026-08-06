/**
 * ProgressiveWcFletcher — Falador regular trees → Oaks (sell bows) when WC≥15 and Fletch≥20.
 * Phase 1: FaladorTreeFletcher (shafts / shortbow / longbow + bank).
 * Phase 2: OakTreeFletcherSell (oak short/longbow → Varrock General → bank GP).
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('ProgressiveWcFletcher: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `ProgressiveWcFletcher: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Locs,
    Npcs,
    GroundItems,
    Inventory,
    Equipment,
    Bank,
    Banking,
    Shop,
    Traversal,
    Tile,
    Skills,
    ChatDialog,
    AXES,
    bestAxe,
    canWieldTool
} = abi;

const SCRIPT_NAME = 'ProgressiveWcFletcher';

/** Switch to oaks only when both are met. */
const OAK_WC_REQ = 15;
const OAK_FLETCH_REQ = 20;

/** Lumbridge knife spawn (behind Bob's) + Bob steel axe / repair. */
const GEAR_KNIFE_SPAWN = new Tile(3224, 3202, 0);
const GEAR_BOB_STAND = new Tile(3231, 3203, 0);
const GEAR_STEEL_AXE = 'Steel axe';
const GEAR_STEEL_COST = 200;
const GEAR_BROKEN_AXE = 'Broken axe';
const GEAR_REPAIR_PREFER = ['repair', 'fix', 'fix my', 'yes'];
const GEAR_REPAIR_COIN_FLOAT = 100;

/** Phase 1 — Falador regular trees. */
const FALADOR_ANCHOR = new Tile(2953, 3407, 0);
const FALADOR_LEASH = 15;
const FALADOR_TREE = 'Tree';
const FALADOR_LOG = 'Logs';
const FALADOR_SHORT_LVL = 5;
const FALADOR_LONG_LVL = 10;

/** Phase 2 — Oaks north of Varrock. */
const OAK_ANCHOR = new Tile(3166, 3416, 0);
const OAK_LEASH = 20;
const OAK_TREE = 'Oak';
const OAK_SHORT_LVL = 20;
const OAK_LONG_LVL = 25;

/** Varrock General Store + West bank (oak sell loop). */
const STORE_STAND = new Tile(3218, 3414, 0);
const STORE_KEEPER = 'Shop keeper';
const VARROCK_WEST_BANK = new Tile(3185, 3440, 0);

const KEEP_TOOLS = [
    'knife',
    'broken axe',
    'bronze axe',
    'iron axe',
    'steel axe',
    'black axe',
    'mithril axe',
    'adamant axe',
    'rune axe'
];

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

function gearAxeRank(name) {
    const want = (name ?? '').toLowerCase();
    const i = AXES.findIndex(t => t.name.toLowerCase() === want);
    return i < 0 ? 999 : i;
}

function gearHasKnife() {
    return (
        Inventory.count('Knife') > 0 ||
        Inventory.items().some(i => (i.name ?? '').toLowerCase() === 'knife')
    );
}

function gearInvCoins() {
    return Inventory.items()
        .filter(i => (i.name ?? '').toLowerCase() === 'coins')
        .reduce((n, i) => n + Math.max(0, i.count), 0);
}

function gearBankCoins() {
    return Bank.count('Coins') || 0;
}

function gearAxeCount(name) {
    return (Inventory.count(name) || 0) + (Equipment.contains(name) ? 1 : 0);
}

function gearBestHeldAxe() {
    return bestAxe(Skills.level('woodcutting'), n => gearAxeCount(n) > 0);
}

function gearHasSteelOrBetter() {
    const steelRank = gearAxeRank(GEAR_STEEL_AXE);
    for (const t of AXES) {
        if (gearAxeRank(t.name) > steelRank) {
            continue;
        }
        if (gearAxeCount(t.name) > 0) {
            return true;
        }
        if (Bank.isOpen() && (Bank.count(t.name) || 0) > 0) {
            return true;
        }
    }
    return false;
}

function gearHasBrokenAxe() {
    return (
        Equipment.contains(GEAR_BROKEN_AXE) ||
        (Inventory.count(GEAR_BROKEN_AXE) || 0) > 0 ||
        Inventory.items().some(i => (i.name ?? '').toLowerCase() === 'broken axe')
    );
}

function gearPickRepairOption(options) {
    for (const p of GEAR_REPAIR_PREFER) {
        const hit = options.find(o => (o ?? '').toLowerCase().includes(p.toLowerCase()));
        if (hit) {
            return hit;
        }
    }
    return options.length > 0 ? options[options.length - 1] : null;
}

async function gearDriveRepairDialog(log) {
    for (let i = 0; i < 80; i++) {
        if (!ChatDialog.isOpen() && !ChatDialog.canContinue()) {
            if (!(await Execution.delayUntil(() => ChatDialog.isOpen() || ChatDialog.canContinue(), 1500))) {
                break;
            }
        }
        if (ChatDialog.canContinue()) {
            await ChatDialog.continue();
            await Execution.delayTicks(1);
            continue;
        }
        const opts = typeof ChatDialog.options === 'function' ? ChatDialog.options() : [];
        if (opts.length > 0) {
            const pick = gearPickRepairOption(opts);
            if (!pick) {
                log(`gear: no repair option in [${opts.join(' | ')}]`);
                return false;
            }
            await ChatDialog.chooseOption(pick);
            await Execution.delayTicks(2);
            continue;
        }
        await Execution.delayTicks(1);
    }
    return !ChatDialog.isOpen();
}

async function gearWaitBankLoaded() {
    if (typeof Bank.loaded === 'function') {
        await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
    }
    await Execution.delayTicks(1);
}

function chopOp(actions) {
    return actions.find(a => /chop/i.test(a)) ?? null;
}

function isKeepTool(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    return KEEP_TOOLS.some(k => n === k || n.includes(k));
}

function normName(name) {
    return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function meetsOakReqs() {
    return Skills.level('woodcutting') >= OAK_WC_REQ && Skills.level('fletching') >= OAK_FLETCH_REQ;
}

/* ── Falador product classifiers ── */

function isFaladorShortbow(name) {
    const n = normName(name);
    if (n.includes('oak')) {
        return false;
    }
    return n === 'shortbow' || n === 'short bow';
}

function isFaladorLongbow(name) {
    const n = normName(name);
    if (n.includes('oak')) {
        return false;
    }
    if (n === 'longbow' || n === 'long bow') {
        return true;
    }
    return (
        n.includes('long') &&
        n.includes('bow') &&
        (n.includes('(u)') || n.includes('unstrung'))
    );
}

function isFaladorBow(name) {
    return isFaladorShortbow(name) || isFaladorLongbow(name);
}

function isShaft(name) {
    return normName(name).includes('arrow shaft');
}

function isFaladorLog(name) {
    const n = normName(name);
    return n === 'logs' || n === 'log';
}

/* ── Oak product classifiers ── */

function isOakShortbow(name) {
    const n = normName(name);
    return n.includes('oak') && n.includes('short') && n.includes('bow');
}

function isOakLongbow(name) {
    const n = normName(name);
    return n.includes('oak') && n.includes('long') && n.includes('bow');
}

function isOakBow(name) {
    return isOakShortbow(name) || isOakLongbow(name);
}

function isOakLog(name) {
    const n = normName(name);
    return n === 'oak logs' || n === 'oak log';
}

function isCoins(name) {
    return normName(name) === 'coins';
}

function faladorPlan(level) {
    if (level < FALADOR_SHORT_LVL) {
        return { id: 'shafts', menuMatch: 'shaft', label: 'Arrow shafts', bank: false };
    }
    if (level < FALADOR_LONG_LVL) {
        return { id: 'shortbow', menuMatch: 'short', label: 'Shortbow', bank: true };
    }
    return { id: 'longbow', menuMatch: 'long', label: 'Longbow', bank: true };
}

function oakPlan(level) {
    if (level < OAK_SHORT_LVL) {
        return {
            id: 'oak-logs',
            menuMatch: '',
            label: 'Oak logs (bank)',
            fletch: false,
            sell: false
        };
    }
    if (level < OAK_LONG_LVL) {
        return {
            id: 'oak-shortbow',
            menuMatch: 'short',
            label: 'Oak shortbow',
            fletch: true,
            sell: true
        };
    }
    return {
        id: 'oak-longbow',
        menuMatch: 'long',
        label: 'Oak longbow',
        fletch: true,
        sell: true
    };
}

function matchMakeProduct(products, menuMatch, preferOak) {
    const want = menuMatch.toLowerCase();
    let pool = products;
    if (preferOak) {
        const oakish = products.filter(p => (p ?? '').toLowerCase().includes('oak'));
        if (oakish.length > 0) {
            pool = oakish;
        }
    } else {
        const plain = products.filter(p => !(p ?? '').toLowerCase().includes('oak'));
        if (plain.length > 0) {
            pool = plain;
        }
    }
    return pool.find(p => (p ?? '').toLowerCase().includes(want)) ?? null;
}

function knifeItem() {
    return (
        Inventory.items().find(i => (i.name ?? '').toLowerCase().includes('knife')) ?? null
    );
}

function countPred(pred) {
    return Inventory.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function faladorLogCount() {
    return Inventory.count(FALADOR_LOG);
}

function oakLogCount() {
    return countPred(isOakLog);
}

function faladorBowCount() {
    return countPred(isFaladorBow);
}

function oakBowCount() {
    return countPred(isOakBow);
}

function shaftCount() {
    return countPred(isShaft);
}

function coinCount() {
    return Inventory.items()
        .filter(i => isCoins(i.name))
        .reduce((n, i) => n + Math.max(0, i.count), 0);
}

function lastLogMatching(pred) {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        if (pred(items[i].name)) {
            return items[i];
        }
    }
    return null;
}

function faladorHasBankables() {
    const flvl = Skills.level('fletching');
    if (faladorLogCount() > 0) {
        return true;
    }
    if (faladorBowCount() > 0) {
        return true;
    }
    return flvl >= FALADOR_SHORT_LVL && shaftCount() > 0;
}

function needsFaladorBank(plan) {
    if (faladorLogCount() > 0) {
        return false;
    }
    if (plan.bank && faladorBowCount() > 0) {
        return true;
    }
    return Skills.level('fletching') >= FALADOR_SHORT_LVL && shaftCount() > 0;
}

function needsOakSell(plan) {
    if (!plan.sell || !plan.fletch) {
        return false;
    }
    if (oakLogCount() > 0) {
        return false;
    }
    return oakBowCount() > 0;
}

function oakBowNamesHeld() {
    const names = [];
    const seen = new Set();
    for (const item of Inventory.items()) {
        if (!isOakBow(item.name) || !item.name) {
            continue;
        }
        const key = item.name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(item.name);
    }
    return names;
}

function countByExactName(name) {
    return Inventory.items()
        .filter(i => (i.name ?? '').toLowerCase() === name.toLowerCase())
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

class ProgressiveWcFletcher extends LoopingBot {
    /** @type {'falador' | 'oak'} */
    phase = 'falador';
    status = 'starting';
    startedAt = 0;
    wcXpAtStart = 0;
    fletchXpAtStart = 0;
    chopped = 0;
    fletched = 0;
    bankTrips = 0;
    sellTrips = 0;
    soldBows = 0;
    /** Last known Coins stack in the bank (updated after each GP deposit). */
    totalGpEarned = 0;
    planId = 'shafts';
    gearReady = false;
    needSteelBuy = false;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.startedAt = Date.now();
        this.wcXpAtStart = Skills.xp('woodcutting');
        this.fletchXpAtStart = Skills.xp('fletching');
        this.totalGpEarned = 0;
        this.phase = meetsOakReqs() ? 'oak' : 'falador';
        this.planId =
            this.phase === 'oak'
                ? oakPlan(Skills.level('fletching')).id
                : faladorPlan(Skills.level('fletching')).id;
        this.gearReady = false;
        this.needSteelBuy = false;

        this.on('skill.level', e => {
            if (e.name === 'fletching' || e.name === 'woodcutting') {
                this.log(`${e.name} ${e.previous} → ${e.level}`);
            }
            if (e.name === 'woodcutting' && e.previous < 6 && e.level >= 6 && !gearHasSteelOrBetter()) {
                this.needSteelBuy = true;
            }
            if (this.phase === 'falador' && meetsOakReqs()) {
                this.log(
                    `reqs met (WC ${OAK_WC_REQ}+ / Fletch ${OAK_FLETCH_REQ}+) — will switch to oaks after clearing Falador pack`
                );
            }
        });

        if (this.phase === 'oak') {
            this.log(
                `ProgressiveWcFletcher — starting on OAKS @ ${OAK_ANCHOR.x},${OAK_ANCHOR.z} ` +
                    `(already WC ${Skills.level('woodcutting')} / Fletch ${Skills.level('fletching')})`
            );
        } else {
            this.log(
                `ProgressiveWcFletcher — Falador trees @ ${FALADOR_ANCHOR.x},${FALADOR_ANCHOR.z} ` +
                    `until WC ${OAK_WC_REQ} + Fletch ${OAK_FLETCH_REQ} (now WC ${Skills.level('woodcutting')} / ` +
                    `Fletch ${Skills.level('fletching')})`
            );
        }
        this.status = 'ready';
    }

    async loop() {
        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (await this.prepWcGear()) {
            return;
        }

        if (Shop.isOpen()) {
            await Shop.close();
            return;
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        // Promote Falador → Oak when both skills meet the gate.
        if (this.phase === 'falador' && meetsOakReqs()) {
            await this.transitionToOaks();
            return;
        }

        if (this.phase === 'oak') {
            await this.loopOak();
        } else {
            await this.loopFalador();
        }
    }

    /**
     * Bank leftover Falador products, then walk to the oak camp and flip phase.
     */
    async transitionToOaks() {
        if (faladorHasBankables() || oakLogCount() > 0) {
            this.status = 'phase clear — banking';
            this.log('banking Falador leftovers before oaks');
            await Banking.bankNearest({
                deposit: name => {
                    if (isKeepTool(name)) {
                        return false;
                    }
                    return (
                        isShaft(name) ||
                        isFaladorBow(name) ||
                        isFaladorLog(name) ||
                        isOakLog(name) ||
                        isOakBow(name)
                    );
                },
                afterDeposit: async () => {
                    if ((Bank.count(GEAR_BROKEN_AXE) || 0) > 0 && !gearHasBrokenAxe()) {
                        this.log('gear: withdrawing Broken axe');
                        await Bank.withdrawX(GEAR_BROKEN_AXE, 1);
                    }
                    this.maybeQueueSteelBuy();
                },
                returnTo: null,
                log: m => this.log(`  ${m}`)
            });
            this.bankTrips++;
            return;
        }

        this.status = 'phase — walking to oaks';
        this.log(
            `switching to oaks @ ${OAK_ANCHOR.x},${OAK_ANCHOR.z} ` +
                `(WC ${Skills.level('woodcutting')} / Fletch ${Skills.level('fletching')})`
        );
        await Traversal.walkResilient(OAK_ANCHOR, {
            radius: 4,
            log: m => this.log(`  ${m}`)
        });
        this.phase = 'oak';
        this.planId = oakPlan(Skills.level('fletching')).id;
        this.status = 'oaks ready';
        this.log('now on oak progression (sell bows → bank GP)');
    }

    /* ═══════════ Phase 1: Falador ═══════════ */

    async loopFalador() {
        const plan = faladorPlan(Skills.level('fletching'));
        this.planId = plan.id;

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan, false, () => faladorLogCount());
            return;
        }

        if (faladorLogCount() > 0 && Inventory.isFull()) {
            await this.fletchLogs(plan, false, faladorLogCount, n => isFaladorLog(n));
            return;
        }

        if (
            faladorLogCount() > 0 &&
            Game.animating() &&
            faladorBowCount() === 0 &&
            !this.findTree(FALADOR_TREE, FALADOR_ANCHOR, FALADOR_LEASH, 2)
        ) {
            this.status = `fletching ${plan.label}`;
            await Execution.delayTicks(1);
            return;
        }

        if (needsFaladorBank(plan)) {
            await this.bankFaladorAndReturn();
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(FALADOR_ANCHOR) > FALADOR_LEASH) {
            this.status = 'returning to Falador trees';
            await Traversal.walkResilient(FALADOR_ANCHOR, {
                radius: 4,
                log: m => this.log(`  ${m}`)
            });
            return;
        }

        if (Game.animating()) {
            this.status = 'chopping';
            await Execution.delayTicks(1);
            return;
        }

        const tree = this.findTree(FALADOR_TREE, FALADOR_ANCHOR, FALADOR_LEASH);
        if (!tree) {
            this.status = 'waiting for tree';
            await Traversal.walkTo(FALADOR_ANCHOR, { radius: 3, timeoutMs: 10_000 });
            await Execution.delayTicks(2);
            return;
        }

        await this.chopTree(tree, faladorLogCount, 'Tree');
    }

    async bankFaladorAndReturn() {
        const flvl = Skills.level('fletching');
        const bows = faladorBowCount();
        const shorts = countPred(isFaladorShortbow);
        const shafts = shaftCount();
        this.status = 'banking';
        this.log(
            `banking` +
                (shorts ? ` ${shorts} Shortbow` : '') +
                (bows - shorts > 0 ? ` ${bows - shorts} Longbow` : '') +
                (shafts && flvl >= FALADOR_SHORT_LVL ? ` ${shafts} arrow shafts` : '') +
                ` (fletching ${flvl})`
        );

        await Banking.bankNearest({
            deposit: name => {
                if (isKeepTool(name)) {
                    return false;
                }
                if (isShaft(name)) {
                    return flvl >= FALADOR_SHORT_LVL;
                }
                if (isFaladorBow(name)) {
                    return true;
                }
                return isFaladorLog(name);
            },
            afterDeposit: async () => {
                if ((Bank.count(GEAR_BROKEN_AXE) || 0) > 0 && !gearHasBrokenAxe()) {
                    this.log('gear: withdrawing Broken axe');
                    await Bank.withdrawX(GEAR_BROKEN_AXE, 1);
                }
                this.maybeQueueSteelBuy();
            },
            returnTo: FALADOR_ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.status = 'returning to trees';
    }

    /* ═══════════ Phase 2: Oaks + sell ═══════════ */

    async loopOak() {
        const plan = oakPlan(Skills.level('fletching'));
        this.planId = plan.id;

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan, true, () => oakLogCount());
            return;
        }

        if (plan.fletch && oakLogCount() > 0 && Inventory.isFull()) {
            await this.fletchLogs(plan, true, oakLogCount, isOakLog);
            return;
        }

        if (
            plan.fletch &&
            oakLogCount() > 0 &&
            Game.animating() &&
            oakBowCount() === 0 &&
            !this.findTree(OAK_TREE, OAK_ANCHOR, OAK_LEASH, 2)
        ) {
            this.status = `fletching ${plan.label}`;
            await Execution.delayTicks(1);
            return;
        }

        if (needsOakSell(plan)) {
            await this.sellOakBowsBankGpAndReturn();
            return;
        }

        // Safety if somehow below 20 while on oak phase.
        if (!plan.fletch && oakLogCount() > 0 && Inventory.isFull()) {
            this.status = 'banking oak logs';
            await Banking.bankNearest({
                deposit: name => !isKeepTool(name) && isOakLog(name),
                afterDeposit: async () => {
                    if ((Bank.count(GEAR_BROKEN_AXE) || 0) > 0 && !gearHasBrokenAxe()) {
                        this.log('gear: withdrawing Broken axe');
                        await Bank.withdrawX(GEAR_BROKEN_AXE, 1);
                    }
                    this.maybeQueueSteelBuy();
                },
                returnTo: OAK_ANCHOR,
                log: m => this.log(`  ${m}`)
            });
            this.bankTrips++;
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(OAK_ANCHOR) > OAK_LEASH) {
            this.status = 'returning to oaks';
            await Traversal.walkResilient(OAK_ANCHOR, {
                radius: 4,
                log: m => this.log(`  ${m}`)
            });
            return;
        }

        if (Game.animating()) {
            this.status = 'chopping';
            await Execution.delayTicks(1);
            return;
        }

        const tree = this.findTree(OAK_TREE, OAK_ANCHOR, OAK_LEASH);
        if (!tree) {
            this.status = 'waiting for oak';
            await Traversal.walkTo(OAK_ANCHOR, { radius: 3, timeoutMs: 10_000 });
            await Execution.delayTicks(2);
            return;
        }

        await this.chopTree(tree, oakLogCount, 'Oak');
    }

    async sellOakBowsBankGpAndReturn() {
        const bows = oakBowCount();
        const shorts = countPred(isOakShortbow);
        this.status = 'walking to Varrock store';
        this.log(
            `selling` +
                (shorts ? ` ${shorts} Oak shortbow` : '') +
                (bows - shorts > 0 ? ` ${bows - shorts} Oak longbow` : '') +
                ` at Varrock General Store`
        );

        await Traversal.walkResilient(STORE_STAND, {
            radius: 2,
            log: m => this.log(`  ${m}`)
        });

        this.status = 'opening shop';
        if (!(await Shop.open(STORE_KEEPER))) {
            this.log('could not open Shop keeper — retrying next loop');
            await Execution.delayTicks(3);
            return;
        }

        this.status = 'selling bows';
        let sold = 0;
        for (let guard = 0; guard < 60 && oakBowCount() > 0 && Shop.isOpen(); guard++) {
            const names = oakBowNamesHeld();
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
            if (oakBowCount() > 0) {
                await Execution.delayTicks(1);
            }
        }

        if (Shop.isOpen()) {
            await Shop.close();
        }

        this.soldBows += sold;
        this.sellTrips++;

        if (oakBowCount() > 0) {
            this.log(`WARNING: still holding ${oakBowCount()} oak bows — will retry`);
            await Execution.delayTicks(3);
            return;
        }

        const gp = coinCount();
        this.status = 'banking GP';
        this.log(`banking ${gp} coins at Varrock West`);

        await Banking.bankNearest({
            destination: { name: 'Varrock West', tile: VARROCK_WEST_BANK },
            deposit: name => {
                if (isKeepTool(name)) {
                    return false;
                }
                return isCoins(name) || isOakBow(name) || isOakLog(name);
            },
            afterDeposit: async () => {
                if ((Bank.count(GEAR_BROKEN_AXE) || 0) > 0 && !gearHasBrokenAxe()) {
                    this.log('gear: withdrawing Broken axe');
                    await Bank.withdrawX(GEAR_BROKEN_AXE, 1);
                }
                await this.refreshBankGp();
                this.maybeQueueSteelBuy();
            },
            returnTo: OAK_ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.status = 'returning to oaks';
    }

    /** Read Coins currently stored in the open bank → totalGpEarned. */
    async refreshBankGp() {
        if (!Bank.isOpen()) {
            return;
        }
        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.count('Coins') > 0, 2500);
        }
        await Execution.delayTicks(1);
        const bankCoins = Bank.count('Coins');
        this.totalGpEarned = bankCoins;
        this.log(`bank GP: ${bankCoins}`);
    }

    /* ═══════════ Gear bootstrap (axe / knife / Bob steel) ═══════════ */

    maybeQueueSteelBuy() {
        if (gearHasSteelOrBetter()) {
            this.needSteelBuy = false;
            return;
        }
        if (Skills.level('woodcutting') < 6) {
            return;
        }
        if (Bank.isOpen() && gearBankCoins() + gearInvCoins() >= GEAR_STEEL_COST) {
            this.needSteelBuy = true;
        }
    }

    /**
     * Use Broken axe on Bob and drive the repair dialogue.
     * @returns {Promise<boolean>} always true (spent this loop on repair)
     */
    async repairBrokenAxeAtBob() {
        this.status = 'gear: repair';

        if (Shop.isOpen()) {
            await Shop.close();
            return true;
        }

        if (Equipment.contains(GEAR_BROKEN_AXE) && !Inventory.isFull()) {
            this.log('gear: unequipping Broken axe');
            await Equipment.unequip(GEAR_BROKEN_AXE);
            await Execution.delayTicks(1);
        }

        if (!gearHasBrokenAxe()) {
            if (!Bank.isOpen()) {
                if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                    await Execution.delayTicks(3);
                    return true;
                }
            }
            await gearWaitBankLoaded();
            if ((Bank.count(GEAR_BROKEN_AXE) || 0) > 0) {
                this.log('gear: withdrawing Broken axe from bank');
                await Bank.withdrawX(GEAR_BROKEN_AXE, 1);
                await Execution.delayTicks(1);
            } else {
                await Bank.close();
                return true;
            }
        }

        if (gearInvCoins() < GEAR_REPAIR_COIN_FLOAT) {
            if (!Bank.isOpen()) {
                if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                    this.log('gear: could not open bank for repair coins — trying Bob anyway');
                }
            }
            if (Bank.isOpen()) {
                await gearWaitBankLoaded();
                const need = GEAR_REPAIR_COIN_FLOAT - gearInvCoins();
                const have = gearBankCoins();
                if (need > 0 && have > 0) {
                    await Bank.withdrawX('Coins', Math.min(need, have));
                    await Execution.delayTicks(1);
                }
                await Bank.close();
                await Execution.delayTicks(1);
            }
        } else if (Bank.isOpen()) {
            await Bank.close();
            await Execution.delayTicks(1);
        }

        const broken = Inventory.first(GEAR_BROKEN_AXE);
        if (!broken) {
            this.log('gear: Broken axe not in pack after prep');
            await Execution.delayTicks(3);
            return true;
        }

        this.log('gear: walking to Bob to repair Broken axe');
        await Traversal.walkResilient(GEAR_BOB_STAND, {
            radius: 2,
            log: m => this.log(`  ${m}`)
        });

        const bob = Npcs.query().name('Bob').within(12).nearest();
        if (!bob) {
            this.log('gear: Bob not nearby — retrying');
            await Execution.delayTicks(3);
            return true;
        }

        const before = Inventory.count(GEAR_BROKEN_AXE) || 0;
        this.log('gear: using Broken axe on Bob');
        if (!(await broken.useOn(bob))) {
            this.log('gear: use-on Bob failed');
            await Execution.delayTicks(2);
            return true;
        }

        if (!(await Execution.delayUntil(() => ChatDialog.isOpen() || ChatDialog.canContinue(), 8000))) {
            this.log('gear: Bob never opened repair dialogue');
            await Execution.delayTicks(3);
            return true;
        }

        await gearDriveRepairDialog(m => this.log(m));
        await Execution.delayTicks(2);

        const after = Inventory.count(GEAR_BROKEN_AXE) || 0;
        if (after < before || !gearHasBrokenAxe()) {
            this.log('gear: axe repaired at Bob');
            const held = gearBestHeldAxe();
            if (held && !Equipment.contains(held) && canWieldTool(held, Skills.level('attack'))) {
                await Equipment.equip(held);
            }
            if (!gearBestHeldAxe() || !gearHasKnife()) {
                this.gearReady = false;
            }
        } else {
            this.log('gear: Bob did not repair — will retry');
        }
        return true;
    }

    /** @returns {Promise<boolean>} true if this loop spent time on gear prep */
    async prepWcGear() {
        if (ChatDialog.isMakeMenu()) {
            return false;
        }

        // Broken axe always wins — take it to Bob before anything else.
        if (gearHasBrokenAxe() || (Bank.isOpen() && (Bank.count(GEAR_BROKEN_AXE) || 0) > 0)) {
            return await this.repairBrokenAxeAtBob();
        }

        if (this.gearReady && !this.needSteelBuy) {
            return false;
        }

        if (this.needSteelBuy && Shop.isOpen()) {
            return await this.buySteelAtOpenShop();
        }

        if (Shop.isOpen()) {
            await Shop.close();
            return true;
        }

        if (!this.gearReady) {
            return await this.bootstrapWcGear();
        }

        if (this.needSteelBuy) {
            return await this.runSteelAxeBuy();
        }

        return false;
    }

    async bootstrapWcGear() {
        this.status = 'gear: bank';

        if (!Bank.isOpen()) {
            this.log('gear: opening bank for best axe / knife');
            if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                this.log('gear: could not open bank — retrying');
                await Execution.delayTicks(3);
                return true;
            }
        }

        await gearWaitBankLoaded();

        if (Inventory.free() < 2) {
            await Bank.depositAllMatching(name => {
                const n = (name ?? '').toLowerCase();
                if (!n || n === 'coins' || n === 'knife') {
                    return false;
                }
                if (isKeepTool(name)) {
                    return false;
                }
                return true;
            });
            await Execution.delayTicks(1);
        }

        const wc = Skills.level('woodcutting');
        const best = bestAxe(wc, n => gearAxeCount(n) > 0 || (Bank.count(n) || 0) > 0);

        if (!best) {
            this.log(`gear: no usable axe in bank/pack for WC ${wc} — waiting`);
            await Bank.close();
            await Execution.delayTicks(8);
            return true;
        }

        if (gearAxeCount(best) === 0 && (Bank.count(best) || 0) > 0) {
            this.log(`gear: withdrawing ${best}`);
            if (!(await Bank.withdrawX(best, 1))) {
                this.log(`gear: withdraw failed for ${best}`);
                await Execution.delayTicks(2);
                return true;
            }
            await Execution.delayTicks(1);
        }

        if (!gearHasKnife()) {
            if ((Bank.count('Knife') || 0) > 0) {
                this.log('gear: withdrawing Knife');
                await Bank.withdrawX('Knife', 1);
                await Execution.delayTicks(1);
            } else {
                this.log('gear: no Knife in bank — will pick up behind Bob');
            }
        }

        if ((Bank.count(GEAR_BROKEN_AXE) || 0) > 0 && !gearHasBrokenAxe()) {
            this.log('gear: withdrawing Broken axe');
            await Bank.withdrawX(GEAR_BROKEN_AXE, 1);
            await Execution.delayTicks(1);
        }

        this.maybeQueueSteelBuy();
        if (this.needSteelBuy) {
            const need = GEAR_STEEL_COST - gearInvCoins();
            if (need > 0) {
                this.log(`gear: withdrawing ${need}gp for Steel axe`);
                await Bank.withdrawX('Coins', need);
                await Execution.delayTicks(1);
            }
        }

        await Bank.close();
        await Execution.delayTicks(1);

        if (gearHasBrokenAxe()) {
            return await this.repairBrokenAxeAtBob();
        }

        const held = gearBestHeldAxe();
        if (held && !Equipment.contains(held) && canWieldTool(held, Skills.level('attack'))) {
            this.status = `gear: wield ${held}`;
            this.log(`gear: wielding ${held}`);
            await Equipment.equip(held);
            await Execution.delayTicks(1);
        } else if (held && !canWieldTool(held, Skills.level('attack'))) {
            this.log(`gear: keeping ${held} in pack (Attack too low to wield)`);
        }

        if (!gearHasKnife()) {
            return await this.pickupLumbridgeKnife();
        }

        if (!gearBestHeldAxe()) {
            this.log('gear: still missing axe after bank');
            await Execution.delayTicks(5);
            return true;
        }

        this.gearReady = true;
        this.log(
            `gear: ready — ${gearBestHeldAxe()}` +
                (this.needSteelBuy ? ' (buying Steel axe next)' : '')
        );

        if (this.needSteelBuy) {
            return await this.runSteelAxeBuy();
        }
        return true;
    }

    async pickupLumbridgeKnife() {
        this.status = 'gear: knife spawn';
        this.log('gear: walking to Lumbridge knife spawn (behind Bob)');
        await Traversal.walkResilient(GEAR_KNIFE_SPAWN, {
            radius: 1,
            log: m => this.log(`  ${m}`)
        });

        let ground = GroundItems.query().name('Knife').within(6).nearest();
        if (!ground) {
            await Execution.delayTicks(3);
            ground = GroundItems.query().name('Knife').within(6).nearest();
        }
        if (!ground) {
            this.log('gear: Knife not on ground yet — waiting');
            await Execution.delayTicks(5);
            return true;
        }

        if (Inventory.isFull()) {
            this.log('gear: inventory full — cannot Take Knife');
            await Execution.delayTicks(5);
            return true;
        }

        this.log('gear: taking Knife');
        await ground.interact('Take');
        await Execution.delayUntil(() => gearHasKnife(), 8000);

        if (gearHasKnife() && gearBestHeldAxe()) {
            this.gearReady = true;
            this.log('gear: Knife acquired — ready');
        }
        return true;
    }

    async runSteelAxeBuy() {
        if (gearHasSteelOrBetter()) {
            this.needSteelBuy = false;
            return false;
        }
        if (Skills.level('woodcutting') < 6) {
            this.needSteelBuy = false;
            return false;
        }

        // Confirm ownership in bank before spending 200gp at Bob.
        if (!Bank.isOpen()) {
            this.status = 'gear: check steel';
            if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                await Execution.delayTicks(3);
                return true;
            }
        }
        await gearWaitBankLoaded();

        if (gearHasSteelOrBetter()) {
            const steelRank = gearAxeRank(GEAR_STEEL_AXE);
            const best = bestAxe(
                Skills.level('woodcutting'),
                n => gearAxeCount(n) > 0 || (Bank.count(n) || 0) > 0
            );
            if (best && gearAxeRank(best) <= steelRank && gearAxeCount(best) === 0) {
                this.log(`gear: already own ${best} in bank — withdrawing (skip Bob)`);
                await Bank.withdrawX(best, 1);
                await Execution.delayTicks(1);
            } else {
                this.log('gear: already own steel+ axe — skip Bob');
            }
            this.needSteelBuy = false;
            await Bank.close();
            const held = gearBestHeldAxe();
            if (held && !Equipment.contains(held) && canWieldTool(held, Skills.level('attack'))) {
                await Equipment.equip(held);
            }
            return true;
        }

        if (gearInvCoins() < GEAR_STEEL_COST) {
            this.status = 'gear: steel gp';
            if (gearBankCoins() + gearInvCoins() < GEAR_STEEL_COST) {
                this.log('gear: need 200gp in bank for Steel axe — waiting');
                this.needSteelBuy = false;
                await Bank.close();
                return true;
            }
            const need = GEAR_STEEL_COST - gearInvCoins();
            if (need > 0) {
                await Bank.withdrawX('Coins', need);
            }
            await Bank.close();
            await Execution.delayTicks(1);
            return true;
        }

        await Bank.close();
        await Execution.delayTicks(1);

        this.status = 'gear: Bob';
        this.log('gear: walking to Bob for Steel axe');
        await Traversal.walkResilient(GEAR_BOB_STAND, {
            radius: 2,
            log: m => this.log(`  ${m}`)
        });

        if (!(await Shop.open('Bob'))) {
            this.log("gear: could not open Bob's shop");
            await Execution.delayTicks(3);
            return true;
        }
        return await this.buySteelAtOpenShop();
    }

    async buySteelAtOpenShop() {
        if (gearHasSteelOrBetter()) {
            this.log('gear: already own steel+ axe — closing Bob');
            this.needSteelBuy = false;
            await Shop.close();
            return true;
        }

        this.status = 'gear: buy steel';
        const before = gearAxeCount(GEAR_STEEL_AXE);
        const bought = await Shop.buy(GEAR_STEEL_AXE, 1);
        const got = bought > 0 ? bought : Math.max(0, gearAxeCount(GEAR_STEEL_AXE) - before);

        if (got <= 0) {
            this.log('gear: Steel axe buy failed (stock/coins?)');
            await Shop.close();
            await Execution.delayTicks(5);
            return true;
        }

        this.log('gear: bought Steel axe from Bob');
        this.needSteelBuy = false;
        await Shop.close();
        await Execution.delayTicks(1);

        if (
            !Equipment.contains(GEAR_STEEL_AXE) &&
            canWieldTool(GEAR_STEEL_AXE, Skills.level('attack'))
        ) {
            await Equipment.equip(GEAR_STEEL_AXE);
        }
        return true;
    }

    /* ═══════════ Shared chop / fletch ═══════════ */

    findTree(treeName, anchor, leash, maxDistFromPlayer = null) {
        let q = Locs.query()
            .name(treeName)
            .where(l => chopOp(l.actions()) !== null)
            .where(l => Tile.from(l.tile()).distanceTo(anchor) <= leash);
        if (maxDistFromPlayer != null) {
            q = q.where(l => l.distance() <= maxDistFromPlayer);
        }
        return q.nearest();
    }

    async chopTree(tree, logCountFn, label) {
        const op = chopOp(tree.actions());
        if (!op) {
            this.log(`${label} has no chop action: [${tree.actions().join(', ')}]`);
            await Execution.delayTicks(2);
            return;
        }

        const before = logCountFn();
        this.status = `chopping (${tree.distance()}t)`;
        this.log(`chopping ${label} @ ${tree.tile().x},${tree.tile().z}`);
        await tree.interact(op);
        const gotLog = await Execution.delayUntil(
            () => logCountFn() > before || Game.animating() || ChatDialog.canContinue(),
            8000
        );
        if (logCountFn() > before) {
            this.chopped += logCountFn() - before;
        } else if (gotLog && Game.animating()) {
            await Execution.delayUntil(
                () => logCountFn() > before || !Game.animating() || ChatDialog.canContinue(),
                20_000
            );
            if (logCountFn() > before) {
                this.chopped += logCountFn() - before;
            }
        }
    }

    async fletchLogs(plan, preferOak, logCountFn, logPred) {
        if (preferOak && plan.fletch === false) {
            return;
        }
        if (logCountFn() === 0) {
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan, preferOak, logCountFn);
            return;
        }

        const knife = knifeItem();
        const log = lastLogMatching(logPred);
        if (!knife) {
            this.log('WARNING: no Knife in inventory — cannot fletch');
            await Execution.delayTicks(5);
            return;
        }
        if (!log) {
            return;
        }

        this.status = `fletching ${plan.label}`;
        this.log(`knife → logs (${logCountFn()} left) for ${plan.label}`);
        const before = logCountFn();
        if (!(await knife.useOn(log))) {
            await Execution.delayTicks(2);
            return;
        }

        const opened = await Execution.delayUntil(
            () =>
                ChatDialog.isMakeMenu() ||
                logCountFn() < before ||
                ChatDialog.canContinue() ||
                Game.animating(),
            8000
        );

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan, preferOak, logCountFn);
            return;
        }

        if (!opened && logCountFn() >= before) {
            this.log('fletch useOn did not start — retrying');
        }
    }

    async chooseMakeProduct(plan, preferOak, logCountFn) {
        if (preferOak && plan.fletch === false) {
            return;
        }
        if (!plan.menuMatch) {
            return;
        }

        const products = ChatDialog.makeProducts();
        const match = matchMakeProduct(products, plan.menuMatch, preferOak);
        if (!match) {
            this.log(
                `make menu missing '${plan.label}' (have: [${products.join(', ')}]) — closing`
            );
            await Execution.delayTicks(2);
            return;
        }

        const start = logCountFn();
        this.status = `make ${plan.label}`;
        this.log(`selecting '${match}' x${start}`);

        let picked = false;
        if (typeof ChatDialog.makeX === 'function') {
            const count = Math.max(1, Math.min(start, 30));
            picked = await ChatDialog.makeX(match, count);
        }
        if (!picked) {
            picked = await ChatDialog.make(match);
        }
        if (!picked) {
            this.log(`could not pick '${match}' from make menu`);
            await Execution.delayTicks(1);
            return;
        }

        await Execution.delayUntil(
            () =>
                !ChatDialog.isMakeMenu() &&
                (Game.animating() || logCountFn() < start || ChatDialog.canContinue()),
            5000
        );

        let mark = logCountFn();
        let idle = 0;
        for (let guard = 0; guard < 400 && logCountFn() > 0; guard++) {
            if (ChatDialog.canContinue() || ChatDialog.isMakeMenu()) {
                return;
            }
            await Execution.delayTicks(1);
            const now = logCountFn();
            if (now < mark) {
                this.fletched += mark - now;
                mark = now;
                idle = 0;
            } else if (!Game.animating() && ++idle >= 12) {
                return;
            } else if (Game.animating()) {
                idle = 0;
            }
        }
    }

    onStop() {
        this.log(
            `stopped — phase ${this.phase}, chopped ~${this.chopped}, fletched ~${this.fletched}, ` +
                `sold ~${this.soldBows}, bank GP ${this.totalGpEarned}, ` +
                `sell ${this.sellTrips}, bank ${this.bankTrips} (${this.status})`
        );
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const wcXp = Skills.xp('woodcutting') - this.wcXpAtStart;
        const flXp = Skills.xp('fletching') - this.fletchXpAtStart;
        const wcXph = hrs > 0.008 ? wcXp / hrs : 0;
        const flXph = hrs > 0.008 ? flXp / hrs : 0;
        const wc = Skills.level('woodcutting');
        const fl = Skills.level('fletching');

        const plan =
            this.phase === 'oak' ? oakPlan(fl) : faladorPlan(fl);
        const phaseLabel =
            this.phase === 'oak'
                ? `OAK → store`
                : `FALADOR → oaks @ WC${OAK_WC_REQ}/Fl${OAK_FLETCH_REQ}`;

        const lines = [
            `ProgFletch  WC ${wc}  Fletch ${fl}  [${this.phase}]`,
            `time ${fmtElapsed(elapsed)}  ·  ${phaseLabel}  ·  ${plan.label}  ·  ${this.status}`,
            this.phase === 'oak'
                ? `oak logs ${oakLogCount()}  bows ${oakBowCount()}  sold ${this.soldBows}`
                : `logs ${faladorLogCount()}  bows ${faladorBowCount()}  shafts ${shaftCount()}`,
            `GP earned ${fmtXph(this.totalGpEarned)} (in bank)  ·  bank trips ${this.bankTrips}`,
            `WC ${fmtXph(wcXph)}/hr  Fletch ${fmtXph(flXph)}/hr`
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
        ctx.fillStyle = this.phase === 'oak' ? '#9ecb6a' : '#c4a35a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.1.0',
    category: 'Fletching',
    tags: [
        'woodcutting',
        'fletching',
        'progressive',
        'falador',
        'oak',
        'sell',
        'varrock'
    ],
    description:
        `Falador trees (shafts→shortbow→longbow) until WC ${OAK_WC_REQ} + Fletching ${OAK_FLETCH_REQ}, then oaks at 3166,3416: oak short/longbow → Varrock General sell → bank GP.`,
    create: () => new ProgressiveWcFletcher()
});
