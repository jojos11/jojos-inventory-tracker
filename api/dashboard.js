const { getSupabase, cors, checkAuth } = require('./lib/supabase');

// ─── HELPERS ────────────────────────────────────────────────────────────────

function round4(n) { return Math.round(n * 4) / 4; }

function hoursBetween(a, b) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Math.abs(tb - ta) / 3600000;
}

// Project 7 days forward. Colin makes dough Mon/Tue every week, so the plan
// only needs to cover one week of sales until the next production cycle.
// (Old behavior was 14 days, which double-counted demand and inflated batches.)
function getProjectionDays() { return 7; }

function cookiesToBins(cookies, binCapacity) {
  return binCapacity > 0 ? cookies / binCapacity : 0;
}

// ─── VELOCITY FROM COUNT DELTAS ─────────────────────────────────────────────
// Looks at last 14 days of snapshots per flavor per location.
// For each consecutive count pair, infers "true sales" =
//   prev_count + production(Pet only) + transfers_in − transfers_out − current_count
// Sums deltas, normalizes to weekly rate. Combines in-store + online sales.
async function calculateVelocity(supabase, flavor, days = 14) {
  const fId = flavor.id;
  const binCap = flavor.bin_capacity_cookies || 80;
  const batchSize = flavor.batch_size_cookies || 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const result = { petoskey: 0, tc: 0, total: 0, dataPoints: 0, reliable: false };

  for (const locId of [1, 2]) {
    // Fetch ALL snapshots (both fridge and freezer) since cutoff
    const { data: rawSnaps } = await supabase
      .from('inventory_snapshots')
      .select('actual_bins, created_at, storage')
      .eq('flavor_id', fId)
      .eq('location_id', locId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true });

    if (!rawSnaps || rawSnaps.length === 0) continue;

    // Group by calendar date — sum fridge + freezer bins for that date
    // Use the LATEST timestamp on that date as the snapshot time
    const byDate = {};
    for (const snap of rawSnaps) {
      const dateKey = snap.created_at.substring(0, 10); // YYYY-MM-DD
      if (!byDate[dateKey]) {
        byDate[dateKey] = { bins: 0, anyNull: false, latestTime: snap.created_at };
      }
      if (snap.actual_bins === null) {
        byDate[dateKey].anyNull = true;
      } else {
        byDate[dateKey].bins += Number(snap.actual_bins);
      }
      if (snap.created_at > byDate[dateKey].latestTime) {
        byDate[dateKey].latestTime = snap.created_at;
      }
    }

    // Convert to a sorted array
    const snaps = Object.keys(byDate).sort().map(d => ({
      actual_bins: byDate[d].anyNull && byDate[d].bins === 0 ? null : byDate[d].bins,
      created_at: byDate[d].latestTime,
      isNull: byDate[d].anyNull && byDate[d].bins === 0
    }));

    if (snaps.length < 2) continue;

    let totalSoldBins = 0;
    let totalDays = 0;

    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const curr = snaps[i];

      // Skip intervals where either count was fully "not stocked"
      if (prev.isNull || curr.isNull) continue;

      const prevBins = Number(prev.actual_bins);
      const currBins = Number(curr.actual_bins);

      // Production during interval (only applies to Petoskey — all prod is there)
      let productionBins = 0;
      if (locId === 1 && batchSize > 0) {
        const { data: prod } = await supabase
          .from('production_logs')
          .select('batches')
          .eq('flavor_id', fId)
          .gt('created_at', prev.created_at)
          .lte('created_at', curr.created_at);
        if (prod) {
          for (const p of prod) {
            productionBins += (Number(p.batches) * batchSize) / binCap;
          }
        }
      }

      const { data: tIn } = await supabase
        .from('transfers')
        .select('bins')
        .eq('flavor_id', fId)
        .eq('to_location_id', locId)
        .gt('created_at', prev.created_at)
        .lte('created_at', curr.created_at);
      const transfersIn = (tIn || []).reduce((s, t) => s + Number(t.bins), 0);

      const { data: tOut } = await supabase
        .from('transfers')
        .select('bins')
        .eq('flavor_id', fId)
        .eq('from_location_id', locId)
        .gt('created_at', prev.created_at)
        .lte('created_at', curr.created_at);
      const transfersOut = (tOut || []).reduce((s, t) => s + Number(t.bins), 0);

      const soldThisInterval = prevBins + productionBins + transfersIn - transfersOut - currBins;
      const intervalDays = hoursBetween(prev.created_at, curr.created_at) / 24;

      // Only count intervals with positive sales (negative = data error, skip)
      if (intervalDays > 0 && soldThisInterval >= 0) {
        totalSoldBins += soldThisInterval;
        totalDays += intervalDays;
      }
    }

    if (totalDays > 0) {
      const weeklyRate = (totalSoldBins / totalDays) * 7;
      if (locId === 1) result.petoskey = round4(weeklyRate);
      else result.tc = round4(weeklyRate);
      result.dataPoints += snaps.length;
    }
  }

  result.total = round4(result.petoskey + result.tc);
  result.reliable = result.dataPoints >= 4;
  return result;
}

