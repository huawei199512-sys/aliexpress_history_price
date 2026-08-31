// 设置环境变量忽略自签名证书（免费代理常见问题）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// AiPrice (AliPrice) 速卖通商品历史价格爬虫
// 输入: 速卖通商品ID → 返回商品完整信息+历史价格
// 采集站点已公开数据，无需登录，代理IP池方案
// 数据来源:
//   1) /Index/search.html        —— 商品基础信息（标题/价格/图片/评分/订单/卖家...）
//   2) /Index/priceTracking.html —— 历史价格点 JSON（无需登录）
// 合规: 以上两个路径均不在 robots.txt 的 Disallow 列表中，仅采集公开数据
const axios = require('axios');
const https = require('https');
const proxyManager = require('./proxyManager');

// ============ 配置 ============
const BASE_URL = 'https://www.aiprice.com';
const SEARCH_URL = `${BASE_URL}/Index/search.html`;
const PRICE_TRACK_URL = `${BASE_URL}/Index/priceTracking.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 超时与并发策略（适配Render免费版30秒限制）
const SINGLE_PROXY_TIMEOUT = 5000;
const TOTAL_REQUEST_TIMEOUT = 25000;
const CONCURRENT_PROXIES = 5;
const MAX_ROUNDS = 4;

// 默认历史价格跟踪天数（180 = 6个月，页面默认也是6个月）
const DEFAULT_HISTORY_DAYS = 180;

// 自定义HTTPS Agent
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  rejectUnauthorized: false,
});

// ============ 默认请求头 ============
const getDefaultHeaders = () => {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
};

// ============ 代理竞态请求（含直连回退） ============
async function requestWithProxyRace(requestFn, options = {}) {
  const {
    allowDirectFallback = true,
    totalTimeout = TOTAL_REQUEST_TIMEOUT,
  } = options;

  let lastError = '代理请求全部失败';
  let successfulProxy = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const proxiesThisRound = [];
    for (let i = 0; i < CONCURRENT_PROXIES; i++) {
      const proxy = proxyManager.getProxy();
      if (proxy) proxiesThisRound.push(proxy);
    }

    if (proxiesThisRound.length === 0) {
      console.log(`[AiPrice] 轮次 ${round + 1}/${MAX_ROUNDS}: 没有更多可用代理`);
      break;
    }

    const promises = proxiesThisRound.map(proxy => {
      return new Promise(async (resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SINGLE_PROXY_TIMEOUT);
        try {
          const result = await requestFn(proxy, controller.signal);
          clearTimeout(timer);
          if (result && result.success) {
            proxyManager.markSuccess(proxy);
            resolve({ success: true, result, proxy });
          } else {
            proxyManager.markFailed(proxy);
            resolve({ success: false, error: result ? result.error : '失败' });
          }
        } catch (err) {
          clearTimeout(timer);
          proxyManager.markFailed(proxy);
          resolve({ success: false, error: err.message || err });
        }
      });
    });

    const result = await Promise.race(promises);
    if (result.success) {
      successfulProxy = result.proxy;
      return { ...result.result, proxy: successfulProxy };
    }

    lastError = result.error;
  }

  // 所有代理都失败后，尝试直连回退
  if (allowDirectFallback) {
    console.log(`[AiPrice] 代理全部失败，尝试直连回退...`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10000, totalTimeout));
    try {
      const result = await requestFn(null, controller.signal);
      if (result.success) {
        clearTimeout(timer);
        return result;
      }
      lastError = result.error || '直连回退失败';
    } catch (err) {
      lastError = '直连回退异常: ' + (err.message || err);
    } finally { clearTimeout(timer); }
  }

  return { success: false, error: lastError };
}

// ============ 构造速卖通商品URL ============
function getAliExpressUrl(itemId) {
  return `https://www.aliexpress.com/item/${itemId}.html`;
}

// ============ 请求 search.html 并解析商品基础信息 ============
async function searchProductByItemId(itemId, allowDirectFallback = true) {
  const aliUrl = getAliExpressUrl(itemId);
  const searchUrl = `${SEARCH_URL}?link=${encodeURIComponent(aliUrl)}&search_from=index_Index_index`;

  const requestFn = async (proxy, signal) => {
    const axiosOptions = {
      url: searchUrl,
      method: 'GET',
      headers: getDefaultHeaders(),
      signal: signal,
      timeout: SINGLE_PROXY_TIMEOUT,
      maxRedirects: 5,
    };
    if (proxy) {
      const agent = proxyManager.createAgent(proxy);
      axiosOptions.httpsAgent = agent;
      axiosOptions.httpAgent = agent;
    } else {
      axiosOptions.httpsAgent = httpsAgent;
    }

    const response = await axios(axiosOptions);
    return parseHtml(response.data, itemId, aliUrl, searchUrl);
  };

  return requestWithProxyRace(requestFn, { allowDirectFallback });
}

