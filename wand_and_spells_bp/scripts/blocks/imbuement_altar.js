import { world, system, ItemStack } from "@minecraft/server";
import { ELEMENTS, ELEMENT_COLORS, blockKey, claimBlockInteraction, consumeHeldItem, getHeldItem, giveItem, txt } from "../utils/common.js";

/**
 * Imbuement Altar (adapted from EBWizardry):
 * - 4 receptacles around the altar (N/S/E/W, 1 or 2 blocks out, same height or one above)
 * - each receptacle takes one elemental Spectral Dust (use the dust on it)
 * - with all 4 holding the SAME element the altar lights up and imbues the held item
 */

const ALTAR_ACTIVE = "ws:imbuement_altar";
const ALTAR_INACTIVE = "ws:imbuement_altar_inactive";
const RECEPTACLE = "ws:receptacle";
const IMBUE_TICKS = 60;
const ELEMENT_KEYS = {
    fire: "ws.element.fire", ice: "ws.element.ice", lightning: "ws.element.lightning", earth: "ws.element.earth",
    healing: "ws.element.healing", necromancy: "ws.element.necromancy", sorcery: "ws.element.sorcery"
};

const DIRECTIONS = [
    { x: 0, z: -1 }, // norte
    { x: 0, z: 1 },  // sul
    { x: 1, z: 0 },  // leste
    { x: -1, z: 0 }  // oeste
];

const imbuingAltars = new Set();

// ------------------------------------------------------------------ Receptacles

const receptacleProp = (dimensionId, loc) => `ws:receptacle:${blockKey(dimensionId, loc)}`;

function getReceptacleElement(dimensionId, loc) {
    return world.getDynamicProperty(receptacleProp(dimensionId, loc));
}

function setReceptacleElement(dimensionId, loc, element) {
    world.setDynamicProperty(receptacleProp(dimensionId, loc), element);
    igniteReceptacle(dimensionId, loc, element);
}

/**
 * Lights or clears the dust inside a receptacle.
 * The block state is what the renderer sees: it swaps the texture, shows the cube and turns the light on.
 */
function igniteReceptacle(dimensionId, loc, element) {
    try {
        const block = world.getDimension(dimensionId).getBlock(loc);
        if (!block || block.typeId !== RECEPTACLE) return;
        block.setPermutation(block.permutation.withState("ws:element", element ?? "none"));
    } catch { }
}

function receptacleParticles(dimension, loc) {
    try {
        for (let i = 0; i < 6; i++) {
            dimension.spawnParticle("minecraft:witch_spell_particle", {
                x: loc.x + 0.5 + (Math.random() - 0.5) * 0.4,
                y: loc.y + 0.5 + Math.random() * 0.4,
                z: loc.z + 0.5 + (Math.random() - 0.5) * 0.4
            });
        }
    } catch { }
}

function interactReceptacle(player, block) {
    const dimension = block.dimension;
    const loc = block.location;
    const stored = getReceptacleElement(dimension.id, loc);
    const held = getHeldItem(player);
    const dustElement = held?.typeId.startsWith("ws:spectral_dust_") ? held.typeId.replace("ws:spectral_dust_", "") : null;

    if (dustElement && ELEMENTS.includes(dustElement)) {
        if (stored) {
            player.onScreenDisplay.setActionBar(txt("ws.msg.receptacle_full", ELEMENT_COLORS[stored], txt(ELEMENT_KEYS[stored])));
            return;
        }
        consumeHeldItem(player);
        setReceptacleElement(dimension.id, loc, dustElement);
        try { dimension.playSound("block.receptacle.ignite", loc); } catch { }
        receptacleParticles(dimension, loc);
        player.onScreenDisplay.setActionBar(txt("ws.msg.receptacle_set", ELEMENT_COLORS[dustElement], txt(ELEMENT_KEYS[dustElement])));
        updateAltarsNear(dimension, loc);
        return;
    }

    if (stored) {
        // Take the dust back out
        setReceptacleElement(dimension.id, loc, undefined);
        giveItem(player, new ItemStack(`ws:spectral_dust_${stored}`, 1));
        player.playSound("random.pop", { volume: 0.8 });
        player.onScreenDisplay.setActionBar(txt("ws.msg.receptacle_emptied"));
        updateAltarsNear(dimension, loc);
        return;
    }

    player.onScreenDisplay.setActionBar(txt("ws.msg.receptacle_hint"));
}

