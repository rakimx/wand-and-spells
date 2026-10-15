import { system } from "@minecraft/server";
import { txt } from "../utils/common.js";

/**
 * Diagnostic tool (temporary).
 *
 * Look at a block and run in chat:  /scriptevent ws:block
 * The game answers with the block id, its states and which side is supporting it.
 *
 * Useful to work out how Bedrock orients wall-mounted blocks (torch, receptacle)
 * by using the game's own placement as reference.
 *
 * Safe to delete this file and its line in main.js once it is no longer needed.
 */
system.afterEvents.scriptEventReceive.subscribe((event) => {
    if (event.id !== "ws:bloco") return;

    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;

    let target;
    try {
        target = player.getBlockFromViewDirection({ maxDistance: 12, includePassableBlocks: true });
    } catch { }

    if (!target?.block) {
        player.sendMessage(txt("ws.msg.debug_no_block"));
        return;
    }

    const block = target.block;
    let states = {};
    try {
        states = block.permutation.getAllStates();
    } catch { }
    const list = Object.entries(states);

    player.sendMessage(`§6=== ${bloco.typeId}`);
    player.sendMessage(txt("ws.msg.debug_position", block.x, block.y, block.z));
    if (list.length === 0) {
        player.sendMessage("§7(sem estados)");
    } else {
        for (const [chave, valor] of list) {
            player.sendMessage(`§f  ${chave} §7= §e${valor}`);
        }
    }

    // Which neighbours are solid, to tell which side holds the block up
    const sides = {
        norte: { x: 0, y: 0, z: -1 },
        sul: { x: 0, y: 0, z: 1 },
        leste: { x: 1, y: 0, z: 0 },
        oeste: { x: -1, y: 0, z: 0 },
        baixo: { x: 0, y: -1, z: 0 },
        cima: { x: 0, y: 1, z: 0 }
    };
    const supports = [];
    for (const [nome, desloc] of Object.entries(sides)) {
        try {
            const neighbour = block.dimension.getBlock({
                x: block.x + desloc.x,
                y: block.y + desloc.y,
                z: block.z + desloc.z
            });
            if (neighbour && !neighbour.isAir && !neighbour.isLiquid) {
                supports.push(`${nome}=${vizinho.typeId.replace("minecraft:", "")}`);
            }
        } catch { }
    }
    player.sendMessage(`§7apoio: ${apoios.join(", ") || "nenhum"}`);
});
