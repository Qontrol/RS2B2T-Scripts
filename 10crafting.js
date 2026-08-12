/**
 * 10crafting — craft soft leather with needle + thread until Crafting 10.
 * Products: Leather gloves @1 → Leather boots @7 → Leather cowl @9.
 * Banks products and restocks leather/thread/needle from the nearest bank.
 * Completely vibe coded by @.benzyme on Discord via Cursor AI
 * Self-contained ESM for rs2b0t Load local script / Load URL.
 */
const SUPPORTED_API_VERSION = 1;
const abi = globalThis.__rs2b0t;
if (!abi) {
    throw new Error('10crafting: globalThis.__rs2b0t missing — load inside rs2b0t bot.html');
}
if (abi.apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error(
        `10crafting: ABI ${abi.apiVersion} != supported ${SUPPORTED_API_VERSION}`
    );
}

const {
    defineBot,
    Execution,
    Game,
    LoopingBot,
    Inventory,
    Bank,
    Banking,
    Skills,
    ChatDialog,
    withdrawOp
} = abi;

const SCRIPT_NAME = '10crafting';

/** Stop when Crafting reaches this level. */
const TARGET_CRAFTING = 10;

/** Soft-leather product thresholds (OSRS / RS2). */
const BOOTS_LEVEL = 7;
const COWL_LEVEL = 9;

/** Right-click Make 10 on the craft-leather menu (not Make-X amount entry). */
const MAKE_COUNT = 10;

/**
 * Soft-leather make-menu options (short labels from "What would you like to make?").
 * Ordered highest level first so we pick the best available.
 */
const LEATHER_OPTIONS = [
    { id: 'coif', level: 38, menuMatch: 'coif', label: 'Coif' },
    { id: 'chaps', level: 18, menuMatch: 'chap', label: 'Chaps' },
    { id: 'armour', level: 14, menuMatch: 'armour', label: 'Armour', alts: ['body'] },
    { id: 'vambraces', level: 11, menuMatch: 'vambrace', label: 'Vambraces' },
    { id: 'cowl', level: COWL_LEVEL, menuMatch: 'cowl', label: 'Cowl' },
    { id: 'boots', level: BOOTS_LEVEL, menuMatch: 'boot', label: 'Boots' },
    { id: 'gloves', level: 1, menuMatch: 'glove', label: 'Gloves' }
];

const NEEDLE_NAME = 'Needle';
const THREAD_NAME = 'Thread';

/** Keep at least this many thread in inventory when restocking. */
const THREAD_KEEP = 20;

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

