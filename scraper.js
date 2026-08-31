// 设置环境变量忽略自签名证书（免费代理常见问题）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// AiPrice (AliPrice) 速卖通商品历史价格爬虫
// 输入: 速卖通商品ID → 返回商品完整信息+历史价格
// 采集站点已公开数据，无需登录，代理IP池方案
const axios = require('axios');
const https = require('https');
const proxyManager = require('./proxyManager');

// 本网站使用axios即可，curl-cffi在Render上有类型兼容问题

// ============ 配置 ============
const BASE_URL = 'https://www.aiprice.com';
const SEARCH_URL = `${BASE_URL}/Index/search.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 超时与并发策略（适配Render免费版30秒限制）
const SINGLE_PROXY_TIMEOUT = 5000;
const TOTAL_REQUEST_TIMEOUT = 25000;
const CONCURRENT_PROXIES = 5;
const MAX_ROUNDS = 4;

// 自定义HTTPS Agent（axios降级方案使用）
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

  // 多轮次并发请求
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

    console.log(`[AiPrice] 轮次 ${round + 1}/${MAX_ROUNDS}: 并发测试 ${proxiesThisRound.length} 个代理`);

    // 同时请求，谁先成功谁返回
    const promises = proxiesThisRound.map(proxy => {
      return new Promise(async (resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SINGLE_PROXY_TIMEOUT);
        try {
          const result = await requestFn(proxy, controller.signal);
          clearTimeout(timer);
          if (result && result.success) {
            proxyManager.markSuccess(proxy);
            console.log(`[AiPrice] 代理成功: ${proxy}`);
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

    // 等待第一个成功的
    const result = await Promise.race(promises);
    if (result.success) {
      successfulProxy = result.proxy;
      return { ...result.result, proxy: successfulProxy };
    }

    lastError = result.error;

    // 所有并发都失败了，进入下一轮
    console.log(`[AiPrice] 轮次 ${round + 1} 全部失败，继续下一轮`);
  }

  // 所有代理都失败后，尝试直连回退
  if (allowDirectFallback) {
    console.log(`[AiPrice] 代理全部失败，尝试直连回退...`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10000, totalTimeout));
    try {
      const result = await requestFn(null, controller.signal);
      if (result.success) {
        console.log('[AiPrice] 直连回退成功!');
        clearTimeout(timer);
        return result;
      }
      lastError = result.error || '直连回退失败';
    } catch (err) {
      lastError = '直连回退异常: ' + (err.message || err);
    } finally { clearTimeout(timer); }
  }

  console.log(`[AiPrice] 全部尝试失败: ${lastError}`);
  return { success: false, error: lastError };
}

// ============ 构造速卖通商品URL ============
function getAliExpressUrl(itemId) {
  return `https://www.aliexpress.com/item/${itemId}.html`;
}

// ============ 搜索并解析商品数据 ============
async function searchProductByItemId(itemId, allowDirectFallback = true) {
  const aliUrl = getAliExpressUrl(itemId);
  const searchUrl = `${SEARCH_URL}?link=${encodeURIComponent(aliUrl)}&search_from=index_Index_index`;

  console.log(`[AiPrice] 开始搜索商品 ${itemId}`);
  console.log(`[AiPrice] URL: ${searchUrl}`);

  const requestFn = async (proxy, signal) => {
    const headers = getDefaultHeaders();

    // 全部使用axios即可，aiprice.com反爬不严格
    const axiosOptions = {
      url: searchUrl,
      method: 'GET',
      headers: headers,
      signal: signal,
      timeout: SINGLE_PROXY_TIMEOUT,
    };
    if (proxy) {
      const agent = proxyManager.createAgent(proxy);
      axiosOptions.httpsAgent = agent;
      axiosOptions.httpAgent = agent;
    } else {
      axiosOptions.httpsAgent = httpsAgent;
    }

    try {
      const response = await axios(axiosOptions);
      return parseHtml(response.data, itemId, aliUrl);
    } catch (err) {
      return { success: false, error: `axios: ${err.message}` };
    }
  };

  return requestWithProxyRace(requestFn, { allowDirectFallback });
}

