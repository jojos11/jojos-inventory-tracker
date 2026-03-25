const { getSupabase, cors, checkAuth } = require('./lib/supabase');

async function getShopifyToken() {
  const resp = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!resp.ok) throw new Error(`Shopify auth ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

async function fetchShopifyOrders(token, since) {
  const sinceDate = since || new Date(Date.now() - 86400000).toISOString();
  const query = `{
    orders(first: 100, query: "created_at:>'${sinceDate}' AND NOT status:cancelled") {
      edges {
        node {
          id
          name
          createdAt
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                variant { title }
              }
            }
          }
        }
      }
    }
  }`;

  const resp = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query })
  });
  if (!resp.ok) throw new Error(`Shopify API ${resp.status}`);
  return resp.json();
}

function parseShopifyOrders(data) {
  const sales = [];
  const orders = data?.data?.orders?.edges || [];
  for (const { node: order } of orders) {
    const date = order.createdAt.split('T')[0];
    const lineItems = order.lineItems?.edges || [];
    for (const { node: item } of lineItems) {
      const title = (item.title || '').toLowerCase();
      const variant = (item.variant?.title || '').toLowerCase();
      if (title.includes('merch') || title.includes('shirt') || title.includes('hat')) continue;
      let cookieCount = 1;
      if (title.includes('dozen') || title.includes('12') || variant.includes('dozen')) cookieCount = 12;
      else if (title.includes('half dozen') || title.includes('6') || variant.includes('half')) cookieCount = 6;
      else if (title.includes('4 pack') || title.includes('4-pack') || variant.includes('4')) cookieCount = 4;
      else if (title.includes('cookie cake large')) cookieCount = 12;
      else if (title.includes('cookie cake small')) cookieCount = 6;
      sales.push({
        flavor_name: item.title, date,
        quantity_sold: cookieCount * (item.quantity || 1),
        pack_size: cookieCount === 12 ? '12-pack' : cookieCount === 6 ? '6-pack' : cookieCount === 4 ? '4-pack' : 'single',
        order_id: order.name
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
    const token = await getShopifyToken();
    const { data: flavors } = await supabase.from('flavors').select('id, name').eq('active', true);
    const flavorMap = {};
    for (const f of flavors) {
      flavorMap[f.name.toLowerCase()] = f.id;
      const n = f.name.toLowerCase();
      if (n.includes('chocolate chip') && !n.includes('vegan') && !n.includes('gf')) flavorMap['choc chip'] = f.id;
      if (n === 'peanut butter') flavorMap['pb'] = f.id;
      if (n === 'famous sugar') flavorMap['sugar'] = f.id;
      if (n === 'fudge chocolate') flavorMap['fudge'] = f.id;
    }

    const shopifyData = await fetchShopifyOrders(token, since);
    const sales = parseShopifyOrders(shopifyData);
    const results = { total: sales.length, matched: 0, unmatched: [] };

    for (const sale of sales) {
      const fId = flavorMap[sale.flavor_name.toLowerCase()];
      if (fId) {
        await supabase.from('sales').insert({
          flavor_id: fId, location_id: 1, source: 'shopify',
          date: sale.date, quantity_sold: sale.quantity_sold,
          pack_size: sale.pack_size, order_id: sale.order_id
        });
        results.matched++;
      } else results.unmatched.push(sale.flavor_name);
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Shopify sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
```

Commit that — **all files are done!** Your repo should now have:
```
├── README.md
├── index.html
├── package.json
├── vercel.json
└── api/
    ├── clover.js
    ├── config.js
    ├── dashboard.js
    ├── db.js
    ├── orders.js
    ├── shopify.js
    └── lib/
        └── supabase.js
