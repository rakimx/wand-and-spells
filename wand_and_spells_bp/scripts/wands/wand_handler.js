import { world, system } from "@minecraft/server";
import { executeSpell, startChanneledLightningRay, stopChanneledLightningRay, CHANNELED_SPELLS } from "../spells/spell_caster.js";
import {
    getWandMana, getWandMaxMana, setWandMana, calculateSpellCost, getSlotCount, getSpellModifiers,
    pendingManaUpdates, applyPendingMana, takeBankedMana
} from "./wand_data.js";
import { isWandItem, getSpellColor, txt, spellText } from "../utils/common.js";

/**
 * Spells bound to the wand, padded to its slot count
 */
function readWandSpells(wandItem) {
    const spellsJson = wandItem.getDynamicProperty("spells");
    const spells = spellsJson ? JSON.parse(spellsJson) : ["ws:magic_missile", "ws:lightning_ray", null, null, null];
    const slotCount = getSlotCount(wandItem);
    while (spells.length < slotCount) spells.push(null);
    if (!spells[1]) spells[1] = "ws:lightning_ray";
    return spells;
}

/**
 * Sneak and use cycles through the spell slots.
 *
 * Caught before the use rather than after it, and cancelled. Switching is a
 * tap, but the wand's use_duration runs for an hour, so by the time an after
 * event runs the player is already in the using state - wand held out, walking
 * at a fifth speed - and the only way out is the release, which the switch's
 * own setItem can swallow. Cancelling here means the state is never entered, so
 * there is nothing left to get stuck in.
 *
 * The work is deferred a tick because a before event may not change the world.
 */
world.beforeEvents.itemUse.subscribe((event) => {
    const player = event.source;
    if (!player) return;

    let sneaking = false;
    try { sneaking = player.isSneaking; } catch { return; }
    if (!sneaking) return;
    if (!isWandItem(event.itemStack)) return;

    event.cancel = true;
    system.run(() => {
        try { switchWandSpell(player); } catch { }
    });
});

function switchWandSpell(player) {
    if (!player.isValid()) return;
    const inventory = player.getComponent("inventory")?.container;
    if (!inventory) return;
    const wandItem = inventory.getItem(player.selectedSlotIndex);
    if (!isWandItem(wandItem)) return;

    applyPendingMana(player);

    const maxMana = getWandMaxMana(wandItem);
    const currentMana = setWandMana(wandItem, getWandMana(wandItem) + takeBankedMana(player, player.selectedSlotIndex));
    const selectedSlot = wandItem.getDynamicProperty("selected_slot");
    const spells = readWandSpells(wandItem);
    const slotCount = getSlotCount(wandItem);

    const currentSlot = selectedSlot ?? 0;
    const nextSlot = (currentSlot + 1) % slotCount;

    wandItem.setDynamicProperty("selected_slot", nextSlot);
    wandItem.setDynamicProperty("spells", JSON.stringify(spells));
    inventory.setItem(player.selectedSlotIndex, wandItem);

    const spellId = spells[nextSlot];
    if (spellId) {
        const cost = calculateSpellCost(wandItem, spellId);
        const color = getSpellColor(spellId);
        player.onScreenDisplay.setActionBar(txt("ws.msg.slot_switch", nextSlot + 1, color, spellText(spellId), cost, currentMana, maxMana));
    } else {
        player.onScreenDisplay.setActionBar(txt("ws.msg.slot_switch_empty", nextSlot + 1, currentMana, maxMana));
    }
    player.playSound("random.orb", { pitch: 1.2, volume: 0.5 });

    releaseWandUse(player);
}

/**
 * A second line against the wand sticking in the using state.
 *
 * Cancelling the use above should mean this is never needed, but cancelling
 * only works if the before event reaches the game in time, and the switch has
 * just replaced the stack underneath either way. A script cannot stop an item
 * being used; changing which slot is held can, and moving off and straight
 * back is close enough to instant that the hotbar does not visibly flicker.
 */
