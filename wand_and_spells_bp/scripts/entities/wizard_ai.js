import { world, system } from "@minecraft/server";
import { castLightningBeamBetween } from "../spells/spell_caster.js";
import { getSpellProps, ELEMENT_COLORS } from "../utils/common.js";

/**
 * Wizard combat.
 *
 * The ordinary shot (Magic Missile) comes from the entity itself, via the
 * minecraft:shooter component. What lives here is each wizard's elemental spell,
 * which needs script because that is how the addon implements spells, and the
 * missile damage, which the addon also applies by script.
 *
 * As in the mod, a wizard has one element and only casts from it.
 */

const INTERVAL = 20;              // verifica alvos a cada 1s
const RECHARGE_TICKS = 60;          // cada mago conjura no máximo a cada 3s
const RANGE = 18;

const lastSpell = new Map();   // id do mago -> tick da última conjuração

/** Rough position of the wizard's hand */
function spellOrigin(wizard) {
    const head = wizard.getHeadLocation();
    return { x: head.x, y: head.y - 0.2, z: head.z };
}

function center(entity) {
    try {
        const head = entity.getHeadLocation();
        return { x: entity.location.x, y: (entity.location.y + head.y) / 2, z: entity.location.z };
    } catch {
        return { x: entity.location.x, y: entity.location.y + 0.9, z: entity.location.z };
    }
}

function particles(dimension, loc, particle, count = 6) {
    try {
        for (let i = 0; i < count; i++) {
            dimension.spawnParticle(particle, {
                x: loc.x + (Math.random() - 0.5),
                y: loc.y + Math.random(),
                z: loc.z + (Math.random() - 0.5)
            });
        }
    } catch { }
}

/**
 * What each element does to the target. These mirror the addon's own spells,
 * pulling the numbers from the matching spell definitions.
 */
const SPELLS = {
    fire: (wizard, target) => {
        const props = getSpellProps("ws:firebolt");
        try { target.setOnFire(props.burn_duration ?? 5, true); } catch { }
        target.applyDamage(props.damage ?? 5, { cause: "fire", damagingEntity: wizard });
        particles(wizard.dimension, center(target), "minecraft:basic_flame_particle");
        return "spell.firebolt";
    },
    ice: (wizard, target) => {
        const props = getSpellProps("ws:freeze");
        target.addEffect("slowness", props.effect_duration ?? 200, { amplifier: props.effect_strength ?? 1 });
        target.applyDamage(props.damage ?? 3, { cause: "freezing", damagingEntity: wizard });
        particles(wizard.dimension, center(target), "minecraft:snowflake_particle");
        return "spell.freeze";
    },
    lightning: (wizard, target) => {
        const props = getSpellProps("ws:arc");
        castLightningBeamBetween(wizard.dimension, spellOrigin(wizard), center(target), target, props.damage ?? 3, wizard);
        return null; // o próprio raio já toca o som
    },
    earth: (wizard, target) => {
        const props = getSpellProps("ws:poison");
        target.addEffect("poison", props.effect_duration ?? 200, { amplifier: props.effect_strength ?? 0 });
        target.applyDamage(props.damage ?? 4, { cause: "magic", damagingEntity: wizard });
        particles(wizard.dimension, center(target), "minecraft:villager_angry", 4);
        return "spell.poison";
    },
    necromancy: (wizard, target) => {
        const props = getSpellProps("ws:decay");
        target.addEffect("wither", Math.min(props.effect_duration ?? 200, 200), { amplifier: 0 });
        particles(wizard.dimension, center(target), "minecraft:witch_spell_particle");
        return "spell.decay";
    },
    sorcery: (wizard, target) => {
        const props = getSpellProps("ws:magic_missile");
        target.applyDamage(props.damage ?? 7, { cause: "magic", damagingEntity: wizard });
        particles(wizard.dimension, center(target), "ws:magic_missile_sparkle");
        return "spell.magic_missile";
    },
    healing: (wizard) => {
        // A healing wizard patches itself up instead of attacking
        try {
            const vitality = wizard.getComponent("minecraft:health");
            if (vitality && vitality.currentValue < vitality.effectiveMax) {
                vitality.setCurrentValue(Math.min(vitality.effectiveMax, vitality.currentValue + (getSpellProps("ws:heal").health ?? 4)));
                particles(wizard.dimension, center(wizard), "minecraft:heart_particle", 4);
                return "spell.heal";
            }
        } catch { }
        return null;
    }
};

