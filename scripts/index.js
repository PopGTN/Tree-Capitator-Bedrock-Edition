/*
 * ================================================================
 *  Tree Capitator — Bedrock Edition Script Addon
 *  By PopGTN
 * ================================================================
 *
 *  Original concept and feature design by SystemTv (Twitter: @SystemTv_)
 *  Core concept, config book pattern, toggleCompat utility, addItem
 *  helper, and original 4 toggle features are based on their work.
 *
 *  Rewritten and extended by PopGTN:
 *    - Full architecture rewrite (dynamic properties, concurrency
 *      guard, toggle debounce, integer hash BFS)
 *    - Unified single-pass BFS for logs + leaves
 *    - Two-phase layer-progressive break with instant leaf clearing
 *    - Build protection via trunk shape analysis
 *    - Unbreaking-aware durability system
 *    - Sound and particle controls (mobile optimisation)
 *    - Expanded block list (wood variants, nether hyphae, custom)
 *
 * ================================================================
 */

import {
 world,
 EquipmentSlot,
 EntityEquippableComponent,
 system,
 ItemStack
} from '@minecraft/server';
import { ModalFormData } from "@minecraft/server-ui";

/* ------------------------------------------------ */
/* BLOCK LISTS                                      */
/* ------------------------------------------------ */

export const AXE_COMMON_BREAKABLE_BLOCKS = [
  // --- Standard Logs ---
  'minecraft:oak_log', 'minecraft:spruce_log', 'minecraft:birch_log',
  'minecraft:jungle_log', 'minecraft:acacia_log', 'minecraft:dark_oak_log',
  'minecraft:cherry_log', 'minecraft:mangrove_log', 'minecraft:pale_oak_log',

  // --- Stripped Logs ---
  'minecraft:stripped_oak_log', 'minecraft:stripped_spruce_log', 'minecraft:stripped_birch_log',
  'minecraft:stripped_jungle_log', 'minecraft:stripped_acacia_log', 'minecraft:stripped_dark_oak_log',
  'minecraft:stripped_cherry_log', 'minecraft:stripped_mangrove_log', 'minecraft:stripped_pale_oak_log',

  // --- Wood (6-Sided Bark Blocks) ---
  'minecraft:oak_wood', 'minecraft:spruce_wood', 'minecraft:birch_wood',
  'minecraft:jungle_wood', 'minecraft:acacia_wood', 'minecraft:dark_oak_wood',
  'minecraft:cherry_wood', 'minecraft:mangrove_wood', 'minecraft:pale_oak_wood',

  // --- Stripped Wood ---
  'minecraft:stripped_oak_wood', 'minecraft:stripped_spruce_wood', 'minecraft:stripped_birch_wood',
  'minecraft:stripped_jungle_wood', 'minecraft:stripped_acacia_wood', 'minecraft:stripped_dark_oak_wood',
  'minecraft:stripped_cherry_wood', 'minecraft:stripped_mangrove_wood', 'minecraft:stripped_pale_oak_wood',

  // --- Nether Stems & Hyphae ---
  'minecraft:crimson_stem', 'minecraft:warped_stem',
  'minecraft:stripped_crimson_stem', 'minecraft:stripped_warped_stem',
  'minecraft:crimson_hyphae', 'minecraft:warped_hyphae',
  'minecraft:stripped_crimson_hyphae', 'minecraft:stripped_warped_hyphae',

  // --- Miscellaneous ---
  'minecraft:stripped_bamboo_block',

  // --- Custom Blocks ---
  'ff:maple_log',
  'ff:stripped_maple_log',
  'ff:maple_wood',
  'ff:stripped_maple_wood'
];

export const AXE_COMMON_BREAKABLE_BLOCKS_WITH_LEAVES = [
  ...AXE_COMMON_BREAKABLE_BLOCKS,

  // --- Leaves ---
  'minecraft:oak_leaves', 'minecraft:spruce_leaves', 'minecraft:birch_leaves',
  'minecraft:jungle_leaves', 'minecraft:acacia_leaves', 'minecraft:dark_oak_leaves',
  'minecraft:cherry_leaves', 'minecraft:mangrove_leaves', 'minecraft:pale_oak_leaves',
  'minecraft:azalea_leaves', 'minecraft:azalea_leaves_flowered',

  // --- Roots ---
  'minecraft:mangrove_roots',

  // --- Custom Leaves ---
  'ff:red_maple_leaves',
  'ff:orange_maple_leaves',
  'ff:yellow_maple_leaves'
];

// Sets must be defined immediately after the arrays — referenced throughout
const LOG_SET  = new Set(AXE_COMMON_BREAKABLE_BLOCKS);
const FULL_SET = new Set(AXE_COMMON_BREAKABLE_BLOCKS_WITH_LEAVES);

/* ------------------------------------------------ */
/* DYNAMIC PROPERTY KEYS                            */
/*                                                  */
/*   breakLeaves      true  = break leaves          */
/*   progressiveChop  true  = progressive mode      */
/*   customAxes       true  = allow custom axes     */
/*   disableSneak     false = sneak required        */
/*   capitatorOff     false = capitator active      */
/*   gotBook          false = book not yet given    */
/* ------------------------------------------------ */

