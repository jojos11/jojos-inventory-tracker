const { getSupabase, cors, checkAuth } = require('./lib/supabase');

// Cookie name mapping: Shopify product titles → DB flavor names
const COOKIE_NAME_MAP = {
  'chocolate chip': 'Chocolate Chip',
  'famous sugar': 'Famous Sugar',
  'fudge chocolate': 'Fudge Chocolate',
  'kitchen sink': 'Kitchen Sink',
  'cake batter': 'Cake Batter',
  'lemon': 'Lemon',
  'snickerdoodle': 'Snickerdoodle',
  'triple chip': 'Triple Chip',
  'peanut butter': 'Peanut Butter',
  'oatmeal raisin': 'Oatmeal Raisin',
  'thick mint': 'Thick Mint',
  'lucky charm': 'Lucky Charm',
  'salted caramel chocolate chip': 'Salted Caramel',
  'salted caramel': 'Salted Caramel',
  'dubai chocolate': 'Dubai Chocolate',
  'oatmeal cream': 'Oatmeal Cream',
  'carrot cake': 'Carrot Cake',
  'm&m brownie': 'M&M Brownie',
  // Shopify display names that differ from DB
  "not your mama's peanut butter": 'Peanut Butter',
  "not your mama\u2019s peanut butter": 'Peanut Butter',
  'lemon-glazed molasses': 'Molasses',
  'gluten-friendly chocolate chip': 'GF Chocolate Chip',
  'vegan-friendly chocolate chip': 'Vegan Chocolate Chip',
  'monster': 'Monster',
};

// Items to skip (not actual cookies)
const SKIP_ITEMS = [
  'specialty cookie upcharge', 'premium cookie upcharge',
  'gift card', 'shipping', 'merch', 'shirt', 'hat', 'hoodie',
];

// Box products (contain assorted cookies — count as generic cookies sold)
const BOX_PRODUCTS = {
  'easter box (half dozen $32)': 6,
  'easter box (one dozen $44)': 12,
  'st. paddy box ($32-$44) (half dozen)': 6,
  'st. paddy box ($32-$44) (dozen)': 12,
  'st. paddy box': 6,
  'one dozen ($48)': 12,
  'half dozen ($34)': 6,
  '4 pack ($27)': 4,
  '4 pack': 4,
};

