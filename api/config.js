module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ supabaseUrl: process.env.SUPABASE_URL });
};
