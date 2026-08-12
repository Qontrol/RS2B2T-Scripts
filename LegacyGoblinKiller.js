/**
 * Legacy Goblin Killer. Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM: pulls the live ABI from globalThis.__rs2b0t (same as @rs2b0t/api).
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('LegacyGoblinKiller: globalThis.__rs2b0t missing — load this inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `LegacyGoblinKiller: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    Equipment,
    Inventory,
    Bank,
    Banking,
    Traversal,
    Tile,
    Skills,
    ChatDialog,
    depositAllExcept
} = abi;

const SCRIPT_NAME = 'Legacy Goblin Killer';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/** Draynor bank stand — forced first walk for fresh combat-3 / total-28 accounts. */
const DRAYNOR_BANK = new Tile(3092, 3244, 0);
/** Fresh tutorial-complete account: combat 3, all skills 1 except HP 10 → total 28. */
const FRESH_COMBAT_LEVEL = 3;
const FRESH_TOTAL_LEVEL = 28;

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

/** Outdoor goblin camp — south of the house door (3246,3244). */
const GOBLIN_SPOT = new Tile(3246, 3242, 0);
const LEASH = 12;
/** Only loot bones this far from camp (never chase cow-field bones). */
const BONE_LEASH = 8;
/** Goblin house door — keep this Open whenever we're at camp. */
const HOUSE_DOOR = new Tile(3246, 3244, 0);
const GEAR = ['Bronze sword', 'Wooden shield'];
const DEATH_RE = /oh dear.*you are dead/i;
const CANT_REACH_RE = /i can't reach that/i;
const TOWARD_SLACK = 4;

/** Side-panel tab indices (rs2b0t Game.openSideTab). */
const STATS_TAB = 1;

/** Melee styles that train a single combat skill (1:1 with the skill name). */
const TRAINABLE = ['attack', 'strength', 'defence'];
/** Skills we may show XP/hr for once they gain XP this session. */
const COMBAT_TRACK = ['attack', 'strength', 'defence', 'hitpoints', 'prayer'];

