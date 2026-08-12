/**
 * FlaxHost — stand at Catherby bank and accept incoming noted-flax trades.
 * Stays leashed to the bank (anti-lure). Never offers items; only receives.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('FlaxHost: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(`FlaxHost: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`);
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Players,
    Inventory,
    Bank,
    Banking,
    Traversal,
    Tile,
    Trade,
    BANK_LOCATIONS
} = abi;

const SCRIPT_NAME = 'FlaxHost';

const FLAX_NAME = 'Flax';
/** Max Chebyshev distance to answer a trade wish (request fails beyond this). */
const TRADE_RANGE = 8;
const TRADE_REQUEST_MS = 5_000;
const TRADE_OFFER_WAIT_MS = 5_000;
const TRADE_CONFIRM_WAIT_MS = 8_000;
/** Pause before first Accept on each trade screen (offer + confirm). */
const ACCEPT_WAIT_MIN_MS = 1_000;
const ACCEPT_WAIT_MAX_MS = 3_000;
const ACCEPT_RETRY_MS = 3_000;

const WISHES_TRADE_RE = /wishes to trade with you/i;
const WISH_RE = /^(.+?)\s+wishes to trade with you\.?$/i;
/** How long a noted wish stays valid without being re-seen in chat. */
const WISH_FRESH_MS = 45_000;
const CHAT_POLL_LINES = 20;

const CATHERBY =
    (BANK_LOCATIONS || []).find(b => (b.name || '').toLowerCase() === 'catherby')?.tile ??
    new Tile(2809, 3441, 0);

const WELCOME_SCREEN_ID = 5993;

function acceptDelayMs() {
    return ACCEPT_WAIT_MIN_MS + Math.floor(Math.random() * (ACCEPT_WAIT_MAX_MS - ACCEPT_WAIT_MIN_MS + 1));
}

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

        await Execution.delayUntil(() => !isWelcomeModalOpen(), 1500);
    }
    return !isWelcomeModalOpen();
}

function isFlax(name) {
    return !!name && name.trim().toLowerCase() === FLAX_NAME.toLowerCase();
}

