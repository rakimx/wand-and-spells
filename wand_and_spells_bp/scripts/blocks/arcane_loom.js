import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { SPELL_DEFINITIONS } from "../data/spells_data.js";
import { getPlayerKnownSpells } from "../spells/spell_learning.js";
import {
    getWandInfo, getWandMana, getWandMaxMana, setWandMana, calculateSpellCost, MANA_RECHARGE_VALUES, getManaBar,
    getSlotCount, WAND_UPGRADES, MAX_UPGRADE_LEVEL, getWandUpgrades, getTotalUpgrades, canApplyUpgrade, applyUpgrade,
    applyPendingMana, takeBankedMana
} from "../wands/wand_data.js";
import { isWandItem, TOTAL_SPELLS, claimBlockInteraction, consumeInventorySlot, txt, spellText, itemText } from "../utils/common.js";

// Official tier names for spells
const TIER_KEYS = {
    novice: "ws.tier.novice",
    apprentice: "ws.tier.apprentice",
    advanced: "ws.tier.advanced",
    master: "ws.tier.master"
};

// Spell book icons per element, for the UI buttons
const ELEMENT_SPELL_ICONS = {
    fire: "textures/items/spell_book_fire.png",
    ice: "textures/items/spell_book_ice.png",
    lightning: "textures/items/spell_book_lightning.png",
    earth: "textures/items/spell_book_earth.png",
    healing: "textures/items/spell_book_healing.png",
    necromancy: "textures/items/spell_book_necromancy.png",
    sorcery: "textures/items/spell_book_sorcery.png"
};

// Crystal icons for the class picker
const ELEMENT_CLASS_ICONS = {
    fire: "textures/items/crystal_fire.png",
    ice: "textures/items/crystal_ice.png",
    lightning: "textures/items/crystal_lightning.png",
    earth: "textures/items/crystal_earth.png",
    healing: "textures/items/crystal_healing.png",
    necromancy: "textures/items/crystal_necromancy.png",
    sorcery: "textures/items/crystal_sorcery.png"
};

// Blurbs for the 7 arcane classes
const ELEMENT_INFO = {
    fire: { key: "ws.class.fire" },
    ice: { key: "ws.class.ice" },
    lightning: { key: "ws.class.lightning" },
    earth: { key: "ws.class.earth" },
    healing: { key: "ws.class.healing" },
    necromancy: { key: "ws.class.necromancy" },
    sorcery: { key: "ws.class.sorcery" }
};

/**
 * The held wand, with any banked mana (Condenser/Siphon) already written into the item
 */
function getHeldWand(player) {
    const inventory = player.getComponent("inventory").container;
    const slot = player.selectedSlotIndex;
    const wandItem = inventory.getItem(slot);
    if (!isWandItem(wandItem)) return null;

    applyPendingMana(player);
    const banked = takeBankedMana(player, slot);
    if (banked > 0) {
        setWandMana(wandItem, getWandMana(wandItem) + banked);
        inventory.setItem(slot, wandItem);
    }
    return { inventory, slot, wandItem: inventory.getItem(slot) };
}

/**
 * First inventory slot holding one of the given item types
 */
function findInventoryItem(inventory, predicate) {
    for (let slot = 0; slot < inventory.size; slot++) {
        const it = inventory.getItem(slot);
        if (it && predicate(it)) return { slot, item: it };
    }
    return null;
}

/**
 * Arcane Loom main menu for the wand in the player's hand
 */
