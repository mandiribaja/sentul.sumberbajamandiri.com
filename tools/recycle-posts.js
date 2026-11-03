const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');

// Working URL-notification logic (IndexNow) — replaces the old axios-based pingSearchEngines(),
// which pinged endpoints that are retired or were never real search-engine endpoints.
// See tools/lib/index-ping.js for the full explanation.
const { submitToIndexNow } = require('./lib/index-ping.js');

// Domain dibaca dari hugo.toml (baseURL), bukan ditulis langsung, agar IndexNow memakai host situs ini.
const SITE_URL = (() => {
  const cfg = ['hugo.toml', 'config.toml'].map(f => path.join(__dirname, '..', f)).find(p => fs.existsSync(p));
  const base = require('toml').parse(fs.readFileSync(cfg, 'utf-8')).baseURL;
  return base.endsWith('/') ? base : base + '/';
})();

const contentDir = path.join(__dirname, '..', 'content');
const now = new Date();

// Articles live nested under content/categories/<folder>/ — fs.readdirSync(contentDir)
// alone only sees the top-level folder names, never the .md files, so walk recursively.
// Hanya artikel di dalam folder (content/<folder>/slug.md) yang didaur ulang. File di root content/
// (promo.md, profile.md, cari.md, ...) dan folder pendukung beranda tidak disentuh.
const EXCLUDED_FOLDERS = new Set(['home', 'page', 'gallery', 'subheader']);

function walkMarkdownFiles(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md') {
      const parts = path.relative(contentDir, fullPath).replace(/\\/g, '/').split('/');
      if (parts.length >= 2 && !EXCLUDED_FOLDERS.has(parts[0])) results.push(fullPath);
    }
  }
  return results;
}

// Same URL convention as dedup-lapis1.js and lib/related-articles.js:
// content/categories/<folder>/slug.md → /categories/<folder>/slug/.
function toUrl(filePath) {
  return '/' + path.relative(contentDir, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}

// Surgically insert/update a `lastmod:` field within the RAW frontmatter text (gray-matter's
// .matter) — never a full YAML re-serialize, which would reformat every file and produce
// noisy diffs. `date:` (original publish date) is left untouched; `lastmod:` feeds the sitemap
// <lastmod> and the "Diperbarui" label in the theme.
function setLastmod(rawMatter, newDate) {
  const line = `lastmod: "${newDate}"`;
  if (/^lastmod:\s*.*$/m.test(rawMatter)) {
    return rawMatter.replace(/^lastmod:\s*.*$/m, line);
  }
  if (/^date:\s*.*$/m.test(rawMatter)) {
    return rawMatter.replace(/^(date:\s*.*)$/m, `$1\n${line}`);
  }
  return `${rawMatter}\n${line}`;
}

function recyclePost(filePath) {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(fileContent);
  const { data, content } = parsed;

  if (data.draft === true) return false; // never touch unpublished drafts

  const postDate = new Date(data.date);
  if (isNaN(postDate.getTime())) return false; // missing/unparseable date — skip, don't crash

  // Age is measured from the LAST touch (lastmod if present, otherwise date), so an article is
  // recycled again 12 months after its previous recycle/revision — not on every run.
  const lastTouch = data.lastmod ? new Date(data.lastmod) : postDate;
  const reference = isNaN(lastTouch.getTime()) ? postDate : lastTouch;
  const monthsDiff = (now.getFullYear() - reference.getFullYear()) * 12 + now.getMonth() - reference.getMonth();

  if (monthsDiff >= 12) {
    const newDate = now.toISOString().split('T')[0];
    // `date:` is NOT overwritten (the old code destroyed the true publish date and made every
    // recycled article look freshly published although nothing changed). `lastmod:` records
    // the touch honestly instead.
    const newRawMatter = setLastmod(parsed.matter, newDate);
    const updatedContent = `---${newRawMatter}\n---\n${content}`;
    fs.writeFileSync(filePath, updatedContent);
    return true;
  }

  return false;
}

const markdownFiles = walkMarkdownFiles(contentDir);
console.log(`📁 ${markdownFiles.length} .md files found in ${contentDir} (recursive, all sub-folders).`);

let updatedCount = 0;
const updatedFilePaths = [];
for (const filePath of markdownFiles) {
  if (recyclePost(filePath)) {
    updatedCount++;
    updatedFilePaths.push(filePath);
  }
}

// Async IIFE (CommonJS has no top-level await) so the script WAITS for the IndexNow submission
// to finish before exiting.
(async () => {
  if (updatedCount > 0) {
    console.log(`${updatedCount} article(s) updated.`);
    // Rebuild the Hugo site
    execSync('hugo', { stdio: 'inherit' });

    // IndexNow wants the SPECIFIC pages that changed, not the sitemap URL.
    const updatedUrls = updatedFilePaths.map(fp => `${SITE_URL.replace(/\/$/, '')}${toUrl(fp)}`);
    await submitToIndexNow(SITE_URL, updatedUrls);
  } else {
    console.log('There are no articles that need to be updated.');
  }
})().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
