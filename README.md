# Wand & Spells

A data-driven magic add-on for Minecraft Bedrock Edition featuring 67 spells across 7 elements.

## Features

- **67 spells** across 7 elemental schools
- **219 items** including wands, reagents, and magical equipment
- **13 custom blocks** (Arcane Workbench, Imbuement Altar, Runestone Pedestal, etc.)
- **16 entities** (wizards, projectiles, summons)
- **79 recipes** and **78 loot tables**
- **16 custom particles** and **68 sound effects**
- **Custom JSON UI** (HUD elements + server forms)
- **21 script files** (~7,800 lines of JavaScript)

## Technical Details

- **Engine:** Bedrock 1.21.60+
- **Script API:** `@minecraft/server` 1.19.0, `@minecraft/server-ui` 1.3.0
- **Architecture:** Data-driven spell system — spells are defined as data and processed by a central spell caster engine

## Structure

```
wand_and_spells_bp/    # Behavior Pack
  scripts/             # Script API (main.js, spell_caster.js, etc.)
  blocks/              # Custom blocks
  entities/            # Entity definitions
  items/               # Item definitions
  recipes/             # Crafting recipes
  loot_tables/         # Loot tables

wand_and_spells_rp/    # Resource Pack
  textures/            # Item, block, and entity textures
  models/              # Geometry models
  particles/           # Custom particles
  sounds/              # Sound effects
  animation_controllers/
  animations/
  attachables/         # 3D armor and wearables
```
