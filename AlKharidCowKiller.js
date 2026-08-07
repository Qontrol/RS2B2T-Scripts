/**
 * AlKharidCowKiller — kill Lumbridge cows, loot Cow hide, bank at Al Kharid.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('AlKharidCowKiller: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `AlKharidCowKiller: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Npcs,
    Locs,
    GroundItems,
    Inventory,
    Bank,
    Banking,
    Traversal,
    Tile,
    Skills,
    ChatDialog
} = abi;

const SCRIPT_NAME = 'AlKharidCowKiller';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/** Lumbridge cow pen east of the castle / north of the windmill. */
const COW_SPOT = new Tile(3255, 3275, 0);
const LEASH = 14;
/** Only loot hides this far from camp. */
const LOOT_LEASH = 12;

/** Al Kharid bank stand (west of the palace). */
const BANK_STAND = new Tile(3269, 3167, 0);

const HIDE_NAME = 'Cow hide';
const DEATH_RE = /oh dear.*you are dead/i;
const CANT_REACH_RE = /i can't reach that/i;
const TOWARD_SLACK = 4;

/** Melee styles that train a single combat skill. */
const TRAINABLE = ['attack', 'strength', 'defence'];
const COMBAT_TRACK = ['attack', 'strength', 'defence', 'hitpoints'];

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