function openLoomMainMenu(player, block) {
    const held = getHeldWand(player);

    if (!held) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.hold_wand"));
        player.playSound("note.bass", { pitch: 0.7, volume: 1.0 });
        return;
    }

    const { inventory, wandItem } = held;
    const wandInfo = getWandInfo(wandItem.typeId);
    const maxMana = getWandMaxMana(wandItem);
    const currentMana = getWandMana(wandItem);
    const manaPercent = Math.round((currentMana / maxMana) * 100);
    const slotCount = getSlotCount(wandItem);

    const knownSpells = getPlayerKnownSpells(player);

    let spellsJson = wandItem.getDynamicProperty("spells");
    let wandSpells = spellsJson ? JSON.parse(spellsJson) : [];
    while (wandSpells.length < slotCount) {
        wandSpells.push(null);
    }

    const manaBar = getManaBar(currentMana, maxMana, 10);

    const form = new ActionFormData();
    form.title(txt("ws.ui.loom_title"));
    form.body(txt("ws.ui.loom_body", itemText(wandItem.typeId), manaBar, currentMana, maxMana, manaPercent, getTotalUpgrades(wandItem), wandInfo.upgradeLimit, knownSpells.length, TOTAL_SPELLS));

    // Each button registers its action in the same order it is added
    const actions = [];

    // One button per wand slot, with the element icon on the side
    for (let i = 0; i < slotCount; i++) {
        const spellId = wandSpells[i];
        if (spellId) {
            const elem = SPELL_DEFINITIONS[spellId]?.element ?? "sorcery";
            const cost = calculateSpellCost(wandItem, spellId);
            const icon = ELEMENT_SPELL_ICONS[elem] ?? "textures/items/spell_book.png";
            form.button(txt("ws.ui.slot_filled", i + 1, spellText(spellId), cost), icon);
        } else {
            form.button(txt("ws.ui.slot_empty", i + 1), "textures/items/spell_book.png");
        }
        actions.push(() => openElementCategoryMenu(player, block, i));
    }

    form.button(txt("ws.ui.recharge", currentMana, maxMana), "textures/items/mana_flask_large.png");
    actions.push(() => rechargeWandMana(player, block));

    form.button(txt("ws.ui.upgrades_button"), "textures/items/upgrade_storage.png");
    actions.push(() => openUpgradeMenu(player, block));

    if (wandInfo.next && findInventoryItem(inventory, (it) => it.typeId === "ws:arcane_tome")) {
        form.button(txt("ws.ui.evolve", itemText(wandInfo.next)), "textures/items/arcane_tome.png");
        actions.push(() => evolveWand(player, block));
    }

    form.button(txt("ws.ui.close"));
    actions.push(() => { });

    form.show(player).then((response) => {
        if (response.canceled) return;
        actions[response.selection]?.();
    });
}

/**
 * Class picker (Ignes, Glacies...), listing only the unlocked ones
 */
function openElementCategoryMenu(player, block, slotIndex) {
    const knownSpells = getPlayerKnownSpells(player);

    const form = new ActionFormData();
    form.title(txt("ws.ui.pick_class_title"));

    if (knownSpells.length === 0) {
        form.body(txt("ws.ui.no_spells_body"));
        form.button(txt("ws.ui.back_to_loom"));
        form.show(player).then((res) => {
            if (!res.canceled) openLoomMainMenu(player, block);
        });
        return;
    }

    // Group the known spells by element
    const spellsByElement = {
        fire: [],
        ice: [],
        lightning: [],
        earth: [],
        healing: [],
        necromancy: [],
        sorcery: []
    };

    for (const spellId of knownSpells) {
        const elem = SPELL_DEFINITIONS[spellId]?.element ?? "sorcery";
        if (spellsByElement[elem]) {
            spellsByElement[elem].push(spellId);
        } else {
            spellsByElement.sorcery.push(spellId);
        }
    }

    form.body(txt("ws.ui.pick_class_body"));

    // Button 0: unbind the slot
    form.button(txt("ws.ui.unbind_slot"), "textures/items/spell_book.png");

    // Only classes with at least one unlocked spell
    const availableCategories = [];
    for (const [elemKey, list] of Object.entries(spellsByElement)) {
        if (list.length > 0) {
            const info = ELEMENT_INFO[elemKey];
            const icon = ELEMENT_CLASS_ICONS[elemKey] ?? "textures/items/spell_book.png";
            form.button(txt("ws.ui.class_button", txt(info.key), list.length), icon);
            availableCategories.push({ elemKey, list });
        }
    }

    form.button(txt("ws.ui.back_to_loom"));

    form.show(player).then((response) => {
        if (response.canceled) return;

        const sel = response.selection;

        // Clear the slot
        if (sel === 0) {
            updateWandSlot(player, block, slotIndex, null);
            return;
        }

        // Back to the Loom (last button)
        if (sel === availableCategories.length + 1) {
            openLoomMainMenu(player, block);
            return;
        }

        const chosenCategory = availableCategories[sel - 1];
        if (chosenCategory) {
            openElementSpellListMenu(player, block, slotIndex, chosenCategory.elemKey, chosenCategory.list);
        }
    });
}

/**
 * Spell list for one class, e.g. every Ignes spell the player knows
 */
function openElementSpellListMenu(player, block, slotIndex, elemKey, spellList) {
    const info = ELEMENT_INFO[elemKey] ?? { name: elemKey };
    const inventory = player.getComponent("inventory").container;
    const wandItem = inventory.getItem(player.selectedSlotIndex);
    const icon = ELEMENT_SPELL_ICONS[elemKey] ?? "textures/items/spell_book.png";

    const form = new ActionFormData();
    form.title(txt("ws.ui.spells_title", txt(info.key)));
    form.body(txt("ws.ui.spells_body", slotIndex + 1));

    for (const spellId of spellList) {
        const def = SPELL_DEFINITIONS[spellId];
        const tierKey = def?.tier;
        const tierStr = tierKey && TIER_KEYS[tierKey] ? txt("ws.ui.tier_suffix", txt(TIER_KEYS[tierKey])) : "";
        const cost = isWandItem(wandItem) ? calculateSpellCost(wandItem, spellId) : (def?.cost ?? 10);
        form.button(txt("ws.ui.spell_button", spellText(spellId), cost, tierStr), icon);
    }

    form.button(txt("ws.ui.back_to_classes"));

    form.show(player).then((response) => {
        if (response.canceled) return;

        const sel = response.selection;

        // Back to the classes (last button)
        if (sel === spellList.length) {
            openElementCategoryMenu(player, block, slotIndex);
            return;
        }

        const chosenSpell = spellList[sel];
        if (chosenSpell) {
            updateWandSlot(player, block, slotIndex, chosenSpell);
        }
    });
}