function cheb(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function inGoblinCamp(tile, radius = LEASH) {
    if (!tile) {
        return false;
    }
    return Tile.from(tile).distanceTo(GOBLIN_SPOT) <= radius;
}

/** Prefer doors that lie toward the target (not behind us). */
function towardDest(door, here, dest) {
    return cheb(door, dest) <= cheb(here, dest) + TOWARD_SLACK;
}

function isShutDoor(loc) {
    const name = (loc.name ?? '').toLowerCase();
    if (!name.includes('door')) {
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

function npcTargetsAnother(n) {
    return typeof n.targetsAnotherPlayer === 'function' && !!n.targetsAnotherPlayer();
}

function hasAttackOp(n) {
    return n.actions().some(a => /attack/i.test(a ?? ''));
}

function isSpiderNpc(n) {
    return (n.name ?? '').toLowerCase().includes('spider');
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

/** Skills present on this era's client (HP 10 + rest 1 ⇒ total 28). */
const TOTAL_SKILL_NAMES = [
    'attack',
    'defence',
    'strength',
    'hitpoints',
    'ranged',
    'prayer',
    'magic',
    'cooking',
    'woodcutting',
    'fletching',
    'fishing',
    'firemaking',
    'crafting',
    'smithing',
    'mining',
    'herblore',
    'agility',
    'thieving',
    'slayer',
    'runecraft'
];

function clientReader() {
    return abi.reader ?? welcomeHost()?.reader ?? null;
}

/** Classic combat-level estimate from base skills (fallback if reader has no combatLevel). */
function combatLevelFromSkills() {
    const atk = Skills.level('attack');
    const str = Skills.level('strength');
    const def = Skills.level('defence');
    const hp = Skills.level('hitpoints');
    const pray = Skills.level('prayer');
    const ranged = Skills.level('ranged');
    const magic = Skills.level('magic');
    if (hp <= 0) {
        return 0;
    }
    const base = 0.25 * (def + hp + Math.floor(pray / 2));
    const melee = 0.325 * (atk + str);
    const range = 0.325 * Math.floor(ranged * 1.5);
    const mage = 0.325 * Math.floor(magic * 1.5);
    return Math.floor(base + Math.max(melee, range, mage));
}

/** Local player's combat level from the client reader (or skill formula). */
function combatLevel() {
    const reader = clientReader();
    if (reader && typeof reader.combatLevel === 'function') {
        const c = reader.combatLevel() || 0;
        if (c > 0) {
            return c;
        }
    }
    return combatLevelFromSkills();
}

/** Sum of the standard skill set (HP 10 + rest 1 ⇒ 28). Do not sum reader.skillCount —
 * extra skills push the total above 28 and wrongly skip the Draynor path. */
function totalLevel() {
    return TOTAL_SKILL_NAMES.reduce((sum, name) => sum + (Skills.level(name) || 0), 0);
}

/** Chebyshev distance to the Draynor bank stand. */
function distToDraynor(here) {
    if (!here) {
        return Infinity;
    }
    return Math.max(Math.abs(here.x - DRAYNOR_BANK.x), Math.abs(here.z - DRAYNOR_BANK.z));
}

/** Deposit predicate: bank everything except Bronze sword / Wooden shield. */
function depositExceptGear() {
    if (typeof depositAllExcept === 'function') {
        return depositAllExcept(GEAR);
    }
    const keep = new Set(GEAR.map(g => g.toLowerCase()));
    return name => {
        const n = (name ?? '').toLowerCase();
        return n.length > 0 && !keep.has(n);
    };
}

function isGearName(name) {
    const n = (name ?? '').toLowerCase();
    return GEAR.some(g => g.toLowerCase() === n);
}

/**
 * Host disables Edit parameters while running *or* paused. Re-enable while
 * paused so Combat prefs can be changed without stopping the script.
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

class LegacyGoblinKiller extends LoopingBot {
    recovering = false;
    deaths = 0;
    attacks = 0;
    status = 'starting';
    /** False until we have banked everything and withdrawn/equipped GEAR once. */
    gearReady = false;
    /**
     * Latched once stats are readable: true = combat 3 / total 28 → Draynor first.
     * @type {boolean | null}
     */
    freshStarter = null;

    autoLowest = true;
    levelsBeforeSwap = 1;
    buryBones = true;
    desiredStyle = 'attack';
    fixedStyle = 'attack';
    /** Base level of desiredStyle when we committed to this training segment. */
    styleLevelAnchor = 1;

    startedAt = 0;
    xpAtStart = Object.create(null);
    /** @type {Set<string>} */
    usedSkills = new Set();
    styleFails = 0;
    styleRetryAt = 0;
    cantReach = false;
    buried = 0;
    /** When the current attacker started hitting us with no retaliate click. */
    underAttackSince = 0;
    /** @type {number} */
    lastAttackerIndex = -1;
    /** NPC index we last clicked Attack on (counts as fighting back). */
    retaliatingIndex = -1;
    retaliateClickedAt = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    grindTargets() {
        return ['goblin'];
    }

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
        this.buried = 0;
        this.gearReady = false;
        this.freshStarter = null;
        this.underAttackSince = 0;
        this.lastAttackerIndex = -1;
        this.retaliatingIndex = -1;
        this.retaliateClickedAt = 0;
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
                ? `started — auto-lowest on (swap every ${this.levelsBeforeSwap} lvl); training ${this.desiredStyle}`
                : `started — fixed style ${this.desiredStyle}`
        );
        this.log(`bury bones: ${this.buryBones ? 'on' : 'off'}`);

        await Execution.delayUntil(() => Skills.level('hitpoints') > 0, 5000);
        this.latchFreshStarter();
        this.log(
            `startup: one trip to Draynor ${DRAYNOR_BANK.x},${DRAYNOR_BANK.z},0 → gear up → goblins until death`
        );
        this.log('tip: Pause → Edit parameters to change prefs without stopping');
        this.status = 'walk to Draynor';
    }

    /** Detect combat 3 + total 28 once (also combat-3 base melee if total math differs). */
    latchFreshStarter() {
        if (this.freshStarter !== null) {
            return this.freshStarter;
        }
        if (Skills.level('hitpoints') <= 0) {
            return null;
        }
        const combat = combatLevel();
        const total = totalLevel();
        const baseMelee =
            Skills.level('hitpoints') === 10 &&
            Skills.level('attack') === 1 &&
            Skills.level('strength') === 1 &&
            Skills.level('defence') === 1;
        this.freshStarter =
            combat === FRESH_COMBAT_LEVEL &&
            (total === FRESH_TOTAL_LEVEL || baseMelee);
        if (this.freshStarter) {
            this.log(
                `fresh starter (combat ${combat}, total ${total}) — ` +
                    `first action: walk to ${DRAYNOR_BANK.x},${DRAYNOR_BANK.z},0 then bank junk except sword+shield`
            );
            this.status = 'walk to Draynor';
        } else {
            this.log(
                `stats combat ${combat}, total ${total} — first walk ${DRAYNOR_BANK.x},${DRAYNOR_BANK.z},0 then bank all / withdraw GEAR`
            );
            this.status = 'walk to Draynor';
        }
        return this.freshStarter;
    }

    onPause() {
        unlockPausedPrefsUi();
    }

    onResume() {
        this.syncPrefs({ silent: false });
    }

    async loop() {
        this.syncPrefs({ silent: false });

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

        // Clear leftover random-event / dwarf dialog before combat clicks.
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

        // Drop Beer / Kebab / Casket — never eat or drink them.
        if (await this.handleDropJunk()) {
            return;
        }

        if (await this.prepCombatGear()) {
            return;
        }

        if (await this.ensureCombatStyle()) {
            return;
        }

        // Keep Stats open by default (combat-style clicks leave the combat tab).
        if (await this.ensureStatsTab()) {
            return;
        }

        if (await this.handleBones()) {
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        // Being hit without fighting back for 5s → click Attack on that NPC.
        if (await this.ensureRetaliate()) {
            return;
        }

        if (Tile.from(here).distanceTo(GOBLIN_SPOT) > LEASH) {
            this.status = 'walking to goblins';
            this.log('walking to goblins');
            const ok = await Traversal.walkResilient(GOBLIN_SPOT, {
                radius: 4,
                log: msg => this.log(`  ${msg}`)
            });
            if (!ok) {
                this.log('path to goblins failed — retrying');
            }
            return;
        }

        // Keep the house door open whenever we're at camp (even mid-fight).
        if (await this.ensureHouseDoorOpen()) {
            return;
        }

        // Only idle in combat when a goblin is actually on us. After random events
        // (Drunken Dwarf, etc.) the combat flag can linger / drop without a target —
        // fall through and Attack again.
        if (Game.inCombat()) {
            const onMe = this.findGoblinFightingMe();
            if (onMe) {
                this.status = 'in combat';
                await Execution.delayTicks(2);
                return;
            }
            this.status = 're-engaging';
            this.log('combat interrupted (e.g. random event) — re-engaging a goblin');
        }

        const goblin = this.findAttackableGoblin();
        if (!goblin) {
            this.status = 'waiting for goblin';
            await Traversal.walkTo(GOBLIN_SPOT, { radius: 2, timeoutMs: 8_000 });
            await Execution.delayTicks(2);
            return;
        }

        await this.attackGoblin(goblin);
    }

    onStop() {
        this.stopPausedPrefUnlock();
        this.log(
            `stopped — ${this.attacks} attacks, ${this.deaths} deaths` +
                (this.buryBones ? `, ${this.buried} buried` : '') +
                ` (${this.status})`
        );
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const lines = [
            `Legacy Goblin Killer v1.10`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `deaths ${this.deaths}`
        ];

        if (this.buryBones) {
            lines.push(`bury bones · buried ${this.buried}`);
        }

        if (this.autoLowest) {
            const gained = Skills.level(this.desiredStyle) - this.styleLevelAnchor;
            lines.push(
                `auto-lowest · ${gained}/${this.levelsBeforeSwap} lv on ${this.desiredStyle}`
            );
        }

        lines.push(`Currently training ${this.desiredStyle.toUpperCase()}`);

        const hrs = elapsed / 3_600_000;
        for (const skill of COMBAT_TRACK) {
            if (!this.usedSkills.has(skill)) {
                continue;
            }
            const gained = Math.max(0, Skills.xp(skill) - (this.xpAtStart[skill] ?? 0));
            const xph = hrs > 0.0005 ? gained / hrs : 0;
            lines.push(`${skill}: ${fmtXph(xph)} xp/hr  (+${Math.round(gained)} xp)`);
        }

        lines.push('CAUTION: ONLY DETECTS BRONZE SWORD AND WOODEN SHIELD.');

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
        lines.forEach((line, i) => {
            const isCaution = i === lines.length - 1;
            ctx.fillStyle = isCaution ? '#e8b84a' : '#9dce6a';
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }

    /**
     * Live-read Combat prefs from SettingsStore storage (panel saves there).
     * Host snapshots this.settings only at Start — we re-read so Pause edits apply.
     */
    syncPrefs(opts = {}) {
        const silent = opts.silent === true;
        const prevAuto = this.autoLowest;
        const prevLevels = this.levelsBeforeSwap;
        const prevFixed = this.fixedStyle;
        const prevBury = this.buryBones;

        this.autoLowest = readPrefBool('autoLowest', this.settings.bool('autoLowest', true));
        this.buryBones = readPrefBool('buryBones', this.settings.bool('buryBones', true));
        this.levelsBeforeSwap = Math.max(
            1,
            Math.floor(readPrefNum('levelsBeforeSwap', this.settings.num('levelsBeforeSwap', 1)))
        );
        let fixed = readPrefStr('meleeStyle', this.settings.str('meleeStyle', 'attack')).toLowerCase();
        if (!TRAINABLE.includes(fixed)) {
            fixed = 'attack';
        }
        this.fixedStyle = fixed;

        if (!silent && this.buryBones !== prevBury) {
            this.log(`prefs: bury bones → ${this.buryBones ? 'on' : 'off'}`);
        }

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

    /**
     * Attack a goblin. On "I can't reach that!" open the blocking door and retry.
     */
    async attackGoblin(goblin) {
        const index = goblin.index;
        const targetTile = goblin.tile();

        this.status = `attacking (${goblin.distance()}t)`;
        this.log(`attacking Goblin @ ${targetTile.x},${targetTile.z}`);
        this.cantReach = false;
        await goblin.interact('Attack');
        this.noteRetaliateClick(goblin.index);
        await Execution.delayUntil(
            () => Game.inCombat() || this.cantReach || this.findGoblinFightingMe() !== null,
            4000
        );

        if (Game.inCombat() || this.findGoblinFightingMe()) {
            this.attacks++;
            return;
        }

        if (!this.cantReach) {
            return;
        }

        this.log("can't reach that — opening door then retrying");
        this.status = 'opening door';
        const opened = await this.openDoorToward(targetTile);
        if (!opened) {
            this.log('no shut door found toward that goblin');
            return;
        }

        const again =
            Npcs.query()
                .where(n => n.index === index)
                .nearest() ?? this.findAttackableGoblin();

        if (!again) {
            this.log('goblin gone after opening door');
            return;
        }

        this.status = `retry attack (${again.distance()}t)`;
        this.log(`retrying Goblin @ ${again.tile().x},${again.tile().z}`);
        this.cantReach = false;
        await again.interact('Attack');
        this.noteRetaliateClick(again.index);
        if (
            await Execution.delayUntil(
                () => Game.inCombat() || this.cantReach || this.findGoblinFightingMe() !== null,
                4000
            )
        ) {
            if (Game.inCombat() || this.findGoblinFightingMe()) {
                this.attacks++;
            }
        }
    }

    noteRetaliateClick(index) {
        this.retaliatingIndex = index;
        this.retaliateClickedAt = Date.now();
        this.underAttackSince = 0;
        this.lastAttackerIndex = index;
    }

    /**
     * Goblin / spider / any Attackable NPC on us.
     * Uses targetsMe, plus sticky in-combat (faceEntity flickers between hits) —
     * spiders near the house often need the sticky check.
     */
    findNpcAttackingMe() {
        const range = LEASH + 12;
        const targeting = Npcs.query()
            .within(range)
            .where(n => hasAttackOp(n))
            .where(n => npcTargetsMe(n))
            .nearest();
        if (targeting) {
            return targeting;
        }

        // faceEntity often clears between hits — keep spiders/goblins that are
        // mid-fight in our face and not clearly on someone else.
        const sticky = Npcs.query()
            .within(4)
            .where(n => hasAttackOp(n))
            .where(n => n.inCombat && !npcTargetsAnother(n))
            .nearest();
        if (sticky) {
            return sticky;
        }

        // Explicit spider scan a bit further (multi-combat packs).
        return (
            Npcs.query()
                .within(range)
                .where(n => isSpiderNpc(n))
                .where(n => hasAttackOp(n))
                .where(n => npcTargetsMe(n) || (n.inCombat && !npcTargetsAnother(n) && n.distance() <= 3))
                .nearest() ?? null
        );
    }

    /**
     * If an NPC (goblin, spider, etc.) has been attacking us for 5s without us
     * clicking Attack back, click Attack on them.
     * @returns {Promise<boolean>} true if this loop spent time retaliating
     */
    async ensureRetaliate() {
        const attacker = this.findNpcAttackingMe();
        if (!attacker) {
            this.underAttackSince = 0;
            this.lastAttackerIndex = -1;
            return false;
        }

        // We already clicked Attack on this NPC recently — treat as fighting back.
        if (
            attacker.index === this.retaliatingIndex &&
            Date.now() - this.retaliateClickedAt < 12_000
        ) {
            this.underAttackSince = 0;
            this.lastAttackerIndex = attacker.index;
            return false;
        }

        if (attacker.index !== this.lastAttackerIndex || this.underAttackSince === 0) {
            this.lastAttackerIndex = attacker.index;
            this.underAttackSince = Date.now();
            return false;
        }

        const waited = Date.now() - this.underAttackSince;
        if (waited < 5000) {
            return false;
        }

        const name = attacker.name ?? 'NPC';
        this.status = `retaliating (${name})`;
        this.log(
            `${name} attacking for ${Math.round(waited / 1000)}s without retaliate — clicking Attack`
        );
        this.cantReach = false;
        await attacker.interact('Attack');
        this.noteRetaliateClick(attacker.index);
        await Execution.delayUntil(
            () => Game.animating() || Game.inCombat() || this.cantReach,
            3000
        );
        this.attacks++;
        return true;
    }

    /** Goblin currently targeting the player (real fight, not a stale combat flag). */
    findGoblinFightingMe() {
        return Npcs.query()
            .name('Goblin')
            .within(LEASH + 6)
            .where(n => inGoblinCamp(n.tile(), LEASH + 2))
            .where(n => npcTargetsMe(n))
            .nearest();
    }

    /**
     * Prefer the goblin already on us (re-engage after random events), else an idle one.
     * Never start a fight on a goblin already in combat with someone else.
     * Stay inside the goblin camp — do not chase into the cow field.
     */
    findAttackableGoblin() {
        const onMe = this.findGoblinFightingMe();
        if (onMe) {
            return onMe;
        }
        return Npcs.query()
            .name('Goblin')
            .action('Attack')
            .within(LEASH + 4)
            .where(n => inGoblinCamp(n.tile()))
            .where(n => !n.inCombat)
            .nearest();
    }

    /** Shut Door loc at the goblin house entrance, if any. */
    findShutHouseDoor() {
        return (
            Locs.query()
                .where(l => isShutDoor(l))
                .within(10)
                .where(l => {
                    const t = l.tile();
                    return (
                        Math.abs(t.x - HOUSE_DOOR.x) <= 1 &&
                        Math.abs(t.z - HOUSE_DOOR.z) <= 1 &&
                        (t.level ?? 0) === (HOUSE_DOOR.level ?? 0)
                    );
                })
                .nearest() ?? null
        );
    }

    /**
     * If the house door is shut while we're at camp, open it.
     * @returns {Promise<boolean>} true if this loop spent time on the door
     */
    async ensureHouseDoorOpen() {
        const shut = this.findShutHouseDoor();
        if (!shut) {
            return false;
        }
        this.status = 'opening house door';
        this.log('house door shut — opening');
        await this.openDoorToward(HOUSE_DOOR, shut);
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

    /** Open the nearest shut door toward `toward`. */
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

    /**
     * Drop Beer, Kebab, and any Casket from the pack (never Drink/Eat).
     * @returns {Promise<boolean>} true if this loop dropped something
     */
    async handleDropJunk() {
        const item =
            Inventory.items().find(i => {
                const n = (i.name ?? '').toLowerCase();
                if (!n) {
                    return false;
                }
                if (n === 'kebab' || n === 'casket' || n.includes('casket')) {
                    return true;
                }
                // Plain Beer / dwarf beer — not kegs or other drinks.
                return n === 'beer' || (n.includes('beer') && !n.includes('keg'));
            }) ?? null;

        if (!item) {
            return false;
        }

        const name = item.name ?? 'junk';
        this.status = `drop ${name}`;
        this.log(`dropping ${name}`);
        const before = Inventory.used();
        await item.interact('Drop');
        await Execution.delayUntil(() => Inventory.used() < before, 4000);
        return true;
    }

    /**
     * Keep the Stats side tab open whenever nothing else needs another tab.
     * @returns {Promise<boolean>} true if this loop spent time opening Stats
     */
    async ensureStatsTab() {
        if (typeof Game.openSideTab !== 'function') {
            return false;
        }
        const reader = clientReader();
        if (reader && typeof reader.activeSideTab === 'function') {
            if (reader.activeSideTab() === STATS_TAB) {
                return false;
            }
        }
        this.status = 'open stats';
        const ok = await Game.openSideTab(STATS_TAB);
        if (ok) {
            this.log('stats tab open');
        }
        return true;
    }

    /**
     * Bury inventory bones / loot nearby bones when the option is on.
     * Ground bones must sit inside the goblin camp — never chase cow-field piles.
     * @returns {Promise<boolean>} true if this loop handled bones
     */
    async handleBones() {
        if (!this.buryBones || Game.inCombat()) {
            return false;
        }

        const bones = Inventory.first('Bones');
        if (bones) {
            this.status = 'burying bones';
            const before = Inventory.used();
            await bones.interact('Bury');
            if (await Execution.delayUntil(() => Inventory.used() < before, 3000)) {
                this.buried++;
                this.log(`buried bones (#${this.buried})`);
            }
            return true;
        }

        if (Inventory.isFull()) {
            return false;
        }

        // Only loot bones that are inside the goblin camp radius.
        const ground = GroundItems.query()
            .name('Bones')
            .within(BONE_LEASH + 2)
            .where(g => inGoblinCamp(g.tile(), BONE_LEASH))
            .nearest();
        if (!ground) {
            return false;
        }

        this.status = 'looting bones';
        const before = Inventory.used();
        await ground.interact('Take');
        await Execution.delayUntil(() => Inventory.used() > before, 5000);
        return true;
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

    /**
     * Re-evaluate lowest-stat target after N levels, then assert the combat tab.
     * @returns {Promise<boolean>} true if this loop spent time on the style click
     */
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
            this.log('could not set attack style (combat tab not ready?) — retrying in 60s');
        }
        return true;
    }

    async recover() {
        const ready = await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 20_000);
        if (!ready) {
            this.log('still waiting for respawn…');
            return;
        }
        await Execution.delayTicks(3);

        const haveGear = GEAR.every(g => Equipment.contains(g) || Inventory.first(g));
        if (!haveGear) {
            // Only bank again after death if sword/shield are actually gone.
            this.gearReady = false;
            this.log('gear missing after death — one Draynor bank trip, then back to goblins');
            this.recovering = false;
            this.status = 'walk to Draynor';
            return;
        }

        this.status = 're-equipping';
        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!(await Equipment.equip(item))) {
                this.log(`WARNING: could not equip ${item} — is it in the pack?`);
            } else {
                this.log(`equipped ${item}`);
            }
        }

        this.status = 'returning';
        this.log('running back to goblins');
        const ok = await Traversal.walkResilient(GOBLIN_SPOT, {
            radius: 4,
            log: msg => this.log(`  ${msg}`)
        });
        if (ok) {
            this.recovering = false;
            this.status = 'fighting';
            this.log('back at goblins');
        } else {
            this.log('could not reach goblins after death — will retry');
        }
    }

    hasGearEquipped() {
        return GEAR.every(g => Equipment.contains(g));
    }

    hasGearAvailable() {
        return GEAR.every(g => Equipment.contains(g) || Inventory.first(g));
    }

    /** Inventory stacks that are only Bronze sword, Wooden shield, Bones, and/or Coins. */
    invOnlyGearOrBones() {
        return Inventory.items().every(i => {
            const n = (i.name ?? '').toLowerCase();
            if (!n) {
                return false;
            }
            if (n === 'bones' || n === 'coins') {
                return true;
            }
            return GEAR.some(g => g.toLowerCase() === n);
        });
    }

    /** Worn slots are empty or only Bronze sword / Wooden shield. */
    wornOnlyGear() {
        const allowed = new Set(GEAR.map(n => n.toLowerCase()));
        return Equipment.items()
            .filter(i => i.name)
            .every(i => allowed.has((i.name ?? '').toLowerCase()));
    }

    /**
     * Pack is only sword/shield/bones/coins (or empty), worn is only sword/shield,
     * and both gear pieces are equipped or in the pack — skip the bank trip.
     */
    canSkipBankPrep() {
        return this.invOnlyGearOrBones() && this.wornOnlyGear() && this.hasGearAvailable();
    }

    /**
     * Walk to 3092,3244,0 — first gear action. Never uses Banking.open nearest-bank.
     * @returns {Promise<boolean>} true if still traveling (caller should return)
     */
    async walkToDraynorFirst() {
        if (distToDraynor(Game.tile()) <= 6) {
            return false;
        }
        if (Bank.isOpen()) {
            await Bank.close();
            await Execution.delayTicks(1);
        }
        this.status = 'walk to Draynor';
        this.log(`walking to Draynor @ ${DRAYNOR_BANK.x},${DRAYNOR_BANK.z},0 (one trip)`);
        await Traversal.walkResilient(DRAYNOR_BANK, {
            radius: 2,
            timeoutMs: 180_000,
            log: m => this.log(`  ${m}`)
        });
        // Still en route only if we failed to arrive — don't thrash at the booth.
        return distToDraynor(Game.tile()) > 6;
    }

    /**
     * Open the booth at the Draynor stand. Caller must already be on/near the pin.
     * Never calls Banking.open() (that web-walks to Al Kharid when no booth is in scene).
     * @returns {Promise<boolean>}
     */
    async openDraynorBoothHere() {
        if (Bank.isOpen()) {
            if (distToDraynor(Game.tile()) <= 12) {
                return true;
            }
            this.log('wrong bank open — closing');
            await Bank.close();
            await Execution.delayTicks(1);
        }

        if (distToDraynor(Game.tile()) > 6) {
            return false;
        }

        this.status = 'gear: draynor';
        this.log('opening Draynor bank booth');
        if (typeof Bank.openBooth === 'function') {
            return !!(await Bank.openBooth(DRAYNOR_BANK, 'Bank booth', 'Use-quickly', m =>
                this.log(`  ${m}`)
            ));
        }
        if (typeof Bank.openNearest === 'function') {
            return !!(await Bank.openNearest('Bank booth', 'Use-quickly', m => this.log(`  ${m}`)));
        }
        this.log('WARNING: Bank.openBooth unavailable — cannot open Draynor without nearest-bank snap');
        return false;
    }

    /**
     * While the bank is open: withdraw any missing Bronze sword / Wooden shield.
     * @returns {Promise<boolean>} true if both pieces are equipped or in the pack
     */
    async withdrawMissingGearFromOpenBank() {
        if (!Bank.isOpen()) {
            return this.hasGearAvailable();
        }

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(
                () => Bank.loaded() || (typeof Bank.items === 'function' && Bank.items().length > 0),
                5000
            );
        }
        await Execution.delayTicks(1);

        for (const item of GEAR) {
            if (Equipment.contains(item) || Inventory.first(item)) {
                continue;
            }

            let inBank = typeof Bank.count === 'function' ? Bank.count(item) || 0 : 0;
            if (inBank <= 0 && typeof Bank.items === 'function') {
                const want = item.toLowerCase();
                inBank = Bank.items().some(i => (i.name ?? '').toLowerCase() === want) ? 1 : 0;
            }
            if (inBank <= 0) {
                this.log(`WARNING: no ${item} in open bank`);
                continue;
            }

            this.status = `gear: withdraw ${item}`;
            this.log(`gear: withdrawing ${item}`);
            let ok = false;
            if (typeof Bank.withdrawX === 'function') {
                ok = !!(await Bank.withdrawX(item, 1));
            }
            if (!ok && typeof Bank.withdraw === 'function') {
                ok = !!(await Bank.withdraw(item, 'Withdraw-1'));
            }
            if (!ok && typeof Bank.withdraw === 'function') {
                ok = !!(await Bank.withdraw(item));
            }

            await Execution.delayUntil(
                () => !!Inventory.first(item) || Equipment.contains(item),
                4000
            );
            if (!Inventory.first(item) && !Equipment.contains(item)) {
                this.log(`gear: ${item} still missing after withdraw — keep bank open and retry`);
                return false;
            }
            this.log(`gear: withdrew ${item}`);
            await Execution.delayTicks(1);
        }

        return this.hasGearAvailable();
    }

    /** Unequip then re-equip Bronze sword + Wooden shield from the pack. */
    async equipGearFromPack() {
        for (const item of GEAR) {
            if (!Equipment.contains(item)) {
                continue;
            }
            this.log(`unequipping ${item}`);
            await Equipment.unequip(item);
            await Execution.delayTicks(1);
        }
        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!Inventory.first(item)) {
                continue;
            }
            this.status = `gear: equip ${item}`;
            this.log(`re-equipping ${item}`);
            if (await Equipment.equip(item)) {
                this.log(`gear: equipped ${item}`);
            } else {
                this.log(`WARNING: could not equip ${item}`);
            }
            await Execution.delayTicks(1);
        }
        return this.hasGearEquipped();
    }

    /**
     * Fresh combat-3 / total-28: (1) walk to 3092,3244,0 first, (2) bank junk except GEAR,
     * (3) withdraw GEAR if stuck in bank, (4) equip and go.
     * @returns {Promise<boolean>} true if this loop spent time on travel/gear
     */
    async prepFreshDraynorBank() {
        if (await this.walkToDraynorFirst()) {
            return true;
        }

        for (const worn of Equipment.items()) {
            const name = worn.name;
            if (!name || isGearName(name)) {
                continue;
            }
            this.log(`gear: unequipping ${name}`);
            if (!(await Equipment.unequip(name))) {
                this.log(`gear: could not unequip ${name}`);
                await Execution.delayTicks(1);
                return true;
            }
            await Execution.delayTicks(1);
        }

        // Already holding gear and no junk — just equip and fight (no bank thrash).
        const shouldDeposit = depositExceptGear();
        const junk = Inventory.items().filter(i => shouldDeposit(i.name ?? ''));
        if (junk.length === 0 && this.hasGearAvailable()) {
            await this.equipGearFromPack();
            this.gearReady = true;
            this.status = 'walking to goblins';
            this.log('gear ready — heading to goblins (no bank needed)');
            return false;
        }

        if (!(await this.openDraynorBoothHere())) {
            this.log('could not open Draynor booth — retrying');
            await Execution.delayTicks(3);
            return true;
        }

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(
                () => Bank.loaded() || (typeof Bank.items === 'function' && Bank.items().length > 0),
                5000
            );
        }
        await Execution.delayTicks(1);

        if (distToDraynor(Game.tile()) > 12) {
            this.log(
                `bank open but not at Draynor (tile ${Game.tile()?.x},${Game.tile()?.z}) — closing`
            );
            if (Bank.isOpen()) {
                await Bank.close();
            }
            await Execution.delayTicks(2);
            return true;
        }

        if (junk.length > 0) {
            this.log('depositing junk at Draynor (keeping Bronze sword + Wooden shield)');
            await Bank.depositAllMatching(shouldDeposit);
            await Execution.delayTicks(1);
        }

        // Gear may already be sitting in the bank from an earlier deposit — pull it out.
        await this.withdrawMissingGearFromOpenBank();
        if (Bank.isOpen()) {
            await Bank.close();
            await Execution.delayTicks(1);
        }

        await this.equipGearFromPack();

        if (this.hasGearAvailable()) {
            this.gearReady = true;
            this.status = 'walking to goblins';
            this.log('gear ready (Draynor) — sword + shield; killing goblins until death');
            return false;
        }

        this.log('WARNING: missing Bronze sword / Wooden shield after Draynor — retrying');
        await Execution.delayTicks(5);
        return true;
    }

    /**
     * Non-fresh startup: walk Draynor first, deposit all, withdraw/equip GEAR.
     * Never uses Banking.open() nearest-bank (Al Kharid).
     * @returns {Promise<boolean>}
     */
    async prepGearAtDraynorBank() {
        if (await this.walkToDraynorFirst()) {
            return true;
        }

        for (const worn of Equipment.items()) {
            const name = worn.name;
            if (!name) {
                continue;
            }
            this.log(`gear: unequipping ${name}`);
            if (!(await Equipment.unequip(name))) {
                this.log(`gear: could not unequip ${name}`);
                await Execution.delayTicks(1);
                return true;
            }
            await Execution.delayTicks(1);
        }

        if (!(await this.openDraynorBoothHere())) {
            this.log('could not open Draynor booth — retrying');
            await Execution.delayTicks(3);
            return true;
        }

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(
                () => Bank.loaded() || (typeof Bank.items === 'function' && Bank.items().length > 0),
                5000
            );
        }
        await Execution.delayTicks(1);

        if (distToDraynor(Game.tile()) > 12) {
            this.log('bank open but not at Draynor — closing');
            if (Bank.isOpen()) {
                await Bank.close();
            }
            return true;
        }

        this.log('gear: depositing inventory at Draynor');
        if (typeof Bank.depositInventory === 'function') {
            await Bank.depositInventory();
        } else {
            await Bank.depositAllMatching(() => true);
        }
        await Execution.delayTicks(2);

        await this.withdrawMissingGearFromOpenBank();
        if (Bank.isOpen()) {
            await Bank.close();
            await Execution.delayTicks(1);
        }

        await this.equipGearFromPack();

        if (this.hasGearAvailable()) {
            this.gearReady = true;
            this.status = 'walking to goblins';
            this.log('gear ready — sword + shield; killing goblins until death');
            return false;
        }

        this.log('gear incomplete — need Bronze sword and Wooden shield in the bank');
        await Execution.delayTicks(5);
        return true;
    }

    /**
     * Startup: one Draynor trip. After gearReady, never banks again until death loses gear.
     * @returns {Promise<boolean>} true if this loop spent time on gear
     */
    async prepCombatGear() {
        if (this.gearReady) {
            return await this.ensureGear();
        }

        if (this.freshStarter === null) {
            this.latchFreshStarter();
            if (this.freshStarter === null) {
                this.status = 'waiting for stats';
                await Execution.delayTicks(2);
                return true;
            }
        }

        // Already geared — skip bank entirely and go kill.
        if (this.hasGearAvailable()) {
            await this.equipGearFromPack();
            this.gearReady = true;
            this.status = 'walking to goblins';
            this.log('already have sword + shield — skipping bank, killing goblins');
            return false;
        }

        if (this.freshStarter) {
            return await this.prepFreshDraynorBank();
        }

        return await this.prepGearAtDraynorBank();
    }

    /** @returns {Promise<boolean>} true if this loop spent time equipping */
    async ensureGear() {
        let did = false;
        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!Inventory.first(item)) {
                // Never clear gearReady mid-fight — that caused bank↔goblin thrashing.
                this.log(`WARNING: ${item} missing mid-fight — bank only after death if lost`);
                continue;
            }
            this.status = `equipping ${item}`;
            if (await Equipment.equip(item)) {
                this.log(`equipped ${item}`);
                did = true;
            }
            await Execution.delayTicks(1);
        }
        return did;
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.10.0',
    category: 'Combat',
    tags: ['goblin', 'lumbridge', 'melee', 'death-recovery', 'xp', 'prayer', 'bank', 'draynor'],
    description:
        'Legacy Goblin Killer — one Draynor gear trip, then goblins until death; drops Beer/Kebab/Casket',
    settingsSchema: {
        buryBones: {
            type: 'boolean',
            default: true,
            label: 'Bury bones',
            group: 'Loot',
            help: 'Loot nearby Bones and bury them from the inventory for Prayer XP'
        },
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
    create: () => new LegacyGoblinKiller()
});