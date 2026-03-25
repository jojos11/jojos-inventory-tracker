const { getSupabase, cors, checkAuth } = require('./lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { batches } = req.body || {};
    // batches = [{ flavor_id, batch_count }] from production plan

    if (!batches || !Array.isArray(batches) || batches.length === 0) {
      return res.json({ bases: [], subRecipes: [], addOns: [], totalBatches: 0 });
    }

    const { data: flavors } = await supabase.from('flavors').select('*').eq('active', true);
    const flavorMap = {};
    for (const f of flavors) flavorMap[f.id] = f;

    const { data: baseDoughs } = await supabase.from('base_doughs').select('*');
    const baseMap = {};
    for (const b of baseDoughs) baseMap[b.id] = b;

    const { data: baseIngredients } = await supabase.from('base_dough_ingredients').select('*, ingredients(name, nickname)');
    const { data: flavorIngredients } = await supabase.from('flavor_ingredients').select('*, ingredients(name, nickname)');
    const { data: flavorSubRecipes } = await supabase.from('flavor_sub_recipes').select('*');
    const { data: subRecipes } = await supabase.from('sub_recipes').select('*');
    const subRecipeMap = {};
    for (const sr of subRecipes || []) subRecipeMap[sr.id] = sr;
    const { data: subRecipeIngredients } = await supabase.from('sub_recipe_ingredients').select('*, ingredients(name, nickname)');

    // 1. Calculate base dough needs
    const baseNeeds = {}; // { base_dough_id: { base, totalBatches, flavors: [...] } }
    const standaloneNeeds = []; // flavors with no base dough

    for (const { flavor_id, batch_count } of batches) {
      const flavor = flavorMap[flavor_id];
      if (!flavor || !batch_count) continue;

      if (flavor.base_dough_id) {
        if (!baseNeeds[flavor.base_dough_id]) {
          baseNeeds[flavor.base_dough_id] = {
            base: baseMap[flavor.base_dough_id],
            totalBatches: 0,
            flavors: []
          };
        }
        baseNeeds[flavor.base_dough_id].totalBatches += batch_count;
        baseNeeds[flavor.base_dough_id].flavors.push({ name: flavor.name, batches: batch_count });
      } else {
        standaloneNeeds.push({ flavor, batches: batch_count });
      }
    }

    // Build base dough list with ingredients
    const bases = Object.values(baseNeeds).map(bn => {
      const ings = baseIngredients
        .filter(bi => bi.base_dough_id === bn.base.id)
        .map(bi => ({
          name: bi.ingredients?.nickname || bi.ingredients?.name || 'Unknown',
          grams_per_batch: parseFloat(bi.grams),
          total_grams: parseFloat(bi.grams) * bn.totalBatches,
          total_oz: Math.round(parseFloat(bi.grams) * bn.totalBatches / 28.3495 * 10) / 10
        }));
      return { ...bn, ingredients: ings };
    });

    // Add standalone flavors as pseudo-bases
    for (const sn of standaloneNeeds) {
      const ings = [...baseIngredients, ...flavorIngredients]
        .filter(i => {
          if (i.base_dough_id) return false;
          return i.flavor_id === sn.flavor.id;
        })
        .map(i => ({
          name: i.ingredients?.nickname || i.ingredients?.name || 'Unknown',
          grams_per_batch: parseFloat(i.grams),
          total_grams: parseFloat(i.grams) * sn.batches,
          total_oz: Math.round(parseFloat(i.grams) * sn.batches / 28.3495 * 10) / 10
        }));
      bases.push({
        base: { name: sn.flavor.name + ' (Standalone)', label: 'Standalone' },
        totalBatches: sn.batches,
        flavors: [{ name: sn.flavor.name, batches: sn.batches }],
        ingredients: ings
      });
    }

    // 2. Calculate sub-recipe needs (frostings, centers, glazes)
    const subNeeds = {}; // { sub_recipe_id: { subRecipe, totalCookies, flavors } }

    for (const { flavor_id, batch_count } of batches) {
      const flavor = flavorMap[flavor_id];
      if (!flavor || !batch_count) continue;

      const linked = (flavorSubRecipes || []).filter(fsr => fsr.flavor_id === flavor_id);
      for (const link of linked) {
        const sr = subRecipeMap[link.sub_recipe_id];
        if (!sr) continue;
        if (!subNeeds[sr.id]) {
          subNeeds[sr.id] = { subRecipe: sr, totalCookies: 0, totalBatches: 0, flavors: [] };
        }
        subNeeds[sr.id].totalCookies += flavor.batch_size_cookies * batch_count;
        subNeeds[sr.id].totalBatches += batch_count;
        subNeeds[sr.id].flavors.push({ name: flavor.name, batches: batch_count });
      }
    }

    const subRecipeList = Object.values(subNeeds).map(sn => {
      const sr = sn.subRecipe;
      const srIngs = (subRecipeIngredients || []).filter(si => si.sub_recipe_id === sr.id);
      const totalSubGrams = srIngs.reduce((s, i) => s + parseFloat(i.grams), 0);

      let ingredients;
      let usesOz = false;

      if (sr.oz_per_cookie) {
        // Frostings/centers measured in oz — scale by oz_per_cookie * total cookies
        usesOz = true;
        const totalOzNeeded = parseFloat(sr.oz_per_cookie) * sn.totalCookies;
        const totalSubOz = totalSubGrams / 28.3495;
        ingredients = srIngs.map(si => {
          const ratio = totalSubOz > 0 ? (parseFloat(si.grams) / 28.3495) / totalSubOz : 0;
          const ingOz = totalOzNeeded * ratio;
          return {
            name: si.ingredients?.nickname || si.ingredients?.name || 'Unknown',
            total_oz: Math.round(ingOz * 10) / 10,
            total_lbs: Math.round(ingOz / 16 * 10) / 10,
            total_grams: Math.round(ingOz * 28.3495)
          };
        });
      } else if (sr.grams_per_cookie) {
        // Scale by grams_per_cookie * total cookies
        const totalGrams = parseFloat(sr.grams_per_cookie) * sn.totalCookies;
        ingredients = srIngs.map(si => {
          const ratio = totalSubGrams > 0 ? parseFloat(si.grams) / totalSubGrams : 0;
          const total = totalGrams * ratio;
          return {
            name: si.ingredients?.nickname || si.ingredients?.name || 'Unknown',
            total_grams: Math.round(total),
            total_oz: Math.round(total / 28.3495 * 10) / 10,
            total_lbs: Math.round(total / 453.592 * 10) / 10
          };
        });
      } else {
        // Scale by batches (glazes, etc.)
        ingredients = srIngs.map(si => ({
          name: si.ingredients?.nickname || si.ingredients?.name || 'Unknown',
          total_grams: Math.round(parseFloat(si.grams) * sn.totalBatches),
          total_oz: Math.round(parseFloat(si.grams) * sn.totalBatches / 28.3495 * 10) / 10,
          total_lbs: Math.round(parseFloat(si.grams) * sn.totalBatches / 453.592 * 10) / 10
        }));
      }

      const totalOzNeeded = sr.oz_per_cookie ? Math.round(parseFloat(sr.oz_per_cookie) * sn.totalCookies * 10) / 10 : null;

      return { ...sn, ingredients, usesOz, totalOzNeeded };
    });

    // 3. Calculate add-on ingredient needs (flavor-specific mix-ins)
    const addOnNeeds = {}; // { ingredient_name: { total_grams, flavors } }

    for (const { flavor_id, batch_count } of batches) {
      const flavor = flavorMap[flavor_id];
      if (!flavor || !batch_count) continue;

      const addOns = (flavorIngredients || []).filter(fi => fi.flavor_id === flavor_id);
      for (const fi of addOns) {
        const name = fi.ingredients?.nickname || fi.ingredients?.name || 'Unknown';
        if (!addOnNeeds[name]) {
          addOnNeeds[name] = { name, total_grams: 0, flavors: [] };
        }
        addOnNeeds[name].total_grams += parseFloat(fi.grams) * batch_count;
        addOnNeeds[name].flavors.push({ name: flavor.name, batches: batch_count, grams: parseFloat(fi.grams) * batch_count });
      }
    }

    const addOns = Object.values(addOnNeeds).map(ao => ({
      ...ao,
      total_grams: Math.round(ao.total_grams),
      total_oz: Math.round(ao.total_grams / 28.3495 * 10) / 10,
      total_lbs: Math.round(ao.total_grams / 453.592 * 10) / 10
    })).sort((a, b) => b.total_grams - a.total_grams);

    const totalBatches = batches.reduce((s, b) => s + (b.batch_count || 0), 0);

    res.json({ bases, subRecipes: subRecipeList, addOns, totalBatches });
  } catch (err) {
    console.error('Prep list error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
};
