const { getSupabase, cors, checkAuth } = require('./lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { batches } = req.body || {};

    // Only get active ingredients
    const { data: ingredients } = await supabase.from('ingredients').select('*').eq('active', true).order('supplier_id').order('name');
    const { data: pantry } = await supabase.from('pantry').select('*');
    const pantryMap = {};
    for (const p of pantry || []) pantryMap[p.ingredient_id] = p;

    const { data: baseIngredients } = await supabase.from('base_dough_ingredients').select('*');
    const { data: flavorIngredients } = await supabase.from('flavor_ingredients').select('*');
    const { data: flavors } = await supabase.from('flavors').select('*').eq('active', true);
    const flavorMap = {};
    for (const f of flavors) flavorMap[f.id] = f;
    const { data: subRecipeIngredients } = await supabase.from('sub_recipe_ingredients').select('*');
    const { data: flavorSubRecipes } = await supabase.from('flavor_sub_recipes').select('*');
    const { data: subRecipes } = await supabase.from('sub_recipes').select('*');
    const subRecipeMap = {};
    for (const sr of subRecipes || []) subRecipeMap[sr.id] = sr;

    // Build set of ingredients actually used in recipes
    const usedIngredientIds = new Set();
    for (const bi of baseIngredients || []) usedIngredientIds.add(bi.ingredient_id);
    for (const fi of flavorIngredients || []) usedIngredientIds.add(fi.ingredient_id);
    for (const si of subRecipeIngredients || []) usedIngredientIds.add(si.ingredient_id);

    // Calculate ingredient usage from production plan
    const ingredientUsage = {};

    if (batches && Array.isArray(batches)) {
      for (const { flavor_id, batch_count } of batches) {
        const flavor = flavorMap[flavor_id];
        if (!flavor || !batch_count) continue;

        if (flavor.base_dough_id) {
          const baseIngs = baseIngredients.filter(bi => bi.base_dough_id === flavor.base_dough_id);
          for (const bi of baseIngs) {
            ingredientUsage[bi.ingredient_id] = (ingredientUsage[bi.ingredient_id] || 0) + parseFloat(bi.grams) * batch_count;
          }
        }

        const addOns = flavorIngredients.filter(fi => fi.flavor_id === flavor_id);
        for (const fi of addOns) {
          ingredientUsage[fi.ingredient_id] = (ingredientUsage[fi.ingredient_id] || 0) + parseFloat(fi.grams) * batch_count;
        }

        const linkedSubs = flavorSubRecipes?.filter(fsr => fsr.flavor_id === flavor_id) || [];
        for (const link of linkedSubs) {
          const sr = subRecipeMap[link.sub_recipe_id];
          if (!sr) continue;
          const srIngs = subRecipeIngredients?.filter(si => si.sub_recipe_id === link.sub_recipe_id) || [];
          if (sr.grams_per_cookie) {
            const cookiesProduced = flavor.batch_size_cookies * batch_count;
            const scaleFactor = parseFloat(sr.grams_per_cookie) * cookiesProduced;
            const totalSubGrams = srIngs.reduce((s, i) => s + parseFloat(i.grams), 0);
            if (totalSubGrams > 0) {
              for (const si of srIngs) {
                const ratio = parseFloat(si.grams) / totalSubGrams;
                ingredientUsage[si.ingredient_id] = (ingredientUsage[si.ingredient_id] || 0) + scaleFactor * ratio;
              }
            }
          } else {
            for (const si of srIngs) {
              ingredientUsage[si.ingredient_id] = (ingredientUsage[si.ingredient_id] || 0) + parseFloat(si.grams) * batch_count;
            }
          }
        }
      }
    }

    // Build supplier order lists - only include ingredients used in recipes
    const suppliers = {};
    for (const ing of ingredients) {
      // Skip ingredients not used in any recipe
      if (!usedIngredientIds.has(ing.id)) continue;

      const supId = ing.supplier_id;
      if (!suppliers[supId]) suppliers[supId] = { items: [] };
      const pantryItem = pantryMap[ing.id];
      const onHand = pantryItem ? parseFloat(pantryItem.quantity_on_hand || 0) : 0;
      const parLevel = pantryItem ? parseFloat(pantryItem.par_level || 0) : 0;
      const usageGrams = ingredientUsage[ing.id] || 0;
      const needToOrder = parLevel > 0 ? Math.max(0, parLevel - onHand) : 0;

      // Calculate level percentage safely (avoid NaN)
      const levelPct = parLevel > 0 ? Math.round(onHand / parLevel * 100) : 0;

      suppliers[supId].items.push({
        ingredient: ing, on_hand: onHand, par_level: parLevel,
        usage_grams: Math.round(usageGrams),
        usage_oz: Math.round(usageGrams / 28.3495 * 10) / 10,
        need_to_order: needToOrder,
        unit: pantryItem?.unit || ing.unit_size || 'unit',
        level_pct: levelPct,
        status: parLevel === 0 ? 'no-par' : onHand >= parLevel * 0.7 ? 'good' : onHand >= parLevel * 0.4 ? 'low' : 'order'
      });
    }

    const { data: supplierList } = await supabase.from('suppliers').select('*');
    const supplierMap = {};
    for (const s of supplierList) supplierMap[s.id] = s;

    const orderLists = Object.entries(suppliers).map(([supId, data]) => ({
      supplier: supplierMap[parseInt(supId)] || { name: 'Unknown' },
      items: data.items.sort((a, b) => {
        if (a.status === 'order' && b.status !== 'order') return -1;
        if (a.status !== 'order' && b.status === 'order') return 1;
        return a.ingredient.name.localeCompare(b.ingredient.name);
      }),
      itemsToOrder: data.items.filter(i => i.status === 'order').length
    }));

    res.json({ orderLists, ingredientUsage });
  } catch (err) {
    console.error('Order lists error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
