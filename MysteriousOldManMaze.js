/**
 * MysteriousOldManMaze — solve the Mysterious Old Man maze random event.
 * (Often called "wise old man maze"; the NPC is Mysterious Old Man.)
 *
 * Detects where you are stuck, tries Open on maze Walls, blacklists
 * wrong-way / fake walls ("I don't think that's the right way." /
 * "I can't open that."), prefers doors that move you closer to the
 * Strange shrine, walks the ring when no candidates are near, then
 * Touches the shrine at the centre.
 *
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('MysteriousOldManMaze: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `MysteriousOldManMaze: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Locs,
    Npcs,
    Traversal,
    Tile,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'MysteriousOldManMaze';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/**
 * Lost City / 2004scape maze mapzone 0_45_71.
 * Absolute tiles: mx*64+lx → centre ~2910,4576; spawns in the four corners.
 */
const MAZE_MIN_X = 2880;
const MAZE_MAX_X = 2943;
const MAZE_MIN_Z = 4544;
const MAZE_MAX_Z = 4607;
/** Fallback shrine tile if scenery is not loaded yet. */
const SHRINE_FALLBACK = new Tile(2910, 4576, 0);

const FAIL_RE =
    /don'?t think that'?s the right way|can'?t open that|wrong way|try a different/i;
const MAZE_HINT_RE = /reach the maze centre|returned to where you were/i;
const MOM_NAMES = ['Mysterious Old Man', 'Wise Old Man'];

function welcomeHost() {
    return globalThis.rs2b0t ?? null;
}

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

function modalTexts() {
    const host = welcomeHost();
    if (!host?.reader || typeof host.reader.mainModalTexts !== 'function') {
        return [];
    }
    try {
        return host.reader.mainModalTexts() ?? [];
    } catch {
        return [];
    }
}

function textsMatchFail(texts) {
    return texts.some(t => FAIL_RE.test(t ?? ''));
}

function inMazeBounds(tile) {
    if (!tile) {
        return false;
    }
    return (
        tile.x >= MAZE_MIN_X &&
        tile.x <= MAZE_MAX_X &&
        tile.z >= MAZE_MIN_Z &&
        tile.z <= MAZE_MAX_Z
    );
}

function locKey(loc) {
    const t = loc.tile();
    return `${t.x},${t.z},${t.level ?? 0}`;
}

function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function distTo(a, b) {
    return Tile.from(a).distanceTo(Tile.from(b));
}

function openOp(loc) {
    const acts = typeof loc.actions === 'function' ? loc.actions() : [];
    return acts.find(a => /^open$/i.test(a ?? '')) ?? null;
}

function touchOp(loc) {
    const acts = typeof loc.actions === 'function' ? loc.actions() : [];
    return (
        acts.find(a => /^touch$/i.test(a ?? '')) ??
        acts.find(a => /touch|use|enter/i.test(a ?? '')) ??
        null
    );
}

function talkOp(npc) {
    const acts = typeof npc.actions === 'function' ? npc.actions() : [];
    return acts.find(a => /^talk/i.test(a ?? '')) ?? 'Talk-to';
}

function isMazeWall(loc) {
    const name = (loc.name ?? '').toLowerCase();
    if (name !== 'wall') {
        return false;
    }
    return openOp(loc) !== null;
}

function isChest(loc) {
    return /^chest$/i.test(loc.name ?? '');
}

function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

