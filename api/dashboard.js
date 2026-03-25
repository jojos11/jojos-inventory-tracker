const { getSupabase, cors, checkAuth } = require('./lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { data: flavors } = await supabase.from('flavors').select('*').eq('active', true).order('type').order('name');
    if (!flavors || flavors.length === 0) return res.json({ inventory: [], productionPlan: [], velocity: {}, alerts: [], manualOrders: [], summary: { totalFlavors: 0 } });

    // Get inventory directly with SQL for reliability
    const { data: invData } = await supabase.rpc('get_current_inventory').catch(() => ({ data: null }));

    // Fallback: get latest snapshot per flavor per location
    const inventory = {};
    for (const f of flavors) {
      const { data: petSnap } = await supabase
        .from('inventory_snapshots')
        .select('actual_bins, calculated_bins, date')
        .eq('flavor_id', f.id)
        .eq('location_id', 1)
        .order('date', { ascending: false })
        .limit(1)
        .single()
        .catch(() => ({ data: null }));

      const { data: tcSnap } = await supabase
        .from('inventory_snapshots')
        .select('actual_bins, calculated_bins, date')
        .eq('flavor_id', f.id)
        .eq('location_id', 2)
        .order('date', { ascending: false })
        .limit(1)
        .single()
        .catch(() => ({ data: null }));

      let petBins = 0;
      let tcBins = 0;

      if (petSnap) {
        petBins = Number(petSnap.actual_bins) || Number(petSnap.calculated_bins) || 0;
        const snapDate = petSnap.date;

        // Add production since snapshot
        const { data: prod } = await supabase
          .from('production_logs')
          .select('batches')
          .eq('flavor_id', f.id)
          .gt('date', snapDate);
        if (prod) {
          for (const p of prod) {
            petBins += (Number(p.batches) * f.batch_size_cookies) / f.bin_capacity_cookies;
          }
        }

        // Subtract Petoskey sales since snapshot
        const { data: petSales } = await supabase
          .from('sales')
          .select('quantity_sold')
          .eq('flavor_id', f.id)
          .eq('location_id', 1)
          .gt('date', snapDate);
        if (petSales) {
          for (const s of petSales) {
            petBins -= Number(s.quantity_sold) / f.bin_capacity_cookies;
          }
        }

        // Subtract transfers out from Petoskey
        const { data: transOut } = await supabase
          .from('transfers')
          .select('bins')
          .eq('flavor_id', f.id)
          .eq('from_location_id', 1)
          .gt('date', snapDate);
        if (transOut) {
          for (const t of transOut) petBins -= Number(t.bins);
        }

        // Add transfers in to Petoskey
        const { data: transIn } = await supabase
          .from('transfers')
          .select('bins')
          .eq('flavor_id', f.id)
          .eq('to_location_id', 1)
          .gt('date', snapDate);
        if (transIn) {
          for (const t of transIn) petBins += Number(t.bins);
        }
      }

      if (tcSnap) {
        tcBins = Number(tcSnap.actual_bins) || Number(tcSnap.calculated_bins) || 0;
        const snapDate = tcSnap.date;

        const { data: tcSales } = await supabase
          .from('sales')
          .select('quantity_sold')
          .eq('flavor_id', f.id)
          .eq('location_id', 2)
          .gt('date', snapDate);
        if (tcSales) {
          for (const s of tcSales) tcBins -= Number(s.quantity_sold) / f.bin_capacity_cookies;
        }

        const { data: transOut } = await supabase
          .from('transfers')
          .select('bins')
          .eq('flavor_id', f.id)
          .eq('from_location_id', 2)
          .gt('date', snapDate);
        if (transOut) {
          for (const t of transOut) tcBins -= Number(t.bins);
        }

        const { data: transIn } = await supabase
          .from('transfers')
          .select('bins')
          .eq('flavor_id', f.id)
          .eq('to_location_id', 2)
          .gt('date', snapDate);
        if (transIn) {
          for (const t of transIn) tcBins += Number(t.bins);
        }
      }

      petBins = Math.max(0, Math.round(petBins * 4) / 4);
      tcBins = Math.max(0, Math.round(tcBins * 4) / 4);

      inventory[f.id] = {
        flavor: f,
        petoskey: petBins,
        tc: tcBins,
        total: petBins + tcBins
      };
    }

    // Weekly sales velocity (last 4 weeks)
    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];
    const velocity = {};
    for (const f of flavors) {
      const { data: recentSales } = await supabase
        .from('sales')
        .select('quantity_sold')
        .eq('flavor_id', f.id)
        .gte('date', fourWeeksAgo);
      const totalSold = (recentSales || []).reduce((sum, s) => sum + Number(s.quantity_sold || 0), 0);
      velocity[f.id] = Math.round(totalSold / 4 / f.bin_capacity_cookies * 4) / 4;
    }

    // Pending manual orders
    const { data: manualOrders } = await supabase
      .from('manual_orders')
      .select('*, manual_order_items(*)')
      .in('status', ['pending', 'confirmed'])
      .order('fulfillment_date');

    // Production plan
    const productionPlan = [];
    for (const f of flavors) {
      const inv = inventory[f.id];
      const weeklyUse = velocity[f.id] || 0;
      const endOfWeek = Math.round((inv.total - weeklyUse) * 4) / 4;
      const trigger = Number(f.restock_trigger_bins) || 3;
      const upcomingDemand = (manualOrders || []).reduce((sum, o) => {
        const items = (o.manual_order_items || []).filter(i => i.flavor_id === f.id);
        return sum + items.reduce((s, i) => s + (Number(i.quantity) / f.bin_capacity_cookies), 0);
      }, 0);
      const projectedEnd = endOfWeek - upcomingDemand;
      const needsProduction = projectedEnd <= trigger;
      const binsNeeded = needsProduction ? Math.max(0, Number(f.par_level_bins) - projectedEnd) : 0;
      const binsPerBatch = f.batch_size_cookies / f.bin_capacity_cookies;
      const batches = binsNeeded > 0 ? Math.ceil(binsNeeded / binsPerBatch) : 0;
      const tcNeedsTransfer = inv.tc <= 1 && inv.petoskey > trigger;

      productionPlan.push({
        flavor: f, current: inv.total, petoskey: inv.petoskey, tc: inv.tc,
        weeklyUse, endOfWeek: projectedEnd, needsProduction,
        binsNeeded: Math.round(binsNeeded * 4) / 4, batches, tcNeedsTransfer,
        upcomingDemand: Math.round(upcomingDemand * 4) / 4
      });
    }

    productionPlan.sort((a, b) => {
      if (a.needsProduction && !b.needsProduction) return -1;
      if (!a.needsProduction && b.needsProduction) return 1;
      return a.endOfWeek - b.endOfWeek;
    });

    const alerts = [];
    for (const p of productionPlan) {
      if (p.endOfWeek < 0) alerts.push({ type: 'critical', message: `${p.flavor.name} will run out this week!`, flavor: p.flavor.name });
      else if (p.needsProduction) alerts.push({ type: 'warning', message: `${p.flavor.name} below restock trigger (${p.current} bins)`, flavor: p.flavor.name });
      if (p.tcNeedsTransfer) alerts.push({ type: 'transfer', message: `${p.flavor.name} — TC needs transfer from Petoskey`, flavor: p.flavor.name });
    }

    res.json({
      inventory: Object.values(inventory), productionPlan, velocity, alerts,
      manualOrders: manualOrders || [],
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
