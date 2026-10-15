import { world, system, MolangVariableMap, ItemStack } from "@minecraft/server";
import { getSpellColor, getSpellProps, getSpellElement, isWandItem, spellText, txt } from "../utils/common.js";
import { loadStones } from "../blocks/transportation_stone.js";

/**
 * A que causa de dano cada elemento recorre.
 *
 * No Bedrock a armadura so desconta de certas causas. "magic" e "freezing"
 * furam-na por completo - era por isso que as magias batiam igual de ferro ou
 * de diamante. Aqui cada elemento aponta para uma causa que a armadura conta:
 * fogo e raio tem a sua propria, naturais; os outros vao por "entity_attack",
 * que e o golpe generico que a armadura e a Proteccao reduzem.
 *
 * Isto muda so a parte de dano cru. Os efeitos - a lentidao do gelo, o veneno,
 * o wither - vem de addEffect e continuam exactamente como estavam, por isso o
 * sabor de cada elemento mantem-se; o que muda e que a armadura passa a valer.
 */
const HURT_CAUSE = {
    fire: "fire",
    lightning: "lightning",
    ice: "entity_attack",
    earth: "entity_attack",
    sorcery: "entity_attack",
    necromancy: "entity_attack",
    healing: "entity_attack"
};

/** A causa de dano de um elemento, sempre uma que a armadura reduz */
function hurtCause(element) {
    return HURT_CAUSE[element] ?? "entity_attack";
}

/** A causa de dano da magia, pelo seu id */
function hurtCauseOf(spellId) {
    return hurtCause(getSpellElement(spellId));
}

/**
 * Channelled spells: they keep running while the player holds the use button
 */
export const CHANNELED_SPELLS = new Set(["ws:lightning_ray", "ws:arc", "ws:flame_ray", "ws:frost_ray", "ws:grapple"]);

/**
 * Spells that play their own cast sound instead of the generic spell.<id>
 */
const SELF_SOUND_SPELLS = new Set(["ws:magic_missile", "ws:fireball", "ws:blink", "ws:phase_step", "ws:lightning_ray", "ws:arc", "ws:thunderbolt", "ws:flame_ray", "ws:frost_ray"]);

/**
 * Continuous sound trio (start/loop/end), as in the original mod.
 * loopTicks is the length of the loop file, in ticks, so it can be re-fired seamlessly.
 */
const CHANNEL_SOUNDS = {
    "ws:lightning_ray": {
        start: "spell.lightning_ray.start",
        loop: "spell.lightning_ray.loop",
        end: "spell.lightning_ray.end",
        loopTicks: 42
    },
    "ws:flame_ray": {
        start: "spell.flame_ray.start",
        loop: "spell.flame_ray.loop",
        end: "spell.flame_ray.end",
        loopTicks: 290
    },
    "ws:frost_ray": {
        start: "spell.frost_ray.start",
        loop: "spell.frost_ray.loop",
        end: "spell.frost_ray.end",
        loopTicks: 160
    }
};
const CHANNEL_LOOP_TICKS = 42;

/**
 * How each channelled ray draws itself and what it does to the target.
 * The elemental ones have no model, so they come out as a particle beam.
 */
const RAY_STYLES = {
    "ws:lightning_ray": { usesEntity: true, impact: "ws:lightning_spark" },
    "ws:arc": { usesEntity: true, impact: "ws:lightning_spark" },
    "ws:flame_ray": {
        usesEntity: false,
        feixe: "ws:flame_ray_beam",
        impact: "minecraft:basic_flame_particle",
        aoAcertar: (target, props) => { target.setOnFire(props.burn_duration ?? 10, true); }
    },
    "ws:frost_ray": {
        usesEntity: false,
        feixe: "ws:frost_ray_beam",
        impact: "minecraft:snowflake_particle",
        aoAcertar: (target, props) => {
            target.addEffect("slowness", props.effect_duration ?? 200, {
                amplifier: props.effect_strength ?? 0,
                showParticles: true
            });
        }
    }
};

function rayStyle(spellId) {
    return RAY_STYLES[spellId] ?? RAY_STYLES["ws:lightning_ray"];
}

/**
 * Draws a beam of particles between two points
 */
function drawBeam(dimension, begin, finish, particle, step = 0.6) {
    const dx = finish.x - begin.x;
    const dy = finish.y - begin.y;
    const dz = finish.z - begin.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.2) return;
    try {
        for (let d = 0.35; d < dist; d += step) {
            const f = d / dist;
            dimension.spawnParticle(particle, {
                x: begin.x + dx * f,
                y: begin.y + dy * f,
                z: begin.z + dz * f
            });
        }
    } catch { }
}

/**
 * Default multipliers, for scrolls and wands with no upgrades
 */
const DEFAULT_MODIFIERS = { range: 1, duration: 1, blast: 1 };

/**
 * Default query filter for combat targets, leaving out dropped items and XP orbs
 */
const COMBAT_TARGET_FILTER = {
    excludeFamilies: ["inanimate", "lightning_ray", "item"],
    excludeTypes: ["minecraft:item", "minecraft:xp_orb", "ws:lightning_ray", "ws:lightning_hammer", "ws:ground_rune"]
};

/**
 * Whether an entity is a valid combat target (living mobs and other players).
 * Dropped items, orbs, projectiles and decorations can never be aimed at or damaged.
 * @param {Entity} entity
 * @param {Player} [sourcePlayer]
 * @returns {boolean}
 */
function isValidCombatTarget(entity, sourcePlayer = null) {
    if (!entity || !entity.isValid()) return false;

    // Never hits the caster. If the owner reference is already dead (they left the world
    // while the hammer or sigil was still running), the safe call is to hit no player at all.
    if (sourcePlayer) {
        try {
            if (entity.id === sourcePlayer.id) return false;
        } catch {
            if (entity.typeId === "minecraft:player") return false;
        }
    }

    const typeId = entity.typeId;

    // Never dropped items, experience orbs or the ray itself
    if (typeId === "minecraft:item" || typeId === "minecraft:xp_orb" || typeId === "ws:lightning_ray") {
        return false;
    }

    // Skip projectiles in flight
    if (typeId.includes("arrow") || typeId.includes("trident") || typeId.includes("snowball") ||
        typeId.includes("potion") || typeId.includes("projectile") || typeId.includes("orb") ||
        typeId.includes("egg") || typeId.includes("missile") || typeId.includes("fireball") ||
        typeId.includes("wind_charge")) {
        return false;
    }

    // Skip armour stands, frames, paintings, leads, effect clouds, lightning and vehicles
    if (typeId === "minecraft:armor_stand" || typeId === "minecraft:painting" ||
        typeId === "minecraft:item_frame" || typeId === "minecraft:glow_item_frame" ||
        typeId === "minecraft:leash_knot" || typeId === "minecraft:area_effect_cloud" ||
        typeId === "minecraft:lightning_bolt" || typeId.includes("boat") || typeId.includes("minecart")) {
        return false;
    }

    // Must be a living entity with a health component (dropped items have none)
    try {
        const health = entity.getComponent("minecraft:health");
        if (!health || health.currentValue <= 0) return false;
    } catch {
        return false;
    }

    return true;
}

/**
 * Knockback that works with both the old (1.x) and new (2.x) API signatures
 */
function knockback(entity, dirX, dirZ, horizontal, vertical) {
    try {
        entity.applyKnockback(dirX, dirZ, horizontal, vertical);
    } catch {
        try {
            entity.applyKnockback({ x: dirX * horizontal, z: dirZ * horizontal }, vertical);
        } catch { }
    }
}

/**
 * Finds what the player is aiming at: combat entities first, then blocks.
 * Returns { entity, location }, or { location: null } when nothing is in range.
 */
function findAimTarget(player, maxRange) {
    try {
        const hits = player.getEntitiesFromViewDirection({ maxDistance: maxRange, ...COMBAT_TARGET_FILTER });
        for (const hit of hits) {
            if (hit.entity && isValidCombatTarget(hit.entity, player)) {
                return { entity: hit.entity, location: getEntityCenter(hit.entity) };
            }
        }
    } catch { }

    try {
        const rayBlock = player.getBlockFromViewDirection({ maxDistance: maxRange });
        if (rayBlock && rayBlock.block) {
            const loc = rayBlock.block.location;
            return {
                block: rayBlock.block,
                face: rayBlock.face,
                location: {
                    x: loc.x + rayBlock.faceLocation.x,
                    y: loc.y + rayBlock.faceLocation.y,
                    z: loc.z + rayBlock.faceLocation.z
                }
            };
        }
    } catch { }

    return { location: null };
}

/**
 * Electric spark wrapping the target, scaled to its size.
 *
 * Height comes from the gap between head and feet, which is how the API measures a mob.
 * It goes to the particle as the scale variable, which drives emitter radius, count and
 * spark size, so a chicken does not get the same effect as a ravager.
 */
function sparkOnTarget(dimension, entity) {
    let height = 1;
    try {
        const measure = entity.getHeadLocation().y - entity.location.y;
        if (Number.isFinite(measure) && measure > 0.1) height = Math.max(0.4, Math.min(3, measure));
    } catch { }

    const vars = new MolangVariableMap();
    vars.setFloat("scale", height);

    const loc = entity.location;
    dimension.spawnParticle("ws:lightning_spark", { x: loc.x, y: loc.y + height * 0.5, z: loc.z }, vars);
}

function getEntityCenter(entity) {
    let y = entity.location.y + 0.9;
    try {
        const head = entity.getHeadLocation();
        if (head) y = (entity.location.y + head.y) / 2;
    } catch { }
    return { x: entity.location.x, y, z: entity.location.z };
}

// ------------------------------------------------------------------ Fireskin

// Players with Fireskin up: id -> { until: last tick, burn: seconds of fire on the attacker }
const activeFireskin = new Map();

world.afterEvents.entityHurt.subscribe((ev) => {
    const data = activeFireskin.get(ev.hurtEntity.id);
    if (!data) return;
    if (system.currentTick > data.until) {
        activeFireskin.delete(ev.hurtEntity.id);
        return;
    }
    const attacker = ev.damageSource.damagingEntity;
    if (attacker && attacker.id !== ev.hurtEntity.id && attacker.isValid()) {
        try { attacker.setOnFire(data.burn, true); } catch { }
    }
});

// ------------------------------------------------------------------ Casting

/**
 * Runs the effects of any spell, cast from a wand or from a scroll
 * @param {Player} player - who is casting
 * @param {string} spellId - the spell id, e.g. ws:firebolt
 * @param {boolean} isScroll - true when it came from a single-use scroll
 * @param {{range:number,duration:number,blast:number}} modifiers - wand upgrade multipliers
 * @returns {boolean} false when the spell failed, so no mana or scroll is spent
 */