class MysteriousOldManMaze extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    doorsTried = 0;
    doorsFailed = 0;
    doorsPassed = 0;
    completed = false;
    /** @type {Set<string>} */
    blacklist = new Set();
    /** Last fail flagged by chat.message / modal */
    failFlag = false;
    /** Cached shrine tile once seen */
    shrineTile = null;
    exploreDir = 1;
    idleOutsideTicks = 0;
    stuckTicks = 0;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.startedAt = Date.now();
        this.doorsTried = 0;
        this.doorsFailed = 0;
        this.doorsPassed = 0;
        this.completed = false;
        this.blacklist = new Set();
        this.failFlag = false;
        this.shrineTile = null;
        this.exploreDir = 1;
        this.idleOutsideTicks = 0;
        this.stuckTicks = 0;

        this.on('chat.message', e => {
            const text = e?.text ?? '';
            if (FAIL_RE.test(text)) {
                this.failFlag = true;
            }
            if (MAZE_HINT_RE.test(text)) {
                this.log('maze start hint received');
            }
        });

        this.log(
            'MysteriousOldManMaze — talk to Mysterious Old Man if he appears, ' +
                'then open correct Walls to the Strange shrine (blacklists wrong-way doors)'
        );
        if (this.inMaze()) {
            this.status = 'solving';
            this.log(`already in maze @ ${this.hereStr()}`);
        } else {
            this.status = 'waiting for random';
        }
    }

    onStop() {
        this.log(
            `stopped — passed ${this.doorsPassed}, failed ${this.doorsFailed}, ` +
                `tried ${this.doorsTried}, done=${this.completed} (${this.status})`
        );
    }

    hereStr() {
        const t = Game.tile();
        return t ? `${t.x},${t.z}` : '?';
    }

    inMaze() {
        const here = Game.tile();
        if (inMazeBounds(here)) {
            return true;
        }
        if (this.findShrine(24)) {
            return true;
        }
        // Cluster of openable Walls is a strong in-maze signal.
        const walls = Locs.query()
            .where(l => isMazeWall(l))
            .within(12)
            .results();
        return walls.length >= 3;
    }

    findShrine(within = 40) {
        const shrine =
            Locs.query().name('Strange shrine').within(within).nearest() ??
            Locs.query()
                .where(l => /strange\s*shrine/i.test(l.name ?? ''))
                .where(l => touchOp(l) !== null)
                .within(within)
                .nearest();
        if (shrine) {
            this.shrineTile = Tile.from(shrine.tile());
        }
        return shrine;
    }

    centreTile() {
        if (this.shrineTile) {
            return this.shrineTile;
        }
        const shrine = this.findShrine(48);
        if (shrine) {
            return Tile.from(shrine.tile());
        }
        return SHRINE_FALLBACK;
    }

    async clearDialogs() {
        let acted = false;
        for (let i = 0; i < 10; i++) {
            if (ChatDialog.canContinue()) {
                acted = true;
                await ChatDialog.continue();
                await Execution.delayTicks(1);
                continue;
            }
            if (
                typeof ChatDialog.isOpen === 'function' &&
                ChatDialog.isOpen() &&
                typeof ChatDialog.options === 'function' &&
                ChatDialog.options().length > 0 &&
                typeof ChatDialog.chooseOption === 'function'
            ) {
                acted = true;
                await ChatDialog.chooseOption();
                await Execution.delayTicks(1);
                continue;
            }
            break;
        }
        return acted;
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

        if (await this.clearDialogs()) {
            this.status = 'dialog';
            return;
        }

        if (this.completed) {
            this.status = 'done';
            this.log('maze complete — stopping');
            stopScript();
            return;
        }

        if (!this.inMaze()) {
            await this.waitOrAcceptRandom();
            return;
        }

        await this.solveMazeStep();
    }

    async waitOrAcceptRandom() {
        this.status = 'waiting for random';
        const mom = Npcs.query()
            .where(n => MOM_NAMES.some(name => (n.name ?? '').toLowerCase() === name.toLowerCase()))
            .within(12)
            .nearest();

        if (mom) {
            this.status = 'talk Mysterious Old Man';
            this.log(`talking to ${mom.name}`);
            const op = talkOp(mom);
            await mom.interact(op);
            await Execution.delayUntil(
                () => ChatDialog.canContinue() || ChatDialog.isOpen() || this.inMaze(),
                6000
            );
            await this.clearDialogs();
            if (this.inMaze()) {
                this.blacklist.clear();
                this.log(`entered maze @ ${this.hereStr()}`);
                this.status = 'solving';
            }
            return;
        }

        this.idleOutsideTicks++;
        if (this.idleOutsideTicks % 25 === 1) {
            this.log('not in maze — waiting for Mysterious Old Man (or start while already inside)');
        }
        await Execution.delayTicks(3);
    }

    async solveMazeStep() {
        this.status = 'solving';
        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        // Left the maze (shrine touched → teleport out).
        if (!this.inMaze() && this.doorsPassed > 0) {
            this.completed = true;
            this.status = 'done';
            this.log('left maze after progress — treating as complete');
            return;
        }

        const shrine = this.findShrine(30);
        if (shrine) {
            const st = Tile.from(shrine.tile());
            if (distTo(here, st) <= 3) {
                await this.touchShrine(shrine);
                return;
            }
        }

        const centre = this.centreTile();
        const hereDist = chebyshev(here, centre);
        const candidates = this.rankDoors(here, centre);

        if (candidates.length === 0) {
            this.status = 'exploring corridor';
            await this.exploreCorridor(here, centre);
            return;
        }

        const door = candidates[0];
        const key = locKey(door);
        const doorDist = chebyshev(door.tile(), centre);
        const inward = doorDist < hereDist;

        this.log(
            `try Wall @ ${door.tile().x},${door.tile().z} ` +
                `(${inward ? 'inward' : 'outward'}, ring ${hereDist}→${doorDist}, ` +
                `${candidates.length} candidates, ${this.blacklist.size} blocked)`
        );

        const ok = await this.tryDoor(door);
        if (ok) {
            this.doorsPassed++;
            this.stuckTicks = 0;
            this.status = `passed door (${this.doorsPassed})`;
            this.log(`passed door — now @ ${this.hereStr()}`);
            return;
        }

        this.blacklist.add(key);
        this.doorsFailed++;
        this.stuckTicks++;
        this.status = 'wrong door — trying another';
        this.log(`blocked Wall @ ${door.tile().x},${door.tile().z} (blacklist ${this.blacklist.size})`);

        // Flip explore direction if we keep failing.
        if (this.stuckTicks > 0 && this.stuckTicks % 4 === 0) {
            this.exploreDir *= -1;
        }
        await Execution.delayTicks(1);
    }

    /**
     * Prefer walls that sit closer to the shrine than we are (inward),
     * then nearer walls, then anything else still open.
     */
    rankDoors(here, centre) {
        const hereDist = chebyshev(here, centre);
        const walls = Locs.query()
            .where(l => isMazeWall(l))
            .where(l => !isChest(l))
            .where(l => !this.blacklist.has(locKey(l)))
            .within(18)
            .results();

        const scored = walls.map(loc => {
            const lt = loc.tile();
            const doorDist = chebyshev(lt, centre);
            const toPlayer = distTo(here, lt);
            const inward = doorDist < hereDist ? 0 : doorDist === hereDist ? 1 : 2;
            return { loc, inward, doorDist, toPlayer };
        });

        scored.sort((a, b) => {
            if (a.inward !== b.inward) {
                return a.inward - b.inward;
            }
            if (a.doorDist !== b.doorDist) {
                return a.doorDist - b.doorDist;
            }
            return a.toPlayer - b.toPlayer;
        });

        return scored.map(s => s.loc);
    }

    async tryDoor(door) {
        const op = openOp(door);
        if (!op) {
            return false;
        }

        const before = Game.tile();
        if (!before) {
            return false;
        }

        const dt = Tile.from(door.tile());
        if (distTo(before, dt) > 2) {
            this.status = 'walk to wall';
            await Traversal.walkTo(dt, { radius: 2, timeoutMs: 8_000 });
            await Execution.delayTicks(1);
        }

        this.failFlag = false;
        this.doorsTried++;
        const start = Game.tile();
        await door.interact(op);

        await Execution.delayUntil(
            () =>
                this.failFlag ||
                textsMatchFail(modalTexts()) ||
                ChatDialog.canContinue() ||
                this.movedFrom(start, 1),
            4500
        );

        if (this.failFlag || textsMatchFail(modalTexts())) {
            await this.clearDialogs();
            this.failFlag = false;
            return false;
        }

        if (ChatDialog.canContinue() || ChatDialog.isOpen()) {
            const texts = modalTexts();
            await this.clearDialogs();
            if (textsMatchFail(texts) || this.failFlag) {
                this.failFlag = false;
                return false;
            }
        }

        // Door open walks you onto / through the wall tile.
        await Execution.delayUntil(() => this.movedFrom(start, 1), 3500);
        if (this.movedFrom(start, 1)) {
            await Execution.delayUntil(() => !Game.animating(), 2000);
            return true;
        }

        // No movement and no fail dialog — treat as dead / fake wall.
        return false;
    }

    movedFrom(from, tiles) {
        const now = Game.tile();
        if (!from || !now) {
            return false;
        }
        return Tile.from(from).distanceTo(now) >= tiles;
    }

    async touchShrine(shrine) {
        const op = touchOp(shrine);
        if (!op) {
            this.log(`Strange shrine has no Touch: [${(shrine.actions?.() ?? []).join(', ')}]`);
            await Execution.delayTicks(2);
            return;
        }

        const before = Game.tile();
        const st = Tile.from(shrine.tile());
        if (before && distTo(before, st) > 2) {
            await Traversal.walkTo(st, { radius: 1, timeoutMs: 6_000 });
        }

        this.status = 'touch shrine';
        this.log(`Touch Strange shrine @ ${st.x},${st.z}`);
        await shrine.interact(op);

        await Execution.delayUntil(
            () =>
                !this.inMaze() ||
                ChatDialog.canContinue() ||
                this.movedFrom(before, 5),
            8000
        );
        await this.clearDialogs();

        if (!this.inMaze()) {
            this.completed = true;
            this.status = 'done';
            this.log('touched shrine — maze complete');
        }
    }

    /**
     * No usable walls nearby: walk along the current ring to find the next gate,
     * or step slightly outward/inward if the corridor dead-ends.
     */
    async exploreCorridor(here, centre) {
        const farther = Locs.query()
            .where(l => isMazeWall(l))
            .where(l => !this.blacklist.has(locKey(l)))
            .within(28)
            .results()
            .sort((a, b) => distTo(here, a.tile()) - distTo(here, b.tile()));

        if (farther.length > 0) {
            const target = Tile.from(farther[0].tile());
            this.log(`walk toward distant Wall @ ${target.x},${target.z}`);
            await Traversal.walkTo(target, { radius: 2, timeoutMs: 10_000 });
            return;
        }

        const dx = here.x - centre.x;
        const dz = here.z - centre.z;
        const len = Math.hypot(dx, dz) || 1;
        const step = 7;
        const px = (-dz / len) * this.exploreDir;
        const pz = (dx / len) * this.exploreDir;
        const rawX = Math.round(here.x + px * step);
        const rawZ = Math.round(here.z + pz * step);
        const dest = new Tile(
            Math.max(MAZE_MIN_X + 2, Math.min(MAZE_MAX_X - 2, rawX)),
            Math.max(MAZE_MIN_Z + 2, Math.min(MAZE_MAX_Z - 2, rawZ)),
            here.level ?? 0
        );

        this.log(`ring walk → ${dest.x},${dest.z} (dir ${this.exploreDir > 0 ? 'CW' : 'CCW'})`);
        const ok = await Traversal.walkTo(dest, { radius: 1, timeoutMs: 8_000 });
        if (!ok) {
            this.exploreDir *= -1;
            // Nudge toward / away from centre to escape a pocket.
            const nudge = chebyshev(here, centre) > 8 ? -2 : 2;
            const mid = new Tile(
                Math.round(here.x + (dx / len) * nudge),
                Math.round(here.z + (dz / len) * nudge),
                here.level ?? 0
            );
            await Traversal.walkTo(mid, { radius: 1, timeoutMs: 5_000 });
        }
    }

    onPaint(ctx) {
        const elapsed = this.startedAt ? fmtElapsed(Date.now() - this.startedAt) : '0:00';
        const here = Game.tile();
        const centre = this.centreTile();
        const ring = here ? chebyshev(here, centre) : -1;
        const lines = [
            'MOM Maze Solver',
            `${this.status}  ·  ${elapsed}`,
            `pos ${this.hereStr()}  ring ${ring}`,
            `doors +${this.doorsPassed} / -${this.doorsFailed}  block ${this.blacklist.size}`,
            this.completed ? 'COMPLETE' : this.inMaze() ? 'IN MAZE' : 'waiting…'
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
        ctx.fillStyle = this.completed ? '#9be05b' : this.inMaze() ? '#e0c36c' : '#6cb6ff';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Utility',
    tags: ['maze', 'random', 'mysterious old man', 'strange shrine', 'random event'],
    description:
        'Solves the Mysterious Old Man maze random event: finds where you are stuck, ' +
        'opens correct Walls (blacklists wrong-way / fake doors), and Touches the Strange shrine.',
    create: () => new MysteriousOldManMaze()
});
