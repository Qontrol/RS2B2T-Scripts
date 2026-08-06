/**
 * LumbridgeGoblinKiller. Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM: pulls the live ABI from globalThis.__rs2b0t (same as @rs2b0t/api).
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('LumbridgeGoblinKiller: globalThis.__rs2b0t missing — load this inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `LumbridgeGoblinKiller: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
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
    ChatDialog
} = abi;

const SCRIPT_NAME = 'LumbridgeGoblinKiller';

/** Outdoor goblin camp — south of the house door (3246,3244). */
const GOBLIN_SPOT = new Tile(3246, 3242, 0);
const LEASH = 12;
/**
 * Goblin house interior (ground floor). Door @ 3246,3244 faces south —
 * do not voluntarily Attack goblins inside these bounds (or upstairs).
 */
const HOUSE_X0 = 3243;
const HOUSE_X1 = 3248;
const HOUSE_Z0 = 3245;
const HOUSE_Z1 = 3249;
const GEAR = ['Bronze sword', 'Wooden shield'];
const DEATH_RE = /oh dear.*you are dead/i;
const CANT_REACH_RE = /i can't reach that/i;
const TOWARD_SLACK = 4;

/** Melee styles that train a single combat skill (1:1 with the skill name). */
const TRAINABLE = ['attack', 'strength', 'defence'];
/** Skills we may show XP/hr for once they gain XP this session. */
const COMBAT_TRACK = ['attack', 'strength', 'defence', 'hitpoints', 'prayer'];

function cheb(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
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

/** True when the tile is inside the goblin house (skip these for voluntary attacks). */
function isInsideGoblinHouse(tile) {
    if (!tile) {
        return false;
    }
    const level = tile.level ?? 0;
    if (level > 0) {
        return true;
    }
    return (
        tile.x >= HOUSE_X0 &&
        tile.x <= HOUSE_X1 &&
        tile.z >= HOUSE_Z0 &&
        tile.z <= HOUSE_Z1
    );
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

class LumbridgeGoblinKiller extends LoopingBot {
    recovering = false;
    deaths = 0;
    attacks = 0;
    status = 'starting';
    /** False until we have banked everything and withdrawn/equipped GEAR once. */
    gearReady = false;

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
        this.log('first: bank all → withdraw/equip Bronze sword + Wooden shield');
        this.log('tip: Pause → Edit parameters to change prefs without stopping');
        this.status = 'gear: bank';
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

        if (await this.prepCombatGear()) {
            return;
        }

        if (await this.ensureCombatStyle()) {
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

        if (Tile.from(here).distanceTo(GOBLIN_SPOT) > LEASH) {
            this.status = 'walking to goblins';
            this.log('walking to outdoor goblins');
            const ok = await Traversal.walkResilient(GOBLIN_SPOT, {
                radius: 4,
                log: msg => this.log(`  ${msg}`)
            });
            if (!ok) {
                this.log('path to goblins failed — retrying');
            }
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
            `Benzyme's Goblin Killer v1.6  ${this.desiredStyle}  atk ${this.attacks}  deaths ${this.deaths}`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`
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
     * Attack an outdoor goblin. On "I can't reach that!" open the blocking door and retry.
     */
    async attackGoblin(goblin) {
        const index = goblin.index;
        const targetTile = goblin.tile();
        if (isInsideGoblinHouse(targetTile) && !npcTargetsMe(goblin)) {
            this.log(`skipping house goblin @ ${targetTile.x},${targetTile.z}`);
            await Execution.delayTicks(1);
            return;
        }

        this.status = `attacking (${goblin.distance()}t)`;
        this.log(`attacking Goblin @ ${targetTile.x},${targetTile.z}`);
        this.cantReach = false;
        await goblin.interact('Attack');
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

    /** Goblin currently targeting the player (real fight, not a stale combat flag). */
    findGoblinFightingMe() {
        return Npcs.query()
            .name('Goblin')
            .within(LEASH + 6)
            .where(n => npcTargetsMe(n))
            .nearest();
    }

    /**
     * Prefer the goblin already on us (re-engage after random events), else an idle outdoor one.
     * Never start a fight on a goblin already in combat with someone else, or inside the house.
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
            .where(n => !n.inCombat)
            .where(n => !isInsideGoblinHouse(n.tile()))
            .nearest();
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
     * Bury inventory bones / loot nearby bones when the option is on.
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

        const ground = GroundItems.query().name('Bones').within(10).nearest();
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
            this.gearReady = false;
            this.log('gear missing after death — will bank + withdraw again');
            this.recovering = false;
            this.status = 'gear: bank';
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

    /**
     * Startup (and when gear is missing): unequip → deposit all → withdraw GEAR → equip.
     * After gearReady, only re-equip from the pack if something was removed.
     * @returns {Promise<boolean>} true if this loop spent time on gear
     */
    async prepCombatGear() {
        if (this.gearReady) {
            return await this.ensureGear();
        }

        this.status = 'gear: bank';

        // Bank worn junk too — strip everything before deposit.
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

        if (!Bank.isOpen()) {
            this.log('gear: opening bank — deposit all, withdraw sword + shield');
            if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                this.log('gear: could not open bank — retrying');
                await Execution.delayTicks(3);
                return true;
            }
        }

        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
        }
        await Execution.delayTicks(1);

        this.log('gear: depositing inventory');
        if (typeof Bank.depositInventory === 'function') {
            await Bank.depositInventory();
        } else {
            await Bank.depositAllMatching(() => true);
        }
        await Execution.delayTicks(1);

        for (const item of GEAR) {
            if (Inventory.first(item)) {
                continue;
            }
            const inBank = Bank.count(item) || 0;
            if (inBank <= 0) {
                this.log(`WARNING: no ${item} in bank — put one in, then continue`);
                continue;
            }
            this.log(`gear: withdrawing ${item}`);
            if (!(await Bank.withdrawX(item, 1))) {
                this.log(`gear: withdraw failed for ${item}`);
                await Execution.delayTicks(2);
                return true;
            }
            await Execution.delayTicks(1);
        }

        await Bank.close();
        await Execution.delayTicks(1);

        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!Inventory.first(item)) {
                continue;
            }
            this.status = `gear: equip ${item}`;
            if (await Equipment.equip(item)) {
                this.log(`gear: equipped ${item}`);
            } else {
                this.log(`WARNING: could not equip ${item}`);
            }
            await Execution.delayTicks(1);
        }

        if (this.hasGearEquipped()) {
            this.gearReady = true;
            this.status = 'ready';
            this.log('gear ready — Bronze sword + Wooden shield equipped; heading to goblins');
        } else {
            this.log('gear incomplete — need Bronze sword and Wooden shield in the bank');
            await Execution.delayTicks(8);
        }
        return true;
    }

    /** @returns {Promise<boolean>} true if this loop spent time equipping */
    async ensureGear() {
        let did = false;
        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!Inventory.first(item)) {
                this.gearReady = false;
                this.log(`missing ${item} — will bank + withdraw again`);
                return true;
            }
            this.status = `equipping ${item}`;
            if (await Equipment.equip(item)) {
                this.log(`equipped ${item}`);
                did = true;
            }
        }
        return did;
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.6.0',
    category: 'Combat',
    tags: ['goblin', 'lumbridge', 'melee', 'death-recovery', 'xp', 'prayer', 'bank'],
    description:
        "Benzyme's Goblin Killer — banks all first, withdraws/equips Bronze sword + Wooden shield, then Lumbridge goblins",
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
    create: () => new LumbridgeGoblinKiller()
});