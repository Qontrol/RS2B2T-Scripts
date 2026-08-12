/**
 * CatherbyFlaxMule — stand at Catherby bank, accept incoming trades of noted Flax.
 * Walks to the bank, listens for "wishes to trade", opens the trade, waits for
 * noted Flax + the offerer's Accept, then Accepts both trade screens. Loops.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('CatherbyFlaxMule: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `CatherbyFlaxMule: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Players,
    Inventory,
    Traversal,
    Tile,
    ChatDialog,
    Trade
} = abi;

if (!Trade || typeof Trade.active !== 'function') {
    throw new Error('CatherbyFlaxMule: Trade API missing from __rs2b0t');
}

const SCRIPT_NAME = 'CatherbyFlaxMule';

/** Post-login welcome modal interface id (Close Window top-right). */
const WELCOME_SCREEN_ID = 5993;

/** Catherby bank stand. */
const BANK_STAND = new Tile(2809, 3441, 0);
const BANK_RADIUS = 3;

const FLAX_NAME = 'Flax';

/** Min delay between Trade.request attempts (game ticks). */
const TRADE_REQUEST_COOLDOWN_TICKS = 9;

/** Wall-clock waits for multiplayer trade UI. */
const TRADE_OFFER_WAIT_MS = 5_000;
const TRADE_CONFIRM_WAIT_MS = 8_000;

const WISHES_TRADE_RE = /wishes to trade with you/i;

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

