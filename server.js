const express = require('express');
const cors = require('cors');
const scraper = require('./scraper');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// ============ 全局错误防护 ============
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err && err.message ? err.message : err);
});

// ============ 健康检查 ============
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============ 首页 ============
app.get('/', (req, res) => {
  res.json({
    service: 'AiPrice AliExpress Product History API',
    version: '1.1.0',
    data_version: '1.1',
    description: '速卖通商品历史价格查询API - 网页采集 + 代理IP（无需登录）',
    mode: '代理IP + 网页采集（axios）',
    features: {
      cookie_required: false,
      proxy_mode: '代理优先 + 直连回退（代理全部失败时自动尝试直连）',
      proxy_pool: '13源自动刷新代理池（每30分钟）',
      api_source: 'www.aiprice.com',
      compliance: '仅采集 robots.txt 允许的公开路径：/Index/search.html 与 /Index/priceTracking.html',
    },
    endpoints: {
      search: 'GET /api/product/:itemId',
      history: 'GET /api/history/:itemId',
      price_tracking: 'GET /api/product/:itemId?days=90|180|365',
      proxy_status: 'GET /api/proxy/status',
    },
    proxy_status: proxyManager.getStatus(),
  });
});

// ============ 1. 查询商品价格历史 ============
app.get('/api/product/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!itemId || !/^\d+$/.test(itemId)) {
      return res.status(400).json({ success: false, error: 'itemId必须是数字，例如: 3256806985085573' });
    }
    proxyManager.setEnabled(true);
    const days = parseInt(req.query.days, 10);
    const validDays = [90, 180, 365].includes(days) ? days : 180;
    const result = await scraper.getProductHistory(itemId, validDays);
    res.json({ ...result, data_version: '1.1' });
  } catch (error) {
    console.error('Product error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 2. 同义词（兼容增强） ============
app.get('/api/history/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!itemId || !/^\d+$/.test(itemId)) {
      return res.status(400).json({ success: false, error: 'itemId必须是数字' });
    }
    proxyManager.setEnabled(true);
    const days = parseInt(req.query.days, 10);
    const validDays = [90, 180, 365].includes(days) ? days : 180;
    const result = await scraper.getProductHistory(itemId, validDays);
    res.json({ ...result, data_version: '1.1' });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 代理状态 ============
app.get('/api/proxy/status', (req, res) => {
  res.json({ success: true, data: proxyManager.getStatus() });
});

// ============ 手动刷新代理池 ============
app.post('/api/proxy/refresh', async (req, res) => {
  try {
    await proxyManager.refreshProxies(false);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 启动服务 ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  AiPrice AliExpress Product History API v1.1.0');
  console.log(`  端口: ${PORT}`);
  console.log('  模式: 代理IP + 网页采集（axios，无需Cookie）');
  console.log('  接口:');
  console.log('    GET /api/product/:itemId(?days=90|180|365)');
  console.log('    GET /api/history/:itemId');
  console.log('    GET /api/proxy/status');
  console.log('    POST /api/proxy/refresh');
  console.log('  代理池: 13源自动刷新（每30分钟）');
  console.log('============================================');

  // 后台初始化代理池
  setTimeout(() => {
    console.log('[启动] 后台初始化代理池...');
    proxyManager.refreshProxies(true).then(() => {
      proxyManager.startAutoRefresh(30);
      console.log('[启动] 代理池初始化完成');
    }).catch(err => {
      console.error('[启动] 代理池初始化失败:', err.message);
      proxyManager.startAutoRefresh(30);
    });
  }, 1000);
});