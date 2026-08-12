// Benzyme's Goblin Killer v2.6 — Lumbridge goblins → giant rats at combat 20, own-kill bone bury.
// If oak camp is crowded (≥7 players), trains wider around HAM hideout door (goblins + spiders).
// Auto-skips Tutorial Island (Accept character design → RuneScape Guide → Yes please).
// Completely vibe coded by @.benzyme on Discord via Cursor AI
// Self-contained ESM for rs2b0t Load local script / Load URL.
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error(
        "Benzyme's Goblin Killer: globalThis.__rs2b0t missing — load inside rs2b0t bot.html"
    );
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `Benzyme's Goblin Killer: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Npcs,
    Locs,
    Players,
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

const SCRIPT_NAME = "Benzyme's Goblin Killer";
/** Display / paint version — bump minor on each update (v2 → v2.1 → v2.2 …). */
const SCRIPT_VERSION = '2.6';
const SCRIPT_VERSION_FULL = '2.6.0';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/** Tutorial Island map-square bbox (48,48 → tiles ~3072–3135). */
const TUT_MIN = 3072;
const TUT_MAX = 3200;
const GUIDE_NAME = 'RuneScape Guide';

/**
 * Oak tree in the center of the Lumbridge goblin camp.
 * Combat + bone loot stay inside this radius so cow-paddock bones to the north are ignored.
 */
const OAK_TREE = new Tile(3243, 3240, 0);
const CAMP_RADIUS = 15;
/** Goblin house door — keep Open whenever we're at the oak camp. */
const HOUSE_DOOR = new Tile(3246, 3244, 0);

/**
 * Overflow training spot when the oak camp is crowded — HAM hideout door.
 * Fight goblins + spiders here (prefer goblins); larger radius so we radiate around the door.
 */
const ALT_CAMP = new Tile(3176, 3243, 0);
const ALT_CAMP_RADIUS = 28;
/** If this many (or more) other players are at the oak camp, hop to ALT_CAMP. */
const OAK_CROWD_THRESHOLD = 7;

/**
 * Combat-20+ training spot — Lumbridge giant rats (south of castle / near farm).
 * Takes priority over oak + HAM overflow once combat level is reached.
 */
const RAT_CAMP = new Tile(3215, 3180, 0);
const RAT_CAMP_RADIUS = 18;
const RAT_COMBAT_LEVEL = 20;
const RAT_NPC_NAME = 'Giant rat';

/** Only loot Bones that appear on/near our last kill tile, within this window. */
const OWN_BONE_LOOT_RADIUS = 2;
const OWN_BONE_LOOT_MS = 12_000;

const GEAR = ['Bronze sword', 'Wooden shield'];
const DEATH_RE = /oh dear.*you are dead/i;
const CANT_REACH_RE = /i can't reach that/i;
const TOWARD_SLACK = 4;

/** Side-panel tab indices (rs2b0t Game.openSideTab). */
const STATS_TAB = 1;

/** Melee styles that train a single combat skill. */
const TRAINABLE = ['attack', 'strength', 'defence'];
/** Skills we may show XP/hr for once they gain XP this session. */
const COMBAT_TRACK = ['attack', 'strength', 'defence', 'hitpoints', 'prayer'];

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

/** True while standing on Tutorial Island (map square ~48,48). */
function isOnTutorialIsland(tile = Game.tile()) {
    if (!tile) {
        return false;
    }
    return (
        tile.x >= TUT_MIN &&
        tile.x < TUT_MAX &&
        tile.z >= TUT_MIN &&
        tile.z < TUT_MAX
    );
}

function characterCreationTexts() {
    const host = welcomeHost();
    if (!host?.reader || typeof host.reader.mainModalTexts !== 'function') {
        return [];
    }
    return host.reader.mainModalTexts() ?? [];
}

/** Character design (player_kit) open — Accept to finish appearance. */
function isCharacterCreationOpen() {
    const host = welcomeHost();
    if (!host?.reader) {
        return false;
    }
    const { reader } = host;
    const main = typeof reader.modals === 'function' ? reader.modals().main : -1;
    if (main === -1) {
        return false;
    }

    const texts = characterCreationTexts();
    if (
        texts.some(
            t =>
                /design your player/i.test(t) ||
                /use the buttons below to design/i.test(t) ||
                /welcome to runescape - use the buttons/i.test(t)
        )
    ) {
        return true;
    }

    // On tutorial island with an Accept button on the main modal.
    if (
        isOnTutorialIsland() &&
        typeof reader.buttonByText === 'function' &&
        reader.buttonByText(main, 'Accept') !== -1
    ) {
        return true;
    }
    return false;
}

/**
 * Click Accept on character creation (player_kit clientcode 326).
 * @returns {Promise<boolean>}
 */
async function acceptCharacterCreation() {
    if (!isCharacterCreationOpen()) {
        return false;
    }
    const host = welcomeHost();
    if (!host?.reader || !host?.actions) {
        return false;
    }
    const { reader, actions } = host;
    const main = reader.modals().main;
    if (main === -1 || typeof actions.ifButton !== 'function') {
        return false;
    }

    if (typeof reader.buttonByText === 'function') {
        const btn = reader.buttonByText(main, 'Accept');
        if (btn !== -1 && actions.ifButton(btn)) {
            await Execution.delayTicks(2);
            return true;
        }
    }
    return false;
}

function findRuneScapeGuide() {
    return (
        Npcs.query().name(GUIDE_NAME).nearest() ??
        Npcs.query()
            .where(n => /runescape\s*guide/i.test(n.name ?? ''))
            .nearest() ??
        null
    );
}

function pickTutorialSkipOption(options) {
    if (!options || options.length === 0) {
        return null;
    }
    for (const prefer of [
        /yes\s*please/i,
        /skip\s*(the\s*)?tutorial/i,
        /^yes\b/i
    ]) {
        const hit = options.find(o => prefer.test(o ?? ''));
        if (hit) {
            return hit;
        }
    }
    return options[0] ?? null;
}

function cheb(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/**
 * Other players standing in/near the oak goblin camp.
 * Used to decide when to hop to the overflow spot.
 */
function otherPlayersAtOakCamp(radius = CAMP_RADIUS) {
    if (typeof Players?.query !== 'function') {
        return 0;
    }
    return Players.query()
        .where(p => {
            const pt = p.tile?.() ?? null;
            return pt != null && Tile.from(pt).distanceTo(OAK_TREE) <= radius;
        })
        .count();
}

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

function isGiantRatNpc(n) {
    const name = (n.name ?? '').toLowerCase();
    return name.includes('giant rat') || name === 'giant rat';
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

/** Clamp levels-before-swap to the scroll bar range 1–20. */
function clampLevels(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) {
        return 1;
    }
    return Math.min(20, Math.max(1, v));
}

/**
 * Pick a random melee style. Prefer a different skill than `except` when possible.
 * @param {string | null} [except]
 */
function pickRandomStyle(except = null) {
    const pool = TRAINABLE.filter(s => s !== except);
    const choices = pool.length > 0 ? pool : TRAINABLE.slice();
    return choices[Math.floor(Math.random() * choices.length)];
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

class BenzymeGoblinKiller extends LoopingBot {
    recovering = false;
    deaths = 0;
    attacks = 0;
    status = 'starting';
    /** False until we have banked everything and withdrawn/equipped GEAR once. */
    gearReady = false;
    /** False until Tutorial Island / character creation is cleared (or never present). */
    tutorialCleared = false;

    /** When true: train one style for N levels, then randomly pick another. */
    rotateStyles = true;
    levelsBeforeSwap = 5;
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
    underAttackSince = 0;
    /** @type {number} */
    lastAttackerIndex = -1;
    retaliatingIndex = -1;
    retaliateClickedAt = 0;
    /** NPC index we are / were fighting — used to claim own-kill bone drops. */
    fightNpcIndex = -1;
    /** @type {InstanceType<typeof Tile> | null} */
    fightNpcTile = null;
    /** @type {InstanceType<typeof Tile> | null} */
    ownBoneLootTile = null;
    ownBoneLootUntil = 0;
    /** Inventory bones from our own loot that we are allowed to bury. */
    ownBonesPending = 0;
    /** When true: train at ALT_CAMP (goblins + spiders) because oak is crowded. */
    useAltCamp = false;
    /** When true: combat ≥20 — train giant rats at RAT_CAMP (overrides goblin camps). */
    useRats = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    unlockTimer = null;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();
        this.startPausedPrefUnlock();

        this.syncPrefs({ silent: true });
        if (this.rotateStyles) {
            this.desiredStyle = pickRandomStyle(null);
        } else {
            this.desiredStyle = this.fixedStyle;
        }
        this.useAltCamp = false;
        this.useRats = false;
        this.styleLevelAnchor = Skills.level(this.desiredStyle);

        this.startedAt = Date.now();
        this.xpAtStart = Object.create(null);
        this.usedSkills = new Set();
        this.buried = 0;
        this.gearReady = false;
        this.tutorialCleared = false;
        this.underAttackSince = 0;
        this.lastAttackerIndex = -1;
        this.retaliatingIndex = -1;
        this.retaliateClickedAt = 0;
        this.fightNpcIndex = -1;
        this.fightNpcTile = null;
        this.ownBoneLootTile = null;
        this.ownBoneLootUntil = 0;
        this.ownBonesPending = 0;
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
            this.rotateStyles
                ? `started — rotate styles (swap every ${this.levelsBeforeSwap} lvl); training ${this.desiredStyle}`
                : `started — fixed style ${this.desiredStyle}`
        );
        this.log(
            `camp oak ${OAK_TREE.x},${OAK_TREE.z} · radius ${CAMP_RADIUS} · ` +
                `if ≥${OAK_CROWD_THRESHOLD} players → alt HAM door ${ALT_CAMP.x},${ALT_CAMP.z} ` +
                `r${ALT_CAMP_RADIUS} (goblins+spiders) · ` +
                `combat ≥${RAT_COMBAT_LEVEL} → rats ${RAT_CAMP.x},${RAT_CAMP.z} · ` +
                `bury bones: ${this.buryBones ? 'own kills only' : 'off'}`
        );
        this.log(
            'startup first: skip Tutorial Island if needed → find bank → unequip all → deposit all → withdraw Bronze sword + Wooden shield'
        );
        if (isOnTutorialIsland() || isCharacterCreationOpen() || findRuneScapeGuide()) {
            this.log('Tutorial Island / character creation detected — will Accept → Guide → skip');
            this.status = 'tutorial';
        } else {
            this.tutorialCleared = true;
            this.status = 'find bank';
        }
        this.log('tip: Pause → Edit parameters to change prefs without stopping');
    }

    onPause() {
        unlockPausedPrefsUi();
    }

    onResume() {
        this.syncPrefs({ silent: false });
    }

    /**
     * Tutorial Island / character creation:
     * 1) Click Accept on player design
     * 2) Talk to RuneScape Guide
     * 3) Choose "Yes please." to skip (dev/private servers)
     * Then mark cleared and let normal bank/gear flow run.
     * @returns {Promise<boolean>} true if this loop spent time on tutorial
     */
    async handleTutorialIsland() {
        // Already off the island with no design UI — commence normal script.
        if (
            !isCharacterCreationOpen() &&
            !isOnTutorialIsland() &&
            !findRuneScapeGuide() &&
            !(
                typeof ChatDialog !== 'undefined' &&
                ChatDialog &&
                (ChatDialog.canContinue() ||
                    (typeof ChatDialog.isOpen === 'function' && ChatDialog.isOpen()))
            )
        ) {
            this.tutorialCleared = true;
            this.log('tutorial cleared — commencing normal script');
            this.status = 'find bank';
            return false;
        }

        if (isCharacterCreationOpen()) {
            this.status = 'tutorial: accept design';
            this.log('character creation — clicking Accept');
            if (await acceptCharacterCreation()) {
                this.log('accepted character design');
            } else {
                this.log('could not click Accept — retrying');
                await Execution.delayTicks(2);
            }
            return true;
        }

        if (typeof ChatDialog !== 'undefined' && ChatDialog) {
            if (ChatDialog.canContinue()) {
                this.status = 'tutorial: continue';
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
                const pick = pickTutorialSkipOption(opts);
                this.status = 'tutorial: skip option';
                this.log(
                    `tutorial dialog: [${opts.join(' | ')}] → ${pick ?? 'none'}`
                );
                if (pick) {
                    await ChatDialog.chooseOption(pick);
                } else {
                    await ChatDialog.chooseOption();
                }
                await Execution.delayTicks(2);
                return true;
            }
        }

        if (isOnTutorialIsland() || findRuneScapeGuide()) {
            const guide = findRuneScapeGuide();
            if (!guide) {
                this.status = 'tutorial: find guide';
                this.log('waiting for RuneScape Guide');
                await Execution.delayTicks(3);
                return true;
            }

            const talk =
                guide.actions().find(a => /talk/i.test(a ?? '')) ?? 'Talk-to';
            this.status = 'tutorial: talk to guide';
            this.log(`Talk-to ${GUIDE_NAME} — skip tutorial`);
            await guide.interact(talk);
            await Execution.delayUntil(
                () =>
                    (typeof ChatDialog !== 'undefined' &&
                        ChatDialog &&
                        (ChatDialog.canContinue() ||
                            (typeof ChatDialog.isOpen === 'function' &&
                                ChatDialog.isOpen()))) ||
                    !isOnTutorialIsland(),
                8000
            );
            return true;
        }

        // Fallback: something odd — wait then re-check.
        await Execution.delayTicks(2);
        return true;
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

        // Fresh accounts: character design → RuneScape Guide → skip tutorial → Lumbridge.
        if (!this.tutorialCleared) {
            if (await this.handleTutorialIsland()) {
                return;
            }
        }

        if (this.recovering) {
            await this.recover();
            return;
        }

        // First priority after login/respawn gear loss: find a bank and kit up.
        if (!this.gearReady) {
            if (await this.prepCombatGear()) {
                return;
            }
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

        if (await this.handleDropJunk()) {
            return;
        }

        if (await this.prepCombatGear()) {
            return;
        }

        if (await this.ensureCombatStyle()) {
            return;
        }

        if (await this.ensureStatsTab()) {
            return;
        }

        this.refreshOwnKillLoot();

        if (await this.handleBones()) {
            return;
        }

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (await this.ensureRetaliate()) {
            return;
        }

        this.refreshCampChoice();
        const anchor = this.campAnchor();
        const radius = this.campRadius();

        if (Tile.from(here).distanceTo(anchor) > radius) {
            this.status = this.useRats
                ? 'walking to rats'
                : this.useAltCamp
                  ? 'walking to alt camp'
                  : 'walking to goblins';
            this.log(
                this.useRats
                    ? `walking to giant rats ${anchor.x},${anchor.z}`
                    : this.useAltCamp
                      ? `walking to overflow camp ${anchor.x},${anchor.z}`
                      : `walking to goblin camp oak ${anchor.x},${anchor.z}`
            );
            const ok = await Traversal.walkResilient(anchor, {
                radius: 4,
                log: msg => this.log(`  ${msg}`)
            });
            if (!ok) {
                this.log('path to camp failed — retrying');
            }
            return;
        }

        // Re-check progression / crowd once we arrive (scene may have loaded more).
        if (!this.useRats) {
            this.refreshCampChoice();
            if (this.useRats || this.useAltCamp) {
                return;
            }
        }

        if (!this.useRats && !this.useAltCamp && (await this.ensureHouseDoorOpen())) {
            return;
        }

        if (Game.inCombat()) {
            const onMe = this.findTargetFightingMe();
            if (onMe) {
                this.noteFightTarget(onMe);
                this.status = 'in combat';
                await Execution.delayTicks(2);
                return;
            }
            this.status = 're-engaging';
            this.log('combat interrupted (e.g. random event) — re-engaging');
        }

        const target = this.findAttackableTarget();
        if (!target) {
            this.status = this.useRats
                ? 'waiting for giant rat'
                : this.useAltCamp
                  ? 'waiting for goblin/spider'
                  : 'waiting for goblin';
            // At HAM door / rats, roam farther so we radiate through the area.
            const idleRadius = this.useRats
                ? Math.min(8, Math.floor(RAT_CAMP_RADIUS / 2))
                : this.useAltCamp
                  ? Math.min(10, Math.floor(ALT_CAMP_RADIUS / 2))
                  : 2;
            await Traversal.walkTo(anchor, {
                radius: idleRadius,
                timeoutMs: 8_000
            });
            await Execution.delayTicks(2);
            return;
        }

        await this.attackTarget(target);
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
            `Benzyme's Goblin Killer v${SCRIPT_VERSION}`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `deaths ${this.deaths}`
        ];

        if (this.buryBones) {
            lines.push(
                `bury own bones · buried ${this.buried}` +
                    (this.ownBonesPending > 0 ? ` · pending ${this.ownBonesPending}` : '')
            );
        }

        if (this.useRats) {
            lines.push(`camp rats ${RAT_CAMP.x},${RAT_CAMP.z} r${RAT_CAMP_RADIUS} · combat ≥${RAT_COMBAT_LEVEL}`);
        } else if (this.useAltCamp) {
            lines.push(
                `camp HAM door ${ALT_CAMP.x},${ALT_CAMP.z} r${ALT_CAMP_RADIUS} · goblins > spiders`
            );
        } else {
            lines.push(`camp oak ${OAK_TREE.x},${OAK_TREE.z}`);
        }

        if (this.rotateStyles) {
            const gained = Skills.level(this.desiredStyle) - this.styleLevelAnchor;
            lines.push(
                `rotate · ${gained}/${this.levelsBeforeSwap} lv on ${this.desiredStyle}`
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

        lines.push('GEAR: Bronze sword + Wooden shield only.');

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
        const prevRotate = this.rotateStyles;
        const prevLevels = this.levelsBeforeSwap;
        const prevFixed = this.fixedStyle;
        const prevBury = this.buryBones;

        this.rotateStyles = readPrefBool('rotateStyles', this.settings.bool('rotateStyles', true));
        this.buryBones = readPrefBool('buryBones', this.settings.bool('buryBones', true));
        this.levelsBeforeSwap = clampLevels(
            readPrefNum('levelsBeforeSwap', this.settings.num('levelsBeforeSwap', 5))
        );
        let fixed = readPrefStr('meleeStyle', this.settings.str('meleeStyle', 'attack')).toLowerCase();
        if (!TRAINABLE.includes(fixed)) {
            fixed = 'attack';
        }
        this.fixedStyle = fixed;

        if (!silent && this.buryBones !== prevBury) {
            this.log(`prefs: bury bones → ${this.buryBones ? 'on' : 'off'}`);
        }

        if (this.rotateStyles !== prevRotate) {
            if (this.rotateStyles) {
                this.desiredStyle = pickRandomStyle(null);
                this.styleLevelAnchor = Skills.level(this.desiredStyle);
                if (!silent) {
                    this.log(`prefs: rotate styles ON → training ${this.desiredStyle}`);
                }
            } else {
                this.desiredStyle = this.fixedStyle;
                this.styleLevelAnchor = Skills.level(this.desiredStyle);
                if (!silent) {
                    this.log(`prefs: rotate styles OFF → fixed ${this.desiredStyle}`);
                }
            }
            return;
        }

        if (!this.rotateStyles && this.fixedStyle !== prevFixed) {
            this.desiredStyle = this.fixedStyle;
            this.styleLevelAnchor = Skills.level(this.desiredStyle);
            if (!silent) {
                this.log(`prefs: melee style → ${this.desiredStyle}`);
            }
            return;
        }

        if (this.levelsBeforeSwap !== prevLevels && !silent) {
            this.log(`prefs: levels before random swap → ${this.levelsBeforeSwap}`);
        }
    }

    campAnchor() {
        if (this.useRats) {
            return RAT_CAMP;
        }
        return this.useAltCamp ? ALT_CAMP : OAK_TREE;
    }

    campRadius() {
        if (this.useRats) {
            return RAT_CAMP_RADIUS;
        }
        return this.useAltCamp ? ALT_CAMP_RADIUS : CAMP_RADIUS;
    }

    inActiveCamp(tile, radius = this.campRadius()) {
        if (!tile) {
            return false;
        }
        return Tile.from(tile).distanceTo(this.campAnchor()) <= radius;
    }

    /**
     * Combat ≥20 → giant rats (latched). Else if oak is crowded → HAM overflow.
     * Rat camp overrides goblin / spider spots for the rest of the run.
     */
    refreshCampChoice() {
        if (!this.useRats) {
            const combat = combatLevel();
            if (combat >= RAT_COMBAT_LEVEL) {
                this.useRats = true;
                this.useAltCamp = false;
                this.log(
                    `combat ${combat} ≥ ${RAT_COMBAT_LEVEL} — moving to giant rats ` +
                        `${RAT_CAMP.x},${RAT_CAMP.z},${RAT_CAMP.level ?? 0}`
                );
                return;
            }
        }
        if (this.useRats || this.useAltCamp) {
            return;
        }
        const crowd = otherPlayersAtOakCamp(CAMP_RADIUS);
        if (crowd >= OAK_CROWD_THRESHOLD) {
            this.useAltCamp = true;
            this.log(
                `oak camp crowded (${crowd} players ≥ ${OAK_CROWD_THRESHOLD}) — ` +
                    `training at ${ALT_CAMP.x},${ALT_CAMP.z} (goblins preferred, spiders ok)`
            );
        }
    }

    async attackTarget(npc) {
        const index = npc.index;
        const targetTile = npc.tile();
        const name = npc.name ?? 'NPC';

        this.status = `attacking ${name} (${npc.distance()}t)`;
        this.log(`attacking ${name} @ ${targetTile.x},${targetTile.z}`);
        this.cantReach = false;
        this.noteFightTarget(npc);
        await npc.interact('Attack');
        this.noteRetaliateClick(npc.index);
        await Execution.delayUntil(
            () => Game.inCombat() || this.cantReach || this.findTargetFightingMe() !== null,
            4000
        );

        if (Game.inCombat() || this.findTargetFightingMe()) {
            const fighting = this.findTargetFightingMe() ?? npc;
            this.noteFightTarget(fighting);
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
            this.log(`no shut door found toward that ${name}`);
            return;
        }

        const again =
            Npcs.query()
                .where(n => n.index === index)
                .nearest() ?? this.findAttackableTarget();

        if (!again) {
            // Target gone after door open — likely died / despawned; claim bone tile if we had one.
            this.refreshOwnKillLoot();
            this.log(`${name} gone after opening door`);
            return;
        }

        this.status = `retry attack (${again.distance()}t)`;
        this.log(`retrying ${again.name ?? name} @ ${again.tile().x},${again.tile().z}`);
        this.cantReach = false;
        this.noteFightTarget(again);
        await again.interact('Attack');
        this.noteRetaliateClick(again.index);
        if (
            await Execution.delayUntil(
                () => Game.inCombat() || this.cantReach || this.findTargetFightingMe() !== null,
                4000
            )
        ) {
            if (Game.inCombat() || this.findTargetFightingMe()) {
                const fighting = this.findTargetFightingMe() ?? again;
                this.noteFightTarget(fighting);
                this.attacks++;
            }
        }
    }

    noteFightTarget(npc) {
        if (!npc) {
            return;
        }
        this.fightNpcIndex = npc.index;
        const t = npc.tile?.() ?? null;
        if (t) {
            this.fightNpcTile = Tile.from(t);
        }
    }

    /**
     * When the NPC we were fighting despawns, treat last tile as our kill drop spot
     * so we only loot / bury those bones — never random camp piles.
     */
    refreshOwnKillLoot() {
        if (this.fightNpcIndex < 0) {
            return;
        }
        const still = Npcs.query()
            .where(n => n.index === this.fightNpcIndex)
            .nearest();
        if (still) {
            const t = still.tile?.() ?? null;
            if (t) {
                this.fightNpcTile = Tile.from(t);
            }
            return;
        }
        if (this.fightNpcTile) {
            this.ownBoneLootTile = this.fightNpcTile;
            this.ownBoneLootUntil = Date.now() + OWN_BONE_LOOT_MS;
            this.log(
                `own kill @ ${this.ownBoneLootTile.x},${this.ownBoneLootTile.z} — loot bones only there`
            );
        }
        this.fightNpcIndex = -1;
        this.fightNpcTile = null;
    }

    noteRetaliateClick(index) {
        this.retaliatingIndex = index;
        this.retaliateClickedAt = Date.now();
        this.underAttackSince = 0;
        this.lastAttackerIndex = index;
    }

    findNpcAttackingMe() {
        const range = this.campRadius() + 12;
        const targeting = Npcs.query()
            .within(range)
            .where(n => hasAttackOp(n))
            .where(n => npcTargetsMe(n))
            .nearest();
        if (targeting) {
            return targeting;
        }

        const sticky = Npcs.query()
            .within(4)
            .where(n => hasAttackOp(n))
            .where(n => n.inCombat && !npcTargetsAnother(n))
            .nearest();
        if (sticky) {
            return sticky;
        }

        return (
            Npcs.query()
                .within(range)
                .where(n => isSpiderNpc(n))
                .where(n => hasAttackOp(n))
                .where(n => npcTargetsMe(n) || (n.inCombat && !npcTargetsAnother(n) && n.distance() <= 3))
                .nearest() ?? null
        );
    }

    async ensureRetaliate() {
        const attacker = this.findNpcAttackingMe();
        if (!attacker) {
            this.underAttackSince = 0;
            this.lastAttackerIndex = -1;
            return false;
        }

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
        this.noteFightTarget(attacker);
        this.noteRetaliateClick(attacker.index);
        await Execution.delayUntil(
            () => Game.animating() || Game.inCombat() || this.cantReach,
            3000
        );
        this.attacks++;
        return true;
    }

    findTargetFightingMe() {
        const r = this.campRadius();
        if (this.useRats) {
            return (
                Npcs.query()
                    .name(RAT_NPC_NAME)
                    .within(r + 6)
                    .where(n => this.inActiveCamp(n.tile(), r + 2))
                    .where(n => npcTargetsMe(n))
                    .nearest() ??
                Npcs.query()
                    .within(r + 6)
                    .where(n => isGiantRatNpc(n))
                    .where(n => this.inActiveCamp(n.tile(), r + 2))
                    .where(n => npcTargetsMe(n))
                    .nearest() ??
                null
            );
        }
        const goblin = Npcs.query()
            .name('Goblin')
            .within(r + 6)
            .where(n => this.inActiveCamp(n.tile(), r + 2))
            .where(n => npcTargetsMe(n))
            .nearest();
        if (goblin) {
            return goblin;
        }
        if (!this.useAltCamp) {
            return null;
        }
        return (
            Npcs.query()
                .within(r + 6)
                .where(n => isSpiderNpc(n))
                .where(n => this.inActiveCamp(n.tile(), r + 2))
                .where(n => npcTargetsMe(n))
                .nearest() ?? null
        );
    }

    /**
     * Prefer target already on us, else idle NPC in camp.
     * Rats at combat 20+; else goblins; at HAM overflow fall back to spiders.
     */
    findAttackableTarget() {
        const onMe = this.findTargetFightingMe();
        if (onMe) {
            return onMe;
        }

        const r = this.campRadius();
        if (this.useRats) {
            return (
                Npcs.query()
                    .name(RAT_NPC_NAME)
                    .action('Attack')
                    .within(r + 4)
                    .where(n => this.inActiveCamp(n.tile()))
                    .where(n => !n.inCombat)
                    .nearest() ??
                Npcs.query()
                    .action('Attack')
                    .within(r + 4)
                    .where(n => isGiantRatNpc(n))
                    .where(n => this.inActiveCamp(n.tile()))
                    .where(n => !n.inCombat)
                    .nearest() ??
                null
            );
        }

        const goblin = Npcs.query()
            .name('Goblin')
            .action('Attack')
            .within(r + 4)
            .where(n => this.inActiveCamp(n.tile()))
            .where(n => !n.inCombat)
            .nearest();
        if (goblin) {
            return goblin;
        }

        if (!this.useAltCamp) {
            return null;
        }

        return (
            Npcs.query()
                .action('Attack')
                .within(r + 4)
                .where(n => isSpiderNpc(n))
                .where(n => this.inActiveCamp(n.tile()))
                .where(n => !n.inCombat)
                .nearest() ?? null
        );
    }

    /** @deprecated use findTargetFightingMe */
    findGoblinFightingMe() {
        return this.findTargetFightingMe();
    }

    /** @deprecated use findAttackableTarget */
    findAttackableGoblin() {
        return this.findAttackableTarget();
    }

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
     * Bury inventory bones from our own kills only.
     * Ground loot is limited to the last kill tile window — never scoop other players' piles.
     */
    async handleBones() {
        if (!this.buryBones || Game.inCombat()) {
            return false;
        }

        const bones = Inventory.first('Bones');
        if (bones) {
            if (this.ownBonesPending <= 0) {
                // Foreign / leftover bones — drop instead of burying Prayer XP we didn't earn.
                this.status = 'drop foreign bones';
                this.log('dropping bones not from our kill');
                const before = Inventory.used();
                await bones.interact('Drop');
                await Execution.delayUntil(() => Inventory.used() < before, 4000);
                return true;
            }
            this.status = 'burying own bones';
            const before = Inventory.used();
            await bones.interact('Bury');
            if (await Execution.delayUntil(() => Inventory.used() < before, 3000)) {
                this.ownBonesPending = Math.max(0, this.ownBonesPending - 1);
                this.buried++;
                this.log(`buried own bones (#${this.buried})`);
            }
            return true;
        }

        if (Inventory.isFull()) {
            return false;
        }

        if (!this.ownBoneLootTile || Date.now() > this.ownBoneLootUntil) {
            return false;
        }

        const spot = this.ownBoneLootTile;
        const ground = GroundItems.query()
            .name('Bones')
            .within(OWN_BONE_LOOT_RADIUS + 4)
            .where(g => {
                const t = g.tile?.() ?? null;
                return t != null && Tile.from(t).distanceTo(spot) <= OWN_BONE_LOOT_RADIUS;
            })
            .nearest();
        if (!ground) {
            return false;
        }

        this.status = 'looting own bones';
        const before = Inventory.used();
        await ground.interact('Take');
        if (await Execution.delayUntil(() => Inventory.used() > before, 5000)) {
            this.ownBonesPending++;
            this.log(
                `looted own-kill bones @ ${spot.x},${spot.z} (pending ${this.ownBonesPending})`
            );
        }
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
     * After N levels on the current style, randomly pick another melee skill.
     * @returns {Promise<boolean>} true if this loop spent time on the style click
     */
    async ensureCombatStyle() {
        if (this.rotateStyles) {
            const cur = Skills.level(this.desiredStyle);
            if (cur >= this.styleLevelAnchor + this.levelsBeforeSwap) {
                const next = pickRandomStyle(this.desiredStyle);
                this.log(
                    `random swap ${this.desiredStyle} → ${next} ` +
                        `(gained ${cur - this.styleLevelAnchor} lv; atk=${Skills.level('attack')} ` +
                        `str=${Skills.level('strength')} def=${Skills.level('defence')})`
                );
                this.desiredStyle = next;
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
            this.fightNpcIndex = -1;
            this.fightNpcTile = null;
            this.ownBoneLootTile = null;
            this.ownBoneLootUntil = 0;
            this.ownBonesPending = 0;
            this.log('gear missing after death — find bank, re-kit, then back to goblins');
            this.recovering = false;
            this.status = 'find bank';
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
        this.refreshCampChoice();
        const anchor = this.campAnchor();
        this.log(
            this.useRats
                ? `running back to giant rats ${anchor.x},${anchor.z}`
                : this.useAltCamp
                  ? `running back to overflow camp ${anchor.x},${anchor.z}`
                  : 'running back to goblins'
        );
        const ok = await Traversal.walkResilient(anchor, {
            radius: 4,
            log: msg => this.log(`  ${msg}`)
        });
        if (ok) {
            this.recovering = false;
            this.status = 'fighting';
            this.log(
                this.useRats
                    ? 'back at giant rats'
                    : this.useAltCamp
                      ? 'back at overflow camp'
                      : 'back at goblins'
            );
        } else {
            this.log('could not reach camp after death — will retry');
        }
    }

    hasGearEquipped() {
        return GEAR.every(g => Equipment.contains(g));
    }

    hasGearAvailable() {
        return GEAR.every(g => Equipment.contains(g) || Inventory.first(g));
    }

    /**
     * Locate and open the nearest bank (web-walks if needed).
     * @returns {Promise<boolean>}
     */
    async findAndOpenBank() {
        if (Bank.isOpen()) {
            return true;
        }
        this.status = 'find bank';
        this.log('finding nearest bank for gear prep');
        if (typeof Banking !== 'undefined' && Banking && typeof Banking.open === 'function') {
            return !!(await Banking.open({
                log: m => this.log(`  ${m}`)
            }));
        }
        if (typeof Bank.openNearest === 'function') {
            return !!(await Bank.openNearest('Bank booth', 'Use-quickly', m => this.log(`  ${m}`)));
        }
        this.log('WARNING: Banking.open unavailable — cannot find a bank');
        return false;
    }

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

    async equipGearFromPack() {
        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!Inventory.first(item)) {
                continue;
            }
            this.status = `gear: equip ${item}`;
            this.log(`equipping ${item}`);
            if (await Equipment.equip(item)) {
                this.log(`gear: equipped ${item}`);
            } else {
                this.log(`WARNING: could not equip ${item}`);
            }
            await Execution.delayTicks(1);
        }
        return this.hasGearEquipped();
    }

    /** Unequip every worn slot into the pack. */
    async unequipEverything() {
        for (const worn of Equipment.items()) {
            const name = worn.name;
            if (!name) {
                continue;
            }
            this.status = `unequip ${name}`;
            this.log(`gear: unequipping ${name}`);
            if (!(await Equipment.unequip(name))) {
                this.log(`gear: could not unequip ${name}`);
                await Execution.delayTicks(1);
                return false;
            }
            await Execution.delayTicks(1);
        }
        return true;
    }

    /**
     * Startup / re-gear: find bank → unequip all → deposit inventory → withdraw GEAR → equip.
     * @returns {Promise<boolean>} true if this loop spent time on travel/gear
     */
    async prepGearAtBank() {
        // First action: locate a bank and open it (walks there if needed).
        if (!(await this.findAndOpenBank())) {
            this.log('could not find / open a bank — retrying');
            await Execution.delayTicks(3);
            return true;
        }

        if (!(await this.unequipEverything())) {
            return true;
        }

        // Re-open if unequip somehow closed the interface.
        if (!Bank.isOpen() && !(await this.findAndOpenBank())) {
            this.log('bank closed during unequip — retrying');
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

        this.log('gear: depositing inventory');
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
            this.log('gear ready — Bronze sword + Wooden shield; heading to goblins');
            return false;
        }

        this.log('gear incomplete — need Bronze sword and Wooden shield in the bank');
        await Execution.delayTicks(5);
        return true;
    }

    /**
     * Startup: find nearest bank, unequip + bank all + withdraw gear. After gearReady,
     * never banks again until death loses gear.
     */
    async prepCombatGear() {
        if (this.gearReady) {
            return await this.ensureGear();
        }
        return await this.prepGearAtBank();
    }

    async ensureGear() {
        let did = false;
        for (const item of GEAR) {
            if (Equipment.contains(item)) {
                continue;
            }
            if (!Inventory.first(item)) {
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
    version: SCRIPT_VERSION_FULL,
    category: 'Combat',
    tags: ['goblin', 'giant-rat', 'lumbridge', 'melee', 'death-recovery', 'xp', 'prayer', 'bank', 'tutorial', 'benzyme'],
    description:
        "Benzyme's Goblin Killer v2.6 — skips Tutorial Island, bank/gear prep, kill Lumbridge oak-camp goblins; if ≥7 players there, train around the HAM hideout door; at combat 20+ move to 3215,3180 and kill giant rats; bury only bones from your own kills",
    settingsSchema: {
        buryBones: {
            type: 'boolean',
            default: true,
            label: 'Bury own-kill bones',
            group: 'Loot',
            help:
                'Loot Bones only from NPCs you killed (drop tile of your last kill) and bury those for Prayer XP — ignores other players\' piles'
        },
        rotateStyles: {
            type: 'boolean',
            default: true,
            label: 'Rotate melee styles',
            group: 'Combat',
            help: 'Train one Attack / Strength / Defence style, then randomly pick another after N levels'
        },
        levelsBeforeSwap: {
            type: 'number',
            default: 5,
            min: 1,
            max: 20,
            label: 'Levels before random swap',
            group: 'Combat',
            showIf: { key: 'rotateStyles', anyOf: ['true'] },
            help: 'Scroll bar 1–20: levels to gain on the current style before randomly selecting another'
        },
        meleeStyle: {
            type: 'string',
            default: 'attack',
            options: ['attack', 'strength', 'defence'],
            label: 'Melee style',
            group: 'Combat',
            showIf: { key: 'rotateStyles', anyOf: ['false'] },
            help: 'Fixed combat style when rotate is off'
        }
    },
    create: () => new BenzymeGoblinKiller()
});
