import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

/**
 * Wizard Handbook.
 *
 * The screen is drawn by ui/server_form.json in the resource pack, which picks
 * the form apart by button index instead of stacking everything in one list.
 * That layout is fixed, so the buttons must always be sent in this exact order:
 *
 *   0 .. 4    the five tabs along the top
 *   5         the close cross on the right of the tab bar
 *   6 .. 21   the entries of the open tab, in the left column
 *   22 .. 30  the 3x3 crafting grid, read row by row
 *   31        the crafting result
 *
 * The grid buttons are never drawn as buttons - the UI reads only their icon
 * and paints them as a crafting bench. Sending a texture is the only way to get
 * an arbitrary image onto the screen, which is why they are buttons at all.
 *
 * Slots that have nothing to show are still sent, as empty buttons. The UI
 * hides any row with no icon, and a slot that was never sent would keep
 * whatever the previous form left in it.
 */

const ENTRY_SLOTS = 16;
const CLOSE_INDEX = 5;
const ENTRY_BASE = 6;
const GRID_SLOTS = 9;

// The crafting grid costs ten extra buttons. This has to stay in step with the
// recipe controls in server_form.json: turning one off without the other leaves
// the ui drawing slots the form never sent.
const SEND_RECIPE = true;

/** Icons by their shorthand, resolved against the packs' real texture paths. */
const ICON = {
    crystal: "textures/items/crystal_magic",
    shard: "textures/items/crystal_shard",
    stick: "textures/items/stick",
    gold: "textures/items/gold_nugget",
    string: "textures/items/string",
    paper: "textures/items/paper",
    bottle: "textures/items/potion_bottle_empty",
    book: "textures/items/book_normal",
    carpet: "textures/blocks/wool_colored_purple",
    lapis: "textures/blocks/lapis_block",
    stone: "textures/blocks/stone",

    wand: "textures/items/wand_novice",
    loom: "textures/blocks/arcane_workbench_side",
    silk: "textures/items/magic_silk",
    scroll: "textures/items/scroll",
    flask: "textures/items/mana_flask_small",
    handbook: "textures/items/wizard_handbook",
    hat: "textures/items/wizard_hat",
    tome: "textures/items/arcane_tome",
    dust: "textures/items/spectral_dust",
    book_fire: "textures/items/spell_book_fire",
    book_ice: "textures/items/spell_book_ice",
    book_lightning: "textures/items/spell_book_lightning",
    book_earth: "textures/items/spell_book_earth",
    book_life: "textures/items/spell_book_healing",
    book_shadow: "textures/items/spell_book_necromancy",
    book_sorcery: "textures/items/spell_book_sorcery",
    spell_book: "textures/items/spell_book"
};

const _ = null;

/**
 * Entries, grouped by the tab they live under.
 *
 * `grid` is the crafting bench read row by row, `result` what comes out.
 * These mirror the recipe json in the behaviour pack - if a recipe changes
 * there, it has to change here too, since nothing links the two.
 */
const TABS = [
    {
        id: "main",
        entries: [
            { id: "welcome", icon: ICON.handbook },
            { id: "first_steps", icon: ICON.wand }
        ]
    },
    {
        id: "wands",
        entries: [
            { id: "loom", icon: ICON.tome },
            { id: "robes", icon: ICON.hat }
        ]
    },
    {
        id: "magic",
        entries: [
            { id: "scrolls", icon: ICON.spell_book },
            { id: "fire", icon: ICON.book_fire },
            { id: "ice", icon: ICON.book_ice },
            { id: "lightning", icon: ICON.book_lightning },
            { id: "earth", icon: ICON.book_earth },
            { id: "life", icon: ICON.book_life },
            { id: "shadow", icon: ICON.book_shadow },
            { id: "sorcery", icon: ICON.book_sorcery }
        ]
    },
    {
        id: "items",
        entries: [
            { id: "crystals", icon: ICON.crystal },
            { id: "dust", icon: ICON.dust }
        ]
    },
    {
        id: "recipes",
        entries: [
            {
                id: "r_wand",
                icon: ICON.wand,
                result: ICON.wand,
                grid: [
                    _, _, ICON.crystal,
                    _, ICON.stick, _,
                    ICON.gold, _, _
                ]
            },
            {
                id: "r_loom",
                icon: ICON.loom,
                result: ICON.loom,
                grid: [
                    ICON.gold, ICON.carpet, ICON.gold,
                    ICON.crystal, ICON.lapis, ICON.crystal,
                    ICON.stone, ICON.stone, ICON.stone
                ]
            },
            {
                id: "r_silk",
                icon: ICON.silk,
                result: ICON.silk,
                grid: [
                    _, ICON.string, _,
                    ICON.string, ICON.crystal, ICON.string,
                    _, ICON.string, _
                ]
            },
            {
                id: "r_flask",
                icon: ICON.flask,
                result: ICON.flask,
                grid: [
                    ICON.shard, ICON.shard, ICON.shard,
                    ICON.shard, ICON.bottle, ICON.shard,
                    ICON.shard, ICON.shard, ICON.shard
                ]
            },
            {
                id: "r_scroll",
                icon: ICON.scroll,
                result: ICON.scroll,
                grid: [
                    _, _, _,
                    ICON.paper, ICON.string, _,
                    _, _, _
                ]
            },
            {
                id: "r_handbook",
                icon: ICON.handbook,
                result: ICON.handbook,
                grid: [
                    _, _, _,
                    ICON.book, ICON.crystal, _,
                    _, _, _
                ]
            }
        ]
    }
];

