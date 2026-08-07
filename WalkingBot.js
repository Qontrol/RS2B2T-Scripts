/**
 * WalkingBot — walk to a chosen town pin and stop.
 * Destinations: Port Sarim, Draynor, Catherby, Ardougne, Seers, Falador,
 * Rimmington, Varrock, Barbarian Village, Edgeville, Taverley.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('WalkingBot: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `WalkingBot: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const { defineBot, Execution, Game, LoopingBot, Traversal, Tile } = abi;

const SCRIPT_NAME = "Benzyme's Walker";

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

const DESTINATIONS = [
    { name: 'Port Sarim', tile: new Tile(3028, 3235, 0) },
    { name: 'Draynor Village', tile: new Tile(3094, 3244, 0) },
    { name: 'Catherby', tile: new Tile(2809, 3440, 0) },
    { name: 'Ardougne', tile: new Tile(2663, 3303, 0) },
    { name: 'Seers Village', tile: new Tile(2702, 3484, 0) },
    { name: 'Falador', tile: new Tile(2963, 3382, 0) },
    { name: 'Rimmington', tile: new Tile(2956, 3214, 0) },
    { name: 'Varrock', tile: new Tile(3213, 3425, 0) },
    { name: 'Barbarian Village', tile: new Tile(3084, 3420, 0) },
    { name: 'Edgeville', tile: new Tile(3093, 3493, 0) },
    { name: 'Taverley', tile: new Tile(2899, 3458, 0) }
];

const DEST_NAMES = DESTINATIONS.map(d => d.name);
const DEFAULT_DEST = DEST_NAMES[0];

function resolveDest(name) {
    const key = (name ?? '').trim().toLowerCase();
    return DESTINATIONS.find(d => d.name.toLowerCase() === key) ?? null;
}

/** Matches rs2b0t SettingsStore boxKey(`set:${name}:${key}`). */
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

function isPanelPaused() {
    return !!document.querySelector('.rs2b0t-value.rs2b0t-state-paused');
}

/**
 * Host disables Edit parameters while running *or* paused. Re-enable while
 * paused so Destination can be changed without stopping the script.
 */
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

function sameTile(a, b) {
    return (
        !!a &&
        !!b &&
        a.x === b.x &&
        a.z === b.z &&
        (a.level ?? 0) === (b.level ?? 0)
    );
}

class WalkingBot extends LoopingBot {
    status = 'starting';
    destName = DEFAULT_DEST;
    /** @type {InstanceType<typeof Tile> | null} */
    target = null;
    radius = 3;
    arrived = false;
    tripStartDist = 0;
    startedAt = 0;
    /** Bumped whenever Destination changes — aborts walks aimed at the old pin. */
    walkEpoch = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();

        this.syncPrefs({ silent: true, resetTrip: true });
        this.startedAt = Date.now();
        this.arrived = false;

        if (!this.target) {
            this.log('WalkingBot: no destination — stopping');
            throw new Error('WalkingBot: no destination');
        }