const PROP = {
 breakLeaves:     "stv:breakLeaves",
 progressiveChop: "stv:progressiveChop",
 customAxes:      "stv:customAxes",
 disableSneak:    "stv:disableSneak",
 capitatorOff:    "stv:capitatorOff",
 gotBook:         "stv:gotBook",
 sound:           "stv:sound",
 particles:       "stv:particles",
 groveMode:       "stv:groveMode",   // true = preserve nearby tree leaves
 buildSafety:     "stv:buildSafety"  // true = abort if built log within 5 blocks
};

function getProp(entity, key, defaultVal) {
 try {
  const v = entity.getDynamicProperty(key);
  return v === undefined ? defaultVal : !!v;
 } catch {
  return defaultVal;
 }
}

function setProp(entity, key, value) {
 try {
  entity.setDynamicProperty(key, value);
 } catch {}
}

/* ------------------------------------------------ */
/* CONCURRENCY GUARD                                */
/* ------------------------------------------------ */

const choppingPlayers = new Set();

function acquireLock(player, maxLayers, breakDelayMs) {
 if (choppingPlayers.has(player.id)) return false;
 choppingPlayers.add(player.id);
 const safetyTicks = Math.ceil((maxLayers * breakDelayMs) / 50) + 40;
 system.runTimeout(() => choppingPlayers.delete(player.id), safetyTicks);
 return true;
}

function releaseLock(player) {
 choppingPlayers.delete(player.id);
}

/* ------------------------------------------------ */
/* TOGGLE DEBOUNCE                                  */
/* ------------------------------------------------ */

const lastToggleTick = new Map();

function handleToggle(player, typeId) {
 if (!typeId.includes("_axe")) return;
 if (!player.isSneaking) return;

 const tick = system.currentTick;
 if (lastToggleTick.get(player.id) === tick) return;
 lastToggleTick.set(player.id, tick);

 const current = getProp(player, PROP.capitatorOff, false);
 setProp(player, PROP.capitatorOff, !current);
 showToggleStatus(player);
}

/* ------------------------------------------------ */
/* CONFIG FORM                                      */
/* ------------------------------------------------ */

const FIELDS = [
 { label: "§b» Break Leaves «",           prop: PROP.breakLeaves,     def: true  },
 { label: "§b» Progressive Chopping «",   prop: PROP.progressiveChop, def: true  },
 { label: "§b» Works with Custom Axes «", prop: PROP.customAxes,      def: true  },
 { label: "§b» Disable When Sneaking «",  prop: PROP.disableSneak,    def: false },
 { label: "§b» Chopping Sound «",         prop: PROP.sound,           def: true  },
 { label: "§b» Chopping Particles «",     prop: PROP.particles,       def: true  },
 { label: "§b» Preserve Nearby Tree Leaves «", prop: PROP.groveMode,   def: true  },
 { label: "§b» Protect Nearby Log Builds «",   prop: PROP.buildSafety, def: true  }
];

function toggleCompat(form, label, def) {
 try {
  return form.toggle(label, { defaultValue: def });
 } catch {
  return form.toggle(label, def);
 }
}

export function functionConfig(p) {
 const form = new ModalFormData().title("§l§3[ §bTree Capitator §3]");

 for (const f of FIELDS) {
  toggleCompat(form, f.label, getProp(p, f.prop, f.def));
 }

 form.show(p).then(res => {
  if (res.canceled || !Array.isArray(res.formValues)) return;
  if (res.formValues.length !== FIELDS.length) {
   p.sendMessage("§c(Form mismatch) Values do not match fields.");
   return;
  }
  for (let i = 0; i < FIELDS.length; i++) {
   setProp(p, FIELDS[i].prop, !!res.formValues[i]);
  }
  p.sendMessage({ rawtext: [{ text: "§l§2-Saved configuration" }] });
 });
}

/* ------------------------------------------------ */
/* GIVE CONFIG ITEM                                 */
/* ------------------------------------------------ */

export function addItem(player, itemId, keepOnDeath, lockMode, lore) {
 const container = player.getComponent("inventory").container;
 const item = new ItemStack(itemId);
 item.keepOnDeath = keepOnDeath;
 item.lockMode    = lockMode;
 item.setLore(lore);
 container.addItem(item);
}

/* ------------------------------------------------ */
/* TOGGLE DISPLAY                                   */
/* ------------------------------------------------ */

function showToggleStatus(player) {
 if (getProp(player, PROP.capitatorOff, false)) {
  player.onScreenDisplay.setActionBar("§7Tree Capitator: §cOff");
 } else {
  player.onScreenDisplay.setActionBar("§7Tree Capitator: §aOn");
 }
}

/* ------------------------------------------------ */
/* TOGGLE EVENTS                                    */
/* ------------------------------------------------ */

world.afterEvents.itemUse.subscribe(ev => {
 const p    = ev.source;
 const item = ev.itemStack;
 if (!item) return;

 if (item.typeId.includes("stv:")) {
  functionConfig(p);
  return;
 }

 handleToggle(p, item.typeId);
});

world.afterEvents.itemUseOn.subscribe(ev => {
 const p    = ev.source;
 const item = ev.itemStack;
 if (!item) return;

 handleToggle(p, item.typeId);
});

/* ------------------------------------------------ */
/* AXE NOTIFICATION — runs every 10 ticks           */
/* Only acts on item change so idle cost ~zero      */
/* ------------------------------------------------ */