// ============ HTML解析 ============
function parseHtml(html, itemId, aliUrl) {
  // 检查滑块验证
  if (html.includes('Please drag the slider to verify') || html.includes('slide to verify')) {
    return { success: false, error: '触发滑块验证' };
  }

  // 检查空页面
  if (!html || html.length < 500) {
    return { success: false, error: '响应数据为空' };
  }

  // 调试：如果返回非HTML内容
  if (!html.includes('AiPrice') && !html.includes('AliPrice')) {
    const preview = html.substring(0, 200).replace(/\n/g, ' ');
    return { success: false, error: `非预期内容: ${preview}` };
  }

  // 解析基础信息
  const result = {
    item_id: itemId,
    aliexpress_url: aliUrl,
    aiprice_url: `${SEARCH_URL}?link=${encodeURIComponent(aliUrl)}&search_from=index_Index_index`,
    product: null,
    seller: null,
    price_history: [],
    price_stats: null,
    reviews: [],
    analysis: null,
  };

  // 提取商品标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (titleMatch) {
    result.title = titleMatch[1].trim();
  } else {
    // 尝试其他选择器
    const titleMatch2 = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch2) {
      result.title = titleMatch2[1].replace(/\|.*$/, '').trim();
    }
  }

  // 提取商品图片
  const imgMatches = html.match(/<img[^>]+src="([^"]+)"[^>]*alt[^>]*>/g);
  if (imgMatches && imgMatches.length > 0) {
    result.images = [];
    for (const img of imgMatches) {
      const srcMatch = img.match(/src="([^"]+)"/);
      if (srcMatch && srcMatch[1] && !srcMatch[1].includes('logo') && !srcMatch[1].includes('banner')) {
        result.images.push(srcMatch[1]);
      }
    }
  }

  // 提取当前价格
  const priceMatch = html.match(/\$(\d+(?:\.\d+))/);
  if (priceMatch) {
    result.current_price = parseFloat(priceMatch[1]);
    result.currency = 'USD';
  }

  // 提取销量和评分
  const ordersMatch = html.match(/(\d+)Orders/i);
  if (ordersMatch) {
    result.orders_count = parseInt(ordersMatch[1]);
  }

  // 营业时间
  const sinceMatch = html.match(/AliExpress Seller Since : \*\*(\d{4}-\d{2}-\d{2})\*\*/);
  if (sinceMatch) {
    result.seller_since = sinceMatch[1];
  }

  // 好评率
  const feedbackMatch = html.match(/Positive Feedback.*:.*\*\*(\d+)%\*\*/);
  if (feedbackMatch) {
    result.positive_feedback_percent = parseInt(feedbackMatch[1]);
  }

  // 历史价格数据
  const priceHistoryMatch = html.match(/id="PriceHistory"[^>]*>([\s\S]*?)<\/div/);
  if (priceHistoryMatch) {
    const priceHtml = priceHistoryMatch[1];
    const priceLines = priceHtml.match(/\$[\d.]+.*\d{4}-\d{2}-\d{2}/g);
    if (priceLines) {
      result.price_history = priceLines.map(line => {
        const priceMatch = line.match(/\$(\d+(?:\.\d+))/);
        const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
        if (priceMatch && dateMatch) {
          return {
            date: dateMatch[1],
            price: parseFloat(priceMatch[1]),
          };
        }
        return null;
      }).filter(p => p !== null);
    }
  }

  // 价格统计
  if (result.price_history && result.price_history.length > 0) {
    const prices = result.price_history.map(p => p.price);
    result.price_stats = {
      count: prices.length,
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: prices.reduce((a, b) => a + b, 0) / prices.length,
      first_date: result.price_history[0].date,
      last_date: result.price_history[result.price_history.length - 1].date,
    };
  }

  // 如果产品信息都没提取到，说明页面不对
  if (!result.title && (!result.price_history || result.price_history.length === 0)) {
    const preview = html.substring(0, 300).replace(/\n/g, ' ');
    return { success: false, error: `无法提取商品信息，页面内容: ${preview}...` };
  }

  result.success = true;
  result.timestamp = new Date().toISOString();

  console.log(`[AiPrice] 商品 ${itemId} 解析成功: ${result.title || '(无标题)'}，历史价格点: ${result.price_history ? result.price_history.length : 0}`);

  return { success: true, data: result };
}

// ============ 获取商品详情（已有itemId直接调用） ============
async function getProductHistory(itemId, allowDirectFallback = true) {
  return searchProductByItemId(itemId, allowDirectFallback);
}

module.exports = {
  getProductHistory,
  searchProductByItemId,
};