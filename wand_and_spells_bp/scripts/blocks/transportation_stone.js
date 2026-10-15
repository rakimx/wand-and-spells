import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { blockKey, claimBlockInteraction, isWandItem, txt } from "../utils/common.js";
import { getWandMana, setWandMana, applyPendingMana, takeBankedMana } from "../wands/wand_data.js";

/**
 * Transportation Stone (adapted from EBWizardry's transport circle):
 * each stone can be registered with a name, and from any registered stone
 * you can travel to another, paying mana from the held wand.
 */

const STONE = "ws:transportation_stone";
const REGISTRY_PROP = "ws:transport_stones";
const TELEPORT_COST = 50;
const DIMENSION_KEYS = {
    "minecraft:overworld": "ws.dim.overworld",
    "minecraft:nether": "ws.dim.nether",
    "minecraft:the_end": "ws.dim.the_end"
};

export function loadStones() {
    try {
        return JSON.parse(world.getDynamicProperty(REGISTRY_PROP) ?? "[]");
    } catch {
        return [];
    }
}

function saveStones(stones) {
    world.setDynamicProperty(REGISTRY_PROP, JSON.stringify(stones));
}

function findStone(stones, key) {
    return stones.find((s) => s.key === key);
}

function openStoneMenu(player, block) {
    const key = blockKey(block.dimension.id, block.location);
    const stones = loadStones();
    const current = findStone(stones, key);

    if (!current) {
        openRenameForm(player, block, null);
        return;
    }

    const destinations = stones.filter((s) => s.key !== key);
    const form = new ActionFormData();
    form.title(txt("ws.ui.stone_title", current.name));
    form.body(txt(destinations.length === 0 ? "ws.ui.stone_body_empty" : "ws.ui.stone_body", TELEPORT_COST));

    const actions = [];
    for (const dest of destinations) {
        const dimName = txt(DIMENSION_KEYS[dest.dimensionId] ?? "ws.dim.overworld");
        let distance = "";
        if (dest.dimensionId === block.dimension.id) {
            distance = txt("ws.ui.stone_distance", Math.round(Math.hypot(dest.x - block.x, dest.z - block.z)));
        }
        form.button(txt("ws.ui.stone_dest", dest.name, dimName, distance));
        actions.push(() => teleportToStone(player, dest));
    }
    form.button(txt("ws.ui.stone_rename"));
    actions.push(() => openRenameForm(player, block, current));
    form.button(txt("ws.ui.stone_forget"));
    actions.push(() => {
        saveStones(loadStones().filter((s) => s.key !== key));
        player.onScreenDisplay.setActionBar(txt("ws.msg.stone_forgotten", current.name));
    });
    form.button(txt("ws.ui.close"));
    actions.push(() => { });

    form.show(player).then((res) => {
        if (res.canceled) return;
        actions[res.selection]?.();
    });
}

function openRenameForm(player, block, current) {
    const form = new ModalFormData();
    form.title(txt(current ? "ws.ui.stone_rename_title" : "ws.ui.stone_register_title"));
    form.textField(txt("ws.ui.stone_field_label"), txt("ws.ui.stone_field_hint"), current?.name ?? "");

    form.show(player).then((res) => {
        if (res.canceled) return;
        const name = String(res.formValues?.[0] ?? "").trim().slice(0, 32);
        if (!name) {
            player.onScreenDisplay.setActionBar(txt("ws.msg.stone_need_name"));
            return;
        }

        if (block.dimension.getBlock(block.location)?.typeId !== STONE) return;

        const key = blockKey(block.dimension.id, block.location);
        const stones = loadStones().filter((s) => s.key !== key);
        stones.push({ key, name, dimensionId: block.dimension.id, x: block.x, y: block.y, z: block.z });
        saveStones(stones);

        player.playSound("random.orb", { pitch: 1.4 });
        player.onScreenDisplay.setActionBar(txt("ws.msg.stone_registered", name));
    });
}

function teleportToStone(player, dest) {
    const inventory = player.getComponent("inventory")?.container;
    const slot = player.selectedSlotIndex;
    const wand = inventory?.getItem(slot);
    if (!isWandItem(wand)) {
        player.onScreenDisplay.setActionBar(txt("ws.msg.stone_need_wand", TELEPORT_COST));
        player.playSound("note.bass", { pitch: 0.7 });
        return;
    }

    applyPendingMana(player);
    const wandItem = inventory.getItem(slot);
    const mana = getWandMana(wandItem) + takeBankedMana(player, slot);
    if (mana < TELEPORT_COST) {
        setWandMana(wandItem, mana);
        inventory.setItem(slot, wandItem);
        player.onScreenDisplay.setActionBar(txt("ws.msg.stone_low_mana", mana, TELEPORT_COST));
        player.playSound("note.bass", { pitch: 0.7 });
        return;
    }

    let dimension;
    try {
        dimension = world.getDimension(dest.dimensionId);
    } catch {
        return;
    }

    // The destination may have been broken while the area was unloaded
    try {
        const destBlock = dimension.getBlock({ x: dest.x, y: dest.y, z: dest.z });
        if (destBlock && destBlock.typeId !== STONE) {
            saveStones(loadStones().filter((s) => s.key !== dest.key));
            player.onScreenDisplay.setActionBar(txt("ws.msg.stone_destroyed", dest.name));
            return;
        }
    } catch { }

    setWandMana(wandItem, mana - TELEPORT_COST);
    inventory.setItem(slot, wandItem);

    const origin = player.location;
    try {
        player.dimension.playSound("spell.transportation", origin);
        player.dimension.spawnParticle("minecraft:witch_spell_particle", origin);
    } catch { }

    player.teleport({ x: dest.x + 0.5, y: dest.y + 1, z: dest.z + 0.5 }, { dimension, keepVelocity: false });

    system.runTimeout(() => {
        try {
            player.playSound("mob.endermen.portal", { pitch: 1.2 });
            player.dimension.spawnParticle("minecraft:witch_spell_particle", player.location);
        } catch { }
        player.onScreenDisplay.setActionBar(txt("ws.msg.stone_arrived", dest.name));
    }, 2);
}

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    if (event.block.typeId !== STONE) return;
    if (!claimBlockInteraction(event)) return;
    const player = event.player;
    const block = event.block;
    system.run(() => openStoneMenu(player, block));
});

// Breaking the stone drops it from the registry
world.afterEvents.playerBreakBlock.subscribe((event) => {
    if (event.brokenBlockPermutation.type.id !== STONE) return;
    const key = blockKey(event.dimension.id, event.block.location);
    const stones = loadStones();
    if (findStone(stones, key)) saveStones(stones.filter((s) => s.key !== key));
});
