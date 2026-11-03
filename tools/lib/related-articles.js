/**
 * tools/lib/related-articles.js
 *
 * NON-AI internal-linking support, shared by generate-articles.js, revise-articles.js and
 * find-orphans.js.
 *
 *   1. buildArticleIndex(contentRoot)   — scans content/**\/*.md once, builds a lightweight
 *      in-memory index (title, url, category, a short excerpt).
 *   2. guessCategoryHint(text, cats)    — cheap heuristic: does a known category-folder name
 *      (folder names) literally appear in the keyword/title?
 *   3. findRelatedCandidates(...)       — scores every indexed article against the current
 *      keyword/title by significant-word overlap (+ category boost), returns the top N.
 *   4. formatCandidatesForPrompt(...)   — turns the candidate list into the text block that is
 *      injected into the AI prompt (title + url + excerpt).
 *   5. enforceInternalLinks(...)        — SAFETY NET run on the AI's output: strips any internal
 *      link that ISN'T one of the offered candidate URLs and hard-caps the total to 2.
 *
 * Layout note: all articles live in content/categories/<folder>/*.md,
 * so the URL of an article is simply its path (/categories/<folder>/slug/) and its "category" is
 * the folder right under content/categories/ (see toCategory()).
 *
 * Deliberately dependency-free (no gray-matter) so it works in every CI job.
 */

const fs   = require('fs');
const path = require('path');

// Folders directly under content/ that are NOT thematic articles (site pages / home widgets),
// never offered as internal-link candidates.
const EXCLUDED_CATEGORY_FOLDERS = new Set(['home', 'page', 'gallery', 'subheader']);
// File di root content/ yang BUKAN artikel (artikel di root content/*.md tetap diindeks).
const ROOT_NON_ARTICLES = new Set(['promo.md', 'profile.md', 'gallery.md', 'cari.md']);

// Broad marketing/business boilerplate words ignored when scoring topical relatedness.
const RELATED_STOPWORDS = new Set([
  'jual', 'jasa', 'harga', 'sewa', 'beli', 'biaya', 'tukang', 'pasang', 'tempat', 'menyewakan',
  'di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'apa', 'itu', 'ini',
  'terbaik', 'berkualitas', 'gratis', 'ongkir', 'murah', 'terpercaya', 'terdekat', 'bagus',
  'professional', 'profesional', 'area', 'lokasi', 'wilayah', 'daerah', 'kota', 'kabupaten',
  'kecamatan', 'jabodetabek', 'anda', 'kami', 'material', 'konstruksi', 'desain', 'interior',
  'bangunan', 'apakah', 'pengertian', 'alternatif', 'panduan', 'lengkap', 'cara', 'tips',
  'mengenal', 'kenali', 'memilih', 'adalah', 'dalam', 'pada', 'juga', 'akan', 'bisa', 'dapat',
  'kuat', 'awet', 'tahan', 'lama', 'baik', 'jenis', 'macam', 'model', 'membuat', 'minimalis',
  'terbaru', 'contoh', 'proses', 'sederhana', 'yaitu', 'ialah',
]);

function significantWords(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !RELATED_STOPWORDS.has(w));
}

// Titles follow "[Product/Service] di [Location][optional suffix]" (e.g. "Jual Besi Beton
// Ulir di Cibinong Bogor"). Everything from the first standalone "di" onward
// is dropped before computing significant words so two different topics offered in the SAME
// city don't score as "related" just because of the shared place name. Falls back to the full
// text if "di" never appears.
function stripLocationForMatching(text) {
  return (text || '').replace(/\bdi\b[\s\S]*$/i, '').trim() || text || '';
}

function significantWordsForMatching(text) {
  return significantWords(stripLocationForMatching(text));
}

// Lightweight frontmatter split — regex-based on purpose (see file header). Only the fields we
// actually need (title, draft) are extracted.
function splitFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { title: '', draft: false, content: raw };
  const yamlBlock = m[1];
  const titleMatch = yamlBlock.match(/^title:\s*"((?:[^"\\]|\\.)*)"/m) || yamlBlock.match(/^title:\s*(.+?)\s*$/m);
  const draftMatch = yamlBlock.match(/^draft:\s*(true|false)/m);
  return {
    title: titleMatch ? titleMatch[1].replace(/\\"/g, '"').trim() : '',
    draft: draftMatch ? draftMatch[1] === 'true' : false,
    content: m[2] || '',
  };
}

