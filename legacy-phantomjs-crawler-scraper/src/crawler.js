'use strict';

var fs = require('fs');
var path = require('path');
var phantom = require('phantom');
var ProxyHandler = require('./utils/proxy_handler');
var CookieManager = require('./utils/cookie_manager');
var interceptRequest = require('./handlers/intercept_request');
var pageFunction = require('./handlers/page_function');
var settings = require('./config/settings.json');

/**
* Read input URLs from a text file, one per line.
* Falls back to provided array if file does not exist or is empty.
*/
function readInputUrls(filePath, fallbackUrls) {
var urls = [];
try {
var content = fs.readFileSync(filePath, 'utf8');
urls = content
.split(/\r?\n/)
.map(function (line) {
return line.trim();
})
.filter(function (line) {
return line.length > 0 && line.indexOf('#') !== 0;
});
} catch (e) {
// ignore, will fallback
}

if ((!urls || urls.length === 0) && Array.isArray(fallbackUrls)) {
return fallbackUrls.slice();
}

return urls;
}

/**
* Filter discovered URLs, de-duplicate, respect maxDepth and maxLinksPerPage.
* Returns an array of queue items { url, depth, label }.
*/
function filterDiscoveredUrls(urls, options, visited, currentDepth) {
options = options || {};
visited = visited || {};

var maxDepth =
typeof options.maxDepth === 'number' && options.maxDepth >= 0
? options.maxDepth
: 0;

if (maxDepth && currentDepth >= maxDepth) {
return [];
}

var maxPerPage =
typeof options.maxLinksPerPage === 'number' && options.maxLinksPerPage > 0
? options.maxLinksPerPage
: 10;

var out = [];
var seen = {};

for (var i = 0; i < urls.length && out.length < maxPerPage; i++) {
var u = urls[i];

if (!u || typeof u !== 'string') continue;

// normalize simple things like trailing slashes
var normalized = u.trim();
if (!normalized) continue;

if (visited[normalized]) continue;
if (seen[normalized]) continue;

seen[normalized] = true;

out.push({
url: normalized,
depth: currentDepth + 1,
label: 'FOLLOWED',
});
}

return out;
}

function delay(ms) {
return new Promise(function (resolve) {
setTimeout(resolve, ms);
});
}

/**
* Crawl a single URL.
* Returns { pageInfo, discoveredUrls }.
*/
async function crawlSingle(job, options, proxyHandler, phantomLib, logger) {
var instance = null;
var page = null;
var proxyUrl = proxyHandler && proxyHandler.getNextProxy();
var phantomArgs = proxyHandler
? proxyHandler.buildPhantomArgs(proxyUrl)
: ['--ignore-ssl-errors=yes', '--ssl-protocol=any'];

logger.debug &&
logger.debug('Launching PhantomJS with args: ' + phantomArgs.join(' '));

try {
instance = await phantomLib.create(phantomArgs);
page = await instance.createPage();

if (options.userAgent) {
await page.setting('userAgent', options.userAgent);
}

if (options.viewport && options.viewport.width && options.viewport.height) {
await page.property('viewportSize', {
width: options.viewport.width,
height: options.viewport.height,
});
}

interceptRequest.configure(page, options, logger);

if (options.cookies && options.cookies.length) {
await CookieManager.apply(page, options.cookies);
}

var requestedAt = new Date().toISOString();
logger.log('Opening URL: ' + job.url);

var status = await page.open(job.url);

var pageFnSrc = pageFunction.toString();
var pageFunctionResult = null;

try {
pageFunctionResult = await page.evaluate(
function (fnSrc, label) {
/* eslint-disable no-eval */
var fn = eval('(' + fnSrc + ')');
return fn(label);
},
pageFnSrc,
job.label
);
} catch (e) {
logger.error(
'pageFunction failed on ' + job.url + ': ' + (e && e.message ? e.message : e)
);
pageFunctionResult = null;
}

var discoveredUrls = [];
try {
discoveredUrls = await page.evaluate(function () {
var anchors = document.querySelectorAll('a[href]');
var out = [];
for (var i = 0; i < anchors.length; i++) {
out.push(anchors[i].href);
}
return out;
});
} catch (e) {
logger.error(
'Link discovery failed on ' + job.url + ': ' + (e && e.message ? e.message : e)
);
}

var responseStatus = typeof status === 'number' ? status : 0;

var pageInfo = {
loadedUrl: job.url,
requestedAt: requestedAt,
label: job.label,
pageFunctionResult: pageFunctionResult,
responseStatus: responseStatus,
method: 'GET',
proxy: proxyUrl || null,
};

return {
pageInfo: pageInfo,
discoveredUrls: discoveredUrls,
};
} finally {
if (page && typeof page.close === 'function') {
try {
await page.close();
} catch (e) {
// ignore
}
}
if (instance && typeof instance.exit === 'function') {
try {
await instance.exit();
} catch (e) {
// ignore
}
}
}
}

