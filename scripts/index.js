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
 particles:       "stv:particles"
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
 { label: "§b» Chopping Particles «",     prop: PROP.particles,       def: true  }
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
/* ------------------------------------------------ */

function isNaturalTree(logs) {
 if (logs.length === 0) return false;
 const minY        = logs.reduce((m, l) => l.y < m ? l.y : m, logs[0].y);
 const bottomCount = logs.reduce((n, l) => n + (l.y === minY ? 1 : 0), 0);
 return bottomCount <= 2;
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

  const breakLeaves = getProp(player, PROP.breakLeaves, true);
  const breakSet    = breakLeaves ? FULL_SET : LOG_SET;

  if (!breakSet.has(block.typeId)) return;

  breakEntireTreeProgressive(block, player, breakLeaves, {
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

export function breakEntireTreeProgressive(centerBlock, player, breakLeaves, {
 breakDelayMs    = 5,
 perBlockDelayMs = 0,
 maxHoriz        = 6,
 maxUp           = 24,
 maxDown         = 3,
 maxBlocks       = 2000
} = {}) {

 const dim = centerBlock.dimension;

 const { logs, leaves } = findTreeBlocks(centerBlock, breakLeaves, {
  maxHoriz, maxUp, maxDown, maxBlocks
 });

 if (logs.length === 0) return;
 if (!isNaturalTree(logs)) return;

 // Logs only go into the progressive layer system
 const ys = [...new Set(logs.map(l => l.y))].sort((a, b) => a - b);

 if (!acquireLock(player, ys.length, breakDelayMs)) return;

 const layers      = new Map();
 const totalBreaks = logs.length; // leaves cost no durability — matches vanilla behaviour

 for (const loc of logs) {
  if (!layers.has(loc.y)) layers.set(loc.y, []);
  layers.get(loc.y).push(loc);
 }

 ys.forEach((y, layerIndex) => {
  system.runTimeout(() => {

   const layer      = layers.get(y);
   // Read once per layer rather than once per block
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

   // On the final log layer, break all leaves instantly in one go
   // Leaves have zero hardness in vanilla so instant break is correct
   if (layerIndex === ys.length - 1) {
    if (breakLeaves) {
     // Read props once — not per-block — to avoid 200x getDynamicProperty calls
     const playSound    = getProp(player, PROP.sound,     true);
     const playParticle = getProp(player, PROP.particles, true);
     for (const loc of leaves)
      breakLeafBlock(player, dim, loc, playSound, playParticle);
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
function breakLeafBlock(player, dimension, loc, playSound, playParticle) {
 try {
  const b = dimension.getBlock(loc);
  if (!b || !FULL_SET.has(b.typeId)) return;

  // Leaves are intentionally silent — no axe sound, no particles
  // Playing sound/particles on 200 leaves simultaneously causes lag spikes
  dimension.runCommand(`setblock ${loc.x} ${loc.y} ${loc.z} air destroy`);
 } catch {}
}

/* ------------------------------------------------ */
/* TREE DETECTION — single unified BFS              */
/*                                                  */
/* Walks breakSet directly (LOG_SET when leaves     */
/* disabled, FULL_SET when enabled). Logs and       */
/* leaves tracked in separate arrays so             */
/* isNaturalTree only checks log blocks.            */
/* 26-direction neighbors for diagonal/custom tree  */
/* support. maxHoriz=8 so canopy leaves that are    */
/* 6+ blocks wide are not clipped by the bounds.   */
/* ------------------------------------------------ */

function locHash(x, y, z) {
 return ((x + 2048) * 16777216) + ((y + 512) * 4096) + (z + 2048);
}

function findTreeBlocks(startBlock, includeLeaves, {
 maxHoriz  = 8,
 maxUp     = 24,
 maxDown   = 3,
 maxBlocks = 2000
} = {}) {

 const start   = startBlock.location;
 const dim     = startBlock.dimension;
 const visited = new Set();
 const logs    = [];
 const leaves  = [];
 const stack   = [start];

 // Single BFS — walks breakSet directly (logs + leaves when enabled).
 // Tracks logs and leaves in separate arrays so isNaturalTree only
 // sees log blocks, but the traversal is one unified pass.
 // This is the only approach that reliably finds all connected leaves
 // since it follows the actual block connectivity rather than trying
 // to seed from log surfaces after the fact.
 const breakSet = includeLeaves ? FULL_SET : LOG_SET;

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

  if (breakSet.has(block.typeId)) {
   if (LOG_SET.has(block.typeId)) {
    logs.push(cur);
   } else {
    leaves.push(cur);
   }

   if (logs.length + leaves.length >= maxBlocks) break;

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

 return { logs, leaves };
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