const playerLastAxe = new Map();

system.runInterval(() => {
 for (const p of world.getPlayers()) {
  try {
   const equip  = p.getComponent(EntityEquippableComponent.componentId);
   const item   = equip?.getEquipment(EquipmentSlot.Mainhand);
   const typeId = item?.typeId ?? "";
   const last   = playerLastAxe.get(p.id);

   if (typeId === last) continue;
   playerLastAxe.set(p.id, typeId);

   if (typeId.includes("_axe")) {
    if (last === undefined || !last.includes("_axe")) {
     p.onScreenDisplay.setActionBar("§7--Sneak + Interact to activate/deactivate--");
    } else {
     showToggleStatus(p);
    }
   }
  } catch {}
 }
}, 10);

/* ------------------------------------------------ */
/* BUILD PROTECTION                                 */
/*                                                  */
/* isNaturalTree — leaves present = natural tree,  */
/* always proceed. No leaves = check if any base   */
/* log has ARTIFICIAL_GROUND (stone, planks etc)   */
/* below it. If yes, player build → abort.         */
/* Natural ground (grass/dirt) = stump → proceed.  */
/*                                                  */
/* hasBuildLog — scans ±5 blocks for same-type log  */
/* with artificial ground below. Skips when grove  */
/* mode detects nearby natural trees.              */
/* ------------------------------------------------ */