export function executeSpell(player, spellId, isScroll = false, modifiers = DEFAULT_MODIFIERS) {
    const color = getSpellColor(spellId);
    const props = getSpellProps(spellId);

    // Action bar feedback, scrolls only.
    //
    // This used to read a spellName that was never declared anywhere, so every
    // scroll threw here before it reached the switch below - no scroll worked
    // at all. The name has to come through as a nested translate, the way
    // learnSpell builds it, or the player sees the raw lang key instead of the
    // spell in their own language.
    if (isScroll) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.scroll_cast", color, spellText(spellId)));
    }

    const headLoc = player.getHeadLocation();
    const viewDir = player.getViewDirection();
    const duration = (ticks) => Math.round(ticks * modifiers.duration);
    const range = (blocks) => blocks * modifiers.range;

    let success = true;

    switch (spellId) {
        // --- TELEPORTS ---
        case "ws:blink":
            success = castBlink(player, headLoc, viewDir, range(props.range ?? 25));
            break;

        case "ws:phase_step":
            success = castPhaseStep(player, viewDir, range(props.range ?? 8));
            break;

        // --- HEALING AND SUPPORT ---
        case "ws:heal":
        case "ws:greater_heal":
            success = castHeal(player, props.health ?? 4);
            break;

        case "ws:agility":
            player.addEffect("speed", duration(props.speed_duration ?? 600), { amplifier: props.speed_strength ?? 1, showParticles: true });
            player.addEffect("jump_boost", duration(props.jump_boost_duration ?? 600), { amplifier: props.jump_boost_strength ?? 1, showParticles: true });
            try {
                player.dimension.spawnParticle("minecraft:villager_happy", player.location);
            } catch { }
            break;

        case "ws:fire_resistance":
            player.addEffect("fire_resistance", duration(props.fire_resistance_duration ?? 600), { amplifier: props.fire_resistance_strength ?? 0, showParticles: true });
            try {
                player.dimension.spawnParticle("minecraft:basic_flame_particle", player.location);
            } catch { }
            break;

        case "ws:fireskin": {
            // Fire immune, and sets alight whoever attacks the wizard
            const ticks = duration(props.fireskin_duration ?? 600);
            player.addEffect("fire_resistance", ticks, { amplifier: props.fireskin_strength ?? 0, showParticles: true });
            activeFireskin.set(player.id, { until: system.currentTick + ticks, burn: props.burn_duration ?? 5 });
            try {
                for (let i = 0; i < 8; i++) {
                    player.dimension.spawnParticle("minecraft:basic_flame_particle", {
                        x: player.location.x + (Math.random() - 0.5),
                        y: player.location.y + Math.random() * 1.8,
                        z: player.location.z + (Math.random() - 0.5)
                    });
                }
            } catch { }
            break;
        }

        case "ws:invisibility":
            player.addEffect("invisibility", duration(props.invisibility_duration ?? 600), { amplifier: props.invisibility_strength ?? 0, showParticles: true });
            try {
                player.dimension.spawnParticle("minecraft:witch_spell_particle", player.location);
            } catch { }
            break;

        case "ws:water_breathing":
            player.addEffect("water_breathing", duration(props.water_breathing_duration ?? 1200), { amplifier: props.water_breathing_strength ?? 0, showParticles: true });
            break;

        case "ws:frost_step":
            success = castFrostStep(player, props, modifiers);
            break;

        case "ws:forcefield":
            success = castForcefield(player, props, modifiers);
            break;

        case "ws:ice_spikes":
            success = castIceSpikes(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:meteor":
            success = castMeteor(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:earthquake":
            success = castEarthquake(player, props, modifiers);
            break;

        case "ws:plague_of_darkness":
            success = castPlagueOfDarkness(player, props, modifiers);
            break;

        case "ws:summon_zombie":
            success = castSummon(player, "ws:zombie_minion", props, modifiers);
            break;

        case "ws:summon_skeleton":
            success = castSummon(player, "ws:skeleton_minion", props, modifiers);
            break;

        case "ws:summon_lightning_wraith":
            success = castSummon(player, "ws:lightning_wraith", props, modifiers);
            break;

        case "ws:conjure_sword":
            success = castConjureSword(player, props, modifiers);
            break;

        case "ws:ice_age":
            success = castIceAge(player, props, modifiers);
            break;

        case "ws:resurrection":
            success = castResurrection(player, props, modifiers);
            break;

        case "ws:darkvision":
            player.addEffect("night_vision", duration(props.night_vision_duration ?? 900), { amplifier: props.night_vision_strength ?? 0, showParticles: false });
            break;

        case "ws:replenish_hunger":
        case "ws:satiety":
            // Instant saturation: each level restores one hunger point
            player.addEffect("saturation", 1, { amplifier: Math.max(0, (props.hunger_points ?? 6) - 1), showParticles: true });
            break;

        // --- ATTACKS AND PROJECTILES ---
        case "ws:magic_missile":
            castMagicMissile(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:fireball":
            castFireball(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:firebolt":
            castFireProjectile(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:lightning_ray":
        case "ws:arc":
        case "ws:flame_ray":
        case "ws:frost_ray":
            castLightningRay(player, viewDir, spellId, modifiers);
            break;

        case "ws:thunderbolt":
            castThunderbolt(player, viewDir, props, modifiers);
            break;

        case "ws:lightning_bolt":
            success = castLightningBolt(player, range(props.range ?? 40));
            break;

        case "ws:lightning_hammer":
            success = castLightningHammer(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:ice_shard":
            castIceShard(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:freeze":
            castFreeze(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:snowball":
            launchProjectile(player, "minecraft:snowball", spawnInFront(headLoc, viewDir, 1.5), viewDir, 2.0, range(props.range ?? 15), "minecraft:snowflake_particle", {
                onHitEntity: (target, loc, dim) => {
                    if (target && isValidCombatTarget(target, player)) {
                        target.applyDamage(2, { cause: "projectile", damagingEntity: player });
                        target.addEffect("slowness", 60, { amplifier: 0, showParticles: true });
                    }
                    try { dim.spawnParticle("minecraft:snowflake_particle", loc); } catch { }
                },
                onHitBlock: (loc, dim) => {
                    try { dim.spawnParticle("minecraft:snowflake_particle", loc); } catch { }
                }
            });
            break;

        case "ws:wither_skull":
            launchProjectile(player, "minecraft:wither_skull", spawnInFront(headLoc, viewDir, 1.5), viewDir, 1.6, range(20), "minecraft:witch_spell_particle", {
                onHitEntity: (target) => {
                    if (target && isValidCombatTarget(target, player)) {
                        target.addEffect("wither", duration(200), { amplifier: 1, showParticles: true });
                    }
                }
            });
            break;

        // --- SINGLE TARGET ---
        case "ws:ignite":
            success = castIgnite(player, props, modifiers);
            break;

        case "ws:poison":
            success = castAimedEffect(player, range(props.range ?? 10), (target) => {
                target.applyDamage(props.damage ?? 1, { cause: "entity_attack", damagingEntity: player });
                target.addEffect("poison", duration(props.effect_duration ?? 200), { amplifier: props.effect_strength ?? 1, showParticles: true });
            }, "minecraft:villager_angry");
            break;

        case "ws:wither":
            success = castAimedEffect(player, range(props.range ?? 10), (target) => {
                target.applyDamage(props.damage ?? 1, { cause: "entity_attack", damagingEntity: player });
                target.addEffect("wither", duration(props.effect_duration ?? 200), { amplifier: props.effect_strength ?? 1, showParticles: true });
            }, "minecraft:witch_spell_particle");
            break;

        case "ws:snare":
            success = castSnare(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:life_drain":
            success = castLifeDrain(player, props, modifiers);
            break;

        case "ws:mind_trick":
            success = castMindTrick(player, props, modifiers);
            break;

        case "ws:decay":
            success = castDecay(player, headLoc, viewDir, props, modifiers);
            break;

        // --- LIGHTNING ---
        case "ws:lightning_pulse":
            success = castLightningPulse(player, props, modifiers);
            break;

        case "ws:chain_lightning":
            success = castChainLightning(player, props, modifiers);
            break;

        case "ws:charge":
            success = castCharge(player, viewDir, props, modifiers);
            break;

        // --- SUPPORT ---
        case "ws:ward":
            player.addEffect("resistance", duration(props.ward_duration ?? 600), { amplifier: props.ward_strength ?? 0, showParticles: false });
            break;

        case "ws:cure_effects":
            success = castCureEffects(player);
            break;

        case "ws:heal_ally":
            success = castHealAlly(player, props, modifiers);
            break;

        case "ws:ice_shroud": {
            // Slow immune, and freezes whoever attacks the wizard
            const ticks = duration(props.ice_shroud_duration ?? 600);
            player.addEffect("resistance", ticks, { amplifier: props.ice_shroud_strength ?? 0, showParticles: false });
            activeIceShroud.set(player.id, {
                until: system.currentTick + ticks,
                slow: duration(props.effect_duration ?? 100),
                strength: props.effect_strength ?? 0
            });
            frostSpark(player.dimension, player);
            break;
        }

        // --- MOVEMENT AND UTILITY ---
        case "ws:leap":
            success = castLeap(player, viewDir, props);
            break;

        case "ws:gust":
            success = castGust(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:wind_step":
            success = castWindStep(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:grapple":
            success = castGrapple(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:mine":
            success = castMine(player, props, modifiers);
            break;

        case "ws:light":
            success = castLight(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:fangs":
            success = castFangs(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:transportation":
            success = castTransportation(player, props, modifiers);
            break;

        // --- SIGILS AND CONSTRUCTS ---
        case "ws:fire_sigil":
        case "ws:frost_sigil":
        case "ws:lightning_sigil":
            success = castSigil(player, headLoc, viewDir, spellId, props, modifiers);
            break;

        case "ws:ring_of_fire":
            success = castRingOfFire(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:healing_aura":
            success = castHealingAura(player, props, modifiers);
            break;

        case "ws:black_hole":
            success = castBlackHole(player, headLoc, viewDir, props, modifiers);
            break;

        case "ws:tornado":
            success = castTornado(player, headLoc, viewDir, props, modifiers);
            break;

        default:
            // A spell that is defined but has no branch yet. It has to report
            // failure: success starts true, so without this the caster paid the
            // mana and sat through the cooldown for a puff of particles and
            // nothing else - a hundred and fifty mana, on the master spells.
            success = false;
            try {
                player.dimension.spawnParticle("minecraft:witch_spell_particle", {
                    x: headLoc.x + viewDir.x * 1.5,
                    y: headLoc.y + viewDir.y * 1.5,
                    z: headLoc.z + viewDir.z * 1.5
                });
            } catch { }
            break;
    }

    // Themed sound on success, and only for spells that do not play their own
    if (success && !SELF_SOUND_SPELLS.has(spellId)) {
        const spellSound = spellId.replace("ws:", "spell.");
        try { player.dimension.playSound(spellSound, player.location, { volume: 1.0 }); } catch { }
    }

    return success;
}

// ------------------------------------------------------------------ Healing

/**
 * Direct heal, as in the mod. Fails when health is already full.
 */
function castHeal(player, amount) {
    const health = player.getComponent("minecraft:health");
    if (!health) return false;
    if (health.currentValue >= health.effectiveMax) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.health_full" });
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        return false;
    }
    health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + amount));
    try {
        for (let i = 0; i < 5; i++) {
            player.dimension.spawnParticle("minecraft:heart_particle", {
                x: player.location.x + (Math.random() - 0.5),
                y: player.location.y + 1.0 + Math.random() * 0.8,
                z: player.location.z + (Math.random() - 0.5)
            });
        }
    } catch { }
    return true;
}

// ------------------------------------------------------------------ Projectiles

// Spell projectiles in flight: id -> { onHitEntity(entity, projectileLoc), onHitBlock(loc) }
const trackedProjectiles = new Map();

/**
 * Fires a projectile with an owner, trails particles and removes it past its range
 */
function launchProjectile(player, typeId, spawnPos, viewDir, speed, maxRange, trailParticle, handlers) {
    const dimension = player.dimension;
    let projectile;
    try {
        projectile = dimension.spawnEntity(typeId, spawnPos);
    } catch (e) {
        console.warn(`Aviso ao spawnar ${typeId}: ${e}`);
        return null;
    }

    try {
        const rot = player.getRotation();
        projectile.setRotation({ x: rot.x, y: rot.y });
    } catch { }

    const velocity = { x: viewDir.x * speed, y: viewDir.y * speed, z: viewDir.z * speed };
    const proj = projectile.getComponent("minecraft:projectile");
    let shot = false;
    if (proj) {
        try { proj.owner = player; } catch { }
        try {
            proj.shoot(velocity, { uncertainty: 0 });
            shot = true;
        } catch { }
    }
    if (!shot) {
        try { projectile.applyImpulse(velocity); } catch { }
    }

    const id = projectile.id;
    trackedProjectiles.set(id, handlers);

    let prevLoc = { ...spawnPos };
    const runId = system.runInterval(() => {
        if (!projectile.isValid()) {
            system.clearRun(runId);
    // Keep the data around a few ticks: the impact event can arrive later
            system.runTimeout(() => trackedProjectiles.delete(id), 5);
            return;
        }
        try {
            const curLoc = projectile.location;
            if (trailParticle) {
                for (let step = 0; step <= 2; step++) {
                    const t = step / 2;
                    dimension.spawnParticle(trailParticle, {
                        x: prevLoc.x + (curLoc.x - prevLoc.x) * t,
                        y: prevLoc.y + (curLoc.y - prevLoc.y) * t,
                        z: prevLoc.z + (curLoc.z - prevLoc.z) * t
                    });
                }
            }
            prevLoc = { x: curLoc.x, y: curLoc.y, z: curLoc.z };

            const traveled = Math.hypot(curLoc.x - spawnPos.x, curLoc.y - spawnPos.y, curLoc.z - spawnPos.z);
            if (traveled > maxRange) {
                system.clearRun(runId);
                trackedProjectiles.delete(id);
                projectile.remove();
            }
        } catch { }
    }, 1);

    return projectile;
}

world.afterEvents.projectileHitEntity.subscribe((ev) => {
    let id;
    try { id = ev.projectile.id; } catch { return; }
    const handlers = trackedProjectiles.get(id);
    if (!handlers) return;
    trackedProjectiles.delete(id);
    const hit = ev.getEntityHit()?.entity;
    try { handlers.onHitEntity?.(hit, ev.location, ev.dimension); } catch { }
});

world.afterEvents.projectileHitBlock.subscribe((ev) => {
    let id;
    try { id = ev.projectile.id; } catch { return; }
    const handlers = trackedProjectiles.get(id);
    if (!handlers) return;
    trackedProjectiles.delete(id);
    try { handlers.onHitBlock?.(ev.location, ev.dimension); } catch { }
});

function spawnInFront(headLoc, viewDir, distance) {
    return {
        x: headLoc.x + viewDir.x * distance,
        y: headLoc.y + viewDir.y * distance,
        z: headLoc.z + viewDir.z * distance
    };
}

/**
 * Magic Missile: projectile with no gravity.
 * Damage and range come from the spell properties; the shot sound plays once.
 * The trail is not drawn here. The entity emits it itself through
 * animation.ws.magic_missile.move, which fires the sparkle effect every tick,
 * so the trail tracks the missile exactly and also works for wizards, who fire
 * the same projectile through the shooter component without touching script.
 */
function castMagicMissile(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const spawnPos = spawnInFront(headLoc, viewDir, 1.6);
    const damage = props.damage ?? 3;

    try { dimension.playSound("spell.magic_missile", spawnPos, { volume: 1.0, pitch: 1.0 }); } catch { }

    const missile = launchProjectile(player, "ws:magic_missile", spawnPos, viewDir, 1.2, (props.range ?? 18) * modifiers.range, null, {
        onHitEntity: (target, loc, dim) => {
            try { dim.spawnParticle("ws:magic_missile_hit", loc); } catch { }
            if (target && isValidCombatTarget(target, player)) {
                target.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
                knockback(target, viewDir.x, viewDir.z, 0.3, 0.1);
            }
        },
        onHitBlock: (loc, dim) => {
            try { dim.spawnParticle("ws:magic_missile_hit", loc); } catch { }
        }
    });

    if (!missile) {
        try { dimension.spawnParticle("ws:magic_missile_sparkle", spawnPos); } catch { }
    }
}

/**
 * Fireball: its own projectile, with the mod's texture and effects.
 * As with the magic missile, the flame trail is not drawn here: the entity
 * emits it through animation.ws.fireball.move, every tick.
 */
function castFireball(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const spawnPos = spawnInFront(headLoc, viewDir, 1.6);
    const damage = props.damage ?? 5;
    const burn = Math.round((props.burn_duration ?? 5) * modifiers.duration);

    try { dimension.playSound("spell.fireball", spawnPos, { volume: 1.0, pitch: 1.0 }); } catch { }

    const impact = (loc, dim) => {
        try { dim.spawnParticle("ws:fireball_hit", loc); } catch { }
        try { dim.playSound("entity.firebolt.hit", loc, { volume: 0.9 }); } catch { }
        // Vanilla smoke over the flames, like the mod's burst
        for (let i = 0; i < 4; i++) {
            try {
                dim.spawnParticle("minecraft:basic_smoke_particle", {
                    x: loc.x + (Math.random() - 0.5) * 0.6,
                    y: loc.y + Math.random() * 0.5,
                    z: loc.z + (Math.random() - 0.5) * 0.6
                });
            } catch { }
        }
    };

    const ball = launchProjectile(player, "ws:fireball", spawnPos, viewDir, 1.5, (props.range ?? 20) * modifiers.range, null, {
        onHitEntity: (target, loc, dim) => {
            impact(loc, dim);
            if (target && isValidCombatTarget(target, player)) {
        // Fire damage, so anything fire immune walks away clean, as in the mod
                target.applyDamage(damage, { cause: "fire", damagingEntity: player });
                try { target.setOnFire(burn, true); } catch { }
            }
        },
        onHitBlock: (loc, dim) => impact(loc, dim)
    });

    if (!ball) {
        try { dimension.spawnParticle("ws:fireball_hit", spawnPos); } catch { }
    }
}

/**
 * Firebolt: small vanilla fireball (damage 5, same as the mod).
 * Burn time and range come from the spell properties.
 */
function castFireProjectile(player, headLoc, viewDir, props, modifiers) {
    const burn = Math.round((props.burn_duration ?? 5) * modifiers.duration);
    launchProjectile(player, "minecraft:small_fireball", spawnInFront(headLoc, viewDir, 1.5), viewDir, 1.8, (props.range ?? 15) * modifiers.range, null, {
        onHitEntity: (target) => {
            if (target && isValidCombatTarget(target, player)) {
                try { target.setOnFire(burn, true); } catch { }
            }
        }
    });
}

/**
 * Ice Shard: projectile that deals damage and slows on hit
 */
function castIceShard(player, headLoc, viewDir, props, modifiers) {
    const damage = props.damage ?? 6;
    const slowTicks = Math.round((props.effect_duration ?? 200) * modifiers.duration);
    const slowStrength = props.effect_strength ?? 0;

    launchProjectile(player, "minecraft:snowball", spawnInFront(headLoc, viewDir, 1.5), viewDir, 2.2, (props.range ?? 15) * modifiers.range, "minecraft:snowflake_particle", {
        onHitEntity: (target, loc, dim) => {
            try { dim.playSound("entity.ice_shard.hit", loc); } catch { }
            if (target && isValidCombatTarget(target, player)) {
                target.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
                target.addEffect("slowness", slowTicks, { amplifier: slowStrength, showParticles: true });
            }
        },
        onHitBlock: (loc, dim) => {
            try { dim.playSound("entity.ice_shard.smash", loc); } catch { }
        }
    });
}

// ------------------------------------------------------------------ Instant rays

/**
 * Freeze: instant ray at whatever is aimed at. Damages and slows the target;
 * water becomes ice and lava becomes obsidian (flowing lava becomes cobblestone).
 */
function castFreeze(player, headLoc, viewDir, props, modifiers) {
    const maxRange = (props.range ?? 10) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const end = target.location ?? spawnInFront(headLoc, viewDir, maxRange);

    // Snowflake trail up to the target
    try {
        const dist = Math.hypot(end.x - headLoc.x, end.y - headLoc.y, end.z - headLoc.z);
        for (let d = 1; d < dist; d += 0.8) {
            player.dimension.spawnParticle("minecraft:snowflake_particle", spawnInFront(headLoc, viewDir, d));
        }
    } catch { }

    if (target.entity) {
        target.entity.addEffect("slowness", Math.round((props.effect_duration ?? 200) * modifiers.duration), {
            amplifier: props.effect_strength ?? 1,
            showParticles: true
        });
        target.entity.applyDamage(props.damage ?? 3, { cause: "entity_attack", damagingEntity: player });
    } else if (target.block) {
        freezeLiquidNear(player.dimension, target.block);
    }
}

function freezeLiquidNear(dimension, block) {
    const candidates = [block];
    try { candidates.push(block.above()); } catch { }
    for (const b of candidates) {
        if (!b) continue;
        try {
            if (b.typeId === "minecraft:water" || b.typeId === "minecraft:flowing_water") {
                b.setType("minecraft:ice");
                return;
            }
            if (b.typeId === "minecraft:lava" || b.typeId === "minecraft:flowing_lava") {
                const depth = b.permutation.getState("liquid_depth") ?? 0;
                b.setType(depth === 0 ? "minecraft:obsidian" : "minecraft:cobblestone");
                return;
            }
        } catch { }
    }
}

/**
 * Thunderbolt: instant electric discharge at the aimed target,
 * with damage and knockback from the spell properties
 */
function castThunderbolt(player, viewDir, props, modifiers) {
    const maxRange = (props.range ?? 12) * modifiers.range;
    const startLoc = getWandTipLocation(player);
    const target = findAimTarget(player, maxRange);
    const end = target.location ?? {
        x: startLoc.x + viewDir.x * maxRange,
        y: startLoc.y + viewDir.y * maxRange,
        z: startLoc.z + viewDir.z * maxRange
    };

    castLightningBeamBetween(player.dimension, startLoc, end, target.entity ?? null, props.damage ?? 3, player);
    if (target.entity && isValidCombatTarget(target.entity, player)) {
        knockback(target.entity, viewDir.x, viewDir.z, props.knockback_strength ?? 0.2, 0.1);
        try { player.dimension.playSound("entity.thunderbolt.hit", end); } catch { }
    }
}

/**
 * Lightning Bolt: calls lightning down exactly on the aimed point, entity or block
 */
function castLightningBolt(player, maxRange) {
    const target = findAimTarget(player, maxRange);
    if (!target.location) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_target" });
        return false;
    }
    const strikeLoc = target.entity ? target.entity.location : target.location;
    try {
        player.dimension.spawnEntity("minecraft:lightning_bolt", strikeLoc);
    } catch {
        return false;
    }
    return true;
}

// ------------------------------------------------------------------ Teleports

/**
 * Blink: teleports the wizard up to the spell range in the direction they face
 */
function castBlink(player, headLoc, viewDir, maxRange) {
    const dimension = player.dimension;

    // Raycast for the block surface
    let dest = null;
    try {
        const hitResult = dimension.getBlockFromRay(headLoc, viewDir, {
            maxDistance: maxRange,
            includeLiquidBlocks: false,
            includePassableBlocks: false
        });

        if (hitResult && hitResult.block) {
            const block = hitResult.block;
            const bLoc = block.location;
            const face = hitResult.face; // "Up", "Down", "North", "South", "East", "West"

            let offsetX = 0;
            let offsetY = 0;
            let offsetZ = 0;

            if (face === "Up") {
                offsetY = 1.0;
            } else if (face === "Down") {
                offsetY = -2.0;
            } else if (face === "North") {
                offsetZ = -0.6;
            } else if (face === "South") {
                offsetZ = 0.6;
            } else if (face === "West") {
                offsetX = -0.6;
            } else if (face === "East") {
                offsetX = 0.6;
            }

            dest = {
                x: bLoc.x + 0.5 + offsetX,
                y: bLoc.y + offsetY,
                z: bLoc.z + 0.5 + offsetZ
            };
        }
    } catch { }

    // As in the mod: with no block or surface in range the spell fizzles, costing nothing
    if (!dest) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_destination" });
        return false;
    }

    const originLoc = { x: player.location.x, y: player.location.y, z: player.location.z };

    // Sound at the departure point, only after the destination checks out.
    // No particles: as in the mod, Blink announces itself with a flash on the caster's
    // screen, not with an effect in the world.
    try {
        dimension.playSound("spell.blink", originLoc, { volume: 1.0 });
    } catch { }

    try {
        player.teleport(dest, {
            dimension: dimension,
            rotation: { x: player.getRotation().x, y: player.getRotation().y },
            keepVelocity: false
        });
    } catch {
        try { player.teleport(dest); } catch { }
    }

    // Arrival: quiet sound and the white flash on screen
    try {
        player.playSound("mob.endermen.portal", { pitch: 1.2, volume: 0.8 });
    } catch { }
    flash(player);

    return true;
}

/**
 * Teleport flash: strong white at the edges, almost nothing in the middle.
 *
 * The art is the mod's blink_overlay texture, which already carries that vignette in
 * its alpha channel (alpha 2 at the centre, 255 at the edge). It is shown as a particle
 * right in front of the eyes, facing the camera, which covers the view without touching
 * the game UI. That is why we do not use a camera fade, which whitens the whole screen evenly.
 *
 * One short particle per tick, repositioned every frame to follow the head, with the
 * strength falling to zero. Seven ticks, a little over a third of a second.
 */
function flash(player) {
    // The overlay lives in the UI (ui/hud_screen.json), in three opacity layers.
    // The trigger is the title text: one, two or three spaces. A space draws no glyph,
    // so it works as an invisible signal without touching the game's title element.
    // Sending the three in sequence produces the fade, with no UI animation needed.
    const show = (texto, ticks) => {
        try {
            player.onScreenDisplay.setTitle(texto, {
                fadeInDuration: 0,
                stayDuration: ticks,
                fadeOutDuration: 0
            });
        } catch { }
    };

    const steps = [" ", "  ", "   "];
    steps.forEach((gatilho, i) => {
        if (i === 0) show(gatilho, 3);
        else system.runTimeout(() => show(gatilho, 3), i * 3);
    });

    // Clearing is mandatory, and it has to be done by swapping the text rather than wiping
    // the title: the text still counts for the UI after the title leaves the screen, so the
    // last layer would stay lit forever.
    // Sending a reset code does both jobs: it matches no layer, and it is in the list of
    // strings that hide the title, so the background panel is not drawn either.
    system.runTimeout(() => show("§r", 1), steps.length * 3);
}

/**
 * Phase Step: steps through a solid wall, landing on the far side within range
 */
function castPhaseStep(player, viewDir, maxRange) {
    const dimension = player.dimension;
    const originLoc = { x: player.location.x, y: player.location.y, z: player.location.z };

    try {
        dimension.playSound("spell.phase_step", originLoc, { volume: 1.0 });
        for (let i = 0; i < 10; i++) {
            const offset = {
                x: originLoc.x + (Math.random() - 0.5) * 0.8,
                y: originLoc.y + Math.random() * 1.8,
                z: originLoc.z + (Math.random() - 0.5) * 0.8
            };
            dimension.spawnParticle("ws:magic_missile_sparkle", offset);
        }
    } catch { }

    // Walk through the wall looking for the first open space on the other side
    let dest = null;
    let foundSolid = false;

    for (let dist = 1; dist <= maxRange; dist += 0.5) {
        const checkPos = {
            x: Math.floor(player.location.x + viewDir.x * dist),
            y: Math.floor(player.location.y + viewDir.y * dist),
            z: Math.floor(player.location.z + viewDir.z * dist)
        };

        try {
            const block = dimension.getBlock(checkPos);
            const blockAbove = dimension.getBlock({ x: checkPos.x, y: checkPos.y + 1, z: checkPos.z });

            if (block && !block.isAir && !block.isLiquid) {
                foundSolid = true;
            } else if (foundSolid && block && block.isAir && blockAbove && blockAbove.isAir) {
                dest = { x: checkPos.x + 0.5, y: checkPos.y, z: checkPos.z + 0.5 };
                break;
            }
        } catch { }
    }

    if (!dest) {
    // Not a wall, or no way out: fall back to a plain teleport up to the range
        dest = {
            x: player.location.x + viewDir.x * maxRange,
            y: player.location.y + viewDir.y * maxRange,
            z: player.location.z + viewDir.z * maxRange
        };
    }

    try {
        player.teleport(dest, {
            dimension: dimension,
            rotation: { x: player.getRotation().x, y: player.getRotation().y },
            keepVelocity: false
        });
    } catch {
        try { player.teleport(dest); } catch { }
    }

    try {
        player.playSound("mob.endermen.portal", { pitch: 1.4, volume: 0.8 });
        for (let i = 0; i < 12; i++) {
            const offset = {
                x: dest.x + (Math.random() - 0.5) * 0.8,
                y: dest.y + Math.random() * 1.8,
                z: dest.z + (Math.random() - 0.5) * 0.8
            };
            dimension.spawnParticle("ws:magic_missile_sparkle", offset);
        }
    } catch { }

    return true;
}

// ------------------------------------------------------------------ Lightning Ray

/**
 * Exact 3D position of the wand's crystal tip, in first and third person.
 * Includes dead reckoning to cancel the client's interpolation lag while moving.
 * @param {Player} player
 * @param {number} leadTicks How far ahead to aim, to offset client interpolation latency
 * @returns {Vector3}
 */
export function getWandTipLocation(player, leadTicks = 1.8) {
    const headLoc = player.getHeadLocation();
    const viewDir = player.getViewDirection();

    // Predictive offset that cancels the teleport delay while the player walks or runs
    let velX = 0;
    let velY = 0;
    let velZ = 0;
    try {
        const vel = player.getVelocity();
        if (vel) {
            velX = (vel.x || 0) * leadTicks;
            velZ = (vel.z || 0) * leadTicks;
    // Vertical compensation only while jumping or falling, to avoid gravity drift on the ground
            const onGround = player.isOnGround ?? true;
            if (!onGround && Math.abs(vel.y || 0) > 0.08) {
                velY = (vel.y || 0) * leadTicks;
            }
        }
    } catch {}

    const posX = headLoc.x + velX;
    const posY = headLoc.y + velY;
    const posZ = headLoc.z + velZ;

    // 1. Camera forward vector (F)
    const fwdX = viewDir.x;
    const fwdY = viewDir.y;
    const fwdZ = viewDir.z;

    // 2. Camera right vector (R)
    const rX = -fwdZ;
    const rZ = fwdX;
    const rLen = Math.hypot(rX, rZ) || 1;
    const rightX = rX / rLen;
    const rightZ = rZ / rLen;

    // 3. Camera up vector (U = cross(R, F))
    const upX = -rightZ * fwdY;
    const upY = rightZ * fwdX - rightX * fwdZ;
    const upZ = rightX * fwdY;

    // Offsets lined up with the wand crystal:
    // ~1.05m ahead of the eyes, ~0.27m right, ~0.08m below the line of sight
    const fwdOffset = 1.05;
    const rightOffset = 0.27;
    const upOffset = -0.08;

    return {
        x: posX + fwdX * fwdOffset + rightX * rightOffset + upX * upOffset,
        y: posY + fwdY * fwdOffset + upY * upOffset,
        z: posZ + fwdZ * fwdOffset + rightZ * rightOffset + upZ * upOffset
    };
}

/**
 * One-shot Lightning Ray (scroll): connects the wand to the target or aim point
 */
function castLightningRay(player, viewDir, spellId, modifiers) {
    const dimension = player.dimension;
    const props = getSpellProps(spellId);
    const maxRange = (props.range ?? 10) * modifiers.range;
    const startLoc = getWandTipLocation(player);
    const target = findAimTarget(player, maxRange);
    const targetLoc = target.location ?? {
        x: startLoc.x + viewDir.x * maxRange,
        y: startLoc.y + viewDir.y * maxRange,
        z: startLoc.z + viewDir.z * maxRange
    };

    const style = rayStyle(spellId);
    const hitCause = hurtCauseOf(spellId);

    if (style.usesEntity) {
        castLightningBeamBetween(dimension, startLoc, targetLoc, target.entity ?? null, props.damage ?? 3, player);
        return;
    }

    // Elemental rays: particle beam, no entity
    drawBeam(dimension, startLoc, targetLoc, style.feixe);
    try { dimension.playSound(`spell.${spellId.replace("ws:", "")}.start`, startLoc, { volume: 0.9 }); } catch { }

    if (target.entity && isValidCombatTarget(target.entity, player)) {
        try {
            target.entity.applyDamage(props.damage ?? 3, { cause: hitCause, damagingEntity: player });
            if (style.aoAcertar) style.aoAcertar(target.entity, props);
            const center = getEntityCenter(target.entity);
            for (let i = 0; i < 6; i++) {
                dimension.spawnParticle(style.impact, {
                    x: center.x + (Math.random() - 0.5) * 0.8,
                    y: center.y + (Math.random() - 0.5) * 0.8,
                    z: center.z + (Math.random() - 0.5) * 0.8
                });
            }
        } catch { }
    }
}

// Players currently channelling a ray
const activeLightningChannels = new Map();

/**
 * Starts the continuous ray while the player holds the use button.
 * Range and damage come from the spell properties, with the wand upgrades applied.
 */
export function startChanneledLightningRay(player, spellId, modifiers = DEFAULT_MODIFIERS, onManaCost = null) {
    if (!player || !player.isValid()) return;

    // The wand handler sends everything in CHANNELED_SPELLS through here, and
    // the grapple is held down the same way a ray is even though nothing about
    // it is a ray. Branching here keeps that handler from having to know.
    if (spellId === "ws:grapple") {
        startGrappleLine(player, modifiers, onManaCost);
        return;
    }

    if (activeLightningChannels.has(player.id)) {
        stopChanneledLightningRay(player, true);
    }

    const dimension = player.dimension;
    const props = getSpellProps(spellId);
    const maxRange = (props.range ?? 10) * modifiers.range;

    // Clear any orphan ray entities left near the player
    try {
        const strayRays = dimension.getEntities({
            location: player.location,
            maxDistance: 64,
            type: "ws:lightning_ray"
        });
        for (const stray of strayRays) {
            try { stray.remove(); } catch { }
        }
    } catch { }

    const startLoc = getWandTipLocation(player);
    const style = rayStyle(spellId);

    // Only the lightning ray has a 3D entity; the elemental ones are a particle beam
    let rayEntity = null;
    let currentVariant = Math.floor(Math.random() * 4);
    if (style.usesEntity) {
        try {
            rayEntity = dimension.spawnEntity("ws:lightning_ray", startLoc);
            rayEntity.setProperty("ws:variant", currentVariant);
            // Born with no length, not a full block of it. The ray is not
            // aimed until channelTick runs, and the wand tip it spawns at sits
            // off to the player's right - so a full length ray here shows for
            // one frame as a bar flicking out sideways before it lines up.
            rayEntity.setProperty("ws:length", 0.1);
            rayEntity.setProperty("ws:pitch", 0.0);
        } catch (e) {
            console.warn("Aviso ao spawnar entidade ws:lightning_ray: " + e);
        }
    }

    const channelData = {
        runId: 0,
        rayEntity,
        currentVariant,
        ticks: 0,
        damage: props.damage ?? 3,
        cause: hurtCauseOf(spellId),
        dimensionId: dimension.id,
        style,
        props
    };

    // Opening crack and the first pass of the loop fire together, as in the original mod
    // (start is only the attack, it does not cover the whole channel)
    const sounds = CHANNEL_SOUNDS[spellId] ?? null;
    channelData.sounds = sounds;
    try {
        dimension.playSound(sounds ? sounds.start : `spell.${spellId.replace("ws:", "")}`, startLoc, { volume: 0.9 });
        if (sounds) dimension.playSound(sounds.loop, startLoc, { volume: 0.7 });
    } catch { }

    // Dispara no tick inicial imediatamente
    channelTick(player, dimension, maxRange, channelData);
    channelData.ticks = 1;

    const runId = system.runInterval(() => {
        if (!player || !player.isValid()) {
            stopChanneledLightningRay(player);
            return;
        }

        // Mana is charged every 10 ticks (~0.5s)
        if (channelData.ticks % 10 === 0 && onManaCost) {
            const hasMana = onManaCost();
            if (!hasMana) {
                stopChanneledLightningRay(player);
                return;
            }
        }

        channelTick(player, player.dimension, maxRange, channelData);
        channelData.ticks++;
    }, 1);

    channelData.runId = runId;
    activeLightningChannels.set(player.id, channelData);
}

/**
 * Stops the continuous ray and removes the visual entity
 */
export function stopChanneledLightningRay(player, silencioso = false) {
    if (!player) return;

    // Letting go of the button arrives here too, whatever was being held
    releaseGrapple(player, silencioso);

    const channel = activeLightningChannels.get(player.id);
    if (channel) {
        system.clearRun(channel.runId);
        // Closing sound, skipped when this is just cleanup before restarting the channel
        if (!silencioso && channel.sounds) {
            try { player.dimension.playSound(channel.sounds.end, player.location, { volume: 0.8 }); } catch { }
        }
        if (channel.rayEntity && channel.rayEntity.isValid()) {
            try {
                channel.rayEntity.remove();
            } catch { }
        }
        activeLightningChannels.delete(player.id);
    }
}

/**
 * Runs one frame of the continuous ray
 */
function channelTick(player, dimension, maxRange, channel) {
    // Swapping item or putting the wand away stops it immediately
    try {
        const inv = player.getComponent("inventory")?.container;
        const mainItem = inv?.getItem(player.selectedSlotIndex);
        if (!isWandItem(mainItem)) {
            stopChanneledLightningRay(player);
            return;
        }
    } catch { }

    const headLoc = player.getHeadLocation();
    const viewDir = player.getViewDirection();

    const startLoc = getWandTipLocation(player);

    let targetLoc = null;
    let targetEntity = null;

    // 1. Raycast for a mob in the crosshair, ignoring dropped items and orbs
    try {
        const rayHits = player.getEntitiesFromViewDirection({
            maxDistance: maxRange,
            ...COMBAT_TARGET_FILTER
        });

        for (const hit of rayHits) {
            if (hit.entity && isValidCombatTarget(hit.entity, player)) {
                targetEntity = hit.entity;
                break;
            }
        }
    } catch { }

    // 2. Soft magnetic lock (cone aim assist) onto a mob in the aimed direction
    if (!targetEntity) {
        try {
            const nearby = dimension.getEntities({
                location: headLoc,
                maxDistance: maxRange,
                ...COMBAT_TARGET_FILTER
            });

            let bestDot = 0.94; // cone de mira
            for (const ent of nearby) {
                if (!isValidCombatTarget(ent, player)) continue;
                const entLoc = ent.location;
                const toX = entLoc.x - headLoc.x;
                const toY = (entLoc.y + 1.0) - headLoc.y;
                const toZ = entLoc.z - headLoc.z;
                const d = Math.hypot(toX, toY, toZ);
                if (d > 0.5 && d <= maxRange) {
                    const dot = (toX * viewDir.x + toY * viewDir.y + toZ * viewDir.z) / d;
                    if (dot > bestDot) {
                        bestDot = dot;
                        targetEntity = ent;
                    }
                }
            }
        } catch { }
    }

    // 3. With a living mob found, aim at its centre of mass
    if (targetEntity && isValidCombatTarget(targetEntity, player)) {
        targetLoc = getEntityCenter(targetEntity);

        // Continuous damage every 4 ticks (~0.2s), with each element's own effect
        if (channel.ticks % 4 === 0) {
            try {
                targetEntity.applyDamage(channel.damage, { damagingEntity: player, cause: channel.cause });
                if (channel.style.aoAcertar) {
                    channel.style.aoAcertar(targetEntity, channel.props ?? {});
                } else {
                    targetEntity.addEffect("slowness", 10, { amplifier: 1, showParticles: false });
                }

                if (channel.style.usesEntity) {
                    sparkOnTarget(dimension, targetEntity);
                } else {
                    const center = getEntityCenter(targetEntity);
                    for (let i = 0; i < 5; i++) {
                        dimension.spawnParticle(channel.style.impact, {
                            x: center.x + (Math.random() - 0.5) * 0.7,
                            y: center.y + (Math.random() - 0.5) * 0.7,
                            z: center.z + (Math.random() - 0.5) * 0.7
                        });
                    }
                }
            } catch { }
        }
    } else {
        targetEntity = null;
    }

    // 4. No mob: land on the aimed block and spark against it
    if (!targetLoc) {
        try {
            const rayBlock = player.getBlockFromViewDirection({ maxDistance: maxRange });
            if (rayBlock && rayBlock.block) {
                targetLoc = {
                    x: rayBlock.block.location.x + 0.5,
                    y: rayBlock.block.location.y + 0.5,
                    z: rayBlock.block.location.z + 0.5
                };
                if (channel.ticks % 6 === 0) {
                    try {
                        dimension.spawnParticle(channel.style.impact, targetLoc);
                    } catch {}
                }
            }
        } catch { }
    }

    // 5. Nothing hit: stretch out to the aim direction from the wand
    if (!targetLoc) {
        targetLoc = {
            x: startLoc.x + viewDir.x * maxRange,
            y: startLoc.y + viewDir.y * maxRange,
            z: startLoc.z + viewDir.z * maxRange
        };
    }

    // 6. Recompute direction and exact distance
    const dx = targetLoc.x - startLoc.x;
    const dy = targetLoc.y - startLoc.y;
    const dz = targetLoc.z - startLoc.z;
    const horizontalDist = Math.hypot(dx, dz);
    const distance = Math.hypot(dx, dy, dz);

    const pitch = -Math.atan2(dy, horizontalDist || 0.001) * (180 / Math.PI);
    const yaw = -Math.atan2(dx, dz || 0.001) * (180 / Math.PI);

    // 7. Particle beam for the elemental rays, which have no entity
    if (!channel.style.usesEntity) {
        drawBeam(dimension, startLoc, targetLoc, channel.style.feixe);
    }

    // 8. Make sure the entity exists and is in the right dimension
    if (channel.style.usesEntity && (!channel.rayEntity || !channel.rayEntity.isValid())) {
        try {
            channel.rayEntity = dimension.spawnEntity("ws:lightning_ray", startLoc);
            channel.rayEntity.setProperty("ws:variant", channel.currentVariant);
            // same reason as on the first spawn: nothing visible until the
            // block below turns it to face the target
            channel.rayEntity.setProperty("ws:length", 0.1);
            channel.rayEntity.setProperty("ws:pitch", 0.0);
        } catch { }
    }

    // 9. Update the entity: teleport it facing the target, and set the length
    if (channel.rayEntity && channel.rayEntity.isValid()) {
        try {
            const tpOptions = {
                dimension: dimension,
                keepVelocity: false
            };
            if (Number.isFinite(targetLoc.x) && Number.isFinite(targetLoc.y) && Number.isFinite(targetLoc.z) && distance >= 0.1) {
                tpOptions.facingLocation = { x: targetLoc.x, y: targetLoc.y, z: targetLoc.z };
            } else {
                tpOptions.rotation = { x: 0, y: Number.isFinite(yaw) ? yaw : 0 };
            }
            channel.rayEntity.teleport(startLoc, tpOptions);
            channel.rayEntity.setProperty("ws:length", Math.max(0.1, distance));
            channel.rayEntity.setProperty("ws:pitch", pitch);
        } catch (err) {
            console.warn("[channelTick TP Error]: " + err);
        }

        // 9. Alterna a variant visual a cada 2 ticks sem repetir a anterior
        if (channel.ticks % 2 === 0 && channel.ticks > 0) {
            let nextVariant;
            do {
                nextVariant = Math.floor(Math.random() * 4);
            } while (nextVariant === channel.currentVariant);

            channel.currentVariant = nextVariant;
            try {
                channel.rayEntity.setProperty("ws:variant", nextVariant);
            } catch { }
        }
    }

    // Continuous sound, following the wand tip.
    // Each spell re-fires the loop at the pace of its own audio file.
    if (channel.sounds) {
        const interval = channel.sounds.loopTicks ?? CHANNEL_LOOP_TICKS;
        if (channel.ticks > 0 && channel.ticks % interval === 0) {
            try { dimension.playSound(channel.sounds.loop, startLoc, { volume: 0.7 }); } catch { }
        }
    } else if (channel.ticks % 8 === 0 && channel.ticks > 0) {
        // Spells without their own trio keep the short crack
        try { dimension.playSound("spell.arc", startLoc, { volume: 0.8, pitch: 1.05 }); } catch { }
    }
}

/**
 * Fires a one-shot Lightning Ray.
 * Spawns the visual entity, flickers it for a few ticks and removes it.
 *
 * followCaster keeps the ray anchored to the player's wand during the animation.
 * Spells fired from elsewhere, like the Lightning Hammer, pass false so it stays put.
 */
/**
 * Ha mundo carregado neste ponto?
 *
 * Um chunk que nao esta a tickar nao aceita nada: spawnar la dentro atira
 * LocationInUnloadedChunkError. Perguntar por um bloco e a maneira barata de
 * saber, porque falha da mesma forma e sem efeitos colaterais.
 */
function locationIsLoaded(dimension, loc) {
    try {
        return !!dimension.getBlock({
            x: Math.floor(loc.x),
            y: Math.floor(loc.y),
            z: Math.floor(loc.z)
        });
    } catch {
        return false;
    }
}

export function castLightningBeamBetween(dimension, startLoc, targetLoc, targetEntity = null, damage = 4, player = null, followCaster = true) {
    const dx = targetLoc.x - startLoc.x;
    const dy = targetLoc.y - startLoc.y;
    const dz = targetLoc.z - startLoc.z;
    const horizontalDist = Math.hypot(dx, dz);
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.2) return;

    // O raio e so o desenho. Se a ponta de partida cair num chunk descarregado
    // nao ha onde o por, mas o golpe em si continua a valer - por isso salta-se
    // o visual e segue-se para o dano, em vez de estourar e avisar.
    const podeDesenhar = locationIsLoaded(dimension, startLoc);

    const pitch = -Math.atan2(dy, horizontalDist || 0.001) * (180 / Math.PI);
    const yaw = -Math.atan2(dx, dz || 0.001) * (180 / Math.PI);

    let ray = null;
    let currentVar = Math.floor(Math.random() * 4);
    try {
        if (!podeDesenhar) throw null;
        ray = dimension.spawnEntity("ws:lightning_ray", startLoc);
        // shrunk before anything else, for the same reason as the other two
        // spawns: a ray that exists for even one frame at its default length
        // and rotation shows as a bar in the wrong place
        ray.setProperty("ws:length", 0.1);
        ray.setProperty("ws:pitch", 0.0);
        const tpOptions = {
            dimension: dimension,
            keepVelocity: false
        };
        if (Number.isFinite(targetLoc.x) && Number.isFinite(targetLoc.y) && Number.isFinite(targetLoc.z) && distance >= 0.1) {
            tpOptions.facingLocation = { x: targetLoc.x, y: targetLoc.y, z: targetLoc.z };
        } else {
            tpOptions.rotation = { x: 0, y: Number.isFinite(yaw) ? yaw : 0 };
        }
        ray.teleport(startLoc, tpOptions);
        ray.setProperty("ws:variant", currentVar);
        ray.setProperty("ws:length", distance);
        ray.setProperty("ws:pitch", pitch);
    } catch (err) {
        // o throw null acima e o caso conhecido do chunk descarregado, e nao e
        // motivo para encher o log; o resto continua a queixar-se
        if (err !== null) console.warn("[castLightningBeamBetween Error]: " + err);
    }

    try {
        dimension.playSound("spell.arc", startLoc, { volume: 0.9, pitch: 1.0 });
    } catch { }

    // Damage and sparks on the target, never on dropped items
    if (targetEntity && isValidCombatTarget(targetEntity, player)) {
        try {
            targetEntity.applyDamage(damage, player ? { cause: "lightning", damagingEntity: player } : { cause: "lightning" });
            sparkOnTarget(dimension, targetEntity);
        } catch { }
    }

    // Se spawnou o raio, anima a troca por 6 ticks (~0.3s) e remove acompanhando a varinha em tempo real
    if (ray && ray.isValid()) {
        let count = 0;
        const animId = system.runInterval(() => {
            count++;
            if (!ray.isValid() || count >= 6) {
                system.clearRun(animId);
                if (ray.isValid()) {
                    try { ray.remove(); } catch { }
                }
                return;
            }

            // Follow the wand if the player is moving
            if (followCaster && player && player.isValid()) {
                const curStart = getWandTipLocation(player);
                const curDx = targetLoc.x - curStart.x;
                const curDy = targetLoc.y - curStart.y;
                const curDz = targetLoc.z - curStart.z;
                const curH = Math.hypot(curDx, curDz);
                const curDist = Math.hypot(curDx, curDy, curDz);
                const curPitch = -Math.atan2(curDy, curH || 0.001) * (180 / Math.PI);
                const curYaw = -Math.atan2(curDx, curDz || 0.001) * (180 / Math.PI);
                try {
                    const curTpOptions = {
                        dimension: dimension,
                        keepVelocity: false
                    };
                    if (curDist >= 0.1) {
                        curTpOptions.facingLocation = { x: targetLoc.x, y: targetLoc.y, z: targetLoc.z };
                    } else {
                        curTpOptions.rotation = { x: 0, y: Number.isFinite(curYaw) ? curYaw : 0 };
                    }
                    ray.teleport(curStart, curTpOptions);
                    ray.setProperty("ws:length", Math.max(0.1, curDist));
                    ray.setProperty("ws:pitch", curPitch);
                } catch { }
            }

            if (count % 2 === 0) {
                let nextVar;
                do {
                    nextVar = Math.floor(Math.random() * 4);
                } while (nextVar === currentVar);
                currentVar = nextVar;
                try {
                    ray.setProperty("ws:variant", nextVar);
                } catch { }
            }
        }, 1);
    }
}

// ------------------------------------------------------------------ Lightning Hammer

/** Quantos blocos o martelo desce por tick durante a queda */
const HAMMER_FALL_SPEED = 1.2;
/** How high above the target the hammer can be summoned */
const HAMMER_SPAWN_HEIGHT = 18;
/** How far the hammer may fall looking for ground before giving up */
const HAMMER_MAX_DROP = 48;

/**
 * Whether a position is solid ground (air and liquids do not hold the hammer)
 */
function isSolidBlockAt(dimension, x, y, z) {
    try {
        const block = dimension.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
        if (!block) return false;
        return !block.isAir && !block.isLiquid;
    } catch {
        return false;
    }
}

/**
 * First solid block along the stretch covered in one tick of falling.
 * Walks block by block so the hammer never clips through a thin floor at speed.
 */
function firstSolidBetween(dimension, x, fromY, toY, z) {
    for (let y = Math.floor(fromY); y >= Math.floor(toY); y--) {
        if (isSolidBlockAt(dimension, x, y, z)) return y;
    }
    return null;
}

/**
 * Climbs from y until clear of the ground, giving the height the hammer rests at
 */
function hammerRestY(dimension, x, y, z) {
    let restY = Math.floor(y);
    for (let i = 0; i < 6 && isSolidBlockAt(dimension, x, restY, z); i++) {
        restY++;
    }
    return restY;
}

/**
 * Summon height: as high above the impact as possible without clipping a ceiling,
 * so in caves and under the Nether roof it appears just below them
 */
function hammerSpawnY(dimension, x, impactY, z) {
    let y = impactY + 2;
    for (let i = 0; i < HAMMER_SPAWN_HEIGHT && !isSolidBlockAt(dimension, x, y + 1, z); i++) {
        y++;
    }
    return y;
}

/**
 * Where the rays come out: the top of the hammer's handle
 */
function hammerTopLocation(hammer) {
    const loc = hammer.location;
    return { x: loc.x, y: loc.y + 1.7, z: loc.z };
}

/**
 * Valid targets around the hammer, never the caster and never dropped items
 */
function nearbyHammerTargets(dimension, loc, radius, player) {
    try {
        return dimension
            .getEntities({ location: loc, maxDistance: radius, ...COMBAT_TARGET_FILTER })
            .filter((entity) => isValidCombatTarget(entity, player));
    } catch {
        return [];
    }
}

/**
 * Lightning Hammer (master): a giant hammer falls from the sky onto the aimed point.
 * On landing it releases a shockwave and then arcs lightning at nearby mobs
 * until its duration runs out.
 */
function castLightningHammer(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 40) * modifiers.range;

    const aim = findAimTarget(player, maxRange);
    const impact = aim.entity ? aim.entity.location : (aim.location ?? spawnInFront(headLoc, viewDir, maxRange));
    const spawnY = hammerSpawnY(dimension, impact.x, impact.y, impact.z);

    let hammer = null;
    try {
        hammer = dimension.spawnEntity("ws:lightning_hammer", { x: impact.x, y: spawnY, z: impact.z });
        hammer.teleport({ x: impact.x, y: spawnY, z: impact.z }, {
            dimension,
            keepVelocity: false,
            rotation: { x: 0, y: player.getRotation().y }
        });
    } catch (err) {
        console.warn("[castLightningHammer Error]: " + err);
        return false;
    }

    try {
        dimension.playSound("entity.hammer.throw", { x: impact.x, y: spawnY, z: impact.z }, { volume: 1.0 });
    } catch { }

    dropHammer(player, hammer, impact.y, props, modifiers);
    return true;
}

/**
 * The fall: straight down, trailing sparks, until it finds ground
 */
function dropHammer(player, hammer, impactY, props, modifiers) {
    const dimension = hammer.dimension;
    const floorLimit = impactY - HAMMER_MAX_DROP;
    let fallen = 0;

    const fallId = system.runInterval(() => {
        if (!hammer.isValid()) {
            system.clearRun(fallId);
            return;
        }

        const loc = hammer.location;
        const nextY = loc.y - HAMMER_FALL_SPEED;

        // Electric trail following it down
        try {
            dimension.spawnParticle("ws:lightning_sparkle", { x: loc.x, y: loc.y + 0.9, z: loc.z });
        } catch { }

        const ground = firstSolidBetween(dimension, loc.x, loc.y, nextY, loc.z);
        if (ground !== null) {
            system.clearRun(fallId);
            const restY = hammerRestY(dimension, loc.x, ground, loc.z);
            try {
                hammer.teleport({ x: loc.x, y: restY, z: loc.z }, { dimension, keepVelocity: false });
            } catch { }
            hammerImpact(player, hammer, props, modifiers);
            return;
        }

        // Fell into the void with no ground below: dissipate instead of falling forever
        fallen += HAMMER_FALL_SPEED;
        if (nextY <= floorLimit || fallen > HAMMER_MAX_DROP) {
            system.clearRun(fallId);
            dissipateHammer(hammer);
            return;
        }

        try {
            hammer.teleport({ x: loc.x, y: nextY, z: loc.z }, { dimension, keepVelocity: false });
        } catch { }
    }, 1);
}

/**
 * Landing: the crash, a shockwave and one discharge into everything in radius
 */
function hammerImpact(player, hammer, props, modifiers) {
    const dimension = hammer.dimension;
    const loc = hammer.location;
    const radius = (props.effect_radius ?? 10) * modifiers.blast;
    const damage = props.direct_damage ?? 10;

    try {
        dimension.playSound("entity.hammer.land", loc, { volume: 1.2 });
        dimension.playSound("entity.hammer.explode", loc, { volume: 1.0, pitch: 0.9 });
    } catch { }

    // Flash at the landing point and a ring of sparks running along the ground
    try {
        dimension.spawnParticle("ws:lightning_pulse", { x: loc.x, y: loc.y + 0.5, z: loc.z });
        for (let i = 0; i < 16; i++) {
            const angle = (Math.PI * 2 * i) / 16;
            dimension.spawnParticle("ws:lightning_sparkle", {
                x: loc.x + Math.cos(angle) * 1.8,
                y: loc.y + 0.2,
                z: loc.z + Math.sin(angle) * 1.8
            });
        }
    } catch { }

    const top = hammerTopLocation(hammer);
    for (const entity of nearbyHammerTargets(dimension, loc, radius, player)) {
        castLightningBeamBetween(dimension, top, getEntityCenter(entity), entity, damage, player, false);
        const dx = entity.location.x - loc.x;
        const dz = entity.location.z - loc.z;
        const length = Math.hypot(dx, dz) || 1;
        knockback(entity, dx / length, dz / length, 1.0, 0.45);
    }

    startHammerAura(player, hammer, props, modifiers);
}

/**
 * While planted: sparks constantly and arcs at nearby mobs on an interval,
 * until the spell duration is up
 */
function startHammerAura(player, hammer, props, modifiers) {
    const dimension = hammer.dimension;
    const duration = Math.round((props.duration ?? 600) * modifiers.duration);
    const radius = (props.effect_radius ?? 10) * modifiers.blast;
    const maxTargets = props.secondary_max_targets ?? 8;
    const interval = Math.max(5, props.attack_interval ?? 40);
    const damage = props.splash_damage ?? 6;

    let ticks = 0;
    const auraId = system.runInterval(() => {
        if (!hammer.isValid()) {
            system.clearRun(auraId);
            return;
        }

        ticks++;
        const loc = hammer.location;

            // Sparks crackling on the hammer
        if (ticks % 5 === 0) {
            try {
                dimension.spawnParticle("ws:lightning_spark", {
                    x: loc.x + (Math.random() - 0.5) * 1.2,
                    y: loc.y + 0.4 + Math.random() * 1.4,
                    z: loc.z + (Math.random() - 0.5) * 1.2
                });
            } catch { }
        }

        // Periodic discharge: lightning from the hammer to the mobs around it
        if (ticks % interval === 0) {
            const targets = nearbyHammerTargets(dimension, loc, radius, player).slice(0, maxTargets);
            if (targets.length > 0) {
                try {
                    dimension.playSound("entity.hammer.attack", loc, { volume: 1.0 });
                    dimension.spawnParticle("ws:lightning_pulse", { x: loc.x, y: loc.y + 1.4, z: loc.z });
                } catch { }

                const top = hammerTopLocation(hammer);
                for (const entity of targets) {
                    castLightningBeamBetween(dimension, top, getEntityCenter(entity), entity, damage, player, false);
                }
            }
        }

        if (ticks >= duration) {
            system.clearRun(auraId);
            dissipateHammer(hammer);
        }
    }, 1);
}

/**
 * End of the spell: the hammer bursts into sparks and vanishes
 */
function dissipateHammer(hammer) {
    if (!hammer.isValid()) return;
    const dimension = hammer.dimension;
    const loc = hammer.location;

    try {
        dimension.playSound("entity.hammer.explode", loc, { volume: 1.0 });
        dimension.spawnParticle("ws:lightning_pulse", { x: loc.x, y: loc.y + 0.9, z: loc.z });
        for (let i = 0; i < 10; i++) {
            dimension.spawnParticle("ws:lightning_sparkle", {
                x: loc.x + (Math.random() - 0.5) * 1.6,
                y: loc.y + Math.random() * 1.8,
                z: loc.z + (Math.random() - 0.5) * 1.6
            });
        }
    } catch { }

    try { hammer.remove(); } catch { }
}

// ------------------------------------------------------------------ Ground runes (sigils and areas)

/**
 * Texture index of each rune in the render controller (Array.runas)
 */
const RUNE_VARIANT = {
    fire_sigil: 0,
    frost_sigil: 1,
    lightning_sigil: 2,
    ring_of_fire: 3,
    healing_aura: 4
};

/** How long a sigil stays armed waiting for someone to step on it (2 minutes) */
const SIGIL_DURATION = 2400;

/**
 * Spawns the rune on the ground. Size travels as a property and the animation scales
 * the model, so the same entity works as a small sigil or a wide ring.
 */
function spawnRune(dimension, loc, variant, diametro, spin = 0) {
    try {
        const rune = dimension.spawnEntity("ws:ground_rune", { x: loc.x, y: loc.y + 0.05, z: loc.z });
        rune.setProperty("ws:variant", variant);
        rune.setProperty("ws:size", Math.max(0.1, Math.min(12, diametro)));
        rune.setProperty("ws:spin", spin);
        return rune;
    } catch (err) {
        console.warn("[nascerRuna]: " + err);
        return null;
    }
}

function fadeRune(rune) {
    try { if (rune && rune.isValid()) rune.remove(); } catch { }
}

/**
 * Finds the ground just below the aimed point, so the rune does not float
 */
function groundBelow(dimension, point) {
    const base = Math.floor(point.y);
    for (let dy = 1; dy >= -3; dy--) {
        if (isSolidBlockAt(dimension, point.x, base + dy, point.z)) {
            return { x: point.x, y: base + dy + 1, z: point.z };
        }
    }
    return { x: point.x, y: point.y, z: point.z };
}

/**
 * Sigils (Fire, Frost and Lightning): mark the ground and wait, armed.
 * When a creature steps on one it discharges all at once and is spent.
 */
function castSigil(player, headLoc, viewDir, spellId, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 10) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const point = groundBelow(dimension, target.location ?? spawnInFront(headLoc, viewDir, maxRange));
    const radius = (props.effect_radius ?? 1) * modifiers.blast;

    const variant = spellId === "ws:fire_sigil" ? RUNE_VARIANT.fire_sigil
        : spellId === "ws:frost_sigil" ? RUNE_VARIANT.frost_sigil
            : RUNE_VARIANT.lightning_sigil;

    const rune = spawnRune(dimension, point, variant, radius * 2, 12);
    if (!rune) return false;

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks += 2;
        if (!rune.isValid() || ticks > SIGIL_DURATION) {
            system.clearRun(id);
            fadeRune(rune);
            return;
        }

        const victims = nearbyHammerTargets(dimension, point, radius, player);
        if (victims.length === 0) return;

        system.clearRun(id);
        triggerSigil(player, spellId, dimension, point, victims, props, modifiers);
        fadeRune(rune);
    }, 2);

    return true;
}

/**
 * The sigil discharge, different for each element
 */
function triggerSigil(player, spellId, dimension, point, victims, props, modifiers) {
    if (spellId === "ws:fire_sigil") {
        for (const v of victims) {
            try {
                v.applyDamage(props.damage ?? 6, { cause: "fire", damagingEntity: player });
                v.setOnFire(props.burn_duration ?? 10, true);
            } catch { }
        }
        try {
            for (let i = 0; i < 14; i++) {
                dimension.spawnParticle("minecraft:basic_flame_particle", {
                    x: point.x + (Math.random() - 0.5) * 2,
                    y: point.y + Math.random() * 1.2,
                    z: point.z + (Math.random() - 0.5) * 2
                });
            }
        } catch { }
        return;
    }

    if (spellId === "ws:frost_sigil") {
        for (const v of victims) {
            try {
                v.applyDamage(props.damage ?? 8, { cause: "entity_attack", damagingEntity: player });
                v.addEffect("slowness", Math.round((props.effect_duration ?? 200) * modifiers.duration), {
                    amplifier: props.effect_strength ?? 1,
                    showParticles: true
                });
            } catch { }
        }
        try {
            for (let i = 0; i < 14; i++) {
                dimension.spawnParticle("minecraft:snowflake_particle", {
                    x: point.x + (Math.random() - 0.5) * 2,
                    y: point.y + Math.random() * 1.2,
                    z: point.z + (Math.random() - 0.5) * 2
                });
            }
        } catch { }
        return;
    }

    // Lightning Sigil: whoever stepped on it takes the full hit, then the bolt jumps to neighbours
    const center = { x: point.x, y: point.y + 0.6, z: point.z };
    const hitTargets = new Set();
    for (const v of victims) {
        hitTargets.add(v.id);
        castLightningBeamBetween(dimension, center, getEntityCenter(v), v, props.direct_damage ?? 6, player, false);
    }

    const neighbours = nearbyHammerTargets(dimension, point, (props.secondary_range ?? 1) * 3 * modifiers.range, player)
        .filter((e) => !hitTargets.has(e.id))
        .slice(0, props.secondary_max_targets ?? 3);

    for (const neighbour of neighbours) {
        castLightningBeamBetween(dimension, center, getEntityCenter(neighbour), neighbour, props.splash_damage ?? 4, player, false);
    }
}

/**
 * Ring of Fire: a circle of flame that burns anything inside it until the duration ends
 */
function castRingOfFire(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const target = findAimTarget(player, 10 * modifiers.range);
    const point = groundBelow(dimension, target.location ?? spawnInFront(headLoc, viewDir, 4));
    const radius = (props.effect_radius ?? 2.5) * modifiers.blast;
    const duration = Math.round((props.duration ?? 600) * modifiers.duration);

    const rune = spawnRune(dimension, point, RUNE_VARIANT.ring_of_fire, radius * 2, 8);
    if (!rune) return false;

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;
        if (!rune.isValid() || ticks > duration) {
            system.clearRun(id);
            fadeRune(rune);
            return;
        }

            // Flames running along the edge of the ring
        if (ticks % 3 === 0) {
            try {
                for (let i = 0; i < 4; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    dimension.spawnParticle("minecraft:basic_flame_particle", {
                        x: point.x + Math.cos(angle) * radius,
                        y: point.y + Math.random() * 0.7,
                        z: point.z + Math.sin(angle) * radius
                    });
                }
            } catch { }
        }

        if (ticks % 20 !== 0) return;
        for (const v of nearbyHammerTargets(dimension, point, radius, player)) {
            try {
                v.applyDamage(props.damage ?? 1, { cause: "fire", damagingEntity: player });
                v.setOnFire(props.burn_duration ?? 10, true);
            } catch { }
        }
    }, 1);

    return true;
}

/**
 * Healing Aura: a circle that regenerates players inside it and hurts the undead
 */
const UNDEAD_FAMILY = ["zombie", "skeleton", "wither", "phantom", "drowned", "husk", "stray", "zoglin"];

function castHealingAura(player, props, modifiers) {
    const dimension = player.dimension;
    const point = groundBelow(dimension, player.location);
    const radius = (props.effect_radius ?? 2.5) * modifiers.blast;
    const duration = Math.round((props.duration ?? 600) * modifiers.duration);

    const rune = spawnRune(dimension, point, RUNE_VARIANT.healing_aura, radius * 2, -6);
    if (!rune) return false;

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;
        if (!rune.isValid() || ticks > duration) {
            system.clearRun(id);
            fadeRune(rune);
            return;
        }

        if (ticks % 20 !== 0) return;

        // Heal the players inside the circle
        for (const p of dimension.getPlayers({ location: point, maxDistance: radius })) {
            try {
                const vitality = p.getComponent("minecraft:health");
                if (vitality && vitality.currentValue < vitality.effectiveMax) {
                    vitality.setCurrentValue(Math.min(vitality.effectiveMax, vitality.currentValue + (props.health ?? 1)));
                }
            } catch { }
        }

        // And hurt the undead, which cannot stand the light
        for (const v of nearbyHammerTargets(dimension, point, radius, player)) {
            if (!UNDEAD_FAMILY.some((f) => v.typeId.includes(f))) continue;
            try { v.applyDamage(props.damage ?? 1, { cause: "entity_attack", damagingEntity: player }); } catch { }
        }
    }, 1);

    return true;
}