// ------------------------------------------------------------------ Altar

/**
 * The altar's 4 receptacles, with their element. Returns fewer than 4 if any is missing.
 */
function findAltarReceptacles(dimension, altarLoc) {
    const found = [];
    for (const dir of DIRECTIONS) {
        let match = null;
        for (let dist = 1; dist <= 2 && !match; dist++) {
            for (let dy = 0; dy <= 1 && !match; dy++) {
                const loc = { x: altarLoc.x + dir.x * dist, y: altarLoc.y + dy, z: altarLoc.z + dir.z * dist };
                try {
                    const block = dimension.getBlock(loc);
                    if (block?.typeId === RECEPTACLE) {
                        const element = getReceptacleElement(dimension.id, loc);
                        // Resync receptacles whose visual fell out of step
                        if ((block.permutation.getState("ws:element") ?? "none") !== (element ?? "none")) {
                            igniteReceptacle(dimension.id, loc, element);
                        }
                        match = { loc, element };
                    }
                } catch { }
            }
        }
        if (match) found.push(match);
    }
    return found;
}

/**
 * Element shared by all 4 receptacles, or null if any is empty or different
 */
function getAltarElement(receptacles) {
    if (receptacles.length < 4 || receptacles.some((r) => !r.element)) return null;
    const first = receptacles[0].element;
    return receptacles.every((r) => r.element === first) ? first : null;
}

function setAltarActive(block, active) {
    const target = active ? ALTAR_ACTIVE : ALTAR_INACTIVE;
    if (block.typeId !== target) {
        try { block.setType(target); } catch { }
    }
}

function updateAltarsNear(dimension, loc) {
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (dx !== 0 && dz !== 0) continue;
            for (let dy = -1; dy <= 0; dy++) {
                try {
                    const block = dimension.getBlock({ x: loc.x + dx, y: loc.y + dy, z: loc.z + dz });
                    if (block && (block.typeId === ALTAR_ACTIVE || block.typeId === ALTAR_INACTIVE)) {
                        setAltarActive(block, getAltarElement(findAltarReceptacles(dimension, block.location)) !== null);
                    }
                } catch { }
            }
        }
    }
}

/**
 * Imbuement recipes: take the held item and the element, return the result
 * ({ item } for an ItemStack, { lootTable } to roll from a loot table)
 */
const ARMOR_PIECES = ["ws:wizard_hat", "ws:wizard_robe", "ws:wizard_leggings", "ws:wizard_boots"];

function getImbuementResult(held, element) {
    if (held.typeId === "ws:ruined_spell_book") {
        return { lootTable: `gameplay/imbuement_altar/ruined_spell_book_${element}` };
    }
    if (held.typeId === "ws:crystal_magic") {
        return { item: new ItemStack(`ws:crystal_${element}`, 1) };
    }
    if (held.typeId === "ws:spectral_dust") {
        return { item: new ItemStack(`ws:spectral_dust_${element}`, 1) };
    }
    if (ARMOR_PIECES.includes(held.typeId)) {
        const result = new ItemStack(`${held.typeId}_${element}`, 1);
        // Keep the original piece's damage and custom name
        try {
            const oldDur = held.getComponent("minecraft:durability");
            const newDur = result.getComponent("minecraft:durability");
            if (oldDur && newDur) newDur.damage = Math.min(oldDur.damage, newDur.maxDurability - 1);
        } catch { }
        if (held.nameTag) result.nameTag = held.nameTag;
        return { item: result };
    }
    return null;
}

