import { world, system } from "@minecraft/server";
import { txt } from "../utils/common.js";
import { blockKey, claimBlockInteraction } from "../utils/common.js";

/**
 * Runestone Pedestal (adapted from EBWizardry's shrine):
 * activating it summons a wave of hostile guardians. Defeat them all and the
 * pedestal is claimed, releasing the shrine reward (chests/shrine loot table).
 */

const PEDESTAL = "ws:runestone_pedestal";
const PROP_PREFIX = "ws:pedestal:";
const GUARDIANS = ["minecraft:zombie", "minecraft:skeleton", "minecraft:husk", "minecraft:witch"];
const SPAWN_RADIUS = 4;
const PLAYER_RANGE = 32;
const CHECK_INTERVAL = 20;
const CHALLENGE_TIMEOUT_TICKS = 20 * 60 * 5;

// key -> { dimensionId, loc, tag, startTick }
const activeChallenges = new Map();

const propFor = (key) => PROP_PREFIX + key;

function parseKey(key) {
    const [dimensionId, x, y, z] = key.split("|");
    return { dimensionId, loc: { x: Number(x), y: Number(y), z: Number(z) } };
}

function challengeTag(key) {
    return "ws_pedestal_" + key.replace(/[^a-zA-Z0-9-]/g, "_");
}

function playersNear(dimension, loc, range) {
    return dimension.getPlayers({ location: loc, maxDistance: range });
}

function startChallenge(player, block) {
    const dimension = block.dimension;
    const loc = block.location;
    const key = blockKey(dimension.id, loc);
    const state = world.getDynamicProperty(propFor(key));

    if (state === "conquered") {
        player.onScreenDisplay.setActionBar(txt("ws.msg.pedestal_claimed"));
        return;
    }
    // Only pedestals generated with a shrine hold a reward, otherwise crafting
    // pedestals would let anyone farm the challenge.
    if (state === "construido") {
        player.onScreenDisplay.setActionBar(txt("ws.msg.pedestal_built"));
        player.playSound("note.bass", { pitch: 0.7, volume: 0.8 });
        return;
    }
    if (state === "active" || activeChallenges.has(key)) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.pedestal_fight"));
        return;
    }

    const tag = challengeTag(key);
    let spawned = 0;
    for (let i = 0; i < GUARDIANS.length; i++) {
        const angle = (Math.PI * 2 * i) / GUARDIANS.length;
        const spawnLoc = {
            x: loc.x + 0.5 + Math.cos(angle) * SPAWN_RADIUS,
            y: loc.y + 1,
            z: loc.z + 0.5 + Math.sin(angle) * SPAWN_RADIUS
        };
        try {
            const mob = dimension.spawnEntity(GUARDIANS[i], spawnLoc);
            mob.addTag(tag);
            mob.addTag("ws_pedestal_guardian");
            dimension.spawnParticle("minecraft:large_explosion", spawnLoc);
            spawned++;
        } catch { }
    }

    if (spawned === 0) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.pedestal_no_room"));
        return;
    }

    world.setDynamicProperty(propFor(key), "active");
    activeChallenges.set(key, { dimensionId: dimension.id, loc, tag, startTick: system.currentTick });

    try { dimension.playSound("block.pedestal.activate", loc); } catch { }
    for (const p of playersNear(dimension, loc, PLAYER_RANGE)) {
                p.onScreenDisplay.setTitle(txt("ws.msg.shrine_start"), { subtitle: txt("ws.msg.shrine_start_sub"), fadeInDuration: 10, stayDuration: 40, fadeOutDuration: 10 });
    }
}

function finishChallenge(key, challenge, conquered) {
    activeChallenges.delete(key);
    const dimension = world.getDimension(challenge.dimensionId);
    const loc = challenge.loc;

    if (!conquered) {
        world.setDynamicProperty(propFor(key), undefined);
        return;
    }

    world.setDynamicProperty(propFor(key), "conquered");
    const top = { x: loc.x + 0.5, y: loc.y + 1.2, z: loc.z + 0.5 };
    try {
        dimension.playSound("block.pedestal.conquer", loc);
        dimension.spawnParticle("minecraft:totem_particle", top);
        dimension.runCommand(`loot spawn ${top.x} ${top.y} ${top.z} loot "chests/shrine"`);
    } catch (e) {
        console.warn(`[Pedestal] Falha ao entregar recompensa: ${e}`);
    }
    for (const p of playersNear(dimension, loc, PLAYER_RANGE)) {
                p.onScreenDisplay.setTitle(txt("ws.msg.shrine_won"), { subtitle: txt("ws.msg.shrine_won_sub"), fadeInDuration: 10, stayDuration: 40, fadeOutDuration: 10 });
    }
}

// Periodic check for whether the guardians are down
system.runInterval(() => {
    for (const [key, challenge] of activeChallenges) {
        let dimension;
        try {
            dimension = world.getDimension(challenge.dimensionId);
        } catch {
            continue;
        }

        const players = playersNear(dimension, challenge.loc, PLAYER_RANGE);
        let remaining;
        try {
            remaining = dimension.getEntities({ tags: [challenge.tag] });
        } catch {
            continue; // área descarregada
        }

        if (remaining.length === 0) {
            // With no players around the guardians merely despawned: the challenge resets
            finishChallenge(key, challenge, players.length > 0);
            continue;
        }

        // Abandoned for too long: clear the guardians and reset the pedestal
        if (players.length === 0 && system.currentTick - challenge.startTick > CHALLENGE_TIMEOUT_TICKS) {
            for (const mob of remaining) {
                try { mob.remove(); } catch { }
            }
            finishChallenge(key, challenge, false);
        }
    }
}, CHECK_INTERVAL);

// Restores running challenges after a world reload
function restoreChallenges() {
    try {
        for (const id of world.getDynamicPropertyIds()) {
            if (!id.startsWith(PROP_PREFIX) || world.getDynamicProperty(id) !== "active") continue;
            const key = id.slice(PROP_PREFIX.length);
            const { dimensionId, loc } = parseKey(key);
            activeChallenges.set(key, { dimensionId, loc, tag: challengeTag(key), startTick: system.currentTick });
        }
    } catch {
        system.runTimeout(restoreChallenges, 20);
    }
}
system.runTimeout(restoreChallenges, 20);

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    if (event.block.typeId !== PEDESTAL) return;
    if (!claimBlockInteraction(event)) return;
    const player = event.player;
    const block = event.block;
    system.run(() => startChallenge(player, block));
});

// Player-placed pedestals are flagged so they never count as a shrine
world.afterEvents.playerPlaceBlock.subscribe((event) => {
    if (event.block.typeId !== PEDESTAL) return;
    const key = blockKey(event.dimension.id, event.block.location);
    world.setDynamicProperty(propFor(key), "construido");
});

// Breaking the pedestal forgets its state
world.afterEvents.playerBreakBlock.subscribe((event) => {
    if (event.brokenBlockPermutation.type.id !== PEDESTAL) return;
    const key = blockKey(event.dimension.id, event.block.location);
    activeChallenges.delete(key);
    world.setDynamicProperty(propFor(key), undefined);
});