/**
 * Black Hole: opens a well that pulls everything in and, on closing, tears apart
 * quem ficou perto demais
 */
function castBlackHole(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 10) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const base = target.location ?? spawnInFront(headLoc, viewDir, maxRange);
    // Low enough that victims are dragged against the ground, not up into the sky
    const center = { x: base.x, y: base.y + 1.0, z: base.z };

    const duration = Math.round((props.duration ?? 120) * modifiers.duration);
    const pullRadius = (props.pull_radius ?? 9) * modifiers.blast;
    const strength = props.pull_strength ?? 0.55;
    const damageRadius = (props.effect_radius ?? 3) * modifiers.blast;
    const damage = props.damage ?? 16;

    // Captured at cast time: survives the player reference dying mid-spell (relog),
    // which comparing against the live object does not.
    const ownerId = player.id;

    /** The well ignores whoever opened it, and any player's tamed animals */
    const spare = (target) => target.id === ownerId || isPet(target);

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;

        // The well grows for a moment and then holds
        const growth = 0.75 + 0.25 * Math.min(1, ticks / 20);
        const coreSize = BLACK_HOLE_SIZE * growth;

        try {
            // Horizonte e aura saem na mesma textura: o disco preto ocupa metade da
            // of it, which is why the size is twice the horizon diameter.
            const holeVars = new MolangVariableMap();
            holeVars.setFloat("radius", coreSize * 2);
            holeVars.setFloat("spin", (ticks * 0.9) % 360);
            dimension.spawnParticle("ws:black_hole", center, holeVars);
        } catch { }

        // Pull: the vertical comes from the height difference to the well, otherwise the
        // sobe sem parar e acaba flutuando acima dele
        for (const v of nearbyHammerTargets(dimension, center, pullRadius, player)) {
            if (spare(v)) continue;
            try {
                const dx = center.x - v.location.x;
                const dy = center.y - v.location.y;
                const dz = center.z - v.location.z;
                const dist = Math.hypot(dx, dy, dz) || 0.001;
                const h = Math.hypot(dx, dz) || 0.001;

                // The closer to the well, the stronger the pull, like real gravity
                const intensity = strength * (1.4 - 0.4 * Math.min(1, dist / pullRadius));
                knockback(v, dx / h, dz / h, intensity, (dy / dist) * intensity);
            } catch { }
        }

        if (ticks < duration) return;

        // Collapse: the well closes and whatever stayed close is torn apart
        system.clearRun(id);
        try { dimension.playSound("spell.black_hole", center, { volume: 1.2 }); } catch { }
        burstBlackHole(dimension, center, coreSize);

        for (const v of nearbyHammerTargets(dimension, center, damageRadius, player)) {
            if (spare(v)) continue;
            try {
                v.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
                const dx = v.location.x - center.x;
                const dz = v.location.z - center.z;
                const h = Math.hypot(dx, dz) || 1;
                knockback(v, dx / h, dz / h, 1.2, 0.6);
            } catch { }
        }
    }, 1);

    return true;
}