function releaseWandUse(player) {
    system.run(() => {
        try {
            if (!player.isValid()) return;
            const held = player.selectedSlotIndex;
            player.selectedSlotIndex = (held + 1) % 9;
            player.selectedSlotIndex = held;
        } catch { }
    });
}

// Use fires the spell right away, on itemStartUse, along with the arm animation
world.afterEvents.itemStartUse.subscribe((event) => {
    const player = event.source;
    const item = event.itemStack;

    if (!isWandItem(item)) {
        return;
    }

    if (player.isSneaking) {
        return;
    }

    // Flush any deduction left pending by a previous cast
    applyPendingMana(player);

    const inventory = player.getComponent("inventory")?.container;
    if (!inventory) return;
    const slot = player.selectedSlotIndex;
    const wandItem = inventory.getItem(slot);
    if (!wandItem) return;

    const maxMana = getWandMaxMana(wandItem);
    // Mana banked by the Condenser/Siphon lands now. No setItem here: it would cancel the use.
    const currentMana = Math.min(maxMana, getWandMana(wandItem) + takeBankedMana(player, slot));
    const selectedSlot = wandItem.getDynamicProperty("selected_slot");
    const spells = readWandSpells(wandItem);

    const currentSlot = selectedSlot ?? 0;
    const spellId = spells[currentSlot];

    if (!spellId) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.slot_unset", currentSlot + 1));
        player.playSound("random.fizz", { volume: 0.5 });
        pendingManaUpdates.set(player.id, { slot, mana: currentMana });
        return;
    }

    const spellCost = calculateSpellCost(wandItem, spellId);
    const color = getSpellColor(spellId);
    const modifiers = getSpellModifiers(wandItem);

    if (currentMana < spellCost) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.not_enough_mana", currentMana, spellCost));
        player.playSound("note.bass", { pitch: 0.8, volume: 1.0 });
        pendingManaUpdates.set(player.id, { slot, mana: currentMana });
        return;
    }

    // Channelled spells (rays) keep going while the button is held. The listed cost is
    // per second, as in the mod, and is charged every 0.5s.
    if (CHANNELED_SPELLS.has(spellId)) {
        const tickCost = Math.max(1, Math.round(spellCost / 2));
        startChanneledLightningRay(player, spellId, modifiers, () => {
            const pending = pendingManaUpdates.get(player.id);
            let manaLeft = pending ? pending.mana : currentMana;
            if (manaLeft < tickCost) {
                player.onScreenDisplay.setActionBar(txt("ws.msg.mana_drained"));
                return false;
            }
            manaLeft -= tickCost;
            pendingManaUpdates.set(player.id, { slot, mana: manaLeft });
            player.onScreenDisplay.setActionBar(txt("ws.msg.channelling", currentSlot + 1, color, spellText(spellId), manaLeft, maxMana));
            return true;
        });
    } else {
        const success = executeSpell(player, spellId, false, modifiers);
        if (success === false) {
            pendingManaUpdates.set(player.id, { slot, mana: currentMana });
            return;
        }
    }

    // Arm animation on its own controller, so nothing else can overlap it
    try {
        player.playAnimation("animation.wand_cast.use", {
            blendOutTime: 0.2,
            stopExpression: "!query.is_using_item || query.is_sneaking",
            controller: "wand_arm_cast"
        });
    } catch { }

    const remainingMana = currentMana - spellCost;
    player.onScreenDisplay.setActionBar(txt("ws.msg.cast", currentSlot + 1, color, spellText(spellId), spellCost, remainingMana, maxMana));

    // Mana is only written back to the item when the use button is released
    pendingManaUpdates.set(player.id, { slot, mana: remainingMana });
});

// Releasing or interrupting the wand stops the ray and commits the mana safely
world.afterEvents.itemReleaseUse.subscribe((event) => {
    stopChanneledLightningRay(event.source);
    applyPendingMana(event.source);
});

world.afterEvents.itemStopUse.subscribe((event) => {
    stopChanneledLightningRay(event.source);
    applyPendingMana(event.source);
});

world.beforeEvents.playerLeave.subscribe((event) => {
    stopChanneledLightningRay(event.player);
    applyPendingMana(event.player);
});
