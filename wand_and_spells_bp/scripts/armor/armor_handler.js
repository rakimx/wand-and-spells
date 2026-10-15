import { world, system, EquipmentSlot } from "@minecraft/server";

// Set bonus per element. No particles here: the bonus is meant to be silent.
const ELEMENT_SET_BONUSES = {
    fire: {
        effect: "fire_resistance",
        amplifier: 0
    },
    ice: {
        effect: "resistance",
        amplifier: 0
    },
    lightning: {
        effect: "speed",
        amplifier: 0
    },
    earth: {
        effect: "strength",
        amplifier: 0
    },
    healing: {
        effect: "regeneration",
        amplifier: 0
    },
    necromancy: {
        effect: "resistance",
        amplifier: 0
    },
    sorcery: {
        effect: "jump_boost",
        amplifier: 1
    }
};

/**
 * Wizard armour pieces the player is currently wearing
 */
export function getEquippedWizardArmor(player) {
    const equippable = player.getComponent("equippable");
    if (!equippable) return { count: 0, elements: [] };

    const slots = [
        EquipmentSlot.Head,
        EquipmentSlot.Chest,
        EquipmentSlot.Legs,
        EquipmentSlot.Feet
    ];

    let count = 0;
    const elements = [];

    for (const slot of slots) {
        try {
            const item = equippable.getEquipment(slot);
            if (item && item.typeId.startsWith("ws:wizard_")) {
                count++;
                // Trailing element if there is one (ws:wizard_robe_fire -> fire)
                const parts = item.typeId.split("_");
                const possibleElement = parts[parts.length - 1];
                if (ELEMENT_SET_BONUSES[possibleElement]) {
                    elements.push(possibleElement);
                } else {
                    elements.push("neutral");
                }
            }
        } catch {}
    }

    return { count, elements };
}

// Full-set bonus is reapplied every 3 seconds
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const { count, elements } = getEquippedWizardArmor(player);

        if (count === 4) {
            const firstElem = elements[0];
            const isFullElemental = firstElem !== "neutral" && elements.every(e => e === firstElem);

            if (isFullElemental && ELEMENT_SET_BONUSES[firstElem]) {
                const bonus = ELEMENT_SET_BONUSES[firstElem];
                player.addEffect(bonus.effect, 80, { amplifier: bonus.amplifier, showParticles: false });
            } else {
                // Mixed or plain set: light arcane focus instead
                player.addEffect("regeneration", 80, { amplifier: 0, showParticles: false });
            }
        }
    }
}, 60);
