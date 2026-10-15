import { world } from "@minecraft/server";
import { getSpellColor, consumeHeldItem , txt, spellText } from "../utils/common.js";

/**
 * Spell IDs the player has learned, in "ws:firebolt" form
 */
export function getPlayerKnownSpells(player) {
    const raw = player.getDynamicProperty("known_spells");
    if (!raw) return [];
    try {
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

/**
 * Teaches a spell to the player, with feedback.
 * Returns false if they already knew it.
 */
export function learnSpell(player, spellId) {
    const color = getSpellColor(spellId);
    const knownSpells = getPlayerKnownSpells(player);

    if (knownSpells.includes(spellId)) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.already_known", color, spellText(spellId)));
        player.playSound("note.bass", { pitch: 0.8, volume: 1.0 });
        return false;
    }

    knownSpells.push(spellId);
    player.setDynamicProperty("known_spells", JSON.stringify(knownSpells));

    // Arcane light show
    player.playSound("misc.discover_spell", { volume: 1.0 });
    player.playSound("random.levelup", { pitch: 1.2, volume: 1.0 });

    try {
        player.dimension.spawnParticle("minecraft:totem_particle", {
            x: player.location.x,
            y: player.location.y + 1.0,
            z: player.location.z
        });
        player.dimension.spawnParticle("minecraft:witch_spell_particle", {
            x: player.location.x,
            y: player.location.y + 1.2,
            z: player.location.z
        });
    } catch {}

    player.sendMessage(txt("ws.msg.spell_learned_chat", color, spellText(spellId), knownSpells.length));
    player.onScreenDisplay.setActionBar(txt("ws.msg.spell_learned", color, spellText(spellId)));
    return true;
}

/**
 * Learning happens when the player right-clicks a Spell Book
 */
world.afterEvents.itemUse.subscribe((event) => {
    const player = event.source;
    const item = event.itemStack;

    if (!item || !item.typeId.startsWith("ws:spell_book_")) {
        return;
    }

    const spellId = `ws:${item.typeId.replace("ws:spell_book_", "")}`;
    if (learnSpell(player, spellId)) {
        consumeHeldItem(player);
    }
});
