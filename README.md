
<p align="center">
  <a href="https://rs2b2t.com/discord" rel="noopener noreferrer" target="_blank">
    <img width="600" alt="rs2b2t-discord-banner" src="https://i.imgur.com/tAEkgGQ.png" />
  </a>
</p>


<p align="center">Scripts designed for use on the <a href="https://rs2b2t.com/">https://rs2b2t.com/</a> server.</p>

1. Load the bot client via url: https://w1.rs2b2t.com/rs2b0t/ (Make an account via https://rs2b2t.com/register if you haven't already)
2. Log into your account
3. Click browse up the top right of the client
4. Download a script and locate/run it off your PC

Most scripts dismiss the welcome screen on start.

## Scripts

### Woodcutting / Fletching

**`FaladorTreeFletcher.js`**  
Chops regular trees west of Falador, then fletches by level: arrow shafts → shortbows at 5 → longbows at 10. Banks products and returns.

**`OakTreeFletcher.js`**  
Chops oaks north of Varrock. Banks oak logs until Fletching 20, then oak shortbows at 20 and oak longbows at 25. Banks and repeats.

**`OakTreeFletcherSell.js`**  
Same oak chop/fletch loop, but sells the bows at Varrock General Store, banks the coins (keeps knife/axe), then goes back to the oaks.

**`WillowTreeFletcher.js`**  
Chops willows at Draynor. Banks willow logs until Fletching 35, then willow shortbows at 35 and willow longbows at 40.

**`MapleTreeFletcher.js`**  
Chops maples near Seers’ Village. Banks maple logs until Fletching 50, then maple shortbows at 50 and maple longbows at 55. Stops if there is no knife.

**`YewFletcher.js`**  
Chops yews between Catherby and Seers. Banks yew logs until Fletching 65, then yew shortbows at 65 and yew longbows at 70. Optional: sell bows to Arhein, bank GP, return. Stops if there is no knife.

**`ProgressiveWcFletcher.js`**  
Starter woodcutting/fletching pipeline: Falador trees until WC 15 / Fletching 20 → oaks (sell bows in Varrock) until WC 30 / Fletching 35 → Draynor willows (bank bows). Wields a steel axe when Attack allows.

### Fishing / Cooking

**`CatherbyNetFisher.js`**  
Small-net shrimp at Catherby Net+Bait spots. On start it banks everything and withdraws only a small fishing net. Optional cook on the bank-house range before depositing.

**`CatherbyBaitFisher.js`**  
Bait-rods sardines/herring at Catherby Net+Bait spots. Pulls rod + bait from the bank; buys a rod (5gp) or bait (up to 500) from Harry if missing. Optional cook on the way; optional sell raw catch to Harry.

**`CatherbyLobsters.js`**  
Cage-fishes lobsters at Catherby Cage+Harpoon spots. Banks, withdraws a lobster pot (or buys one from Harry). Optional cook on the way; optional sell raw lobster to Harry.

**`CatherbySwordfish.js`**  
Harpoons tuna/swordfish at Catherby Cage+Harpoon spots. Withdraws a harpoon (or buys one from Harry). Optional cook (tuna 30+, swordfish 45+); optional sell raw catch to Harry.

**`LegacyCatherbyLobsters.js`**  
Archived cage-lobster script. Same idea as `CatherbyLobsters.js`; prefer the current lobster/swordfish scripts.

**`AlKharidNetFisher.js`**  
Small-nets at a fixed Al Kharid spot and waits there if the spot hops. Banks the catch. Optional cook on the Al Kharid range after a full inventory.

**`CatherbyRangeCooker.js`**  
Withdraws raw fish from Catherby bank, cooks on the bank-house range, deposits. Dropdown: shrimp, anchovies, sardine, herring, or everything you can cook at your level.

### Flax / Crafting

**`SeersFlaxPicker.js`**  
Picks flax at the Seers’ Village field and banks at Catherby via the beehives (keeps the gate open). Starts by depositing everything and unequipping. Optional mule: type a username, tick Confirm mule, pick until bank flax hits the threshold, trade noted flax to that player, then resume.

**`SeersBowstringSpinner.js`**  
Withdraws flax from Seers’ Village bank, spins bowstrings upstairs in the house south of the bank. Needs Crafting 10+.

**`FlaxHost.js`**  
Stands at Catherby bank and **receives** noted-flax trades. Banks everything except noted flax, stays leashed to the bank (anti-lure), never offers items. After a genie lamp it steps one tile out and back so the XP overlay doesn’t cover trade requests.

**`CatherbyFlaxMule.js`**  
Simpler flax receiver: walks to Catherby bank, accepts incoming noted-flax trades, confirms both screens, and keeps listening. Use `FlaxHost.js` if you want banking + anti-lure.

**`10crafting.js`**  
Crafts soft leather with needle + thread until Crafting 10: gloves → boots at 7 → cowl at 9. Banks products and restocks from the nearest bank. BROKEN/JUNK

### Combat / Thieving

**`BenzymeGoblinKiller.js`**  
Skips Tutorial Island if needed, then fights Lumbridge oak-camp goblins. If that camp is crowded (≥7 players), trains around the HAM hideout door. At combat 20+ switches to giant rats. Optional bury of bones from your own kills; optional melee-style rotation.

**`LegacyGoblinKiller.js`**  
Older goblin fighter: one Draynor gear trip, then Lumbridge goblins until death. Optional bone bury and combat-stat rotation. Drops beer/kebab/casket. Prefer `BenzymeGoblinKiller.js`.

**`BenzymeCowSlaughterhouse.js`**  
Kills Lumbridge cows, loots cowhides (hides over combat), banks at Al Kharid. Opens the pen gate if stuck outside. Optional auto-train lowest melee stat.

**`ArdougneThiever.js`**  
Pickpockets in East Ardougne: Men (1), Warrior women (25), Guards (40), or Knights (55). HP handling: wait to regen, or eat cake / chocolate slice.

**`SneakyArdougne.js`**  
Gets a fresh account to Ardougne: skips Tutorial Island if needed, pickpockets Lumbridge Men until 60gp (HP ≥ 5), then boats Port Sarim → Karamja → Brimhaven → Ardougne. Works without Pirate’s Treasure (Customs search at Brimhaven).

### Utility / Randoms

**`WalkingBot.js`**  
Walks to a chosen town pin and stops. Destinations: Port Sarim, Draynor, Catherby, Ardougne, Seers, Falador, Rimmington, Varrock, Barbarian Village, Edgeville, Taverley.

**`AutoShopBuyer.js`**  
Buys a shop item by ID in batches of 10 until the target amount (1–5000) is reached. Open the shop (or stand by a Trade NPC) first.

**`GeneralStoreNotedSeller.js`**  
Sells all noted inventory stacks to the nearest general store. Treats Arhein (Catherby) as a general store.

**`MysteriousOldManMaze.js`**  
Solves the Mysterious Old Man maze random: opens the correct walls, blacklists fake/wrong-way doors, then touches the Strange shrine at the centre.
