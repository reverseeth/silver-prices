const cheerio = require('cheerio');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // --- 1. Fetch SGE Delayed Quotes page ---
    const sgeUrl = 'https://en.sge.com.cn/data_DelayedQuotes';
    const sgeResponse = await fetch(sgeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!sgeResponse.ok) {
      throw new Error(`SGE returned status ${sgeResponse.status}`);
    }

    const html = await sgeResponse.text();
    const $ = cheerio.load(html);

    // --- 2. Extract Ag(T+D) price from table ---
    let agLatest = null;
    let agHigh = null;
    let agLow = null;
    let agOpen = null;

    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 4) {
        const variety = $(cells[0]).text().trim();
        if (variety === 'Ag(T+D)') {
          agLatest = parseFloat($(cells[1]).text().trim());
          agHigh = parseFloat($(cells[2]).text().trim());
          agLow = parseFloat($(cells[3]).text().trim());
          agOpen = parseFloat($(cells[4]).text().trim()) || null;
        }
      }
    });

    if (!agLatest || agLatest === 0) {
      throw new Error('Ag(T+D) price not found or market closed (0.0)');
    }

    // --- 3. Fetch USD/CNY exchange rate ---
    // Using open.er-api.com (free, no key required)
    // Note: This returns CNY (onshore). CNH (offshore) differs by ~0.1-0.3%.
    const fxResponse = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(10000),
    });

    if (!fxResponse.ok) {
      throw new Error(`Exchange rate API returned status ${fxResponse.status}`);
    }

    const fxData = await fxResponse.json();
    const usdCny = fxData.rates.CNY;

    if (!usdCny) {
      throw new Error('CNY rate not found in exchange rate response');
    }

    // --- 4. Convert to USD per troy ounce ---
    // Formula: USD/oz = Price_RMB_kg / (32.1507465686 * USD/CNY_spot)
    const TROY_OZ_PER_KG = 32.1507465686;
    const usdPerOz = agLatest / (TROY_OZ_PER_KG * usdCny);

    // --- 5. Cache for 30 minutes, stale-while-revalidate for 2 hours ---
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');

    return res.status(200).json({
      usd_per_oz: parseFloat(usdPerOz.toFixed(4)),
      rmb_per_kg: agLatest,
      rmb_high: agHigh,
      rmb_low: agLow,
      rmb_open: agOpen,
      usd_cny_rate: usdCny,
      timestamp: new Date().toISOString(),
      source: 'Shanghai Gold Exchange - Ag(T+D) Delayed Quotes',
      note: 'Exchange rate is USD/CNY (onshore). Offshore CNH rate may differ slightly.',
    });
  } catch (error) {
    console.error('Shanghai API error:', error.message);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=3600');

    return res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
      hint: 'SGE may be unreachable or market is closed. Cached data may still be served.',
    });
  }
};
