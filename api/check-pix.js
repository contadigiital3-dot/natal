const { checkOrderStatus } = require('./_cakto');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido. Use GET.' });
  }

  try {
    const id =
      (req.query && req.query.id) ||
      new URL(req.url, 'http://localhost').searchParams.get('id') ||
      '';

    const result = await checkOrderStatus(id);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[api/check-pix] Erro:', err.message);
    return res.status(err.status || 500).json({
      error: err.message || 'Erro ao consultar status do Pix.'
    });
  }
};