/** Event horizon diameter, in blocks, with the well fully open */
const BLACK_HOLE_SIZE = 1.1;

/** How many ticks the black hole takes to open on collapse */
const BLACK_HOLE_BURST_TICKS = 16;

/** How much the well grows in the burst (0.9 = almost double) */
const BLACK_HOLE_BURST_GROWTH = 0.9;

/**
 * A player's tamed animal (wolf, cat, parrot, mount...)
 */
function isPet(entity) {
    try {
        if (entity.hasComponent("minecraft:is_tamed")) return true;
    } catch { }
    try {
        // Tamed mounts use a different marker on some versions
        if (entity.hasComponent("minecraft:tamemount") && entity.hasComponent("minecraft:is_saddled")) return true;
    } catch { }
    return false;
}

/**
 * The well opening on collapse: grows and fades over a few ticks.
 * Square-root growth starts fast and slows down, the way an explosion opens.
 */
function burstBlackHole(dimension, center, coreSize) {
    let t = 0;
    const id = system.runInterval(() => {
        t++;
        const p = t / BLACK_HOLE_BURST_TICKS;          // 0 -> 1
        const scale = 1 + BLACK_HOLE_BURST_GROWTH * Math.sqrt(p);   // abre rápido e desacelera
        const alpha = Math.max(0, 1 - p * p);         // segura a tint e some no finish

        try {
            const holeVars = new MolangVariableMap();
            holeVars.setFloat("radius", coreSize * 2 * scale);
            holeVars.setFloat("spin", (t * 9) % 360);
            holeVars.setFloat("alpha", alpha);
            dimension.spawnParticle("ws:black_hole", center, holeVars);
        } catch { }

        if (t >= BLACK_HOLE_BURST_TICKS) system.clearRun(id);
    }, 1);
}

/**
 * Tornado (advanced): a funnel touches down where the caster is aiming and then
 * walks away from them in a straight line, following the lie of the land.
 * Anything it passes is dragged round its core and thrown into the air.
 */
function castTornado(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 20) * modifiers.range;

    const aim = findAimTarget(player, maxRange);
    const target = aim.location ?? spawnInFront(headLoc, viewDir, maxRange);
    const footing = tornadoFooting(dimension, target.x, target.y + 1, target.z);
    if (footing === null) return false;

    // Heading is the flat part of the view only. Following the pitch as well
    // would send the funnel climbing into the sky when cast while looking up.
    const flat = Math.hypot(viewDir.x, viewDir.z);
    const dir = flat < 0.001
        ? { x: 0, z: 1 }
        : { x: viewDir.x / flat, z: viewDir.z / flat };

    const radius = (props.effect_radius ?? 3) * modifiers.blast;

    let funnel;
    try {
        funnel = dimension.spawnEntity("ws:tornado", { x: target.x, y: footing, z: target.z });
        // The model is three blocks across at its top, so the scale that gives
        // the wanted diameter is that diameter over three.
        funnel.setProperty("ws:size", Math.max(0.2, Math.min(6, (radius * 2) / 3)));
        funnel.setProperty("ws:spin", props.spin ?? 260);
    } catch (err) {
        console.warn("[castTornado Error]: " + err);
        return false;
    }

    try {
        dimension.playSound("ws.entity.tornado.ambient", { x: target.x, y: footing, z: target.z }, { volume: 1.1 });
    } catch { }

    driveTornado(player, funnel, dir, radius, props, modifiers);
    return true;
}

/** How far the funnel travels each tick */
const TORNADO_STEP_DEFAULT = 0.16;

/**
 * How fast a victim is swung round the funnel, in radians a tick.
 * Flip the sign if they end up turning against the way the model spins.
 */
const TORNADO_ORBIT_SPEED = 0.34;

/**
 * How wide a victim circles, as a share of the funnel's width at that height.
 * Below 1 they ride just inside the wall; at 0 they would collapse into the
 * middle, which is the one thing a tornado must never look like.
 */
const TORNADO_ORBIT_BAND = 0.82;

/**
 * How wide they circle down at the tip, where the funnel is at its narrowest.
 * The model tapers from a sixth of its width at the foot to full width at the
 * mouth, and the orbit has to taper with it or they would be hanging outside
 * the tip. Tracking that taper exactly, at about 0.2, pinches the circle down
 * to a single block while they are still low - close enough to the middle to
 * look wrong. Half keeps it visibly a circle the whole way up, and it still
 * settles at around nine tenths of the wall once they are carried high.
 */
const TORNADO_ORBIT_FLOOR = 0.5;

/** What share of the distance to its proper orbit a victim closes each tick */
const TORNADO_ORBIT_CLOSE = 0.15;

/**
 * How much the outer drag leans sideways rather than straight in. Without this
 * prey walks at the funnel head-on; with it they curve in, which is both how a
 * tornado pulls and how they arrive already circling.
 */
const TORNADO_PULL_SWIRL = 0.55;

/** How fast a victim is carried up the funnel, in blocks a tick */
const TORNADO_CLIMB = 0.11;

/**
 * How far up the funnel a victim rises, as a share of its height.
 * This is where their feet end up, not their head, so it has to leave room for
 * the tallest thing the funnel might be holding. At three quarters a player
 * stands with their head exactly at the mouth; three fifths keeps a whole body
 * inside the texture with room to spare.
 */
const TORNADO_CARRY_SHARE = 0.6;

/** How hard a victim is flung when the funnel finally lets go */
const TORNADO_RELEASE = 0.9;

/** The biggest step up or down the funnel will take before it stops advancing */
const TORNADO_MAX_CLIMB = 2;

/** How far below itself the funnel will look for ground before giving up */
const TORNADO_MAX_DROP = 6;

/** How often the ambient roar is played again, in ticks */
const TORNADO_SOUND_INTERVAL = 45;

/**
 * The ground the funnel should stand on near a point, or null if there is
 * nothing within reach - over a ravine or the void it simply stops there.
 */
function tornadoFooting(dimension, x, fromY, z) {
    const solid = firstSolidBetween(dimension, x, fromY, fromY - TORNADO_MAX_DROP, z);
    if (solid === null) return null;
    return hammerRestY(dimension, x, solid, z);
}

/**
 * The funnel's life: walk, seize, wound, and let go when its time is up.
 *
 * Whatever it touches is held rather than pushed. A victim is placed on its own
 * orbit every tick, spiralling in and rising, and because that orbit is measured
 * from the funnel it travels with it - caught is caught until the storm dies.
 * That means moving them outright instead of shoving them: a shove is fought by
 * their own walking and by gravity, and they fall out within a second or two.
 */
/**
 * Como um jogador apanhado pelo funil e atirado.
 *
 * Tudo por velocidade, nunca por teletransporte: e isso que lhe deixa a camara
 * e o controlo. Roda sobretudo de lado, com um resto para dentro, e so levanta
 * de quatro em quatro ticks - applyKnockback fixa a velocidade em vez de a
 * somar, por isso um impulso vertical todo o tick venceria a gravidade e ele
 * ficaria pendurado no ar para sempre.
 */
const TORNADO_SWIRL_PLAYER = 0.78;
const TORNADO_LIFT_PLAYER = 0.34;
const TORNADO_LIFT_EVERY = 4;

function swirlCaught(victim, pos, away, dx, dz, ticks) {
    const len = away || 0.001;
    const inX = dx / len;
    const inZ = dz / len;
    // mais tangente do que radial: e o que faz girar em vez de colar ao centro
    const spinX = inX * 0.3 - inZ * 0.95;
    const spinZ = inZ * 0.3 + inX * 0.95;
    const norm = Math.hypot(spinX, spinZ) || 1;
    const sobe = ticks % TORNADO_LIFT_EVERY === 0 ? TORNADO_LIFT_PLAYER : 0;
    try {
        knockback(victim, spinX / norm, spinZ / norm, TORNADO_SWIRL_PLAYER, sobe);
    } catch { }
}

function driveTornado(player, funnel, dir, radius, props, modifiers) {
    const dimension = funnel.dimension;
    const duration = Math.round((props.duration ?? 300) * modifiers.duration);
    const step = props.move_speed ?? TORNADO_STEP_DEFAULT;
    const interval = props.attack_interval ?? 10;
    const damage = props.damage ?? 3;

    // The reach is much wider than the funnel itself. Anything inside it is
    // dragged in; only what actually reaches the funnel gets picked up.
    const pullRadius = (props.pull_radius ?? 10) * modifiers.blast;
    const pullStrength = props.pull_strength ?? 0.35;

    // Exactly how tall the funnel stands. The model is four blocks tall and is
    // scaled by twice the radius over three, so eight thirds of the radius. The
    // smoke is spread up it and the orbits are measured against it, so this has
    // to be the real figure rather than a rounded one - anything above it is
    // outside the texture, hanging in the open air.
    const bodyHeight = (radius * 8) / 3;
    const carryHeight = bodyHeight * TORNADO_CARRY_SHARE;

    // Captured at cast time: survives the player reference dying mid-spell,
    // which comparing against the live object does not.
    const ownerId = player.id;

    /** Everything the funnel is currently holding, by entity id */
    const held = new Map();

    let pos = funnel.location;
    let ticks = 0;

    const id = system.runInterval(() => {
        ticks++;

        if (!funnel.isValid()) {
            system.clearRun(id);
            releaseTornado(held);
            return;
        }

        // Walk it forward, keeping its foot on whatever ground the next step
        // lands on. A wall or a drop it cannot manage leaves it turning on the
        // spot rather than climbing thin air.
        const nextX = pos.x + dir.x * step;
        const nextZ = pos.z + dir.z * step;
        const nextY = tornadoFooting(dimension, nextX, pos.y + TORNADO_MAX_CLIMB, nextZ);
        if (nextY !== null && Math.abs(nextY - pos.y) <= TORNADO_MAX_CLIMB) {
            pos = { x: nextX, y: nextY, z: nextZ };
            try { funnel.teleport(pos, { dimension, keepVelocity: false }); } catch { }
        }

        // Dust off the ground at the tip, smoke up the body of the storm
        try {
            const dustVars = new MolangVariableMap();
            dustVars.setFloat("scale", radius);
            dimension.spawnParticle("ws:tornado_dust", { x: pos.x, y: pos.y + 0.2, z: pos.z }, dustVars);
        } catch { }

        if (ticks % 2 === 0) {
            for (let i = 0; i < 3; i++) {
                const up = bodyHeight * (0.25 + 0.3 * i);
                // it is a cone, so the smoke ring widens as it goes up
                const ring = radius * (0.45 + 0.55 * (up / bodyHeight));
                try {
                    const smokeVars = new MolangVariableMap();
                    smokeVars.setFloat("scale", ring);
                    dimension.spawnParticle("ws:tornado_smoke", { x: pos.x, y: pos.y + up, z: pos.z }, smokeVars);
                } catch { }
            }
        }

        if (ticks % TORNADO_SOUND_INTERVAL === 0) {
            try { dimension.playSound("ws.entity.tornado.ambient", pos, { volume: 1.0, pitch: 0.9 }); } catch { }
        }

        // Wounds only land on the interval. Every tick would make standing in
        // it instant death, and nothing caught can walk out on its own.
        const wounds = ticks % interval === 0;
        const core = { x: pos.x, y: pos.y + 1.5, z: pos.z };

        // Everything in the wider reach is dragged towards the funnel. What has
        // actually arrived at it is seized instead, on the angle it arrived at,
        // so it simply carries on round from where it already was.
        for (const v of nearbyHammerTargets(dimension, core, pullRadius, player)) {
            if (v.id === ownerId || isPet(v) || held.has(v.id)) continue;
            try {
                const dx = pos.x - v.location.x;
                const dz = pos.z - v.location.z;
                const away = Math.hypot(dx, dz) || 0.001;

                if (away <= radius) {
                    // A player is swept, never seized.
                    //
                    // The carry below moves what it holds by teleporting it every
                    // tick. On a mob that looks like a storm; on a player it means
                    // the server overrides their position twenty times a second,
                    // and the camera stops obeying - they cannot look down, cannot
                    // aim, cannot blink out. Held and unable to leave, the wounds
                    // on the interval then added up to certain death.
                    //
                    // So players are thrown around by velocity instead. Still
                    // spun, still lifted, still hurt - but they keep the controls
                    // and can fight their way out.
                    if (v.typeId === "minecraft:player") {
                        swirlCaught(v, pos, away, dx, dz, ticks);
                        if (wounds) {
                            try { v.applyDamage(damage, { cause: "entity_attack", damagingEntity: player }); } catch { }
                        }
                        continue;
                    }

                    // The height is clamped on the way in. Without the ceiling,
                    // anything seized while already high - off a ledge, out of a
                    // tree, a flying mob, or something the drag below had lifted
                    // - kept that height for good, because the carry only ever
                    // climbed. It ended up circling in the open air above the
                    // funnel with nothing drawn around it.
                    held.set(v.id, {
                        entity: v,
                        angle: Math.atan2(-dz, -dx),
                        orbit: away,
                        height: Math.min(carryHeight, Math.max(0.3, v.location.y - pos.y))
                    });
                    continue;
                }

                const inX = dx / away;
                const inZ = dz / away;
                const dragX = inX * (1 - TORNADO_PULL_SWIRL) - inZ * TORNADO_PULL_SWIRL;
                const dragZ = inZ * (1 - TORNADO_PULL_SWIRL) + inX * TORNADO_PULL_SWIRL;
                const len = Math.hypot(dragX, dragZ) || 1;

                // Harder the closer they already are, the way real suction works
                const force = pullStrength * (1.4 - 0.4 * (away / pullRadius));
                knockback(v, dragX / len, dragZ / len, force, 0.12);
            } catch { }
        }

        // and carry everything it already has
        for (const [victimId, grip] of held) {
            const victim = grip.entity;
            let gone = false;
            try { gone = !victim.isValid(); } catch { gone = true; }
            if (gone) { held.delete(victimId); continue; }

            grip.angle += TORNADO_ORBIT_SPEED;

            // Drift towards the carry height from whichever side it is on, and
            // never step past it. Climbing only, with no ceiling, is what let a
            // victim end up above the funnel and stay there.
            const drift = carryHeight - grip.height;
            grip.height += Math.max(-TORNADO_CLIMB, Math.min(TORNADO_CLIMB, drift));

            // The funnel is a cone, so where the wall is depends on how high up
            // they have been carried. Following it outwards as they rise is
            // what keeps them circling the thing instead of inside it.
            const taper = TORNADO_ORBIT_FLOOR + (1 - TORNADO_ORBIT_FLOOR) * Math.min(1, grip.height / bodyHeight);
            const wall = radius * TORNADO_ORBIT_BAND * taper;
            grip.orbit += (wall - grip.orbit) * TORNADO_ORBIT_CLOSE;

            try {
                victim.teleport({
                    x: pos.x + Math.cos(grip.angle) * grip.orbit,
                    y: pos.y + grip.height,
                    z: pos.z + Math.sin(grip.angle) * grip.orbit
                }, { dimension, keepVelocity: false });
            } catch {
                held.delete(victimId);
                continue;
            }

            if (wounds) {
                try { victim.applyDamage(damage, { cause: "entity_attack", damagingEntity: player }); } catch { }
            }
        }

        if (ticks >= duration) {
            system.clearRun(id);
            releaseTornado(held);
            try { funnel.remove(); } catch { }
        }
    }, 1);
}