/**
* Factory to create a crawler instance.
* customOptions overrides settings.json.
* dependencies allows injecting phantom and logger for testing.
*/
function createCrawler(customOptions, dependencies) {
var options = {};
for (var key in settings) {
if (Object.prototype.hasOwnProperty.call(settings, key)) {
options[key] = settings[key];
}
}
if (customOptions) {
for (var k in customOptions) {
if (Object.prototype.hasOwnProperty.call(customOptions, k)) {
options[k] = customOptions[k];
}
}
}

var deps = dependencies || {};
var phantomLib = deps.phantom || phantom;
var logger = deps.logger || console;

var proxyHandler = ProxyHandler.createProxyHandler(options.proxyConfiguration);

async function run() {
var defaultInputPath = path.resolve(__dirname, '..', 'data', 'input_urls.txt');
var startUrls = readInputUrls(defaultInputPath, options.startUrls || []);

if (!startUrls || startUrls.length === 0) {
throw new Error(
'No start URLs defined. Provide src/config/settings.json.startUrls or data/input_urls.txt'
);
}

var visited = {};
var queue = [];
for (var i = 0; i < startUrls.length; i++) {
queue.push({
url: startUrls[i],
depth: 0,
label: 'START',
});
}

var results = [];
var stats = {
queued: queue.length,
crawled: 0,
failed: 0,
};

while (queue.length > 0) {
var job = queue.shift();
if (visited[job.url]) {
continue;
}

visited[job.url] = true;

try {
var crawlResult = await crawlSingle(
job,
options,
proxyHandler,
phantomLib,
logger
);

results.push(crawlResult.pageInfo);
stats.crawled += 1;

var newJobs = filterDiscoveredUrls(
crawlResult.discoveredUrls || [],
options,
visited,
job.depth
);

for (var j = 0; j < newJobs.length; j++) {
queue.push(newJobs[j]);
stats.queued += 1;
}
} catch (err) {
stats.failed += 1;
logger.error(
'Failed to crawl ' +
job.url +
': ' +
(err && err.message ? err.message : String(err))
);
}

if (options.delayMs && options.delayMs > 0) {
await delay(options.delayMs);
}
}

var outputFile = options.outputFile || 'output.json';
var outPath = path.resolve(__dirname, '..', 'data', outputFile);

try {
fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
logger.log('Crawl finished. Results saved to ' + outPath);
} catch (e) {
logger.error(
'Failed to write output file: ' +
outPath +
' - ' +
(e && e.message ? e.message : e)
);
}

return {
results: results,
stats: stats,
};
}

return {
run: run,
};
}

module.exports = {
createCrawler: createCrawler,
filterDiscoveredUrls: filterDiscoveredUrls,
readInputUrls: readInputUrls,
crawlSingle: crawlSingle,
};

if (require.main === module) {
var crawler = createCrawler();
crawler
.run()
.then(function () {
// finished
})
.catch(function (err) {
console.error('Crawler failed:', err && err.message ? err.message : err);
process.exitCode = 1;
});
}