/**
 * A translated label with a colour code in front of it.
 * The colour is what marks the open tab and the open entry, since the UI has
 * no way of knowing which one the script considers selected.
 */
function label(color, key) {
    return { rawtext: [{ text: color }, { translate: key }] };
}

/**
 * Opens the handbook on a given tab and entry.
 * Every click reopens the form - that is how the selection moves.
 */
export function openWizardHandbook(player, tabIndex = 0, entryIndex = 0) {
    const tab = TABS[tabIndex] ?? TABS[0];
    const entry = tab.entries[entryIndex] ?? tab.entries[0];

    const form = new ActionFormData();
    // The prefix on the title is what tells server_form.json to use our screen
    // instead of the vanilla dialog.
    //
    // It is two reset codes rather than readable text on purpose. The ui can
    // subtract them to detect the form, but it cannot strip them off the label
    // it draws - a view binding onto #text loses to the label's own text
    // property, so the prefix ended up on screen. Reset codes draw nothing, so
    // the title reads correctly whether the ui strips them or not.
    form.title({ rawtext: [{ text: "§r§r" }, { translate: `ws.hb.e.${entry.id}.name` }] });
    form.body({ translate: `ws.hb.e.${entry.id}.body` });

    // Gold for the tab that is open, plain for the rest. The ui draws these
    // labels itself and sets no colour of its own, so these codes are what
    // marks the open tab - the highlight box only follows the keyboard focus.
    for (let i = 0; i < TABS.length; i++) {
        form.button(label(i === tabIndex ? "§e" : "§f", `ws.hb.tab.${TABS[i].id}`));
    }
    form.button("§6X");

    for (let i = 0; i < ENTRY_SLOTS; i++) {
        const item = tab.entries[i];
        if (item) {
            form.button(label(i === entryIndex ? "§e" : "§f", `ws.hb.e.${item.id}.name`), item.icon);
        } else {
            form.button("");
        }
    }

    if (SEND_RECIPE) {
        for (let i = 0; i < GRID_SLOTS; i++) {
            const cell = entry.grid?.[i];
            if (cell) form.button("", cell);
            else form.button("");
        }
        form.button("", entry.result ?? undefined);
    }

    // Navigating makes no sound of its own - the buttons already click. The page
    // turn is kept for opening the book, where it happens once and fits.
    form.show(player).then((res) => {
        if (res.canceled) return;
        const picked = res.selection;

        if (picked < TABS.length) {
            openWizardHandbook(player, picked, picked === tabIndex ? entryIndex : 0);
            return;
        }
        if (picked === CLOSE_INDEX) return;

        const chosen = picked - ENTRY_BASE;
        if (chosen >= 0 && chosen < tab.entries.length) {
            openWizardHandbook(player, tabIndex, chosen);
        }
    });
}

world.afterEvents.itemUse.subscribe((event) => {
    const item = event.itemStack;
    if (item && item.typeId === "ws:wizard_handbook") {
        system.run(() => {
            event.source.playSound("item.book.page_turn", { pitch: 1.0, volume: 0.8 });
            openWizardHandbook(event.source);
        });
    }
});