/**
 * Writes the chosen spell into the wand slot
 */
function updateWandSlot(player, block, slotIndex, spellId) {
    const inventory = player.getComponent("inventory").container;
    const wandItem = inventory.getItem(player.selectedSlotIndex);

    if (!isWandItem(wandItem)) {
        return;
    }

    const slotCount = getSlotCount(wandItem);
    let spellsJson = wandItem.getDynamicProperty("spells");
    let wandSpells = spellsJson ? JSON.parse(spellsJson) : [];
    while (wandSpells.length < slotCount) wandSpells.push(null);

    wandSpells[slotIndex] = spellId;
    wandItem.setDynamicProperty("spells", JSON.stringify(wandSpells));
    inventory.setItem(player.selectedSlotIndex, wandItem);

    player.playSound("block.arcane_workbench.bind_spell", { volume: 1.0 });
    player.playSound("misc.discover_spell", { pitch: 1.2, volume: 0.8 });

    try {
        block.dimension.spawnParticle("minecraft:witch_spell_particle", {
            x: block.x + 0.5,
            y: block.y + 1.2,
            z: block.z + 0.5
        });
        block.dimension.spawnParticle("minecraft:totem_particle", {
            x: block.x + 0.5,
            y: block.y + 1.0,
            z: block.z + 0.5
        });
    } catch {}

    if (spellId) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.slot_bound", slotIndex + 1, spellText(spellId)));
    } else {
        player.onScreenDisplay.setActionBar(txt("ws.msg.slot_unbound", slotIndex + 1));
    }

    // Reopen the main menu once it is updated
    system.runTimeout(() => {
        openLoomMainMenu(player, block);
    }, 4);
}

/**
 * Recharges the wand with crystals or mana flasks from the inventory
 */
function rechargeWandMana(player, block) {
    const held = getHeldWand(player);
    if (!held) return;
    const { inventory, slot, wandItem } = held;

    const wandInfo = getWandInfo(wandItem.typeId);
    const maxMana = getWandMaxMana(wandItem);
    const currentMana = getWandMana(wandItem);

    if (currentMana >= maxMana) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.mana_full", maxMana, maxMana));
        player.playSound("random.orb", { pitch: 1.0, volume: 0.8 });
        return;
    }

    const found = findInventoryItem(inventory, (it) => MANA_RECHARGE_VALUES[it.typeId] !== undefined);
    if (!found) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.need_mana_items"));
        player.playSound("note.bass", { pitch: 0.7, volume: 1.0 });
        return;
    }

    let restoreAmount = MANA_RECHARGE_VALUES[found.item.typeId];
    // Matching element gives a bonus (+300 extra mana)
    if (wandInfo.element && found.item.typeId === `ws:crystal_${wandInfo.element}`) {
        restoreAmount += 300;
    }

    consumeInventorySlot(player, found.slot);

    const newMana = setWandMana(wandItem, currentMana + restoreAmount);
    inventory.setItem(slot, wandItem);

    player.playSound("item.mana_flask.recharge", { volume: 1.0 });
    try {
        block.dimension.spawnParticle("minecraft:totem_particle", {
            x: block.x + 0.5,
            y: block.y + 1.1,
            z: block.z + 0.5
        });
    } catch {}

    const actuallyRestored = newMana - currentMana;
    player.onScreenDisplay.setActionBar(txt("ws.msg.mana_restored", actuallyRestored, newMana, maxMana));

    // Reopen the refreshed main menu after 6 ticks
    system.runTimeout(() => {
        openLoomMainMenu(player, block);
    }, 6);
}

/**
 * Upgrade menu: what the player carries and the current level of each
 */