/**
 * The storm dying: everything it was holding is thrown clear along the way it
 * was already travelling, rather than simply dropped on the spot.
 */
function releaseTornado(held) {
    for (const grip of held.values()) {
        try {
            if (!grip.entity.isValid()) continue;
            knockback(grip.entity, Math.cos(grip.angle), Math.sin(grip.angle), TORNADO_RELEASE, 0.35);
        } catch { }
    }
    held.clear();
}

// ------------------------------------------------------------------ Frost Step

/** Wizards currently walking on frost: player id -> the run id freezing under them */
const activeFrostStep = new Map();

/** How often the ground under a frost walker is looked at, in ticks */
const FROST_STEP_PERIOD = 2;

/**
 * Frost Step (advanced): for a while, water freezes under the wizard's feet as
 * they walk, so they can cross it.
 *
 * Only water is ever touched, and only with frosted ice, which thaws by itself
 * the way the Frost Walker enchantment's does. Nothing has to be remembered and
 * put back, and a lake is no worse off a minute later.
 */
function castFrostStep(player, props, modifiers) {
    const ticks = Math.round((props.frost_step_duration ?? 600) * modifiers.duration);
    // strength 0 freezes the block underfoot and its neighbours; each step out
    // widens the patch by one
    const reach = 1 + (props.frost_step_strength ?? 0);

    // Casting it again restarts it rather than running two at once
    stopFrostStep(player.id);

    const until = system.currentTick + ticks;
    const id = system.runInterval(() => {
        let gone = false;
        try { gone = !player.isValid(); } catch { gone = true; }
        if (gone || system.currentTick > until) {
            stopFrostStep(player.id);
            return;
        }
        freezeUnder(player, reach);
    }, FROST_STEP_PERIOD);

    activeFrostStep.set(player.id, id);

    try {
        player.playSound("mob.wither.shoot", { pitch: 1.8, volume: 0.5 });
        const burst = new MolangVariableMap();
        burst.setFloat("scale", 2.4);
        player.dimension.spawnParticle("ws:frost_step", {
            x: player.location.x,
            y: player.location.y + 0.15,
            z: player.location.z
        }, burst);
    } catch { }

    return true;
}

function stopFrostStep(playerId) {
    const id = activeFrostStep.get(playerId);
    if (id === undefined) return;
    try { system.clearRun(id); } catch { }
    activeFrostStep.delete(playerId);
}

/**
 * Turns the water the wizard is standing over into frosted ice.
 * Flowing water is left alone: freezing a waterfall mid-fall looks wrong and
 * dams things that were never meant to be dammed.
 */
function freezeUnder(player, reach) {
    const dimension = player.dimension;
    const base = player.location;
    const y = Math.floor(base.y) - 1;

    for (let dx = -reach; dx <= reach; dx++) {
        for (let dz = -reach; dz <= reach; dz++) {
            const x = Math.floor(base.x) + dx;
            const z = Math.floor(base.z) + dz;

            // Round, and measured from where the wizard actually is rather than
            // from the corner of the block they happen to be standing on. Taken
            // off the block grid instead, the patch sits to one side of them by
            // however far into the block they are standing.
            const offX = x + 0.5 - base.x;
            const offZ = z + 0.5 - base.z;
            if (offX * offX + offZ * offZ > (reach + 0.5) * (reach + 0.5)) continue;

            try {
                const block = dimension.getBlock({ x, y, z });
                if (!block || block.typeId !== "minecraft:water") continue;
                // only still, full water - a partly filled block is flowing
                const level = block.permutation?.getState("liquid_depth");
                if (level !== undefined && level !== 0) continue;
                block.setType("minecraft:frosted_ice");
            } catch { }
        }
    }

    try {
        const frost = new MolangVariableMap();
        frost.setFloat("scale", 1.0);
        dimension.spawnParticle("ws:frost_step", { x: base.x, y: base.y + 0.1, z: base.z }, frost);
    } catch { }
}

// ------------------------------------------------------------------ Forcefield

/** How hard anything inside the dome is thrown back out of it */
const FORCEFIELD_SHOVE = 0.9;

/** How often the dome sweeps for intruders, in ticks */
const FORCEFIELD_PERIOD = 4;

/**
 * Forcefield (advanced): a dome of light at the wizard's feet that shoves
 * hostiles back out of it and keeps them out until it fades.
 *
 * It stays where it was cast rather than following the wizard, so it can be
 * dropped on a doorway or over a fallen ally and held.
 */
function castForcefield(player, props, modifiers) {
    const dimension = player.dimension;
    const radius = (props.effect_radius ?? 3) * modifiers.blast;
    const ticks = Math.round((props.duration ?? 600) * modifiers.duration);

    const foot = groundBelow(dimension, player.location);
    const centre = { x: foot.x, y: foot.y, z: foot.z };

    // The ring on the floor is the ground rune wearing its healing aura face -
    // the same entity the aura spells use, sized to this dome.
    const ring = spawnRune(dimension, centre, 4, radius * 2, 12);

    const ownerId = player.id;
    let elapsed = 0;

    const id = system.runInterval(() => {
        elapsed += FORCEFIELD_PERIOD;

        if (elapsed >= ticks) {
            system.clearRun(id);
            fadeRune(ring);
            try { dimension.playSound("random.glass", centre, { volume: 0.8, pitch: 1.4 }); } catch { }
            return;
        }

        drawDome(dimension, centre, radius, elapsed);

        for (const v of nearbyHammerTargets(dimension, { x: centre.x, y: centre.y + 1, z: centre.z }, radius, player)) {
            if (v.id === ownerId || isPet(v)) continue;
            try {
                const dx = v.location.x - centre.x;
                const dz = v.location.z - centre.z;
                const away = Math.hypot(dx, dz) || 0.001;
                knockback(v, dx / away, dz / away, FORCEFIELD_SHOVE, 0.25);
                dimension.spawnParticle("minecraft:villager_happy", v.location);
            } catch { }
        }
    }, FORCEFIELD_PERIOD);

    try {
        dimension.playSound("beacon.activate", centre, { volume: 0.7, pitch: 1.5 });
    } catch { }

    return true;
}

/**
 * The shell, drawn as a ring of particles that climbs and shrinks over time so
 * the whole dome is described a slice at a time rather than all at once.
 */
function drawDome(dimension, centre, radius, elapsed) {
    // one full sweep from floor to crown every five seconds
    const phase = (elapsed % 100) / 100;
    const up = Math.sin(phase * Math.PI) * radius;
    const ringRadius = Math.sqrt(Math.max(0, radius * radius - up * up));

    for (let i = 0; i < 12; i++) {
        const angle = (Math.PI * 2 * i) / 12 + phase * 2;
        try {
            dimension.spawnParticle("minecraft:end_rod", {
                x: centre.x + Math.cos(angle) * ringRadius,
                y: centre.y + up,
                z: centre.z + Math.sin(angle) * ringRadius
            });
        } catch { }
    }
}

// ------------------------------------------------------------------ Ice Spikes

/** How many ticks apart each panel of the wall is raised */
const ICE_SPIKE_STAGGER = 2;

/** How far below and above the aimed point a panel will look for footing */
const ICE_SPIKE_REACH = 4;

/**
 * How far apart the panels stand, in blocks. This is a fact about the model,
 * not about the spell: the pane is 29 model units across, which is 1.8125
 * blocks, so standing them a shade closer than that leaves no seam between one
 * and the next.
 */
const ICE_SPIKE_SPACING = 1.75;

/**
 * How thick the wall is as an obstacle, in blocks, and how high it stops things.
 *
 * The panels carry collision of their own, but an entity's collision box is a
 * square of a single width and theirs is narrower than the gap between them -
 * wide enough to walk through sideways. Widening the box would make the wall as
 * thick as it is wide, a metre and a half of invisible obstacle in front of a
 * pane you can see through. So the wall is held here instead: anything that
 * works its way into the slab is put back on the side it came from, which
 * leaves no gap to find at any width.
 */
const ICE_SPIKE_THICKNESS = 0.9;
const ICE_SPIKE_HEIGHT = 2.6;

/**
 * Ice Spikes (advanced): a wall of ice tears up out of the ground across the
 * way you are facing, wounding and slowing whatever was standing there and then
 * holding the line until it shatters.
 *
 * It is a wall across your line of sight, not a ring around the target - a ring
 * closes you in as readily as it closes anything out, which is no use when what
 * you wanted was something between you and what is coming.
 *
 * The wall is made of entities, not blocks. Blocks would have meant writing to
 * the world and putting it back afterwards, and any of that going wrong leaves
 * someone's build with ice in it. Entities touch nothing: when the spell ends
 * they are simply removed, and the ground underneath was never altered. They
 * carry collision, so the wall really does block the way while it stands.
 *
 * Each panel rises out of the floor on its own, driven by the model's animation
 * from the moment it spawns - the script only decides where and when.
 */
function castIceSpikes(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 20) * modifiers.range;
    const aim = findAimTarget(player, maxRange);
    const centre = aim.location ?? spawnInFront(headLoc, viewDir, maxRange);

    const radius = (props.effect_radius ?? 2.5) * modifiers.blast;
    const count = props.ice_spike_count ?? 5;
    const damage = props.damage ?? 5;
    const standing = Math.round((props.duration ?? 140) * modifiers.duration);

    // The flat part of the view only. The wall runs at right angles to it, and
    // its panels face back down it, so it stands across your line of sight.
    const flat = Math.hypot(viewDir.x, viewDir.z);
    const dir = flat < 0.001 ? { x: 0, z: 1 } : { x: viewDir.x / flat, z: viewDir.z / flat };
    const along = { x: -dir.z, z: dir.x };
    const yaw = (-Math.atan2(dir.x, dir.z) * 180) / Math.PI;

    const wall = [];
    const middle = (count - 1) / 2;

    // The panels overlap, so without this anything standing in the middle of
    // the wall would be wounded once by every panel that reached it - five
    // times over, for a spell that says it does five damage.
    const wounded = new Set();

    // Raised from the middle outwards, which reads as the wall unfurling from
    // where you aimed rather than sweeping in from one end.
    const order = [];
    for (let i = 0; i < count; i++) order.push(i);
    order.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));

    order.forEach((slot, wave) => {
        const off = (slot - middle) * ICE_SPIKE_SPACING;
        const x = centre.x + along.x * off;
        const z = centre.z + along.z * off;
        system.runTimeout(() => {
            const panel = raisePanel(dimension, x, centre.y, z, yaw);
            if (panel) wall.push(panel);
            try {
                dimension.playSound("random.glass", { x, y: centre.y, z }, { volume: 0.8, pitch: 0.7 + (wave / count) * 0.6 });
            } catch { }
            hurtAtPanel(dimension, player, { x, y: centre.y, z }, radius, damage, props, modifiers, wounded);
        }, wave * ICE_SPIKE_STAGGER);
    });

    holdWall(dimension, centre, dir, along, (count * ICE_SPIKE_SPACING) / 2, standing);
    system.runTimeout(() => shatterWall(dimension, wall), standing);
    return true;
}

/**
 * Keeps the wall solid for as long as it stands.
 *
 * Every tick it looks for anything that has got into the slab of space the wall
 * occupies and sets it back down on the face it entered by. It is a hard stop
 * rather than a shove, because a shove can be walked through by anything that
 * pushes harder than the shove pushes back, and this has to hold.
 *
 * Only living things are stopped. Arrows, dropped items and experience are left
 * to fly through: catching them would mean teleporting them, which reads as
 * them vanishing rather than as them hitting ice.
 */
function holdWall(dimension, centre, dir, along, halfLength, standing) {
    const half = ICE_SPIKE_THICKNESS / 2;
    let ticks = 0;

    const id = system.runInterval(() => {
        ticks++;
        if (ticks > standing) {
            system.clearRun(id);
            return;
        }

        let crowd;
        try {
            crowd = dimension.getEntities({ location: centre, maxDistance: halfLength + 3 });
        } catch {
            return;
        }

        for (const v of crowd) {
            try {
                if (v.typeId === "ws:ice_spike") continue;
                if (!v.getComponent("minecraft:health")) continue;

                const at = v.location;
                const up = at.y - centre.y;
                if (up < -1.5 || up > ICE_SPIKE_HEIGHT) continue;

                const offX = at.x - centre.x;
                const offZ = at.z - centre.z;

                // how far through the wall, and how far along it
                const through = offX * dir.x + offZ * dir.z;
                const across = offX * along.x + offZ * along.z;
                if (Math.abs(across) > halfLength) continue;
                if (Math.abs(through) >= half) continue;

                // back out the way it came, with a little to spare so it is not
                // left resting exactly on the face and caught again next tick
                const side = through >= 0 ? 1 : -1;
                const back = half - through * side + 0.08;
                v.teleport({
                    x: at.x + dir.x * side * back,
                    y: at.y,
                    z: at.z + dir.z * side * back
                }, { dimension, keepVelocity: false });
            } catch { }
        }
    }, 1);
}

/**
 * One panel. Finds the floor under its place along the wall and stands it
 * there. Returns null where there is no floor within reach, so a wall thrown
 * across a ravine comes up with a gap in it rather than panels hanging in the
 * air.
 */
function raisePanel(dimension, x, aroundY, z, yaw) {
    const solid = firstSolidBetween(dimension, x, aroundY + ICE_SPIKE_REACH, aroundY - ICE_SPIKE_REACH, z);
    if (solid === null) return null;
    const y = hammerRestY(dimension, x, solid, z);

    try {
        const panel = dimension.spawnEntity("ws:ice_spike", { x, y, z });
        panel.teleport({ x, y, z }, {
            dimension,
            keepVelocity: false,
            rotation: { x: 0, y: yaw }
        });
        const frost = new MolangVariableMap();
        frost.setFloat("scale", 1.6);
        dimension.spawnParticle("ws:frost_step", { x, y: y + 0.4, z }, frost);
        return panel;
    } catch (err) {
        console.warn("[raisePanel Error]: " + err);
        return null;
    }
}

/**
 * The ice coming up under a creature. Done panel by panel rather than in one
 * sweep of the whole wall, so it catches what is standing on the line and
 * leaves alone what is merely near the middle of it.
 */
function hurtAtPanel(dimension, player, at, radius, damage, props, modifiers, wounded) {
    for (const v of nearbyHammerTargets(dimension, at, radius, player)) {
        if (v.id === player.id || isPet(v) || wounded.has(v.id)) continue;
        wounded.add(v.id);
        try {
            v.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
            v.addEffect("slowness", Math.round((props.effect_duration ?? 100) * modifiers.duration), {
                amplifier: props.effect_strength ?? 0,
                showParticles: true
            });
        } catch { }
    }
}

/**
 * The wall coming down: every panel removed, with frost where it stood.
 */
function shatterWall(dimension, wall) {
    // Remembered as it goes, because a removed entity has no location to ask
    // for afterwards
    let heard = null;

    for (const panel of wall) {
        try {
            if (!panel.isValid()) continue;
            const at = panel.location;
            if (heard === null) heard = { x: at.x, y: at.y, z: at.z };
            const frost = new MolangVariableMap();
            frost.setFloat("scale", 2.0);
            dimension.spawnParticle("ws:frost_step", { x: at.x, y: at.y + 0.8, z: at.z }, frost);
            panel.remove();
        } catch { }
    }

    if (heard !== null) {
        try { dimension.playSound("random.glass", heard, { volume: 1.0, pitch: 1.3 }); } catch { }
    }
}

// ------------------------------------------------------------------ Meteor

/** How far out along its path the rock starts, in blocks */
const METEOR_TRAVEL = 46;

/**
 * How far below an aimed point the spell will look for ground to hit.
 *
 * Deliberately short. It was 128, which on a shot into open sky walked all the
 * way to the bedrock at the bottom of the world and called that the target -
 * and then tried to start the rock forty blocks out and thirty up from there,
 * in a chunk nowhere near anybody, which is what threw. Anything more than a
 * few dozen blocks under where you were pointing is not what you were aiming
 * at anyway.
 */
const METEOR_SEEK = 48;

/**
 * How many times the start of the flight is drawn back in towards the target
 * when the sky out there turns out not to be loaded, and by how much each time.
 */
const METEOR_TRIES = 4;
const METEOR_PULL_IN = 0.65;

/** How much of that distance is height: 0.7 gives a shallow slanting fall */
const METEOR_SLOPE = 0.72;

/** How far the rock moves along its path each tick */
const METEOR_SPEED = 2.2;

/** How wide the blast is for each point of blast_strength, in blocks */
const METEOR_BASE_BLAST = 2.5;

/**
 * Meteor (master): a burning rock is called out of the sky onto the aimed
 * point.
 *
 * It starts beyond the target and high, and comes in towards the wizard. They
 * are already looking that way, so it drops into view ahead of them and they
 * watch the whole approach. Starting it behind them, as it did at first, meant
 * the rock was over their head before they knew it existed.
 *
 * The rock is a real entity so it can be seen tumbling and lit from its own
 * cracks. It is removed on impact, and cannot be hurt or pushed on the way in.
 */
function castMeteor(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 40) * modifiers.range;

    const aim = findAimTarget(player, maxRange);
    const aimed = aim.entity ? aim.entity.location : (aim.location ?? spawnInFront(headLoc, viewDir, maxRange));

    // Aimed at open sky, the rock still has to come down somewhere. The point
    // is dropped to the first ground beneath it before anything else is worked
    // out, so the flight ends on the floor instead of bursting in mid air. A
    // point that was already on the ground finds itself and does not move.
    const floor = firstSolidBetween(dimension, aimed.x, aimed.y + 1, aimed.y - METEOR_SEEK, aimed.z);
    if (floor === null) {
        // Open sky with nothing under it inside the search, or a stretch of
        // world that is not loaded and so cannot be read. Either way there is
        // nothing there to hit, and failing costs the caster nothing.
        try {
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_block" });
            player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        } catch { }
        return false;
    }
    const impact = { x: aimed.x, y: floor + 1, z: aimed.z };

    // Its path runs on outwards from the target and up, so the rock starts
    // beyond what it is going to hit and flies back down towards the wizard.
    const spread = Math.hypot(impact.x - player.location.x, impact.z - player.location.z);
    let heading;
    if (spread >= 0.5) {
        heading = { x: (impact.x - player.location.x) / spread, z: (impact.z - player.location.z) / spread };
    } else {
        // aimed straight up or straight down, so there is no direction in the
        // aim to use - fall back to the way they are facing, and to due south
        // if they are not facing anywhere either
        const flat = Math.hypot(viewDir.x, viewDir.z);
        heading = flat < 0.001 ? { x: 0, z: 1 } : { x: viewDir.x / flat, z: viewDir.z / flat };
    }

    const born = spawnMeteorRock(dimension, impact, heading);
    if (born === null) {
        try {
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_block" });
            player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        } catch { }
        return false;
    }
    const rock = born.rock;
    const start = born.start;

    const legX = impact.x - start.x;
    const legY = impact.y - start.y;
    const legZ = impact.z - start.z;
    const leg = Math.hypot(legX, legY, legZ) || 1;
    const step = { x: (legX / leg) * METEOR_SPEED, y: (legY / leg) * METEOR_SPEED, z: (legZ / leg) * METEOR_SPEED };

    try {
        dimension.playSound("mob.enderdragon.flap", start, { volume: 1.6, pitch: 0.45 });
        player.playSound("mob.enderdragon.growl", { volume: 0.7, pitch: 1.4 });
    } catch { }

    const ownerId = player.id;
    let at = { x: start.x, y: start.y, z: start.z };
    let travelled = 0;

    const id = system.runInterval(() => {
        let lost = false;
        try { lost = !rock.isValid(); } catch { lost = true; }
        if (lost) {
            // The rock went out from under us, most likely because the chunk it
            // was crossing stopped ticking. The spell was paid for, so it still
            // lands where it was sent rather than simply vanishing.
            system.clearRun(id);
            meteorImpact(dimension, player, ownerId, impact, props, modifiers);
            return;
        }

        const next = { x: at.x + step.x, y: at.y + step.y, z: at.z + step.z };

        // Anything solid along this leg ends the flight there, so a hillside in
        // the way is struck rather than flown through.
        if (isSolidBlockAt(dimension, next.x, next.y, next.z)) {
            system.clearRun(id);
            try { rock.remove(); } catch { }
            meteorImpact(dimension, player, ownerId, at, props, modifiers);
            return;
        }

        at = next;
        try { rock.teleport(at, { dimension, keepVelocity: false }); } catch { }
        drawMeteorTrail(dimension, at);

        travelled += METEOR_SPEED;
        if (travelled >= leg) {
            system.clearRun(id);
            try { rock.remove(); } catch { }
            meteorImpact(dimension, player, ownerId, impact, props, modifiers);
        }
    }, 1);

    return true;
}

/**
 * Puts the rock in the sky and hands back where it started.
 *
 * The far end of the flight can easily be somewhere the game is not currently
 * keeping loaded - forty blocks out and thirty up, over unexplored ground, is
 * often past the edge of what is ticking. Spawning there throws. So the start
 * is drawn in towards the target and tried again, a few times, until it lands
 * somewhere the world actually exists. A shorter run in is a shorter show, and
 * a shorter show beats an error and no spell at all.
 *
 * Returns null only when even a quarter of the distance is out of reach, which
 * means the target itself is barely loaded and the spell should not go ahead.
 */
function spawnMeteorRock(dimension, impact, heading) {
    let reach = METEOR_TRAVEL;

    for (let attempt = 0; attempt < METEOR_TRIES; attempt++) {
        const start = {
            x: impact.x + heading.x * reach,
            y: impact.y + reach * METEOR_SLOPE,
            z: impact.z + heading.z * reach
        };
        try {
            const rock = dimension.spawnEntity("ws:meteor", start);
            return { rock, start };
        } catch {
            reach *= METEOR_PULL_IN;
        }
    }

    console.warn("[spawnMeteorRock]: no loaded sky above " + Math.round(impact.x) + "," + Math.round(impact.z));
    return null;
}

/** The fire streaming off the rock behind it */
function drawMeteorTrail(dimension, at) {
    for (let i = 0; i < 6; i++) {
        try {
            dimension.spawnParticle("minecraft:basic_flame_particle", {
                x: at.x + (Math.random() - 0.5) * 1.6,
                y: at.y + (Math.random() - 0.5) * 1.6,
                z: at.z + (Math.random() - 0.5) * 1.6
            });
        } catch { }
    }
    try {
        dimension.spawnParticle("minecraft:basic_smoke_particle", { x: at.x, y: at.y + 0.6, z: at.z });
    } catch { }
}

/**
 * The landing. The crater is a real explosion, so it breaks ground and starts
 * fires the way one should - if that is not wanted, breaks_blocks in the spell
 * data turns the digging off and leaves the rest.
 */
function meteorImpact(dimension, player, ownerId, at, props, modifiers) {
    const blast = (props.blast_strength ?? 2) * METEOR_BASE_BLAST * modifiers.blast;

    try {
        dimension.createExplosion(at, blast, {
            breaksBlocks: props.breaks_blocks !== false,
            causesFire: true,
            source: player
        });
    } catch (err) {
        console.warn("[meteorImpact Error]: " + err);
    }

    for (const v of nearbyHammerTargets(dimension, at, blast, player)) {
        if (v.id === ownerId || isPet(v)) continue;
        try {
            v.applyDamage(props.damage ?? 18, { cause: "fire", damagingEntity: player });
            v.setOnFire(props.burn_duration ?? 8, true);
            const dx = v.location.x - at.x;
            const dz = v.location.z - at.z;
            const away = Math.hypot(dx, dz) || 1;
            knockback(v, dx / away, dz / away, 1.4, 0.7);
        } catch { }
    }

    try {
        dimension.playSound("random.explode", at, { volume: 1.6, pitch: 0.6 });
        for (let i = 0; i < 40; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * blast;
            dimension.spawnParticle("minecraft:basic_flame_particle", {
                x: at.x + Math.cos(a) * r,
                y: at.y + Math.random() * 2,
                z: at.z + Math.sin(a) * r
            });
        }
    } catch { }
}

// ------------------------------------------------------------------ Earthquake