function nameEq(a, b) {
    return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

/** Soft leather only — not gloves/boots/cowl/etc. */
function isSoftLeather(name) {
    const n = (name ?? '').toLowerCase().trim();
    return n === 'leather' || n === 'soft leather';
}

function isNeedle(name) {
    return (name ?? '').toLowerCase().trim() === 'needle';
}

function isThread(name) {
    return (name ?? '').toLowerCase().trim() === 'thread';
}

function isKeepTool(name) {
    return isNeedle(name) || isThread(name);
}

/** Crafted leather armour we deposit. */
function isCraftedProduct(name) {
    const n = (name ?? '').toLowerCase();
    if (!n) {
        return false;
    }
    if (isSoftLeather(n)) {
        return false;
    }
    return (
        n.includes('leather glove') ||
        n.includes('leather boot') ||
        n.includes('leather cowl') ||
        n.includes('leather vambrace') ||
        n === 'leather body' ||
        n.includes('leather chap') ||
        n === 'coif'
    );
}

/** Best soft-leather product for the current Crafting level (≤ target). */
function craftPlan(level) {
    if (level < BOOTS_LEVEL) {
        return LEATHER_OPTIONS.find(o => o.id === 'gloves');
    }
    if (level < COWL_LEVEL) {
        return LEATHER_OPTIONS.find(o => o.id === 'boots');
    }
    return LEATHER_OPTIONS.find(o => o.id === 'cowl');
}

/**
 * Highest-level leather option the player can make, matched against make-menu products.
 * Prefers UI short names (Gloves / Boots / Cowl / …).
 */
function bestAvailablePlan(level, products) {
    const list = (products ?? [])
        .map(p => String(p ?? '').trim())
        .filter(p => p && !/not\s*available/i.test(p));

    // Only gloves → boots → cowl while training to 10.
    const training = LEATHER_OPTIONS.filter(
        o => o.id === 'gloves' || o.id === 'boots' || o.id === 'cowl'
    );

    for (const opt of training) {
        if (opt.level > level) {
            continue;
        }
        const match = matchMakeProduct(list.length ? list : products, opt);
        if (match) {
            return { ...opt, menuName: match };
        }
    }

    const plan = craftPlan(level);
    return { ...plan, menuName: plan.label };
}

function matchMakeProduct(products, opt) {
    const needles = [opt.menuMatch, opt.label, ...(opt.alts ?? [])].map(s =>
        String(s).toLowerCase()
    );
    return (
        products.find(p => {
            const n = (p ?? '').toLowerCase();
            if (!n || /not\s*available/i.test(n)) {
                return false;
            }
            return needles.some(want => n === want || n.includes(want));
        }) ?? null
    );
}

function invCountMatching(pred) {
    return Inventory.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function leatherCount() {
    return invCountMatching(isSoftLeather);
}

function productCount() {
    return invCountMatching(isCraftedProduct);
}

function needleCount() {
    return invCountMatching(isNeedle);
}

function threadCount() {
    return invCountMatching(isThread);
}

function hasNeedle() {
    return needleCount() > 0;
}

function hasThread() {
    return threadCount() > 0;
}

function needleItem() {
    return Inventory.items().find(i => isNeedle(i.name)) ?? null;
}

function lastLeather() {
    const items = Inventory.items();
    for (let i = items.length - 1; i >= 0; i--) {
        if (isSoftLeather(items[i].name)) {
            return items[i];
        }
    }
    return null;
}

function canCraftNow() {
    return hasNeedle() && hasThread() && leatherCount() > 0;
}

function needsBankTrip() {
    if (canCraftNow()) {
        return false;
    }
    if (productCount() > 0) {
        return true;
    }
    if (!hasNeedle() || !hasThread() || leatherCount() === 0) {
        return true;
    }
    return false;
}

function bankItemCount(pred) {
    if (typeof Bank.items !== 'function') {
        return 0;
    }
    return Bank.items()
        .filter(i => pred(i.name))
        .reduce((n, i) => n + Math.max(1, i.count), 0);
}

function bankFindItem(pred) {
    if (typeof Bank.items !== 'function') {
        return null;
    }
    return Bank.items().find(i => pred(i.name)) ?? null;
}

function bankFindName(pred) {
    return bankFindItem(pred)?.name ?? null;
}

async function waitBankLoaded() {
    if (typeof Bank.loaded === 'function') {
        await Execution.delayUntil(() => Bank.loaded() || Bank.items().length > 0, 3000);
    }
    await Execution.delayTicks(1);
}

/**
 * Withdraw one stack item from an open bank.
 * Tries withdrawX, then Bank.withdraw with Withdraw-1 / Withdraw-All.
 * @returns {Promise<boolean>}
 */
async function withdrawFromOpenBank(name, qty, bankItem) {
    if (!name || qty <= 0 || !Bank.isOpen()) {
        return false;
    }

    if (typeof Bank.withdrawX === 'function') {
        if (await Bank.withdrawX(name, qty)) {
            return true;
        }
    }

    if (typeof Bank.withdraw === 'function') {
        const wantAll = qty >= 5 || (bankItem && Math.max(1, bankItem.count) <= qty);
        const hint = wantAll ? 'all' : '1';
        const op =
            (typeof withdrawOp === 'function' && bankItem?.ops
                ? withdrawOp(bankItem.ops, hint)
                : null) ?? (wantAll ? 'Withdraw-All' : 'Withdraw-1');
        if (await Bank.withdraw(name, op)) {
            return true;
        }
        if (await Bank.withdraw(name)) {
            return true;
        }
    }

    return false;
}

class TenCrafting extends LoopingBot {
    status = 'starting';
    startedAt = 0;
    craftXpAtStart = 0;
    crafted = 0;
    bankTrips = 0;
    planId = 'gloves';
    done = false;

    async onStart() {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        if (typeof Banking?.preload === 'function') {
            Banking.preload();
        }

        this.startedAt = Date.now();
        this.craftXpAtStart = Skills.xp('crafting');
        this.crafted = 0;
        this.bankTrips = 0;
        this.done = false;
        this.planId = craftPlan(Skills.level('crafting')).id;

        this.on('skill.level', e => {
            if (e.name === 'crafting') {
                const plan = craftPlan(e.level);
                this.planId = plan.id;
                this.log(
                    `crafting ${e.previous} → ${e.level}` +
                        (e.level >= TARGET_CRAFTING
                            ? ` — target ${TARGET_CRAFTING} reached`
                            : ` — now making ${plan.label}`)
                );
            }
        });

        const lvl = Skills.level('crafting');
        const plan = craftPlan(lvl);
        this.log(
            `10crafting — Crafting ${lvl} → target ${TARGET_CRAFTING}; ` +
                `making ${plan.label} (needle + thread + leather)`
        );

        if (lvl >= TARGET_CRAFTING) {
            this.finishDone(`already Crafting ${lvl} ≥ ${TARGET_CRAFTING} — nothing to do`);
            return;
        }

        this.status = 'ready';
    }

    finishDone(reason) {
        this.done = true;
        this.status = 'done';
        this.log(reason);
        stopScript();
    }

    async loop() {
        if (!Game.ingame()) {
            await Execution.delayTicks(5);
            return;
        }
        if (this.done) {
            await Execution.delayTicks(5);
            return;
        }
        if (await dismissWelcomeScreen()) {
            this.status = 'close welcome';
            return;
        }

        if (Skills.level('crafting') >= TARGET_CRAFTING) {
            this.finishDone(
                `done — Crafting ${Skills.level('crafting')} ≥ ${TARGET_CRAFTING} ` +
                    `(~${this.crafted} crafted)`
            );
            return;
        }

        if (ChatDialog.canContinue()) {
            this.status = 'continue dialog';
            await ChatDialog.continue();
            return;
        }

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(craftPlan(Skills.level('crafting')));
            return;
        }

        const plan = craftPlan(Skills.level('crafting'));
        this.planId = plan.id;

        if (canCraftNow()) {
            // Already mid-craft animation with leather left — wait it out.
            if (Game.animating() && productCount() > 0) {
                this.status = `crafting ${plan.label}`;
                await Execution.delayTicks(1);
                return;
            }
            await this.craftLeather(plan);
            return;
        }

        if (needsBankTrip()) {
            await this.bankCycle();
            return;
        }

        this.status = 'idle';
        await Execution.delayTicks(2);
    }

    async craftLeather(plan) {
        if (!canCraftNow()) {
            return;
        }

        const needle = needleItem();
        const leather = lastLeather();
        if (!needle || !leather) {
            return;
        }

        const before = leatherCount();
        const beforeXp = Skills.xp('crafting');
        this.status = `crafting ${plan.label}`;
        this.log(
            `needle → leather (${before} left) for ${plan.label} ` +
                `(craft ${Skills.level('crafting')})`
        );

        if (!(await needle.useOn(leather))) {
            await Execution.delayTicks(2);
            return;
        }

        const opened = await Execution.delayUntil(
            () =>
                ChatDialog.isMakeMenu() ||
                leatherCount() < before ||
                Skills.xp('crafting') > beforeXp ||
                ChatDialog.canContinue() ||
                Game.animating(),
            8000
        );

        if (ChatDialog.isMakeMenu()) {
            await this.chooseMakeProduct(plan);
            return;
        }

        if (!opened && leatherCount() >= before) {
            this.log('craft useOn did not start — retrying');
        }
    }

    async chooseMakeProduct(_plan) {
        const products = typeof ChatDialog.makeProducts === 'function' ? ChatDialog.makeProducts() : [];
        const level = Skills.level('crafting');
        const plan = bestAvailablePlan(level, products);
        this.planId = plan.id;

        const menuName = plan.menuName || plan.label;
        if (!menuName) {
            this.log(
                `make menu: no usable product (have: [${(products ?? []).join(', ')}]) — closing`
            );
            await this.closeMakeMenu();
            return;
        }

        const startLeather = leatherCount();
        const startProducts = productCount();
        this.status = `Make 10 ${plan.label}`;
        this.log(
            `make menu: [${(products ?? []).join(', ')}] → right-click '${menuName}' Make ${MAKE_COUNT} ` +
                `(craft ${level}, leather ${startLeather})`
        );

        let picked = false;

        // Prefer Make 10 via makeX (maps to right-click Make 10 on this interface).
        if (typeof ChatDialog.makeX === 'function') {
            picked = await ChatDialog.makeX(menuName, MAKE_COUNT);
        }

        // Fallbacks if makeX missed the right-click option.
        if (!picked && typeof ChatDialog.make === 'function') {
            picked = await ChatDialog.make(menuName);
        }
        if (!picked && typeof ChatDialog.make === 'function') {
            picked = await ChatDialog.make(plan.label);
        }
        if (!picked && typeof ChatDialog.makeX === 'function') {
            // Last resort: try Make 5 then Make 1 equivalents.
            picked = await ChatDialog.makeX(menuName, 5);
        }
        if (!picked && typeof ChatDialog.makeX === 'function') {
            picked = await ChatDialog.makeX(menuName, 1);
        }

        if (!picked) {
            this.log(`could not pick '${menuName}' Make ${MAKE_COUNT} — closing menu`);
            await this.closeMakeMenu();
            return;
        }

        await Execution.delayUntil(
            () =>
                !ChatDialog.isMakeMenu() &&
                (Game.animating() ||
                    leatherCount() < startLeather ||
                    productCount() > startProducts ||
                    ChatDialog.canContinue()),
            5000
        );

        let mark = leatherCount();
        let idle = 0;
        for (let guard = 0; guard < 400 && leatherCount() > 0; guard++) {
            if (Skills.level('crafting') >= TARGET_CRAFTING) {
                return;
            }
            if (ChatDialog.canContinue()) {
                return;
            }
            if (ChatDialog.isMakeMenu()) {
                // Batch of 10 finished (or interrupted) — loop will re-open / re-pick.
                return;
            }
            await Execution.delayTicks(1);
            const now = leatherCount();
            if (now < mark) {
                this.crafted += mark - now;
                mark = now;
                idle = 0;
            } else if (!Game.animating() && ++idle >= 12) {
                return;
            } else if (Game.animating()) {
                idle = 0;
            }
        }
    }

    async closeMakeMenu() {
        const host = welcomeHost();
        const { reader, actions } = host ?? {};
        if (typeof actions?.closeModal === 'function' && actions.closeModal()) {
            await Execution.delayTicks(1);
            return;
        }
        if (reader && typeof actions?.closeMainModal === 'function') {
            const main = typeof reader.modals === 'function' ? reader.modals().main : -1;
            if (main !== -1) {
                actions.closeMainModal(main);
                await Execution.delayTicks(1);
                return;
            }
        }
        await Execution.delayTicks(2);
    }

    /**
     * Deposit crafted goods, then always restock Needle + Thread from bank,
     * then fill remaining slots with soft leather.
     */
    async bankCycle() {
        this.status = 'banking';
        this.log(
            `banking` +
                (productCount() ? ` ${productCount()} products` : '') +
                (leatherCount() ? ` ${leatherCount()} leather` : '') +
                ` (needle ${needleCount()}, thread ${threadCount()})`
        );

        if (!Bank.isOpen()) {
            if (!(await Banking.open({ log: m => this.log(`  ${m}`) }))) {
                this.log('could not open bank — retrying');
                await Execution.delayTicks(3);
                return;
            }
        }

        await waitBankLoaded();

        // Deposit everything except needle + thread.
        this.log('depositing products / leftovers (keep needle + thread)');
        await Bank.depositAllMatching(name => {
            if (isKeepTool(name)) {
                return false;
            }
            return !!name;
        });
        await Execution.delayTicks(1);
        await waitBankLoaded();

        this.bankTrips++;

        // Always pull Needle + Thread from the bank ourselves.
        if (!(await this.ensureNeedleFromBank())) {
            return;
        }
        if (!(await this.ensureThreadFromBank())) {
            return;
        }

        // Soft leather — fill free slots after tools are in.
        if (!(await this.ensureLeatherFromBank())) {
            return;
        }

        await Bank.close();

        if (!canCraftNow()) {
            if (!hasNeedle()) {
                this.finishDone('stopped — still no Needle after bank');
                return;
            }
            if (!hasThread()) {
                this.finishDone('stopped — still no Thread after bank');
                return;
            }
            if (leatherCount() === 0) {
                this.finishDone('stopped — still no Leather after bank');
                return;
            }
        }

        this.status = 'crafting';
        this.log(
            `restocked — leather ${leatherCount()}, needle ${needleCount()}, thread ${threadCount()}`
        );
    }

    /**
     * @returns {Promise<boolean>} false if we stopped the script
     */
    async ensureNeedleFromBank() {
        if (hasNeedle()) {
            this.log(`already have Needle ×${needleCount()}`);
            return true;
        }

        const bankItem = bankFindItem(isNeedle);
        const name = bankItem?.name ?? NEEDLE_NAME;
        const inBank =
            (bankItem ? Math.max(1, bankItem.count) : 0) ||
            (typeof Bank.count === 'function' ? Bank.count(name) || 0 : 0) ||
            bankItemCount(isNeedle);

        if (inBank <= 0) {
            await Bank.close();
            this.finishDone('stopped — no Needle in inventory or bank');
            return false;
        }

        this.log(`withdrawing Needle from bank (bank has ${inBank})`);
        const before = needleCount();
        const ok = await withdrawFromOpenBank(name, 1, bankItem);
        await Execution.delayUntil(() => needleCount() > before || !Bank.isOpen(), 4000);
        await Execution.delayTicks(1);

        if (!hasNeedle()) {
            this.log(`Needle withdraw ${ok ? 'clicked but' : 'failed —'} still missing`);
            await Bank.close();
            this.finishDone('stopped — could not withdraw Needle from bank');
            return false;
        }

        this.log(`got Needle ×${needleCount()}`);
        return true;
    }

    /**
     * @returns {Promise<boolean>} false if we stopped the script
     */
    async ensureThreadFromBank() {
        if (threadCount() >= THREAD_KEEP) {
            this.log(`already have Thread ×${threadCount()}`);
            return true;
        }

        const bankItem = bankFindItem(isThread);
        const name = bankItem?.name ?? THREAD_NAME;
        const inBank =
            (bankItem ? Math.max(1, bankItem.count) : 0) ||
            (typeof Bank.count === 'function' ? Bank.count(name) || 0 : 0) ||
            bankItemCount(isThread);

        if (inBank <= 0) {
            if (hasThread()) {
                this.log(`Thread low (${threadCount()}) but bank empty — crafting with what we have`);
                return true;
            }
            await Bank.close();
            this.finishDone('stopped — no Thread in inventory or bank');
            return false;
        }

        const need = Math.max(1, THREAD_KEEP - threadCount());
        const take = Math.min(need, inBank);
        this.log(`withdrawing ${take}× Thread from bank (bank has ${inBank})`);
        const before = threadCount();
        const ok = await withdrawFromOpenBank(name, take, bankItem);
        await Execution.delayUntil(() => threadCount() > before || !Bank.isOpen(), 4000);
        await Execution.delayTicks(1);

        if (!hasThread()) {
            this.log(`Thread withdraw ${ok ? 'clicked but' : 'failed —'} still missing`);
            await Bank.close();
            this.finishDone('stopped — could not withdraw Thread from bank');
            return false;
        }

        this.log(`got Thread ×${threadCount()}`);
        return true;
    }

    /**
     * @returns {Promise<boolean>} false if we stopped the script
     */
    async ensureLeatherFromBank() {
        const free =
            typeof Inventory.free === 'function'
                ? Inventory.free()
                : Math.max(0, 28 - Inventory.used());

        if (free <= 0) {
            if (leatherCount() > 0) {
                return true;
            }
            await Bank.close();
            this.finishDone('stopped — inventory full with no soft Leather');
            return false;
        }

        const bankItem = bankFindItem(isSoftLeather);
        if (!bankItem) {
            await Bank.close();
            if (canCraftNow()) {
                this.status = 'crafting';
                return true;
            }
            this.finishDone('stopped — no soft Leather left in bank');
            return false;
        }

        const name = bankItem.name;
        const inBank =
            Math.max(1, bankItem.count) ||
            (typeof Bank.count === 'function' ? Bank.count(name) || 0 : 0) ||
            bankItemCount(isSoftLeather);

        if (inBank <= 0) {
            await Bank.close();
            if (canCraftNow()) {
                this.status = 'crafting';
                return true;
            }
            this.finishDone('stopped — no soft Leather left in bank');
            return false;
        }

        const take = Math.min(free, inBank);
        this.log(`withdrawing ${take}× ${name} from bank`);
        const before = leatherCount();
        const ok = await withdrawFromOpenBank(name, take, bankItem);
        await Execution.delayUntil(() => leatherCount() > before || !Bank.isOpen(), 5000);
        await Execution.delayTicks(1);

        if (leatherCount() <= before) {
            this.log(`Leather withdraw ${ok ? 'clicked but' : 'failed —'} count unchanged`);
            await Bank.close();
            if (!canCraftNow()) {
                this.finishDone(`stopped — could not withdraw ${name}`);
                return false;
            }
        }

        return true;
    }

    onStop() {
        this.log(
            `stopped — crafted ~${this.crafted}, bank trips ${this.bankTrips} ` +
                `(Crafting ${Skills.level('crafting')}, ${this.status})`
        );
    }

    onPaint(ctx) {
        const plan = craftPlan(Skills.level('crafting'));
        const elapsed = Date.now() - this.startedAt;
        const hrs = elapsed / 3_600_000;
        const craftXp = Skills.xp('crafting') - this.craftXpAtStart;
        const craftXph = hrs > 0.008 ? craftXp / hrs : 0;
        const craftedPh = hrs > 0.008 ? this.crafted / hrs : 0;

        const lines = [
            `10crafting  Craft ${Skills.level('crafting')}/${TARGET_CRAFTING}`,
            `time ${fmtElapsed(elapsed)}  ·  ${plan.label}  ·  ${this.status}`,
            `crafted ${this.crafted} (${fmtXph(craftedPh)}/hr)  trips ${this.bankTrips}`,
            `leather ${leatherCount()}  needle ${needleCount()}  thread ${threadCount()}  XP ${fmtXph(craftXph)}/hr`
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
        ctx.fillStyle = '#c4a35a';
        lines.forEach((line, i) => {
            ctx.fillText(line, 6 + pad, 6 + pad + (i + 1) * lineH - 4);
        });
    }
}

export default defineBot({
    name: SCRIPT_NAME,
    version: '1.0.0',
    category: 'Crafting',
    tags: ['crafting', 'leather', 'needle', 'thread', 'gloves', 'boots', 'cowl', 'bank'],
    description:
        '10crafting — withdraws Needle + Thread + Leather from bank. Right-clicks highest available (Gloves/Boots/Cowl) → Make 10 until Crafting 10.',
    create: () => new TenCrafting()
});