function cheb(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function inCowCamp(tile, radius = LEASH) {
    if (!tile) {
        return false;
    }
    return Tile.from(tile).distanceTo(COW_SPOT) <= radius;
}

function towardDest(door, here, dest) {
    return cheb(door, dest) <= cheb(here, dest) + TOWARD_SLACK;
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

function npcTargetsMe(n) {
    return typeof n.targetsMe === 'function' && !!n.targetsMe();
}

function isCowNpc(n) {
    const name = (n.name ?? '').toLowerCase();
    return name === 'cow' || name === 'dairy cow' || name.includes('cow');
}

function isCowHideName(name) {
    if (!name) {
        return false;
    }
    const n = name.toLowerCase().replace(/\s+/g, '');
    return n === 'cowhide';
}

function hideCount() {
    return Inventory.items()
        .filter(i => isCowHideName(i.name))
        .reduce((sum, i) => sum + Math.max(1, i.count || 1), 0);
}

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

function pickLowestStyle() {
    let best = TRAINABLE[0];
    let bestLevel = Skills.level(best);
    for (let i = 1; i < TRAINABLE.length; i++) {
        const style = TRAINABLE[i];
        const level = Skills.level(style);
        if (level < bestLevel) {
            best = style;
            bestLevel = level;
        }
    }
    return best;
}

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

function readPrefBool(key, fallback) {
    const raw = readPrefRaw(key);
    if (raw === null) {
        return fallback;
    }
    const n = raw.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes';
}

function readPrefNum(key, fallback) {
    const raw = readPrefRaw(key);
    if (raw === null) {
        return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function readPrefStr(key, fallback) {
    const raw = readPrefRaw(key);
    return raw !== null ? raw.trim() : fallback;
}

function isPanelPaused() {
    return !!document.querySelector('.rs2b0t-value.rs2b0t-state-paused');
}

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

class AlKharidCowKiller extends LoopingBot {
    recovering = false;
    deaths = 0;
    kills = 0;
    hidesLooted = 0;
    bankTrips = 0;
    status = 'starting';

    autoLowest = true;
    levelsBeforeSwap = 1;
    desiredStyle = 'attack';
    fixedStyle = 'attack';
    styleLevelAnchor = 1;

    startedAt = 0;
    xpAtStart = Object.create(null);
    /** @type {Set<string>} */
    usedSkills = new Set();
    styleFails = 0;
    styleRetryAt = 0;
    cantReach = false;
    /** Last seen hide count — tally loots across ticks. */
    lastHideSeen = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();

        this.syncPrefs({ silent: true });
        if (this.autoLowest) {
            this.desiredStyle = pickLowestStyle();
        } else {
            this.desiredStyle = this.fixedStyle;
        }
        this.styleLevelAnchor = Skills.level(this.desiredStyle);

        this.startedAt = Date.now();
        this.xpAtStart = Object.create(null);
        this.usedSkills = new Set();
        this.kills = 0;
        this.hidesLooted = 0;
        this.bankTrips = 0;
        this.lastHideSeen = hideCount();
        for (const skill of COMBAT_TRACK) {
            this.xpAtStart[skill] = Skills.xp(skill);
        }

        this.on('chat.message', e => {
            if (CANT_REACH_RE.test(e.text)) {
                this.cantReach = true;
            }
            if (DEATH_RE.test(e.text) && !this.recovering) {
                this.recovering = true;
                this.deaths++;
                this.status = 'dead';
                this.log(`died (#${this.deaths}) — waiting for respawn`);
            }
        });

        this.on('skill.xp', e => {
            if (COMBAT_TRACK.includes(e.name)) {
                this.usedSkills.add(e.name);
            }
        });

        this.on('skill.level', e => {
            if (TRAINABLE.includes(e.name)) {
                this.log(`${e.name} level ${e.previous} → ${e.level}`);
            }
        });

        this.log(
            this.autoLowest
                ? `started — cows @ ${COW_SPOT.x},${COW_SPOT.z}; bank Al Kharid; auto-lowest (swap every ${this.levelsBeforeSwap} lvl); training ${this.desiredStyle}`
                : `started — cows @ ${COW_SPOT.x},${COW_SPOT.z}; bank Al Kharid; fixed style ${this.desiredStyle}`
        );
        this.log('tip: Pause → Edit parameters to change prefs without stopping');
        this.status = 'ready';
    }

    onPause() {
        unlockPausedPrefsUi();
    }

    onResume() {
        this.syncPrefs({ silent: false });
    }

    async loop() {
        this.syncPrefs({ silent: false });
        unlockPausedPrefsUi();
        this.noteHides();

        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }
        if (await dismissWelcomeScreen()) {
            this.status = 'close welcome';
            return;
        }

        if (this.recovering) {
            await this.recover();
            return;
        }

        if (typeof ChatDialog !== 'undefined' && ChatDialog) {
            if (ChatDialog.canContinue()) {
                this.status = 'continue dialog';
                await ChatDialog.continue();
                return;
            }
            if (
                typeof ChatDialog.isOpen === 'function' &&
                ChatDialog.isOpen() &&
                typeof ChatDialog.options === 'function' &&
                ChatDialog.options().length > 0 &&
                typeof ChatDialog.chooseOption === 'function'
            ) {
                this.status = 'dialog option';
                await ChatDialog.chooseOption();
                return;
            }
        }

        if (Bank.isOpen()) {
            await Bank.close();
            return;
        }

        if (await this.ensureCombatStyle()) {
            return;
        }

        // Full pack → bank hides at Al Kharid (only pause for a cow actually on us).
        const cowOnMe = this.findCowFightingMe();
        if (Inventory.isFull() && hideCount() > 0 && !cowOnMe) {
            await this.bankAndReturn();
            return;
        }

        // Hides always win: loot before walking, fighting, or idling in combat.
        if (await this.lootHides()) {
            return;
        }

        // No hide to take — finish the current fight if a cow is on us.
        if (cowOnMe) {
            this.status = 'in combat';
            await Execution.delayTicks(2);
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (Tile.from(here).distanceTo(COW_SPOT) > LEASH) {
            this.status = 'walking to cows';
            this.log(`walking to cow pen ${COW_SPOT.x},${COW_SPOT.z}`);
            const ok = await Traversal.walkResilient(COW_SPOT, {
                radius: 4,
                log: msg => this.log(`  ${msg}`)
            });
            if (!ok) {
                this.log('path to cows failed — retrying');
            }
            return;
        }

        // One more hide check at camp before clicking Attack.
        if (await this.lootHides()) {
            return;
        }

        const cow = this.findAttackableCow();
        if (!cow) {
            this.status = 'waiting for cow';
            await Traversal.walkTo(COW_SPOT, { radius: 2, timeoutMs: 8_000 });
            await Execution.delayTicks(2);
            return;
        }

        await this.attackCow(cow);
    }

    onStop() {
        this.stopPausedPrefUnlock();
        this.log(
            `stopped — ${this.kills} kills, ${this.hidesLooted} hides, ` +
                `${this.bankTrips} bank trips, ${this.deaths} deaths (${this.status})`
        );
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const hidePh = hrs > 0.008 ? this.hidesLooted / hrs : 0;

        const lines = [
            `Al Kharid Cow Killer`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `kills ${this.kills}  hides ${this.hidesLooted} (${fmtXph(hidePh)}/hr)  inv ${hideCount()}`,
            `bank trips ${this.bankTrips}  deaths ${this.deaths}`
        ];

        if (this.autoLowest) {
            const gained = Skills.level(this.desiredStyle) - this.styleLevelAnchor;
            lines.push(
                `auto-lowest · ${gained}/${this.levelsBeforeSwap} lv on ${this.desiredStyle}`
            );
        }

        lines.push(`training ${this.desiredStyle.toUpperCase()}`);

        for (const skill of COMBAT_TRACK) {
            if (!this.usedSkills.has(skill)) {
                continue;
            }
            const gained = Math.max(0, Skills.xp(skill) - (this.xpAtStart[skill] ?? 0));
            const xph = hrs > 0.0005 ? gained / hrs : 0;
            lines.push(`${skill}: ${fmtXph(xph)} xp/hr  (+${Math.round(gained)} xp)`);
        }

        ctx.font = '12px monospace';
        let maxW = 0;
        for (const line of lines) {
            maxW = Math.max(maxW, ctx.measureText(line).width);
        }
        const pad = 6;
        const lineH = 16;
        const boxH = pad * 2 + lines.length * lineH;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, 6, maxW + pad * 2, boxH);
        ctx.fillStyle = '#c9a66b';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }

    noteHides() {
        const now = hideCount();
        if (now > this.lastHideSeen) {
            this.hidesLooted += now - this.lastHideSeen;
        }
        this.lastHideSeen = now;
    }

    syncPrefs(opts = {}) {
        const silent = opts.silent === true;
        const prevAuto = this.autoLowest;
        const prevLevels = this.levelsBeforeSwap;
        const prevFixed = this.fixedStyle;

        this.autoLowest = readPrefBool('autoLowest', this.settings.bool('autoLowest', true));
        this.levelsBeforeSwap = Math.max(
            1,
            Math.floor(readPrefNum('levelsBeforeSwap', this.settings.num('levelsBeforeSwap', 1)))
        );
        let fixed = readPrefStr('meleeStyle', this.settings.str('meleeStyle', 'attack')).toLowerCase();
        if (!TRAINABLE.includes(fixed)) {
            fixed = 'attack';
        }
        this.fixedStyle = fixed;

        if (this.autoLowest !== prevAuto) {
            if (this.autoLowest) {
                this.desiredStyle = pickLowestStyle();
                this.styleLevelAnchor = Skills.level(this.desiredStyle);
                if (!silent) {
                    this.log(`prefs: auto-lowest ON → training ${this.desiredStyle}`);
                }
            } else {
                this.desiredStyle = this.fixedStyle;
                this.styleLevelAnchor = Skills.level(this.desiredStyle);
                if (!silent) {
                    this.log(`prefs: auto-lowest OFF → fixed ${this.desiredStyle}`);
                }
            }
            return;
        }

        if (!this.autoLowest && this.fixedStyle !== prevFixed) {
            this.desiredStyle = this.fixedStyle;
            this.styleLevelAnchor = Skills.level(this.desiredStyle);
            if (!silent) {
                this.log(`prefs: melee style → ${this.desiredStyle}`);
            }
            return;
        }

        if (this.levelsBeforeSwap !== prevLevels && !silent) {
            this.log(`prefs: levels before swap → ${this.levelsBeforeSwap}`);
        }
    }

    async ensureCombatStyle() {
        if (this.autoLowest) {
            const cur = Skills.level(this.desiredStyle);
            if (cur >= this.styleLevelAnchor + this.levelsBeforeSwap) {
                const next = pickLowestStyle();
                if (next !== this.desiredStyle) {
                    this.log(
                        `swap style ${this.desiredStyle} → ${next} ` +
                            `(gained ${cur - this.styleLevelAnchor} lv; atk=${Skills.level('attack')} ` +
                            `str=${Skills.level('strength')} def=${Skills.level('defence')})`
                    );
                    this.desiredStyle = next;
                } else {
                    this.log(
                        `${this.desiredStyle} still lowest after ${this.levelsBeforeSwap} lv — continuing`
                    );
                }
                this.styleLevelAnchor = Skills.level(this.desiredStyle);
            }
        }

        if (Game.hasCombatStyle(this.desiredStyle) || Date.now() < this.styleRetryAt) {
            return false;
        }

        this.status = `setting style: ${this.desiredStyle}`;
        Game.setCombatStyle(this.desiredStyle);
        if (await Execution.delayUntil(() => Game.hasCombatStyle(this.desiredStyle), 3000)) {
            this.styleFails = 0;
            this.log(`combat style set to ${this.desiredStyle}`);
            return true;
        }

        if (++this.styleFails >= 5) {
            this.styleFails = 0;
            this.styleRetryAt = Date.now() + 60_000;
            this.log('could not set attack style — retrying in 60s');
        }
        return true;
    }

    async attackCow(cow) {
        const index = cow.index;
        const targetTile = cow.tile();
        const name = cow.name ?? 'Cow';

        this.status = `attacking (${cow.distance()}t)`;
        this.log(`attacking ${name} @ ${targetTile.x},${targetTile.z}`);
        this.cantReach = false;
        await cow.interact('Attack');
        await Execution.delayUntil(
            () => Game.inCombat() || this.cantReach || this.findCowFightingMe() !== null,
            4000
        );

        if (Game.inCombat() || this.findCowFightingMe()) {
            this.kills++;
            return;
        }

        if (!this.cantReach) {
            return;
        }

        this.log("can't reach that — opening gate/door then retrying");
        this.status = 'opening gate';
        const opened = await this.openDoorToward(targetTile);
        if (!opened) {
            this.log('no shut gate/door found toward that cow');
            return;
        }

        const again =
            Npcs.query()
                .where(n => n.index === index)
                .nearest() ?? this.findAttackableCow();

        if (!again) {
            this.log('cow gone after opening gate');
            return;
        }

        this.status = `retry attack (${again.distance()}t)`;
        this.log(`retrying ${again.name ?? 'Cow'} @ ${again.tile().x},${again.tile().z}`);
        this.cantReach = false;
        await again.interact('Attack');
        if (
            await Execution.delayUntil(
                () => Game.inCombat() || this.cantReach || this.findCowFightingMe() !== null,
                4000
            )
        ) {
            if (Game.inCombat() || this.findCowFightingMe()) {
                this.kills++;
            }
        }
    }

    findCowFightingMe() {
        return Npcs.query()
            .within(LEASH + 6)
            .where(n => isCowNpc(n))
            .where(n => inCowCamp(n.tile(), LEASH + 2))
            .where(n => npcTargetsMe(n))
            .nearest();
    }

    findAttackableCow() {
        const onMe = this.findCowFightingMe();
        if (onMe) {
            return onMe;
        }
        return Npcs.query()
            .action('Attack')
            .within(LEASH + 4)
            .where(n => isCowNpc(n))
            .where(n => inCowCamp(n.tile()))
            .where(n => !n.inCombat)
            .nearest();
    }

    /**
     * Take nearby Cow hide piles inside the camp.
     * @returns {Promise<boolean>} true if this loop looted
     */
    async lootHides() {
        if (Inventory.isFull()) {
            return false;
        }

        const ground =
            GroundItems.query()
                .name(HIDE_NAME)
                .within(LOOT_LEASH + 2)
                .where(g => inCowCamp(g.tile(), LOOT_LEASH))
                .nearest() ??
            GroundItems.query()
                .where(g => isCowHideName(g.name))
                .within(LOOT_LEASH + 2)
                .where(g => inCowCamp(g.tile(), LOOT_LEASH))
                .nearest();

        if (!ground) {
            return false;
        }

        const before = hideCount();
        this.status = 'looting hide';
        this.log(`taking ${ground.name ?? HIDE_NAME}`);
        await ground.interact('Take');
        await Execution.delayUntil(() => hideCount() > before || Inventory.isFull(), 5000);
        this.noteHides();
        return true;
    }

    findShutDoorToward(toward) {
        const here = Game.tile();
        if (!here) {
            return null;
        }
        return (
            Locs.query()
                .where(l => isShutDoor(l))
                .within(8)
                .where(l => towardDest(l.tile(), here, toward))
                .nearest() ??
            Locs.query().where(l => isShutDoor(l)).within(6).nearest()
        );
    }

    async openDoorToward(toward, knownDoor = null) {
        const here = Game.tile();
        if (!here) {
            return false;
        }

        const door = knownDoor ?? this.findShutDoorToward(toward);
        if (!door) {
            return false;
        }

        const t = door.tile();
        if (cheb(here, t) > 1) {
            this.log(`walking to ${door.name} at ${t.x},${t.z}`);
            await Traversal.walkTo(t, { radius: 1, timeoutMs: 15_000 });
        }

        const shut = Locs.query()
            .where(l => l.tile().x === t.x && l.tile().z === t.z && isShutDoor(l))
            .nearest();
        if (!shut) {
            return true;
        }

        const op = openDoorOp(shut);
        if (!op) {
            return false;
        }

        this.log(`opening ${shut.name} at ${t.x},${t.z}`);
        if (!(await shut.interact(op))) {
            return false;
        }

        return Execution.delayUntil(() => {
            const still = Locs.query()
                .where(l => l.tile().x === t.x && l.tile().z === t.z && isShutDoor(l))
                .nearest();
            return still === null;
        }, 5000);
    }

    async bankAndReturn() {
        const held = hideCount();
        this.status = 'banking';
        this.log(`banking ${held} Cow hide at Al Kharid`);

        // Avoid crediting re-withdraw / leftover stacks after deposit.
        this.lastHideSeen = 0;

        await Banking.bankNearest({
            destination: { name: 'Al Kharid', tile: BANK_STAND },
            deposit: name => isCowHideName(name),
            returnTo: COW_SPOT,
            log: m => this.log(`  ${m}`)
        });

        this.bankTrips++;
        this.lastHideSeen = hideCount();
        this.status = 'returning to cows';
    }

    async recover() {
        const ready = await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 20_000);
        if (!ready) {
            this.log('still waiting for respawn…');
            return;
        }
        await Execution.delayTicks(3);

        this.status = 'returning';
        this.log('running back to cows');
        const ok = await Traversal.walkResilient(COW_SPOT, {
            radius: 4,
            log: msg => this.log(`  ${msg}`)
        });
        if (ok) {
            this.recovering = false;
            this.status = 'fighting';
            this.log('back at cows');
        } else {
            this.log('could not reach cows after death — will retry');
        }
    }

    startPausedPrefUnlock() {
        this.stopPausedPrefUnlock();
        this.unlockTimer = setInterval(unlockPausedPrefsUi, 250);
        unlockPausedPrefsUi();
    }

    stopPausedPrefUnlock() {
        if (this.unlockTimer !== null) {
            clearInterval(this.unlockTimer);
            this.unlockTimer = null;
        }
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.1',
    category: 'Combat',
    tags: ['cow', 'cowhide', 'lumbridge', 'al-kharid', 'melee', 'bank', 'xp'],
    description:
        'Kills cows in the Lumbridge cow pen, loots Cow hide, and banks full inventories at Al Kharid.',
    settingsSchema: {
        autoLowest: {
            type: 'boolean',
            default: true,
            label: 'Auto train lowest combat stat',
            group: 'Combat',
            help: 'Pick Attack / Strength / Defence with the lowest level, then re-pick after N levels'
        },
        levelsBeforeSwap: {
            type: 'number',
            default: 1,
            min: 1,
            max: 20,
            label: 'Levels before swap',
            group: 'Combat',
            showIf: { key: 'autoLowest', anyOf: ['true'] },
            help: 'Gain this many levels on the current style before switching to the new lowest'
        },
        meleeStyle: {
            type: 'string',
            default: 'attack',
            options: ['attack', 'strength', 'defence'],
            label: 'Melee style',
            group: 'Combat',
            showIf: { key: 'autoLowest', anyOf: ['false'] },
            help: 'Fixed combat style when auto-lowest is off'
        }
    },
    create: () => new AlKharidCowKiller()
});
