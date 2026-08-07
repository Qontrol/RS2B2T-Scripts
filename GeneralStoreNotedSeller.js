/**
 * GeneralStoreNotedSeller — sell all noted inventory stacks to the nearest general store.
 * Treats Arhein (Catherby) as a general store. Completely vibe coded by @.benzyme via Cursor AI.
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('GeneralStoreNotedSeller: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `GeneralStoreNotedSeller: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    Shop,
    Traversal,
    Tile,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'GeneralStoreNotedSeller';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

function welcomeHost() {
    return globalThis.rs2b0t ?? null;
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

/**
 * Known general-store stands (allstock / general goods). Arhein included.
 * Keeper name is what Shop.open / Trade uses.
 */
const GENERAL_STORES = [
    { keeper: 'Arhein', stand: new Tile(2807, 3430, 0), label: 'Arhein (Catherby)' },
    { keeper: 'Shop keeper', stand: new Tile(3212, 3247, 0), label: 'Lumbridge General' },
    { keeper: 'Shop keeper', stand: new Tile(3216, 3415, 0), label: 'Varrock General' },
    { keeper: 'Shop keeper', stand: new Tile(3316, 3178, 0), label: 'Al-Kharid General' },
    { keeper: 'Shop keeper', stand: new Tile(2958, 3388, 0), label: 'Falador General' },
    { keeper: 'Shop keeper', stand: new Tile(3080, 3508, 0), label: 'Edgeville General' },
    { keeper: 'Shop keeper', stand: new Tile(2946, 3215, 0), label: 'Rimmington General' },
    { keeper: 'Shop keeper', stand: new Tile(2903, 3147, 0), label: 'Karamja General' },
    { keeper: 'Aemad', stand: new Tile(2613, 3294, 0), label: "Aemad's (Ardougne)" },
    { keeper: 'Fionella', stand: new Tile(2728, 3348, 0), label: 'Legends Guild General' }
];

/** Exact names that stack without being bank notes. */
const ALWAYS_STACK = new Set([
    'coins',
    'feather',
    'fishing bait',
    'thread',
    'needle',
    'vial',
    'bronze arrow',
    'iron arrow',
    'steel arrow',
    'mithril arrow',
    'adamant arrow',
    'rune arrow',
    'bronze arrowtips',
    'iron arrowtips',
    'steel arrowtips',
    'mithril arrowtips',
    'adamant arrowtips',
    'rune arrowtips',
    'bolts'
]);

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

