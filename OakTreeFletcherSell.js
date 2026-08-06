/**
 * OakTreeFletcherSell — same oak camp/fletch as OakTreeFletcher, but sells bows
 * at Varrock General Store then banks the coins (keeps knife/axe).
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('OakTreeFletcherSell: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `OakTreeFletcherSell: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    Shop,
    Traversal,
    Tile,
    Skills,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'OakTreeFletcherSell';

/** Oak camp — center + walking radius. */
const ANCHOR = new Tile(3166, 3416, 0);
const LEASH = 20;
const TREE_NAME = 'Oak';

/** Varrock General Store (quest anchors). */
const STORE_STAND = new Tile(3218, 3414, 0);
const STORE_KEEPER = 'Shop keeper';
/** Closest bank after selling. */
const VARROCK_WEST_BANK = new Tile(3185, 3440, 0);

/** Fletching tier thresholds. */
const SHORTBOW_LEVEL = 20;
const LONGBOW_LEVEL = 25;

/** Always keep these when banking / never sell. */
const KEEP_TOOLS = [
    'knife',
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

function isFletchedShortbow(name) {
    const n = normName(name);
    if (!n.includes('oak')) {
        return false;
    }
    return n.includes('short') && n.includes('bow');
}

function isFletchedLongbow(name) {
    const n = normName(name);
    if (!n.includes('oak')) {
        return false;
    }
    return n.includes('long') && n.includes('bow');
}

function isBankableBow(name) {
    return isFletchedShortbow(name) || isFletchedLongbow(name);
}

function isOakLog(name) {
    const n = normName(name);
    return n === 'oak logs' || n === 'oak log';
}

function isCoins(name) {
    return normName(name) === 'coins';
}

function fletchPlan(level) {
    if (level < SHORTBOW_LEVEL) {
        return {
            id: 'logs',
            menuMatch: '',
            label: 'Oak logs (bank)',
            bank: true,
            fletch: false,
            sell: false
        };
    }
    if (level < LONGBOW_LEVEL) {
        return {
            id: 'oak-shortbow',
            menuMatch: 'short',
            label: 'Oak shortbow',
            bank: false,
            fletch: true,
            sell: true
        };
    }
    return {
        id: 'oak-longbow',
        menuMatch: 'long',
        label: 'Oak longbow',
        bank: false,
        fletch: true,
        sell: true
    };
}

function matchMakeProduct(products, menuMatch) {
    const want = menuMatch.toLowerCase();
    const oakish = products.filter(p => (p ?? '').toLowerCase().includes('oak'));
    const pool = oakish.length > 0 ? oakish : products;
    return pool.find(p => (p ?? '').toLowerCase().includes(want)) ?? null;
}

function logCount() {
    return Inventory.items()
        .filter(i => isOakLog(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function knifeItem() {
    return (
        Inventory.items().find(i => (i.name ?? '').toLowerCase().includes('knife')) ?? null
    );
}

function lastLog() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        if (isOakLog(items[i].name)) {
            return items[i];
        }
    }
    return null;
}

function bowCount() {
    return Inventory.items()
        .filter(i => isBankableBow(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function shortbowCount() {
    return Inventory.items()
        .filter(i => isFletchedShortbow(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function coinCount() {
    return Inventory.items()
        .filter(i => isCoins(i.name))
        .reduce((n, i) => n + Math.max(0, i.count), 0);
}

/** Unique display names of bows currently held (Shop.sell needs exact names). */
function bowNamesHeld() {
    const names = [];
    const seen = new Set();
    for (const item of Inventory.items()) {
        if (!isBankableBow(item.name) || !item.name) {
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

/** Below 20: bank full oak logs. At 20+: sell when logs are gone and bows remain. */
function needsLogBank(plan) {
    if (plan.fletch) {
        return false;
    }
    return logCount() > 0 && Inventory.isFull();
}

function needsSellTrip(plan) {
    if (!plan.sell || !plan.fletch) {
        return false;
    }
    if (logCount() > 0) {
        return false;
    }
    return bowCount() > 0;
}

class OakTreeFletcherSell extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    wcXpAtStart = 0;
    fletchXpAtStart = 0;
    chopped = 0;
    fletched = 0;
    sellTrips = 0;
    bankTrips = 0;
    soldBows = 0;
    planId = 'logs';

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.startedAt = Date.now();
        this.wcXpAtStart = Skills.xp('woodcutting');
        this.fletchXpAtStart = Skills.xp('fletching');
        this.planId = fletchPlan(Skills.level('fletching')).id;

        this.on('skill.level', e => {
            if (e.name === 'fletching') {
                const plan = fletchPlan(e.level);
                this.log(`fletching ${e.previous} → ${e.level} — now making ${plan.label}`);
                this.planId = plan.id;
            }
            if (e.name === 'woodcutting') {
                this.log(`woodcutting ${e.previous} → ${e.level}`);
            }
        });

        const plan = fletchPlan(Skills.level('fletching'));
        this.log(
            `OakTreeFletcherSell @ ${ANCHOR.x},${ANCHOR.z} (leash ${LEASH}) — ` +
                `fletching ${Skills.level('fletching')} → ${plan.label}; ` +
                `sell bows @ Varrock General → bank GP`
        );
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

        if (Shop.isOpen()) {
            await Shop.close();
            return;
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        const plan = fletchPlan(Skills.level('fletching'));
        this.planId = plan.id;

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan);
            return;
        }

        if (plan.fletch && logCount() > 0 && Inventory.isFull()) {
            await this.fletchLogs(plan);
            return;
        }

        if (
            plan.fletch &&
            logCount() > 0 &&
            Game.animating() &&
            bowCount() === 0 &&
            !this.findTreeWithin(2)
        ) {
            this.status = `fletching ${plan.label}`;
            await Execution.delayTicks(1);
            return;
        }

        if (needsSellTrip(plan)) {
            await this.sellBowsBankGpAndReturn();
            return;
        }

        if (needsLogBank(plan)) {
            await this.bankLogsAndReturn();
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(ANCHOR) > LEASH) {
            this.status = 'returning to oaks';
            this.log('walking back to oak camp');
            await Traversal.walkResilient(ANCHOR, {
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

        const tree = this.findTree();
        if (!tree) {
            this.status = 'waiting for oak';
            await Traversal.walkTo(ANCHOR, { radius: 3, timeoutMs: 10_000 });
            await Execution.delayTicks(2);
            return;
        }

        const op = chopOp(tree.actions());
        if (!op) {
            this.log(`Oak has no chop action: [${tree.actions().join(', ')}]`);
            await Execution.delayTicks(2);
            return;
        }

        const before = logCount();
        this.status = `chopping (${tree.distance()}t)`;
        this.log(`chopping Oak @ ${tree.tile().x},${tree.tile().z}`);
        await tree.interact(op);
        const gotLog = await Execution.delayUntil(
            () => logCount() > before || Game.animating() || ChatDialog.canContinue(),
            8000
        );
        if (logCount() > before) {
            this.chopped += logCount() - before;
        } else if (gotLog && Game.animating()) {
            await Execution.delayUntil(
                () => logCount() > before || !Game.animating() || ChatDialog.canContinue(),
                20_000
            );
            if (logCount() > before) {
                this.chopped += logCount() - before;
            }
        }
    }

    findTree() {
        return Locs.query()
            .name(TREE_NAME)
            .where(l => chopOp(l.actions()) !== null)
            .where(l => Tile.from(l.tile()).distanceTo(ANCHOR) <= LEASH)
            .nearest();
    }

    findTreeWithin(maxDistFromPlayer) {
        return Locs.query()
            .name(TREE_NAME)
            .where(l => chopOp(l.actions()) !== null)
            .where(l => Tile.from(l.tile()).distanceTo(ANCHOR) <= LEASH)
            .where(l => l.distance() <= maxDistFromPlayer)
            .nearest();
    }

    async fletchLogs(plan) {
        if (!plan.fletch || logCount() === 0) {
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan);
            return;
        }

        const knife = knifeItem();
        const log = lastLog();
        if (!knife) {
            this.log('WARNING: no Knife in inventory — cannot fletch');
            await Execution.delayTicks(5);
            return;
        }
        if (!log) {
            return;
        }

        this.status = `fletching ${plan.label}`;
        this.log(`knife → oak logs (${logCount()} left) for ${plan.label}`);
        const before = logCount();
        if (!(await knife.useOn(log))) {
            await Execution.delayTicks(2);
            return;
        }

        const opened = await Execution.delayUntil(
            () =>
                ChatDialog.isMakeMenu() ||
                logCount() < before ||
                ChatDialog.canContinue() ||
                Game.animating(),
            8000
        );

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan);
            return;
        }

        if (!opened && logCount() >= before) {
            this.log('fletch useOn did not start — retrying');
        }
    }

    async chooseMakeProduct(plan) {
        if (!plan.fletch) {
            return;
        }

        const products = ChatDialog.makeProducts();
        const match = matchMakeProduct(products, plan.menuMatch);
        if (!match) {
            this.log(
                `make menu missing '${plan.label}' (have: [${products.join(', ')}]) — closing`
            );
            await Execution.delayTicks(2);
            return;
        }

        const start = logCount();
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
                (Game.animating() || logCount() < start || ChatDialog.canContinue()),
            5000
        );

        let mark = logCount();
        let idle = 0;
        for (let guard = 0; guard < 400 && logCount() > 0; guard++) {
            if (ChatDialog.canContinue()) {
                return;
            }
            if (ChatDialog.isMakeMenu()) {
                return;
            }
            await Execution.delayTicks(1);
            const now = logCount();
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

    /** Sell all oak bows at Varrock General, bank coins, return to oaks. */
    async sellBowsBankGpAndReturn() {
        const bows = bowCount();
        const shorts = shortbowCount();
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
        for (let guard = 0; guard < 60 && bowCount() > 0 && Shop.isOpen(); guard++) {
            const names = bowNamesHeld();
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
            if (bowCount() > 0) {
                await Execution.delayTicks(1);
            }
        }

        if (Shop.isOpen()) {
            await Shop.close();
        }

        this.soldBows += sold;
        this.sellTrips++;

        if (bowCount() > 0) {
            this.log(`WARNING: still holding ${bowCount()} bows after sell — will retry`);
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
                if (isCoins(name)) {
                    return true;
                }
                if (isBankableBow(name)) {
                    return true;
                }
                return isOakLog(name);
            },
            returnTo: ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.status = 'returning to oaks';
    }

    /** Below fletching 20: deposit oak logs only. */
    async bankLogsAndReturn() {
        const logs = logCount();
        this.status = 'banking logs';
        this.log(`banking ${logs} Oak logs (fletching < ${SHORTBOW_LEVEL})`);

        await Banking.bankNearest({
            deposit: name => {
                if (isKeepTool(name)) {
                    return false;
                }
                return isOakLog(name);
            },
            returnTo: ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.status = 'returning to oaks';
    }

    onStop() {
        this.log(
            `stopped — chopped ~${this.chopped}, fletched ~${this.fletched}, ` +
                `sold ~${this.soldBows}, sell trips ${this.sellTrips}, ` +
                `bank trips ${this.bankTrips} (${this.status})`
        );
    }

    onPaint(ctx) {
        const plan = fletchPlan(Skills.level('fletching'));
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const wcXp = Skills.xp('woodcutting') - this.wcXpAtStart;
        const flXp = Skills.xp('fletching') - this.fletchXpAtStart;
        const wcXph = hrs > 0.008 ? wcXp / hrs : 0;
        const flXph = hrs > 0.008 ? flXp / hrs : 0;

        const lines = [
            `OakSell  WC ${Skills.level('woodcutting')}  Fletch ${Skills.level('fletching')}`,
            `time ${fmtElapsed(elapsed)}  ·  ${plan.label}${plan.sell ? ' → store+bank GP' : ' + bank'}  ·  ${this.status}`,
            `logs ${logCount()}  bows ${bowCount()}  sold ${this.soldBows}  trips ${this.sellTrips}`,
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
        ctx.fillStyle = '#9ecb6a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Fletching',
    tags: ['woodcutting', 'fletching', 'oak', 'shortbow', 'longbow', 'sell', 'varrock'],
    description:
        'Oaks at 3166,3416. Oak shortbow @20 / longbow @25 → sell all bows at Varrock General Store → bank GP → return. Logs banked below 20.',
    create: () => new OakTreeFletcherSell()
});
