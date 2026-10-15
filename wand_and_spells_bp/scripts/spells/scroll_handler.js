import { world } from "@minecraft/server";
import { executeSpell } from "./spell_caster.js";
import { SPELL_DEFINITIONS } from "../data/spells_data.js";
import { consumeHeldItem } from "../utils/common.js";

/**
 * Handles scrolls: single-use consumable spells
 */
world.afterEvents.itemUse.subscribe((event) => {
    const player = event.source;
    const item = event.itemStack;

    if (!item || !item.typeId.startsWith("ws:scroll_")) {
        return;
    }

    const spellRaw = item.typeId.replace("ws:scroll_", "");
    const spellId = `ws:${spellRaw}`;
    if (!SPELL_DEFINITIONS[spellId]) return;

    // Cast first: if the spell fails (Blink with no destination, say) the scroll is not spent
    const success = executeSpell(player, spellId, true);
    if (success === false) return;

    consumeHeldItem(player);

    // Tearing sound only; the visuals are up to the spell itself
    player.playSound("item.book.page_turn", { pitch: 1.2, volume: 1.0 });
});
