const cheerio = require('cheerio');

const TROY_OZ_PER_KG = 32.1507465686;

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSGE() {
  const url = 'https://en.sge.com.cn/data_DelayedQuotes';
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });

  if (!res.ok) throw new Error(`SGE HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  let result = null;
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 4) {
      const variety = $(cells[0]).text().trim();
      if (variety === 'Ag(T+D)') {
        const latest = parseFloat($(cells[1]).text().trim());
        const high = parseFloat($(cells[2]).text().trim());
        const low = parseFloat($(cells[3]).text().trim());
        const open = cells.length >= 5 ? parseFloat($(cells[4]).text().trim()) : null;
        if (latest && latest > 0) {
          result = { latest, high, low, open: open || null };
        }
      }
    }
  });

  if (!result) throw new Error('Ag(T+D) not found or market closed');
  return result;
}

async function fetchCOMEX() {
  const res = await fetchWithTimeout('https://data-asg.goldprice.org/dbXRates/USD');
  if (!res.ok) throw new Error(`COMEX HTTP ${res.status}`);
  const data = await res.json();
  const item = data.items && data.items[0];
  if (!item || !item.xagPrice) throw new Error('Silver price not found in COMEX data');
  return {
    price: item.xagPrice,
    change: item.chgXag,
    changePercent: item.pcXag,
    prevClose: item.xagClose,
    timestamp: data.date || new Date().toISOString(),
  };
}

async function fetchFX() {
  const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
  const data = await res.json();
  const cny = data.rates && data.rates.CNY;
  if (!cny) throw new Error('CNY rate not found');
  return cny;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const result = {
    timestamp: new Date().toISOString(),
    sge: null,
    comex: null,
    fx: null,
    premium: null,
    errors: [],
  };

  // Fetch all three in parallel
  const [sgeResult, comexResult, fxResult] = await Promise.allSettled([
    fetchSGE(),
    fetchCOMEX(),
    fetchFX(),
  ]);

  // Process COMEX
  if (comexResult.status === 'fulfilled') {
    result.comex = comexResult.value;
  } else {
    result.errors.push({ source: 'comex', message: comexResult.reason?.message || 'Unknown error' });
  }

  // Process FX
  if (fxResult.status === 'fulfilled') {
    result.fx = { usd_cny: fxResult.value };
  } else {
    result.errors.push({ source: 'fx', message: fxResult.reason?.message || 'Unknown error' });
  }

  // Process SGE + convert to USD/oz
  if (sgeResult.status === 'fulfilled' && result.fx) {
    const sge = sgeResult.value;
    const usdPerOz = sge.latest / (TROY_OZ_PER_KG * result.fx.usd_cny);
    result.sge = {
      usd_per_oz: parseFloat(usdPerOz.toFixed(4)),
      rmb_per_kg: sge.latest,
      rmb_high: sge.high,
      rmb_low: sge.low,
      rmb_open: sge.open,
    };

    // Calculate premium if COMEX is also available
    if (result.comex) {
      const premiumUsd = result.sge.usd_per_oz - result.comex.price;
      const premiumPct = ((result.sge.usd_per_oz - result.comex.price) / result.comex.price) * 100;
      result.premium = {
        usd: parseFloat(premiumUsd.toFixed(4)),
        percent: parseFloat(premiumPct.toFixed(2)),
      };
    }
  } else if (sgeResult.status === 'rejected') {
    result.errors.push({ source: 'sge', message: sgeResult.reason?.message || 'Unknown error' });
  } else if (!result.fx && sgeResult.status === 'fulfilled') {
    result.errors.push({ source: 'sge', message: 'Cannot convert without FX rate' });
  }

  // Cache: 60s server, 5min stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  const status = result.comex || result.sge ? 200 : 502;
  return res.status(status).json(result);
};
