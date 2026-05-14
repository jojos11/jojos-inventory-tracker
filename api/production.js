const { getSupabase, cors, checkAuth } = require('./lib/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION LOGGING WITH PANTRY DEDUCTION
//
// POST /api/production
//   body: {
//     batches: [{flavor_id, batch_count}],
//     location_id: number,
//     logged_by: string,
//     dryRun?: boolean   // if true, just return the rollup preview, don't write
//   }
//
// What this does:
//   1) Rolls up every batch into a flat list of ingredient grams needed
//      using the same model as /api/prep-list:
//        - flavor.base_dough_id → base_dough_ingredients (grams × batches)
//        - flavor → flavor_ingredients (mix-ins, grams × batches)
//        - flavor → flavor_sub_recipes → sub_recipe_ingredients
//             (sub-recipes can be per-cookie or per-batch scaled)
//   2) If dryRun=true: returns the preview, no writes
//   3) Otherwise: writes one production_logs row per flavor, then
//      decrements pantry.quantity_on_hand for each ingredient based on
//      grams_per_order_unit conversion. Pantry can drift over time;
//      Colin/Marisa will reconcile with manual counts periodically.
//
// Safety:
//   - Never lets pantry go below 0 (clamps to 0, flags shortages)
//   - Ingredients with no pantry row or no grams_per_order_unit are skipped
//     (logged in `skipped` so the UI can show "we couldn't track these")
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { batches, location_id, logged_by, dryRun } = req.body || {};
    if (!batches || !Array.isArray(batches) || batches.length === 0) {
      return res.status(400).json({ error: 'No batches provided' });
    }

    // ─── 1. Load reference data needed for rollup ───────────────────────────
    const { data: flavors } = await supabase.from('flavors').select('*');
    const flavorMap = {};
    for (const f of (flavors || [])) flavorMap[f.id] = f;

    const { data: baseIngredients } = await supabase.from('base_dough_ingredients').select('*');
    const { data: flavorIngredients } = await supabase.from('flavor_ingredients').select('*');
    const { data: flavorSubRecipes } = await supabase.from('flavor_sub_recipes').select('*');
    const { data: subRecipes } = await supabase.from('sub_recipes').select('*');
    const subRecipeMap = {};
    for (const sr of (subRecipes || [])) subRecipeMap[sr.id] = sr;
    const { data: subRecipeIngredients } = await supabase.from('sub_recipe_ingredients').select('*');

    // ─── 2. Roll up: aggregate total grams per ingredient_id ────────────────
    // ingredientTotals: { [ingredient_id]: { grams: number, sources: [string] } }
    const ingredientTotals = {};
    const addGrams = (ingredientId, grams, sourceLabel) => {
      if (!ingredientId || !grams || grams <= 0) return;
      if (!ingredientTotals[ingredientId]) {
        ingredientTotals[ingredientId] = { grams: 0, sources: [] };
      }
      ingredientTotals[ingredientId].grams += grams;
      if (!ingredientTotals[ingredientId].sources.includes(sourceLabel)) {
        ingredientTotals[ingredientId].sources.push(sourceLabel);
      }
    };

    let totalBatches = 0;

    for (const { flavor_id, batch_count } of batches) {
      const flavor = flavorMap[flavor_id];
      if (!flavor || !batch_count) continue;
      totalBatches += batch_count;

      // Base dough ingredients (if the flavor uses a base dough)
      if (flavor.base_dough_id) {
        const baseIngs = (baseIngredients || []).filter(bi => bi.base_dough_id === flavor.base_dough_id);
        for (const bi of baseIngs) {
          addGrams(bi.ingredient_id, Number(bi.grams) * batch_count, flavor.name);
        }
      }

      // Direct flavor ingredients (mix-ins, add-ons)
      const flavorAddOns = (flavorIngredients || []).filter(fi => fi.flavor_id === flavor_id);
      for (const fi of flavorAddOns) {
        addGrams(fi.ingredient_id, Number(fi.grams) * batch_count, flavor.name);
      }

      // Sub-recipes (frostings, centers, glazes)
      const linkedSubs = (flavorSubRecipes || []).filter(fsr => fsr.flavor_id === flavor_id);
      for (const link of linkedSubs) {
        const sr = subRecipeMap[link.sub_recipe_id];
        if (!sr) continue;
        const srIngs = (subRecipeIngredients || []).filter(si => si.sub_recipe_id === sr.id);
        const totalSubGrams = srIngs.reduce((s, i) => s + Number(i.grams), 0);

        if (sr.grams_per_cookie) {
          // Frosting-style: scale by total cookies in batch
          const cookies = (flavor.batch_size_cookies || 300) * batch_count;
          const totalGrams = Number(sr.grams_per_cookie) * cookies;
          for (const si of srIngs) {
            const ratio = totalSubGrams > 0 ? Number(si.grams) / totalSubGrams : 0;
            addGrams(si.ingredient_id, totalGrams * ratio, `${flavor.name} (${sr.name})`);
          }
        } else {
          // Glaze/other: scale by batch count
          for (const si of srIngs) {
            addGrams(si.ingredient_id, Number(si.grams) * batch_count, `${flavor.name} (${sr.name})`);
          }
        }
      }
    }

    // ─── 3. Load ingredient + pantry info to build the deduction preview ───
    const affectedIds = Object.keys(ingredientTotals).map(Number);
    if (affectedIds.length === 0) {
      return res.json({
        totalBatches,
        ingredients: [],
        skipped: [],
        productionLogs: [],
        dryRun: !!dryRun,
        note: 'No ingredients found for these flavors. Check that recipes are configured in Settings.'
      });
    }

    const { data: ingredientRows } = await supabase.from('ingredients').select('*').in('id', affectedIds);
    const ingredientMap = {};
    for (const ing of (ingredientRows || [])) ingredientMap[ing.id] = ing;

    const { data: pantryRows } = await supabase.from('pantry').select('*').in('ingredient_id', affectedIds);
    const pantryMap = {};
    for (const p of (pantryRows || [])) pantryMap[p.ingredient_id] = p;

    // ─── 4. Build the deduction preview ────────────────────────────────────
    const ingredientsPreview = [];
    const skipped = [];

    for (const ingId of affectedIds) {
      const totals = ingredientTotals[ingId];
      const ing = ingredientMap[ingId];
      const pantry = pantryMap[ingId];

      if (!ing) {
        skipped.push({ ingredient_id: ingId, reason: 'Ingredient not found', grams: totals.grams });
        continue;
      }

      const name = ing.nickname || ing.name;
      const gramsPerOrderUnit = Number(ing.grams_per_order_unit) || 0;
      const orderUnit = ing.order_unit || 'unit';

      // If we can't convert grams to order units, we can still show the preview
      // but we can't deduct. Flag it so the UI shows "we don't know how to
      // track this one yet"
      if (gramsPerOrderUnit <= 0) {
        skipped.push({
          ingredient_id: ingId,
          name,
          reason: 'Missing grams_per_order_unit',
          grams: Math.round(totals.grams),
          sources: totals.sources
        });
        continue;
      }

      const orderUnitsUsed = totals.grams / gramsPerOrderUnit;
      const onHandBefore = pantry ? Number(pantry.quantity_on_hand) : 0;
      const onHandAfter = Math.max(0, onHandBefore - orderUnitsUsed);
      const wouldGoNegative = (onHandBefore - orderUnitsUsed) < 0;
      const parLevel = pantry ? Number(pantry.par_level || 0) : 0;

      ingredientsPreview.push({
        ingredient_id: ingId,
        name,
        grams_used: Math.round(totals.grams),
        order_units_used: Math.round(orderUnitsUsed * 100) / 100,
        order_unit: orderUnit,
        on_hand_before: onHandBefore,
        on_hand_after: Math.round(onHandAfter * 100) / 100,
        par_level: parLevel,
        below_par_after: parLevel > 0 && onHandAfter < parLevel,
        would_go_negative: wouldGoNegative,
        has_pantry_row: !!pantry,
        sources: totals.sources
      });
    }

    // Sort by largest order-unit impact first so the most "expensive" items lead
    ingredientsPreview.sort((a, b) => b.order_units_used - a.order_units_used);

    // ─── 5. If dryRun, return preview without writes ──────────────────────
    if (dryRun) {
      return res.json({
        totalBatches,
        ingredients: ingredientsPreview,
        skipped,
        productionLogs: [],
        dryRun: true
      });
    }

    // ─── 6. Real save: validate inputs, insert production_logs, deduct ────
    if (!location_id) return res.status(400).json({ error: 'location_id required to save' });
    if (!logged_by) return res.status(400).json({ error: 'logged_by required to save' });

    const today = new Date().toISOString().split('T')[0];
    const productionLogs = [];

    for (const { flavor_id, batch_count } of batches) {
      const flavor = flavorMap[flavor_id];
      if (!flavor || !batch_count || batch_count <= 0) continue;
      const { data: inserted, error: prodErr } = await supabase
        .from('production_logs')
        .insert({
          flavor_id: parseInt(flavor_id),
          batches: parseFloat(batch_count),
          date: today,
          location_id: parseInt(location_id),
          logged_by
        })
        .select();
      if (prodErr) {
        return res.status(500).json({ error: 'Production log insert failed: ' + prodErr.message });
      }
      if (inserted?.[0]) productionLogs.push(inserted[0]);
    }

    // Deduct from pantry. We do this one row at a time because Supabase's
    // JS SDK doesn't support atomic decrement via update — we have to read
    // then write. Drift from concurrent edits is acceptable here because
    // pantry is reconciled by manual counts periodically.
    for (const item of ingredientsPreview) {
      if (!item.has_pantry_row) continue;
      const { error: updErr } = await supabase
        .from('pantry')
        .update({ quantity_on_hand: item.on_hand_after, updated_at: new Date().toISOString() })
        .eq('ingredient_id', item.ingredient_id);
      if (updErr) {
        // Don't abort — the production was logged, just flag this deduction failed
        item.deduction_error = updErr.message;
      }
    }

    res.json({
      totalBatches,
      ingredients: ingredientsPreview,
      skipped,
      productionLogs,
      dryRun: false
    });
  } catch (err) {
    console.error('Production error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
};