/** How many points around the ring throw up dust, per block of its radius */
const QUAKE_DETAIL = 2;

/** How often the screen is shaken again while the ring runs, in ticks */
const QUAKE_SHAKE_PERIOD = 10;

/**
 * How dark the dust is, from soot to pale ash.
 *
 * It used to be read off the block underfoot, so the wave turned green over
 * grass and yellow over sand. That was truer to what is being thrown up, and it
 * looked wrong - bright coloured specks read as confetti rather than as a cloud
 * coming off the ground. Grey does the job, and grey is what dust looks like
 * once it is in the air anyway.
 */
const QUAKE_DARKEST = 0.16;
const QUAKE_LIGHTEST = 0.46;

/**
 * Earthquake (master): the ground heaves outward from the wizard in a ring that
 * widens until it runs out, throwing up whatever it passes under.
 *
 * Nothing is dug: the ground is not touched, only shaken. A master spell that
 * rearranged the terrain around the caster would be unusable anywhere near
 * anything built.
 */
function castEarthquake(player, props, modifiers) {
    const dimension = player.dimension;
    const origin = groundBelow(dimension, player.location);
    const radius = (props.effect_radius ?? 8) * modifiers.blast;
    const speed = props.spread_speed ?? 0.4;
    const damage = props.damage ?? 12;
    const lift = props.knockback_strength ?? 0.85;
    const ownerId = player.id;

    // Each victim is caught once, as the front reaches it. Without this the
    // ring would wound everything inside it again on every tick it grew.
    const caught = new Set();
    let front = 0.5;

    try {
        dimension.playSound("mob.ravager.roar", origin, { volume: 1.4, pitch: 0.45 });
        dimension.playSound("random.explode", origin, { volume: 1.0, pitch: 0.4 });
    } catch { }

    shakeGroundAt(dimension, origin, Math.ceil(radius) + 2);

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;
        front += speed;
        if (front > radius) {
            system.clearRun(id);
            return;
        }

        drawQuakeRing(dimension, origin, front);

        // Kept up while the ring runs rather than shaken once at the start, so
        // the ground goes on moving for as long as the wave does. It reaches
        // the wizard too - they are standing on it - but the wounding below
        // passes them over.
        //
        // The selector carries the centre with it. A plain r= measures from
        // wherever the command is run from, and a command run on the dimension
        // has no position at all - it was shaking anyone standing near the
        // world origin instead of anyone standing near the earthquake.
        if (ticks % QUAKE_SHAKE_PERIOD === 1) {
            shakeGroundAt(dimension, origin, Math.ceil(radius) + 2);
        }

        for (const v of nearbyHammerTargets(dimension, origin, front, player)) {
            if (v.id === ownerId || isPet(v) || caught.has(v.id)) continue;
            caught.add(v.id);
            try {
                v.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
                const dx = v.location.x - origin.x;
                const dz = v.location.z - origin.z;
                const away = Math.hypot(dx, dz) || 1;
                knockback(v, dx / away, dz / away, 0.5, lift);
            } catch { }
        }
    }, 1);

    return true;
}

/**
 * Shakes the screen of everyone standing within reach of a point.
 *
 * The centre goes into the selector as coordinates rather than being left to a
 * bare r=, because a command run on the dimension carries no position for r= to
 * measure from. Rounded, since the selector will not take long decimals.
 */
function shakeGroundAt(dimension, at, reach) {
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    const z = Math.round(at.z);
    try {
        dimension.runCommand(`camerashake add @a[x=${x},y=${y},z=${z},r=${reach}] 0.3 0.8 positional`);
    } catch { }
}

/**
 * The crest of the wave: grit thrown up off the ground and dropping back.
 *
 * Each point gets its own shade between soot and ash, so the ring is not one
 * flat grey but a scatter of darks - which is what a cloud of dust looks like
 * from outside it. The particle sheet is plain white and the colour is set
 * here, so the shade costs nothing but a number.
 */
function drawQuakeRing(dimension, origin, radius) {
    const points = Math.max(6, Math.round(radius * QUAKE_DETAIL));
    for (let i = 0; i < points; i++) {
        const a = (Math.PI * 2 * i) / points + radius * 0.3;
        const x = origin.x + Math.cos(a) * radius;
        const z = origin.z + Math.sin(a) * radius;

        const shade = QUAKE_DARKEST + Math.random() * (QUAKE_LIGHTEST - QUAKE_DARKEST);
        try {
            const dust = new MolangVariableMap();
            dust.setFloat("scale", 1.5);
            // a touch warmer than neutral, the way soot is
            dust.setFloat("r", shade * 1.05);
            dust.setFloat("g", shade);
            dust.setFloat("b", shade * 0.94);
            dimension.spawnParticle("ws:quake_dust", { x, y: origin.y + 0.15, z }, dust);
        } catch { }
    }
}

// ------------------------------------------------------------------ Plague of Darkness

/** How many ticks the shell takes to open out to its full width */
const PLAGUE_BLOOM = 10;

/**
 * Plague of Darkness (master): a shell of rot bursts out of the wizard, withering
 * and blinding everything living it washes over.
 *
 * The undead are passed over. They are already what this does to people, and a
 * necromancer's own risen are the last thing it should be turning on.
 */
function castPlagueOfDarkness(player, props, modifiers) {
    const dimension = player.dimension;
    const centre = { x: player.location.x, y: player.location.y + 1, z: player.location.z };
    const radius = (props.effect_radius ?? 5) * modifiers.blast;
    const ticks = Math.round((props.effect_duration ?? 140) * modifiers.duration);
    const ownerId = player.id;

    try {
        dimension.playSound("mob.wither.spawn", centre, { volume: 1.2, pitch: 1.4 });
    } catch { }

    const struck = [];
    for (const v of nearbyHammerTargets(dimension, centre, radius, player)) {
        if (v.id === ownerId || isPet(v)) continue;
        if (UNDEAD_FAMILY.some((f) => v.typeId.includes(f))) continue;
        try {
            v.applyDamage(props.damage ?? 8, { cause: "entity_attack", damagingEntity: player });
            v.addEffect("wither", ticks, { amplifier: props.effect_strength ?? 2, showParticles: true });
            v.addEffect("blindness", ticks, { amplifier: 0, showParticles: true });
            struck.push(v);
        } catch { }
    }

    bloomPlague(dimension, player, radius);
    clingPlague(dimension, struck);
    return true;
}

/** Which rune face the circle wears: the pentagram cut for necromancy */
const PLAGUE_RUNE = 5;

/** How long the circle stays lit under the wizard, in ticks */
const PLAGUE_RUNE_LIFE = 50;

/**
 * What the spell looks like: a necromancer's circle opening under the wizard.
 *
 * This was a sphere of particles before, two shells of them, and what it
 * actually read as on screen was fog - the spell disappeared inside its own
 * effect. A circle says the same thing in one shape: where the caster stood,
 * how far it reached, and whose magic it was.
 *
 * It is the ground rune the sigil spells already use, wearing a sixth face.
 * Nothing new had to be built for it beyond the drawing.
 */
function bloomPlague(dimension, player, radius) {
    const foot = groundBelow(dimension, player.location);
    const circle = spawnRune(dimension, foot, PLAGUE_RUNE, radius * 2, -25);
    if (!circle) return;

    // A handful of motes lifting off the ring as it opens, no more. The circle
    // carries the spell; these only stop it looking painted on.
    let t = 0;
    const id = system.runInterval(() => {
        t++;
        const a = t * 0.9;
        try {
            const rot = new MolangVariableMap();
            rot.setFloat("scale", 1.4);
            // Near black with only a hint of violet. The circle on the ground
            // carries the colour of the school; what comes off it is smoke, and
            // bright purple specks read as confetti rather than as rot.
            rot.setFloat("r", 0.15);
            rot.setFloat("g", 0.12);
            rot.setFloat("b", 0.18);
            dimension.spawnParticle("ws:plague", {
                x: foot.x + Math.cos(a) * radius,
                y: foot.y + 0.3,
                z: foot.z + Math.sin(a) * radius
            }, rot);
        } catch { }
        if (t >= PLAGUE_BLOOM) system.clearRun(id);
    }, 2);

    system.runTimeout(() => fadeRune(circle), PLAGUE_RUNE_LIFE);
}

/** How long the rot goes on smoking off whoever caught it, in ticks */
const PLAGUE_CLING = 60;

/**
 * The rot staying on its victims after the shell has passed: a few motes
 * bleeding off each of them, so it is clear at a glance who was caught and who
 * was missed.
 */
function clingPlague(dimension, struck) {
    if (struck.length === 0) return;
    let t = 0;
    const id = system.runInterval(() => {
        t += 4;
        if (t > PLAGUE_CLING) {
            system.clearRun(id);
            return;
        }
        for (const v of struck) {
            try {
                if (!v.isValid()) continue;
                const rot = new MolangVariableMap();
                rot.setFloat("scale", 0.5);
                rot.setFloat("r", 0.11);
                rot.setFloat("g", 0.09);
                rot.setFloat("b", 0.14);
                dimension.spawnParticle("ws:plague", {
                    x: v.location.x,
                    y: v.location.y + 1.0,
                    z: v.location.z
                }, rot);
            } catch { }
        }
    }, 6);
}

// ------------------------------------------------------------------ Summoning

/** How many places round the wizard are tried before a summon gives up */
const SUMMON_TRIES = 12;

/** How far above and below the wizard a summon will look for footing */
const SUMMON_REACH = 3;

/** How often a wraith looses a bolt, in ticks */
const WRAITH_PERIOD = 35;

/** How far it will reach for something to loose one at */
const WRAITH_RANGE = 16;

/** What the bolt does when it lands */
const WRAITH_DAMAGE = 5;

/** How far the bolt moves each tick, in blocks */
const WRAITH_BOLT_SPEED = 1.1;

/** How long a bolt may chase before it burns out, in ticks */
const WRAITH_BOLT_LIFE = 45;

/**
 * The three summoning spells, which differ only in what they call up.
 *
 * Summon Zombie, Summon Skeleton and Summon Lightning Wraith all place a minion
 * or two beside the wizard, bound for as long as the spell holds them. They go
 * for hostiles and never for a player, and the spells spare them: every minion
 * is marked as tamed, which is what isPet already looks for, so a wizard's own
 * risen do not get caught in their own black hole or tornado.
 *
 * Failing to find any footing fails the spell rather than dropping something
 * inside a wall, so the caster keeps their mana.
 */
function castSummon(player, minionId, props, modifiers) {
    const dimension = player.dimension;
    const count = Math.max(1, Math.round((props.minion_count ?? 1) * modifiers.blast));
    const spread = props.summon_radius ?? 2;
    const lifetime = Math.round((props.minion_lifetime ?? 600) * modifiers.duration);

    const raised = [];
    for (let i = 0; i < count; i++) {
        const spot = summonFooting(dimension, player.location, spread, i);
        if (spot === null) continue;
        try {
            const minion = dimension.spawnEntity(minionId, spot);
            raised.push(minion);
            markSummon(dimension, spot);
            if (minionId === "ws:lightning_wraith") {
                armWraith(dimension, minion, player, lifetime);
            }
        } catch (err) {
            console.warn("[castSummon Error]: " + err);
        }
    }

    if (raised.length === 0) {
        try {
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_block" });
            player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        } catch { }
        return false;
    }

    try {
        dimension.playSound("mob.wither.spawn", player.location, { volume: 0.6, pitch: 1.6 });
    } catch { }

    // The entity carries a timer of its own as a backstop, but the spell's own
    // hold is shorter and is what should decide - a wand with duration on it
    // has to be able to lengthen it.
    system.runTimeout(() => dismissSummons(dimension, raised), lifetime);
    return true;
}

/**
 * Somewhere solid to stand, near the wizard but not on top of them.
 *
 * Places are tried round a circle rather than at random, so two minions from
 * one cast do not land in each other. Returns null when everywhere in reach is
 * wall or a drop.
 */
function summonFooting(dimension, around, spread, index) {
    for (let attempt = 0; attempt < SUMMON_TRIES; attempt++) {
        const angle = ((index * 2 + attempt) * Math.PI * 2) / SUMMON_TRIES;
        const out = spread * (0.6 + 0.4 * (attempt / SUMMON_TRIES));
        const x = around.x + Math.cos(angle) * out;
        const z = around.z + Math.sin(angle) * out;

        const solid = firstSolidBetween(dimension, x, around.y + SUMMON_REACH, around.y - SUMMON_REACH, z);
        if (solid === null) continue;
        const y = hammerRestY(dimension, x, solid, z);

        // and room to stand up in
        if (isSolidBlockAt(dimension, x, y, z) || isSolidBlockAt(dimension, x, y + 1, z)) continue;
        return { x, y, z };
    }
    return null;
}

/** The ground opening where one comes up */
function markSummon(dimension, at) {
    try {
        const rot = new MolangVariableMap();
        rot.setFloat("scale", 1.6);
        rot.setFloat("r", 0.15);
        rot.setFloat("g", 0.12);
        rot.setFloat("b", 0.18);
        dimension.spawnParticle("ws:plague", { x: at.x, y: at.y + 0.6, z: at.z }, rot);
    } catch { }
}

/**
 * The wraith's ranged attack: a bolt of lightning that chases what it was sent
 * after rather than flying where it was pointed.
 *
 * A wraith is a thing of storm rather than of fists, so it fights at a distance
 * and its lightning does not miss. The behaviour file still gives it a melee
 * swing for anything that closes on it; this is what it does the rest of the
 * time.
 *
 * The bolt is not an entity. It is a point walked towards its mark a step at a
 * time, re-aimed every tick, leaving sparks where it has been - which is all a
 * bolt of lightning needs to be, and nothing to leave behind if the chunk goes
 * quiet mid flight.
 */
function armWraith(dimension, wraith, owner, lifetime) {
    let waited = 0;

    const id = system.runInterval(() => {
        waited += WRAITH_PERIOD;

        let gone = false;
        try { gone = !wraith.isValid(); } catch { gone = true; }
        if (gone || waited > lifetime) {
            system.clearRun(id);
            return;
        }

        const mark = nearestMonsterTo(dimension, wraith, WRAITH_RANGE);
        if (mark) looseBolt(dimension, wraith, mark, owner);
    }, WRAITH_PERIOD);
}

/** The closest hostile to a minion, or null if it has nothing to shoot at */
function nearestMonsterTo(dimension, from, reach) {
    try {
        const near = dimension.getEntities({
            location: from.location,
            maxDistance: reach,
            families: ["monster"]
        });
        let best = null;
        let bestGap = Infinity;
        for (const v of near) {
            if (v.id === from.id) continue;
            const gap = Math.hypot(
                v.location.x - from.location.x,
                v.location.y - from.location.y,
                v.location.z - from.location.z
            );
            if (gap < bestGap) { bestGap = gap; best = v; }
        }
        return best;
    } catch {
        return null;
    }
}

/** One bolt, from the wraith to its mark, correcting its aim as it goes */
function looseBolt(dimension, wraith, mark, owner) {
    let at;
    try {
        at = { x: wraith.location.x, y: wraith.location.y + 1.0, z: wraith.location.z };
    } catch {
        return;
    }

    try {
        dimension.playSound("ambient.weather.lightning.impact", at, { volume: 0.5, pitch: 1.8 });
    } catch { }

    let steps = 0;
    const id = system.runInterval(() => {
        steps++;

        let lost = false;
        try { lost = !mark.isValid(); } catch { lost = true; }
        if (lost || steps > WRAITH_BOLT_LIFE) {
            system.clearRun(id);
            return;
        }

        // re-aimed every tick, which is what makes it track rather than lead
        const to = mark.location;
        const dx = to.x - at.x;
        const dy = to.y + 0.9 - at.y;
        const dz = to.z - at.z;
        const gap = Math.hypot(dx, dy, dz) || 0.001;

        if (gap <= WRAITH_BOLT_SPEED) {
            system.clearRun(id);
            try {
                const hurtBy = owner && owner.isValid() ? owner : wraith;
                mark.applyDamage(WRAITH_DAMAGE, { cause: "lightning", damagingEntity: hurtBy });
            } catch { }
            try {
                dimension.spawnParticle("ws:lightning_pulse", { x: to.x, y: to.y + 0.9, z: to.z });
                dimension.playSound("ambient.weather.lightning.impact", to, { volume: 0.8, pitch: 1.5 });
            } catch { }
            return;
        }

        at = {
            x: at.x + (dx / gap) * WRAITH_BOLT_SPEED,
            y: at.y + (dy / gap) * WRAITH_BOLT_SPEED,
            z: at.z + (dz / gap) * WRAITH_BOLT_SPEED
        };
        try { dimension.spawnParticle("ws:lightning_sparkle", at); } catch { }
    }, 1);
}

/** Letting them go again when the spell's hold runs out */
function dismissSummons(dimension, raised) {
    for (const minion of raised) {
        try {
            if (!minion.isValid()) continue;
            markSummon(dimension, minion.location);
            minion.remove();
        } catch { }
    }
}

// ------------------------------------------------------------------ Conjure Sword

/** What the conjured blade is, so the spell and the unmaking agree on it */
const CONJURED_BLADE = "ws:spectral_sword";

/**
 * Where the world keeps its account of blades still owed an ending.
 *
 * The hour was written on the item itself at first, and it did not work: the
 * blade goes into the pack through addItem, which does not carry a dynamic
 * property across the way setItem does, so every sweep found an unstamped blade,
 * stamped it afresh, and the sword lived for ever. A world property is the
 * mechanism the rest of this pack already trusts to survive a reload, so the
 * account is kept there instead, and the blades themselves stay plain items.
 */
const BLADE_LEDGER = "ws_blades";

/** How often the account is looked over, in ticks */
const BLADE_SWEEP = 40;

/** How far around a player dropped blades are looked for */
const BLADE_SWEEP_REACH = 48;

/** Past this many outstanding blades the oldest are forgotten, so the account cannot grow without end */
const BLADE_LEDGER_CAP = 200;

/** Said once if the account cannot be read or written, so a silent failure cannot hide again */
let bladeLedgerWarned = false;

function readBladeLedger() {
    try {
        const raw = world.getDynamicProperty(BLADE_LEDGER);
        if (typeof raw !== "string") return [];
        const rows = JSON.parse(raw);
        return Array.isArray(rows) ? rows : [];
    } catch (err) {
        if (!bladeLedgerWarned) {
            bladeLedgerWarned = true;
            console.warn("[Conjure Sword] could not read the blade ledger: " + err);
        }
        return [];
    }
}

function writeBladeLedger(rows) {
    try {
        const kept = rows.length > BLADE_LEDGER_CAP ? rows.slice(rows.length - BLADE_LEDGER_CAP) : rows;
        world.setDynamicProperty(BLADE_LEDGER, JSON.stringify(kept));
    } catch (err) {
        if (!bladeLedgerWarned) {
            bladeLedgerWarned = true;
            console.warn("[Conjure Sword] could not write the blade ledger: " + err);
        }
    }
}

/**
 * A count of ticks that survives the world being closed and opened.
 *
 * system.currentTick starts again from nothing every time the world loads, so a
 * blade stamped with one would outlive its hour by however long the world was
 * shut. The absolute time does not restart; if it is ever unavailable the tick
 * counter is still better than nothing.
 */
function worldTick() {
    try {
        return world.getAbsoluteTime();
    } catch {
        return system.currentTick;
    }
}

/**
 * Conjure Sword (apprentice): a blade of solid magic, lent for a while.
 *
 * It is a real item in a real slot, so it swings, blocks and sits in the hotbar
 * like any sword. What makes it conjured is that the spell remembers to take it
 * back.
 */
function castConjureSword(player, props, modifiers) {
    const lifetime = Math.round((props.item_lifetime ?? 1200) * modifiers.duration);

    let pack;
    try {
        pack = player.getComponent("inventory")?.container;
    } catch { }
    if (!pack) return false;

    try {
        const spare = pack.addItem(new ItemStack(CONJURED_BLADE, 1));
        if (spare) {
            // nowhere to put it: dropping a conjured blade on the floor would
            // leave it lying there after the spell has forgotten it
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_block" });
            player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
            return false;
        }
    } catch (err) {
        console.warn("[castConjureSword Error]: " + err);
        return false;
    }

    try {
        player.playSound("random.anvil_use", { pitch: 1.8, volume: 0.6 });
        for (let i = 0; i < 12; i++) {
            const a = (Math.PI * 2 * i) / 12;
            player.dimension.spawnParticle("minecraft:witch_spell_particle", {
                x: player.location.x + Math.cos(a) * 0.8,
                y: player.location.y + 1.0,
                z: player.location.z + Math.sin(a) * 0.8
            });
        }
    } catch { }

    // The blade itself is a plain sword. What makes it conjured is this line in
    // the world's account, which outlives the session, the player and the sword
    const ledger = readBladeLedger();
    ledger.push({ who: player.id, due: worldTick() + lifetime });
    writeBladeLedger(ledger);

    return true;
}

/**
 * Whether a blade's hour has come.
 *
 * The far future counts as the past. The world clock is what /time set moves,
 * and a jump backwards would leave a blade dated further ahead than any casting
 * could ever date it - which would make it permanent, the one failure worth
 * guarding against. No modifier stretches the lifetime anywhere near fourfold,
 * so nothing honest is caught by this.
 */
function bladeIsDone(due, now, fresh) {
    if (typeof due !== "number") return false;
    return now >= due || due - now > fresh * 4;
}

/**
 * Takes one blade off a player, from the pack or from the ground at their feet.
 * Blades are identical, so which one goes does not matter - only how many.
 */
function takeOneBlade(player) {
    let pack;
    try {
        pack = player.getComponent("inventory")?.container;
    } catch { return false; }

    if (pack) {
        for (let slot = 0; slot < pack.size; slot++) {
            try {
                const held = pack.getItem(slot);
                if (!held || held.typeId !== CONJURED_BLADE) continue;
                pack.setItem(slot, undefined);
                unmakeBlade(player.dimension, { x: player.location.x, y: player.location.y + 1.2, z: player.location.z });
                try { player.onScreenDisplay.setActionBar(txt("ws.msg.blade_faded")); } catch { }
                return true;
            } catch { }
        }
    }

    // Dropped, or spilled on death, and still owed an ending
    try {
        const dropped = player.dimension.getEntities({
            type: "minecraft:item",
            location: player.location,
            maxDistance: BLADE_SWEEP_REACH
        });
        for (const drop of dropped) {
            try {
                const inside = drop.getComponent("minecraft:item")?.itemStack;
                if (!inside || inside.typeId !== CONJURED_BLADE) continue;
                const where = drop.location;
                drop.remove();
                unmakeBlade(player.dimension, where);
                return true;
            } catch { }
        }
    } catch { }

    return false;
}

/**
 * The blade coming apart, wherever it happens to be.
 */
function unmakeBlade(dimension, where) {
    try {
        dimension.playSound("random.glass", where, { pitch: 1.6, volume: 0.5 });
        for (let i = 0; i < 6; i++) {
            dimension.spawnParticle("minecraft:witch_spell_particle", {
                x: where.x + (Math.random() - 0.5) * 0.6,
                y: where.y + Math.random() * 0.6,
                z: where.z + (Math.random() - 0.5) * 0.6
            });
        }
    } catch { }
}

/** How many blades a player is carrying */
function countBlades(player) {
    let pack;
    try {
        pack = player.getComponent("inventory")?.container;
    } catch { return 0; }
    if (!pack) return 0;

    let found = 0;
    for (let slot = 0; slot < pack.size; slot++) {
        try {
            const held = pack.getItem(slot);
            if (held && held.typeId === CONJURED_BLADE) found++;
        } catch { }
    }
    return found;
}

/**
 * The account is settled: every line whose hour has come costs a blade, and
 * every blade without a line gets one.
 *
 * A timer set at the casting would do for the ordinary case, but not for the
 * ones that matter: it dies when the world is closed, and it only ever looks in
 * the caster's own inventory, so a blade dropped, stored, handed over or left
 * behind on death would outlive the spell for good. Counting instead of marking
 * works because blades are identical - what matters is how many are owed an
 * ending, never which one.
 */
