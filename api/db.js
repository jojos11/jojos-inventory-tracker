const { getSupabase, cors, checkAuth } = require('./lib/supabase');

const VALID_TABLES = [
  'locations','suppliers','ingredients','base_doughs','base_dough_ingredients',
  'sub_recipes','sub_recipe_ingredients','flavors','flavor_ingredients',
  'flavor_sub_recipes','dough_inventory','pantry','deliveries','delivery_items',
  'production_logs','transfers','sales','inventory_snapshots','manual_orders',
  'manual_order_items','product_sizes'
];

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  const { table, action, id, data, filters, select, orderBy, limit: qLimit } = req.body;

  if (!table || !VALID_TABLES.includes(table)) {
    return res.status(400).json({ error: `Invalid table: ${table}` });
  }

  try {
    let query;
    switch (action) {
      case 'select': {
        query = supabase.from(table).select(select || '*');
        if (filters) {
          for (const [col, val] of Object.entries(filters)) {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              if (val.gte !== undefined) query = query.gte(col, val.gte);
              if (val.lte !== undefined) query = query.lte(col, val.lte);
              if (val.gt !== undefined) query = query.gt(col, val.gt);
              if (val.lt !== undefined) query = query.lt(col, val.lt);
              if (val.neq !== undefined) query = query.neq(col, val.neq);
              if (val.in !== undefined) query = query.in(col, val.in);
              if (val.is !== undefined) query = query.is(col, val.is);
            } else {
              query = query.eq(col, val);
            }
          }
        }
        if (orderBy) {
          const [col, dir] = orderBy.split(':');
          query = query.order(col, { ascending: dir !== 'desc' });
        }
        if (qLimit) query = query.limit(qLimit);
        break;
      }
      case 'insert': {
        query = supabase.from(table).insert(data).select();
        break;
      }
      case 'update': {
        if (!id && !filters) return res.status(400).json({ error: 'ID or filters required for update' });
        query = supabase.from(table).update(data);
        if (id) query = query.eq('id', id);
        if (filters) {
          for (const [col, val] of Object.entries(filters)) query = query.eq(col, val);
        }
        query = query.select();
        break;
      }
      case 'upsert': {
        query = supabase.from(table).upsert(data).select();
        break;
      }
      case 'delete': {
        if (!id) return res.status(400).json({ error: 'ID required for delete' });
        query = supabase.from(table).delete().eq('id', id);
        break;
      }
      default:
        return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    const { data: result, error } = await query;
    if (error) throw error;
    res.json({ data: result });
  } catch (err) {
    console.error(`DB Error [${table}.${action}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
};
