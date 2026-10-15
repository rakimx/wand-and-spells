import { SPELL_DEFINITIONS } from "../data/spells_data.js";
import { isWandItem, txt, itemText } from "../utils/common.js";

/**
 * Wand tiers and metadata.
 * Four progression tiers plus the 7 elemental wands.
 * - upgradeLimit: how many upgrades the wand accepts in total
 * - next: what it becomes when evolved with an Arcane Tome
 */
export const WAND_TIERS = {
    "ws:magic_wand": {
        maxMana: 500,
        element: null,
        upgradeLimit: 3,
        next: "ws:apprentice_wand"
    },
    "ws:apprentice_wand": {
        maxMana: 1000,
        element: null,
        upgradeLimit: 4,
        next: "ws:advanced_wand"
    },
    "ws:advanced_wand": {
        maxMana: 1800,
        element: null,
        upgradeLimit: 5,
        next: "ws:master_wand"
    },
    "ws:master_wand": {
        maxMana: 3000,
        element: null,
        upgradeLimit: 6,
        next: null
    },
    // Elemental wands
    "ws:fire_wand": {
        maxMana: 1500,
        element: "fire",
        upgradeLimit: 5,
        next: null
    },
    "ws:ice_wand": {
        maxMana: 1500,
        element: "ice",
        upgradeLimit: 5,
        next: null
    },
    "ws:lightning_wand": {
        maxMana: 1500,
        element: "lightning",
        upgradeLimit: 5,
        next: null
    },
    "ws:earth_wand": {
        maxMana: 1500,
        element: "earth",
        upgradeLimit: 5,
        next: null
    },
    "ws:healing_wand": {
        maxMana: 1500,
        element: "healing",
        upgradeLimit: 5,
        next: null
    },
    "ws:necromancy_wand": {
        maxMana: 1500,
        element: "necromancy",
        upgradeLimit: 5,
        next: null
    },
    "ws:sorcery_wand": {
        maxMana: 1500,
        element: "sorcery",
        upgradeLimit: 5,
        next: null
    }
};

/**
 * Items that recharge mana at the Arcane Loom, and how much each restores
 */
export const MANA_RECHARGE_VALUES = {
    "ws:small_mana_flask": 250,
    "ws:medium_mana_flask": 600,
    "ws:large_mana_flask": 1500,
    "ws:crystal_shard": 100,
    "ws:crystal_magic": 400,
    "ws:crystal_fire": 500,
    "ws:crystal_ice": 500,
    "ws:crystal_lightning": 500,
    "ws:crystal_earth": 500,
    "ws:crystal_healing": 500,
    "ws:crystal_necromancy": 500,
    "ws:crystal_sorcery": 500,
    "ws:grand_crystal": 3000
};

/**
 * Wand upgrades applied at the Arcane Loom (from EBWizardry)
 */
export const WAND_UPGRADES = {
    "ws:storage_upgrade": { key: "storage" },
    "ws:siphon_upgrade": { key: "siphon" },
    "ws:condenser_upgrade": { key: "condenser" },
    "ws:range_upgrade": { key: "range" },
    "ws:duration_upgrade": { key: "duration" },
    "ws:cooldown_upgrade": { key: "cooldown" },
    "ws:blast_upgrade": { key: "blast" },
    "ws:attunement_upgrade": { key: "attunement" },
    "ws:melee_upgrade": { key: "melee" }
};

export const MAX_UPGRADE_LEVEL = 3;
export const BASE_SPELL_SLOTS = 5;

export function getWandInfo(typeId) {
    return WAND_TIERS[typeId] ?? {
        maxMana: 500,
        element: null,
        upgradeLimit: 3,
        next: null
    };
}

// ------------------------------------------------------------------ Upgrades

/**
 * Upgrade levels on a wand, e.g. { storage: 2, range: 1 }
 */