// Player-built material only.
// Excludes all naturally generating blocks so trees in the wild
// are never falsely blocked.
const ARTIFICIAL_GROUND = new Set([
 // Cobblestone — natural stone becomes cobble only when mined/placed
 'minecraft:cobblestone','minecraft:cobbled_deepslate','minecraft:mossy_cobblestone',
 // Planks — all wood types
 'minecraft:oak_planks','minecraft:spruce_planks','minecraft:birch_planks',
 'minecraft:jungle_planks','minecraft:acacia_planks','minecraft:dark_oak_planks',
 'minecraft:mangrove_planks','minecraft:cherry_planks','minecraft:bamboo_planks',
 'minecraft:pale_oak_planks','minecraft:crimson_planks','minecraft:warped_planks',
 // Wooden slabs
 'minecraft:oak_slab','minecraft:spruce_slab','minecraft:birch_slab',
 'minecraft:jungle_slab','minecraft:acacia_slab','minecraft:dark_oak_slab',
 'minecraft:mangrove_slab','minecraft:cherry_slab','minecraft:bamboo_slab',
 'minecraft:pale_oak_slab','minecraft:crimson_slab','minecraft:warped_slab',
 'minecraft:bamboo_mosaic_slab',
 // Stone slabs
 'minecraft:stone_slab','minecraft:cobblestone_slab','minecraft:smooth_stone_slab',
 'minecraft:stone_brick_slab','minecraft:mossy_stone_brick_slab',
 'minecraft:polished_deepslate_slab','minecraft:cobbled_deepslate_slab',
 'minecraft:brick_slab','minecraft:sandstone_slab','minecraft:red_sandstone_slab',
 'minecraft:nether_brick_slab','minecraft:quartz_slab','minecraft:purpur_slab',
 // Wooden stairs
 'minecraft:oak_stairs','minecraft:spruce_stairs','minecraft:birch_stairs',
 'minecraft:jungle_stairs','minecraft:acacia_stairs','minecraft:dark_oak_stairs',
 'minecraft:mangrove_stairs','minecraft:cherry_stairs','minecraft:bamboo_stairs',
 'minecraft:pale_oak_stairs','minecraft:crimson_stairs','minecraft:warped_stairs',
 'minecraft:bamboo_mosaic_stairs',
 // Stone stairs
 'minecraft:stone_stairs','minecraft:cobblestone_stairs','minecraft:stone_brick_stairs',
 'minecraft:mossy_stone_brick_stairs','minecraft:brick_stairs','minecraft:sandstone_stairs',
 'minecraft:nether_brick_stairs','minecraft:quartz_stairs','minecraft:purpur_stairs',
 'minecraft:polished_deepslate_stairs','minecraft:cobbled_deepslate_stairs',
 // Bricks
 'minecraft:bricks','minecraft:stone_bricks','minecraft:mossy_stone_bricks',
 'minecraft:cracked_stone_bricks','minecraft:chiseled_stone_bricks',
 'minecraft:nether_bricks','minecraft:red_nether_bricks','minecraft:chiseled_nether_bricks',
 // Polished/smooth variants — only exist when crafted
 'minecraft:polished_deepslate','minecraft:polished_blackstone','minecraft:polished_basalt',
 'minecraft:polished_granite','minecraft:polished_diorite','minecraft:polished_andesite',
 'minecraft:smooth_stone','minecraft:smooth_sandstone','minecraft:smooth_red_sandstone',
 'minecraft:smooth_quartz','minecraft:smooth_basalt',
 // Quartz and purpur — clearly player-crafted
 'minecraft:quartz_block','minecraft:chiseled_quartz_block','minecraft:quartz_pillar',
 'minecraft:purpur_block','minecraft:purpur_pillar',
 // Concrete and concrete powder
 'minecraft:concrete','minecraft:concrete_powder',
 // Terracotta — plain and glazed
 'minecraft:terracotta','minecraft:glazed_terracotta',
 'minecraft:white_terracotta','minecraft:orange_terracotta','minecraft:magenta_terracotta',
 'minecraft:light_blue_terracotta','minecraft:yellow_terracotta','minecraft:lime_terracotta',
 'minecraft:pink_terracotta','minecraft:gray_terracotta','minecraft:light_gray_terracotta',
 'minecraft:cyan_terracotta','minecraft:purple_terracotta','minecraft:blue_terracotta',
 'minecraft:brown_terracotta','minecraft:green_terracotta','minecraft:red_terracotta',
 'minecraft:black_terracotta',
 // Glass
 'minecraft:glass','minecraft:glass_pane',
 'minecraft:white_stained_glass','minecraft:orange_stained_glass','minecraft:magenta_stained_glass',
 'minecraft:light_blue_stained_glass','minecraft:yellow_stained_glass','minecraft:lime_stained_glass',
 'minecraft:pink_stained_glass','minecraft:gray_stained_glass','minecraft:light_gray_stained_glass',
 'minecraft:cyan_stained_glass','minecraft:purple_stained_glass','minecraft:blue_stained_glass',
 'minecraft:brown_stained_glass','minecraft:green_stained_glass','minecraft:red_stained_glass',
 'minecraft:black_stained_glass',
 'minecraft:white_stained_glass_pane','minecraft:orange_stained_glass_pane',
 // Fences and fence gates
 'minecraft:oak_fence','minecraft:spruce_fence','minecraft:birch_fence',
 'minecraft:jungle_fence','minecraft:acacia_fence','minecraft:dark_oak_fence',
 'minecraft:mangrove_fence','minecraft:cherry_fence','minecraft:pale_oak_fence',
 'minecraft:crimson_fence','minecraft:warped_fence',
 'minecraft:oak_fence_gate','minecraft:spruce_fence_gate','minecraft:birch_fence_gate',
 'minecraft:jungle_fence_gate','minecraft:acacia_fence_gate','minecraft:dark_oak_fence_gate',
 'minecraft:mangrove_fence_gate','minecraft:cherry_fence_gate','minecraft:pale_oak_fence_gate',
 'minecraft:crimson_fence_gate','minecraft:warped_fence_gate',
 // Walls
 'minecraft:cobblestone_wall','minecraft:mossy_cobblestone_wall','minecraft:stone_brick_wall',
 'minecraft:mossy_stone_brick_wall','minecraft:brick_wall','minecraft:nether_brick_wall',
 'minecraft:deepslate_brick_wall','minecraft:cobbled_deepslate_wall','minecraft:polished_deepslate_wall',
 // Doors and trapdoors — player-placed only
 'minecraft:oak_door','minecraft:spruce_door','minecraft:birch_door',
 'minecraft:jungle_door','minecraft:acacia_door','minecraft:dark_oak_door',
 'minecraft:mangrove_door','minecraft:cherry_door','minecraft:pale_oak_door',
 'minecraft:crimson_door','minecraft:warped_door','minecraft:iron_door',
 'minecraft:oak_trapdoor','minecraft:spruce_trapdoor','minecraft:birch_trapdoor',
 'minecraft:jungle_trapdoor','minecraft:acacia_trapdoor','minecraft:dark_oak_trapdoor',
 'minecraft:mangrove_trapdoor','minecraft:cherry_trapdoor','minecraft:pale_oak_trapdoor',
 'minecraft:crimson_trapdoor','minecraft:warped_trapdoor','minecraft:iron_trapdoor',
 // Cut stone variants
 'minecraft:cut_sandstone','minecraft:chiseled_sandstone',
 'minecraft:cut_red_sandstone','minecraft:chiseled_red_sandstone',
 'minecraft:chiseled_deepslate','minecraft:chiseled_polished_blackstone',
 // Wool — dyed = player placed
 'minecraft:white_wool','minecraft:orange_wool','minecraft:magenta_wool',
 'minecraft:light_blue_wool','minecraft:yellow_wool','minecraft:lime_wool',
 'minecraft:pink_wool','minecraft:gray_wool','minecraft:light_gray_wool',
 'minecraft:cyan_wool','minecraft:purple_wool','minecraft:blue_wool',
 'minecraft:brown_wool','minecraft:green_wool','minecraft:red_wool','minecraft:black_wool',
 // Carpet
 'minecraft:white_carpet','minecraft:orange_carpet','minecraft:magenta_carpet',
 'minecraft:light_blue_carpet','minecraft:yellow_carpet','minecraft:lime_carpet',
 'minecraft:pink_carpet','minecraft:gray_carpet','minecraft:light_gray_carpet',
 'minecraft:cyan_carpet','minecraft:purple_carpet','minecraft:blue_carpet',
 'minecraft:brown_carpet','minecraft:green_carpet','minecraft:red_carpet','minecraft:black_carpet',
 // Functional blocks
 'minecraft:crafting_table','minecraft:furnace','minecraft:chest','minecraft:trapped_chest',
 'minecraft:ender_chest','minecraft:barrel','minecraft:bookshelf',
 'minecraft:enchanting_table','minecraft:anvil','minecraft:grindstone',
 'minecraft:smithing_table','minecraft:stonecutter','minecraft:loom','minecraft:cartography_table',
 'minecraft:fletching_table','minecraft:blast_furnace','minecraft:smoker',
 'minecraft:iron_bars','minecraft:iron_block','minecraft:gold_block',
 'minecraft:diamond_block','minecraft:emerald_block','minecraft:netherite_block',
]);

