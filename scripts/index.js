import { world, EquipmentSlot, EntityEquippableComponent, system, ItemStack } from '@minecraft/server';
import { ModalFormData } from "@minecraft/server-ui";

const FIELDS = [
  { label: "-Break Leaves-",           tag: "breakLeavesDisable" },
  { label: "-Progressive Chopping-",   tag: "progressiveChoppingDisable" },
  { label: "-Works with custom axes-", tag: "customAxesDisable" },
  { label: "-Disable when sneaking-",  tag: "disableSneakDisable" }
];

function toggleCompat(form, label, def) {
  try {
    return form.toggle(label, { defaultValue: def });
  } catch {
    return form.toggle(label, def);
  }
}

export function functionConfig(p) {
  const form = new ModalFormData().title("§l§5-Tree Capitator Function-");
  for (const f of FIELDS) {
    const enabled = !p.hasTag(f.tag);
    toggleCompat(form, f.label, enabled);
  }
  form.show(p).then(res => {
    if (res.canceled || !Array.isArray(res.formValues)) return;
    if (res.formValues.length !== FIELDS.length) {
      p.sendMessage("§c(Form mismatch) Valores no coinciden con los campos.");
      return;
    }
    for (let i = 0; i < FIELDS.length; i++) {
      const enabled = !!res.formValues[i];
      const tag = FIELDS[i].tag;
      if (enabled) p.removeTag(tag); else p.addTag(tag);
    }
    p.sendMessage({ rawtext: [{ text: "§l§2-Saved configuration" }] });
  });
}
export function addItem(player, itemId, keepOnDeath, lockMode, lore){
	let container = player.getComponent("inventory").container;
	let item = new ItemStack(itemId);
	item.keepOnDeath = keepOnDeath
	item.lockMode = lockMode;
	item.setLore(lore);
	container.addItem(item);
}
world.beforeEvents.playerBreakBlock.subscribe(({ block, player }) => {
  try {
    const equip = player.getComponent(EntityEquippableComponent.componentId);
    const tool = equip?.getEquipment(EquipmentSlot.Mainhand);
    const typeId = tool?.typeId ?? "";

    const sneakinVerify = !player.hasTag("disableSneakDisable") ? !player.isSneaking : true;
    const customAxeVerify = !player.hasTag("customAxesDisable")
      ? typeId.includes("_axe")
      : (typeId.startsWith("minecraft:") && typeId.includes("_axe"));

    if (customAxeVerify && sneakinVerify && !player.hasTag("off")) {
      const breakSet = !player.hasTag("breakLeavesDisable")
        ? AXE_COMMON_BREAKABLE_BLOCKS_WITH_LEAVES
        : AXE_COMMON_BREAKABLE_BLOCKS;

      if (breakSet.includes(block.typeId)) {
        breakEntireTreeProgressive(block, player, breakSet, {
          breakDelayMs: !player.hasTag("progressiveChoppingDisable") ? 7 : 1,
          maxHoriz: 6,
          maxUp: 24,
          maxDown: 3,
          perBlockDelayMs: 0,
          maxBlocks: 2000,
        });
      }
    }
  } catch (e) {}
});

// Romper árbol progresivo
export function breakEntireTreeProgressive(centerBlock, player, breakableBlocks, {
  breakDelayMs = 5,
  perBlockDelayMs = 0,
  maxHoriz = 6,
  maxUp = 24,
  maxDown = 3,
  maxBlocks = 2000,
} = {}) {
  const dim = centerBlock.dimension;
  const connected = findConnectedWoodBlocks(centerBlock, breakableBlocks, { maxHoriz, maxUp, maxDown, maxBlocks });
  if (connected.length === 0) return;

  const layers = new Map();
  for (const loc of connected) {
    if (!layers.has(loc.y)) layers.set(loc.y, []);
    layers.get(loc.y).push(loc);
  }

  const ys = Array.from(layers.keys()).sort((a, b) => a - b);
  ys.forEach((y, layerIndex) => {
    system.runTimeout(() => {
      const layer = layers.get(y);
      if (perBlockDelayMs > 0) {
        layer.forEach((loc, i) =>
          system.runTimeout(() => breakIfWood(player, dim, loc, breakableBlocks), i * perBlockDelayMs)
        );
      } else {
        for (const loc of layer) breakIfWood(player, dim, loc, breakableBlocks);
      }
    }, layerIndex * breakDelayMs);
  });
}

function breakIfWood(player, dimension, loc, breakableBlocks) {
  const b = dimension.getBlock(loc);
  if (!b || !breakableBlocks.includes(b.typeId)) return;
  
  if (!player.hasTag("choppingSoundDisable")) 
    player.runCommand(`playsound random.axe @s`)
  if (!player.hasTag("choppingParticleDisable"))
    player.runCommand(`particle minecraft:water_evaporation_manual ${loc.x} ${loc.y} ${loc.z}`);

  dimension.runCommand(`setblock ${loc.x} ${loc.y} ${loc.z} air destroy`);
}

