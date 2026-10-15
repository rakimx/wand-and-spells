import { world, system } from "@minecraft/server";

/**
 * Putting the wizards back in their towers.
 *
 * Every tower was saved with its wizard inside it - the .mcstructure files
 * carry a proper entities list, friendly wizards in the plain towers and evil
 * ones in the towers with a chest. World generation never spawns them: a
 * structure placed by a feature contributes its blocks and nothing else, so the
 * towers came out furnished but empty.
 *
 * The towers now carry a marker block at the exact cell where the wizard stood,
 * baked into the structure itself alongside the walls. Whatever the game does
 * with the structure - wherever it puts it, however it turns it - the marker
 * goes with it, because it is part of it. So there is nothing here to work out:
 * the wizard stands up where the marker was.
 */

/** Which marker makes which wizard, and how many faces that wizard has */
const MARKER_MOBS = {
    "ws:wizard_marker": { mob: "ws:wizard", skins: 11 },
    "ws:evil_wizard_marker": { mob: "ws:evil_wizard", skins: 6 }
};

/** The elements a tower wizard can belong to, as both entities declare them */
const WIZARD_ELEMENTS = ["fire", "ice", "lightning", "earth", "healing", "necromancy", "sorcery"];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

/**
 * The marker's one and only tick: it goes back to being air, and a wizard
 * stands where it was.
 *
 * The block is cleared first. If the spawn then throws - a neighbour chunk not
 * there yet, a body that will not fit - the marker must still not survive, or
 * it would try again every few ticks for the life of the world.
 */
function hatchMarker(block) {
    const kind = MARKER_MOBS[block.typeId];
    if (!kind) return;

    const dimension = block.dimension;
    const where = { x: block.x + 0.5, y: block.y, z: block.z + 0.5 };

    try {
        block.setType("minecraft:air");
    } catch (err) {
        console.warn("[Wizard Marker] could not clear the marker: " + err);
        return;
    }

    try {
        const wizard = dimension.spawnEntity(kind.mob, where);
        try { wizard.setProperty("ws:element", pick(WIZARD_ELEMENTS)); } catch { }
        try { wizard.setProperty("ws:skin", Math.floor(Math.random() * kind.skins)); } catch { }
    } catch (err) {
        console.warn("[Wizard Marker] could not raise " + kind.mob + " at " + block.x + "," + block.y + "," + block.z + ": " + err);
    }
}

const MARKER_COMPONENT = {
    onTick(event) {
        hatchMarker(event.block);
    }
};

/**
 * Custom block components are registered at startup, and which event carries
 * the registry moved between API versions. Both are tried, and whichever exists
 * here is the one that takes; saying so in the log means a tower full of
 * markers instead of wizards has an obvious cause rather than a mysterious one.
 */
function registerMarker() {
    let registered = false;

    try {
        system.beforeEvents.startup.subscribe((event) => {
            event.blockComponentRegistry.registerCustomComponent("ws:wizard_marker", MARKER_COMPONENT);
        });
        registered = true;
    } catch { }

    if (!registered) {
        try {
            world.beforeEvents.worldInitialize.subscribe((event) => {
                event.blockComponentRegistry.registerCustomComponent("ws:wizard_marker", MARKER_COMPONENT);
            });
            registered = true;
        } catch { }
    }

    if (!registered) {
        console.warn("[Wizard Marker] no block component registry on this version - towers will stand empty");
    }
}

registerMarker();
