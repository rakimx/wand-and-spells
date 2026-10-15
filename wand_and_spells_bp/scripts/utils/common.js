import { system } from "@minecraft/server";
import { SPELL_DEFINITIONS } from "../data/spells_data.js";

export const ELEMENT_COLORS = {
    fire: "§c",       // red
    ice: "§b",        // aqua
    healing: "§6",    // gold
    lightning: "§9",  // blue
    earth: "§a",      // green
    necromancy: "§5", // purple
    sorcery: "§d"     // pink
};

export const ELEMENTS = Object.keys(ELEMENT_COLORS);

export const TOTAL_SPELLS = Object.keys(SPELL_DEFINITIONS).length;

/**
 * Builds a RawMessage from a lang key. Anything passed as an argument is
 * substituted into %1$s, %2$s and so on, and may itself be a RawMessage,
 * which is how a spell or item name gets nested into a sentence.
 */
export function txt(key, ...args) {
    if (args.length === 0) return { translate: key };
    return {
        translate: key,
        with: { rawtext: args.map((a) => (a && typeof a === "object" ? a : { text: String(a) })) }
    };
}

/** Spell name in the player's language, from the spell.<id> keys */
export function spellText(spellId) {
    return { translate: `spell.${spellId}` };
}

/** Item name in the player's language, from the item.<id>.name keys */
export function itemText(itemId) {
    return { translate: `item.${itemId}.name` };
}

/** Every wand in the addon ends in "_wand" */
export function isWandItem(item) {
    return !!item && item.typeId.startsWith("ws:") && item.typeId.endsWith("_wand");
}

export function getSpellColor(spellId) {
    const element = SPELL_DEFINITIONS[spellId]?.element ?? "sorcery";
    return ELEMENT_COLORS[element] ?? "§f";
}

export function getSpellProps(spellId) {
    return SPELL_DEFINITIONS[spellId]?.properties ?? {};
}

export function getSpellElement(spellId) {
    return SPELL_DEFINITIONS[spellId]?.element ?? "sorcery";
}

export function getHeldItem(player) {
    return player.getComponent("inventory")?.container?.getItem(player.selectedSlotIndex);
}

/** Never consumes in creative */
export function consumeHeldItem(player, amount = 1) {
    if (player.getGameMode() === "creative") return;
    const inventory = player.getComponent("inventory")?.container;
    if (!inventory) return;
    const item = inventory.getItem(player.selectedSlotIndex);
    if (!item) return;
    if (item.amount > amount) {
        item.amount -= amount;
        inventory.setItem(player.selectedSlotIndex, item);
    } else {
        inventory.setItem(player.selectedSlotIndex, undefined);
    }
}

/** Never consumes in creative */
export function consumeInventorySlot(player, slot, amount = 1) {
    if (player.getGameMode() === "creative") return;
    const inventory = player.getComponent("inventory")?.container;
    const item = inventory?.getItem(slot);
    if (!item) return;
    if (item.amount > amount) {
        item.amount -= amount;
        inventory.setItem(slot, item);
    } else {
        inventory.setItem(slot, undefined);
    }
}

/** Drops the item on the ground if the inventory is full */
export function giveItem(player, itemStack) {
    const inventory = player.getComponent("inventory")?.container;
    const leftover = inventory?.addItem(itemStack);
    if (leftover) {
        player.dimension.spawnItem(leftover, player.location);
    }
}

const lastBlockInteraction = new Map();

/**
 * Whether an addon block should handle this interaction.
 * Sneaking falls through to vanilla so blocks can still be placed on top,
 * and holding the button fires the event repeatedly, so only the first one counts.
 */
export function claimBlockInteraction(event) {
    if (event.player.isSneaking) return false;
    event.cancel = true;
    if (event.isFirstEvent === false) return false;

    // Fallback for versions without isFirstEvent
    const now = system.currentTick;
    const last = lastBlockInteraction.get(event.player.id) ?? -100;
    if (now - last < 8) return false;
    lastBlockInteraction.set(event.player.id, now);
    return true;
}

/** Key used to store per-block data in world dynamic properties */
export function blockKey(dimensionId, loc) {
    return `${dimensionId}|${loc.x}|${loc.y}|${loc.z}`;
}
