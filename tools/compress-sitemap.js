const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const toml = require('toml');

// Paths are relative to the repo root (this file lives in tools/)
// hugo.toml (atau config.toml jika ada); project ini hanya punya hugo.toml.
const configPath = ['hugo.toml', 'config.toml'].map(f => path.join(__dirname, '..', f)).find(p => fs.existsSync(p));
const sitemapPath = path.join(__dirname, '..', 'public', 'sitemap.xml');
const sitemapGzipPath = path.join(__dirname, '..', 'public', 'sitemap.xml.gz');
const robotsPath = path.join(__dirname, '..', 'public', 'robots.txt');

// Reads baseURL from config.toml
function getBaseUrl() {
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = toml.parse(configContent);
  return config.baseURL.endsWith('/') ? config.baseURL.slice(0, -1) : config.baseURL;
}

// Writes robots.txt (with noindex rules for archive/pagination pages and both sitemap URLs)
function ensureRobotsTxt() {
  const baseUrl = getBaseUrl();

  const robotsContent = `
User-agent: *
Allow: /

Disallow: /categories/*/page/
Noindex: /categories/*/page/
Disallow: /tags/*/page/
Noindex: /tags/*/page/
Disallow: /page/
Noindex: /page/

Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemap.xml.gz
  `;

  fs.writeFileSync(robotsPath, robotsContent.trim());
  console.log('robots.txt was created or updated successfully.');
}

// Compresses sitemap.xml into sitemap.xml.gz
function compressSitemap() {
  const gzip = zlib.createGzip();
  const source = fs.createReadStream(sitemapPath);
  const destination = fs.createWriteStream(sitemapGzipPath);

  source.pipe(gzip).pipe(destination).on('finish', () => {
    console.log('sitemap.xml successfully compressed into sitemap.xml.gz');
  }).on('error', (err) => {
    console.error('Error while compressing sitemap:', err);
    process.exitCode = 1;
  });
}

ensureRobotsTxt();
compressSitemap();
