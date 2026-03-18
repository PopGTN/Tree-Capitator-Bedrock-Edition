# Tree Capitator — Bedrock Edition

A Minecraft Bedrock script addon that fells entire trees when you break a single log with an axe. Supports all vanilla wood types, nether stems, and custom addon trees.

**By PopGTN**

---

## Features

- **Whole-tree felling** — break one log, the whole tree comes down
- **Progressive chopping** — breaks layer by layer from bottom to top for a natural falling effect
- **Instant leaf clearing** — leaves clear instantly when the last log layer breaks, matching vanilla leaf decay behaviour
- **Custom tree support** — diagonal and branching custom addon trees fully detected via 26-direction BFS
- **Build protection** — trunk shape check prevents log cabins and structures from being accidentally felled
- **Unbreaking support** — axe durability consumed per block with correct Unbreaking enchantment probability
- **Per-player config** — each player has independent settings via a config book
- **Mobile friendly** — sound and particle effects can be disabled individually to reduce lag

---

## Config Book

Every player receives a config book on first join. Right-click it to open the settings form.

| Toggle | Default | Description |
|--------|---------|-------------|
| Break Leaves | On | Break connected leaves alongside logs |
| Progressive Chopping | On | Layer-by-layer break animation |
| Works with Custom Axes | On | Allow non-vanilla axes to trigger capitator |
| Disable When Sneaking | Off | When on, capitator works even while sneaking |
| Chopping Sound | On | Play axe sound per log broken |
| Chopping Particles | On | Spawn particles per log broken — disable on mobile if laggy |

---

## Toggle On / Off

Sneak + right-click with any axe to toggle the capitator on or off. Current status shows on the action bar.

---

## Adding Custom Tree Blocks

Open `scripts/index.js` and add your block IDs to the two lists at the top of the file:

```js
export const AXE_COMMON_BREAKABLE_BLOCKS = [
  // ... existing blocks ...
  'yourAddon:custom_log',
  'yourAddon:custom_wood',
];

export const AXE_COMMON_BREAKABLE_BLOCKS_WITH_LEAVES = [
  ...AXE_COMMON_BREAKABLE_BLOCKS,
  // ... existing leaves ...
  'yourAddon:custom_leaves',
];
```

Block IDs follow the format `namespace:block_name`. You can find them in the addon's behavior pack `blocks/` folder or by using `/give @s yourAddon:` and tab-completing in-game.

---

## Requirements

- Minecraft Bedrock Edition v26.x (engine `1.21.60`)
- `@minecraft/server` `1.17.0` stable
- `@minecraft/server-ui` `1.3.0` stable
- Beta APIs **not required**

---

## Installation

1. Copy the `behavior_pack/` folder into your world's behavior packs
2. Activate the pack on your world
3. Join — the config book will be given automatically

---

## File Structure

```
behavior_pack/
├── manifest.json
├── pack_icon.png
├── items/
│   └── book_config.json
└── scripts/
    └── index.js
```

---

## Credits

Original concept, feature design, config book pattern, and core toggle system by **SystemTv** (Twitter: [@SystemTv_](https://twitter.com/SystemTv_)).

Rewritten and extended by **PopGTN**:
- Full architecture rewrite
- Unified BFS tree detection with leaf support
- Dynamic property config system
- Concurrency guard and toggle debounce
- Build protection
- Durability system with Unbreaking support
- Mobile optimisation (sound/particle toggles)
- Expanded block list

---

## License

This project is provided as-is for personal and server use. If you redistribute or build on this, please credit both SystemTv for the original concept and PopGTN for this implementation.
