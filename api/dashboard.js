const { getSupabase, cors, checkAuth } = require('./lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { data: flavors } = await supabase.from('flavors').select('*').eq('active', true).order('type').order('name');
    if (!flavors || flavors.length === 0) {
      return res.json({ inventory: [], productionPlan: [], velocity: {}, alerts: [], manualOrders: [], summary: { totalFlavors: 0 } });
    }

    // Calculate days until next Monday (production day)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
    const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : (8 - dayOfWeek);
    const projectionDays = daysUntilMonday;

    const inventory = {};

    for (const f of flavors) {
      let petBins = 0;
      let tcBins = 0;

      const { data: petSnaps } = await supabase
        .from('inventory_snapshots')
        .select('actual_bins, calculated_bins, date, created_at')
        .eq('flavor_id', f.id)
        .eq('location_id', 1)
        .order('date', { ascending: false })
        .limit(1);

      const { data: tcSnaps } = await supabase
        .from('inventory_snapshots')
        .select('actual_bins, calculated_bins, date, created_at')
        .eq('flavor_id', f.id)
        .eq('location_id', 2)
        .order('date', { ascending: false })
        .limit(1);

      const petSnap = petSnaps && petSnaps.length > 0 ? petSnaps[0] : null;
      const tcSnap = tcSnaps && tcSnaps.length > 0 ? tcSnaps[0] : null;

      if (petSnap) {
        petBins = Number(petSnap.actual_bins) || Number(petSnap.calculated_bins) || 0;
        const snapTime = petSnap.created_at; // Use timestamp, not date

        const { data: prod } = await supabase.from('production_logs').select('batches').eq('flavor_id', f.id).gt('created_at', snapTime);
        if (prod) for (const p of prod) petBins += (Number(p.batches) * f.batch_size_cookies) / f.bin_capacity_cookies;

        const { data: ps } = await supabase.from('sales').select('quantity_sold').eq('flavor_id', f.id).eq('location_id', 1).gt('synced_at', snapTime);
        if (ps) for (const s of ps) petBins -= Number(s.quantity_sold) / f.bin_capacity_cookies;

        const { data: tout } = await supabase.from('transfers').select('bins').eq('flavor_id', f.id).eq('from_location_id', 1).gt('created_at', snapTime);
        if (tout) for (const t of tout) petBins -= Number(t.bins);

        const { data: tin } = await supabase.from('transfers').select('bins').eq('flavor_id', f.id).eq('to_location_id', 1).gt('created_at', snapTime);
        if (tin) for (const t of tin) petBins += Number(t.bins);
      }

      if (tcSnap) {
        tcBins = Number(tcSnap.actual_bins) || Number(tcSnap.calculated_bins) || 0;
        const snapTime = tcSnap.created_at;

        const { data: ts } = await supabase.from('sales').select('quantity_sold').eq('flavor_id', f.id).eq('location_id', 2).gt('synced_at', snapTime);
        if (ts) for (const s of ts) tcBins -= Number(s.quantity_sold) / f.bin_capacity_cookies;

        const { data: tout } = await supabase.from('transfers').select('bins').eq('flavor_id', f.id).eq('from_location_id', 2).gt('created_at', snapTime);
        if (tout) for (const t of tout) tcBins -= Number(t.bins);

        const { data: tin } = await supabase.from('transfers').select('bins').eq('flavor_id', f.id).eq('to_location_id', 2).gt('created_at', snapTime);
        if (tin) for (const t of tin) tcBins += Number(t.bins);
      }

      petBins = Math.max(0, petBins);
      tcBins = Math.max(0, tcBins);
      inventory[f.id] = { flavor: f, petoskey: petBins, tc: tcBins, total: petBins + tcBins };
    }

    // Velocity: 4-week average weekly usage in bins
    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];
    const velocity = {};
    for (const f of flavors) {
      const { data: rs } = await supabase.from('sales').select('quantity_sold').eq('flavor_id', f.id).gte('date', fourWeeksAgo);
      const totalSold = (rs || []).reduce((sum, s) => sum + Number(s.quantity_sold || 0), 0);
      velocity[f.id] = Math.round(totalSold / 4 / f.bin_capacity_cookies * 4) / 4;
    }

    const { data: manualOrders } = await supabase.from('manual_orders').select('*, manual_order_items(*)').in('status', ['pending', 'confirmed']).order('fulfillment_date');

    // Production plan: project forward to next Monday
    const productionPlan = [];
    for (const f of flavors) {
      const inv = inventory[f.id];
      const weeklyUse = velocity[f.id] || 0;
      // Project usage forward based on days until next Monday
      const projectedUse = Math.round(weeklyUse * (projectionDays / 7) * 4) / 4;
      const projectedEnd = Math.round((inv.total - projectedUse) * 4) / 4;

      const trigger = Number(f.restock_trigger_bins) || 3;

      // Add upcoming manual order demand
      const upcomingDemand = (manualOrders || []).reduce((sum, o) => {
        const items = (o.manual_order_items || []).filter(i => i.flavor_id === f.id);
        return sum + items.reduce((s, i) => s + (Number(i.quantity) / f.bin_capacity_cookies), 0);
      }, 0);

      const projectedWithOrders = Math.round((projectedEnd - upcomingDemand) * 4) / 4;
      const needsProduction = projectedWithOrders <= trigger;
      const binsNeeded = needsProduction ? Math.max(0, Number(f.par_level_bins) - projectedWithOrders) : 0;
      const binsPerBatch = f.batch_size_cookies / f.bin_capacity_cookies;
      const batches = binsNeeded > 0 ? Math.ceil(binsNeeded / binsPerBatch) : 0;
      const tcNeedsTransfer = inv.tc <= 1 && inv.petoskey > trigger;

      productionPlan.push({
        flavor: f, current: inv.total, petoskey: inv.petoskey, tc: inv.tc,
        weeklyUse, projectedUse, projectedEnd: projectedWithOrders,
        needsProduction,
        binsNeeded: Math.round(binsNeeded * 4) / 4, batches, tcNeedsTransfer,
        upcomingDemand: Math.round(upcomingDemand * 4) / 4,
        daysProjected: projectionDays
      });
    }

    productionPlan.sort((a, b) => {
      if (a.needsProduction && !b.needsProduction) return -1;
      if (!a.needsProduction && b.needsProduction) return 1;
      return a.projectedEnd - b.projectedEnd;
    });

    const alerts = [];
    for (const p of productionPlan) {
      if (p.projectedEnd < 0) alerts.push({ type: 'critical', message: p.flavor.name + ' will run out before next Monday!', flavor: p.flavor.name });
      else if (p.needsProduction) alerts.push({ type: 'warning', message: p.flavor.name + ' below restock trigger (' + p.current + ' bins, projected ' + p.projectedEnd + ' by Monday)', flavor: p.flavor.name });
      if (p.tcNeedsTransfer) alerts.push({ type: 'transfer', message: p.flavor.name + ' — TC needs transfer from Petoskey', flavor: p.flavor.name });
    }

    res.json({
      inventory: Object.values(inventory), productionPlan, velocity, alerts,
      manualOrders: manualOrders || [],
      projectionDays,
      summary: {
        totalFlavors: flavors.length,
        needsProduction: productionPlan.filter(p => p.needsProduction).length,
        totalBatches: productionPlan.reduce((s, p) => s + p.batches, 0),
        criticalAlerts: alerts.filter(a => a.type === 'critical').length,
        pendingOrders: (manualOrders || []).length
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
};
