const { getSupabase, cors, checkAuth } = require('./lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  try {
    const { data: flavors } = await supabase.from('flavors').select('*').eq('active', true).order('type').order('name');
    const { data: snapshots } = await supabase.from('inventory_snapshots').select('*').order('date', { ascending: false });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const { data: production } = await supabase.from('production_logs').select('*').gte('date', thirtyDaysAgo).order('date', { ascending: false });
    const { data: sales } = await supabase.from('sales').select('*').gte('date', thirtyDaysAgo);
    const { data: transfers } = await supabase.from('transfers').select('*').gte('date', thirtyDaysAgo);
    const { data: manualOrders } = await supabase.from('manual_orders').select('*, manual_order_items(*)').in('status', ['pending', 'confirmed']).order('fulfillment_date');

    const inventory = {};
    for (const f of flavors) {
      inventory[f.id] = { flavor: f, petoskey: 0, tc: 0, total: 0 };
      const petSnap = snapshots?.find(s => s.flavor_id === f.id && s.location_id === 1);
      const tcSnap = snapshots?.find(s => s.flavor_id === f.id && s.location_id === 2);
      let petBins = petSnap ? parseFloat(petSnap.actual_bins || petSnap.calculated_bins || 0) : 0;
      let tcBins = tcSnap ? parseFloat(tcSnap.actual_bins || tcSnap.calculated_bins || 0) : 0;
      const snapDate = petSnap?.date || tcSnap?.date;

      if (snapDate) {
        const prodSince = production?.filter(p => p.flavor_id === f.id && p.date > snapDate) || [];
        for (const p of prodSince) {
          petBins += (parseFloat(p.batches) * f.batch_size_cookies) / f.bin_capacity_cookies;
        }
        const salesSince = sales?.filter(s => s.flavor_id === f.id && s.date > snapDate) || [];
        for (const s of salesSince) {
          const binsUsed = parseFloat(s.quantity_sold) / f.bin_capacity_cookies;
          if (s.location_id === 1) petBins -= binsUsed;
          else if (s.location_id === 2) tcBins -= binsUsed;
        }
        const transSince = transfers?.filter(t => t.flavor_id === f.id && t.date > snapDate) || [];
        for (const t of transSince) {
          const bins = parseFloat(t.bins);
          if (t.from_location_id === 1) petBins -= bins;
          if (t.from_location_id === 2) tcBins -= bins;
          if (t.to_location_id === 1) petBins += bins;
          if (t.to_location_id === 2) tcBins += bins;
        }
      }

      inventory[f.id].petoskey = Math.max(0, Math.round(petBins * 4) / 4);
      inventory[f.id].tc = Math.max(0, Math.round(tcBins * 4) / 4);
      inventory[f.id].total = inventory[f.id].petoskey + inventory[f.id].tc;
    }

    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];
    const velocity = {};
    for (const f of flavors) {
      const flavorSales = sales?.filter(s => s.flavor_id === f.id && s.date >= fourWeeksAgo) || [];
      const totalSold = flavorSales.reduce((sum, s) => sum + parseFloat(s.quantity_sold || 0), 0);
      velocity[f.id] = Math.round(totalSold / 4 / f.bin_capacity_cookies * 4) / 4;
    }

    const productionPlan = [];
    for (const f of flavors) {
      const inv = inventory[f.id];
      const weeklyUse = velocity[f.id] || 0;
      const endOfWeek = Math.round((inv.total - weeklyUse) * 4) / 4;
      const trigger = parseFloat(f.restock_trigger_bins || 3);
      const upcomingDemand = manualOrders?.reduce((sum, o) => {
        const items = o.manual_order_items?.filter(i => i.flavor_id === f.id) || [];
        return sum + items.reduce((s, i) => s + (parseFloat(i.quantity) / f.bin_capacity_cookies), 0);
      }, 0) || 0;
      const projectedEnd = endOfWeek - upcomingDemand;
      const needsProduction = projectedEnd <= trigger;
      const binsNeeded = needsProduction ? Math.max(0, parseFloat(f.par_level_bins) - projectedEnd) : 0;
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
      else if (p.needsProduction) a