// ─── CURRENT INVENTORY (snapshot + production + transfers, NO sales) ────────
async function calculateCurrentInventory(supabase, flavor) {
  const fId = flavor.id;
  const binCap = flavor.bin_capacity_cookies || 80;
  const batchSize = flavor.batch_size_cookies || 0;

  let petBins = 0;
  let tcBins = 0;
  let petFridge = 0, petFreezer = 0;
  let tcFridge = 0, tcFreezer = 0;
  let petSnapTime = null;
  let tcSnapTime = null;

  // Helper: fetch latest snapshot for a (location, storage) pair
  async function getLatestSnapshot(locId, storage) {
    const { data } = await supabase
      .from('inventory_snapshots')
      .select('actual_bins, created_at')
      .eq('flavor_id', fId)
      .eq('location_id', locId)
      .eq('storage', storage)
      .not('actual_bins', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  }

  // Petoskey: fridge + freezer
  const petFridgeSnap = await getLatestSnapshot(1, 'fridge');
  const petFreezerSnap = await getLatestSnapshot(1, 'freezer');
  if (petFridgeSnap) {
    petFridge = Number(petFridgeSnap.actual_bins);
    petSnapTime = petFridgeSnap.created_at;
  }
  if (petFreezerSnap) {
    petFreezer = Number(petFreezerSnap.actual_bins);
    // Use the most recent of either snap as the "snap time" for downstream logic
    if (!petSnapTime || petFreezerSnap.created_at > petSnapTime) {
      petSnapTime = petFreezerSnap.created_at;
    }
  }

  // Apply production + transfers since the latest Petoskey snap
  if (petSnapTime) {
    petBins = petFridge + petFreezer;

    if (batchSize > 0) {
      const { data: prod } = await supabase
        .from('production_logs')
        .select('batches')
        .eq('flavor_id', fId)
        .gt('created_at', petSnapTime);
      if (prod) for (const p of prod) petBins += (Number(p.batches) * batchSize) / binCap;
    }

    const { data: tOut } = await supabase
      .from('transfers')
      .select('bins')
      .eq('flavor_id', fId)
      .eq('from_location_id', 1)
      .gt('created_at', petSnapTime);
    if (tOut) for (const t of tOut) petBins -= Number(t.bins);

    const { data: tIn } = await supabase
      .from('transfers')
      .select('bins')
      .eq('flavor_id', fId)
      .eq('to_location_id', 1)
      .gt('created_at', petSnapTime);
    if (tIn) for (const t of tIn) petBins += Number(t.bins);
  }

  // Traverse City: fridge + freezer
  const tcFridgeSnap = await getLatestSnapshot(2, 'fridge');
  const tcFreezerSnap = await getLatestSnapshot(2, 'freezer');
  if (tcFridgeSnap) {
    tcFridge = Number(tcFridgeSnap.actual_bins);
    tcSnapTime = tcFridgeSnap.created_at;
  }
  if (tcFreezerSnap) {
    tcFreezer = Number(tcFreezerSnap.actual_bins);
    if (!tcSnapTime || tcFreezerSnap.created_at > tcSnapTime) {
      tcSnapTime = tcFreezerSnap.created_at;
    }
  }

  if (tcSnapTime) {
    tcBins = tcFridge + tcFreezer;

    const { data: tOut } = await supabase
      .from('transfers')
      .select('bins')
      .eq('flavor_id', fId)
      .eq('from_location_id', 2)
      .gt('created_at', tcSnapTime);
    if (tOut) for (const t of tOut) tcBins -= Number(t.bins);

    const { data: tIn } = await supabase
      .from('transfers')
      .select('bins')
      .eq('flavor_id', fId)
      .eq('to_location_id', 2)
      .gt('created_at', tcSnapTime);
    if (tIn) for (const t of tIn) tcBins += Number(t.bins);
  }

  petBins = Math.max(0, petBins);
  tcBins = Math.max(0, tcBins);

  return {
    petoskey: round4(petBins),
    tc: round4(tcBins),
    total: round4(petBins + tcBins),
    petFridge: round4(petFridge),
    petFreezer: round4(petFreezer),
    tcFridge: round4(tcFridge),
    tcFreezer: round4(tcFreezer),
    petSnapTime,
    tcSnapTime
  };
}

// ─── COUNT FRESHNESS ────────────────────────────────────────────────────────
async function getCountFreshness(supabase) {
  const now = new Date();
  const result = {};

  for (const locId of [1, 2]) {
    const { data } = await supabase
      .from('inventory_snapshots')
      .select('created_at, counted_by')
      .eq('location_id', locId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      const lastCount = data[0].created_at;
      const hours = hoursBetween(now, lastCount);
      result[locId] = {
        lastCount,
        countedBy: data[0].counted_by,
        hoursAgo: Math.round(hours),
        stale: hours > 36,
        missing: false
      };
    } else {
      result[locId] = {
        lastCount: null,
        countedBy: null,
        hoursAgo: null,
        stale: true,
        missing: true
      };
    }
  }

  return result;
}

// ─── THIS WEEK'S PRODUCTION (Sun 00:00 → now) ───────────────────────────────
async function getThisWeekProduction(supabase, flavorMap, baseMap) {
  const now = new Date();
  const day = now.getDay();
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - day);

  const { data: logs } = await supabase
    .from('production_logs')
    .select('flavor_id, batches, created_at')
    .gte('created_at', weekStart.toISOString());

  const summary = {
    totalBatches: 0,
    byBase: {},
    byFlavor: {},
    weekStart: weekStart.toISOString()
  };

  for (const log of logs || []) {
    const flavor = flavorMap[log.flavor_id];
    if (!flavor) continue;
    const batches = Number(log.batches) || 0;

    summary.totalBatches += batches;

    const baseId = flavor.base_dough_id;
    const baseLabel = baseId && baseMap[baseId] ? baseMap[baseId].label : 'Standalone';
    summary.byBase[baseLabel] = (summary.byBase[baseLabel] || 0) + batches;

    summary.byFlavor[flavor.name] = (summary.byFlavor[flavor.name] || 0) + batches;
  }

  summary.totalBatches = round4(summary.totalBatches);
  return summary;
}

