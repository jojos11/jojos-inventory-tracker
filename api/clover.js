const { getSupabase, cors, checkAuth } = require('./lib/supabase');

async function fetchCloverOrders(merchantId, apiToken, since) {
  const sinceTs = since ? new Date(since).getTime() : Date.now() - 86400000;
  const url = `https://www.clover.com/v3/merchants/${merchantId}/orders?filter=createdTime>=${sinceTs}&expand=lineItems&expand=lineItems.modifications&limit=100`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' }
  });
  if (!resp.ok) throw new Error(`Clover API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function parseCloverSales(ordersData, locationId) {
  const sales = [];
  if (!ordersData?.elements) return sales;

  for (const order of ordersData.elements) {
    if (!order.lineItems?.elements) continue;
    for (const item of order.lineItems.elements) {
      const name = (item.name || '').toLowerCase();
      if (!name.includes('pack') && !name.includes('single') && !name.includes('cookie cake') && !name.includes('dozen')) continue;

      let packSize = 'single', cookieCount = 1;
      if (name.includes('4') || name.includes('four')) { packSize = '4-pack'; cookieCount = 4; }
      else if (name.includes('half') || (name.includes('6') && !name.includes('16'))) { packSize = '6-pack'; cookieCount = 6; }
      else if (name.includes('12') || name.includes('dozen')) { packSize = '12-pack'; cookieCount = 12; }
      else if (name.includes('large cookie cake')) { packSize = 'large-cake'; cookieCount = 12; }
      else if (name.includes('small cookie cake')) { packSize = 'small-cake'; cookieCount = 6; }

      let flavorName = null;
      if (item.modifications?.elements) {
        for (const mod of item.modifications.elements) {
          if (mod.name && mod.name.trim().length > 0) { flavorName = mod.name.trim(); break; }
        }
      }
      if (!flavorName) continue;

      const qty = item.unitQty ? item.unitQty / 1000 : 1;
      sales.push({
        flavor_name: flavorName, location_id: locationId, source: 'clover',
        date: new Date(order.createdTime).toISOString().split('T')[0],
        quantity_sold: cookieCount * qty, pack_size: packSize, order_id: order.id
      });
    }
  }
  return sales;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  const since = req.body?.since || new Date(Date.now() - 86400000).toISOString();

  try {
    const { data: flavors } = await supabase.from('flavors').select('id, name').eq('active', true);
    const flavorMap = {};
    for (const f of flavors) {
      flavorMap[f.name.toLowerCase()] = f.id;
      const n = f.name.toLowerCase();
      if (n.includes('chocolate chip') && !n.includes('vegan') && !n.includes('gf') && !n.includes('gluten')) flavorMap['choc chip'] = f.id;
      if (n === 'peanut butter') flavorMap['pb'] = f.id;
      if (n.includes('gf') || n.includes('gluten')) { flavorMap['gf'] = f.id; flavorMap['gf choc chip'] = f.id; flavorMap['gluten friendly'] = f.id; }
      if (n.includes('vegan')) { flavorMap['vegan'] = f.id; flavorMap['vegan choc chip'] = f.id; }
      if (n === 'famous sugar') flavorMap['sugar'] = f.id;
      if (n === 'fudge chocolate') { flavorMap['fudge'] = f.id; flavorMap['fudge choc'] = f.id; }
    }

    const results = { petoskey: 0, tc: 0, matched: 0, unmatched: [], errors: [] };

    if (process.env.CLOVER_MERCHANT_ID_PETOSKEY && process.env.CLOVER_API_TOKEN_PETOSKEY) {
      try {
        const data = await fetchCloverOrders(process.env.CLOVER_MERCHANT_ID_PETOSKEY, process.env.CLOVER_API_TOKEN_PETOSKEY, since);
        const sales = parseCloverSales(data, 1);
        results.petoskey = sales.length;
        for (const sale of sales) {
          const fId = flavorMap[sale.flavor_name.toLowerCase()];
          if (fId) {
            await supabase.from('sales').insert({ flavor_id: fId, location_id: 1, source: 'clover', date: sale.date, quantity_sold: sale.quantity_sold, pack_size: sale.pack_size, order_id: sale.order_id });
            results.matched++;
          } else results.unmatched.push(sale.flavor_name);
        }
      } catch (err) { results.errors.push(`Petoskey: ${err.message}`); }
    }

    if (process.env.CLOVER_MERCHANT_ID_TC && process.env.CLOVER_API_TOKEN_TC) {
      try {
        const data = await fetchCloverOrders(process.env.CLOVER_MERCHANT_ID_TC, process.env.CLOVER_API_TOKEN_TC, since);
        const sales = parseCloverSales(data, 2);
        results.tc = sales.length;
        for (const sale of sales) {
          const fId = flavorMap[sale.flavor_name.toLowerCase()];
          if (fId) {
            await supabase.from('sales').insert({ flavor_id: fId, location_id: 2, source: 'clover', date: sale.date, quantity_sold: sale.quantity_sold, pack_size: sale.pack_size, order_id: sale.order_id });
            results.matched++;
          } else results.unmatched.push(sale.flavor_name);
        }
      } catch (err) { results.errors.push(`TC: ${err.message}`); }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Clover sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
