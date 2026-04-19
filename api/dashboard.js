const { getSupabase, cors, checkAuth } = require('./lib/supabase');

// ─── HELPERS ────────────────────────────────────────────────────────────────

function round4(n) { return Math.round(n * 4) / 4; }

function hoursBetween(a, b) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Math.abs(tb - ta) / 3600000;
}

// Always project 14 days forward — covers Tue order → Wed truck → Wed-Sun prep →
// Mon-Tue dough → serves next week. This is the full production cycle window.
function getProjectionDays() { return 14; }

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
    const { data: snaps } = await supabase
      .from('inventory_snapshots')
      .select('actual_bins, created_at')
      .eq('flavor_id', fId)
      .eq('location_id', locId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true });

    if (!snaps || snaps.length < 2) continue;

    let totalSoldBins = 0;
    let totalDays = 0;

    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const curr = snaps[i];

      // Skip intervals where either count was "not stocked" (null)
      if (prev.actual_bins === null || curr.actual_bins === null) continue;

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
  let petSnapTime = null;
  let tcSnapTime = null;

  const { data: petSnaps } = await supabase
    .from('inventory_snapshots')
    .select('actual_bins, created_at')
    .eq('flavor_id', fId)
    .eq('location_id', 1)
    .not('actual_bins', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  const { data: tcSnaps } = await supabase
    .from('inventory_snapshots')
    .select('actual_bins, created_at')
    .eq('flavor_id', fId)
    .eq('location_id', 2)
    .not('actual_bins', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (petSnaps && petSnaps.length > 0) {
    const snap = petSnaps[0];
    petBins = Number(snap.actual_bins);
    petSnapTime = snap.created_at;

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

  if (tcSnaps && tcSnaps.length > 0) {
    const snap = tcSnaps[0];
    tcBins = Number(snap.actual_bins);
    tcSnapTime = snap.created_at;

    const { data: tIn } = await supabase
      .from('transfers')
      .select('bins')
      .eq('flavor_id', fId)
      .eq('to_location_id', 2)
      .gt('created_at', tcSnapTime);
    if (tIn) for (const t of tIn) tcBins += Number(t.bins);

    const { data: tOut } = await supabase
      .from('transfers')
      .select('bins')
      .eq('flavor_id', fId)
      .eq('from_location_id', 2)
      .gt('created_at', tcSnapTime);
    if (tOut) for (const t of tOut) tcBins -= Number(t.bins);
  }

  petBins = Math.max(0, petBins);
  tcBins = Math.max(0, tcBins);

  return {
    petoskey: round4(petBins),
    tc: round4(tcBins),
    total: round4(petBins + tcBins),
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
        petSnapTime: inv.petSnapTime,
        tcSnapTime: inv.tcSnapTime
      });
      velocity[f.id] = vel;
    }

    // Upcoming manual orders in projection window
    const windowEnd = new Date(Date.now() + projectionDays * 86400000).toISOString().split('T')[0];
    const { data: manualOrders } = await supabase
      .from('manual_orders')
      .select('*, manual_order_items(*)')
      .in('status', ['pending', 'confirmed'])
      .lte('fulfillment_date', windowEnd)
      .order('fulfillment_date');

    // Production plan per flavor
    const productionPlan = [];
    for (const invItem of inventoryArr) {
      const f = invItem.flavor;
      const vel = velocity[f.id] || { total: 0, petoskey: 0, tc: 0, reliable: false };
      const binCap = f.bin_capacity_cookies || 80;
      const batchSize = f.batch_size_cookies || 0;
      const binsPerBatch = batchSize > 0 ? batchSize / binCap : 0;
      // par_level_bins is per-location target; we want both locations at par
      const parTotal = (Number(f.par_level_bins) || 6) * 2;
      const trigger = Number(f.restock_trigger_bins) || 3;

      const projectedSales = round4(vel.total * (projectionDays / 7));

      let upcomingDemandCookies = 0;
      for (const order of manualOrders || []) {
        const items = (order.manual_order_items || []).filter(i => i.flavor_id === f.id);
        for (const item of items) {
          upcomingDemandCookies += Number(item.quantity) || 0;
        }
      }
      const upcomingDemandBins = round4(cookiesToBins(upcomingDemandCookies, binCap));

      const totalDemand = round4(projectedSales + upcomingDemandBins);
      const endingWithoutProduction = round4(invItem.total - totalDemand);
      const targetEnding = parTotal;

      const rawNeeded = Math.max(0, targetEnding - endingWithoutProduction);

      // Shelf life cap: don't make more than 2 weeks of velocity at once
      const shelfLifeCap = vel.total * 2;
      const cappedNeeded = shelfLifeCap > 0
        ? Math.min(rawNeeded, shelfLifeCap + totalDemand)
        : rawNeeded;

      const batches = binsPerBatch > 0 && cappedNeeded > 0
        ? Math.ceil(cappedNeeded / binsPerBatch)
        : 0;
      const binsWillMake = round4(batches * binsPerBatch);

      const needsProduction = batches > 0 && endingWithoutProduction < targetEnding;
      const critical = endingWithoutProduction < 0;
      const belowTrigger = endingWithoutProduction <= trigger;
      const tcNeedsTransfer = invItem.tc <= 1 && invItem.petoskey > trigger + 1;

      productionPlan.push({
        flavor: f,
        current: invItem.total,
        petoskey: invItem.petoskey,
        tc: invItem.tc,
        velocity: vel.total,
        velocityReliable: vel.reliable,
        projectedSales,
        upcomingDemand: upcomingDemandBins,
        totalDemand,
        endingWithoutProduction,
        targetEnding,
        binsNeeded: round4(cappedNeeded),
        batches,
        binsWillMake,
        needsProduction,
        critical,
        belowTrigger,
        tcNeedsTransfer,
        projectionDays
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