function findConnectedWoodBlocks(startBlock, breakableBlocks, { maxHoriz = 6, maxUp = 24, maxDown = 3, maxBlocks = 2000 } = {}) {
  const start = startBlock.location;
  const dim = startBlock.dimension;

  const stack = [start];
  const seen = new Set();
  const out = [];
  const key = (x, y, z) => `${x},${y},${z}`;

  while (stack.length > 0) {
    const cur = stack.pop();
    const k = key(cur.x, cur.y, cur.z);
    if (seen.has(k)) continue;
    seen.add(k);

    const dx = cur.x - start.x;
    const dy = cur.y - start.y;
    const dz = cur.z - start.z;
    if (Math.abs(dx) > maxHoriz || Math.abs(dz) > maxHoriz) continue;
    if (dy > maxUp || dy < -maxDown) continue;

    const b = dim.getBlock(cur);
    if (!b || !breakableBlocks.includes(b.typeId)) continue;

    out.push(cur);
    if (out.length >= maxBlocks) break;

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          if (ox === 0 && oy === 0 && oz === 0) continue;
          stack.push({ x: cur.x + ox, y: cur.y + oy, z: cur.z + oz });
        }
      }
    }
  }
  return out;
}

// Mensaje de ayuda al equipar hacha
system.runInterval(() => {
  for (const p of world.getPlayers()) {
    try {
      const equip = p.getComponent(EntityEquippableComponent.componentId);
      const main = equip?.getEquipment(EquipmentSlot.Mainhand);
      const typeId = main?.typeId ?? "";
      if (typeId.includes("_axe") && !p.isSneaking && !p.hasTag("noti")) {
        p.runCommand("title @s actionbar §7--Sneak + Interact to activate/deactivate--");
        p.addTag("noti");
      }
      if (!typeId.includes("_axe") && p.hasTag("noti")) {
        p.removeTag("noti");
      }
    } catch (e) {}
  }
});

// Listas de bloques
export const AXE_COMMON_BREAKABLE_BLOCKS = [
  'minecraft:stripped_oak_wood','minecraft:stripped_dark_oak_wood','minecraft:stripped_birch_wood',
  'minecraft:stripped_spruce_wood','minecraft:stripped_acacia_wood','minecraft:stripped_jungle_wood',
  'minecraft:stripped_cherry_wood','minecraft:stripped_mangrove_wood','minecraft:stripped_pale_oak_wood',
  'minecraft:stripped_oak_log','minecraft:stripped_dark_oak_log','minecraft:stripped_birch_log',
  'minecraft:stripped_spruce_log','minecraft:stripped_acacia_log','minecraft:stripped_jungle_log',
  'minecraft:stripped_cherry_log','minecraft:stripped_mangrove_log','minecraft:stripped_pale_oak_log',
  'minecraft:stripped_crimson_stem','minecraft:stripped_warped_stem','minecraft:stripped_bamboo_block',
  'minecraft:oak_log','minecraft:dark_oak_log','minecraft:birch_log','minecraft:spruce_log','minecraft:acacia_log',
  'minecraft:jungle_log','minecraft:cherry_log','minecraft:mangrove_log','minecraft:pale_oak_log',
  'minecraft:crimson_stem','minecraft:warped_stem'
];
export const AXE_COMMON_BREAKABLE_BLOCKS_WITH_LEAVES = [
  ...AXE_COMMON_BREAKABLE_BLOCKS,
  'minecraft:oak_leaves','minecraft:dark_oak_leaves','minecraft:azalea_leaves_flowered',
  'minecraft:birch_leaves','minecraft:spruce_leaves','minecraft:acacia_leaves','minecraft:jungle_leaves',
  'minecraft:cherry_leaves','minecraft:mangrove_leaves','minecraft:pale_oak_leaves','minecraft:mangrove_roots'
];
world.afterEvents.playerSpawn.subscribe(({player: p})=>{
   if(!p.hasTag("getBook")){
      p.runCommand("gamerule showtags false")
      addItem(p, "stv:book_config", true, "none", [""]);
      p.addTag("getBook")
   }
})
// Activar/desactivar con sneak + usar
world.afterEvents.itemUse.subscribe(ev => {
  const p = ev.source;
  const item = ev.itemStack;
  if(item&&item.typeId.includes("stv:")){
      functionConfig(p)
  }
  if (item&&item.typeId.includes("_axe")){
   if (p.isSneaking && !p.hasTag("off")) {
      p.runCommand("title @s actionbar §7Tree Capitator: §cOff");
      p.addTag("off");
   } else if (p.isSneaking && p.hasTag("off")) {
      p.runCommand("title @s actionbar §7Tree Capitator: §aOn");
      p.removeTag("off");
   }
  }
});