function cheb(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/** Try ObjType.certtemplate when the client exposes it. */
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

function isAlwaysStackName(name) {
    const n = (name ?? '').toLowerCase();
    if (!n) {
        return true;
    }
    if (ALWAYS_STACK.has(n)) {
        return true;
    }
    if (n.endsWith(' rune') || n.endsWith(' runes')) {
        return true;
    }
    if (n.includes('arrow') || n.includes('bolt')) {
        return true;
    }
    return false;
}

/**
 * Bank-note stacks: certtemplate when available; else stack count > 1
 * excluding naturally stackable names (coins, runes, arrows, …).
 */
function isNotedItem(item) {
    if (!item?.name) {
        return false;
    }
    if (isAlwaysStackName(item.name)) {
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

function notedItems() {
    return Inventory.items().filter(isNotedItem);
}

function notedCount() {
    return notedItems().reduce((n, i) => n + Math.max(1, i.count), 0);
}

function keeperKey(name) {
    return (name ?? '').trim().toLowerCase();
}

const GENERAL_KEEPER_KEYS = new Set(
    GENERAL_STORES.map(s => keeperKey(s.keeper)).concat([
        'shop assistant',
        'fairy shop keeper',
        'fairy shop assistant',
        'kortan'
    ])
);

function isGeneralKeeperNpc(npc) {
    if (!npc?.name) {
        return false;
    }
    if (!npc.actions().some(a => /^trade$/i.test(a))) {
        return false;
    }
    return GENERAL_KEEPER_KEYS.has(keeperKey(npc.name));
}

class GeneralStoreNotedSeller extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    soldStacks = 0;
    soldUnits = 0;
    storeLabel = '';
    done = false;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startedAt = Date.now();
        this.soldStacks = 0;
        this.soldUnits = 0;
        this.done = false;
        this.storeLabel = '';

        const n = notedItems().length;
        this.log(
            `Benzyme's Noted Seller — ${n} noted stack(s) in pack; selling to nearest general store (incl. Arhein)`
        );
        if (n === 0) {
            this.log('no noted items found — nothing to sell');
            this.done = true;
            this.status = 'done (empty)';
        } else {
            this.status = 'finding store';
        }
    }

    onStop() {
        this.log(
            `stopped — sold ~${this.soldUnits} units in ${this.soldStacks} stack(s)` +
                (this.storeLabel ? ` at ${this.storeLabel}` : '') +
                ` (${this.status})`
        );
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

        if (this.done) {
            this.status = this.status.startsWith('done') ? this.status : 'done';
            await Execution.delayTicks(8);
            return;
        }

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (notedItems().length === 0) {
            if (Shop.isOpen()) {
                await Shop.close();
            }
            this.done = true;
            this.status = 'done';
            this.log('all noted items sold');
            return;
        }

        if (Shop.isOpen()) {
            await this.sellOpenShop();
            return;
        }

        await this.openNearestGeneralStore();
    }

    /**
     * Prefer a general-store keeper already in the scene; else walk to the closest known stand.
     */
    async openNearestGeneralStore() {
        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        const inScene = Npcs.query()
            .within(25)
            .where(n => isGeneralKeeperNpc(n))
            .nearest();

        if (inScene) {
            this.storeLabel = inScene.name ?? 'general store';
            this.status = `opening ${this.storeLabel}`;
            this.log(`Trade ${this.storeLabel} (${inScene.distance()}t)`);
            if (!(await Shop.open(inScene.name))) {
                await this.openNearbyDoor();
                await Execution.delayTicks(2);
            }
            return;
        }

        let best = null;
        let bestDist = Infinity;
        for (const store of GENERAL_STORES) {
            const d = cheb(here, store.stand);
            if (d < bestDist) {
                bestDist = d;
                best = store;
            }
        }
        if (!best) {
            this.log('WARNING: no general store locations configured');
            await Execution.delayTicks(8);
            return;
        }

        this.storeLabel = best.label;
        this.status = `walking to ${best.label}`;
        this.log(`walking to ${best.label} @ ${best.stand.x},${best.stand.z}`);
        const ok = await Traversal.walkResilient(best.stand, {
            radius: 3,
            log: m => this.log(`  ${m}`)
        });
        if (!ok) {
            this.log('path failed — retrying');
            return;
        }

        this.status = `opening ${best.keeper}`;
        if (!(await Shop.open(best.keeper))) {
            // Some towns use Shop assistant when keeper is busy / out of range.
            if (best.keeper === 'Shop keeper') {
                await Shop.open('Shop assistant');
            } else if (best.keeper === 'Aemad') {
                await Shop.open('Kortan');
            }
            if (!Shop.isOpen()) {
                await this.openNearbyDoor();
                this.log(`could not open ${best.keeper} — retrying`);
                await Execution.delayTicks(2);
            }
        }
    }

    async sellOpenShop() {
        const stacks = notedItems();
        if (stacks.length === 0) {
            await Shop.close();
            return;
        }

        const item = stacks[0];
        const name = item.name;
        const id = item.id;
        const want = Math.max(1, item.count);
        this.status = `selling ${name} ×${want}`;
        this.log(`Sell ${want}× ${name} (id ${id})`);

        const sold = await Shop.sell(name, want, i => i.id === id);
        if (sold > 0) {
            this.soldUnits += sold;
            this.soldStacks++;
            this.log(`sold ${sold}× ${name}`);
            await Execution.delayTicks(1);
            return;
        }

        // Fallback: sell by name without id filter (still only called for noted candidates).
        const sold2 = await Shop.sell(name, want);
        if (sold2 > 0) {
            this.soldUnits += sold2;
            this.soldStacks++;
            this.log(`sold ${sold2}× ${name} (name match)`);
            await Execution.delayTicks(1);
            return;
        }

        this.log(`could not sell ${name} — skipping stack`);
        // Avoid infinite loop on unsellable stack: drop out of noted filter by... we can't.
        // Close and mark stuck if nothing progresses.
        await Execution.delayTicks(2);
        if (notedItems().some(i => i.id === id && i.slot === item.slot)) {
            this.log(`WARNING: stuck on ${name} — closing shop`);
            await Shop.close();
            this.done = true;
            this.status = 'stuck';
        }
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
        await door.interact(op);
        await Execution.delayTicks(2);
        return true;
    }

    onPaint(ctx) {
        const lines = [
            `Benzyme's Noted Seller`,
            `Time ${fmtElapsed(Date.now() - this.startedAt)}  ·  ${this.status}`,
            `Store ${this.storeLabel || '—'}`,
            `Noted left ${notedItems().length} stack(s) / ${notedCount()} units`,
            `Sold ${this.soldUnits} units · ${this.soldStacks} stacks`
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
        ctx.fillStyle = '#e8c547';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Money Making',
    tags: ['shop', 'general store', 'noted', 'sell', 'arhein'],
    description:
        "Benzyme's Noted Seller — sells all noted inventory stacks to the nearest general store (includes Arhein)",
    settingsSchema: {},
    create: () => new GeneralStoreNotedSeller()
});