function sweepBlades() {
    const ledger = readBladeLedger();
    const now = worldTick();
    const fresh = getSpellProps("ws:conjure_sword").item_lifetime ?? 1200;

    const players = world.getAllPlayers();
    const owed = [];

    for (const row of ledger) {
        if (!bladeIsDone(row?.due, now, fresh)) {
            owed.push(row);
            continue;
        }

        const owner = players.find((p) => p.id === row.who);
        if (!owner) {
            // Away from the world. The account waits for them: the blade cannot
            // be doing any harm while its owner is not here to swing it
            owed.push(row);
            continue;
        }

        // Their own first, then anyone else's, for a blade that changed hands
        if (!takeOneBlade(owner)) {
            for (const other of players) {
                if (other.id === row.who) continue;
                if (takeOneBlade(other)) break;
            }
        }

        // The line is struck either way. A blade that could not be found is one
        // locked in a chest or left in an unloaded chunk, and trying again every
        // two seconds for ever would only fill the account up
    }

    // Any blade nobody is accounting for is adopted and given an hour of its
    // own: one conjured before this mechanism existed, one from creative or a
    // command, one the account lost track of. This is what makes a permanent
    // blade impossible rather than merely unlikely, which is the whole point
    let changes = ledger.length - owed.length;
    for (const player of players) {
        const carrying = countBlades(player);
        if (!carrying) continue;
        let accounted = 0;
        for (const row of owed) if (row?.who === player.id) accounted++;
        for (let i = accounted; i < carrying; i++) {
            owed.push({ who: player.id, due: now + fresh });
            changes++;
        }
    }

    if (changes) writeBladeLedger(owed);
}

system.runInterval(sweepBlades, BLADE_SWEEP);

// Said once at load. If a blade ever outlives its hour again, this line in the
// content log is what says whether the sweep was running at all
console.warn("[Conjure Sword] sweep every " + BLADE_SWEEP + " ticks; " + readBladeLedger().length + " blade(s) outstanding");

// ------------------------------------------------------------------ Ice Age

/** Which rune face the frost circle wears */
const ICE_AGE_RUNE = 1;

/** How many ticks the cold takes to reach its full width */
const ICE_AGE_SPREAD = 20;

/**
 * Ice Age (master): winter falls on everything around the wizard.
 *
 * The cold goes out in a ring, wounding and slowing as it passes, and freezes
 * over any water it crosses. Only water is touched, and only with frosted ice,
 * which thaws by itself - the same restraint Frost Step uses. A master spell
 * that left permanent ice over a lake would be unusable near anything built.
 */
function castIceAge(player, props, modifiers) {
    const dimension = player.dimension;
    const radius = (props.effect_radius ?? 7) * modifiers.blast;
    const damage = props.damage ?? 14;
    const chill = Math.round((props.effect_duration ?? 400) * modifiers.duration);
    const linger = Math.round((props.freeze_duration ?? 1200) * modifiers.duration);
    const ownerId = player.id;

    const foot = groundBelow(dimension, player.location);
    const circle = spawnRune(dimension, foot, ICE_AGE_RUNE, radius * 2, -20);

    try {
        dimension.playSound("mob.wither.spawn", foot, { volume: 1.0, pitch: 2.0 });
        dimension.playSound("random.glass", foot, { volume: 1.2, pitch: 0.6 });
    } catch { }

    const bitten = new Set();
    let step = 0;

    const id = system.runInterval(() => {
        step++;
        const front = radius * (step / ICE_AGE_SPREAD);

        drawFrostRing(dimension, foot, front);
        freezeRing(dimension, foot, front);

        for (const v of nearbyHammerTargets(dimension, foot, front, player)) {
            if (v.id === ownerId || isPet(v) || bitten.has(v.id)) continue;
            bitten.add(v.id);
            try {
                v.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
                v.addEffect("slowness", chill, { amplifier: props.effect_strength ?? 1, showParticles: true });
            } catch { }
        }

        if (step >= ICE_AGE_SPREAD) system.clearRun(id);
    }, 1);

    system.runTimeout(() => fadeRune(circle), linger);
    return true;
}

/** The cold made visible, as frost thrown up along the edge of the ring */
function drawFrostRing(dimension, foot, radius) {
    const marks = Math.max(8, Math.round(radius * 2));
    for (let i = 0; i < marks; i++) {
        const a = (Math.PI * 2 * i) / marks + radius * 0.2;
        try {
            const frost = new MolangVariableMap();
            frost.setFloat("scale", 1.3);
            dimension.spawnParticle("ws:frost_step", {
                x: foot.x + Math.cos(a) * radius,
                y: foot.y + 0.25,
                z: foot.z + Math.sin(a) * radius
            }, frost);
        } catch { }
    }
}

/**
 * Any still water on the ring turns to frosted ice, which melts on its own.
 * Flowing water is left alone - freezing a waterfall mid fall dams things that
 * were never meant to be dammed.
 */
function freezeRing(dimension, foot, radius) {
    const marks = Math.max(8, Math.round(radius * 4));
    for (let i = 0; i < marks; i++) {
        const a = (Math.PI * 2 * i) / marks;
        const x = Math.floor(foot.x + Math.cos(a) * radius);
        const z = Math.floor(foot.z + Math.sin(a) * radius);
        for (let dy = 0; dy >= -2; dy--) {
            try {
                const block = dimension.getBlock({ x, y: Math.floor(foot.y) + dy, z });
                if (!block || block.typeId !== "minecraft:water") continue;
                const level = block.permutation?.getState("liquid_depth");
                if (level !== undefined && level !== 0) continue;
                block.setType("minecraft:frosted_ice");
                break;
            } catch { }
        }
    }
}

// ------------------------------------------------------------------ Resurrection

/** Which rune face the ritual circle wears */
const RESURRECTION_RUNE = 4;

/** Everything the rite washes away */
const RESURRECTION_CURES = [
    "poison", "wither", "slowness", "weakness", "blindness", "nausea",
    "hunger", "mining_fatigue", "fatal_poison", "darkness", "levitation"
];

/**
 * Resurrection (master): a rite that takes ten seconds to work and then puts
 * everyone inside the circle back the way they were.
 *
 * It is not instant on purpose. It costs a hundred and fifty mana and mends
 * everything at once, so it has to be started before it is needed rather than
 * thrown at the moment of dying. The circle is visible the whole time, to
 * everyone - including whatever is attacking.
 *
 * Living things are mended. The undead are unmade by it, which is the same
 * thing from the other side.
 */
function castResurrection(player, props, modifiers) {
    const dimension = player.dimension;
    const radius = (props.effect_radius ?? 8) * modifiers.blast;
    const wait = Math.round((props.wait_time ?? 200) * modifiers.duration);
    const ownerId = player.id;

    const foot = groundBelow(dimension, player.location);
    const circle = spawnRune(dimension, foot, RESURRECTION_RUNE, radius * 2, 18);

    try {
        dimension.playSound("beacon.activate", foot, { volume: 1.2, pitch: 0.8 });
    } catch { }

    // the rite gathering, a ring of light climbing as it fills
    let step = 0;
    const id = system.runInterval(() => {
        step += 4;
        if (step >= wait) {
            system.clearRun(id);
            completeResurrection(dimension, player, ownerId, foot, radius, props, modifiers);
            fadeRune(circle);
            return;
        }
        const climb = (step / wait) * 2.5;
        for (let i = 0; i < 10; i++) {
            const a = (Math.PI * 2 * i) / 10 + step * 0.12;
            try {
                dimension.spawnParticle("minecraft:end_rod", {
                    x: foot.x + Math.cos(a) * radius * 0.9,
                    y: foot.y + climb,
                    z: foot.z + Math.sin(a) * radius * 0.9
                });
            } catch { }
        }
    }, 4);

    return true;
}

/** The moment it lands */
function completeResurrection(dimension, player, ownerId, foot, radius, props, modifiers) {
    try {
        dimension.playSound("beacon.power", foot, { volume: 1.4, pitch: 1.2 });
        dimension.playSound("random.levelup", foot, { volume: 1.0, pitch: 0.8 });
    } catch { }

    const mend = Math.round((props.duration ?? 300) * modifiers.duration);
    let healed = 0;

    let gathered = [];
    try {
        gathered = dimension.getEntities({ location: foot, maxDistance: radius });
    } catch { }

    for (const v of gathered) {
        try {
            const undead = UNDEAD_FAMILY.some((f) => v.typeId.includes(f));
            if (undead && !isPet(v)) {
                v.applyDamage(props.damage ?? 20, { cause: "entity_attack", damagingEntity: player });
                continue;
            }

            const mortal = v.typeId === "minecraft:player" || v.id === ownerId || isPet(v);
            if (!mortal) continue;

            const life = v.getComponent("minecraft:health");
            if (life) life.resetToMaxValue();
            for (const ill of RESURRECTION_CURES) {
                try { v.removeEffect(ill); } catch { }
            }
            v.addEffect("regeneration", mend, { amplifier: 1, showParticles: true });
            v.addEffect("absorption", mend, { amplifier: 1, showParticles: true });
            v.addEffect("saturation", 2, { amplifier: 4, showParticles: false });
            healed++;
            dimension.spawnParticle("minecraft:totem_particle", {
                x: v.location.x, y: v.location.y + 1, z: v.location.z
            });
        } catch { }
    }

    try {
        for (let i = 0; i < 40; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * radius;
            dimension.spawnParticle("minecraft:end_rod", {
                x: foot.x + Math.cos(a) * r,
                y: foot.y + Math.random() * 3,
                z: foot.z + Math.sin(a) * r
            });
        }
    } catch { }

    if (healed > 0) {
        try { player.onScreenDisplay.setActionBar(txt("ws.msg.rite_complete", healed)); } catch { }
    }
}

// ------------------------------------------------------------------ Single target spells

/**
 * Base for spells that aim at a creature: finds the target, applies the effect and sparks on it.
 * Fails, spending no mana or scroll, when nothing is in range.
 */
function castAimedEffect(player, maxRange, apply, particle = null) {
    const target = findAimTarget(player, maxRange);
    if (!target.entity || !isValidCombatTarget(target.entity, player)) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_creature" });
        return false;
    }

    try { apply(target.entity); } catch { }

    if (particle) {
        try {
            const center = getEntityCenter(target.entity);
            for (let i = 0; i < 5; i++) {
                player.dimension.spawnParticle(particle, {
                    x: center.x + (Math.random() - 0.5) * 0.8,
                    y: center.y + (Math.random() - 0.5) * 0.8,
                    z: center.z + (Math.random() - 0.5) * 0.8
                });
            }
        } catch { }
    }
    return true;
}

/**
 * One block offset in the direction of the face the ray hit
 */
const FACE_OFFSET = {
    Up: { x: 0, y: 1, z: 0 },
    Down: { x: 0, y: -1, z: 0 },
    North: { x: 0, y: 0, z: -1 },
    South: { x: 0, y: 0, z: 1 },
    West: { x: -1, y: 0, z: 0 },
    East: { x: 1, y: 0, z: 0 }
};

/**
 * Ignite: sets fire to whatever is aimed at.
 *
 * On a creature it sets it alight; on a block it lights a flame on the hit face,
 * like using flint and steel at range.
 */
function castIgnite(player, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 10) * modifiers.range;
    const burning = props.burn_duration ?? 10;
    const target = findAimTarget(player, maxRange);

    if (target.entity && isValidCombatTarget(target.entity, player)) {
        try { target.entity.setOnFire(burning, true); } catch { }
        try {
            const center = getEntityCenter(target.entity);
            for (let i = 0; i < 6; i++) {
                dimension.spawnParticle("minecraft:basic_flame_particle", {
                    x: center.x + (Math.random() - 0.5) * 0.8,
                    y: center.y + (Math.random() - 0.5) * 0.8,
                    z: center.z + (Math.random() - 0.5) * 0.8
                });
            }
        } catch { }
        return true;
    }

    if (target.block) {
        const offset = FACE_OFFSET[target.face] ?? FACE_OFFSET.Up;
        const loc = {
            x: target.block.location.x + offset.x,
            y: target.block.location.y + offset.y,
            z: target.block.location.z + offset.z
        };
        try {
            const destination = dimension.getBlock(loc);
            if (!destination || !destination.isAir) {
                player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_room_flame" });
                player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
                return false;
            }
            destination.setType("minecraft:fire");
            dimension.spawnParticle("minecraft:basic_flame_particle", { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 });
            return true;
        } catch {
            return false;
        }
    }

    player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
    player.onScreenDisplay.setActionBar({ translate: "ws.msg.nothing_to_burn" });
    return false;
}

/**
 * Snare: sets a trap on the ground at the aimed point. It waits there until something
 * steps on it, then snaps shut, damaging and rooting the creature.
 */
function castSnare(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 10) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const point = target.location ?? spawnInFront(headLoc, viewDir, maxRange);

    const center = { x: point.x, y: point.y + 0.1, z: point.z };
    const duration = Math.round((props.duration ?? 600) * modifiers.duration);
    const radius = (props.effect_radius ?? 1.2) * modifiers.blast;
    const damage = props.damage ?? 6;
    const cage = Math.round((props.effect_duration ?? 100) * modifiers.duration);
    const strength = props.effect_strength ?? 2;

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;
        if (ticks > duration) {
            system.clearRun(id);
            return;
        }

            // Armed trap: a ring of growth on the ground
        if (ticks % 6 === 0) {
            try {
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI * 2 * i) / 6 + ticks * 0.05;
                    dimension.spawnParticle("minecraft:villager_happy", {
                        x: center.x + Math.cos(angle) * radius,
                        y: center.y,
                        z: center.z + Math.sin(angle) * radius
                    });
                }
            } catch { }
        }

        const victims = nearbyHammerTargets(dimension, center, radius, player);
        if (victims.length === 0) return;

        // Something stepped on it: the trap snaps shut and is spent
        system.clearRun(id);
        for (const victim of victims) {
            try {
                victim.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
                victim.addEffect("slowness", cage, { amplifier: strength, showParticles: true });
            } catch { }
        }
        try {
            dimension.playSound("spell.snare", center, { volume: 1.0 });
            for (let i = 0; i < 12; i++) {
                dimension.spawnParticle("minecraft:critical_hit_emitter", {
                    x: center.x + (Math.random() - 0.5) * radius * 2,
                    y: center.y + Math.random() * 0.8,
                    z: center.z + (Math.random() - 0.5) * radius * 2
                });
            }
        } catch { }
    }, 1);

    return true;
}

/**
 * Life Drain: takes health from the target and gives part of it back to the wizard
 */
function castLifeDrain(player, props, modifiers) {
    const damage = props.damage ?? 2;
    return castAimedEffect(player, (props.range ?? 10) * modifiers.range, (target) => {
        target.applyDamage(damage, { cause: "entity_attack", damagingEntity: player });
        const vitality = player.getComponent("minecraft:health");
        if (vitality) {
            const healing = damage * (props.heal_factor ?? 0.35);
            vitality.setCurrentValue(Math.min(vitality.effectiveMax, vitality.currentValue + healing));
        }
    }, "minecraft:heart_particle");
}

/**
 * Mind Trick: the creature loses track of the wizard and is left confused.
 *
 * The Bedrock script API cannot clear a mob's target, so what works is teleporting the
 * creature onto its own position, which resets the path it was following, and layering
 * weakness and slowness on top.
 */
function castMindTrick(player, props, modifiers) {
    const ticks = Math.round((props.effect_duration ?? 300) * modifiers.duration);
    return castAimedEffect(player, (props.range ?? 8) * modifiers.range, (target) => {
        try { target.teleport(target.location, { dimension: target.dimension, keepVelocity: false }); } catch { }
        target.addEffect("weakness", ticks, { amplifier: 1, showParticles: false });
        target.addEffect("slowness", Math.min(ticks, 60), { amplifier: 0, showParticles: false });
    }, "minecraft:witch_spell_particle");
}

// ------------------------------------------------------------------ Suporte

/**
 * Bad effects that Cure Effects clears
 */
const NEGATIVE_EFFECTS = [
    "poison", "fatal_poison", "wither", "slowness", "weakness", "mining_fatigue",
    "nausea", "blindness", "hunger", "levitation", "darkness", "bad_omen"
];

function castCureEffects(player) {
    let removed = 0;
    for (const effect of NEGATIVE_EFFECTS) {
        try {
            if (player.getEffect(effect)) {
                player.removeEffect(effect);
                removed++;
            }
        } catch { }
    }
    if (removed === 0) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_bad_effects" });
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        return false;
    }
    try {
        for (let i = 0; i < 8; i++) {
            player.dimension.spawnParticle("minecraft:villager_happy", {
                x: player.location.x + (Math.random() - 0.5),
                y: player.location.y + Math.random() * 1.8,
                z: player.location.z + (Math.random() - 0.5)
            });
        }
    } catch { }
    return true;
}

/**
 * Heal Ally: heals the creature in the crosshair instead of the wizard
 */
function castHealAlly(player, props, modifiers) {
    const healing = props.health ?? 5;
    const target = findAimTarget(player, (props.range ?? 10) * modifiers.range);
    if (!target.entity) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_ally" });
        return false;
    }
    const vitality = target.entity.getComponent("minecraft:health");
    if (!vitality) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.cannot_heal" });
        return false;
    }
    if (vitality.currentValue >= vitality.effectiveMax) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.target_full" });
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        return false;
    }
    vitality.setCurrentValue(Math.min(vitality.effectiveMax, vitality.currentValue + healing));
    try {
        const center = getEntityCenter(target.entity);
        for (let i = 0; i < 6; i++) {
            player.dimension.spawnParticle("minecraft:heart_particle", {
                x: center.x + (Math.random() - 0.5),
                y: center.y + (Math.random() - 0.5),
                z: center.z + (Math.random() - 0.5)
            });
        }
    } catch { }
    return true;
}

// Wizards with Ice Shroud up: id -> { until: last tick, slow: slowness applied to the attacker }
const activeIceShroud = new Map();

world.afterEvents.entityHurt.subscribe((ev) => {
    const data = activeIceShroud.get(ev.hurtEntity.id);
    if (!data) return;
    if (system.currentTick > data.until) {
        activeIceShroud.delete(ev.hurtEntity.id);
        return;
    }
    const attacker = ev.damageSource.damagingEntity;
    if (attacker && attacker.id !== ev.hurtEntity.id && attacker.isValid()) {
        try {
            attacker.addEffect("slowness", data.slow, { amplifier: data.strength, showParticles: true });
            frostSpark(attacker.dimension, attacker);
        } catch { }
    }
});

function frostSpark(dimension, entity) {
    try {
        const loc = entity.location;
        for (let i = 0; i < 6; i++) {
            dimension.spawnParticle("minecraft:snowflake_particle", {
                x: loc.x + (Math.random() - 0.5),
                y: loc.y + Math.random() * 1.6,
                z: loc.z + (Math.random() - 0.5)
            });
        }
    } catch { }
}

// ------------------------------------------------------------------ Lightning

/**
 * Lightning Pulse: a ring discharge around the wizard, hurting and pushing everything close
 */
function castLightningPulse(player, props, modifiers) {
    const dimension = player.dimension;
    const radius = (props.effect_radius ?? 3) * modifiers.blast;
    const damage = props.damage ?? 8;
    const shove = props.repulsion_velocity ?? 0.8;
    const origin = player.location;

    // Shockwave laid flat on the ground, sized to the area actually hit.
    // The radius travels as a Molang variable so the particle scales with the Blast upgrade.
    try {
        const vars = new MolangVariableMap();
        vars.setFloat("radius", radius);
        dimension.spawnParticle("ws:lightning_pulse_ground", { x: origin.x, y: origin.y + 0.05, z: origin.z }, vars);
        dimension.playSound("spell.lightning_pulse.spark", origin, { volume: 1.0 });
    } catch { }

    for (const target of nearbyHammerTargets(dimension, origin, radius, player)) {
        try {
            target.applyDamage(damage, { cause: "lightning", damagingEntity: player });
            sparkOnTarget(dimension, target);
            const dx = target.location.x - origin.x;
            const dz = target.location.z - origin.z;
            const len = Math.hypot(dx, dz) || 1;
            knockback(target, dx / len, dz / len, shove * 2, 0.4);
        } catch { }
    }
    return true;
}

/**
 * Chain Lightning: hits the aimed target, then jumps to its neighbours and from each
 * of those to a few more, losing power with every jump
 */
function castChainLightning(player, props, modifiers) {
    const dimension = player.dimension;
    const begin = getWandTipLocation(player);
    const target = findAimTarget(player, (props.range ?? 10) * modifiers.range);

    if (!target.entity || !isValidCombatTarget(target.entity, player)) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_creature" });
        return false;
    }

    const hitTargets = new Set([target.entity.id]);
    castLightningBeamBetween(dimension, begin, getEntityCenter(target.entity), target.entity, props.primary_damage ?? 10, player);

    // First jump: from the target to its neighbours
    const seconds = nearbyHammerTargets(dimension, target.entity.location, (props.secondary_range ?? 5) * modifiers.range, player)
        .filter((e) => !hitTargets.has(e.id))
        .slice(0, props.secondary_max_targets ?? 5);

    for (const second of seconds) {
        hitTargets.add(second.id);
        castLightningBeamBetween(dimension, getEntityCenter(target.entity), getEntityCenter(second), second, props.secondary_damage ?? 8, player, false);

        // Second jump: from each neighbour to its own
        const thirds = nearbyHammerTargets(dimension, second.location, (props.tertiary_range ?? 5) * modifiers.range, player)
            .filter((e) => !hitTargets.has(e.id))
            .slice(0, props.tertiary_max_targets ?? 2);

        for (const third of thirds) {
            hitTargets.add(third.id);
            castLightningBeamBetween(dimension, getEntityCenter(second), getEntityCenter(third), third, props.tertiary_damage ?? 6, player, false);
        }
    }
    return true;
}

/**
 * Charge: the wizard rushes forward wrapped in lightning, running down whatever is in
 * the way. Each creature is only damaged once per charge.
 */
function castCharge(player, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const speed = props.charge_speed ?? 2;
    const ticks = Math.round((props.duration ?? 10) * modifiers.duration);
    const damage = props.damage ?? 8;
    const shove = props.knockback_strength ?? 1;

    const horizontal = Math.hypot(viewDir.x, viewDir.z) || 1;
    const initialDir = { x: viewDir.x / horizontal, z: viewDir.z / horizontal };

    /**
 * Where the wizard is looking right now, flattened to the ground plane.
 * Reading it every tick is what allows turning mid-charge: locked to the launch
 * direction it would always go straight.
     */
    const currentDir = () => {
        try {
            const v = player.getViewDirection();
            const h = Math.hypot(v.x, v.z);
            if (h > 0.001) return { x: v.x / h, z: v.z / h };
        } catch { }
        return initialDir;
    };

    knockback(player, initialDir.x, initialDir.z, speed, Math.max(0.15, viewDir.y * 0.6));

    const hitTargets = new Set();
    let counter = 0;
    const id = system.runInterval(() => {
        counter++;
        if (!player.isValid() || counter > ticks) {
            system.clearRun(id);
            return;
        }

        const dir = currentDir();

        // The impulse is renewed through most of the charge: a single shove dies to
        // friction in a few ticks and would be a hop, not an advance
        if (counter <= ticks * 0.7) {
            knockback(player, dir.x, dir.z, speed * 0.6, 0.03);
        }

        const loc = player.location;
        try {
            dimension.spawnParticle("ws:lightning_spark", { x: loc.x, y: loc.y + 0.9, z: loc.z });
        } catch { }

        for (const target of nearbyHammerTargets(dimension, loc, 2, player)) {
            if (hitTargets.has(target.id)) continue;
            hitTargets.add(target.id);
            try {
                target.applyDamage(damage, { cause: "lightning", damagingEntity: player });
                sparkOnTarget(dimension, target);
                // Push along whatever direction the charge was heading on impact
                knockback(target, dir.x, dir.z, shove, 0.4);
            } catch { }
        }
    }, 1);

    return true;
}

// ------------------------------------------------------------------ Necromancia

