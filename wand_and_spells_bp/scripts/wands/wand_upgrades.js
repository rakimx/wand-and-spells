import { world, system, Player } from "@minecraft/server";
import {
    getUpgradeLevel, getWandMana, getWandMaxMana, setWandMana, bankHeldWandMana, flushBankedMana
} from "./wand_data.js";
import { isWandItem } from "../utils/common.js";

const SIPHON_MANA_PER_LEVEL = 10;
const CONDENSER_MANA_PER_LEVEL = 2;   // por ciclo de 40 ticks (= 1 de mana/s por nível)
const CONDENSER_INTERVAL = 40;
const MELEE_DAMAGE_PER_LEVEL = 2;
const MOB_DROP_CHANCE = 0.02;

/**
 * Adds mana to a wand in the inventory.
 * A held wand goes to the bank instead: writing to the item mid-use would cancel the cast.
 */
function addManaToSlot(player, inventory, slot, amount) {
    const item = inventory.getItem(slot);
    if (!isWandItem(item)) return;
    const maxMana = getWandMaxMana(item);
    const mana = getWandMana(item);
    if (mana >= maxMana) return;

    if (slot === player.selectedSlotIndex) {
        bankHeldWandMana(player, slot, amount, maxMana, mana);
    } else {
        setWandMana(item, mana + amount);
        inventory.setItem(slot, item);
    }
}

// Condenser: slowly regenerates mana on every wand in the inventory
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const inventory = player.getComponent("inventory")?.container;
        if (!inventory) continue;

        // Flush the banked mana of a wand that stopped being held
        flushBankedMana(player, player.selectedSlotIndex);

        for (let slot = 0; slot < inventory.size; slot++) {
            const item = inventory.getItem(slot);
            if (!isWandItem(item)) continue;
            const level = getUpgradeLevel(item, "condenser");
            if (level > 0) {
                addManaToSlot(player, inventory, slot, CONDENSER_MANA_PER_LEVEL * level);
            }
        }
    }
}, CONDENSER_INTERVAL);

// Siphon: recovers mana on kills while holding the wand,
// plus rare spell book drops from hostile mobs (the mod's old mob_additions)
world.afterEvents.entityDie.subscribe((ev) => {
    const killer = ev.damageSource.damagingEntity;
    if (!(killer instanceof Player)) return;

    const dead = ev.deadEntity;
    let location;
    let dimension;
    try {
        location = dead.location;
        dimension = dead.dimension;
    } catch {
        return;
    }

    const inventory = killer.getComponent("inventory")?.container;
    const held = inventory?.getItem(killer.selectedSlotIndex);
    if (isWandItem(held)) {
        const level = getUpgradeLevel(held, "siphon");
        if (level > 0) {
            addManaToSlot(killer, inventory, killer.selectedSlotIndex, SIPHON_MANA_PER_LEVEL * level);
            try { dimension.spawnParticle("minecraft:totem_particle", { x: location.x, y: location.y + 1, z: location.z }); } catch { }
        }
    }

    let isMonster = false;
    try {
        isMonster = dead.getComponent("minecraft:type_family")?.hasTypeFamily("monster") ?? false;
    } catch { }
    if (isMonster && Math.random() < MOB_DROP_CHANCE) {
        try {
            dimension.runCommand(`loot spawn ${location.x.toFixed(2)} ${location.y.toFixed(2)} ${location.z.toFixed(2)} loot "entities/mob_additions"`);
        } catch { }
    }
});

// Melee: extra damage when hitting while holding the wand
world.afterEvents.entityHitEntity.subscribe((ev) => {
    const attacker = ev.damagingEntity;
    if (!(attacker instanceof Player)) return;
    const held = attacker.getComponent("inventory")?.container?.getItem(attacker.selectedSlotIndex);
    if (!isWandItem(held)) return;

    const level = getUpgradeLevel(held, "melee");
    if (level <= 0) return;

    const target = ev.hitEntity;
    try {
        // The base hit (1 damage) already landed; during invulnerability the game only applies the difference
        target.applyDamage(1 + MELEE_DAMAGE_PER_LEVEL * level, { cause: "entityAttack", damagingEntity: attacker });
        attacker.dimension.playSound("item.wand.melee", target.location, { volume: 0.8 });
    } catch { }
});