function distToBank(tile) {
    if (!tile) {
        return Infinity;
    }
    return Tile.from(tile).distanceTo(BANK_STAND);
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

/**
 * Bank-note Flax: certtemplate when available; else stack count > 1
 * (unnoted flax never stacks).
 */
function isNotedFlax(item) {
    if (!item?.name || item.name.toLowerCase() !== FLAX_NAME.toLowerCase()) {
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

function notedFlaxUnitsInOffer(items) {
    return (items ?? [])
        .filter(isNotedFlax)
        .reduce((s, o) => s + Math.max(1, o.count), 0);
}

function flaxHeld() {
    return Inventory.items()
        .filter(i => (i.name ?? '').toLowerCase() === FLAX_NAME.toLowerCase())
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

/** Parse "Name wishes to trade with you" / use event username. */
function parseTradeWishName(e) {
    const fromUser = (e?.username ?? '').trim();
    if (fromUser) {
        return fromUser;
    }
    const text = (e?.text ?? '').trim();
    const m = text.match(/^(.+?)\s+wishes to trade with you\.?$/i);
    return m ? m[1].trim() : null;
}

function looksLikePartnerAccepted(text) {
    if (!text || typeof text !== 'string') {
        return false;
    }
    if (/waiting for other player/i.test(text)) {
        return false;
    }
    return (
        /other player has accepted/i.test(text) ||
        /other player has accepted\./i.test(text) ||
        (/accepted/i.test(text) && /other player/i.test(text))
    );
}

/** True when offer-screen status says the other player has accepted. */
function partnerHasAcceptedOffer() {
    const host = welcomeHost();
    const reader = host?.reader;
    const blobs = [];

    if (reader && typeof reader.mainModalTexts === 'function') {
        blobs.push(...(reader.mainModalTexts() ?? []));
    }

    // Scan common trademain status / confirm labels.
    const scanIds = [3431, 3432, 3417, 3421, 3423, 3424, 3535, 3536, 3537, 3538, 3546];
    if (reader && typeof reader.componentText === 'function') {
        for (const id of scanIds) {
            try {
                const t = reader.componentText(id);
                if (t) {
                    blobs.push(t);
                }
            } catch {
                /* ignore */
            }
        }
    }

    try {
        const IfType = globalThis.IfType ?? globalThis.__client?.IfType ?? null;
        const list = IfType?.list;
        if (list) {
            for (const id of scanIds) {
                const t = list[id]?.text;
                if (t) {
                    blobs.push(t);
                }
            }
            // Wider sweep: any visible trade-ish status line.
            const len = typeof list.length === 'number' ? list.length : 4000;
            for (let id = 3400; id < Math.min(3600, len); id++) {
                const t = list[id]?.text;
                if (t && /accept/i.test(t)) {
                    blobs.push(t);
                }
            }
        }
    } catch {
        /* ignore */
    }

    return blobs.some(looksLikePartnerAccepted);
}

class CatherbyFlaxMule extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    trades = 0;
    flaxReceived = 0;
    /** @type {string | null} */
    pendingFrom = null;
    /** Earliest Game.tick() we may Trade.request again. */
    nextRequestTick = 0;
    /** Consecutive offer-screen beats waiting on partner header. */
    partnerWait = 0;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        Traversal.preload();

        this.startedAt = Date.now();
        this.trades = 0;
        this.flaxReceived = 0;
        this.pendingFrom = null;
        this.nextRequestTick = 0;
        this.partnerWait = 0;

        this.on('chat.message', e => {
            if (!WISHES_TRADE_RE.test(e?.text ?? '')) {
                return;
            }
            const who = parseTradeWishName(e);
            if (!who) {
                return;
            }
            this.pendingFrom = who;
            this.log(`incoming trade from ${who}`);
        });

        this.log(
            `Benzyme's Catherby Flax Mule @ ${BANK_STAND.x},${BANK_STAND.z} — ` +
                `accept noted Flax after partner Accepts, both screens`
        );
        this.status = 'walk to bank';
    }

    onStop() {
        this.log(
            `stopped — trades ${this.trades}, flax ~${this.flaxReceived} (${this.status})`
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

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        // Own the trade loop while the modal is open (movement cancels it).
        if (Trade.active()) {
            await this.handleActiveTrade();
            return;
        }

        this.partnerWait = 0;

        const here = Game.tile();
        if (!here) {
            await Execution.delayTicks(2);
            return;
        }

        if (distToBank(here) > BANK_RADIUS) {
            this.status = 'walk to bank';
            this.log(`walking to Catherby bank @ ${BANK_STAND.x},${BANK_STAND.z}`);
            await Traversal.walkResilient(BANK_STAND, {
                radius: BANK_RADIUS,
                timeoutMs: 180_000,
                log: m => this.log(`  ${m}`)
            });
            return;
        }

        if (this.pendingFrom) {
            await this.answerTradeRequest(this.pendingFrom);
            return;
        }

        this.status = 'listening for trades';
        await Execution.delayTicks(2);
    }

    canRequestTrade() {
        const tick = typeof Game.tick === 'function' ? Game.tick() : 0;
        return tick >= this.nextRequestTick;
    }

    noteTradeRequest() {
        const tick = typeof Game.tick === 'function' ? Game.tick() : 0;
        this.nextRequestTick = tick + TRADE_REQUEST_COOLDOWN_TICKS;
    }

    async answerTradeRequest(name) {
        if (!this.canRequestTrade()) {
            this.status = `cooldown — ${name}`;
            await Execution.delayTicks(1);
            return;
        }

        const near =
            typeof Players?.query === 'function'
                ? Players.query().name(name).nearest()
                : null;
        if (!near) {
            this.status = `waiting for ${name}`;
            this.log(`${name} not in scene — still listening`);
            await Execution.delayTicks(2);
            return;
        }

        this.status = `opening trade with ${name}`;
        this.log(`Trade with ${name}`);
        this.noteTradeRequest();
        await Trade.request(name);
        await Execution.delayUntil(() => Trade.active(), 5_000);

        if (!Trade.active()) {
            // Keep pending so we retry after cooldown; clear if they never show.
            this.log(`trade with ${name} did not open — will retry if they re-request`);
        } else {
            this.pendingFrom = null;
        }
    }

    async handleActiveTrade() {
        if (Trade.onConfirmScreen()) {
            this.status = 'confirming trade';
            const before = flaxHeld();
            await Trade.accept();
            await Execution.delayUntil(() => !Trade.active(), TRADE_CONFIRM_WAIT_MS);
            if (!Trade.active()) {
                const gained = Math.max(0, flaxHeld() - before);
                this.trades++;
                this.flaxReceived += gained;
                this.pendingFrom = null;
                this.partnerWait = 0;
                this.log(
                    `trade complete` +
                        (gained > 0 ? ` (+${gained} flax)` : '') +
                        ` — total trades ${this.trades}`
                );
                this.status = 'listening for trades';
            } else {
                this.log('confirm still open — partner may not have accepted yet');
            }
            return;
        }

        if (!Trade.onOfferScreen()) {
            await Execution.delayTicks(1);
            return;
        }

        const who = Trade.partner();
        if (who === null) {
            this.partnerWait++;
            this.status = 'reading partner';
            if (this.partnerWait > 12) {
                this.log('trade partner name never appeared — declining');
                await Trade.decline();
                this.partnerWait = 0;
                this.pendingFrom = null;
            }
            await Execution.delayTicks(1);
            return;
        }
        this.partnerWait = 0;

        if (Trade.myOffer().length > 0) {
            this.status = 'declining — own offer not empty';
            this.log('safety: own offer not empty — declining');
            await Trade.decline();
            this.pendingFrom = null;
            return;
        }

        const theirFlax = notedFlaxUnitsInOffer(Trade.theirOffer());
        if (theirFlax <= 0) {
            this.status = `waiting for noted Flax (${who})`;
            await Execution.delayTicks(1);
            return;
        }

        if (!partnerHasAcceptedOffer()) {
            this.status = `waiting for ${who} to Accept (${theirFlax} flax)`;
            await Execution.delayTicks(1);
            return;
        }

        this.status = `accepting ${theirFlax} noted Flax from ${who}`;
        this.log(`Accept offer — ${theirFlax} noted Flax from ${who}`);
        await Trade.accept();
        await Execution.delayUntil(
            () => Trade.onConfirmScreen() || !Trade.active(),
            TRADE_OFFER_WAIT_MS
        );
    }

    onPaint(ctx) {
        const elapsed = Date.now() - this.startedAt;
        const pending = this.pendingFrom ? ` · pending ${this.pendingFrom}` : '';
        const lines = [
            `Benzyme's Catherby Flax Mule`,
            `time ${fmtElapsed(elapsed)}  ·  ${this.status}`,
            `trades ${this.trades}  ·  flax ~${this.flaxReceived}  ·  held ${flaxHeld()}`,
            `bank ${BANK_STAND.x},${BANK_STAND.z}${pending}`
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
        ctx.fillStyle = '#9be05b';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Utility',
    tags: ['trade', 'mule', 'flax', 'catherby', 'bank', 'noted'],
    description:
        "Benzyme's Catherby Flax Mule — walks to Catherby bank, accepts incoming trades of noted Flax after the offerer Accepts, confirms both screens, then keeps listening",
    create: () => new CatherbyFlaxMule()
});