        const here = Game.tile();
        this.tripStartDist = here ? this.target.distanceTo(here) : 0;
        this.log(
            `walking to ${this.destName} @ ${this.target.x},${this.target.z},${this.target.level}` +
                ` (arrive within ${this.radius})`
        );
        this.status = `walking to ${this.destName}`;
    }

    startPausedPrefUnlock() {
        unlockPausedPrefsUi();
        this.unlockTimer = setInterval(() => {
            unlockPausedPrefsUi();
            // Loop is suspended while paused — keep Dest / radius live from panel edits.
            if (isPanelPaused()) {
                this.syncPrefs({ silent: true });
            }
        }, 400);
    }

    onStop() {
        if (this.unlockTimer != null) {
            clearInterval(this.unlockTimer);
            this.unlockTimer = null;
        }
        this.log(`stopped — ${this.status}`);
    }

    syncPrefs({ silent = false, resetTrip = false } = {}) {
        const prevName = this.destName;
        const prevTarget = this.target;
        const prevRadius = this.radius;

        this.destName = readPrefStr(
            'destination',
            this.settings.str('destination', DEFAULT_DEST)
        );
        this.radius = Math.max(
            0,
            Math.min(
                12,
                readPrefNum('arriveRadius', this.settings.num('arriveRadius', 3))
            )
        );

        const dest = resolveDest(this.destName) ?? resolveDest(DEFAULT_DEST);
        this.destName = dest.name;
        this.target = dest.tile;

        const destChanged =
            prevName !== this.destName || !sameTile(prevTarget, this.target);
        if (destChanged || resetTrip) {
            this.arrived = false;
            const here = Game.tile();
            this.tripStartDist = here && this.target ? this.target.distanceTo(here) : 0;
            if (destChanged) {
                this.walkEpoch++;
                this.status = `walking to ${this.destName}`;
            }
            if (!silent && destChanged) {
                this.log(
                    `prefs: destination → ${this.destName} @ ${this.target.x},${this.target.z}`
                );
            }
        }
        if (!silent && prevRadius !== this.radius) {
            this.log(`prefs: arrive within → ${this.radius}`);
        }
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

        if (!this.target) {
            this.status = 'no destination';
            await Execution.delayTicks(8);
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        const dist = this.target.distanceTo(here);
        if (dist <= this.radius) {
            this.arrived = true;
            this.status = `arrived at ${this.destName}`;
            this.log(
                `arrived at ${this.destName} (${here.x}, ${here.z}, ${here.level}) — stopping`
            );
            stopScript();
            return;
        }

        // Snapshot the pin this chunk is walking toward. Short timeouts so a
        // Destination change (pause → edit → resume) abandons the old path
        // instead of finishing a long trek to the previous town.
        const epoch = this.walkEpoch;
        const destName = this.destName;
        const target = this.target;
        const radius = this.radius;

        this.arrived = false;
        this.status = `walking to ${destName}`;
        this.log(
            `walking to ${destName} @ ${target.x},${target.z} (${dist}t away)`
        );

        const ok = await Traversal.walkResilient(target, {
            radius,
            attempts: 2,
            timeoutMs: 12_000,
            log: m => this.log(`  ${m}`)
        });

        this.syncPrefs({ silent: true });
        if (this.walkEpoch !== epoch || !sameTile(this.target, target)) {
            this.log(`changed mind — now walking to ${this.destName}`);
            return;
        }

        const after = Game.tile();
        if (after && target.distanceTo(after) <= radius) {
            this.arrived = true;
            this.status = `arrived at ${destName}`;
            this.log(
                `arrived at ${destName} (${after.x}, ${after.z}, ${after.level}) — stopping`
            );
            stopScript();
            return;
        }

        if (!ok) {
            this.status = `stuck — retry ${destName}`;
            this.log(`path failed toward ${destName} — retrying`);
        }
    }

    onPaint(ctx) {
        // Host snapshots settings at Start; re-read so pause/run param edits show on Dest.
        this.syncPrefs({ silent: true });

        const here = Game.tile();
        const dist = here && this.target ? this.target.distanceTo(here) : -1;
        const elapsed = this.startedAt ? fmtElapsed(Date.now() - this.startedAt) : '0:00';
        const progress =
            this.arrived
                ? 1
                : this.tripStartDist > 0 && dist >= 0
                  ? Math.max(0, Math.min(1, 1 - dist / this.tripStartDist))
                  : 0;
        const pct = Math.round(progress * 100);

        const lines = [
            `Benzyme's Walker`,
            `Dest: ${this.destName}`,
            this.arrived
                ? 'ARRIVED'
                : dist >= 0
                  ? `${dist} tiles away · within ${this.radius}`
                  : '…',
            `Trip ${pct}% · ${elapsed}`
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
        ctx.fillStyle = this.arrived ? '#9be05b' : '#6cb6ff';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Utility',
    tags: [
        'walk',
        'travel',
        'port sarim',
        'draynor',
        'catherby',
        'ardougne',
        'seers',
        'falador',
        'rimmington',
        'varrock',
        'barbarian village',
        'edgeville',
        'taverley'
    ],
    description:
        "Benzyme's Walker — walks to a chosen town pin (Port Sarim, Draynor, Catherby, Ardougne, Seers, Falador, Rimmington, Varrock, Barbarian Village, Edgeville, Taverley) and stops",
    settingsSchema: {
        destination: {
            type: 'string',
            default: DEFAULT_DEST,
            options: DEST_NAMES,
            label: 'Destination',
            group: 'Travel',
            help: 'Town pin to walk to'
        },
        arriveRadius: {
            type: 'number',
            default: 3,
            min: 0,
            max: 12,
            label: 'Arrive within (tiles)',
            group: 'Travel',
            help: 'Stop when this close to the destination tile'
        }
    },
    create: () => new WalkingBot()
});
