import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { SPELL_DEFINITIONS } from "../data/spells_data.js";
import { getPlayerKnownSpells, learnSpell } from "../spells/spell_learning.js";
import { getSpellColor, consumeHeldItem, txt, spellText } from "../utils/common.js";

// Negative effects cleared by the Purifying Elixir
const NEGATIVE_EFFECTS = [
    "poison", "wither", "weakness", "slowness", "mining_fatigue", "nausea",
    "blindness", "hunger", "darkness", "levitation", "fatal_poison", "bad_omen"
];

/**
 * Identification Scroll: decodes a spell scroll from the inventory and learns
 * the spell permanently. The scroll itself is not consumed.
 */
function useIdentificationScroll(player) {
    const inventory = player.getComponent("inventory")?.container;
    if (!inventory) return;
    const known = getPlayerKnownSpells(player);

    const candidates = [];
    for (let slot = 0; slot < inventory.size; slot++) {
        const it = inventory.getItem(slot);
        if (!it || !it.typeId.startsWith("ws:scroll_")) continue;
        const spellId = `ws:${it.typeId.replace("ws:scroll_", "")}`;
        if (SPELL_DEFINITIONS[spellId] && !known.includes(spellId) && !candidates.includes(spellId)) {
            candidates.push(spellId);
        }
    }

    if (candidates.length === 0) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.no_unknown_scroll"));
        player.playSound("note.bass", { pitch: 0.8, volume: 1.0 });
        return;
    }

    const form = new ActionFormData();
    form.title(txt("ws.ui.identify_title"));
    form.body(txt("ws.ui.identify_body"));
    for (const spellId of candidates) {
        const element = SPELL_DEFINITIONS[spellId].element;
        form.button(txt("ws.ui.spell_colored", getSpellColor(spellId), spellText(spellId)), `textures/items/spell_book_${element}.png`);
    }
    form.button(txt("ws.ui.cancel"));

    form.show(player).then((res) => {
        if (res.canceled) return;
        const spellId = candidates[res.selection];
        if (!spellId) return;

        const held = inventory.getItem(player.selectedSlotIndex);
        if (!held || held.typeId !== "ws:identification_scroll") {
        player.onScreenDisplay.setActionBar(txt("ws.msg.hold_identify"));
            return;
        }
        if (learnSpell(player, spellId)) {
            consumeHeldItem(player);
            player.playSound("misc.discover_spell", { volume: 1.0 });
        }
    });
}

world.afterEvents.itemUse.subscribe((event) => {
    if (event.itemStack?.typeId !== "ws:identification_scroll") return;
    const player = event.source;
    system.run(() => useIdentificationScroll(player));
});

/**
 * Purifying Elixir: clears every negative effect once drinking finishes
 */
world.afterEvents.itemCompleteUse.subscribe((event) => {
    if (event.itemStack?.typeId !== "ws:purifying_elixir") return;
    const player = event.source;

    let removed = 0;
    for (const effect of NEGATIVE_EFFECTS) {
        try {
            if (player.getEffect(effect)) {
                player.removeEffect(effect);
                removed++;
            }
        } catch { }
    }

    try { player.dimension.playSound("item.purifying_elixir.drink", player.location); } catch { }
    try {
        player.dimension.spawnParticle("minecraft:totem_particle", {
            x: player.location.x,
            y: player.location.y + 1.0,
            z: player.location.z
        });
    } catch { }
    player.onScreenDisplay.setActionBar(removed > 0 ? txt("ws.msg.purified", removed) : txt("ws.msg.already_pure"));
});