async function fetchShopifyOrders(since) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) throw new Error('Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET env vars');

  // Step 1: Exchange credentials for access token (form-urlencoded, not JSON)
  const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    throw new Error(`Shopify token exchange ${tokenRes.status}: ${txt.slice(0, 200)}`);
  }
  const token = (await tokenRes.json()).access_token;
  if (!token) throw new Error('No access_token returned from Shopify token exchange');

  // Step 2: Query orders with the token

  const sinceDate = since || new Date(Date.now() - 7 * 86400000).toISOString();
  const query = `{
    orders(first: 250, query: "created_at:>'${sinceDate}' AND NOT status:cancelled") {
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
          shippingAddress { provinceCode city }
          note
          tags
          customAttributes { key value }
        }
      }
    }
  }`;

  const resp = await fetch(`https://${domain}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query })
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Shopify API ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

function determineLocation(order) {
  const note = (order.note || '').toLowerCase();
  const tags = (order.tags || []).map(t => t.toLowerCase());
  
  // Check delivery address for store pickup
  const attrs = order.customAttributes || [];
  for (const attr of attrs) {
    const val = (attr.value || '').toLowerCase();
    if (val.includes('petoskey') || val.includes('charlevoix')) return { id: 1, name: 'Petoskey' };
    if (val.includes('traverse') || val.includes('park street')) return { id: 2, name: 'Traverse City' };
  }
  
  if (note.includes('petoskey') || note.includes('charlevoix')) return { id: 1, name: 'Petoskey' };
  if (note.includes('traverse') || note.includes('park street')) return { id: 2, name: 'Traverse City' };
  
  // Shipping orders - count as Petoskey production
  return { id: 1, name: 'Shipping' };
}

function parseOrders(data) {
  const sales = [];
  const allTitles = []; // debug
  const orders = data?.data?.orders?.edges || [];
  
  for (const { node: order } of orders) {
    const date = order.createdAt.split('T')[0];
    const location = determineLocation(order);
    const lineItems = order.lineItems?.edges || [];
    
    for (const { node: item } of lineItems) {
      const title = (item.title || '').toLowerCase().trim();
      allTitles.push(item.title); // debug
      
      
      // Skip non-cookie items
      if (SKIP_ITEMS.some(skip => title.includes(skip))) continue;
      
      // Check if it's a box product
      const boxCount = Object.entries(BOX_PRODUCTS).find(([key]) => title.includes(key));
      if (boxCount) {
        // Box products — we know the cookie count but not individual flavors
        // Record as generic "box" sale for total cookie counting
        sales.push({
          flavor_name: '__box__',
          date,
          quantity: boxCount[1] * (item.quantity || 1),
          location,
          order_id: order.name,
          original_title: item.title
        });
        continue;
      }
      
      // Match to known cookie name
      const mappedName = COOKIE_NAME_MAP[title];
      if (mappedName) {
        sales.push({
          flavor_name: mappedName,
          date,
          quantity: item.quantity || 1,
          location,
          order_id: order.name,
          original_title: item.title
        });
      } else {
        // Unknown item
        sales.push({
          flavor_name: null,
          date,
          quantity: item.quantity || 1,
          location,
          order_id: order.name,
          original_title: item.title
        });
      }
    }
  }
  return { sales, allTitles };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  // Default to 7 days back for initial sync, or use provided 'since'
  const since = req.body?.since || new Date(Date.now() - 7 * 86400000).toISOString();
  const daysBack = req.body?.days || null;
  const sinceDate = daysBack 
    ? new Date(Date.now() - daysBack * 86400000).toISOString()
    : since;

  try {
    const { data: flavors } = await supabase.from('flavors').select('id, name').eq('active', true);
    const flavorMap = {};
    for (const f of flavors) flavorMap[f.name] = f.id;

    const shopifyData = await fetchShopifyOrders(sinceDate);
    const { sales, allTitles } = parseOrders(shopifyData);
    
    const results = { 
      total: sales.length, 
      matched: 0, 
      unmatched: [], 
      boxes: 0,
      inserted: 0,
      skipped_duplicates: 0
    };

    for (const sale of sales) {
      if (sale.flavor_name === '__box__') {
        results.boxes += sale.quantity;
        continue;
      }
      
      if (!sale.flavor_name) {
        results.unmatched.push(sale.original_title);
        continue;
      }

      const flavorId = flavorMap[sale.flavor_name];
      if (!flavorId) {
        results.unmatched.push(`${sale.original_title} (mapped to "${sale.flavor_name}" but not in DB)`);
        continue;
      }

      // Check for duplicate (same order_id + flavor + date)
      const { data: existing } = await supabase.from('sales')
        .select('id')
        .eq('order_id', sale.order_id)
        .eq('flavor_id', flavorId)
        .eq('date', sale.date)
        .limit(1);
      
      if (existing && existing.length > 0) {
        results.skipped_duplicates++;
        continue;
      }

      const { error } = await supabase.from('sales').insert({
        flavor_id: flavorId,
        location_id: sale.location.id,
        source: 'shopify',
        date: sale.date,
        quantity_sold: sale.quantity,
        pack_size: 'individual',
        order_id: sale.order_id
      });
      
      if (!error) {
        results.matched++;
        results.inserted++;
      } else {
        results.unmatched.push(`DB error for ${sale.flavor_name}: ${error.message}`);
      }
    }

    // Include unique titles for debugging
    const uniqueTitles = [...new Set(allTitles)].sort();
    results.debug_titles = uniqueTitles;
    results.debug_order_count = shopifyData?.data?.orders?.edges?.length || 0;
    res.json({ success: true, results });
  } catch (err) {
    console.error('Shopify sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
