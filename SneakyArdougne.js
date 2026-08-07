/**
 * SneakyArdougne — pickpocket Lumbridge Men until 60gp (HP ≥ 5), then boat to Ardougne
 * via Port Sarim → Karamja → Brimhaven.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('SneakyArdougne: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `SneakyArdougne: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    Traversal,
    Tile,
    Skills,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'SneakyArdougne';

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
const PAY_FARE_OP = 'Pay-fare';
const STUN_RE = /been stunned|fail to pick/i;
const STUN_TICKS = 9;

/** Both boat fares (Port Sarim → Karamja + Brimhaven → Ardougne). */
const GP_TARGET = 60;
/** Never pickpocket below this HP — wait for natural regen. */
const MIN_HP = 5;

/** Lumbridge castle courtyard — Men wander here. */
const LUMBY_MEN = new Tile(3222, 3218, 0);
const LUMBY_LEASH = 16;

/** Port Sarim dock — Captain Tobias / Seaman Lorris / Seaman Thresnor. */
const PORT_SARIM_DOCK = new Tile(3029, 3217, 0);
/** Brimhaven docks — Captain Barnaby. */
const BRIMHAVEN_DOCK = new Tile(2772, 3227, 0);
/** Soft "done" pin in East Ardougne. */
const ARDOUGNE_TOWN = new Tile(2663, 3303, 0);

const SARIM_SAILORS = ['Captain Tobias', 'Seaman Lorris', 'Seaman Thresnor'];
const BRIM_CAPTAIN = 'Captain Barnaby';

const PHASE = {
    THIEVE: 'thieve',
    WALK_SARIM: 'walk_sarim',
    BOAT_KARAMJA: 'boat_karamja',
    WALK_BRIMHAVEN: 'walk_brimhaven',
    BOAT_ARDOUGNE: 'boat_ardougne',
    DONE: 'done'
};

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

