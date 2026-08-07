/**
 * AutoShopBuyer — buy a shop item by ID in batches of 10 until the target qty is reached.
 * Settings: item ID text box + buy-amount slider (1–5000).
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('AutoShopBuyer: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `AutoShopBuyer: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Npcs,
    Inventory,
    Shop,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'AutoShopBuyer';

/** Shop stock container com id (see rs2b0t Shop.ts). */
const SHOP_STOCK_COM = 3900;

/** How many units to request per Shop.buy call. */
const BUY_BATCH = 10;

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

function prefKey(key) {
    return `rs2b0t.pref.${SCRIPT_NAME}.${key}`;
}

function readPrefRaw(key) {
    try {
        if (typeof localStorage !== 'undefined') {
            return localStorage.getItem(prefKey(key));
        }
    } catch {
        /* private mode / blocked storage */
    }
    return null;
}

function readPrefStr(key, fallback) {
    const raw = readPrefRaw(key);
    return raw !== null ? raw.trim() : fallback;
}

function readPrefNum(key, fallback) {
    const raw = readPrefRaw(key);
    if (raw === null) {
        return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function parseItemId(raw) {
    const s = String(raw ?? '').trim();
    if (!s) {
        return -1;
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return -1;
    }
    return n;
}

function heldById(id) {
    if (id < 0) {
        return 0;
    }
    if (typeof Inventory.countById === 'function') {
        return Inventory.countById(id);
    }
    return Inventory.items()
        .filter(i => i.id === id)
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function coinCount() {
    return Inventory.count('Coins') || Inventory.count('coins') || 0;
}

/** Resolve display name for an object id when the shop reader lacks one. */
function objName(id) {
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
        return t?.name ?? null;
    } catch {
        return null;
    }
}

/**
 * Shop stock rows with id when the host reader exposes shopInv.
 * Falls back to Shop.stock() (name/count/slot only).
 */
function shopStockRows() {
    const host = welcomeHost();
    if (host?.reader && typeof host.reader.shopInv === 'function') {
        return host.reader
            .shopInv(SHOP_STOCK_COM)
            .filter(s => s?.name != null)
            .map(s => ({
                id: typeof s.id === 'number' ? s.id : -1,
                name: s.name,
                count: Math.max(0, s.count ?? 0),
                slot: s.slot
            }));
    }
    return Shop.stock().map(s => ({
        id: -1,
        name: s.name,
        count: Math.max(0, s.count ?? 0),
        slot: s.slot
    }));
}

/** Find the shop stock row for the configured item id. */
function findStock(itemId) {
    if (itemId < 0 || !Shop.isOpen()) {
        return null;
    }
    const rows = shopStockRows();
    const byId = rows.find(r => r.id === itemId);
    if (byId) {
        return byId;
    }

    const name = objName(itemId);
    if (!name) {
        return null;
    }
    return rows.find(r => (r.name ?? '').toLowerCase() === name.toLowerCase()) ?? null;
}

class AutoShopBuyer extends LoopingBot {
    status = 'starting';
    itemId = -1;
    buyTarget = 100;
    bought = 0;
    heldAtStart = 0;
    itemName = '';
    startedAt = 0;
    done = false;
    failStreak = 0;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        this.syncPrefs({ silent: true });
        this.startedAt = Date.now();
        this.bought = 0;
        this.done = false;
        this.failStreak = 0;
        this.heldAtStart = this.itemId >= 0 ? heldById(this.itemId) : 0;
        this.itemName = '';

        if (this.itemId < 0) {
            this.log('ERROR: enter a valid Item ID in the script settings before starting');
            this.status = 'bad item id';
            this.done = true;
            stopScript();
            return;
        }

        this.log(
            `Benzyme's Auto Shop Buyer — id ${this.itemId}, target ${this.buyTarget}, ` +
                `buying ${BUY_BATCH} at a time (held now ${this.heldAtStart})`
        );
        this.status = Shop.isOpen() ? 'buying' : 'need shop';
    }

    onStop() {
        this.log(
            `stopped — bought ${this.bought}/${this.buyTarget}` +
                (this.itemName ? ` ${this.itemName}` : ` id ${this.itemId}`) +
                ` (${this.status})`
        );
    }

    syncPrefs({ silent = false } = {}) {
        const prevId = this.itemId;
        const prevTarget = this.buyTarget;

        this.itemId = parseItemId(
            readPrefStr('itemId', this.settings.str('itemId', ''))
        );
        this.buyTarget = Math.max(
            1,
            Math.min(
                5000,
                Math.floor(readPrefNum('buyAmount', this.settings.num('buyAmount', 100)))
            )
        );

        if (!silent) {
            if (prevId !== this.itemId) {
                this.log(`prefs: item id → ${this.itemId < 0 ? '(invalid)' : this.itemId}`);
            }
            if (prevTarget !== this.buyTarget) {
                this.log(`prefs: buy amount → ${this.buyTarget}`);
            }
        }
    }

    remaining() {
        return Math.max(0, this.buyTarget - this.bought);
    }

    async finish(reason) {
        this.done = true;
        this.status = reason;
        this.log(reason);
        if (Shop.isOpen()) {
            await Shop.close();
        }
        stopScript();
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

        if (this.done) {
            await Execution.delayTicks(8);
            return;
        }

        if (this.itemId < 0) {
            await this.finish('bad item id — enter a numeric Item ID');
            return;
        }

        if (this.remaining() <= 0) {
            await this.finish(`done — bought ${this.bought}`);
            return;
        }

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (!Shop.isOpen()) {
            await this.openNearestShop();
            return;
        }

        await this.buyBatch();
    }

    async openNearestShop() {
        this.status = 'opening shop';
        const npc = Npcs.query()
            .within(12)
            .where(n => n.actions().some(a => /^trade$/i.test(a)))
            .nearest();

        if (!npc) {
            this.status = 'need shop open';
            this.log('no Trade NPC nearby — stand next to a shop keeper or open the shop');
            await Execution.delayTicks(5);
            return;
        }

        this.log(`Trade ${npc.name} (${npc.distance()}t)`);
        if (!(await Shop.open(npc.name))) {
            this.log(`could not open ${npc.name} — retrying`);
            await Execution.delayTicks(2);
        }
    }

    async buyBatch() {
        const stock = findStock(this.itemId);
        if (!stock || stock.count <= 0) {
            this.failStreak++;
            this.status = 'no stock';
            this.log(
                `item id ${this.itemId} not in stock` +
                    (stock ? ' (0 left)' : '') +
                    ` — waiting (${this.failStreak})`
            );
            if (this.failStreak >= 8) {
                await this.finish(`stopped — id ${this.itemId} not available in this shop`);
            } else {
                await Execution.delayTicks(3);
            }
            return;
        }

        this.itemName = stock.name || this.itemName || `id ${this.itemId}`;

        // Non-stackables need a free slot; stackables can still fill an existing stack.
        if (Inventory.isFull() && heldById(this.itemId) === 0) {
            await this.finish('stopped — inventory full');
            return;
        }

        if (coinCount() <= 0) {
            await this.finish('stopped — out of coins');
            return;
        }

        const want = Math.min(BUY_BATCH, this.remaining(), Math.max(1, stock.count));
        this.status = `buy ${want}× ${this.itemName}`;
        this.log(`Shop.buy ${want}× ${this.itemName} (id ${this.itemId}) — ${this.bought}/${this.buyTarget}`);

        const before = heldById(this.itemId);
        const got = await Shop.buy(stock.name, want);
        const after = heldById(this.itemId);
        const delta = Math.max(got, after - before);

        if (delta > 0) {
            this.bought += delta;
            this.failStreak = 0;
            this.log(`bought ${delta} — progress ${this.bought}/${this.buyTarget}`);
            if (this.remaining() <= 0) {
                await this.finish(`done — bought ${this.bought}`);
            }
            return;
        }

        this.failStreak++;
        this.log(`buy failed (stock/coins/full?) streak ${this.failStreak}`);
        if (Inventory.isFull()) {
            await this.finish('stopped — inventory full / buy failed');
            return;
        }
        if (this.failStreak >= 6) {
            await this.finish('stopped — buy keep failing (coins or stock?)');
            return;
        }
        await Execution.delayTicks(2);
    }

    onPaint(ctx) {
        const lines = [
            `Benzyme's Auto Shop Buyer`,
            `Time ${fmtElapsed(Date.now() - this.startedAt)}  ·  ${this.status}`,
            `Item ${this.itemName || '—'}  ·  id ${this.itemId < 0 ? '?' : this.itemId}`,
            `Bought ${this.bought} / ${this.buyTarget}  ·  batch ${BUY_BATCH}`,
            `Held ${heldById(this.itemId)}  ·  coins ${coinCount()}`
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
        ctx.fillStyle = '#7ec8e3';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Money Making',
    tags: ['shop', 'buy', 'auto', 'utility'],
    description:
        "Benzyme's Auto Shop Buyer — open a shop (or stand by a Trade NPC), set Item ID + amount (1–5000), buys 10 at a time until done",
    settingsSchema: {
        itemId: {
            type: 'string',
            default: '',
            label: 'Item ID',
            group: 'Buy',
            help: 'Numeric object id of the shop item to purchase (e.g. fishing bait, feathers)'
        },
        buyAmount: {
            type: 'number',
            default: 100,
            min: 1,
            max: 5000,
            label: 'Amount to buy',
            group: 'Buy',
            help: 'Total units to buy this run (1–5000). Purchases happen 10 at a time.'
        }
    },
    create: () => new AutoShopBuyer()
});
