const { createPixCharge } = require('./_cakto');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ip =
      req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      (req.socket && req.socket.remoteAddress) ||
      '';

    const result = await createPixCharge({
      plan: body.plan,
      email: body.email,
      name: body.name,
      phone: body.phone,
      cpf: body.cpf,
      fingerprint: body.fingerprint,
      metadata: body.metadata,
      ip
    });

    return res.status(201).json(result);
  } catch (err) {
    console.error('[api/create-pix] Erro:', err.message);
    return res.status(err.status || 500).json({
      error: err.message || 'Erro ao gerar cobrança Pix. Tente novamente em instantes.'
    });
  }
};