function invCoins() {
    return Inventory.items()
        .filter(i => (i.name ?? '').toLowerCase() === 'coins')
        .reduce((n, i) => n + Math.max(0, i.count), 0);
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

function inBox(tile, x0, z0, x1, z1) {
    if (!tile) {
        return false;
    }
    const x = tile.x;
    const z = tile.z;
    return x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && z >= Math.min(z0, z1) && z <= Math.max(z0, z1);
}

function regionOf(tile) {
    if (!tile) {
        return 'unknown';
    }
    if (inBox(tile, 2600, 3260, 2730, 3345)) {
        return 'ardougne';
    }
    if (inBox(tile, 2740, 3140, 2820, 3290)) {
        return 'brimhaven';
    }
    if (inBox(tile, 2880, 3100, 2985, 3200)) {
        return 'musa';
    }
    if (inBox(tile, 3005, 3175, 3060, 3260)) {
        return 'sarim';
    }
    if (inBox(tile, 3185, 3185, 3265, 3265)) {
        return 'lumbridge';
    }
    if (inBox(tile, 2820, 3100, 2985, 3290)) {
        return 'karamja';
    }
    return 'unknown';
}

function pickBoatOption(options, prefer) {
    const prefs = Array.isArray(prefer) ? prefer : [prefer];
    for (const p of prefs) {
        const hit = options.find(o => (o ?? '').toLowerCase().includes(p.toLowerCase()));
        if (hit) {
            return hit;
        }
    }
    const yes = options.find(o => /^yes/i.test(o ?? ''));
    if (yes) {
        return yes;
    }
    return options.length > 0 ? options[0] : null;
}

class SneakyArdougne extends LoopingBot {
    status = 'starting';
    phase = PHASE.THIEVE;
    minHp = MIN_HP;
    gpTarget = GP_TARGET;
    steals = 0;
    fails = 0;
    startedAt = 0;
    xpAtStart = 0;
    stunnedUntilTick = 0;
    arrived = false;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.minHp = MIN_HP;
        this.gpTarget = GP_TARGET;
        this.startedAt = Date.now();
        this.xpAtStart = Skills.xp('thieving');
        this.steals = 0;
        this.fails = 0;
        this.stunnedUntilTick = 0;
        this.arrived = false;
        this.phase = this.inferPhase();

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

        this.log(
            `SneakyArdougne — pickpocket Lumbridge Men until ${this.gpTarget}gp ` +
                `(wait if HP < ${this.minHp}), then Port Sarim → Karamja → Brimhaven → Ardougne`
        );
        this.log(`start phase: ${this.phase} · coins ${invCoins()}gp · region ${regionOf(Game.tile())}`);
        this.status = this.phase;
    }

    onStop() {
        this.log(
            `stopped — ${this.steals} steals, ${this.fails} fails, ${invCoins()}gp, phase ${this.phase} (${this.status})`
        );
    }

    /**
     * Resume mid-route if the player is already past Lumbridge thieving.
     */
    inferPhase() {
        const here = Game.tile();
        const region = regionOf(here);
        const coins = invCoins();

        if (region === 'ardougne') {
            return PHASE.DONE;
        }
        if (region === 'brimhaven') {
            return PHASE.BOAT_ARDOUGNE;
        }
        if (region === 'musa' || region === 'karamja') {
            return PHASE.WALK_BRIMHAVEN;
        }
        if (region === 'sarim') {
            return coins >= 30 ? PHASE.BOAT_KARAMJA : PHASE.WALK_SARIM;
        }
        if (coins >= this.gpTarget) {
            return PHASE.WALK_SARIM;
        }
        return PHASE.THIEVE;
    }

    stunned() {
        return Game.tick() <= this.stunnedUntilTick;
    }

    needHpWait() {
        return Skills.effective('hitpoints') < this.minHp;
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

        if (await this.handleDialog()) {
            return;
        }

        if (this.arrived || this.phase === PHASE.DONE) {
            await this.finish();
            return;
        }

        // Re-infer if we somehow teleported / boarded between loops.
        if (this.phase !== PHASE.THIEVE) {
            const inferred = this.inferPhase();
            if (
                inferred === PHASE.DONE ||
                (inferred === PHASE.WALK_BRIMHAVEN && this.phase === PHASE.BOAT_KARAMJA) ||
                (inferred === PHASE.BOAT_ARDOUGNE && this.phase === PHASE.WALK_BRIMHAVEN) ||
                (inferred === PHASE.DONE && this.phase === PHASE.BOAT_ARDOUGNE)
            ) {
                this.phase = inferred;
            }
        }

        switch (this.phase) {
            case PHASE.THIEVE:
                await this.doThieve();
                break;
            case PHASE.WALK_SARIM:
                await this.doWalkSarim();
                break;
            case PHASE.BOAT_KARAMJA:
                await this.doBoatKaramja();
                break;
            case PHASE.WALK_BRIMHAVEN:
                await this.doWalkBrimhaven();
                break;
            case PHASE.BOAT_ARDOUGNE:
                await this.doBoatArdougne();
                break;
            default:
                await this.finish();
                break;
        }
    }

    /**
     * Drive ship / sailor chat. Prefer destination keywords, else Yes.
     * @returns {Promise<boolean>} true if dialog was handled this tick
     */
    async handleDialog() {
        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return true;
        }
        if (
            typeof ChatDialog.isOpen === 'function' &&
            ChatDialog.isOpen() &&
            typeof ChatDialog.options === 'function' &&
            ChatDialog.options().length > 0 &&
            typeof ChatDialog.chooseOption === 'function'
        ) {
            const opts = ChatDialog.options();
            let prefer = ['yes please', 'yes', 'karamja', 'musa'];
            if (this.phase === PHASE.BOAT_ARDOUGNE || regionOf(Game.tile()) === 'brimhaven') {
                prefer = ['ardougne', 'yes please', 'yes'];
            }
            const pick = pickBoatOption(opts, prefer);
            this.status = `dialog: ${pick ?? '?'}`;
            this.log(`dialog → ${pick}  [${opts.join(' | ')}]`);
            if (pick) {
                await ChatDialog.chooseOption(pick);
            } else {
                await ChatDialog.chooseOption();
            }
            await Execution.delayTicks(2);
            return true;
        }
        return false;
    }

    async doThieve() {
        if (invCoins() >= this.gpTarget) {
            this.log(`have ${invCoins()}gp (≥ ${this.gpTarget}) — heading to Port Sarim`);
            this.phase = PHASE.WALK_SARIM;
            this.status = 'walk Port Sarim';
            return;
        }

        if (this.needHpWait()) {
            const hp = Skills.effective('hitpoints');
            this.status = `HP ${hp} — regen to ${this.minHp}`;
            await Execution.delayTicks(2);
            return;
        }

        if (this.stunned()) {
            this.status = 'stunned';
            await Execution.delayTicks(1);
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(LUMBY_MEN) > LUMBY_LEASH) {
            this.status = 'walking to Lumbridge Men';
            await Traversal.walkResilient(LUMBY_MEN, {
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

        const npc = this.findMan();
        if (!npc) {
            this.status = 'waiting for Man';
            await Traversal.walkTo(LUMBY_MEN, { radius: 3, timeoutMs: 8_000 });
            await this.openNearbyDoor();
            await Execution.delayTicks(2);
            return;
        }

        await this.pickpocket(npc);
    }

    findMan() {
        return Npcs.query()
            .name('Man')
            .action(PICKPOCKET_OP)
            .within(LUMBY_LEASH + 4)
            .where(n => !n.inCombat)
            .nearest();
    }

    async pickpocket(npc) {
        const beforeXp = Skills.xp('thieving');
        const coinsBefore = invCoins();
        const t = npc.tile();
        this.status = `pickpocket Man (${npc.distance()}t)`;
        this.log(`Pickpocket Man @ ${t.x},${t.z} · ${coinsBefore}gp · HP ${Skills.effective('hitpoints')}`);

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
                ChatDialog.canContinue() ||
                invCoins() > coinsBefore,
            4000
        );

        if (Skills.xp('thieving') > beforeXp || invCoins() > coinsBefore) {
            this.steals++;
            return;
        }

        if (!ok) {
            this.log('pickpocket did not resolve — retrying');
        }
    }

    async doWalkSarim() {
        const here = Game.tile();
        if (here && PORT_SARIM_DOCK.distanceTo(here) <= 6) {
            this.phase = PHASE.BOAT_KARAMJA;
            this.status = 'boat to Karamja';
            return;
        }
        this.status = 'walking to Port Sarim';
        this.log(`walking to Port Sarim dock @ ${PORT_SARIM_DOCK.x},${PORT_SARIM_DOCK.z}`);
        await Traversal.walkResilient(PORT_SARIM_DOCK, {
            radius: 4,
            log: m => this.log(`  ${m}`)
        });
        const after = Game.tile();
        if (after && PORT_SARIM_DOCK.distanceTo(after) <= 6) {
            this.phase = PHASE.BOAT_KARAMJA;
        }
    }

    async doBoatKaramja() {
        if (regionOf(Game.tile()) === 'musa' || regionOf(Game.tile()) === 'karamja') {
            this.log('arrived Musa Point / Karamja — walking to Brimhaven');
            this.phase = PHASE.WALK_BRIMHAVEN;
            return;
        }

        if (invCoins() < 30) {
            this.status = 'need 30gp for Sarim boat';
            this.log(`WARNING: only ${invCoins()}gp — need 30 for Port Sarim → Karamja`);
            this.phase = PHASE.THIEVE;
            await Execution.delayTicks(5);
            return;
        }

        if (await this.crossGangplank()) {
            return;
        }

        const sailor = this.findSarimSailor();
        if (!sailor) {
            this.status = 'looking for sailor';
            await Traversal.walkResilient(PORT_SARIM_DOCK, {
                radius: 3,
                timeoutMs: 10_000,
                log: m => this.log(`  ${m}`)
            });
            await Execution.delayTicks(2);
            return;
        }

        const before = Game.tile();
        const coinsBefore = invCoins();
        const fareOp = this.fareOp(sailor);
        this.status = `${fareOp} → Karamja`;
        this.log(`${fareOp} ${sailor.name} for Karamja (${coinsBefore}gp)`);

        if (!(await sailor.interact(fareOp))) {
            await Execution.delayTicks(2);
            return;
        }

        await Execution.delayUntil(
            () =>
                ChatDialog.canContinue() ||
                (typeof ChatDialog.isOpen === 'function' &&
                    ChatDialog.isOpen() &&
                    typeof ChatDialog.options === 'function' &&
                    ChatDialog.options().length > 0) ||
                regionOf(Game.tile()) === 'musa' ||
                regionOf(Game.tile()) === 'karamja' ||
                invCoins() < coinsBefore ||
                this.movedFar(before, 20),
            8000
        );

        if (await this.handleDialog()) {
            await Execution.delayUntil(
                () =>
                    regionOf(Game.tile()) === 'musa' ||
                    regionOf(Game.tile()) === 'karamja' ||
                    this.movedFar(before, 20),
                12_000
            );
        }

        if (regionOf(Game.tile()) === 'musa' || regionOf(Game.tile()) === 'karamja') {
            this.phase = PHASE.WALK_BRIMHAVEN;
            this.log('boat landed on Karamja');
            return;
        }

        await this.crossGangplank();
        await Execution.delayTicks(2);
    }

    findSarimSailor() {
        for (const name of SARIM_SAILORS) {
            const npc = Npcs.query().name(name).within(18).nearest();
            if (npc) {
                return npc;
            }
        }
        return (
            Npcs.query()
                .within(18)
                .where(n => {
                    const acts = typeof n.actions === 'function' ? n.actions() : [];
                    return acts.some(a => /pay-?fare/i.test(a ?? ''));
                })
                .nearest() ?? null
        );
    }

    async doWalkBrimhaven() {
        const here = Game.tile();
        if (here && BRIMHAVEN_DOCK.distanceTo(here) <= 8) {
            this.phase = PHASE.BOAT_ARDOUGNE;
            this.status = 'boat to Ardougne';
            return;
        }
        if (regionOf(here) === 'brimhaven') {
            this.phase = PHASE.BOAT_ARDOUGNE;
            return;
        }

        this.status = 'walking to Brimhaven';
        this.log(`walking Musa/Karamja → Brimhaven dock @ ${BRIMHAVEN_DOCK.x},${BRIMHAVEN_DOCK.z}`);
        await Traversal.walkResilient(BRIMHAVEN_DOCK, {
            radius: 5,
            log: m => this.log(`  ${m}`)
        });
        await this.openNearbyDoor();

        const after = Game.tile();
        if (after && (BRIMHAVEN_DOCK.distanceTo(after) <= 8 || regionOf(after) === 'brimhaven')) {
            this.phase = PHASE.BOAT_ARDOUGNE;
        }
    }

    async doBoatArdougne() {
        if (regionOf(Game.tile()) === 'ardougne') {
            this.log('arrived Ardougne');
            this.phase = PHASE.DONE;
            return;
        }

        if (invCoins() < 30) {
            this.status = 'need 30gp for Brimhaven boat';
            this.log(`WARNING: only ${invCoins()}gp — need 30 for Brimhaven → Ardougne`);
            await Execution.delayTicks(8);
            return;
        }

        if (await this.crossGangplank()) {
            return;
        }

        const cap = this.findBarnaby();
        if (!cap) {
            this.status = 'looking for Barnaby';
            await Traversal.walkResilient(BRIMHAVEN_DOCK, {
                radius: 3,
                timeoutMs: 10_000,
                log: m => this.log(`  ${m}`)
            });
            await Execution.delayTicks(2);
            return;
        }

        const before = Game.tile();
        const coinsBefore = invCoins();
        const fareOp = this.fareOp(cap);
        this.status = `${fareOp} → Ardougne`;
        this.log(`${fareOp} ${cap.name} for Ardougne (${coinsBefore}gp)`);

        if (!(await cap.interact(fareOp))) {
            await Execution.delayTicks(2);
            return;
        }

        await Execution.delayUntil(
            () =>
                ChatDialog.canContinue() ||
                (typeof ChatDialog.isOpen === 'function' &&
                    ChatDialog.isOpen() &&
                    typeof ChatDialog.options === 'function' &&
                    ChatDialog.options().length > 0) ||
                regionOf(Game.tile()) === 'ardougne' ||
                invCoins() < coinsBefore ||
                this.movedFar(before, 20),
            8000
        );

        if (await this.handleDialog()) {
            await Execution.delayUntil(
                () => regionOf(Game.tile()) === 'ardougne' || this.movedFar(before, 20),
                12_000
            );
        }

        if (regionOf(Game.tile()) === 'ardougne') {
            this.phase = PHASE.DONE;
            this.log('boat landed in Ardougne');
            return;
        }

        await this.crossGangplank();
        await Execution.delayTicks(2);
    }

    findBarnaby() {
        return (
            Npcs.query().name(BRIM_CAPTAIN).within(18).nearest() ??
            Npcs.query()
                .within(18)
                .where(n => {
                    const acts = typeof n.actions === 'function' ? n.actions() : [];
                    return acts.some(a => /pay-?fare/i.test(a ?? ''));
                })
                .nearest() ??
            null
        );
    }

    fareOp(npc) {
        const acts = typeof npc.actions === 'function' ? npc.actions() : [];
        const pay = acts.find(a => /pay-?fare/i.test(a ?? ''));
        if (pay) {
            return pay;
        }
        const talk = acts.find(a => /^talk/i.test(a ?? ''));
        return talk ?? 'Talk-to';
    }

    movedFar(from, tiles) {
        const now = Game.tile();
        if (!from || !now) {
            return false;
        }
        return Tile.from(from).distanceTo(now) >= tiles;
    }

    /**
     * Some boat flows leave you on the ship — Cross the Gangplank.
     */
    async crossGangplank() {
        const plank = Locs.query()
            .within(10)
            .where(l => /gangplank/i.test(l.name ?? ''))
            .nearest();
        if (!plank) {
            return false;
        }
        const op =
            plank.actions().find(a => /cross|walk|climb/i.test(a ?? '')) ??
            plank.actions()[0] ??
            null;
        if (!op) {
            return false;
        }
        const before = Game.tile();
        this.status = `cross ${plank.name}`;
        this.log(`crossing ${plank.name} (${op})`);
        if (!(await plank.interact(op))) {
            return false;
        }
        await Execution.delayUntil(() => this.movedFar(before, 3), 6000);
        return true;
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

    async finish() {
        this.phase = PHASE.DONE;
        this.arrived = true;
        const here = Game.tile();
        if (here && ARDOUGNE_TOWN.distanceTo(here) > 20) {
            this.status = 'walking into Ardougne';
            await Traversal.walkResilient(ARDOUGNE_TOWN, {
                radius: 6,
                attempts: 2,
                timeoutMs: 20_000,
                log: m => this.log(`  ${m}`)
            });
        }
        this.status = 'arrived Ardougne';
        this.log(
            `done — Ardougne reached with ${invCoins()}gp · ${this.steals} steals · ${this.fails} fails`
        );
        stopScript();
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hp = Skills.effective('hitpoints');
        const coins = invCoins();
        const lines = [
            `SneakyArdougne`,
            `Time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `Phase ${this.phase}  ·  region ${regionOf(Game.tile())}`,
            `HP ${hp}/${Skills.level('hitpoints')}  ·  wait < ${this.minHp}`,
            `Coins ${coins}/${this.gpTarget}gp  ·  steals ${this.steals}  fails ${this.fails}`,
            `Thieving ${Skills.level('thieving')}  (+${Math.round(Skills.xp('thieving') - this.xpAtStart)} xp)`
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
        ctx.fillStyle = this.arrived ? '#9be05b' : '#c9a227';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Thieving',
    tags: [
        'thieving',
        'pickpocket',
        'lumbridge',
        'port sarim',
        'karamja',
        'brimhaven',
        'ardougne',
        'boat',
        'travel'
    ],
    description:
        'Pickpocket Lumbridge Men until 60gp (regen HP to 5+), then boat Port Sarim → Karamja → Brimhaven → Ardougne',
    settingsSchema: {},
    create: () => new SneakyArdougne()
});
