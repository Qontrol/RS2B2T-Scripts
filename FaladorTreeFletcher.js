/**
 * FaladorTreeFletcher — chop regular trees at 2953,3407, fletch by level, bank bows/shafts.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('FaladorTreeFletcher: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `FaladorTreeFletcher: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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

const SCRIPT_NAME = 'FaladorTreeFletcher';

/** West of Falador — regular tree camp. */
const ANCHOR = new Tile(2953, 3407, 0);
const LEASH = 15;
const TREE_NAME = 'Tree';
const LOG_NAME = 'Logs';

/** Fletching tier thresholds (classic / OSRS). */
const SHORTBOW_LEVEL = 5;
const LONGBOW_LEVEL = 10;

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

/**
 * Fletched shortbow on this server is just "Shortbow" (not "Shortbow (u)").
 */
function isFletchedShortbow(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
    return n === 'shortbow' || n === 'short bow';
}

/**
 * Fletched longbow — "Longbow", "Long bow", or Longbow (u) / unstrung variants.
 */
function isFletchedLongbow(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (n === 'longbow' || n === 'long bow') {
        return true;
    }
    return (
        n.includes('long') &&
        n.includes('bow') &&
        (n.includes('(u)') || n.includes('unstrung'))
    );
}

function isBankableBow(name) {
    return isFletchedShortbow(name) || isFletchedLongbow(name);
}

function isShaft(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase();
    return n.includes('arrow shaft');
}

/** Current fletch product for the make-menu + banking phase. */
function fletchPlan(level) {
    if (level < SHORTBOW_LEVEL) {
        return {
            id: 'shafts',
            menuMatch: 'shaft',
            label: 'Arrow shafts',
            bank: false
        };
    }
    if (level < LONGBOW_LEVEL) {
        return {
            id: 'shortbow',
            menuMatch: 'short',
            label: 'Shortbow',
            bank: true
        };
    }
    return {
        id: 'longbow',
        menuMatch: 'long',
        label: 'Longbow',
        bank: true
    };
}

function matchMakeProduct(products, menuMatch) {
    const want = menuMatch.toLowerCase();
    return products.find(p => (p ?? '').toLowerCase().includes(want)) ?? null;
}

function logCount() {
    return Inventory.count(LOG_NAME);
}

function knifeItem() {
    return (
        Inventory.items().find(i => (i.name ?? '').toLowerCase().includes('knife')) ?? null
    );
}

function lastLog() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        if ((items[i].name ?? '').toLowerCase() === LOG_NAME.toLowerCase()) {
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

function shaftCount() {
    return Inventory.items()
        .filter(i => isShaft(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

/** Bank when we have bows to deposit, or leftover shafts once fletching ≥ 5. */
function needsBankTrip(plan) {
    if (logCount() > 0) {
        return false;
    }
    if (plan.bank && bowCount() > 0) {
        return true;
    }
    return Skills.level('fletching') >= SHORTBOW_LEVEL && shaftCount() > 0;
}

class FaladorTreeFletcher extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    wcXpAtStart = 0;
    fletchXpAtStart = 0;
    chopped = 0;
    fletched = 0;
    bankTrips = 0;
    planId = 'shafts';

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
            `FaladorTreeFletcher @ ${ANCHOR.x},${ANCHOR.z} (leash ${LEASH}) — ` +
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

        if (logCount() > 0 && Inventory.isFull()) {
            await this.fletchLogs(plan);
            return;
        }

        if (logCount() > 0 && Game.animating() && bowCount() === 0 && !this.findTreeWithin(2)) {
            this.status = `fletching ${plan.label}`;
            await Execution.delayTicks(1);
            return;
        }

        if (needsBankTrip(plan)) {
            await this.bankProductsAndReturn();
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(ANCHOR) > LEASH) {
            this.status = 'returning to trees';
            this.log('walking back to tree camp');
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
            this.status = 'waiting for tree';
            await Traversal.walkTo(ANCHOR, { radius: 3, timeoutMs: 10_000 });
            await Execution.delayTicks(2);
            return;
        }

        const op = chopOp(tree.actions());
        if (!op) {
            this.log(`Tree has no chop action: [${tree.actions().join(', ')}]`);
            await Execution.delayTicks(2);
            return;
        }

        const before = logCount();
        this.status = `chopping (${tree.distance()}t)`;
        this.log(`chopping Tree @ ${tree.tile().x},${tree.tile().z}`);
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
        if (logCount() === 0) {
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
        this.log(`knife → logs (${logCount()} left) for ${plan.label}`);
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
        const shafts = shaftCount();
        this.status = 'banking';
        this.log(
            `banking` +
                (shorts ? ` ${shorts} Shortbow` : '') +
                (bows - shorts > 0 ? ` ${bows - shorts} Longbow` : '') +
                (shafts && flvl >= SHORTBOW_LEVEL ? ` ${shafts} arrow shafts` : '') +
                ` (fletching ${flvl})`
        );

        await Banking.bankNearest({
            deposit: name => {
                if (isKeepTool(name)) {
                    return false;
                }
                if (isShaft(name)) {
                    return flvl >= SHORTBOW_LEVEL;
                }
                if (isBankableBow(name)) {
                    return true;
                }
                const n = (name ?? '').toLowerCase();
                return n === 'logs';
            },
            returnTo: ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.status = 'returning to trees';
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
            `TreeFletcher  WC ${Skills.level('woodcutting')}  Fletch ${Skills.level('fletching')}`,
            `time ${fmtElapsed(elapsed)}  ·  ${plan.label}${plan.bank ? ' + bank' : ''}  ·  ${this.status}`,
            `logs ${logCount()}  bows ${bowCount()}  shafts ${shaftCount()}  trips ${this.bankTrips}`,
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
    version: '1.1.0',
    category: 'Fletching',
    tags: ['woodcutting', 'fletching', 'falador', 'trees', 'arrow shafts', 'shortbow', 'longbow'],
    description:
        'Chop Trees at 2953,3407 (15t leash). Shafts → bank shafts + Shortbow @5 → Longbow @10; bank and return.',
    create: () => new FaladorTreeFletcher()
});
