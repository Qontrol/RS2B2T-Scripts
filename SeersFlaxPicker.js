/**
 * SeersFlaxPicker — pick Flax at the Seers' Village field, bank at Seers, return.
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
    Inventory,
    Bank,
    Banking,
    Traversal,
    Tile,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'SeersFlaxPicker';

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

/** Seers' Village flax field (south of bank, west of beehives). */
const ANCHOR = new Tile(2739, 3444, 0);
const LEASH = 22;
const STAND_RADIUS = 8;

/** Seers' Village bank stand. */
const BANK_STAND = new Tile(2727, 3493, 0);

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

function flaxCount() {
    return Inventory.items()
        .filter(i => isFlax(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
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

class SeersFlaxPicker extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    picked = 0;
    bankTrips = 0;
    lastFlaxSeen = 0;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.startedAt = Date.now();
        this.picked = 0;
        this.bankTrips = 0;
        this.lastFlaxSeen = flaxCount();

        this.log(
            `SeersFlaxPicker @ ${ANCHOR.x},${ANCHOR.z} — pick Flax, bank at Seers ${BANK_STAND.x},${BANK_STAND.z}`
        );
        this.status = 'ready';
    }

    onStop() {
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

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        if (Inventory.isFull() && flaxCount() > 0) {
            await this.bankAndReturn();
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(ANCHOR) > LEASH) {
            this.status = 'returning to flax';
            this.log('walking back to flax field');
            await Traversal.walkResilient(ANCHOR, {
                radius: 4,
                log: m => this.log(`  ${m}`)
            });
            await this.openNearbyBarrier();
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

    async openNearbyBarrier() {
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

    async bankAndReturn() {
        const held = flaxCount();
        this.status = 'banking';
        this.log(`banking ${held} Flax`);

        this.lastFlaxSeen = 0;

        await Banking.bankNearest({
            destination: { name: "Seers' Village", tile: BANK_STAND },
            deposit: name => isFlax(name),
            returnTo: ANCHOR,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.lastFlaxSeen = flaxCount();
        this.status = 'returning to flax';
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const pickPh = hrs > 0.008 ? this.picked / hrs : 0;

        const lines = [
            `Seers Flax Picker`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `picked ${this.picked} (${fmtXph(pickPh)}/hr)  inv ${flaxCount()}`,
            `bank trips ${this.bankTrips}`
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
        ctx.fillStyle = '#c4b07a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Gathering',
    tags: ['flax', 'seers', 'bank', 'crafting', 'fletching'],
    description:
        "Picks Flax at the Seers' Village field south of the bank, deposits full inventories, then returns to pick more.",
    create: () => new SeersFlaxPicker()
});