// ============ HTML解析（针对aiprice search.html真实结构） ============
function parseHtml(html, itemId, aliUrl, searchUrl) {
  // 检查滑块验证
  if (html.includes('Please drag the slider to verify') || html.includes('slide to verify') || html.includes('Verify to ensure normal access')) {
    return { success: false, error: '触发滑块验证' };
  }

  if (!html || html.length < 500) {
    return { success: false, error: '响应数据为空' };
  }

  // 提取商品标题（product-title 块，可能是 <h1> 或 <a title="...">）
  let title = null;
  const h1Match = html.match(/<div class="product-title"[^>]*>[\s\S]*?<h1[^>]*>([^<]+)<\/h1>/);
  if (h1Match) {
    title = h1Match[1].trim();
  }
  if (!title) {
    const aTitleMatch = html.match(/<div class="product-title"[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"/);
    if (aTitleMatch) title = aTitleMatch[1].trim();
  }
  if (!title) {
    const titleTagMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleTagMatch) title = titleTagMatch[1].replace(/\|.*$/, '').trim();
  }

  // 提取当前价格
  let currentPrice = null;
  let currency = null;
  const priceMatch = html.match(/<div class="product-price">[\s\S]*?<em class="value">\$?([\d.]+)<\/em>/);
  if (priceMatch) {
    currentPrice = parseFloat(priceMatch[1]);
    currency = 'USD';
  }
  if (!priceMatch) {
    const fPrice = html.match(/id="fPrice" value="([\d.]+)"/);
    if (fPrice) currentPrice = parseFloat(fPrice[1]);
  }

  // 提取商品主图
  let image = null;
  const imgMatch = html.match(/<div class="md-img">[\s\S]*?<img[^>]*src="([^"]+)"/);
  if (imgMatch) image = imgMatch[1];

  // 提取评分与订单量
  let rating = null;
  const ratingMatch = html.match(/class="rating">([\d.]+)/);
  if (ratingMatch) rating = parseFloat(ratingMatch[1]);

  let ordersCount = null;
  const ordersMatch = html.match(/Orders\s*\(\s*([\d,]+)\s*\)/i);
  if (ordersMatch) ordersCount = parseInt(ordersMatch[1].replace(/,/g, ''), 10);

  // 提取平台与店铺名
  let website = null;
  const websiteMatch = html.match(/<div class="store">[\s\S]*?<span>(AliExpress|Alibaba|1688)<\/span>/i);
  if (websiteMatch) website = websiteMatch[1];

  let storeName = null;
  const storeMatch = html.match(/<a class="store-name"[^>]*>([^<]+)<\/a>/);
  if (storeMatch) storeName = storeMatch[1].trim();

  // 提取好评率（真实HTML: <td>Positive Feedback (...) :\n &#9;<b>0%</b></td>）
  let positiveFeedback = null;
  const fbMatch = html.match(/Positive Feedback[\s\S]*?<b>\s*([\d.]+)%\s*<\/b>/i);
  if (fbMatch) positiveFeedback = parseFloat(fbMatch[1]);

  // 提取卖家入驻时间
  let sellerSince = null;
  const sinceMatch = html.match(/AliExpress Seller Since\s*:[\s\S]*?<b>([\d-]+)<\/b>/i);
  if (sinceMatch) sellerSince = sinceMatch[1];

  // 提取卖家评级分析 (DSR)
  const sellerAnalysis = {
    item_as_described: extractDsr(html, 'Item as Described'),
    communication: extractDsr(html, 'Communication'),
    shipping_speed: extractDsr(html, 'Shipping Speed'),
  };

  // 提取 adid（用于历史价格接口）
  let adid = 18; // 默认
  const adidMatch = html.match(/[?&]adid=(\d+)/i) || html.match(/[?&]ADID=(\d+)/i);
  if (adidMatch) adid = parseInt(adidMatch[1], 10);

  // 商品信息合法性检查
  if (!title || (title === 'AiPrice' && !currentPrice)) {
    const preview = html.substring(0, 300).replace(/\n/g, ' ');
    return { success: false, error: `无法提取商品信息，页面内容: ${preview}` };
  }

  return {
    success: true,
    data: {
      item_id: itemId,
      aliexpress_url: aliUrl,
      aiprice_url: searchUrl,
      title,
      current_price: currentPrice,
      currency,
      image,
      rating,
      orders_count: ordersCount,
      website,
      store_name: storeName,
      seller_since: sellerSince,
      positive_feedback_percent: positiveFeedback,
      seller_analysis: sellerAnalysis,
      adid,
      price_history: null, // 由 fetchPriceHistory 填充
    },
  };
}