// Horizontal radius — catches adjacent build blocks
// Vertical: check more below (floor slabs) than above
const BUILD_HORIZ_RADIUS = 3;
const BUILD_DOWN_RADIUS  = 4; // floors sit below support beams
const BUILD_UP_RADIUS    = 2; // ceilings are less common above logs

function hasBuildLog(block, dim) {
 const loc = block.location;

 for (let ox = -BUILD_HORIZ_RADIUS; ox <= BUILD_HORIZ_RADIUS; ox++) {
  for (let oz = -BUILD_HORIZ_RADIUS; oz <= BUILD_HORIZ_RADIUS; oz++) {
   for (let oy = -BUILD_DOWN_RADIUS; oy <= BUILD_UP_RADIUS; oy++) {
    try {
     const b = dim.getBlock({ x: loc.x+ox, y: loc.y+oy, z: loc.z+oz });
     if (b && ARTIFICIAL_GROUND.has(b.typeId)) return true;
    } catch {}
   }
  }
 }
 return false;
}

// Check for a same-type log within GROVE_CHECK_RADIUS that is NOT
// part of this tree's BFS result. If found, this tree is in a grove.
const GROVE_CHECK_RADIUS = 8;

function hasSameTypeLogNearby(centerBlock, thisLogs, dim) {
 const loc      = centerBlock.location;
 const logType  = centerBlock.typeId;
 const thisSet  = new Set(thisLogs.map(l => `${l.x},${l.y},${l.z}`));
 // Get allowed leaf types for this log so we can verify it's a live tree
 const leafTypes = LOG_TO_LEAVES.get(logType);

 for (let ox = -GROVE_CHECK_RADIUS; ox <= GROVE_CHECK_RADIUS; ox++) {
  for (let oz = -GROVE_CHECK_RADIUS; oz <= GROVE_CHECK_RADIUS; oz++) {
   if (Math.abs(ox) <= 1 && Math.abs(oz) <= 1) continue;
   for (let oy = -4; oy <= 4; oy++) {
    const x = loc.x + ox;
    const y = loc.y + oy;
    const z = loc.z + oz;
    if (thisSet.has(`${x},${y},${z}`)) continue;
    try {
     const b = dim.getBlock({ x, y, z });
     if (!b || b.typeId !== logType) continue;

     // Only count this as a grove tree if it has leaves nearby —
     // a bare stump (old chopped tree) should not block leaf breaking
     let hasLeaves = false;
     if (leafTypes) {
      outer: for (let lx = -4; lx <= 4; lx++) {
       for (let ly = -4; ly <= 4; ly++) {
        for (let lz = -4; lz <= 4; lz++) {
         try {
          const lb = dim.getBlock({ x: x+lx, y: y+ly, z: z+lz });
          if (lb && leafTypes.has(lb.typeId)) { hasLeaves = true; break outer; }
         } catch {}
        }
       }
      }
     } else {
      hasLeaves = true; // unknown log type — assume live tree to be safe
     }

     if (hasLeaves) return true;
    } catch {}
   }
  }
 }
 return false;
}

// Check if there is another same-type log within a radius around
// the broken block's base that is NOT part of this tree.
function isNaturalTree(logs, leaves, dim) {
 if (logs.length === 0) return false;

 // Leaves present = definitely a natural tree or grove — always proceed
 if (leaves.length > 0) return true;

 // No leaves found (stump, stripped tree, or player build).
 // Only abort if a base log sits on ARTIFICIAL ground (planks, stone etc).
 // Natural ground (grass, dirt) = stump of a real tree = allow through.
 const minY       = logs.reduce((m, l) => l.y < m ? l.y : m, logs[0].y);
 const bottomLogs = logs.filter(l => l.y === minY);

 for (const log of bottomLogs) {
  try {
   const below = dim.getBlock({ x: log.x, y: log.y - 1, z: log.z });
   if (below && ARTIFICIAL_GROUND.has(below.typeId)) return false;
  } catch {}
 }

 return true;
}

/* ------------------------------------------------ */
/* DURABILITY                                       */
/* ------------------------------------------------ */

function applyDurability(player, blocksDestroyed) {
 try {
  const equip = player.getComponent(EntityEquippableComponent.componentId);
  const item  = equip?.getEquipment(EquipmentSlot.Mainhand);
  if (!item) return;

  const durComp = item.getComponent("minecraft:durability");
  if (!durComp) return;

  const enchants   = item.getComponent("minecraft:enchantable");
  const unbreaking = enchants?.getEnchantment("unbreaking");
  const level      = unbreaking?.level ?? 0;

  let damage = 0;
  for (let i = 1; i < blocksDestroyed; i++) {
   if (level === 0 || Math.random() < 1 / (level + 1)) damage++;
  }

  if (damage <= 0) return;

  const newDamage = Math.min(durComp.damage + damage, durComp.maxDurability);
  durComp.damage  = newDamage;
  equip.setEquipment(EquipmentSlot.Mainhand, item);

  if (newDamage >= durComp.maxDurability) {
   equip.setEquipment(EquipmentSlot.Mainhand, undefined);
   world.playSound("random.break", player.location, { volume: 1.0 });
  }
 } catch {}
}