function namesMatch(a, b) {
    return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

/** ObjType.certtemplate when the client exposes the cache type list. */
function certIsNote(id) {
    try {
        const host = welcomeHost();
        const OT = host?.ObjType ?? globalThis.ObjType ?? null;
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

/**
 * Noted flax: certtemplate when available; else stack count > 1
 * (raw flax is non-stackable, so notes are the only stacked flax).
 * When cert lookup is unavailable, treat any Flax offer as noted — hosts
 * receive bank notes, and a count of 1 is a valid single note.
 */
function isNotedFlaxItem(item) {
    if (!item || !isFlax(item.name)) {
        return false;
    }
    const cert = certIsNote(item.id);
    if (cert === true) {
        return true;
    }
    if (cert === false) {
        return false;
    }
    return Math.max(1, item.count) >= 1;
}

function notedUnitsInOffer(items) {
    let n = 0;
    for (const o of items || []) {
        if (isNotedFlaxItem(o)) {
            n += Math.max(1, o.count);
        }
    }
    return n;
}

function offerHasNonFlax(items) {
    return (items || []).some(o => o.name != null && o.name.trim() !== '' && !isFlax(o.name));
}

/** Drunken Dwarf gifts (and similar junk) — never Eat/Drink. */
function isDropJunk(item) {
    const n = (item?.name ?? '').trim().toLowerCase();
    if (!n) {
        return false;
    }
    if (n === 'kebab') {
        return true;
    }
    // Plain Beer / dwarf beer — not kegs or other drinks.
    return n === 'beer' || (n.includes('beer') && !n.includes('keg'));
}

/** Strip RS color / markup so wish regexes still match. */
function stripChatMarkup(s) {
    return (s || '')
        .replace(/@[^@\s]+@/g, '')
        .replace(/<\/?col[^>]*>/gi, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function chatLineSig(line) {
    return `${line?.type ?? ''}|${line?.username ?? ''}|${line?.text ?? ''}`;
}

/**
 * Parse an incoming trade wish from a chat line / event.
 * Handles both forms used by the client:
 *   - username="Bob", text="wishes to trade with you."
 *   - text="Bob wishes to trade with you."
 */
function parseTradeWishName(line) {
    const text = stripChatMarkup(line?.text ?? '');
    if (!WISHES_TRADE_RE.test(text)) {
        return null;
    }
    const fromText = text.match(WISH_RE)?.[1]?.trim() || null;
    if (fromText) {
        return fromText;
    }
    const fromUser = stripChatMarkup(line?.username ?? '');
    return fromUser || null;
}

/** Recent chat lines from the client reader (newest first), or null if unavailable. */
function readChatLines(count = CHAT_POLL_LINES) {
    try {
        const host = welcomeHost();
        const reader = host?.reader;
        if (!reader || typeof reader.chat !== 'function') {
            return null;
        }
        const lines = reader.chat(count);
        return Array.isArray(lines) ? lines : null;
    } catch {
        return null;
    }
}

function findPlayerByName(name) {
    if (!name || typeof Players?.query !== 'function') {
        return null;
    }
    return Players.query().name(name).nearest() ?? null;
}

function flaxHeld() {
    return Inventory.items()
        .filter(i => isFlax(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

class FlaxHost extends LoopingBot {
    loopDelay = 600;

    bankStand = Tile.from(CATHERBY);
    leashRadius = 8;
    depositAfterTrade = true;
    declineNonFlax = true;

    status = 'starting';
    trades = 0;
    flaxReceived = 0;
    startedAt = Date.now();
    /** @type {string | null} */
    pendingPartner = null;
    /** Wall-clock when pendingPartner was last (re)confirmed. */
    pendingSeenAt = 0;
    /** @type {Set<string>} */
    pendingSources = new Set();
    /** Signature of newest chat line already consumed by the poller. */
    lastChatSig = null;
    nextRequestAt = 0;
    partnerWaits = 0;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        await dismissWelcomeScreen();

        this.bankStand = this.settings?.tile('bankStand', Tile.from(CATHERBY)) ?? Tile.from(CATHERBY);
        this.leashRadius = this.settings?.num('leashRadius', 8) ?? 8;
        this.depositAfterTrade = this.settings?.bool('depositAfterTrade', true) ?? true;
        this.declineNonFlax = this.settings?.bool('declineNonFlax', true) ?? true;
        this.startedAt = Date.now();
        this.pendingPartner = null;
        this.pendingSeenAt = 0;
        this.pendingSources = new Set();
        this.lastChatSig = null;
        this.partnerWaits = 0;

        // Check 1: live chat.message events.
        this.on('chat.message', e => {
            const who = parseTradeWishName(e);
            if (who) {
                this.noteTradeWish(who, 'event');
            }
        });

        // Seed poller + catch a wish that arrived just before start.
        this.pollChatForTradeWishes({ seedOnly: false });

        this.log(
            `FlaxHost at Catherby — leash ${this.leashRadius}, accepting noted ${FLAX_NAME}`
        );
        this.status = 'walking to Catherby bank';
    }

    async loop() {
        if (await dismissWelcomeScreen()) {
            return;
        }

        if (typeof Trade !== 'undefined' && Trade.active()) {
            await this.handleTrade();
            return;
        }

        // Check 2: poll client chat buffer every loop (events can miss a line).
        this.pollChatForTradeWishes();
        this.expireStaleWish();

        // Drunken Dwarf (etc.) — free inventory slots; never Eat/Drink these.
        if (await this.dropDwarfJunk()) {
            return;
        }

        if (!this.withinLeash()) {
            await this.returnToBank('outside leash — returning to Catherby bank');
            return;
        }

        if (!this.atBankStand()) {
            await this.returnToBank('walking to Catherby bank stand');
            return;
        }

        const target = this.resolveTradeTarget();
        if (target) {
            await this.requestTrade(target);
            return;
        }

        if (!this.pendingPartner) {
            this.status = 'waiting for incoming trades at Catherby bank';
        }
        await Execution.delayTicks(2);
    }

    /**
     * Record a wish from event or poll. Idempotent for the same name.
     * @param {string} who
     * @param {'event' | 'poll'} source
     */
    noteTradeWish(who, source) {
        const name = (who || '').trim();
        if (!name) {
            return;
        }
        const fresh = !namesMatch(this.pendingPartner, name);
        this.pendingPartner = name;
        this.pendingSeenAt = Date.now();
        this.pendingSources.add(source);
        if (fresh) {
            this.log(`trade request from ${name} (${source})`);
        }
    }

    /**
     * Scan reader.chat() for "wishes to trade" lines (newest first).
     * @param {{ seedOnly?: boolean }} [opts]
     */
    pollChatForTradeWishes(opts = {}) {
        const lines = readChatLines(CHAT_POLL_LINES);
        if (!lines || lines.length === 0) {
            return;
        }
        const newestSig = chatLineSig(lines[0]);
        if (opts.seedOnly) {
            this.lastChatSig = newestSig;
            return;
        }
        if (this.lastChatSig === null) {
            // First pass: note any current wish, then remember the tip.
            for (const line of lines) {
                const who = parseTradeWishName(line);
                if (who) {
                    this.noteTradeWish(who, 'poll');
                    break;
                }
            }
            this.lastChatSig = newestSig;
            return;
        }
        if (newestSig === this.lastChatSig) {
            return;
        }
        const fresh = [];
        for (const line of lines) {
            if (chatLineSig(line) === this.lastChatSig) {
                break;
            }
            fresh.push(line);
        }
        this.lastChatSig = newestSig;
        // Oldest → newest so the newest wish wins if several arrived.
        for (const line of fresh.reverse()) {
            const who = parseTradeWishName(line);
            if (who) {
                this.noteTradeWish(who, 'poll');
            }
        }
    }

    /** Drop pending if it went stale and is no longer in the chat buffer. */
    expireStaleWish() {
        if (!this.pendingPartner) {
            return;
        }
        if (Date.now() - this.pendingSeenAt <= WISH_FRESH_MS) {
            return;
        }
        if (this.wishVisibleInChat(this.pendingPartner)) {
            this.pendingSeenAt = Date.now();
            return;
        }
        this.log(`trade wish from ${this.pendingPartner} expired — clearing`);
        this.clearPendingWish();
    }

    clearPendingWish() {
        this.pendingPartner = null;
        this.pendingSeenAt = 0;
        this.pendingSources = new Set();
    }

    /** True when a matching wish line is still in the recent chat buffer. */
    wishVisibleInChat(name) {
        const lines = readChatLines(CHAT_POLL_LINES);
        if (lines === null) {
            // Reader missing — treat a fresh note as good enough for the chat check.
            return Date.now() - this.pendingSeenAt <= WISH_FRESH_MS;
        }
        for (const line of lines) {
            const who = parseTradeWishName(line);
            if (who && namesMatch(who, name)) {
                return true;
            }
        }
        // Event can beat the poller by a frame — allow a short grace only.
        return (
            namesMatch(this.pendingPartner, name) &&
            Date.now() - this.pendingSeenAt <= 5_000
        );
    }

    /**
     * Drop Beer / Kebab from Drunken Dwarf (never Eat or Drink).
     * @returns {Promise<boolean>} true if this loop dropped something
     */
    async dropDwarfJunk() {
        const item = Inventory.items().find(isDropJunk) ?? null;
        if (!item) {
            return false;
        }
        const name = item.name ?? 'junk';
        this.status = `dropping ${name}`;
        this.log(`dropping ${name}`);
        const before = Inventory.used();
        await item.interact('Drop');
        await Execution.delayUntil(() => Inventory.used() < before, 4000);
        return true;
    }

    withinLeash(tile) {
        const here = tile ?? Game.tile();
        return here !== null && this.bankStand.distanceTo(here) <= this.leashRadius;
    }

    atBankStand() {
        const here = Game.tile();
        return here !== null && this.bankStand.distanceTo(here) <= 2;
    }

    async returnToBank(reason) {
        // Never path anywhere except the bank stand — anti-lure.
        this.status = reason;
        this.log(reason);
        const opts = { radius: 1, log: m => this.log(`  ${m}`) };
        if (Traversal.pureWalk) {
            Object.assign(opts, Traversal.pureWalk);
        }
        await Traversal.walkResilient(this.bankStand, opts);
    }

    /**
     * Only answer explicit incoming wishes — never cold-trade bystanders.
     * Triple-check before returning a target:
     *   1) pending wish noted (event and/or poll)
     *   2) matching wish still visible in chat (or freshly noted if no reader)
     *   3) player in scene, within leash + trade range
     */
    resolveTradeTarget() {
        if (!this.pendingPartner) {
            return null;
        }
        const pending = this.pendingPartner;

        // Check 2 — chat buffer still shows the wish.
        const inChat = this.wishVisibleInChat(pending);
        if (!inChat) {
            if (Date.now() - this.pendingSeenAt > WISH_FRESH_MS) {
                this.log(`no chat wish for ${pending} — clearing`);
                this.clearPendingWish();
            } else {
                this.status = `re-checking chat for ${pending}'s trade wish`;
            }
            return null;
        }

        // Check 3 — player must be on-screen and in range.
        const p = findPlayerByName(pending);
        if (!p) {
            this.status = `waiting for ${pending} (not in scene)`;
            return null;
        }
        if (!this.withinLeash(p.tile())) {
            this.log(`ignoring trade wish from ${pending} (outside leash)`);
            this.clearPendingWish();
            return null;
        }
        if (p.distance() > TRADE_RANGE) {
            this.status = `waiting for ${pending} to step within trade range`;
            return null;
        }

        // pending + chat + scene all passed.
        return p.name ?? pending;
    }

    async requestTrade(name) {
        const now = Date.now();
        if (now < this.nextRequestAt) {
            this.status = `cooldown before re-request (${name})`;
            await Execution.delayTicks(1);
            return;
        }

        // Final re-check immediately before clicking Trade with.
        const inChat = this.wishVisibleInChat(name);
        const inScene = !!findPlayerByName(name);
        if (!inChat || !inScene) {
            this.status = `abort trade — ${name} no longer confirmed`;
            this.log(
                `abort Trade with ${name} — final check failed ` +
                    `(chat=${inChat} scene=${inScene})`
            );
            return;
        }

        const sources = [...this.pendingSources].join('+') || 'unknown';
        this.status = `accepting trade request with ${name}`;
        this.log(`Trade with ${name} (confirmed pending+chat+scene via ${sources})`);
        this.nextRequestAt = now + TRADE_REQUEST_MS;
        await Trade.request(name);
        await Execution.delayUntil(() => Trade.active(), TRADE_REQUEST_MS);
        if (Trade.active()) {
            this.clearPendingWish();
            this.partnerWaits = 0;
        } else {
            this.log(`trade with ${name} did not open — will retry if still pending`);
        }
    }

    async waitAndAcceptScreen(screen) {
        const onOffer = () => Trade.onOfferScreen() && !Trade.onConfirmScreen();
        const onConfirm = () => Trade.onConfirmScreen();
        const isHere = screen === 'confirm' ? onConfirm : onOffer;

        if (!Trade.active() || !isHere()) {
            return;
        }

        const waitMs = acceptDelayMs();
        const label = screen === 'confirm' ? 'confirm screen' : 'offer screen';
        this.status = `waiting on ${screen}`;
        this.log(`${label} — waiting ~${Math.round(waitMs / 1000)}s before accept`);

        const readyAt = Date.now() + waitMs;
        while (Date.now() < readyAt && Trade.active() && isHere()) {
            await Execution.delayTicks(1);
        }
        if (!Trade.active()) {
            return;
        }

        this.status = `accepting ${screen}`;
        this.log(`accepting ${label}`);
        await Trade.accept();

        if (screen === 'offer') {
            while (Trade.active() && onOffer()) {
                await Execution.delayUntil(
                    () => !Trade.active() || onConfirm() || !onOffer(),
                    ACCEPT_RETRY_MS
                );
                if (!Trade.active() || onConfirm() || !onOffer()) {
                    break;
                }
                this.log('re-accepting offer (still open)');
                await Trade.accept();
            }
            return;
        }

        this.log('confirm accepted — keeping Accept until trade closes');
        while (Trade.active()) {
            if (onConfirm() || onOffer()) {
                this.status = 'accepting until trade ends';
                await Trade.accept();
            }
            await Execution.delayTicks(1);
        }
    }

    async handleTrade() {
        while (typeof Trade !== 'undefined' && Trade.active()) {
            if (Trade.onConfirmScreen()) {
                const before = flaxHeld();
                await this.waitAndAcceptScreen('confirm');
                if (!Trade.active()) {
                    const gained = Math.max(0, flaxHeld() - before);
                    this.trades++;
                    this.flaxReceived += gained;
                    this.log(
                        `trade #${this.trades} complete — +${gained} ${FLAX_NAME} (total ${this.flaxReceived})`
                    );
                    this.clearPendingWish();
                    this.partnerWaits = 0;
                    if (this.depositAfterTrade && flaxHeld() > 0) {
                        await this.depositFlax();
                    }
                }
                return;
            }

            if (!Trade.onOfferScreen()) {
                await Execution.delayTicks(1);
                continue;
            }

            const who = Trade.partner();
            if (who === null) {
                this.partnerWaits++;
                this.status = 'reading trade partner';
                if (this.partnerWaits > 8) {
                    this.log('partner name never appeared — declining');
                    await Trade.decline();
                    this.partnerWaits = 0;
                    return;
                }
                await Execution.delayTicks(1);
                continue;
            }
            this.partnerWaits = 0;

            // Safety: never offer anything — this host only receives.
            if (Trade.myOffer().length > 0) {
                this.status = 'declining — own offer not empty';
                this.log('safety: own offer not empty — declining');
                await Trade.decline();
                return;
            }

            const their = Trade.theirOffer();
            if (this.declineNonFlax && offerHasNonFlax(their)) {
                this.status = 'declining — non-flax in offer';
                this.log(`declining ${who}: offer contains non-${FLAX_NAME} items`);
                await Trade.decline();
                return;
            }

            const noted = notedUnitsInOffer(their);
            if (noted <= 0) {
                this.status = `waiting for noted ${FLAX_NAME} from ${who}`;
                await Execution.delayTicks(1);
                continue;
            }

            this.status = `noted ${FLAX_NAME} x${noted} from ${who} — accepting`;
            this.log(`noted ${FLAX_NAME} x${noted} from ${who}`);
            await this.waitAndAcceptScreen('offer');
            await Execution.delayUntil(
                () => Trade.onConfirmScreen() || !Trade.active(),
                TRADE_OFFER_WAIT_MS
            );
        }
    }

    async depositFlax() {
        if (!this.withinLeash()) {
            this.log('skip deposit — outside leash');
            return;
        }
        this.status = 'depositing flax at Catherby bank';
        if (
            !(await Banking.open({
                stand: this.bankStand,
                nearbyRadius: this.leashRadius,
                log: m => this.log(`  ${m}`)
            }))
        ) {
            this.log('bank open failed — will retry later');
            return;
        }
        if (typeof Bank.loaded === 'function') {
            await Execution.delayUntil(() => Bank.loaded(), 3000);
        }
        const before = flaxHeld();
        if (typeof Bank.depositAllMatching === 'function') {
            await Bank.depositAllMatching(name => isFlax(name), m => this.log(`  ${m}`));
        } else if (typeof Bank.deposit === 'function') {
            await Bank.deposit(FLAX_NAME, 'Deposit-All');
        }
        await Execution.delayUntil(() => flaxHeld() < before || before === 0, 3000);
        if (typeof Bank.close === 'function') {
            await Bank.close();
        }
        this.log(`deposited ${FLAX_NAME}`);
    }

    onPaint(ctx) {
        const secs = Math.floor((Date.now() - this.startedAt) / 1000);
        const lines = [
            SCRIPT_NAME,
            this.status,
            `trades ${this.trades}  flax +${this.flaxReceived}  t=${secs}s`,
            `leash ${this.leashRadius} @ ${this.bankStand.x},${this.bankStand.z}`
        ];
        ctx.font = '12px monospace';
        const pad = 6;
        const lineH = 16;
        const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, 6, maxW + pad * 2, pad * 2 + lines.length * lineH);
        ctx.fillStyle = '#c8e6c9';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Money making',
    tags: ['flax', 'trade', 'mule', 'catherby', 'host'],
    description:
        'Stand at Catherby bank and accept incoming noted-flax trades. Leashed anti-lure — never leaves the bank vicinity.',
    settingsSchema: {
        bankStand: {
            type: 'tile',
            default: CATHERBY,
            label: 'Catherby bank stand',
            help: 'Stand tile to walk to and leash around (default: Catherby bank)'
        },
        leashRadius: {
            type: 'number',
            default: 8,
            min: 3,
            max: 20,
            label: 'Leash radius',
            help: 'Never walk outside this Chebyshev distance from the bank stand (anti-lure)'
        },
        depositAfterTrade: {
            type: 'boolean',
            default: true,
            label: 'Deposit after trade',
            help: 'Open the nearby bank booth and deposit received flax after each completed trade'
        },
        declineNonFlax: {
            type: 'boolean',
            default: true,
            label: 'Decline non-flax offers',
            help: 'Decline if their offer contains anything other than Flax'
        }
    },
    create: () => new FlaxHost()
});