// ─── MAIN HANDLER ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { data: flavors } = await supabase
      .from('flavors')
      .select('*')
      .in('status', ['live', 'pre_production'])
      .order('type')
      .order('name');

    if (!flavors || flavors.length === 0) {
      return res.json({
        inventory: [], productionPlan: [], velocity: {},
        alerts: [], manualOrders: [], countFreshness: {},
        thisWeek: { totalBatches: 0, byBase: {}, byFlavor: {} },
        summary: { totalFlavors: 0 }
      });
    }

    const flavorMap = {};
    for (const f of flavors) flavorMap[f.id] = f;

    const { data: baseDoughs } = await supabase.from('base_doughs').select('*');
    const baseMap = {};
    for (const b of baseDoughs || []) baseMap[b.id] = b;

    const projectionDays = getProjectionDays();
    const countFreshness = await getCountFreshness(supabase);
    const thisWeek = await getThisWeekProduction(supabase, flavorMap, baseMap);

    const inventoryArr = [];
    const velocity = {};

    for (const f of flavors) {
      const [inv, vel] = await Promise.all([
        calculateCurrentInventory(supabase, f),
        calculateVelocity(supabase, f, 14)
      ]);
      inventoryArr.push({
        flavor: f,
        petoskey: inv.petoskey,
        tc: inv.tc,
        total: inv.total,
        petFridge: inv.petFridge,
        petFreezer: inv.petFreezer,
        tcFridge: inv.tcFridge,
        tcFreezer: inv.tcFreezer,
        petSnapTime: inv.petSnapTime,
        tcSnapTime: inv.tcSnapTime
      });
      velocity[f.id] = vel;
    }

    // Upcoming manual orders in projection window.
    // Filter:
    //   - status pending or confirmed (not completed/cancelled)
    //   - fulfillment date today through windowEnd (no past-due orders)
    //   - has a fulfillment_date (skip drafts with no date set)
    // Past-due orders should be marked completed/cancelled by the manager, not
    // counted as upcoming demand against future production.
    const todayStr = new Date().toISOString().split('T')[0];
    const windowEnd = new Date(Date.now() + projectionDays * 86400000).toISOString().split('T')[0];
    const { data: manualOrders } = await supabase
      .from('manual_orders')
      .select('*, manual_order_items(*)')
      .in('status', ['pending', 'confirmed'])
      .not('fulfillment_date', 'is', null)
      .gte('fulfillment_date', todayStr)
      .lte('fulfillment_date', windowEnd)
      .order('fulfillment_date');

    // What week of the month is it? (used for specialty campaign logic)
    // Week 1 = days 1-7, week 2 = 8-14, week 3 = 15-21, week 4 = 22+.
    const today = new Date();
    const dayOfMonth = today.getDate();
    const weekOfMonth = Math.min(4, Math.ceil(dayOfMonth / 7));

    // Production plan per flavor — two-track model:
    //   CLASSICS + EXTRAS: weekly replenishment.
    //     need = par + this_week_demand − current  → ceil to batches
    //   SPECIALTIES: monthly campaign.
    //     Week 1: make to 7-8 bins target
    //     Weeks 2-3: only bake if ≤ 2 bins, refill to 5-6
    //     Week 4: 0 batches, let it sell down
    const productionPlan = [];
    for (const invItem of inventoryArr) {
      const f = invItem.flavor;
      // Skip pre_production flavors — these are 'coming soon', not yet
      // selling, so they shouldn't be in the bake-this-week list. They still
      // show in Settings under their lifecycle but don't pollute the prep list.
      if (f.status === 'pre_production') continue;
      const vel = velocity[f.id] || { total: 0, petoskey: 0, tc: 0, reliable: false };
      const binCap = f.bin_capacity_cookies || 80;
      const batchSize = f.batch_size_cookies || 0;
      const binsPerBatch = batchSize > 0 ? batchSize / binCap : 0;
      const par = Number(f.par_level_bins) || 6;
      const trigger = Number(f.restock_trigger_bins) || 3;
      const isSpecialty = f.type === 'specialty';

      // Sales projection for the planning window (7 days)
      const projectedSales = round4(vel.total * (projectionDays / 7));

      // Catering / wholesale demand — 2oz-aware.
      // The cookie_oz field on the order item tells us the cookie size.
      // A 4oz cookie occupies 1 standard slot in a bin (bin_capacity is sized
      // around 4oz). A 2oz cookie takes only half that space — so 200 cookies
      // at 2oz = 200 * 2/4 = 100 standard-equivalent units = 100/binCap bins.
      let upcomingDemandBins = 0;
      for (const order of manualOrders || []) {
        const items = (order.manual_order_items || []).filter(i => i.flavor_id === f.id);
        for (const item of items) {
          const qty = Number(item.quantity) || 0;
          const oz = Number(item.cookie_oz) || 4; // default to 4oz if not specified
          // Bin demand = (cookies × oz/4) / bin_capacity
          // A 2oz cookie is half the dough of a 4oz, so half the bin impact.
          const standardEquivalent = qty * (oz / 4);
          upcomingDemandBins += standardEquivalent / binCap;
        }
      }
      upcomingDemandBins = round4(upcomingDemandBins);

      const totalDemand = round4(projectedSales + upcomingDemandBins);
      const endingWithoutProduction = round4(invItem.total - totalDemand);

      // Track-specific target & raw need
      let targetEnding, rawNeeded, planLogic;
      if (isSpecialty) {
        // Monthly campaign model
        const startTarget = 7;   // beginning-of-month target
        const refillTarget = 5;  // mid-month refill target
        const refillTrigger = 2; // mid-month: only bake if current dips this low

        if (weekOfMonth === 1) {
          // Week 1: stock up. Aim for 7-8 bins TOTAL across both stores.
          targetEnding = startTarget;
          rawNeeded = Math.max(0, targetEnding - endingWithoutProduction);
          planLogic = `Week 1 of month — target ${startTarget} bins to start the month`;
        } else if (weekOfMonth === 4) {
          // Last week: don't make any more. Let it sell down.
          targetEnding = 0;
          rawNeeded = 0;
          planLogic = `Week 4 of month — sell down, no production`;
        } else {
          // Weeks 2-3: only bake if running low (≤ 2 bins after sales)
          if (endingWithoutProduction <= refillTrigger) {
            targetEnding = refillTarget;
            rawNeeded = Math.max(0, targetEnding - endingWithoutProduction);
            planLogic = `Week ${weekOfMonth} — low (${endingWithoutProduction} ≤ ${refillTrigger}), refill to ${refillTarget}`;
          } else {
            targetEnding = endingWithoutProduction;
            rawNeeded = 0;
            planLogic = `Week ${weekOfMonth} — ${endingWithoutProduction} bins on track, no production`;
          }
        }
      } else {
        // Classics + extras: simple weekly replenishment.
        // We want to wake up next Monday with ≥ par_level_bins after this week's sales.
        targetEnding = par;
        rawNeeded = Math.max(0, targetEnding - endingWithoutProduction);
        planLogic = `Classic — target ${par} bins for next Monday`;
      }

      // Round up to whole batches (Colin: full batches only, no halves)
      const batches = binsPerBatch > 0 && rawNeeded > 0
        ? Math.ceil(rawNeeded / binsPerBatch)
        : 0;
      const binsWillMake = round4(batches * binsPerBatch);

      // Build human-readable formula breakdown for the UI
      const formulaParts = [];
      formulaParts.push(`Have ${round4(invItem.total)} bins`);
      if (projectedSales > 0) formulaParts.push(`expect ~${projectedSales} sold this week`);
      if (upcomingDemandBins > 0) formulaParts.push(`${upcomingDemandBins} bins for orders`);
      if (targetEnding > 0) formulaParts.push(`want ${targetEnding} ending`);

      const formulaMath = isSpecialty && batches === 0
        ? planLogic
        : (rawNeeded > 0
            ? `${round4(invItem.total)} − ${totalDemand} + need ${round4(rawNeeded)} ÷ ${round4(binsPerBatch)}/batch → ${batches} batch${batches===1?'':'es'}`
            : `On track — no production needed`);

      const needsProduction = batches > 0 && endingWithoutProduction < targetEnding;
      const critical = endingWithoutProduction < 0;
      const belowTrigger = endingWithoutProduction <= trigger;
      const tcNeedsTransfer = invItem.tc <= 1 && invItem.petoskey > trigger + 1;

      productionPlan.push({
        flavor: f,
        current: invItem.total,
        petoskey: invItem.petoskey,
        tc: invItem.tc,
        petFridge: invItem.petFridge,
        petFreezer: invItem.petFreezer,
        tcFridge: invItem.tcFridge,
        tcFreezer: invItem.tcFreezer,
        velocity: vel.total,
        velocityReliable: vel.reliable,
        projectedSales,
        upcomingDemand: upcomingDemandBins,
        totalDemand,
        endingWithoutProduction,
        targetEnding,
        binsNeeded: round4(rawNeeded),
        batches,
        binsWillMake,
        needsProduction,
        critical,
        belowTrigger,
        tcNeedsTransfer,
        projectionDays,
        // New fields for the UI breakdown
        weekOfMonth,
        planLogic,
        formula: formulaParts.join(' · '),
        formulaMath,
        track: isSpecialty ? 'specialty' : 'classic'
      });
    }

    productionPlan.sort((a, b) => {
      if (a.critical && !b.critical) return -1;
      if (!a.critical && b.critical) return 1;
      if (a.needsProduction && !b.needsProduction) return -1;
      if (!a.needsProduction && b.needsProduction) return 1;
      return a.endingWithoutProduction - b.endingWithoutProduction;
    });

    const alerts = [];
    for (const p of productionPlan) {
      if (p.critical) {
        alerts.push({
          type: 'critical',
          message: `${p.flavor.name} will run out in the next ${projectionDays} days`,
          flavor: p.flavor.name
        });
      }
      if (p.tcNeedsTransfer) {
        alerts.push({
          type: 'transfer',
          message: `${p.flavor.name} — TC needs transfer from Petoskey`,
          flavor: p.flavor.name
        });
      }
    }

    for (const locId of [1, 2]) {
      const locName = locId === 1 ? 'Petoskey' : 'Traverse City';
      const cf = countFreshness[locId];
      if (cf.missing) {
        alerts.push({ type: 'warning', message: `${locName}: no count on record yet`, flavor: null });
      } else if (cf.stale) {
        alerts.push({ type: 'warning', message: `${locName}: last count ${cf.hoursAgo} hours ago`, flavor: null });
      }
    }

    const totalBatchesNeeded = productionPlan.reduce((s, p) => s + p.batches, 0);
    const batchesByBase = {};
    for (const p of productionPlan) {
      if (p.batches > 0) {
        const baseId = p.flavor.base_dough_id;
        const baseLabel = baseId && baseMap[baseId] ? baseMap[baseId].label : 'Standalone';
        batchesByBase[baseLabel] = (batchesByBase[baseLabel] || 0) + p.batches;
      }
    }

    res.json({
      inventory: inventoryArr,
      productionPlan,
      velocity,
      alerts,
      manualOrders: manualOrders || [],
      countFreshness,
      thisWeek,
      projectionDays,
      summary: {
        totalFlavors: flavors.length,
        needsProduction: productionPlan.filter(p => p.needsProduction).length,
        totalBatches: totalBatchesNeeded,
        batchesByBase,
        criticalAlerts: alerts.filter(a => a.type === 'critical').length,
        pendingOrders: (manualOrders || []).length
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
};