export function getWandUpgrades(item) {
    const raw = item.getDynamicProperty("upgrades");
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export function getUpgradeLevel(item, key) {
    return getWandUpgrades(item)[key] ?? 0;
}

export function getTotalUpgrades(item) {
    return Object.values(getWandUpgrades(item)).reduce((sum, lvl) => sum + lvl, 0);
}

export function canApplyUpgrade(item, upgradeTypeId) {
    const upgrade = WAND_UPGRADES[upgradeTypeId];
    if (!upgrade) return { ok: false, reason: txt("ws.msg.no_upgrade_item") };
    const info = getWandInfo(item.typeId);
    if (getTotalUpgrades(item) >= info.upgradeLimit) {
        return { ok: false, reason: txt("ws.msg.upgrade_limit", itemText(item.typeId), info.upgradeLimit) };
    }
    if (getUpgradeLevel(item, upgrade.key) >= MAX_UPGRADE_LEVEL) {
        return { ok: false, reason: txt("ws.msg.upgrade_maxed", itemText(upgradeTypeId), MAX_UPGRADE_LEVEL) };
    }
    return { ok: true };
}

/**
 * Applies an upgrade without validating; call canApplyUpgrade first
 */
export function applyUpgrade(item, upgradeTypeId) {
    const upgrade = WAND_UPGRADES[upgradeTypeId];
    const upgrades = getWandUpgrades(item);
    const mana = getWandMana(item);
    upgrades[upgrade.key] = (upgrades[upgrade.key] ?? 0) + 1;
    item.setDynamicProperty("upgrades", JSON.stringify(upgrades));
    setWandMana(item, mana);
    return upgrades[upgrade.key];
}

/**
 * Spell slot count (5 plus Attunement)
 */
export function getSlotCount(item) {
    return BASE_SPELL_SLOTS + getUpgradeLevel(item, "attunement");
}

/**
 * Multipliers applied to spells cast with this wand
 */
export function getSpellModifiers(item) {
    const upgrades = getWandUpgrades(item);
    return {
        range: 1 + 0.25 * (upgrades.range ?? 0),
        duration: 1 + 0.25 * (upgrades.duration ?? 0),
        blast: 1 + 0.25 * (upgrades.blast ?? 0)
    };
}

// ------------------------------------------------------------------ Mana

/**
 * Real maximum mana (tier base plus Storage)
 */
export function getWandMaxMana(item) {
    const info = getWandInfo(item.typeId);
    return Math.round(info.maxMana * (1 + 0.15 * getUpgradeLevel(item, "storage")));
}

/**
 * Current mana on a wand, starting at maxMana if it is new
 */
export function getWandMana(item) {
    let mana = item.getDynamicProperty("current_mana");
    if (mana === undefined || mana === null) {
        mana = getWandMaxMana(item);
        item.setDynamicProperty("current_mana", mana);
        updateWandLore(item, mana);
    }
    return mana;
}

/**
 * Sets the mana on a wand and refreshes its lore
 */
export function setWandMana(item, mana) {
    const clampedMana = Math.max(0, Math.min(getWandMaxMana(item), Math.round(mana)));
    item.setDynamicProperty("current_mana", clampedMana);
    updateWandLore(item, clampedMana);
    return clampedMana;
}

/**
 * Mana bar drawn with blocks, with a full/empty marker
 */
export function getManaBar(currentMana, maxMana, totalBars = 10) {
    if (!maxMana || maxMana <= 0) return "§7" + "■".repeat(totalBars);
    const ratio = Math.max(0, Math.min(1, currentMana / maxMana));
    let filled = Math.round(ratio * totalBars);
    if (currentMana > 0 && filled === 0) filled = 1;
    if (currentMana < maxMana && filled === totalBars && ratio < 0.99) filled = totalBars - 1;
    const empty = totalBars - filled;

    let color = "§b";
    if (ratio <= 0.2) color = "§c";
    else if (ratio <= 0.5) color = "§e";

    return `${color}${"■".repeat(filled)}§7${"■".repeat(empty)}`;
}

/**
 * Rewrites the wand lore with the mana bar and numbers.
 *
 * Lore is the one place the addon cannot translate: setLore only accepts plain
 * strings, never a RawMessage, and there is no API to read a player's language.
 * So it carries no sentences at all - the wand name already sits above it,
 * localized by the item itself, and the rest is numbers, bars and upgrade keys.
 */
export function updateWandLore(item, mana) {
    try {
        const maxMana = getWandMaxMana(item);
        const percent = Math.round((mana / maxMana) * 100);
        const bar = getManaBar(mana, maxMana, 10);
        const lore = [`§f${bar} §f${mana}/${maxMana} (${percent}%)`];

        const upgrades = getWandUpgrades(item);
        const parts = Object.values(WAND_UPGRADES)
            .filter((u) => upgrades[u.key])
            .map((u) => `${u.key.charAt(0).toUpperCase()}${u.key.slice(1)} ${upgrades[u.key]}`);
        if (parts.length > 0) {
            lore.push(`§7> §e${parts.join("§7, §e")}`);
        }
        item.setLore(lore);
    } catch { }
}

/**
 * Casting cost:
 * - 30% off when the wand matches the spell's element
 * - 10% off per level of Efficiency
 */
export function calculateSpellCost(wandItem, spellId) {
    const def = SPELL_DEFINITIONS[spellId];
    let cost = def?.cost ?? 10;
    const wandInfo = getWandInfo(wandItem.typeId);

    if (wandInfo.element && def?.element === wandInfo.element) {
        cost *= 0.7;
    }
    cost *= 1 - 0.1 * getUpgradeLevel(wandItem, "cooldown");
    return Math.max(1, Math.ceil(cost));
}

// ------------------------------------------------------------------ Pending mana / bank

/**
 * Mana deductions held back until the use finishes, so setItem is never called
 * mid-use: doing that cancels the use, restarts itemStartUse in a loop and glitches the arm.
 */
export const pendingManaUpdates = new Map();

/**
 * Mana earned (Condenser/Siphon) by the held wand, parked until it is safe to write
 */
const heldManaBank = new Map();

export function applyPendingMana(player) {
    if (!player) return;
    const pending = pendingManaUpdates.get(player.id);
    if (!pending) return;
    pendingManaUpdates.delete(player.id);

    try {
        const inventory = player.getComponent("inventory")?.container;
        if (!inventory) return;
        const currentHeld = inventory.getItem(pending.slot);
        if (isWandItem(currentHeld)) {
            setWandMana(currentHeld, pending.mana);
            inventory.setItem(pending.slot, currentHeld);
        }
    } catch { }
}

/**
 * Parks mana earned by the held wand without touching the item.
 * While casting, it goes straight onto the pending amount.
 */
export function bankHeldWandMana(player, slot, amount, maxMana, currentMana) {
    const pending = pendingManaUpdates.get(player.id);
    if (pending && pending.slot === slot) {
        pending.mana = Math.min(maxMana, pending.mana + amount);
        return;
    }
    // Bank from another slot (wand swapped): commit it before reusing
    flushBankedMana(player, slot);
    const room = Math.max(0, maxMana - currentMana);
    const bank = heldManaBank.get(player.id);
    const banked = bank ? bank.amount : 0;
    heldManaBank.set(player.id, { slot, amount: Math.min(room, banked + amount) });
}

/**
 * Takes the banked mana for a slot, 0 if there is none
 */
export function takeBankedMana(player, slot) {
    const bank = heldManaBank.get(player.id);
    if (!bank || bank.slot !== slot) return 0;
    heldManaBank.delete(player.id);
    return bank.amount;
}

/**
 * Commits the banked mana of a slot that is no longer in use
 */
export function flushBankedMana(player, onlyIfNotSlot = -1) {
    const bank = heldManaBank.get(player.id);
    if (!bank || bank.slot === onlyIfNotSlot) return;
    heldManaBank.delete(player.id);
    try {
        const inventory = player.getComponent("inventory")?.container;
        const item = inventory?.getItem(bank.slot);
        if (isWandItem(item)) {
            setWandMana(item, getWandMana(item) + bank.amount);
            inventory.setItem(bank.slot, item);
        }
    } catch { }
}