function interactAltar(player, block) {
    const dimension = block.dimension;
    const altarLoc = block.location;
    const key = blockKey(dimension.id, altarLoc);

    if (imbuingAltars.has(key)) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.altar_busy"));
        return;
    }

    const receptacles = findAltarReceptacles(dimension, altarLoc);
    const filled = receptacles.filter((r) => r.element).length;
    if (receptacles.length < 4 || filled < 4) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.altar_filled", filled));
        setAltarActive(block, false);
        return;
    }

    const element = getAltarElement(receptacles);
    if (!element) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.altar_mismatch"));
        setAltarActive(block, false);
        return;
    }
    setAltarActive(block, true);

    const held = getHeldItem(player);
    const result = held ? getImbuementResult(held, element) : null;
    if (!result) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.altar_hint", ELEMENT_COLORS[element], txt(ELEMENT_KEYS[element])));
        return;
    }

    // The item is consumed up front so it cannot be used twice
    consumeHeldItem(player);
    imbuingAltars.add(key);
    try { dimension.playSound("block.imbuement_altar.imbue", altarLoc); } catch { }

    const center = { x: altarLoc.x + 0.5, y: altarLoc.y + 1.1, z: altarLoc.z + 0.5 };
    let tick = 0;
    const runId = system.runInterval(() => {
        tick += 4;
        try {
            // Particles streaming from each receptacle toward the altar
            for (const r of receptacles) {
                const t = (tick % 20) / 20;
                dimension.spawnParticle("minecraft:witch_spell_particle", {
                    x: r.loc.x + 0.5 + (center.x - r.loc.x - 0.5) * t,
                    y: r.loc.y + 0.6 + (center.y - r.loc.y - 0.6) * t,
                    z: r.loc.z + 0.5 + (center.z - r.loc.z - 0.5) * t
                });
            }
        } catch { }

        if (tick < IMBUE_TICKS) return;
        system.clearRun(runId);
        imbuingAltars.delete(key);

        // Spend the receptacle dust and put the altar out
        for (const r of receptacles) setReceptacleElement(dimension.id, r.loc, undefined);
        try { setAltarActive(dimension.getBlock(altarLoc), false); } catch { }

        if (result.lootTable) {
            try {
                dimension.runCommand(`loot spawn ${center.x} ${center.y} ${center.z} loot "${result.lootTable}"`);
            } catch (e) {
                console.warn(`[Altar] Falha ao sortear ${result.lootTable}: ${e}`);
            }
        } else if (player.isValid()) {
            giveItem(player, result.item);
        } else {
            dimension.spawnItem(result.item, center);
        }

        try {
            dimension.spawnParticle("minecraft:totem_particle", center);
            dimension.playSound("random.levelup", center, { pitch: 1.3 });
        } catch { }
        if (player.isValid()) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.imbue_done", ELEMENT_COLORS[element], txt(ELEMENT_KEYS[element])));
        }
    }, 4);
}

// ------------------------------------------------------------------ Events

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const typeId = event.block.typeId;
    if (typeId !== RECEPTACLE && typeId !== ALTAR_ACTIVE && typeId !== ALTAR_INACTIVE) return;
    if (!claimBlockInteraction(event)) return;

    const player = event.player;
    const block = event.block;
    system.run(() => {
        if (typeId === RECEPTACLE) interactReceptacle(player, block);
        else interactAltar(player, block);
    });
});

// Breaking a receptacle returns the dust and updates the altar
world.afterEvents.playerBreakBlock.subscribe((event) => {
    if (event.brokenBlockPermutation.type.id !== RECEPTACLE) return;
    const dimension = event.dimension;
    const loc = event.block.location;
    const stored = getReceptacleElement(dimension.id, loc);
    if (stored) {
        setReceptacleElement(dimension.id, loc, undefined);
        dimension.spawnItem(new ItemStack(`ws:spectral_dust_${stored}`, 1), { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 });
    }
    updateAltarsNear(dimension, loc);
});