function conjure(wizard) {
    const target = wizard.target;
    if (!target || !target.isValid()) return;

    const separation = Math.hypot(
        target.location.x - wizard.location.x,
        target.location.y - wizard.location.y,
        target.location.z - wizard.location.z
    );
    if (separation > RANGE) return;

    const now = system.currentTick;
    if (now - (lastSpell.get(wizard.id) ?? -999) < RECHARGE_TICKS) return;
    lastSpell.set(wizard.id, now);

    let element = "sorcery";
    try {
        element = wizard.getProperty("ws:element") ?? "sorcery";
    } catch { }

    const spell = SPELLS[element] ?? SPELLS.sorcery;
    let sound;
    try {
        sound = spell(wizard, target);
    } catch { }

    particles(wizard.dimension, spellOrigin(wizard), "minecraft:witch_spell_particle", 4);
    if (sound) {
        try { wizard.dimension.playSound(sound, wizard.location, { volume: 0.9 }); } catch { }
    }
}

system.runInterval(() => {
    // Search near players, by family: sweeping all three dimensions every second
    // was expensive and tripped the watchdog.
    const seen = new Set();
    for (const player of world.getAllPlayers()) {
        let wizards;
        try {
            wizards = player.dimension.getEntities({
                location: player.location,
                maxDistance: 32,
                families: ["ws_wizard"]
            });
        } catch {
            continue;
        }
        for (const wizard of wizards) {
            if (seen.has(wizard.id)) continue;   // dois jogadores perto do mesmo mago
            seen.add(wizard.id);
            try {
                conjure(wizard);
            } catch { }
        }
    }

    // Drop the cooldown of wizards that already died
    if (lastSpell.size > 64) {
        for (const [id, tick] of lastSpell) {
            if (system.currentTick - tick > 1200) lastSpell.delete(id);
        }
    }
}, INTERVAL);

/**
 * A Magic Missile fired by a wizard also needs to deal damage:
 * the player's missile damage is applied by the caster, not by the entity.
 */
world.afterEvents.projectileHitEntity.subscribe((ev) => {
    let projectile;
    try {
        projectile = ev.projectile;
        if (!projectile || projectile.typeId !== "ws:magic_missile") return;
    } catch {
        return;
    }

    const shooter = ev.source;
    if (!shooter || (shooter.typeId !== "ws:evil_wizard" && shooter.typeId !== "ws:wizard")) return;

    const target = ev.getEntityHit()?.entity;
    if (!target || !target.isValid() || target.id === shooter.id) return;

    const damage = getSpellProps("ws:magic_missile").damage ?? 3;
    try {
        target.applyDamage(damage, { cause: "magic", damagingEntity: shooter });
        ev.dimension.spawnParticle("ws:magic_missile_hit", ev.location);
    } catch { }
});

/** Element colour in the wizard's name, as a hint of what it casts */
world.afterEvents.entitySpawn.subscribe((ev) => {
    const entity = ev.entity;
    if (!entity || (entity.typeId !== "ws:evil_wizard" && entity.typeId !== "ws:wizard")) return;
    system.run(() => {
        try {
            const element = entity.getProperty("ws:element");
            const tint = ELEMENT_COLORS[element] ?? "§f";
            if (!entity.nameTag) {
                const base = entity.typeId === "ws:wizard" ? "Mago" : "Mago Maligno";
                entity.nameTag = `${cor}${base}`;
            }
        } catch { }
    });
});