/* ------------------------------------------------ */
/* TREE BREAK TRIGGER                               */
/* ------------------------------------------------ */

world.beforeEvents.playerBreakBlock.subscribe(({ block, player }) => {
 try {
  const equip  = player.getComponent(EntityEquippableComponent.componentId);
  const tool   = equip?.getEquipment(EquipmentSlot.Mainhand);
  const typeId = tool?.typeId ?? "";

  const sneakVerify =
   getProp(player, PROP.disableSneak, false)
   ? true
   : !player.isSneaking;

  const customAxeVerify =
   getProp(player, PROP.customAxes, true)
   ? typeId.includes("_axe")
   : (typeId.startsWith("minecraft:") && typeId.includes("_axe"));

  if (!customAxeVerify || !sneakVerify) return;
  if (getProp(player, PROP.capitatorOff, false)) return;

  // Only trigger on logs — never on leaves
  // If we triggered on a leaf in a shared canopy we'd find both trees
  if (!LOG_SET.has(block.typeId)) return;

  const breakLeaves = getProp(player, PROP.breakLeaves, true);
  const groveMode   = getProp(player, PROP.groveMode, true);

  // BFS with same radius as the grove scan so ALL of this tree's logs
  // are excluded from hasSameTypeLogNearby — otherwise far branches
  // look like a neighbouring tree and nearbyGrove is always true.
  const thisLogs    = findTreeBlocks(block, { maxHoriz: GROVE_CHECK_RADIUS, maxUp: 24, maxDown: 3 });
  const nearbyGrove = groveMode && hasSameTypeLogNearby(block, thisLogs, block.dimension);

  // Build safety — always runs independently of grove mode
  // A tree next to cobblestone should be protected regardless of
  // whether other trees are nearby
  if (getProp(player, PROP.buildSafety, true)) {
   if (hasBuildLog(block, block.dimension)) return;
  }

  breakEntireTreeProgressive(block, player, breakLeaves, nearbyGrove, {
   breakDelayMs:    getProp(player, PROP.progressiveChop, true) ? 7 : 1,
   maxHoriz:        8,
   maxUp:           24,
   maxDown:         3,
   perBlockDelayMs: 0,
   maxBlocks:       2000
  });

 } catch {}
});

/* ------------------------------------------------ */
/* PROGRESSIVE BREAK                                */
/* ------------------------------------------------ */

export function breakEntireTreeProgressive(centerBlock, player, breakLeaves, nearbyGrove, {
 breakDelayMs    = 5,
 perBlockDelayMs = 0,
 maxHoriz        = 8,
 maxUp           = 24,
 maxDown         = 3,
 maxBlocks       = 2000
} = {}) {

 const dim = centerBlock.dimension;

 // BFS with tight radius — only finds THIS tree's connected logs.
 const logs = findTreeBlocks(centerBlock, {
  maxHoriz: 4, maxUp, maxDown, maxBlocks
 });

 if (logs.length === 0) return;

 // Use nearbyGrove passed from trigger — avoids scanning twice
 const isGrove = nearbyGrove;

 const logsToBreak = logs; // always break this tree's logs

 // Leaves — scan around this tree's logs only
 const leaves = breakLeaves
  ? findLeavesAroundLogs(logsToBreak, centerBlock, dim)
  : [];

 if (!isNaturalTree(logs, leaves, dim)) return;

 // Grove: nearby same-type tree exists → skip leaves so they stay
 // Last/only tree: break leaves normally
 const shouldBreakLeaves = breakLeaves && !isGrove;

 const ys = [...new Set(logsToBreak.map(l => l.y))].sort((a, b) => a - b);

 if (!acquireLock(player, ys.length, breakDelayMs)) return;

 const layers      = new Map();
 const totalBreaks = logsToBreak.length;

 for (const loc of logsToBreak) {
  if (!layers.has(loc.y)) layers.set(loc.y, []);
  layers.get(loc.y).push(loc);
 }

 ys.forEach((y, layerIndex) => {
  system.runTimeout(() => {

   const layer        = layers.get(y);
   const playSound    = getProp(player, PROP.sound,     true);
   const playParticle = getProp(player, PROP.particles, true);

   if (perBlockDelayMs > 0) {
    layer.forEach((loc, i) =>
     system.runTimeout(() => breakIfWood(player, dim, loc, LOG_SET, playSound, playParticle), i * perBlockDelayMs)
    );
   } else {
    for (const loc of layer)
     breakIfWood(player, dim, loc, LOG_SET, playSound, playParticle);
   }

   if (layerIndex === ys.length - 1) {
    if (shouldBreakLeaves) {
     for (const loc of leaves)
      breakLeafBlock(player, dim, loc);
    }
    applyDurability(player, totalBreaks);
    releaseLock(player);
   }

  }, layerIndex * breakDelayMs);
 });
}

/* ------------------------------------------------ */
/* BREAK BLOCK                                      */
/* ------------------------------------------------ */

function breakIfWood(player, dimension, loc, breakSet, playSound = true, playParticle = true) {
 try {
  const b = dimension.getBlock(loc);
  if (!b || !breakSet.has(b.typeId)) return;

  if (playSound)
   world.playSound("random.axe", loc, { volume: 1.0, pitch: 0.9 });

  if (playParticle)
   player.runCommand(`particle minecraft:water_evaporation_manual ${loc.x} ${loc.y} ${loc.z}`);

  dimension.runCommand(`setblock ${loc.x} ${loc.y} ${loc.z} air destroy`);
 } catch {}
}