/**
 * Decay: rots the ground at the aimed point. Anything stepping on the patches withers.
 */
function castDecay(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 12) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const center = target.location ?? spawnInFront(headLoc, viewDir, maxRange);
    const duration = Math.round((props.duration ?? 400) * modifiers.duration);
    const effect = Math.round((props.effect_duration ?? 400) * modifiers.duration);
    const amount = props.decay_patches_spawned ?? 5;

    // Spread the patches around the impact point
    const patches = [{ x: center.x, y: center.y, z: center.z }];
    for (let i = 1; i < amount; i++) {
        const angle = (Math.PI * 2 * i) / Math.max(1, amount - 1);
        patches.push({
            x: center.x + Math.cos(angle) * 1.8 * modifiers.blast,
            y: center.y,
            z: center.z + Math.sin(angle) * 1.8 * modifiers.blast
        });
    }

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;
        if (ticks > duration) {
            system.clearRun(id);
            return;
        }

        for (const patch of patches) {
            if (ticks % 4 === 0) {
                try {
                    dimension.spawnParticle("minecraft:witch_spell_particle", {
                        x: patch.x + (Math.random() - 0.5) * 1.4,
                        y: patch.y + 0.15,
                        z: patch.z + (Math.random() - 0.5) * 1.4
                    });
                } catch { }
            }

            if (ticks % 20 !== 0) continue;
            for (const victim of nearbyHammerTargets(dimension, patch, 1.5, player)) {
                try { victim.addEffect("wither", effect, { amplifier: 0, showParticles: true }); } catch { }
            }
        }
    }, 1);

    return true;
}

// ------------------------------------------------------------------ Terra e movimento

/**
 * Leap: an impulse up and forward
 */
function castLeap(player, viewDir, props) {
    const horizontal = Math.hypot(viewDir.x, viewDir.z) || 1;
    knockback(player, viewDir.x / horizontal, viewDir.z / horizontal, props.horizontal_speed ?? 0.3, props.vertical_speed ?? 0.65);
    try {
        player.dimension.spawnParticle("minecraft:villager_happy", player.location);
    } catch { }
    return true;
}

// ------------------------------------------------------------------ Vento

/**
 * Rajada: um golpe de ar em cone a frente do lancador.
 *
 * Faz pouco dano de proposito. O que ela vale e o empurrao - tira de cima quem
 * se encostou, ou atira de um penhasco quem nao devia la estar. Tudo pelo
 * dimension, sem nada que so um jogador tenha, para o Arcano do Vento tambem a
 * poder lancar.
 */
function castGust(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const alcance = (props.range ?? 10) * modifiers.range;
    const dano = props.damage ?? 3;
    const forca = props.knockback ?? 2.8;
    const subida = props.lift ?? 0.5;
    // o cosseno minimo para estar dentro do cone: 0.35 da cerca de 100 graus
    const cone = props.cone ?? 0.35;

    const plano = Math.hypot(viewDir.x, viewDir.z) || 1;
    const fx = viewDir.x / plano;
    const fz = viewDir.z / plano;

    for (let passo = 1; passo <= alcance; passo++) {
        const largura = 0.4 + passo * 0.14;
        for (let i = 0; i < 3; i++) {
            try {
                dimension.spawnParticle("minecraft:snowflake_particle", {
                    x: headLoc.x + fx * passo + (Math.random() - 0.5) * largura * 2,
                    y: headLoc.y + viewDir.y * passo * 0.6 + (Math.random() - 0.5) * largura,
                    z: headLoc.z + fz * passo + (Math.random() - 0.5) * largura * 2
                });
            } catch { }
        }
    }

    let apanhados = 0;
    for (const alvo of nearbyHammerTargets(dimension, player.location, alcance + 1, player)) {
        try {
            if (alvo.id === player.id || isPet(alvo)) continue;
            const dx = alvo.location.x - player.location.x;
            const dz = alvo.location.z - player.location.z;
            const dist = Math.hypot(dx, dz) || 0.001;
            if ((dx / dist) * fx + (dz / dist) * fz < cone) continue;

            knockback(alvo, dx / dist, dz / dist, forca, subida);
            alvo.applyDamage(dano, { cause: "entity_attack", damagingEntity: player });
            apanhados++;
        } catch { }
    }

    try { dimension.playSound("ws.entity.storm_elemental.wind", player.location, { volume: 1.0, pitch: 1.1 }); } catch { }
    return true;
}

/**
 * Passo do Vento: o lancador e atirado para onde esta a olhar, numa rajada.
 *
 * Nao atravessa paredes, ao contrario do Passo Espectral - e impulso, nao
 * teleporte, por isso uma parede pela frente simplesmente para o salto. Em
 * troca, empurra para o lado quem estiver no caminho.
 */
function castWindStep(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const impulso = (props.dash_speed ?? 1.35) * modifiers.range;
    const subida = props.lift ?? 0.35;
    const empurra = props.shove ?? 1.1;

    const plano = Math.hypot(viewDir.x, viewDir.z) || 1;
    const fx = viewDir.x / plano;
    const fz = viewDir.z / plano;

    try { knockback(player, fx, fz, impulso, subida); } catch { }

    // quem estiver no caminho sai dele
    for (const alvo of nearbyHammerTargets(dimension, player.location, 3, player)) {
        try {
            if (alvo.id === player.id || isPet(alvo)) continue;
            const dx = alvo.location.x - player.location.x;
            const dz = alvo.location.z - player.location.z;
            const dist = Math.hypot(dx, dz) || 0.001;
            knockback(alvo, dx / dist, dz / dist, empurra, 0.25);
        } catch { }
    }

    for (let i = 0; i < 20; i++) {
        try {
            dimension.spawnParticle("minecraft:snowflake_particle", {
                x: player.location.x - fx * (i * 0.25) + (Math.random() - 0.5) * 0.8,
                y: player.location.y + 0.4 + Math.random() * 1.2,
                z: player.location.z - fz * (i * 0.25) + (Math.random() - 0.5) * 0.8
            });
        } catch { }
    }

    try { dimension.playSound("ws.entity.storm_elemental.wind", player.location, { volume: 0.9, pitch: 1.45 }); } catch { }
    return true;
}

// ------------------------------------------------------------------ Grapple line

/** Wizards currently on a line: player id -> what it is holding */
const activeGrapples = new Map();

/** The drawn vine: a thin bamboo rod stretched between the wand and the anchor */
const GRAPPLE_VINE = "ws:grapple_vine";

/**
 * The speed profile of the haul, in blocks a tick, before reel_speed scales it.
 *
 * It used to be one flat number applied every tick, which meant the line went
 * from nothing to full speed in a single frame and from full speed to nothing
 * in another. Both ends of that read as a jolt. Winding up over half a second
 * and easing off as the anchor comes up is the whole difference between being
 * hauled and being teleported in steps.
 */
const GRAPPLE_TOP = 0.95;
const GRAPPLE_ACCEL = 0.09;

/**
 * What it starts at, rather than nothing.
 *
 * Winding up from a standstill made long hauls feel right and short ones worse
 * than they had been - over five or six blocks the ramp never finishes, so the
 * whole trip happened at a crawl. Starting part way up costs the long hauls
 * nothing and gives the short ones back.
 */
const GRAPPLE_START = 0.42;

/** How far out from the anchor it starts easing off, in blocks */
const GRAPPLE_BRAKE = 6;

/** It never eases below this share of the speed it had built up */
const GRAPPLE_BRAKE_FLOOR = 0.3;

/**
 * How much of the haul goes into climbing, per unit of slope.
 *
 * It used to be a flat amount added to every haul, and applyKnockback sets the
 * upward speed rather than adding to it - so a flat lift every tick beat
 * gravity outright and whatever was on the line simply rose, however level the
 * line was. Taken from the slope instead, a level haul lifts nothing.
 */
const GRAPPLE_RISE = 1.9;

/** The most and least the haul will ever lift, whatever the slope says */
const GRAPPLE_RISE_MAX = 0.6;
const GRAPPLE_RISE_MIN = -0.25;

/**
 * How close to the anchor counts as arrived, in blocks.
 * Tighter than it was, because the braking above now brings the wizard in
 * gently - before, stopping this far out was the only thing keeping them off
 * the wall.
 */
const GRAPPLE_ARRIVED = 1.6;

/** Longest a line may stay attached, in ticks, if the release is ever missed */
const GRAPPLE_MAX_HOLD = 300;

/**
 * Grapple, as the wand casts it: a vine that reaches out, bites, and holds
 * until the button is let go.
 *
 * It is not a single yank. The vine takes a moment to reach - extension_speed
 * blocks a tick - and once it has bitten it keeps hauling for as long as the
 * button is down, which is what makes it a grapple rather than a jump. What it
 * bit decides which end moves: a block and the wizard is pulled to it, a
 * creature and it is pulled to the wizard.
 *
 * A scroll cannot be held down, so the scroll version stays what it always was:
 * one pull, in castGrapple below.
 */
function startGrappleLine(player, modifiers, onManaCost) {
    releaseGrapple(player, true);

    const dimension = player.dimension;
    const props = getSpellProps("ws:grapple");
    const maxRange = (props.range ?? 20) * modifiers.range;
    const reach = props.extension_speed ?? 3.5;
    const reel = props.reel_speed ?? 1;

    // Where it is going is decided once, on the throw. Re-aiming every tick
    // would let the line wander off whatever it had already caught.
    const aim = findAimTarget(player, maxRange);
    if (!aim.location) {
        try {
            player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.nothing_to_hook" });
        } catch { }
        return;
    }

    const from = getWandTipLocation(player);
    const span = Math.hypot(
        aim.location.x - from.x,
        aim.location.y - from.y,
        aim.location.z - from.z
    ) || 1;

    const line = {
        runId: 0,
        ticks: 0,
        // Already a step out on the first tick. Starting at nothing meant the
        // first frame had no direction to be drawn along, so there was nothing
        // to orient the vine by.
        out: Math.min(span, reach),
        span,
        speed: GRAPPLE_START,
        vine: null,
        anchor: { x: aim.location.x, y: aim.location.y, z: aim.location.z },
        caught: aim.entity && isValidCombatTarget(aim.entity, player) ? aim.entity : null
    };

    try { player.playSound("mob.wither.shoot", { pitch: 1.7, volume: 0.5 }); } catch { }

    line.runId = system.runInterval(() => {
        line.ticks++;

        let gone = false;
        try { gone = !player.isValid(); } catch { gone = true; }
        if (gone || line.ticks > GRAPPLE_MAX_HOLD) {
            releaseGrapple(player);
            return;
        }

        // charged on the same half second the rays are
        if (onManaCost && line.ticks % 10 === 0 && onManaCost() === false) {
            releaseGrapple(player);
            return;
        }

        // a caught creature is a moving anchor
        if (line.caught) {
            let lost = false;
            try { lost = !line.caught.isValid(); } catch { lost = true; }
            if (lost) { releaseGrapple(player); return; }
            try { line.anchor = line.caught.location; } catch { }
        }

        const tip = grappleTip(player, line);
        stretchVine(dimension, line, getWandTipLocation(player), tip);

        // still flying out
        if (line.out < line.span) {
            line.out = Math.min(line.span, line.out + reach);
            if (line.out >= line.span) {
                try { dimension.playSound("random.bowhit", tip, { volume: 0.7, pitch: 0.9 }); } catch { }
            }
            return;
        }

        haulGrapple(player, line, reel);
    }, 1);

    activeGrapples.set(player.id, line);
}

/** Where the end of the vine is right now: on its way out, or on the anchor */
function grappleTip(player, line) {
    if (line.out >= line.span) return line.anchor;
    const from = getWandTipLocation(player);
    const part = line.out / line.span;
    return {
        x: from.x + (line.anchor.x - from.x) * part,
        y: from.y + (line.anchor.y - from.y) * part,
        z: from.z + (line.anchor.z - from.z) * part
    };
}

/**
 * The vine itself: one thin rod of a model, stretched from the wand to the end
 * of the throw and turned to face it.
 *
 * It was a line of particles first, which looked like a line of particles. This
 * is the same trick the lightning ray already uses - a model one block tall
 * along its own up axis, scaled on that axis by the distance and tipped by the
 * pitch, while the entity's own facing takes care of the turn. One entity, held
 * for the length of the throw, rather than fifty sprites a tick.
 */
function stretchVine(dimension, line, from, to) {
    if (!line.vine || !line.vine.isValid()) {
        try {
            line.vine = dimension.spawnEntity(GRAPPLE_VINE, from);
            // Shrunk to nothing the instant it exists. A newly spawned entity
            // keeps its defaults until something sets them, and the default is
            // a whole block of bamboo sitting unrotated at the wand tip - which
            // is off to the side of where the player is looking. That one frame
            // is what reads as the vine flicking out sideways before it snaps
            // into line.
            line.vine.setProperty("ws:length", 0.1);
            line.vine.setProperty("ws:pitch", 0.0);
        } catch {
            line.vine = null;
            return;
        }
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const flat = Math.hypot(dx, dz);
    const span = Math.hypot(dx, dy, dz);

    const pitch = -Math.atan2(dy, flat || 0.001) * (180 / Math.PI);
    const yaw = -Math.atan2(dx, dz || 0.001) * (180 / Math.PI);

    try {
        // Turned every tick even when it has no length to speak of, so it is
        // never left pointing at whatever it was pointing at before.
        const where = { dimension, keepVelocity: false };
        if (span >= 0.1 && Number.isFinite(to.x) && Number.isFinite(to.y) && Number.isFinite(to.z)) {
            where.facingLocation = { x: to.x, y: to.y, z: to.z };
        } else {
            where.rotation = { x: 0, y: Number.isFinite(yaw) ? yaw : 0 };
        }
        line.vine.teleport(from, where);
        line.vine.setProperty("ws:length", Math.max(0.1, Math.min(64, span)));
        line.vine.setProperty("ws:pitch", Number.isFinite(pitch) ? pitch : 0);
    } catch { }
}

/** Taking the vine away again */
function cutVine(line) {
    if (!line || !line.vine) return;
    try { if (line.vine.isValid()) line.vine.remove(); } catch { }
    line.vine = null;
}

/**
 * One tick of hauling: the wizard towards whatever the vine bit.
 *
 * A caught creature is not reeled in - it is a moving anchor, and the wizard
 * goes to it. Hauling the creature instead was the other way round from what a
 * grapple is for, and it floated them into the air besides.
 */
function haulGrapple(player, line, reel) {
    try {
        const me = player.location;
        const a = line.anchor;

        const dx = a.x - me.x;
        const dy = a.y - me.y;
        const dz = a.z - me.z;
        const gap = Math.hypot(dx, dy, dz) || 1;

        if (gap < GRAPPLE_ARRIVED) return;

        // winds up over the first half second rather than starting at full tilt
        line.speed = Math.min(GRAPPLE_TOP, line.speed + GRAPPLE_ACCEL);

        // and eases off over the last few blocks, so the anchor is arrived at
        // rather than collided with
        const ease = gap < GRAPPLE_BRAKE
            ? Math.max(GRAPPLE_BRAKE_FLOOR, gap / GRAPPLE_BRAKE)
            : 1;
        const pull = line.speed * ease * reel;

        const flat = Math.hypot(dx, dz) || 0.001;
        const rise = Math.max(GRAPPLE_RISE_MIN, Math.min(GRAPPLE_RISE_MAX, (dy / gap) * pull * GRAPPLE_RISE));
        knockback(player, dx / flat, dz / flat, pull, rise);

        // No Slow Falling. It was here to stop a line let go of halfway up a
        // cliff being fatal, but it also made every swing float, which is not
        // what a rope should feel like. The fall is the wizard's own problem
        // now, as it is with any other way of getting up high.
    } catch { }
}

/** Letting go */
function releaseGrapple(player, silent = false) {
    if (!player) return;
    let id;
    try { id = player.id; } catch { return; }

    const line = activeGrapples.get(id);
    if (!line) return;
    try { system.clearRun(line.runId); } catch { }
    cutVine(line);
    activeGrapples.delete(id);

    if (!silent) {
        try { player.playSound("random.bowhit", { pitch: 1.4, volume: 0.4 }); } catch { }
    }
}

/**
 * Grapple, as a scroll casts it: one pull towards the aimed point.
 *
 * A scroll is used and spent in the same instant, so there is no button to hold
 * and nothing to let go of. This is the whole spell compressed into one yank.
 */
function castGrapple(player, headLoc, viewDir, props, modifiers) {
    const maxRange = (props.range ?? 20) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    if (!target.location) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.nothing_to_hook" });
        return false;
    }

    // Hook trail up to the anchor point
    try {
        const dist = Math.hypot(target.location.x - headLoc.x, target.location.y - headLoc.y, target.location.z - headLoc.z);
        // The vanilla crit particle is a directional one: it reads
        // variable.direction and logs a Molang error for every particle when
        // nothing supplies it. Along a trail, the direction is the way the
        // trail is going.
        const aim = new MolangVariableMap();
        aim.setVector3("direction", { x: viewDir.x, y: viewDir.y, z: viewDir.z });
        for (let d = 1; d < dist; d += 0.7) {
            player.dimension.spawnParticle("minecraft:basic_crit_particle", spawnInFront(headLoc, viewDir, d), aim);
        }
    } catch { }

    const dx = target.location.x - player.location.x;
    const dy = target.location.y - player.location.y;
    const dz = target.location.z - player.location.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const strength = props.reel_speed ?? 1;
    const horizontal = Math.hypot(dx, dz) || 1;

    knockback(player, dx / horizontal, dz / horizontal, len * 0.12 * strength, Math.max(0.35, (dy / len) * 0.9 + 0.3));
    return true;
}

/**
 * Mine: breaks the aimed block at range, leaving its drops on the ground
 */
function castMine(player, props, modifiers) {
    const maxRange = (props.range ?? 8) * modifiers.range;
    let block = null;
    try {
        block = player.getBlockFromViewDirection({ maxDistance: maxRange })?.block;
    } catch { }

    if (!block) {
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_block" });
        return false;
    }

    // Indestructible blocks are not going anywhere
    if (block.typeId === "minecraft:bedrock" || block.typeId === "minecraft:barrier" || block.typeId === "minecraft:end_portal_frame") {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.block_resists" });
        return false;
    }

    const loc = block.location;
    try {
        // destroy makes the block drop its items, as if broken by hand
        player.dimension.runCommand(`setblock ${loc.x} ${loc.y} ${loc.z} air destroy`);
    } catch {
        try { block.setType("minecraft:air"); } catch { return false; }
    }

    try {
        // supplies variable.direction, which this vanilla particle needs and
        // errors without - upward, since the block is popping out of the ground
        const pop = new MolangVariableMap();
        pop.setVector3("direction", { x: 0, y: 1, z: 0 });
        player.dimension.spawnParticle("minecraft:basic_crit_particle", { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 }, pop);
    } catch { }
    return true;
}

/**
 * Light: plants a light block at the aimed point, which clears itself when the duration ends
 */
function castLight(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 4) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const point = target.location ?? spawnInFront(headLoc, viewDir, maxRange);

    // Step back half a block toward the wizard so it does not spawn inside the wall
    const loc = {
        x: Math.floor(point.x - viewDir.x * 0.5),
        y: Math.floor(point.y - viewDir.y * 0.5),
        z: Math.floor(point.z - viewDir.z * 0.5)
    };

    let block = null;
    try { block = dimension.getBlock(loc); } catch { }
    if (!block || !block.isAir) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_room_light" });
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        return false;
    }

    // The light block name changed between versions; try the new one and fall back
    let placed = false;
    try {
        block.setType("minecraft:light_block_15");
        placed = true;
    } catch {
        try {
            block.setType("minecraft:light_block");
            placed = true;
        } catch { }
    }
    if (!placed) return false;

    try {
        dimension.spawnParticle("minecraft:end_rod", { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 });
    } catch { }

    // Goes out on its own at the end of the duration, if it is still light
    const ticks = Math.round((props.duration ?? 600) * modifiers.duration);
    system.runTimeout(() => {
        try {
            const current = dimension.getBlock(loc);
            if (current && current.typeId.startsWith("minecraft:light_block")) current.setType("minecraft:air");
        } catch { }
    }, ticks);

    return true;
}

/**
 * Fangs: a line of fangs tearing along the ground to the target, like the Evoker's
 */
function castFangs(player, headLoc, viewDir, props, modifiers) {
    const dimension = player.dimension;
    const maxRange = (props.range ?? 10) * modifiers.range;
    const target = findAimTarget(player, maxRange);
    const destination = target.location ?? spawnInFront(headLoc, viewDir, maxRange);

    const dx = destination.x - player.location.x;
    const dz = destination.z - player.location.z;
    const separation = Math.min(maxRange, Math.hypot(dx, dz));
    if (separation < 1) return false;

    const stepX = dx / separation;
    const stepZ = dz / separation;
    let spawned = 0;

    for (let d = 1.5; d <= separation; d += 1.2) {
        const x = player.location.x + stepX * d;
        const z = player.location.z + stepZ * d;
            // Look for ground near the wizard's height so the fangs do not spawn in mid-air
        for (let dy = 1; dy >= -2; dy--) {
            const y = Math.floor(player.location.y) + dy;
            if (!isSolidBlockAt(dimension, x, y - 1, z)) continue;
            try {
                dimension.spawnEntity("minecraft:evocation_fang", { x, y, z });
                spawned++;
            } catch { }
            break;
        }
    }

    if (spawned === 0) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_firm_ground" });
        return false;
    }
    return true;
}

// ------------------------------------------------------------------ Teleport to stone

/**
 * Transportation: takes the wizard to the nearest Transportation Stone in the same
 * dimension, after a countdown they have to stand still through.
 */
function castTransportation(player, props, modifiers) {
    const stones = loadStones();
    const dimensionId = player.dimension.id;

    let nearest = null;
    let bestDist = Infinity;
    for (const stone of stones) {
        const parts = String(stone.key ?? "").split("|");
        if (parts.length !== 4 || parts[0] !== dimensionId) continue;
        const loc = { x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) };
        if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y) || !Number.isFinite(loc.z)) continue;
        const d = Math.hypot(loc.x - player.location.x, loc.y - player.location.y, loc.z - player.location.z);
        if (d < bestDist) {
            bestDist = d;
            nearest = { loc, nome: stone.name ?? "Pedra de Transporte" };
        }
    }

    if (!nearest) {
        player.onScreenDisplay.setActionBar({ translate: "ws.msg.no_stone" });
        player.playSound("random.fizz", { pitch: 1.2, volume: 0.6 });
        return false;
    }

    const tally = Math.round(props.teleport_countdown ?? 75);
    const origin = { x: player.location.x, y: player.location.y, z: player.location.z };
    player.onScreenDisplay.setActionBar({ translate: "ws.msg.teleporting", with: [nearest.nome] });

    let ticks = 0;
    const id = system.runInterval(() => {
        ticks++;
        if (!player.isValid()) {
            system.clearRun(id);
            return;
        }

        // Walking away cancels the trip
        const moved = Math.hypot(player.location.x - origin.x, player.location.y - origin.y, player.location.z - origin.z);
        if (moved > 1.5) {
            system.clearRun(id);
            player.onScreenDisplay.setActionBar({ translate: "ws.msg.teleport_broken" });
            try { player.playSound("random.fizz", { pitch: 0.8, volume: 0.8 }); } catch { }
            return;
        }

        try {
            player.dimension.spawnParticle("minecraft:witch_spell_particle", {
                x: player.location.x + (Math.random() - 0.5),
                y: player.location.y + Math.random() * 2,
                z: player.location.z + (Math.random() - 0.5)
            });
        } catch { }

        if (ticks >= tally) {
            system.clearRun(id);
            try {
                player.teleport({ x: nearest.loc.x + 0.5, y: nearest.loc.y + 1, z: nearest.loc.z + 0.5 }, {
                    dimension: player.dimension,
                    keepVelocity: false
                });
                player.dimension.playSound("spell.transportation", player.location, { volume: 1.0 });
                player.onScreenDisplay.setActionBar({ translate: "ws.msg.arrived", with: [nearest.nome] });
            } catch { }
        }
    }, 1);

    return true;
}
