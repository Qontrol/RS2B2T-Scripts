/**
 * OakTreeFletcher — chop Oaks at 3166,3416 (20t leash), fletch oak bows by level, bank.
 * Fletching: Oak shortbow @20 → Oak longbow @25 (bank oak logs below 20).
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('OakTreeFletcher: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `OakTreeFletcher: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    ChatDialog
} = abi;

const SCRIPT_NAME = 'OakTreeFletcher';

/** Oak camp — center + walking radius. */
const ANCHOR = new Tile(3166, 3416, 0);
const LEASH = 20;
const TREE_NAME = 'Oak';
const LOG_NAME = 'Oak logs';

/** Fletching tier thresholds. */
const SHORTBOW_LEVEL = 20;
const LONGBOW_LEVEL = 25;

/** Always keep these when banking (never deposit). */
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

/**
 * Oak shortbow — "Oak shortbow", "Oak short bow", or (u) / unstrung variants.
 */
function isFletchedShortbow(name) {
    const n = normName(name);
    if (!n.includes('oak')) {
        return false;
    }
    if (!(n.includes('short') && n.includes('bow'))) {
        return false;
    }
    return true;
}

/**
 * Oak longbow — "Oak longbow", "Oak long bow", or (u) / unstrung variants.
 */
function isFletchedLongbow(name) {
    const n = normName(name);
    if (!n.includes('oak')) {
        return false;
    }
    if (!(n.includes('long') && n.includes('bow'))) {
        return false;
    }
    return true;
}

function isBankableBow(name) {
    return isFletchedShortbow(name) || isFletchedLongbow(name);
}

function isOakLog(name) {
    const n = normName(name);
    return n === 'oak logs' || n === 'oak log';
}

/** Current fletch product for the make-menu + banking phase. */
function fletchPlan(level) {
    if (level < SHORTBOW_LEVEL) {
        return {
            id: 'logs',
            menuMatch: '',
            label: 'Oak logs (bank)',
            bank: true,
            fletch: false
        };
    }
    if (level < LONGBOW_LEVEL) {
        return {
            id: 'oak-shortbow',
            menuMatch: 'short',
            label: 'Oak shortbow',
            bank: true,
            fletch: true
        };
    }
    return {
        id: 'oak-longbow',
        menuMatch: 'long',
        label: 'Oak longbow',
        bank: true,
        fletch: true
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

/** Bank when no logs left and we have bows/logs to deposit. */
function needsBankTrip(plan) {
    if (logCount() > 0 && plan.fletch) {
        return false;
    }
    if (plan.bank && bowCount() > 0) {
        return true;
    }
    // Below 20 (or after fletching): full/leftover oak logs → bank.
    if (!plan.fletch && logCount() > 0 && Inventory.isFull()) {
        return true;
    }
    if (plan.fletch && logCount() === 0 && bowCount() > 0) {
        return true;
    }
    return !plan.fletch && logCount() > 0 && Inventory.isFull();
}

class OakTreeFletcher extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    wcXpAtStart = 0;
    fletchXpAtStart = 0;
    chopped = 0;
    fletched = 0;
    bankTrips = 0;
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
            `OakTreeFletcher @ ${ANCHOR.x},${ANCHOR.z} (leash ${LEASH}) — ` +
                `fletching ${Skills.level('fletching')} → ${plan.label}`
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

        if (needsBankTrip(plan)) {
            await this.bankProductsAndReturn();
            return;
        }

        // Below 20: bank a full pack of oak logs instead of fletching.
        if (!plan.fletch && Inventory.isFull() && logCount() > 0) {
            await this.bankProductsAndReturn();
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

    async bankProductsAndReturn() {
        const flvl = Skills.level('fletching');
        const bows = bowCount();
        const shorts = shortbowCount();
        const logs = logCount();
        this.status = 'banking';
        this.log(
            `banking` +
                (shorts ? ` ${shorts} Oak shortbow` : '') +
                (bows - shorts > 0 ? ` ${bows - shorts} Oak longbow` : '') +
                (logs ? ` ${logs} Oak logs` : '') +
                ` (fletching ${flvl})`
        );

        await Banking.bankNearest({
            deposit: name => {
                if (isKeepTool(name)) {
                    return false;
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

    onStop() {
        this.log(
            `stopped — chopped ~${this.chopped}, fletched ~${this.fletched}, ` +
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
            `OakFletcher  WC ${Skills.level('woodcutting')}  Fletch ${Skills.level('fletching')}`,
            `time ${fmtElapsed(elapsed)}  ·  ${plan.label}${plan.bank ? ' + bank' : ''}  ·  ${this.status}`,
            `logs ${logCount()}  bows ${bowCount()}  trips ${this.bankTrips}`,
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
        ctx.fillStyle = '#c4a35a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Fletching',
    tags: ['woodcutting', 'fletching', 'oak', 'shortbow', 'longbow'],
    description:
        'Chop Oaks at 3166,3416 (20t leash). Bank oak logs <20 → Oak shortbow @20 → Oak longbow @25; bank and return.',
    create: () => new OakTreeFletcher()
});