function toUrl(filePath, contentRoot) {
  return '/' + path.relative(contentRoot, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}

// "besi-beton/slug.md" -> "besi-beton" (folder pertama di bawah content/); artikel langsung di
// content/slug.md -> "(root)".
function toCategory(filePath, contentRoot) {
  const parts = path.relative(contentRoot, filePath).replace(/\\/g, '/').split('/');
  if (parts.length === 1) return '(root)';
  return parts[0];
}

// Short plain-text excerpt of the article BODY — lets the AI actually "study" the related
// article instead of only seeing a title.
function extractExcerpt(body, maxChars = 220) {
  const plain = (body || '')
    .replace(/!\[.*?\]\(.*?\)/g, ' ')                                   // images
    .replace(/\{\{<[\s\S]*?>\}\}/g, ' ')                                // Hugo shortcodes
    .replace(/<table[\s\S]*?<\/table>/gi, ' ')                          // rendered safe-tables
    .replace(/\[\[TABEL_MULAI\]\][\s\S]*?\[\[TABEL_SELESAI\]\]/g, ' ')  // safe-table blocks, if present
    .replace(/\[\[\[PLACEHOLDER_\d+\]\]\]/g, ' ')                       // revise-articles protection tokens
    .replace(/[#*_>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, maxChars);
}

/**
 * Scans content/**\/*.md (recursively, skipping folders in EXCLUDED_CATEGORY_FOLDERS),
 * skipping _index.md and draft:true articles. Run ONCE per script execution and reuse it.
 *
 * opts.includeBody (default false): also keep the full raw body on each entry (as `.body`).
 * find-orphans.js turns it on since it needs full bodies to extract every outbound link.
 */
function buildArticleIndex(contentRoot, opts = {}) {
  const index = [];
  if (!fs.existsSync(contentRoot)) return index;

  function walk(dir, isRoot = false) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isRoot && EXCLUDED_CATEGORY_FOLDERS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === '_index.md') continue;
      if (isRoot && ROOT_NON_ARTICLES.has(entry.name)) continue;

      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const { title, draft, content } = splitFrontMatter(raw);
      if (!title || draft) continue;

      index.push({
        file: full,
        url: toUrl(full, contentRoot),
        title,
        category: toCategory(full, contentRoot),
        words: significantWordsForMatching(title),
        excerpt: extractExcerpt(content),
        ...(opts.includeBody ? { body: content } : {}),
      });
    }
  }

  walk(contentRoot, true);

  return index;
}

/**
 * Rule-based hint only (never a hard filter): does a known category-folder name appear as a
 * whole significant word in the keyword/title? e.g. "jalan" in "cor jalan lingkungan".
 */
function guessCategoryHint(text, knownCategories) {
  const words = new Set(significantWords(text));
  for (const cat of knownCategories) {
    if (words.has(cat.toLowerCase())) return cat;
  }
  return null;
}

// Pengacak DETERMINISTIK untuk skor yang sama. Judul artikel di situs ini nyaris identik (hanya lokasi yang
// berbeda), sehingga tanpa ini kandidat selalu artikel pertama menurut abjad dan semua tautan internal
// menumpuk di beberapa halaman saja.
function tieHash(a, b) {
  let h = 2166136261;
  const s = String(a) + '|' + String(b);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function scoreCandidate(queryWords, categoryHint, candidate) {
  const shared = queryWords.filter(w => candidate.words.includes(w));
  let score = shared.length;
  if (categoryHint && candidate.category === categoryHint) score += 1;
  return { score, sharedCount: shared.length };
}

/**
 * "Satu tema" selection — NON-AI. Ranks every indexed article by significant-word overlap with
 * `text`, with a small boost when the candidate lives in the folder the text itself hints at.
 * Returns up to `opts.max` candidates ({ url, title, excerpt }), best match first. Empty array
 * if nothing clears `opts.minShared` — callers must treat that as "no internal link", not an error.
 */
function findRelatedCandidates({ text, excludeUrl, categoryHint }, index, opts = {}) {
  const max = opts.max || 6;
  const minShared = opts.minShared != null ? opts.minShared : 1;

  const queryWords = significantWordsForMatching(text);
  if (!queryWords.length) return [];

  const scored = index
    .filter(a => a.url !== excludeUrl)
    .map(a => ({ a, ...scoreCandidate(queryWords, categoryHint, a) }))
    .filter(x => x.sharedCount >= minShared)
    .sort((x, y) => (y.score - x.score) || (tieHash(excludeUrl, x.a.url) - tieHash(excludeUrl, y.a.url)));

  return scored.slice(0, max).map(x => ({ url: x.a.url, title: x.a.title, excerpt: x.a.excerpt }));
}

function formatCandidatesForPrompt(candidates) {
  if (!candidates.length) {
    return '(Tidak ada artikel terkait yang cukup relevan untuk keyword/topik ini — lewati instruksi internal link, tidak perlu memaksakan.)';
  }
  return candidates.map((c, i) =>
    `${i + 1}. [${c.title}](${c.url})\n   Ringkasan isi: ${c.excerpt || '(tidak ada ringkasan)'}`
  ).join('\n');
}

/**
 * SAFETY NET — run on the final article body AFTER the AI call:
 *   - an internal link is only kept if its URL is EXACTLY one of the offered candidate URLs
 *   - never more than `maxLinks` internal links total (default 2); extras are demoted back to
 *     plain text (anchor text kept), so the sentence still reads naturally.
 * Only touches links whose target looks internal (starts with "/" and ends with "/"); external
 * links, tel: and WhatsApp links are left alone. Image markdown is excluded via the "!" lookbehind.
 */
function enforceInternalLinks(body, candidateUrls, maxLinks = 2) {
  const valid = new Set(candidateUrls || []);
  let kept = 0;
  return body.replace(/(?<!!)\[([^\]]+)\]\((\/[^)\s]+\/)\)/g, (match, anchorText, url) => {
    if (kept >= maxLinks || !valid.has(url)) return anchorText;
    kept++;
    return match;
  });
}

/**
 * Extracts every internal-looking link target from a body of Markdown (same URL shape
 * enforceInternalLinks() enforces). Used by find-orphans.js to build the inbound-link graph.
 */
function extractOutboundUrls(body) {
  const urls = new Set();
  const re = /(?<!!)\[[^\]]+\]\((\/[^)\s]+\/)\)/g;
  let m;
  while ((m = re.exec(body || ''))) urls.add(m[1]);
  return [...urls];
}

module.exports = {
  buildArticleIndex,
  guessCategoryHint,
  findRelatedCandidates,
  formatCandidatesForPrompt,
  enforceInternalLinks,
  extractOutboundUrls,
  significantWords,
  significantWordsForMatching,
  stripLocationForMatching,
};