function openUpgradeMenu(player, block) {
    const held = getHeldWand(player);
    if (!held) return;
    const { inventory, wandItem } = held;
    const wandInfo = getWandInfo(wandItem.typeId);
    const upgrades = getWandUpgrades(wandItem);

    const available = [];
    for (const [typeId, upgrade] of Object.entries(WAND_UPGRADES)) {
        let count = 0;
        for (let slot = 0; slot < inventory.size; slot++) {
            const it = inventory.getItem(slot);
            if (it && it.typeId === typeId) count += it.amount;
        }
        available.push({ typeId, upgrade, count });
    }

    const form = new ActionFormData();
    form.title(txt("ws.ui.upgrades_title"));
    form.body(txt("ws.ui.upgrades_body", itemText(wandItem.typeId), getTotalUpgrades(wandItem), wandInfo.upgradeLimit, MAX_UPGRADE_LEVEL));

    for (const { typeId, upgrade, count } of available) {
        const level = upgrades[upgrade.key] ?? 0;
        const status = count > 0 ? txt("ws.ui.upgrade_have", count) : txt("ws.ui.upgrade_none");
        form.button(txt("ws.ui.upgrade_button", itemText(typeId), level, MAX_UPGRADE_LEVEL, status, txt(`ws.upgrade.${upgrade.key}.desc`)), `textures/items/upgrade_${upgrade.key}.png`);
    }
    form.button(txt("ws.ui.back_to_loom"));

    form.show(player).then((response) => {
        if (response.canceled) return;
        const chosen = available[response.selection];
        if (!chosen) {
            openLoomMainMenu(player, block);
            return;
        }
        applyWandUpgrade(player, block, chosen.typeId);
    });
}

function applyWandUpgrade(player, block, upgradeTypeId) {
    const held = getHeldWand(player);
    if (!held) return;
    const { inventory, slot, wandItem } = held;

    const found = findInventoryItem(inventory, (it) => it.typeId === upgradeTypeId);
    if (!found) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.no_upgrade_item"));
        player.playSound("note.bass", { pitch: 0.7, volume: 1.0 });
        system.runTimeout(() => openUpgradeMenu(player, block), 6);
        return;
    }

    const check = canApplyUpgrade(wandItem, upgradeTypeId);
    if (!check.ok) {
        player.onScreenDisplay.setActionBar(check.reason);
        player.playSound("note.bass", { pitch: 0.7, volume: 1.0 });
        system.runTimeout(() => openUpgradeMenu(player, block), 6);
        return;
    }

    consumeInventorySlot(player, found.slot);
    const level = applyUpgrade(wandItem, upgradeTypeId);
    inventory.setItem(slot, wandItem);

    player.playSound("item.wand.levelup", { volume: 1.0 });
    try {
        block.dimension.spawnParticle("minecraft:totem_particle", { x: block.x + 0.5, y: block.y + 1.1, z: block.z + 0.5 });
    } catch { }
    player.onScreenDisplay.setActionBar(txt("ws.msg.upgrade_applied", itemText(upgradeTypeId), level));

    system.runTimeout(() => openUpgradeMenu(player, block), 6);
}

/**
 * Evolves the wand to the next tier by spending an Arcane Tome.
 * Spells, upgrades, mana and custom name are all carried over.
 */
function evolveWand(player, block) {
    const held = getHeldWand(player);
    if (!held) return;
    const { inventory, slot, wandItem } = held;
    const wandInfo = getWandInfo(wandItem.typeId);
    if (!wandInfo.next) return;

    const tome = findInventoryItem(inventory, (it) => it.typeId === "ws:arcane_tome");
    if (!tome) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.need_tome"));
        player.playSound("note.bass", { pitch: 0.7, volume: 1.0 });
        return;
    }

    const newWand = new ItemStack(wandInfo.next, 1);
    for (const id of wandItem.getDynamicPropertyIds()) {
        newWand.setDynamicProperty(id, wandItem.getDynamicProperty(id));
    }
    if (wandItem.nameTag) newWand.nameTag = wandItem.nameTag;
    setWandMana(newWand, getWandMana(wandItem));

    consumeInventorySlot(player, tome.slot);
    inventory.setItem(slot, newWand);

    player.playSound("item.wand.levelup", { volume: 1.0 });
    player.playSound("random.levelup", { pitch: 0.9, volume: 1.0 });
    try {
        block.dimension.spawnParticle("minecraft:totem_particle", { x: block.x + 0.5, y: block.y + 1.1, z: block.z + 0.5 });
    } catch { }
    player.onScreenDisplay.setActionBar(txt("ws.msg.wand_evolved", itemText(wandInfo.next)));

    system.runTimeout(() => openLoomMainMenu(player, block), 6);
}

/**
 * Interacting with the Arcane Loom in the world.
 * Sneaking keeps vanilla behaviour so blocks can still be placed on top.
 */
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block;
    if (block.typeId !== "ws:arcane_workbench") return;
    if (!claimBlockInteraction(event)) return;

    system.run(() => {
        openLoomMainMenu(event.player, block);
    });
});