// 提取 DSR 评级值（Item as Described/Communication/Shipping Speed）
function extractDsr(html, label) {
  const re = new RegExp(`${label}\\s*:\\s*<\/th>\\s*<td[^>]*>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`);
  const m = html.match(re);
  if (m) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/Above Average|Below Average/g, '').trim();
    const num = text.match(/^([\d.]+)/);
    return num ? { value: parseFloat(num[1]), text: text.trim() } : null;
  }
  return null;
}

// ============ 请求 priceTracking.html 获取历史价格点 ============
async function fetchPriceHistory(itemId, adid, days = DEFAULT_HISTORY_DAYS, allowDirectFallback = true) {
  const priceUrl = `${PRICE_TRACK_URL}?sku_id=${itemId}&adid=${adid}&day=${days}`;

  const requestFn = async (proxy, signal) => {
    const axiosOptions = {
      url: priceUrl,
      method: 'GET',
      headers: {
        ...getDefaultHeaders(),
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': searchUrlFor(itemId),
      },
      signal: signal,
      timeout: SINGLE_PROXY_TIMEOUT,
      maxRedirects: 5,
    };
    if (proxy) {
      const agent = proxyManager.createAgent(proxy);
      axiosOptions.httpsAgent = agent;
      axiosOptions.httpAgent = agent;
    } else {
      axiosOptions.httpsAgent = httpsAgent;
    }

    const response = await axios(axiosOptions);
    return parsePriceHistory(response.data, itemId);
  };

  return requestWithProxyRace(requestFn, { allowDirectFallback });
}

function searchUrlFor(itemId) {
  return `${SEARCH_URL}?link=${encodeURIComponent(getAliExpressUrl(itemId))}&search_from=index_Index_index`;
}

// ============ 解析历史价格JSON ============
function parsePriceHistory(data, itemId) {
  // data 可能已经是数组，也可能是JSON字符串
  let items = data;
  if (typeof data === 'string') {
    try {
      items = JSON.parse(data);
    } catch {
      return { success: false, error: '历史价格数据格式错误' };
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, error: '无历史价格数据' };
  }

  let currency = null;
  const history = items.map(item => {
    const price = parseFloat(item.price);
    if (!currency && item.price_symbol) {
      const symbol = String(item.price_symbol).trim();
      if (symbol.startsWith('$')) {
        currency = 'USD';
      } else {
        const m = symbol.match(/[^\d.]+/);
        if (m) currency = m[0];
      }
    }
    return {
      price,
      m_price: item.m_price ? parseFloat(item.m_price) : null,
      low_price: item.lowprice ? parseFloat(item.lowprice) : null,
      date: formatUnixDate(item.time_update),
      price_symbol: item.price_symbol || null,
    };
  }).filter(p => p.date);

  // 价格统计
  const prices = history.map(p => p.price).filter(p => !isNaN(p));
  const priceStats = prices.length > 0 ? {
    count: prices.length,
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)),
    last_price: prices[prices.length - 1],
    first_date: history[0].date,
    last_date: history[history.length - 1].date,
  } : null;

  return {
    success: true,
    data: {
      item_id: itemId,
      currency,
      price_history: history,
      price_stats: priceStats,
    },
  };
}

// Unix秒时间戳 → YYYY-MM-DD
function formatUnixDate(ts) {
  const t = Number(ts);
  if (isNaN(t) || t <= 0) return null;
  const d = new Date(t * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============ 获取商品完整信息 + 历史价格 ============
async function getProductHistory(itemId, days = DEFAULT_HISTORY_DAYS) {
  // 1. 先获取商品基础信息 + adid
  const basicResult = await searchProductByItemId(itemId);
  if (!basicResult.success) {
    return basicResult;
  }
  const basic = basicResult.data;

  // 2. 获取历史价格
  const historyResult = await fetchPriceHistory(itemId, basic.adid, days);

  const data = { ...basic };
  if (historyResult.success) {
    data.price_history = historyResult.data.price_history;
    data.price_stats = historyResult.data.price_stats;
    if (historyResult.data.currency) data.currency = historyResult.data.currency;
  } else {
    // 历史价格获取失败时，基础信息仍返回，history置空并带提示
    data.price_history = [];
    data.price_stats = null;
    data.price_history_error = historyResult.error;
  }

  data.success = true;
  data.timestamp = new Date().toISOString();
  delete data.adid;

  return { success: true, data };
}

module.exports = {
  getProductHistory,
  searchProductByItemId,
  parseHtml,
  parsePriceHistory,
  formatUnixDate,
};