// Leaves break silently — no sound or particles (matches vanilla behaviour)
function breakLeafBlock(player, dimension, loc) {
 try {
  const b = dimension.getBlock(loc);
  if (!b || !FULL_SET.has(b.typeId)) return;

  // Leaves are intentionally silent — no axe sound, no particles
  // Playing sound/particles on 200 leaves simultaneously causes lag spikes
  dimension.runCommand(`setblock ${loc.x} ${loc.y} ${loc.z} air destroy`);
 } catch {}
}

/* ------------------------------------------------ */
/* TREE DETECTION                                   */
/*                                                  */
/* findTreeBlocks — log-only BFS, maxHoriz=4        */
/*   Tight radius keeps separate nearby trees out.  */
/*                                                  */
/* findLeavesAroundLogs — ±4 radius scan            */
/*   Around only the broken trunk's logs.           */
/*   LOG_TO_LEAVES map filters by matching leaf     */
/*   type so neighbouring trees' leaves are never   */
/*   collected.                                     */
/* ------------------------------------------------ */

// Maps each log type to its valid leaf types
// Used in phase 2 to avoid picking up wrong-tree leaves
const LOG_TO_LEAVES = new Map([
 ['minecraft:oak_log',                 new Set(['minecraft:oak_leaves','minecraft:azalea_leaves','minecraft:azalea_leaves_flowered'])],
 ['minecraft:stripped_oak_log',        new Set(['minecraft:oak_leaves','minecraft:azalea_leaves','minecraft:azalea_leaves_flowered'])],
 ['minecraft:oak_wood',                new Set(['minecraft:oak_leaves','minecraft:azalea_leaves','minecraft:azalea_leaves_flowered'])],
 ['minecraft:stripped_oak_wood',       new Set(['minecraft:oak_leaves','minecraft:azalea_leaves','minecraft:azalea_leaves_flowered'])],
 ['minecraft:spruce_log',              new Set(['minecraft:spruce_leaves'])],
 ['minecraft:stripped_spruce_log',     new Set(['minecraft:spruce_leaves'])],
 ['minecraft:spruce_wood',             new Set(['minecraft:spruce_leaves'])],
 ['minecraft:stripped_spruce_wood',    new Set(['minecraft:spruce_leaves'])],
 ['minecraft:birch_log',               new Set(['minecraft:birch_leaves'])],
 ['minecraft:stripped_birch_log',      new Set(['minecraft:birch_leaves'])],
 ['minecraft:birch_wood',              new Set(['minecraft:birch_leaves'])],
 ['minecraft:stripped_birch_wood',     new Set(['minecraft:birch_leaves'])],
 ['minecraft:jungle_log',              new Set(['minecraft:jungle_leaves'])],
 ['minecraft:stripped_jungle_log',     new Set(['minecraft:jungle_leaves'])],
 ['minecraft:jungle_wood',             new Set(['minecraft:jungle_leaves'])],
 ['minecraft:stripped_jungle_wood',    new Set(['minecraft:jungle_leaves'])],
 ['minecraft:acacia_log',              new Set(['minecraft:acacia_leaves'])],
 ['minecraft:stripped_acacia_log',     new Set(['minecraft:acacia_leaves'])],
 ['minecraft:acacia_wood',             new Set(['minecraft:acacia_leaves'])],
 ['minecraft:stripped_acacia_wood',    new Set(['minecraft:acacia_leaves'])],
 ['minecraft:dark_oak_log',            new Set(['minecraft:dark_oak_leaves'])],
 ['minecraft:stripped_dark_oak_log',   new Set(['minecraft:dark_oak_leaves'])],
 ['minecraft:dark_oak_wood',           new Set(['minecraft:dark_oak_leaves'])],
 ['minecraft:stripped_dark_oak_wood',  new Set(['minecraft:dark_oak_leaves'])],
 ['minecraft:cherry_log',              new Set(['minecraft:cherry_leaves'])],
 ['minecraft:stripped_cherry_log',     new Set(['minecraft:cherry_leaves'])],
 ['minecraft:cherry_wood',             new Set(['minecraft:cherry_leaves'])],
 ['minecraft:stripped_cherry_wood',    new Set(['minecraft:cherry_leaves'])],
 ['minecraft:mangrove_log',            new Set(['minecraft:mangrove_leaves','minecraft:mangrove_roots'])],
 ['minecraft:stripped_mangrove_log',   new Set(['minecraft:mangrove_leaves','minecraft:mangrove_roots'])],
 ['minecraft:mangrove_wood',           new Set(['minecraft:mangrove_leaves','minecraft:mangrove_roots'])],
 ['minecraft:stripped_mangrove_wood',  new Set(['minecraft:mangrove_leaves','minecraft:mangrove_roots'])],
 ['minecraft:pale_oak_log',            new Set(['minecraft:pale_oak_leaves'])],
 ['minecraft:stripped_pale_oak_log',   new Set(['minecraft:pale_oak_leaves'])],
 ['minecraft:pale_oak_wood',           new Set(['minecraft:pale_oak_leaves'])],
 ['minecraft:stripped_pale_oak_wood',  new Set(['minecraft:pale_oak_leaves'])],
 ['minecraft:crimson_stem',            new Set(['minecraft:nether_wart_block','minecraft:shroomlight'])],
 ['minecraft:warped_stem',             new Set(['minecraft:warped_wart_block','minecraft:shroomlight'])],
 ['minecraft:stripped_crimson_stem',   new Set(['minecraft:nether_wart_block'])],
 ['minecraft:stripped_warped_stem',    new Set(['minecraft:warped_wart_block'])],
 ['minecraft:crimson_hyphae',          new Set(['minecraft:nether_wart_block'])],
 ['minecraft:warped_hyphae',           new Set(['minecraft:warped_wart_block'])],
 ['minecraft:stripped_crimson_hyphae', new Set(['minecraft:nether_wart_block'])],
 ['minecraft:stripped_warped_hyphae',  new Set(['minecraft:warped_wart_block'])],
 ['ff:maple_log',                      new Set(['ff:red_maple_leaves','ff:orange_maple_leaves','ff:yellow_maple_leaves'])],
 ['ff:stripped_maple_log',             new Set(['ff:red_maple_leaves','ff:orange_maple_leaves','ff:yellow_maple_leaves'])],
 ['ff:maple_wood',                     new Set(['ff:red_maple_leaves','ff:orange_maple_leaves','ff:yellow_maple_leaves'])],
 ['ff:stripped_maple_wood',            new Set(['ff:red_maple_leaves','ff:orange_maple_leaves','ff:yellow_maple_leaves'])],
]);

const LEAF_RADIUS = 4;

function locHash(x, y, z) {
 return ((x + 2048) * 16777216) + ((y + 512) * 4096) + (z + 2048);
}

// Collect leaves within LEAF_RADIUS of a specific set of logs.
// By passing only the trunk's logs (not all grove logs), we ensure
// we only collect leaves that belong to this tree.
function findLeavesAroundLogs(logsToScan, centerBlock, dim) {
 const logType = centerBlock.typeId;
 const allowedLeaves = new Set();
 const leafSet = LOG_TO_LEAVES.get(logType);
 if (leafSet) {
  for (const l of leafSet) allowedLeaves.add(l);
 } else {
  // Block type not in LOG_TO_LEAVES (e.g. oak_wood broken instead of oak_log)
  // Fall back: allow any leaf type in FULL_SET that isn't a log
  for (const id of FULL_SET) {
   if (!LOG_SET.has(id)) allowedLeaves.add(id);
  }
 }
 if (allowedLeaves.size === 0) return [];

 const leaves   = [];
 const leafSeen = new Set();

 for (const log of logsToScan) {
  for (let ox = -LEAF_RADIUS; ox <= LEAF_RADIUS; ox++) {
   for (let oy = -LEAF_RADIUS; oy <= LEAF_RADIUS; oy++) {
    for (let oz = -LEAF_RADIUS; oz <= LEAF_RADIUS; oz++) {
     const lx = log.x + ox;
     const ly = log.y + oy;
     const lz = log.z + oz;
     const k  = locHash(lx, ly, lz);

     if (leafSeen.has(k)) continue;
     leafSeen.add(k);

     try {
      const b = dim.getBlock({ x: lx, y: ly, z: lz });
      if (b && allowedLeaves.has(b.typeId)) {
       leaves.push({ x: lx, y: ly, z: lz });
      }
     } catch {}
    }
   }
  }
 }
 return leaves;
}

// Log-only BFS — finds all connected logs.
// Leaves are collected separately via findLeavesAroundLogs
// so we only scan around the specific trunk being broken.
function findTreeBlocks(startBlock, {
 maxHoriz  = 8,
 maxUp     = 24,
 maxDown   = 3,
 maxBlocks = 2000
} = {}) {

 const start   = startBlock.location;
 const dim     = startBlock.dimension;
 const visited = new Set();
 const logs    = [];
 const stack   = [start];

 while (stack.length) {
  const cur = stack.pop();
  const k   = locHash(cur.x, cur.y, cur.z);

  if (visited.has(k)) continue;
  visited.add(k);

  const dx = cur.x - start.x;
  const dy = cur.y - start.y;
  const dz = cur.z - start.z;

  if (Math.abs(dx) > maxHoriz || Math.abs(dz) > maxHoriz) continue;
  if (dy > maxUp || dy < -maxDown) continue;

  const block = dim.getBlock(cur);
  if (!block) continue;

  if (LOG_SET.has(block.typeId)) {
   logs.push(cur);
   if (logs.length >= maxBlocks) break;

   for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
     for (let oz = -1; oz <= 1; oz++) {
      if (ox === 0 && oy === 0 && oz === 0) continue;
      stack.push({ x: cur.x + ox, y: cur.y + oy, z: cur.z + oz });
     }
    }
   }
  }
 }

 return logs;
}

/* ------------------------------------------------ */
/* GIVE CONFIG BOOK ON FIRST SPAWN                  */
/* ------------------------------------------------ */

world.afterEvents.playerSpawn.subscribe(({ player: p }) => {
 if (!getProp(p, PROP.gotBook, false)) {
  p.runCommand("gamerule showtags false");
  addItem(p, "stv:book_config", true, "none", [""]);
  setProp(p, PROP.gotBook, true);
 }
});
